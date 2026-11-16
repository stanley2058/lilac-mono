//! Glob and walk operations.
//!
//! `glob` follows `collectLocalGlobMatches` in `packages/fs/src/glob-walk.ts`: it walks from the
//! literal roots of the include patterns, prunes denied and excluded directories, and follows only
//! the root symlink. Matching uses `globset`, which differs from Node's `path.matchesGlob` in
//! extended glob syntax, so those patterns return `None` and Core filters a `walk` listing itself.
//! Core also re-checks every `glob` result with Node's matcher.

use std::fs;
use std::path::{Path, PathBuf};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Serialize;

use crate::errors::{FsError, is_skippable};
use crate::fsops::{file_kind, lexical_resolve};
use crate::protocol::{GlobRequest, WalkRequest};

#[derive(Debug, Serialize)]
pub struct Entry {
    path: String,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
}

#[derive(Debug, Serialize)]
pub struct GlobOutput {
    paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<Entry>>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    path: String,
    is_directory: bool,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct WalkOutput {
    entries: Vec<WalkEntry>,
    truncated: bool,
}

/// Matches `isDeniedPathIn`: the path or anything below a deny path.
pub fn is_denied(path: &Path, deny_paths: &[String]) -> bool {
    let normalized = lexical_resolve(path);
    let normalized = normalized.to_string_lossy();
    deny_paths.iter().any(|deny| {
        normalized == deny.as_str()
            || (normalized.starts_with(deny.as_str())
                && normalized.as_bytes().get(deny.len()) == Some(&b'/'))
    })
}

fn normalize_pattern(pattern: &str) -> String {
    let mut trimmed = pattern;
    while let Some(rest) = trimmed.strip_prefix("./") {
        trimmed = rest.trim_start_matches('/');
    }
    trimmed.to_string()
}

fn uses_extended_glob(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    bytes
        .windows(2)
        .any(|pair| matches!(pair[0], b'+' | b'@' | b'?' | b'!' | b'*') && pair[1] == b'(')
}

fn build_set(patterns: &[String]) -> Option<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .backslash_escape(true)
            .empty_alternates(true)
            .build()
            .ok()?;
        builder.add(glob);
    }
    builder.build().ok()
}

fn matches_contract(set: &GlobSet, path: &str) -> bool {
    set.is_match(path) || set.is_match(format!("{path}/"))
}

fn has_glob_meta(segment: &str) -> bool {
    segment.chars().any(|c| {
        matches!(
            c,
            '*' | '?' | '[' | ']' | '{' | '}' | '(' | ')' | '!' | '+' | '@'
        )
    })
}

fn literal_search_root(pattern: &str) -> String {
    let segments: Vec<&str> = pattern
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let mut prefix: Vec<&str> = Vec::new();
    for segment in &segments {
        if *segment == "." || *segment == ".." {
            return String::new();
        }
        if has_glob_meta(segment) {
            return prefix.join("/");
        }
        prefix.push(segment);
    }
    prefix.pop();
    prefix.join("/")
}

/// Port of `getGlobSearchRoots`.
pub fn search_roots(patterns: &[String]) -> Vec<String> {
    let mut roots: Vec<String> = patterns
        .iter()
        .map(|pattern| literal_search_root(pattern))
        .collect();
    roots.sort_by_key(String::len);
    let mut deduped: Vec<String> = Vec::new();
    for root in roots {
        if root.is_empty() {
            return vec![String::new()];
        }
        if deduped
            .iter()
            .any(|existing| root == *existing || root.starts_with(&format!("{existing}/")))
        {
            continue;
        }
        deduped.push(root);
    }
    if deduped.is_empty() {
        vec![String::new()]
    } else {
        deduped
    }
}

fn sorted_children(dir: &Path) -> Result<Vec<fs::DirEntry>, std::io::Error> {
    let mut children: Vec<fs::DirEntry> = fs::read_dir(dir)?.filter_map(Result::ok).collect();
    children.sort_by_key(|entry| entry.file_name());
    Ok(children)
}

struct GlobWalk<'a> {
    base: PathBuf,
    includes: GlobSet,
    excludes: GlobSet,
    max_entries: u64,
    with_stats: bool,
    deny_paths: &'a [String],
    dangerously_allow: bool,
    seen: std::collections::HashSet<String>,
    paths: Vec<String>,
    entries: Vec<Entry>,
    truncated: bool,
}

