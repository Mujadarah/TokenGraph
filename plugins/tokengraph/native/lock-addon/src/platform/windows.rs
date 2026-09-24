use std::{
    ffi::{OsStr, c_void},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle},
    },
    path::{Component, Path, Prefix},
    ptr,
};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_CANT_ACCESS_FILE, ERROR_DIRECTORY,
        ERROR_FILE_NOT_FOUND, ERROR_FILENAME_EXCED_RANGE, ERROR_INVALID_NAME,
        ERROR_INVALID_PARAMETER, ERROR_INVALID_REPARSE_DATA, ERROR_LOCK_VIOLATION,
        ERROR_NOT_A_REPARSE_POINT, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION, GENERIC_READ,
        HANDLE, INVALID_HANDLE_VALUE,
    },
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        FILE_TYPE_DISK, GetFileInformationByHandle, GetFileType, GetFinalPathNameByHandleW,
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx, OPEN_ALWAYS, OPEN_EXISTING,
        UnlockFileEx, VOLUME_NAME_DOS,
    },
    System::IO::OVERLAPPED,
};

use crate::LockError;

const READ_WRITE_SHARING_WITHOUT_DELETE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;
const DIRECTORY_OPEN_FLAGS: u32 = FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS;

#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "CreateFileW"]
    fn create_file_w(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *const c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: HANDLE,
    ) -> HANDLE;
}

pub struct WindowsLock {
    directory_handles: Vec<OwnedHandle>,
    anchor: OwnedHandle,
    compatibility_directory: Option<OwnedHandle>,
    overlapped: Box<OVERLAPPED>,
    released: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    volume: u32,
    index: u64,
}

impl WindowsLock {
    pub fn try_acquire(path: &Path) -> Result<Self, LockError> {
        validate_anchor_path(path)?;
        let parent = path.parent().ok_or_else(LockError::unsafe_anchor)?;
        let directory_handles = open_directory_chain(parent)?;
        let parent_identity = file_identity(
            directory_handles
                .last()
                .ok_or_else(LockError::unsafe_anchor)?,
        )?;

        let anchor = open_owned(
            path,
            GENERIC_READ,
            OPEN_ALWAYS,
            FILE_FLAG_OPEN_REPARSE_POINT,
            LockError::unsafe_anchor,
        )?;
        let anchor_info = file_information(&anchor)?;
        if anchor_info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)
            != 0
            || anchor_info.nNumberOfLinks != 1
            || file_type(&anchor) != FILE_TYPE_DISK
        {
            return Err(LockError::unsafe_anchor());
        }
        let anchor_identity = identity_from_info(&anchor_info);
        if anchor_identity.volume != parent_identity.volume
            || !handle_matches_path(&anchor, path)?
            || !reopened_identity_matches(
                path,
                &anchor_identity,
                GENERIC_READ,
                FILE_FLAG_OPEN_REPARSE_POINT,
                LockError::unsafe_anchor,
            )?
        {
            return Err(LockError::unsafe_anchor());
        }

        let mut overlapped = Box::<OVERLAPPED>::default();
        let locked = unsafe {
            LockFileEx(
                raw_handle(&anchor),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                overlapped.as_mut(),
            )
        };
        if locked == 0 {
            return Err(if last_error_code() == ERROR_LOCK_VIOLATION {
                LockError::lock_busy()
            } else {
                LockError::native_lock_error()
            });
        }

