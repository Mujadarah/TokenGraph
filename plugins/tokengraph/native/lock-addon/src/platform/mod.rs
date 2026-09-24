#[cfg(any(not(any(windows, unix)), test))]
use std::path::Path;

#[cfg(any(not(any(windows, unix)), test))]
use crate::LockError;

#[cfg(all(windows, not(test)))]
mod windows;

#[cfg(all(windows, not(test)))]
pub use windows::WindowsLock as PlatformLock;

#[cfg(unix)]
mod unix;

#[cfg(all(unix, not(test)))]
pub use unix::UnixLock as PlatformLock;

#[cfg(any(not(any(windows, unix)), test))]
pub struct PlatformLock;

#[cfg(any(not(any(windows, unix)), test))]
impl PlatformLock {
    pub fn try_acquire(_path: &Path) -> Result<Self, LockError> {
        Err(LockError::native_lock_error())
    }

    pub fn protect_compatibility_directory(&mut self, _path: &Path) -> Result<(), LockError> {
        Err(LockError::native_lock_error())
    }

    pub fn release_compatibility_directory(&mut self) -> Result<(), LockError> {
        Err(LockError::native_lock_error())
    }

    pub fn release(self) -> Result<(), LockError> {
        Ok(())
    }
}
