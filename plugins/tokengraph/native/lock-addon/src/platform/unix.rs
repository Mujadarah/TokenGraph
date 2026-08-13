//! Descriptor-identity locking for cooperative TokenGraph processes on POSIX.
//!
//! `flock` cannot prevent another process running as the same uid from unlinking
//! an anchor. TokenGraph therefore supports cooperative local processes in a
//! restrictively owned directory; hostile same-account path replacement and
//! network filesystems are outside this lock's claimed boundary.

use std::{
    ffi::OsStr,
    os::fd::{IntoRawFd, OwnedFd},
    path::{Component, Path},
};

use rustix::{
    fs::{self, AtFlags, FileType, FlockOperation, Mode, OFlags, Stat},
    io::Errno,
    process,
};

use crate::LockError;

const DIRECTORY_FLAGS: OFlags = OFlags::DIRECTORY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const ANCHOR_FLAGS: OFlags = OFlags::CREATE
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NONBLOCK)
    .union(OFlags::NOCTTY)
    .union(OFlags::RDWR);

unsafe extern "C" {
    fn close(fd: i32) -> i32;
}

pub struct UnixLock {
    anchor: OwnedFd,
    compatibility_directory: Option<OwnedFd>,
    released: bool,
}

impl UnixLock {
    pub fn try_acquire(path: &Path) -> Result<Self, LockError> {
        Self::try_acquire_with_opener(path, open_anchor_descriptor)
    }

    fn try_acquire_with_opener<F>(path: &Path, opener: F) -> Result<Self, LockError>
    where
        F: FnOnce(&OwnedFd, &OsStr) -> Result<OwnedFd, LockError>,
    {
        let (parent, name) = open_parent(path, LockError::unsafe_anchor)?;
        let entry_before = match fs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(entry) => {
                if !anchor_metadata_is_safe_for_uid(&entry, process::geteuid().as_raw()) {
                    return Err(LockError::unsafe_anchor());
                }
                Some(entry)
            }
            Err(Errno::NOENT) => None,
            Err(error) => {
                return Err(map_open_error(error, LockError::unsafe_anchor));
            }
        };

        let anchor = opener(&parent, name)?;

        let descriptor = fs::fstat(&anchor).map_err(|_| LockError::unsafe_anchor())?;
        let entry_after = fs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|_| LockError::unsafe_anchor())?;
        if !anchor_metadata_is_safe_for_uid(&descriptor, process::geteuid().as_raw())
            || entry_before
                .as_ref()
                .is_some_and(|entry| !same_identity(entry, &descriptor))
            || !same_identity(&descriptor, &entry_after)
        {
            return Err(LockError::unsafe_anchor());
        }

        if let Err(error) = fs::flock(&anchor, FlockOperation::NonBlockingLockExclusive) {
            return Err(if error == Errno::AGAIN || error == Errno::WOULDBLOCK {
                LockError::lock_busy()
            } else {
                LockError::native_lock_error()
            });
        }

        Ok(Self {
            anchor,
            compatibility_directory: None,
            released: false,
        })
    }

    pub fn protect_compatibility_directory(&mut self, path: &Path) -> Result<(), LockError> {
        self.protect_compatibility_directory_with_opener(path, |parent, name| {
            open_directory_descriptor(parent, name, LockError::unsafe_compatibility_directory)
        })
    }

    fn protect_compatibility_directory_with_opener<F>(
        &mut self,
        path: &Path,
        opener: F,
    ) -> Result<(), LockError>
    where
        F: FnOnce(&OwnedFd, &OsStr) -> Result<OwnedFd, LockError>,
    {
        if self.compatibility_directory.is_some() {
            return Err(LockError::invalid_argument());
        }

        let unsafe_error = LockError::unsafe_compatibility_directory;
        let (parent, name) = open_parent(path, unsafe_error)?;
        let entry_before =
            fs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| unsafe_error())?;
        if !safe_owned_directory(&entry_before) {
            return Err(unsafe_error());
        }

        let directory = opener(&parent, name)?;
        let descriptor = fs::fstat(&directory).map_err(|_| unsafe_error())?;
        let entry_after =
            fs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| unsafe_error())?;
        if !safe_owned_directory(&descriptor)
            || !same_identity(&entry_before, &descriptor)
            || !same_identity(&descriptor, &entry_after)
        {
            return Err(unsafe_error());
        }

        self.compatibility_directory = Some(directory);
        Ok(())
    }

    pub fn release_compatibility_directory(&mut self) -> Result<(), LockError> {
        let directory = self
            .compatibility_directory
            .take()
            .ok_or_else(LockError::invalid_argument)?;
        close_or_abort(directory, "compatibility directory descriptor");
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

        if fs::flock(&self.anchor, FlockOperation::Unlock).is_err() {
            abort_unproven_release("anchor unlock");
        }

        close_or_abort(self.anchor, "anchor descriptor");
        Ok(())
    }
}

