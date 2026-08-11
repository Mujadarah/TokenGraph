use std::path::Path;

use napi_derive::napi;

mod platform;

pub const ABI_VERSION: u32 = 1;

#[derive(Debug)]
pub enum LockError {
    LockBusy,
    UnsafeAnchor,
    UnsafeCompatibilityDirectory,
    NativeLockError,
    AlreadyReleased,
    InvalidArgument,
}

impl LockError {
    pub fn lock_busy() -> Self {
        Self::LockBusy
    }

    pub fn unsafe_anchor() -> Self {
        Self::UnsafeAnchor
    }

    pub fn unsafe_compatibility_directory() -> Self {
        Self::UnsafeCompatibilityDirectory
    }

    pub fn native_lock_error() -> Self {
        Self::NativeLockError
    }

    pub fn already_released() -> Self {
        Self::AlreadyReleased
    }

    pub fn invalid_argument() -> Self {
        Self::InvalidArgument
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::LockBusy => "LOCK_BUSY",
            Self::UnsafeAnchor => "UNSAFE_ANCHOR",
            Self::UnsafeCompatibilityDirectory => "UNSAFE_COMPATIBILITY_DIRECTORY",
            Self::NativeLockError => "NATIVE_LOCK_ERROR",
            Self::AlreadyReleased => "ALREADY_RELEASED",
            Self::InvalidArgument => "INVALID_ARGUMENT",
        }
    }

    pub fn safe_message(&self) -> &'static str {
        match self {
            Self::LockBusy => "The requested lock is already held.",
            Self::UnsafeAnchor => "The lock anchor is unsafe.",
            Self::UnsafeCompatibilityDirectory => "The compatibility directory is unsafe.",
            Self::NativeLockError => "The native lock operation failed.",
            Self::AlreadyReleased => "The native lock handle has already been released.",
            Self::InvalidArgument => "The native lock argument is invalid.",
        }
    }
}

impl From<LockError> for napi::Error {
    fn from(error: LockError) -> Self {
        napi::Error::new(
            napi::Status::GenericFailure,
            format!("{}: {}", error.code(), error.safe_message()),
        )
    }
}

#[allow(non_upper_case_globals)]
#[napi]
pub const abiVersion: u32 = ABI_VERSION;

#[napi]
pub fn implementation() -> &'static str {
    if cfg!(windows) { "lockfileex" } else { "flock" }
}

#[derive(Debug, PartialEq, Eq)]
enum HandleLifecycle {
    AnchorHeld,
    CompatibilityProtected,
    Released,
}

impl HandleLifecycle {
    fn protect_compatibility_directory(&mut self) -> Result<(), LockError> {
        if *self != Self::AnchorHeld {
            return Err(LockError::invalid_argument());
        }
        *self = Self::CompatibilityProtected;
        Ok(())
    }

    fn release_compatibility_directory(&mut self) -> Result<(), LockError> {
        if *self != Self::CompatibilityProtected {
            return Err(LockError::invalid_argument());
        }
        *self = Self::AnchorHeld;
        Ok(())
    }

    fn release_anchor(&mut self) -> Result<(), LockError> {
        if *self == Self::Released {
            return Err(LockError::already_released());
        }
        if *self == Self::CompatibilityProtected {
            return Err(LockError::invalid_argument());
        }
        *self = Self::Released;
        Ok(())
    }
}

#[napi]
pub fn try_acquire_anchor(path: String) -> napi::Result<NativeLockHandle> {
    if path.is_empty() {
        return Err(LockError::invalid_argument().into());
    }

    let inner = platform::PlatformLock::try_acquire(Path::new(&path)).map_err(napi::Error::from)?;
    Ok(NativeLockHandle {
        inner: Some(inner),
        lifecycle: HandleLifecycle::AnchorHeld,
    })
}

#[napi(custom_finalize)]
pub struct NativeLockHandle {
    inner: Option<platform::PlatformLock>,
    lifecycle: HandleLifecycle,
}

impl napi::bindgen_prelude::ObjectFinalize for NativeLockHandle {
    fn finalize(mut self, _env: napi::Env) -> napi::Result<()> {
        if let Some(mut lock) = self.inner.take() {
            if self.lifecycle == HandleLifecycle::CompatibilityProtected
                && let Err(error) = lock.release_compatibility_directory()
            {
                eprintln!(
                    "TokenGraph native compatibility release could not be proven: {}",
                    error.code()
                );
                std::process::abort();
            }
            if let Err(error) = lock.release() {
                eprintln!(
                    "TokenGraph native lock finalizer could not prove release: {}",
                    error.code()
                );
                std::process::abort();
            }
        }
        Ok(())
    }
}

