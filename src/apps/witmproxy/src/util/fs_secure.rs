//! Helpers for writing files and directories that may contain secrets with
//! restrictive permissions.
//!
//! On Unix, secret files are created `0o600` (owner read/write only) and secret
//! directories `0o700`. On non-Unix platforms these fall back to the default
//! permissions (Windows ACLs already restrict a user's profile directory).

use anyhow::{Context, Result};
use std::path::Path;

/// Write `contents` to `path`, creating the file `0o600` if it does not already
/// exist and tightening an existing file's permissions to `0o600`.
pub fn write_secret(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> Result<()> {
    let path = path.as_ref();
    std::fs::write(path, contents)
        .with_context(|| format!("failed to write {}", path.display()))?;
    restrict_file(path)
}

/// Tighten an existing file's permissions to `0o600` (owner-only) on Unix.
pub fn restrict_file(path: impl AsRef<Path>) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = path.as_ref();
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .with_context(|| format!("failed to chmod 600 {}", path.display()))?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// Create `path` (and parents) as a directory, tightening it to `0o700`
/// (owner-only) on Unix. Safe to call repeatedly.
pub fn create_dir_secure(path: impl AsRef<Path>) -> Result<()> {
    let path = path.as_ref();
    std::fs::create_dir_all(path)
        .with_context(|| format!("failed to create directory {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("failed to chmod 700 {}", path.display()))?;
    }
    Ok(())
}