fn open_parent(
    path: &Path,
    unsafe_error: fn() -> LockError,
) -> Result<(OwnedFd, &OsStr), LockError> {
    let components = validated_components(path, unsafe_error)?;
    let (name, parents) = components.split_last().ok_or_else(unsafe_error)?;
    let mut current = open_filesystem_root(unsafe_error)?;

    for component in parents {
        current = open_directory_component(&current, component, unsafe_error)?;
    }

    Ok((current, name))
}

fn open_filesystem_root(unsafe_error: fn() -> LockError) -> Result<OwnedFd, LockError> {
    fs::open("/", DIRECTORY_FLAGS, Mode::empty())
        .map_err(|error| map_open_error(error, unsafe_error))
}

fn open_directory_component(
    parent: &OwnedFd,
    component: &OsStr,
    unsafe_error: fn() -> LockError,
) -> Result<OwnedFd, LockError> {
    let directory = open_directory_descriptor(parent, component, unsafe_error)?;
    let descriptor = fs::fstat(&directory).map_err(|_| unsafe_error())?;
    let entry =
        fs::statat(parent, component, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| unsafe_error())?;
    if FileType::from_raw_mode(descriptor.st_mode) != FileType::Directory
        || !same_identity(&descriptor, &entry)
    {
        return Err(unsafe_error());
    }
    Ok(directory)
}

fn open_anchor_descriptor(parent: &OwnedFd, name: &OsStr) -> Result<OwnedFd, LockError> {
    fs::openat(parent, name, ANCHOR_FLAGS, Mode::RUSR | Mode::WUSR)
        .map_err(|error| map_open_error(error, LockError::unsafe_anchor))
}

fn open_directory_descriptor(
    parent: &OwnedFd,
    component: &OsStr,
    unsafe_error: fn() -> LockError,
) -> Result<OwnedFd, LockError> {
    fs::openat(parent, component, DIRECTORY_FLAGS, Mode::empty())
        .map_err(|error| map_open_error(error, unsafe_error))
}

fn validated_components(
    path: &Path,
    unsafe_error: fn() -> LockError,
) -> Result<Vec<&OsStr>, LockError> {
    if !path.is_absolute() {
        return Err(unsafe_error());
    }

    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(value) if safe_component(value) => components.push(value),
            _ => return Err(unsafe_error()),
        }
    }
    Ok(components)
}

fn safe_component(value: &OsStr) -> bool {
    !value.is_empty() && !value.as_encoded_bytes().contains(&0)
}

fn anchor_metadata_is_safe_for_uid(stat: &Stat, expected_uid: process::RawUid) -> bool {
    FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile
        && stat.st_uid == expected_uid
        && stat.st_nlink == 1
        && Mode::from_raw_mode(stat.st_mode)
            .intersection(Mode::RWXG | Mode::RWXO)
            .is_empty()
}

fn safe_owned_directory(stat: &Stat) -> bool {
    FileType::from_raw_mode(stat.st_mode) == FileType::Directory
        && stat.st_uid == process::geteuid().as_raw()
        && Mode::from_raw_mode(stat.st_mode)
            .intersection(Mode::RWXG | Mode::RWXO)
            .is_empty()
}

fn same_identity(left: &Stat, right: &Stat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
}

fn map_open_error(error: Errno, unsafe_error: fn() -> LockError) -> LockError {
    if error == Errno::ACCESS
        || error == Errno::PERM
        || error == Errno::LOOP
        || error == Errno::NOTDIR
        || error == Errno::NOENT
        || error == Errno::INVAL
        || error == Errno::NAMETOOLONG
        || error == Errno::ISDIR
    {
        unsafe_error()
    } else {
        LockError::native_lock_error()
    }
}

fn abort_unproven_release(label: &str) -> ! {
    eprintln!("TokenGraph native release could not be proven: {label}");
    std::process::abort()
}