#[napi]
impl NativeLockHandle {
    #[napi]
    pub fn protect_compatibility_directory(&mut self, path: String) -> napi::Result<()> {
        if path.is_empty() {
            return Err(LockError::invalid_argument().into());
        }

        if self.lifecycle != HandleLifecycle::AnchorHeld {
            return Err(LockError::invalid_argument().into());
        }

        self.inner
            .as_mut()
            .ok_or_else(LockError::already_released)?
            .protect_compatibility_directory(Path::new(&path))
            .map_err(napi::Error::from)?;
        self.lifecycle
            .protect_compatibility_directory()
            .map_err(napi::Error::from)
    }

    #[napi]
    pub fn release_compatibility_directory(&mut self) -> napi::Result<()> {
        if self.lifecycle != HandleLifecycle::CompatibilityProtected {
            return Err(LockError::invalid_argument().into());
        }

        let lock = self
            .inner
            .as_mut()
            .ok_or_else(LockError::already_released)?;
        if let Err(error) = lock.release_compatibility_directory() {
            eprintln!(
                "TokenGraph native compatibility release could not be proven: {}",
                error.code()
            );
            std::process::abort();
        }
        self.lifecycle
            .release_compatibility_directory()
            .map_err(napi::Error::from)
    }

    #[napi]
    pub fn release(&mut self) -> napi::Result<()> {
        self.lifecycle.release_anchor().map_err(napi::Error::from)?;
        let lock = self.inner.take().ok_or_else(LockError::already_released)?;
        if let Err(error) = lock.release() {
            eprintln!(
                "TokenGraph native lock release could not be proven: {}",
                error.code()
            );
            std::process::abort();
        }
        Ok(())
    }
}

#[cfg(test)]
mod lifecycle_contract {
    use std::process::Command;

    use super::*;

    fn compatibility_protected_handle() -> NativeLockHandle {
        NativeLockHandle {
            inner: Some(platform::PlatformLock),
            lifecycle: HandleLifecycle::CompatibilityProtected,
        }
    }

    #[test]
    fn rejects_double_compatibility_protection() {
        let mut lifecycle = HandleLifecycle::AnchorHeld;
        lifecycle.protect_compatibility_directory().unwrap();
        assert_eq!(
            lifecycle
                .protect_compatibility_directory()
                .unwrap_err()
                .code(),
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn rejects_compatibility_release_before_protection() {
        let mut lifecycle = HandleLifecycle::AnchorHeld;
        assert_eq!(
            lifecycle
                .release_compatibility_directory()
                .unwrap_err()
                .code(),
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn rejects_anchor_release_while_compatibility_protection_is_active() {
        let mut lifecycle = HandleLifecycle::AnchorHeld;
        lifecycle.protect_compatibility_directory().unwrap();
        assert_eq!(
            lifecycle.release_anchor().unwrap_err().code(),
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn permits_protect_then_compatibility_release_then_anchor_release() {
        let mut lifecycle = HandleLifecycle::AnchorHeld;
        lifecycle.protect_compatibility_directory().unwrap();
        lifecycle.release_compatibility_directory().unwrap();
        lifecycle.release_anchor().unwrap();
        assert_eq!(
            lifecycle.release_anchor().unwrap_err().code(),
            "ALREADY_RELEASED"
        );
    }

    #[test]
    fn compatibility_release_failure_aborts_the_process() {
        const CHILD_MARKER: &str = "TOKENGRAPH_LOCK_TEST_COMPATIBILITY_RELEASE_FAILURE";

        if std::env::var_os(CHILD_MARKER).is_some() {
            let mut handle = compatibility_protected_handle();
            assert!(handle.release_compatibility_directory().is_err());
            std::process::exit(17);
        }

        let status = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("lifecycle_contract::compatibility_release_failure_aborts_the_process")
            .arg("--nocapture")
            .env(CHILD_MARKER, "1")
            .status()
            .unwrap();
        assert_ne!(status.code(), Some(17));
    }
}
