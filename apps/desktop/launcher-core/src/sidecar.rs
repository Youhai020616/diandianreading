//! Resolution of the one sidecar executable the launcher is allowed to start.
//!
//! Section 9.1 permits starting only "the fixed sidecar declared in the bundle".
//! Resolution therefore refuses anything that is not a regular file inside the
//! resource directory, so a symlink, a relative segment or an environment value
//! cannot redirect the launcher at an arbitrary executable.

use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

/// Directory inside the bundle resources that holds the packaged sidecar.
pub const BUNDLED_SIDECAR_DIR: &str = "sidecar";

/// File name of the packaged sidecar executable.
pub const BUNDLED_SIDECAR_BIN: &str = "diandian-desktop-sidecar";

/// Why sidecar resolution refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SidecarResolveError {
    /// The expected executable was absent or not a regular file.
    Missing,
    /// The resolved path escaped the resource directory.
    Escaped,
}

impl fmt::Display for SidecarResolveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            Self::Missing => "bundled sidecar executable is unavailable",
            Self::Escaped => "bundled sidecar path escaped the resource directory",
        };
        formatter.write_str(reason)
    }
}

impl Error for SidecarResolveError {}

/// Resolve the packaged sidecar beneath a bundle resource directory.
///
/// # Errors
///
/// Returns [`SidecarResolveError`] when the executable is missing or when the
/// canonical path is not contained by the canonical resource directory.
pub fn resolve_bundled(resource_dir: &Path) -> Result<PathBuf, SidecarResolveError> {
    let candidate = resource_dir
        .join(BUNDLED_SIDECAR_DIR)
        .join(BUNDLED_SIDECAR_BIN);
    let resolved = candidate
        .canonicalize()
        .map_err(|_| SidecarResolveError::Missing)?;
    if !resolved.is_file() {
        return Err(SidecarResolveError::Missing);
    }
    let root = resource_dir
        .canonicalize()
        .map_err(|_| SidecarResolveError::Missing)?;
    if !resolved.starts_with(&root) {
        return Err(SidecarResolveError::Escaped);
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::{resolve_bundled, SidecarResolveError, BUNDLED_SIDECAR_BIN, BUNDLED_SIDECAR_DIR};
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!("launcher-core-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_a_regular_file_inside_resources() {
        let root = TempDir::new("resolve");
        let dir = root.path().join(BUNDLED_SIDECAR_DIR);
        fs::create_dir_all(&dir).expect("sidecar dir");
        let binary = dir.join(BUNDLED_SIDECAR_BIN);
        fs::write(&binary, b"#!/bin/sh\n").expect("sidecar file");
        let resolved = resolve_bundled(root.path()).expect("resolution succeeds");
        assert!(resolved.ends_with(BUNDLED_SIDECAR_BIN));
        assert!(resolved.starts_with(root.path().canonicalize().expect("canonical root")));
    }

    #[test]
    fn refuses_a_missing_executable() {
        let root = TempDir::new("missing");
        assert_eq!(
            resolve_bundled(root.path()).unwrap_err(),
            SidecarResolveError::Missing
        );
    }

    #[test]
    fn refuses_a_directory_in_place_of_the_executable() {
        let root = TempDir::new("directory");
        fs::create_dir_all(
            root.path()
                .join(BUNDLED_SIDECAR_DIR)
                .join(BUNDLED_SIDECAR_BIN),
        )
        .expect("directory instead of file");
        assert_eq!(
            resolve_bundled(root.path()).unwrap_err(),
            SidecarResolveError::Missing
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_escapes_resources() {
        let root = TempDir::new("escape");
        let outside = TempDir::new("outside");
        let target = outside.path().join("other-binary");
        fs::write(&target, b"#!/bin/sh\n").expect("outside file");
        let dir = root.path().join(BUNDLED_SIDECAR_DIR);
        fs::create_dir_all(&dir).expect("sidecar dir");
        std::os::unix::fs::symlink(&target, dir.join(BUNDLED_SIDECAR_BIN)).expect("symlink");
        assert_eq!(
            resolve_bundled(root.path()).unwrap_err(),
            SidecarResolveError::Escaped
        );
    }
}
