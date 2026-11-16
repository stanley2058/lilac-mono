//! `lilac-remote` runs on SSH hosts on behalf of Lilac Core.
//!
//! Core invokes `lilac-remote rpc`, writes one JSON request line to stdin and keeps stdin open for
//! the whole call. Reaching EOF on stdin before the work finishes means the caller is gone or wants
//! the work cancelled. Command jobs pass their output straight through; every other operation
//! answers with one JSON envelope on stdout.

mod errors;
mod exec;
mod fsops;
mod fuzzy;
mod glob;
mod grep;
mod protocol;
mod scan;

use std::io::{BufRead, Read, Write};
use std::process::ExitCode;

use serde::Serialize;

use errors::FsError;
use protocol::Request;

/// Exit code for requests the runner cannot decode. Core treats it as a runner defect.
const EXIT_PROTOCOL_ERROR: u8 = 70;
/// Exit code when the caller closed stdin before a read-only operation finished.
const EXIT_CANCELLED: i32 = 143;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("rpc") => rpc(),
        Some("--version") => {
            println!("lilac-remote {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: lilac-remote rpc | --version");
            ExitCode::from(EXIT_PROTOCOL_ERROR)
        }
    }
}

fn rpc() -> ExitCode {
    let mut stdin = std::io::stdin().lock();
    let mut line = String::new();
    if let Err(error) = stdin.read_line(&mut line) {
        return protocol_failure(&format!("failed to read the request: {error}"));
    }
    drop(stdin);
    let request: Request = match serde_json::from_str(line.trim_end()) {
        Ok(request) => request,
        Err(error) => return protocol_failure(&format!("invalid request: {error}")),
    };
    match request {
        Request::Exec(request) => exec::run(request),
        Request::WriteText(request) => respond(fsops::write_text(
            &request.path,
            &request.content,
            request.create_parents,
        )),
        Request::Unlink(request) => respond(fsops::unlink(&request.path)),
        read_only => {
            exit_when_caller_leaves();
            answer_read_only(read_only)
        }
    }
}

fn answer_read_only(request: Request) -> ExitCode {
    match request {
        Request::Env(request) => respond(Ok(fsops::env(&request.deny_paths))),
        Request::Realpath(request) => respond(fsops::realpath(&request.path)),
        Request::CanonicalizeAsFarAsExists(request) => {
            respond(fsops::canonicalize_as_far_as_exists(&request.path))
        }
        Request::Stat(request) => respond(fsops::stat(&request.path)),
        Request::ScanText(request) => respond(scan::scan_text(&request)),
        Request::ReadPrefix(request) => respond(fsops::read_prefix(&request.path, request.limit)),
        Request::ReadBytes(request) => respond(fsops::read_bytes(&request.path)),
        Request::ReadText(request) => respond(fsops::read_text(&request.path)),
        Request::HashTextFiles(request) => respond(fsops::hash_text_files(&request.paths)),
        Request::Glob(request) => respond(glob::glob(&request)),
        Request::Walk(request) => respond(glob::walk(&request)),
        Request::Grep(request) => respond(grep::grep(&request)),
        Request::FuzzyCandidates(request) => respond(Ok(fuzzy::fuzzy_candidates(&request))),
        Request::Exec(_) | Request::WriteText(_) | Request::Unlink(_) => {
            protocol_failure("operation dispatched as read-only")
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum Envelope<T: Serialize> {
    Ok { ok: bool, value: T },
    Err { ok: bool, error: FsError },
}

fn respond<T: Serialize>(result: Result<T, FsError>) -> ExitCode {
    let envelope = match result {
        Ok(value) => Envelope::Ok { ok: true, value },
        Err(error) => Envelope::Err { ok: false, error },
    };
    let mut stdout = std::io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &envelope).is_err() || writeln!(stdout).is_err() {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// Read-only operations have no state to protect, so a closed stdin ends the process at once.
fn exit_when_caller_leaves() {
    std::thread::spawn(|| {
        let mut sink = [0u8; 4096];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut sink) {
                Ok(0) => std::process::exit(EXIT_CANCELLED),
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => std::process::exit(EXIT_CANCELLED),
            }
        }
    });
}

fn protocol_failure(message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "lilac-remote: {message}");
    ExitCode::from(EXIT_PROTOCOL_ERROR)
}