        Ok(Self {
            directory_handles,
            anchor,
            compatibility_directory: None,
            overlapped,
            released: false,
        })
    }

    pub fn protect_compatibility_directory(&mut self, path: &Path) -> Result<(), LockError> {
        if self.compatibility_directory.is_some() {
            return Err(LockError::invalid_argument());
        }
        validate_existing_directory_path(path, LockError::unsafe_compatibility_directory)?;
        let handle = open_owned(
            path,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            OPEN_EXISTING,
            DIRECTORY_OPEN_FLAGS,
            LockError::unsafe_compatibility_directory,
        )?;
        let info =
            file_information(&handle).map_err(|_| LockError::unsafe_compatibility_directory())?;
        let identity = identity_from_info(&info);
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || file_type(&handle) != FILE_TYPE_DISK
            || !handle_matches_path(&handle, path)
                .map_err(|_| LockError::unsafe_compatibility_directory())?
            || !reopened_identity_matches(
                path,
                &identity,
                FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                DIRECTORY_OPEN_FLAGS,
                LockError::unsafe_compatibility_directory,
            )?
        {
            return Err(LockError::unsafe_compatibility_directory());
        }
        self.compatibility_directory = Some(handle);
        Ok(())
    }

    pub fn release_compatibility_directory(&mut self) -> Result<(), LockError> {
        let handle = self
            .compatibility_directory
            .take()
            .ok_or_else(LockError::invalid_argument)?;
        close_or_abort(handle, "compatibility directory");
        Ok(())
    }

    pub fn release(mut self) -> Result<(), LockError> {
        if self.released {
            return Err(LockError::already_released());
        }
        if self.compatibility_directory.is_some() {
            return Err(LockError::invalid_argument());
        }
        self.released = true;

        let unlocked =
            unsafe { UnlockFileEx(raw_handle(&self.anchor), 0, 1, 0, self.overlapped.as_mut()) };
        if unlocked == 0 {
            abort_unproven_release("anchor unlock");
        }

        close_or_abort(self.anchor, "anchor handle");
        for handle in self.directory_handles.into_iter().rev() {
            close_or_abort(handle, "anchor directory handle");
        }
        Ok(())
    }
}

fn open_directory_chain(path: &Path) -> Result<Vec<OwnedHandle>, LockError> {
    let mut paths: Vec<&Path> = path
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .collect();
    paths.reverse();

    let mut handles = Vec::with_capacity(paths.len());
    for component_path in paths {
        let handle = open_owned(
            component_path,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            OPEN_EXISTING,
            DIRECTORY_OPEN_FLAGS,
            LockError::unsafe_anchor,
        )?;
        let info = file_information(&handle)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || file_type(&handle) != FILE_TYPE_DISK
            || !handle_matches_path(&handle, component_path)?
        {
            return Err(LockError::unsafe_anchor());
        }
        handles.push(handle);
    }
    Ok(handles)
}

fn validate_anchor_path(path: &Path) -> Result<(), LockError> {
    validate_path(path, LockError::unsafe_anchor)?;
    if path.file_name().is_none() || path.parent().is_none() {
        return Err(LockError::unsafe_anchor());
    }
    Ok(())
}

fn validate_existing_directory_path(
    path: &Path,
    unsafe_error: fn() -> LockError,
) -> Result<(), LockError> {
    validate_path(path, unsafe_error)?;
    if path.file_name().is_none() {
        return Err(unsafe_error());
    }
    Ok(())
}

fn validate_path(path: &Path, unsafe_error: fn() -> LockError) -> Result<(), LockError> {
    if !path.is_absolute() {
        return Err(unsafe_error());
    }

    for component in path.components() {
        match component {
            Component::Prefix(prefix)
                if matches!(
                    prefix.kind(),
                    Prefix::Disk(_)
                        | Prefix::VerbatimDisk(_)
                        | Prefix::UNC(_, _)
                        | Prefix::VerbatimUNC(_, _)
                ) => {}
            Component::RootDir => {}
            Component::Normal(value) if safe_component(value) => {}
            _ => return Err(unsafe_error()),
        }
    }
    Ok(())
}

fn safe_component(value: &OsStr) -> bool {
    let wide: Vec<u16> = value.encode_wide().collect();
    !wide.is_empty()
        && !wide.contains(&0)
        && !wide.contains(&(b':' as u16))
        && !matches!(wide.last(), Some(last) if *last == b'.' as u16 || *last == b' ' as u16)
}

