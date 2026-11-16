//! Filesystem errors shaped like Node's, because Core passes their messages to the model and its
//! local tools report Node errors such as `ENOENT: no such file or directory, open '/x'`.

use std::io;
use std::path::Path;

use nix::errno::Errno;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct FsError {
    pub code: String,
    pub message: String,
}

impl FsError {
    pub fn from_io(error: &io::Error, syscall: &str, path: &Path) -> Self {
        let (code, description) = describe(error);
        Self {
            code: code.to_string(),
            message: format!("{code}: {description}, {syscall} '{}'", path.display()),
        }
    }

    /// Node reports failed reads without a path, for example `EISDIR: illegal operation on a
    /// directory, read`.
    pub fn from_read(error: &io::Error) -> Self {
        let (code, description) = describe(error);
        Self {
            code: code.to_string(),
            message: format!("{code}: {description}, read"),
        }
    }

    pub fn other(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

fn describe(error: &io::Error) -> (&'static str, &'static str) {
    let Some(raw) = error.raw_os_error() else {
        return match error.kind() {
            io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
            io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
            io::ErrorKind::InvalidData => ("EINVAL", "invalid argument"),
            _ => ("UNKNOWN", "unknown error"),
        };
    };
    // Descriptions follow libuv's `uv_strerror`, which Node uses.
    match Errno::from_raw(raw) {
        Errno::ENOENT => ("ENOENT", "no such file or directory"),
        Errno::EACCES => ("EACCES", "permission denied"),
        Errno::EPERM => ("EPERM", "operation not permitted"),
        Errno::ENOTDIR => ("ENOTDIR", "not a directory"),
        Errno::EISDIR => ("EISDIR", "illegal operation on a directory"),
        Errno::EEXIST => ("EEXIST", "file already exists"),
        Errno::ENOTEMPTY => ("ENOTEMPTY", "directory not empty"),
        Errno::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        Errno::ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        Errno::EROFS => ("EROFS", "read-only file system"),
        Errno::ENOSPC => ("ENOSPC", "no space left on device"),
        Errno::EIO => ("EIO", "i/o error"),
        Errno::EBUSY => ("EBUSY", "resource busy or locked"),
        Errno::EINVAL => ("EINVAL", "invalid argument"),
        Errno::EMFILE => ("EMFILE", "too many open files"),
        Errno::ENFILE => ("ENFILE", "file table overflow"),
        Errno::ETXTBSY => ("ETXTBSY", "text file is busy"),
        Errno::EXDEV => ("EXDEV", "cross-device link not permitted"),
        Errno::EFBIG => ("EFBIG", "file too large"),
        Errno::ENODEV => ("ENODEV", "no such device"),
        Errno::ENXIO => ("ENXIO", "no such device or address"),
        _ => ("UNKNOWN", "unknown error"),
    }
}

/// Matches `isSkippableTraversalError` in `packages/fs`.
pub fn is_skippable(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error().map(Errno::from_raw),
        Some(Errno::EACCES | Errno::EPERM | Errno::ENOENT | Errno::ENOTDIR)
    ) || matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
    )
}