impl GlobWalk<'_> {
    fn denied(&self, path: &Path) -> bool {
        !self.dangerously_allow && is_denied(path, self.deny_paths)
    }

    fn add_match(&mut self, rel: &str, abs: &Path) -> Result<(), FsError> {
        if !self.seen.insert(rel.to_string()) {
            return Ok(());
        }
        let count = if self.with_stats {
            self.entries.len()
        } else {
            self.paths.len()
        } as u64;
        if count >= self.max_entries {
            self.truncated = true;
            return Ok(());
        }
        if !self.with_stats {
            self.paths.push(rel.to_string());
            return Ok(());
        }
        match fs::metadata(abs) {
            Ok(metadata) => self.entries.push(Entry {
                path: rel.to_string(),
                kind: file_kind(metadata.file_type()),
                size: metadata.len(),
            }),
            Err(error) if is_skippable(&error) => {}
            Err(error) => return Err(FsError::from_io(&error, "stat", abs)),
        }
        Ok(())
    }

    fn walk(&mut self, rel_dir: &str) -> Result<(), FsError> {
        if self.truncated {
            return Ok(());
        }
        let abs_dir = if rel_dir.is_empty() {
            self.base.clone()
        } else {
            self.base.join(rel_dir)
        };
        if self.denied(&abs_dir) {
            return Ok(());
        }
        if !rel_dir.is_empty() && matches_contract(&self.excludes, rel_dir) {
            return Ok(());
        }
        if !rel_dir.is_empty() && matches_contract(&self.includes, rel_dir) {
            self.add_match(rel_dir, &abs_dir)?;
            if self.truncated {
                return Ok(());
            }
        }
        let children = match sorted_children(&abs_dir) {
            Ok(children) => children,
            Err(error) if is_skippable(&error) => return Ok(()),
            Err(error) => return Err(FsError::from_io(&error, "opendir", &abs_dir)),
        };
        for child in children {
            if self.truncated {
                break;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            let rel = if rel_dir.is_empty() {
                name
            } else {
                format!("{rel_dir}/{name}")
            };
            let abs = self.base.join(&rel);
            if self.denied(&abs) || matches_contract(&self.excludes, &rel) {
                continue;
            }
            if matches_contract(&self.includes, &rel) {
                self.add_match(&rel, &abs)?;
            }
            if child.file_type().is_ok_and(|kind| kind.is_dir()) {
                self.walk(&rel)?;
            }
        }
        Ok(())
    }
}

pub fn glob(request: &GlobRequest) -> Result<Option<GlobOutput>, FsError> {
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    for pattern in &request.patterns {
        if pattern.is_empty() {
            continue;
        }
        match pattern.strip_prefix('!') {
            Some(excluded) => {
                let excluded = normalize_pattern(excluded);
                if !excluded.is_empty() {
                    excludes.push(excluded);
                }
            }
            None => includes.push(normalize_pattern(pattern)),
        }
    }
    if includes
        .iter()
        .chain(&excludes)
        .any(|pattern| uses_extended_glob(pattern))
    {
        return Ok(None);
    }
    let (Some(include_set), Some(exclude_set)) = (build_set(&includes), build_set(&excludes))
    else {
        return Ok(None);
    };
    let mut walk = GlobWalk {
        base: PathBuf::from(&request.cwd),
        includes: include_set,
        excludes: exclude_set,
        max_entries: request.max_entries,
        with_stats: request.with_stats,
        deny_paths: &request.deny_paths,
        dangerously_allow: request.dangerously_allow,
        seen: Default::default(),
        paths: Vec::new(),
        entries: Vec::new(),
        truncated: false,
    };
    for root in search_roots(&includes) {
        walk.walk(&root)?;
    }
    Ok(Some(GlobOutput {
        paths: if request.with_stats {
            walk.entries
                .iter()
                .map(|entry| entry.path.clone())
                .collect()
        } else {
            walk.paths
        },
        entries: request.with_stats.then_some(walk.entries),
        truncated: walk.truncated,
    }))
}

/// Lists every entry under the roots in sorted depth-first order, for Core to match itself.
pub fn walk(request: &WalkRequest) -> Result<WalkOutput, FsError> {
    let base = PathBuf::from(&request.base);
    let mut entries = Vec::new();
    let mut truncated = false;
    let denied = |path: &Path| !request.dangerously_allow && is_denied(path, &request.deny_paths);
    let mut stack: Vec<String> = request.roots.iter().rev().cloned().collect();
    while let Some(rel_dir) = stack.pop() {
        let abs_dir = if rel_dir.is_empty() {
            base.clone()
        } else {
            base.join(&rel_dir)
        };
        if denied(&abs_dir) {
            continue;
        }
        if !rel_dir.is_empty() && request.roots.contains(&rel_dir) {
            entries.push(entry_for(&rel_dir, &abs_dir, true));
        }
        let children = match sorted_children(&abs_dir) {
            Ok(children) => children,
            Err(error) if is_skippable(&error) => continue,
            Err(error) => return Err(FsError::from_io(&error, "opendir", &abs_dir)),
        };
        let mut directories = Vec::new();
        for child in children {
            if entries.len() as u64 >= request.max_entries {
                truncated = true;
                break;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            let rel = if rel_dir.is_empty() {
                name
            } else {
                format!("{rel_dir}/{name}")
            };
            let abs = base.join(&rel);
            if denied(&abs) {
                continue;
            }
            let is_directory = child.file_type().is_ok_and(|kind| kind.is_dir());
            entries.push(entry_for(&rel, &abs, is_directory));
            if is_directory {
                directories.push(rel);
            }
        }
        if truncated {
            break;
        }
        stack.extend(directories.into_iter().rev());
    }
    Ok(WalkOutput { entries, truncated })
}

fn entry_for(rel: &str, abs: &Path, is_directory: bool) -> WalkEntry {
    let metadata = fs::metadata(abs).ok();
    WalkEntry {
        path: rel.to_string(),
        is_directory,
        kind: metadata
            .as_ref()
            .map(|metadata| file_kind(metadata.file_type())),
        size: metadata.as_ref().map(|metadata| metadata.len()),
    }
}