fn open_owned(
    path: &Path,
    desired_access: u32,
    creation_disposition: u32,
    flags: u32,
    unsafe_error: fn() -> LockError,
) -> Result<OwnedHandle, LockError> {
    let wide = extended_path_wide(path).ok_or_else(unsafe_error)?;
    let handle = unsafe {
        create_file_w(
            wide.as_ptr(),
            desired_access,
            READ_WRITE_SHARING_WITHOUT_DELETE,
            ptr::null(),
            creation_disposition,
            flags,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let code = last_error_code();
        return Err(if ambiguous_path_error(code) {
            unsafe_error()
        } else {
            LockError::native_lock_error()
        });
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}

fn reopened_identity_matches(
    path: &Path,
    expected: &FileIdentity,
    desired_access: u32,
    flags: u32,
    unsafe_error: fn() -> LockError,
) -> Result<bool, LockError> {
    let verifier = open_owned(path, desired_access, OPEN_EXISTING, flags, unsafe_error)?;
    let actual = file_identity(&verifier).map_err(|_| unsafe_error())?;
    close_or_abort(verifier, "identity verifier handle");
    Ok(actual == *expected)
}

fn file_information(handle: &OwnedHandle) -> Result<BY_HANDLE_FILE_INFORMATION, LockError> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded = unsafe { GetFileInformationByHandle(raw_handle(handle), &mut info) };
    if succeeded == 0 {
        return Err(LockError::native_lock_error());
    }
    Ok(info)
}

fn file_identity(handle: &OwnedHandle) -> Result<FileIdentity, LockError> {
    file_information(handle).map(|info| identity_from_info(&info))
}

fn identity_from_info(info: &BY_HANDLE_FILE_INFORMATION) -> FileIdentity {
    FileIdentity {
        volume: info.dwVolumeSerialNumber,
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    }
}

fn file_type(handle: &OwnedHandle) -> u32 {
    unsafe { GetFileType(raw_handle(handle)) }
}

fn handle_matches_path(handle: &OwnedHandle, expected: &Path) -> Result<bool, LockError> {
    let final_path = final_path(handle)?;
    let expected = normalized_path(expected).ok_or_else(LockError::unsafe_anchor)?;
    Ok(final_path == expected)
}

fn final_path(handle: &OwnedHandle) -> Result<String, LockError> {
    let mut buffer = vec![0_u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                raw_handle(handle),
                buffer.as_mut_ptr(),
                buffer.len().try_into().unwrap_or(u32::MAX),
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        if length == 0 {
            return Err(LockError::native_lock_error());
        }
        let length = usize::try_from(length).map_err(|_| LockError::native_lock_error())?;
        if length < buffer.len() {
            buffer.truncate(length);
            return normalize_wide_path(&buffer).ok_or_else(LockError::unsafe_anchor);
        }
        buffer.resize(length.saturating_add(1), 0);
    }
}

fn normalized_path(path: &Path) -> Option<String> {
    let mut wide = extended_path_wide(path)?;
    wide.pop();
    normalize_wide_path(&wide)
}

fn normalize_wide_path(wide: &[u16]) -> Option<String> {
    let value = String::from_utf16(wide).ok()?.replace('/', "\\");
    let value = if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = value.strip_prefix("\\\\?\\") {
        rest.to_owned()
    } else {
        value
    };
    Some(value.trim_end_matches('\\').to_lowercase())
}

fn extended_path_wide(path: &Path) -> Option<Vec<u16>> {
    let value = path.as_os_str().encode_wide().collect::<Vec<_>>();
    let mut prefixed = if starts_with_wide(&value, "\\\\?\\") {
        value
    } else if starts_with_wide(&value, "\\\\") {
        "\\\\?\\UNC\\"
            .encode_utf16()
            .chain(value.into_iter().skip(2))
            .collect()
    } else {
        "\\\\?\\".encode_utf16().chain(value).collect()
    };
    prefixed.push(0);
    Some(prefixed)
}

fn starts_with_wide(value: &[u16], prefix: &str) -> bool {
    value.starts_with(&prefix.encode_utf16().collect::<Vec<_>>())
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}

fn close_or_abort(handle: OwnedHandle, label: &str) {
    let raw = handle.into_raw_handle().cast();
    if unsafe { CloseHandle(raw) } == 0 {
        abort_unproven_release(label);
    }
}

fn abort_unproven_release(label: &str) -> ! {
    eprintln!("TokenGraph native release could not be proven: {label}");
    std::process::abort()
}

fn last_error_code() -> u32 {
    std::io::Error::last_os_error()
        .raw_os_error()
        .and_then(|code| u32::try_from(code).ok())
        .unwrap_or_default()
}

fn ambiguous_path_error(code: u32) -> bool {
    matches!(
        code,
        ERROR_ACCESS_DENIED
            | ERROR_CANT_ACCESS_FILE
            | ERROR_DIRECTORY
            | ERROR_FILENAME_EXCED_RANGE
            | ERROR_FILE_NOT_FOUND
            | ERROR_INVALID_NAME
            | ERROR_INVALID_PARAMETER
            | ERROR_INVALID_REPARSE_DATA
            | ERROR_NOT_A_REPARSE_POINT
            | ERROR_PATH_NOT_FOUND
            | ERROR_SHARING_VIOLATION
    )
}
