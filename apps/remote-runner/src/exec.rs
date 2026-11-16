//! Runs one bash script as a supervised job.
//!
//! The job runs in its own session, so its process group holds every descendant that does not call
//! `setsid` itself. The job's stdout and stderr are the runner's, so its output reaches Core
//! unchanged. When the runner's stdin reaches EOF before the job exits, the runner terminates the
//! job: SIGTERM to the group, SIGKILL after a grace period, and on Linux SIGKILL to every remaining
//! descendant, which the subreaper setting keeps attached to the runner.

use std::io::Read;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use nix::errno::Errno;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, setsid};

use crate::protocol::ExecRequest;

/// Matches Core's local bash tool, which also waits two seconds before SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const MISSING_CWD_MESSAGE: &str = "Remote cwd does not exist or is not a directory";
/// The exit code a shell reports for a SIGTERM-terminated command.
const EXIT_CANCELLED: u8 = 143;

pub fn run(request: ExecRequest) -> ExitCode {
    #[cfg(target_os = "linux")]
    if let Err(error) = nix::sys::prctl::set_child_subreaper(true) {
        eprintln!("lilac-remote: failed to become a subreaper: {error}");
    }

    let cwd = match resolve_cwd(request.cwd.as_deref()) {
        Ok(cwd) => cwd,
        Err(()) => {
            eprintln!("{MISSING_CWD_MESSAGE}");
            return ExitCode::FAILURE;
        }
    };
    let script = match ScriptFile::create(&request.script) {
        Ok(script) => script,
        Err(error) => {
            eprintln!("lilac-remote: failed to stage the command: {error}");
            return ExitCode::FAILURE;
        }
    };

    let mut command = Command::new("bash");
    command
        .args(["--noprofile", "--norc"])
        .arg(script.path())
        .stdin(Stdio::null());
    if let Some(cwd) = &cwd {
        command.current_dir(cwd);
    }
    // SAFETY: setsid is async-signal-safe and touches no state shared with the parent.
    unsafe {
        command.pre_exec(|| setsid().map(|_| ()).map_err(std::io::Error::from));
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("lilac-remote: failed to start bash: {error}");
            return ExitCode::FAILURE;
        }
    };
    let group = Pid::from_raw(child.id() as i32);

    let cancelled = Arc::new(AtomicBool::new(false));
    let job_done = Arc::new(AtomicBool::new(false));
    let watcher = {
        let cancelled = Arc::clone(&cancelled);
        let job_done = Arc::clone(&job_done);
        std::thread::spawn(move || watch_caller(group, &cancelled, &job_done))
    };

    let status = child.wait();
    job_done.store(true, Ordering::SeqCst);
    drop(script);

    if cancelled.load(Ordering::SeqCst) {
        let _ = watcher.join();
        return ExitCode::from(EXIT_CANCELLED);
    }
    match status {
        Ok(status) => exit_code_for(status),
        Err(error) => {
            eprintln!("lilac-remote: failed to wait for the command: {error}");
            ExitCode::FAILURE
        }
    }
}

fn resolve_cwd(cwd: Option<&str>) -> Result<Option<PathBuf>, ()> {
    let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) else {
        return Ok(None);
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let expanded = match (cwd, &home) {
        ("~", Some(home)) => home.clone(),
        (cwd, Some(home)) if cwd.starts_with("~/") => home.join(&cwd[2..]),
        (cwd, _) => PathBuf::from(cwd),
    };
    if expanded.is_dir() {
        Ok(Some(expanded))
    } else {
        Err(())
    }
}

fn exit_code_for(status: std::process::ExitStatus) -> ExitCode {
    if let Some(code) = status.code() {
        return ExitCode::from(code as u8);
    }
    let signal = status.signal().unwrap_or(0);
    ExitCode::from((128 + signal).min(255) as u8)
}

/// Blocks until the caller closes stdin, then terminates the job if it is still running.
fn watch_caller(group: Pid, cancelled: &AtomicBool, job_done: &AtomicBool) {
    let mut sink = [0u8; 4096];
    let mut stdin = std::io::stdin();
    loop {
        match stdin.read(&mut sink) {
            Ok(0) => break,
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    if job_done.load(Ordering::SeqCst) && !group_alive(group) {
        return;
    }
    cancelled.store(true, Ordering::SeqCst);
    terminate(group);
}

fn terminate(group: Pid) {
    let _ = killpg(group, Signal::SIGTERM);
    let deadline = Instant::now() + KILL_GRACE;
    while group_alive(group) && Instant::now() < deadline {
        reap_orphans();
        std::thread::sleep(POLL_INTERVAL);
    }
    let _ = killpg(group, Signal::SIGKILL);
    kill_adopted_descendants();
}

fn group_alive(group: Pid) -> bool {
    !matches!(killpg(group, None), Err(Errno::ESRCH))
}

/// Reaps descendants that reparented to the runner and have already exited.
fn reap_orphans() {
    use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
    loop {
        match waitpid(None, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::StillAlive) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}

#[cfg(target_os = "linux")]
fn kill_adopted_descendants() {
    use nix::sys::signal::kill;
    let runner = nix::unistd::getpid();
    // Killing one generation can reparent its children to the runner, so repeat until none remain.
    for _ in 0..64 {
        let children = children_of(runner);
        if children.is_empty() {
            return;
        }
        for child in children {
            let _ = kill(child, Signal::SIGKILL);
        }
        std::thread::sleep(POLL_INTERVAL);
        reap_orphans();
    }
}

#[cfg(not(target_os = "linux"))]
fn kill_adopted_descendants() {
    reap_orphans();
}

#[cfg(target_os = "linux")]
fn children_of(parent: Pid) -> Vec<Pid> {
    let path = format!("/proc/{}/task/{}/children", parent, parent);
    if let Ok(text) = std::fs::read_to_string(&path) {
        return text
            .split_whitespace()
            .filter_map(|pid| pid.parse::<i32>().ok())
            .map(Pid::from_raw)
            .collect();
    }
    children_from_proc_stat(parent)
}

/// Fallback for kernels built without `CONFIG_PROC_CHILDREN`.
#[cfg(target_os = "linux")]
fn children_from_proc_stat(parent: Pid) -> Vec<Pid> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // The command name can contain spaces and parentheses, so parse after the last ')'.
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let ppid = rest
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse::<i32>().ok());
        if ppid == Some(parent.as_raw()) {
            children.push(Pid::from_raw(pid));
        }
    }
    children
}

/// The command text, staged in a private temporary file that is removed when dropped.
struct ScriptFile {
    path: PathBuf,
}

impl ScriptFile {
    fn create(script: &str) -> std::io::Result<Self> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0);
        for attempt in 0..16u32 {
            let path = dir.join(format!("lilac-remote-{pid}-{nanos}-{attempt}.sh"));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(mut file) => {
                    file.write_all(script.as_bytes())?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::other(
            "could not create a unique command file",
        ))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScriptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
