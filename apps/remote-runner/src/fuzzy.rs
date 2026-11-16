//! Candidate walk for fuzzy search, ported from `fzfFileSearch` in `packages/fs/src/search-backend.ts`.
//! Core ranks the candidates with the same `fzf` code it uses locally.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::errors::is_skippable;
use crate::glob::is_denied;
use crate::protocol::FuzzyCandidatesRequest;

#[derive(Debug, Serialize)]
pub struct Candidate {
    path: String,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyCandidates {
    files: Vec<Candidate>,
    truncated: bool,
}

/// `None` means the walk hit an error the local fallback also gives up on.
pub fn fuzzy_candidates(request: &FuzzyCandidatesRequest) -> Option<FuzzyCandidates> {
    let cwd = PathBuf::from(&request.cwd);
    let deadline = Instant::now() + Duration::from_millis(request.budget_ms);
    let denied = |path: &Path| !request.dangerously_allow && is_denied(path, &request.deny_paths);
    let mut files: Vec<String> = Vec::new();
    let mut pending: Vec<PathBuf> = vec![cwd.clone()];
    let mut truncated = false;

    while let Some(directory) = pending.pop() {
        if files.len() as u64 >= request.max_files || Instant::now() >= deadline {
            truncated = true;
            break;
        }
        if denied(&directory) {
            continue;
        }
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => continue,
            Err(error) if is_skippable(&error) => continue,
            Err(_) => return None,
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if is_skippable(&error) => continue,
            Err(_) => return None,
        };
        match fs::canonicalize(&directory) {
            Ok(canonical) if canonical == directory && !denied(&canonical) => {}
            Ok(_) => continue,
            Err(error) if is_skippable(&error) => continue,
            Err(_) => return None,
        }
        let mut children: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            if files.len() as u64 >= request.max_files || Instant::now() >= deadline {
                truncated = true;
                break;
            }
            let absolute = directory.join(entry.file_name());
            if denied(&absolute) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                children.push(absolute);
            } else if kind.is_file() {
                let relative = absolute.strip_prefix(&cwd).unwrap_or(&absolute);
                files.push(relative.to_string_lossy().into_owned());
            }
        }
        children.sort();
        children.reverse();
        pending.extend(children);
    }

    files.sort();
    let files = files
        .into_iter()
        .filter_map(|path| {
            let size = fs::symlink_metadata(cwd.join(&path)).ok()?;
            size.is_file().then(|| Candidate {
                path,
                size: size.len(),
            })
        })
        .collect();
    Some(FuzzyCandidates { files, truncated })
}
