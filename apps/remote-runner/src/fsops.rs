//! Filesystem primitives behind Core's remote `FileSystemHost`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::os::unix::fs::FileTypeExt;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::errors::FsError;

#[derive(Debug, Serialize)]
pub struct Stats {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub size: u64,
}

pub fn file_kind(file_type: fs::FileType) -> &'static str {
    if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_socket() {
        "socket"
    } else if file_type.is_block_device() {
        "block_device"
    } else if file_type.is_char_device() {
        "character_device"
    } else if file_type.is_fifo() {
        "fifo"
    } else {
        "unknown"
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub fn realpath(path: &str) -> Result<String, FsError> {
    let path = Path::new(path);
    fs::canonicalize(path)
        .map(|canonical| path_text(&canonical))
        .map_err(|error| FsError::from_io(&error, "realpath", path))
}

/// Normalizes `.` and `..` without touching the filesystem, like Node's `path.resolve`.
pub fn lexical_resolve(path: &Path) -> PathBuf {
    let mut resolved = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(part) => resolved.push(part),
        }
    }
    resolved
}

/// Port of `canonicalizeLocalPathAsFarAsExists` in `packages/fs/src/node-host.ts`.
pub fn canonicalize_as_far_as_exists(input: &str) -> Result<String, FsError> {
    let mut current = lexical_resolve(Path::new(input));
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let finish = |base: &Path, missing: &[std::ffi::OsString]| {
        let mut joined = base.to_path_buf();
        for segment in missing {
            joined.push(segment);
        }
        path_text(&lexical_resolve(&joined))
    };
    loop {
        match fs::canonicalize(&current) {
            Ok(canonical) => return Ok(finish(&canonical, &missing)),
            Err(error) if !is_missing(&error) => {
                return Err(FsError::from_io(&error, "realpath", &current));
            }
            Err(_) => {}
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let target = fs::read_link(&current)
                    .map_err(|error| FsError::from_io(&error, "readlink", &current))?;
                current = if target.is_absolute() {
                    lexical_resolve(&target)
                } else {
                    let parent = current.parent().map(Path::to_path_buf).unwrap_or_default();
                    lexical_resolve(&parent.join(target))
                };
                continue;
            }
            Ok(_) => {}
            Err(error) if !is_missing(&error) => {
                return Err(FsError::from_io(&error, "lstat", &current));
            }
            Err(_) => {}
        }
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            return Ok(finish(&current, &missing));
        };
        if parent == current {
            return Ok(finish(&current, &missing));
        }
        if let Some(name) = current.file_name() {
            missing.insert(0, name.to_os_string());
        }
        current = parent;
    }
}

fn is_missing(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error().map(nix::errno::Errno::from_raw),
        Some(nix::errno::Errno::ENOENT | nix::errno::Errno::ENOTDIR)
    ) || error.kind() == std::io::ErrorKind::NotFound
}

pub fn stat(path: &str) -> Result<Stats, FsError> {
    let path = Path::new(path);
    let metadata = fs::metadata(path).map_err(|error| FsError::from_io(&error, "stat", path))?;
    Ok(Stats {
        kind: file_kind(metadata.file_type()),
        size: metadata.len(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BytesRead {
    base64: String,
    total_bytes: u64,
}

pub fn read_prefix(path: &str, limit: u64) -> Result<BytesRead, FsError> {
    let path = Path::new(path);
    let file = fs::File::open(path).map_err(|error| FsError::from_io(&error, "open", path))?;
    let total_bytes = file
        .metadata()
        .map_err(|error| FsError::from_io(&error, "fstat", path))?
        .len();
    let mut bytes = Vec::new();
    file.take(limit.min(total_bytes))
        .read_to_end(&mut bytes)
        .map_err(|error| FsError::from_read(&error))?;
    Ok(BytesRead {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        total_bytes,
    })
}

/// Opens then reads, reporting each step's failure the way Node does.
fn read_all(path: &Path) -> Result<Vec<u8>, FsError> {
    let mut file = fs::File::open(path).map_err(|error| FsError::from_io(&error, "open", path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| FsError::from_read(&error))?;
    Ok(bytes)
}

pub fn read_bytes(path: &str) -> Result<BytesRead, FsError> {
    let path = Path::new(path);
    let bytes = read_all(path)?;
    Ok(BytesRead {
        total_bytes: bytes.len() as u64,
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// Reads UTF-8 text with replacement characters, like `fs.readFile(path, "utf-8")`.
pub fn read_text(path: &str) -> Result<String, FsError> {
    let path = Path::new(path);
    let bytes = read_all(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// SHA-256 of each file's decoded text, which is what Core hashes for hashline anchors.
pub fn hash_text_files(paths: &[String]) -> Result<BTreeMap<String, String>, FsError> {
    let mut hashes = BTreeMap::new();
    for path in paths {
        if hashes.contains_key(path) {
            continue;
        }
        let text = read_text(path)?;
        hashes.insert(path.clone(), sha256_hex(text.as_bytes()));
    }
    Ok(hashes)
}

pub fn write_text(path: &str, content: &str, create_parents: bool) -> Result<(), FsError> {
    let path = Path::new(path);
    if create_parents {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| FsError::from_io(&error, "mkdir", parent))?;
        }
    }
    fs::write(path, content).map_err(|error| FsError::from_io(&error, "open", path))
}

pub fn unlink(path: &str) -> Result<(), FsError> {
    let path = Path::new(path);
    fs::remove_file(path).map_err(|error| FsError::from_io(&error, "unlink", path))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Env {
    home: String,
    /// Each deny path resolved, followed by its canonical form when that differs.
    deny_paths: Vec<Vec<String>>,
}

/// Home directory and deny paths, resolved the way `FileSystem`'s constructor resolves them.
pub fn env(deny_paths: &[String]) -> Env {
    let home = std::env::var("HOME").unwrap_or_default();
    let deny_paths = deny_paths
        .iter()
        .map(|path| {
            let expanded = if path == "~" {
                PathBuf::from(&home)
            } else if let Some(rest) = path.strip_prefix("~/") {
                Path::new(&home).join(rest)
            } else {
                PathBuf::from(path)
            };
            let resolved = path_text(&lexical_resolve(&expanded));
            match fs::canonicalize(&resolved).map(|canonical| path_text(&canonical)) {
                Ok(canonical) if canonical != resolved => vec![resolved, canonical],
                _ => vec![resolved],
            }
        })
        .collect();
    Env { home, deny_paths }
}
