//! Grep with ripgrep's own crates, shaped like the `rg --json` matches `packages/fs` parses.
//!
//! Directory searches walk with ripgrep's defaults (ignore files, hidden files skipped, no symlink
//! following) and report paths as `./relative/path`, like `rg` searching `.`. A single-file search
//! reports the path as given. Line text keeps its line terminator, and submatch offsets are bytes.

use std::path::{Path, PathBuf};

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::Bytes;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use ignore::overrides::OverrideBuilder;
use serde::Serialize;

use crate::errors::FsError;
use crate::protocol::GrepRequest;

#[derive(Debug, Serialize)]
pub struct Submatch {
    #[serde(rename = "match")]
    text: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Serialize)]
pub struct GrepMatch {
    file: String,
    line: u64,
    column: usize,
    text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    submatches: Vec<Submatch>,
}

#[derive(Debug, Serialize)]
pub struct GrepOutput {
    matches: Vec<GrepMatch>,
    truncated: bool,
}

fn search_failure(message: impl Into<String>) -> FsError {
    FsError::other("EGREP", message)
}

pub fn grep(request: &GrepRequest) -> Result<GrepOutput, FsError> {
    let limit = request.max_matches.max(1);
    // ripgrep configures `\n` as the line terminator, which keeps `\s` and `$` within one line.
    let matcher = RegexMatcherBuilder::new()
        .line_terminator(Some(b'\n'))
        .fixed_strings(!request.regex)
        .build(&request.pattern)
        .map_err(|error| {
            search_failure(format!("rg exited with code 2: regex parse error: {error}"))
        })?;
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .max_matches(Some(limit + 1))
        .build();

    let cwd = PathBuf::from(&request.cwd);
    let targets: Vec<(PathBuf, String)> = match &request.search_path {
        Some(search_path) => vec![(cwd.join(search_path), search_path.clone())],
        None => walk_files(&cwd, &request.globs)?,
    };

    let mut matches = Vec::new();
    for (path, reported) in targets {
        if matches.len() as u64 > limit {
            break;
        }
        let result = searcher.search_path(
            &matcher,
            &path,
            Bytes(|line_number, line| {
                // Like ripgrep's printer, find submatches in the line without its terminator.
                let content = line.strip_suffix(b"\n").unwrap_or(line);
                let mut submatches = Vec::new();
                let _ = matcher.find_iter(content, |found| {
                    submatches.push(Submatch {
                        text: String::from_utf8_lossy(&content[found.start()..found.end()])
                            .into_owned(),
                        start: found.start(),
                        end: found.end(),
                    });
                    true
                });
                matches.push(GrepMatch {
                    file: reported.clone(),
                    line: line_number,
                    column: submatches.first().map_or(0, |submatch| submatch.start) + 1,
                    text: String::from_utf8_lossy(line).into_owned(),
                    submatches,
                });
                Ok((matches.len() as u64) <= limit)
            }),
        );
        if let Err(error) = result {
            if request.search_path.is_some() {
                return Err(search_failure(format!(
                    "rg exited with code 2: {}: {error}",
                    reported
                )));
            }
        }
    }
    let truncated = matches.len() as u64 > limit;
    matches.truncate(limit as usize);
    Ok(GrepOutput { matches, truncated })
}

fn walk_files(cwd: &Path, globs: &[String]) -> Result<Vec<(PathBuf, String)>, FsError> {
    let mut overrides = OverrideBuilder::new(cwd);
    for glob in globs {
        overrides
            .add(glob)
            .map_err(|error| search_failure(format!("rg exited with code 2: {error}")))?;
    }
    let overrides = overrides
        .build()
        .map_err(|error| search_failure(format!("rg exited with code 2: {error}")))?;
    let walker = WalkBuilder::new(cwd)
        .overrides(overrides)
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    let mut files = Vec::new();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.into_path();
        let relative = path
            .strip_prefix(cwd)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        files.push((path, format!("./{relative}")));
    }
    Ok(files)
}
