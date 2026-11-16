use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Exec(ExecRequest),
    Env(EnvRequest),
    Realpath(PathRequest),
    CanonicalizeAsFarAsExists(PathRequest),
    Stat(PathRequest),
    ScanText(ScanTextRequest),
    ReadPrefix(ReadPrefixRequest),
    ReadBytes(PathRequest),
    ReadText(PathRequest),
    HashTextFiles(PathsRequest),
    WriteText(WriteTextRequest),
    Unlink(PathRequest),
    Glob(GlobRequest),
    Walk(WalkRequest),
    Grep(GrepRequest),
    FuzzyCandidates(FuzzyCandidatesRequest),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecRequest {
    /// Remote working directory. `~` and `~/...` expand to `$HOME`.
    pub cwd: Option<String>,
    /// Bash script run with `bash --noprofile --norc <file>`.
    pub script: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvRequest {
    /// Deny paths as configured, possibly starting with `~`.
    pub deny_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathsRequest {
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScanStart {
    Line { line: u64, column: u64 },
    Offset { offset: u64 },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanTextRequest {
    pub path: String,
    pub start: ScanStart,
    pub max_lines: u64,
    pub max_characters: u64,
    /// Longest line hashline can anchor, in UTF-16 units.
    pub hashline_max_line_chars: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadPrefixRequest {
    pub path: String,
    pub limit: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteTextRequest {
    pub path: String,
    pub content: String,
    pub create_parents: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlobRequest {
    pub cwd: String,
    pub patterns: Vec<String>,
    pub max_entries: u64,
    pub deny_paths: Vec<String>,
    pub dangerously_allow: bool,
    pub with_stats: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalkRequest {
    pub base: String,
    pub roots: Vec<String>,
    pub deny_paths: Vec<String>,
    pub dangerously_allow: bool,
    pub max_entries: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrepRequest {
    pub cwd: String,
    pub search_path: Option<String>,
    pub pattern: String,
    pub regex: bool,
    pub globs: Vec<String>,
    pub max_matches: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FuzzyCandidatesRequest {
    pub cwd: String,
    pub deny_paths: Vec<String>,
    pub dangerously_allow: bool,
    pub max_files: u64,
    pub budget_ms: u64,
}
