use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

fn start(request: serde_json::Value) -> (Child, ChildStdin) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lilac-remote"))
        .arg("rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("runner starts");
    let mut stdin = child.stdin.take().expect("stdin is piped");
    writeln!(stdin, "{request}").expect("request is written");
    (child, stdin)
}

fn exec(script: &str, cwd: Option<&str>) -> serde_json::Value {
    serde_json::json!({ "op": "exec", "cwd": cwd, "script": script })
}

fn finish(mut child: Child) -> (i32, String, String) {
    let status = child.wait().expect("runner exits");
    let mut stdout = String::new();
    let mut stderr = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    (status.code().unwrap_or(-1), stdout, stderr)
}

// A zombie still answers signal 0, so both checks read the process state instead.
#[cfg(target_os = "linux")]
fn process_exists(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => !stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "linux"))]
fn process_exists(pid: i32) -> bool {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("ps runs");
    let state = String::from_utf8_lossy(&output.stdout);
    let state = state.trim();
    !state.is_empty() && !state.starts_with('Z')
}

/// Starts the second sleep outside the job's process group, the way a daemonizing command would.
/// macOS has no `setsid` command and no subreaper, so there the runner cannot catch an escaped
/// process and the sleep stays in the group.
#[cfg(target_os = "linux")]
const DETACH: &str = "setsid ";
#[cfg(not(target_os = "linux"))]
const DETACH: &str = "";

fn wait_for_file(path: &std::path::Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if text.ends_with('\n') {
                return text;
            }
        }
        assert!(
            Instant::now() < deadline,
            "{} never appeared",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn passes_output_and_exit_code_through() {
    let (child, stdin) = start(exec("echo out; echo err >&2; exit 7", None));
    let (code, stdout, stderr) = finish(child);
    drop(stdin);
    assert_eq!(code, 7);
    assert_eq!(stdout, "out\n");
    assert_eq!(stderr, "err\n");
}

#[test]
fn runs_in_the_requested_cwd_and_expands_home() {
    let dir = tempdir();
    let (child, stdin) = start(exec("pwd", Some(dir.to_str().unwrap())));
    let (code, stdout, _) = finish(child);
    drop(stdin);
    assert_eq!(code, 0);
    assert_eq!(
        stdout.trim_end(),
        std::fs::canonicalize(&dir).unwrap().to_str().unwrap()
    );

    let home = std::env::var("HOME").unwrap();
    let (child, stdin) = start(exec("pwd", Some("~")));
    let (_, stdout, _) = finish(child);
    drop(stdin);
    assert_eq!(
        stdout.trim_end(),
        std::fs::canonicalize(home).unwrap().to_str().unwrap()
    );
}

#[test]
fn reports_a_missing_cwd_like_the_shell_runner() {
    let (child, stdin) = start(exec("true", Some("/definitely/not/a/dir")));
    let (code, _, stderr) = finish(child);
    drop(stdin);
    assert_eq!(code, 1);
    assert_eq!(stderr, "Remote cwd does not exist or is not a directory\n");
}

#[test]
fn gives_the_command_an_empty_stdin() {
    let (child, stdin) = start(exec("cat; echo done", None));
    let (code, stdout, _) = finish(child);
    drop(stdin);
    assert_eq!(code, 0);
    assert_eq!(stdout, "done\n");
}

#[test]
fn closing_stdin_kills_the_job_and_its_descendants() {
    let dir = tempdir();
    let pids = dir.join("pids");
    let script = format!(
        "sleep 300 & a=$!; {DETACH}sleep 301 & b=$!; trap '' TERM; echo \"$a $b\" > {}; wait",
        pids.display()
    );
    let started = Instant::now();
    let (child, stdin) = start(exec(&script, None));
    let recorded = wait_for_file(&pids);
    drop(stdin);
    let (code, _, _) = finish(child);
    assert_eq!(code, 143);
    assert!(started.elapsed() < Duration::from_secs(10));
    for pid in recorded
        .split_whitespace()
        .map(|pid| pid.parse::<i32>().unwrap())
    {
        assert!(!process_exists(pid), "process {pid} survived cancellation");
    }
}

#[test]
fn a_finished_job_leaves_background_daemons_running() {
    let dir = tempdir();
    let pid_file = dir.join("pid");
    let script = format!(
        "nohup sleep 300 >/dev/null 2>&1 </dev/null & echo $! > {}",
        pid_file.display()
    );
    let (child, stdin) = start(exec(&script, None));
    let (code, _, _) = finish(child);
    drop(stdin);
    assert_eq!(code, 0);
    let pid: i32 = wait_for_file(&pid_file).trim().parse().unwrap();
    assert!(process_exists(pid));
    let _ = Command::new("kill").arg(pid.to_string()).status();
}

#[test]
fn rejects_an_unknown_request() {
    let (child, stdin) = start(serde_json::json!({ "op": "nope" }));
    let (code, _, stderr) = finish(child);
    drop(stdin);
    assert_eq!(code, 70);
    assert!(stderr.contains("invalid request"), "{stderr}");
}

fn tempdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lilac-remote-test-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos() ^ rand_suffix()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn rand_suffix() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::SeqCst) as u128 * 7919
}