fn close_or_abort(descriptor: OwnedFd, label: &str) {
    let raw = descriptor.into_raw_fd();
    if unsafe { close(raw) } != 0 {
        abort_unproven_release(label);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        cell::Cell,
        fs as std_fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    #[test]
    fn fifo_is_rejected_before_any_potentially_blocking_open() {
        let temp = TestDirectory::new("fifo-prevalidation");
        let fifo = temp.path().join("anchor.lock");
        let status = Command::new("mkfifo").arg(&fifo).status().unwrap();
        assert!(status.success(), "mkfifo failed for the controlled fixture");
        let opener_called = Cell::new(false);

        let error = expect_acquire_error(UnixLock::try_acquire_with_opener(&fifo, |_, _| {
            opener_called.set(true);
            Err(LockError::native_lock_error())
        }));

        assert_eq!(error.code(), "UNSAFE_ANCHOR");
        assert!(
            !opener_called.get(),
            "a nonregular entry must be rejected before open"
        );
    }

    #[test]
    fn anchor_metadata_policy_rejects_a_foreign_effective_uid() {
        let temp = TestDirectory::new("foreign-owner-policy");
        let anchor = temp.path().join("anchor.lock");
        create_restrictive_file(&anchor);
        let descriptor = fs::open(&anchor, OFlags::RDWR | OFlags::CLOEXEC, Mode::empty()).unwrap();
        let stat = fs::fstat(&descriptor).unwrap();
        let foreign_uid = stat.st_uid.wrapping_add(1);

        assert!(anchor_metadata_is_safe_for_uid(&stat, stat.st_uid));
        assert!(!anchor_metadata_is_safe_for_uid(&stat, foreign_uid));
    }

    #[test]
    fn anchor_replacement_between_open_and_verification_is_rejected() {
        let temp = TestDirectory::new("anchor-identity-mismatch");
        let anchor = temp.path().join("anchor.lock");
        let moved = temp.path().join("moved-anchor.lock");
        create_restrictive_file(&anchor);

        let error = expect_acquire_error(UnixLock::try_acquire_with_opener(
            &anchor,
            |parent, name| {
                let descriptor = open_anchor_descriptor(parent, name)?;
                std_fs::rename(&anchor, &moved).unwrap();
                create_restrictive_file(&anchor);
                Ok(descriptor)
            },
        ));

        assert_eq!(error.code(), "UNSAFE_ANCHOR");
    }

    #[test]
    fn compatibility_replacement_during_protection_is_rejected() {
        let temp = TestDirectory::new("compatibility-identity-mismatch");
        let anchor = temp.path().join("anchor.lock");
        let compatibility = temp.path().join("compatibility.lock");
        let moved = temp.path().join("moved-compatibility.lock");
        create_restrictive_directory(&compatibility);
        let mut lock = UnixLock::try_acquire(&anchor).unwrap();

        let error = lock
            .protect_compatibility_directory_with_opener(&compatibility, |parent, name| {
                let descriptor = open_directory_descriptor(
                    parent,
                    name,
                    LockError::unsafe_compatibility_directory,
                )?;
                std_fs::rename(&compatibility, &moved).unwrap();
                create_restrictive_directory(&compatibility);
                Ok(descriptor)
            })
            .unwrap_err();

        assert_eq!(error.code(), "UNSAFE_COMPATIBILITY_DIRECTORY");
        lock.protect_compatibility_directory(&compatibility)
            .unwrap();
        lock.release_compatibility_directory().unwrap();
        lock.release().unwrap();
    }

    fn create_restrictive_file(path: &Path) {
        std_fs::write(path, b"").unwrap();
        std_fs::set_permissions(path, std_fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn expect_acquire_error(result: Result<UnixLock, LockError>) -> LockError {
        match result {
            Ok(lock) => {
                lock.release().unwrap();
                panic!("anchor acquisition unexpectedly succeeded")
            }
            Err(error) => error,
        }
    }

    fn create_restrictive_directory(path: &Path) {
        std_fs::create_dir(path).unwrap();
        std_fs::set_permissions(path, std_fs::Permissions::from_mode(0o700)).unwrap();
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let physical_temp = std_fs::canonicalize(std::env::temp_dir()).unwrap();
            let path = physical_temp.join(format!(
                "tokengraph-lock-unix-{label}-{}-{nonce}",
                std::process::id()
            ));
            std_fs::create_dir(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std_fs::remove_dir_all(&self.path);
        }
    }
}
