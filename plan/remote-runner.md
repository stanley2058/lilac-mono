# Native remote runner

Status: approved by Stanley on 2026-11-16 ("build the native remote runner with fff dropped").
Stages 1 to 5 are implemented on `main` (uncommitted) and `bun run check` passes. Stage 6 waits on a
Mac. A run against real OpenSSH 10 in a container confirmed deployment, ControlMaster reuse,
cancellation of a `setsid`-escaped job, timeouts, Core dying mid-command, and every file tool.

## Problem

Core reaches SSH hosts through three mechanisms:

- `ssh.run` and remote `bash` pipe a bash script through a multiplexed `ssh` session per call. When
  Core terminates a call, it signals only the local `ssh` client. The OpenSSH ControlMaster keeps the
  session's stdio open, so the remote command keeps running and the output readers wait until it
  ends. Fork issue #117 traced a Core restart loop to this.
- `read`, `edit`, `apply_patch`, `glob` and `grep` upload `remote-runner.cjs` by hash and run it with
  `bun` or `node` on the remote host.
- `fuzzy_search` (and `glob`/`grep` when `tools.fsBackend` is `fff`) runs the npm package
  `@stanley2058/lilac-remote-fs-runner` through `bunx` or `npx`, which also needs registry access.

The JS runners require a JS runtime, and the npm runner requires a registry, on every remote host.
Remote commands cannot be cancelled.

## Decisions

- **D1. Native runner in Rust.** One static binary, `lilac-remote`, built from `apps/remote-runner`.
  It uses ripgrep's own crates (`ignore`, `globset`, `grep-*`) and has no C dependencies.
- **D2. fff is dropped on remote hosts.** Remote fuzzy search walks the tree on the host and ranks
  candidates in Core with the existing `fzf` code. This is a documented known limitation.
- **D3. The JS runners are removed.** `apps/core/src/ssh/remote-js` and `packages/remote-fs-runner`
  go away, with their build scripts, fingerprint record, CI steps and Docker stages. On a host the
  runner cannot run on, file tools return an unsupported-host error. `ssh.run` and remote `bash`
  fall back to a plain shell path that still cancels through a process group.
- **D4. Targets.** `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`
  and `x86_64-apple-darwin`. Linux builds are verified here, including aarch64 under qemu. macOS
  builds cross-compile with zig and target macOS 11; the arm64 build is verified on a Mac.
- **D5. Core uploads the binary.** Core ships every target's binary, detects the host platform with
  `uname -sm`, and uploads the matching binary gzip-compressed by content hash to
  `${XDG_CACHE_HOME:-$HOME/.cache}/lilac/remote-runner/<sha256>/lilac-remote`. There is no download
  path, so hosts without registry or internet access work.
- **D6. One invocation per call, stdin as liveness.** Each call runs the binary once over the existing
  multiplexed connection. The request is the first line on stdin, and stdin stays open for the whole
  call. When stdin reaches EOF before the work finishes, the runner cancels it: it terminates the
  job's process group, waits a grace period, kills it, and on Linux also kills descendants that
  escaped the group, using `PR_SET_CHILD_SUBREAPER`. Core cancels by closing stdin. A Core crash or a
  dropped connection closes it too, so remote jobs never outlive their caller.
- **D7. Tool behavior stays in Core.** `FileSystem` in `packages/fs` keeps every policy and formatting
  decision: deny paths, read windows, numbered and hashline formats, edits, hashline edits, glob and
  grep result shapes. Its I/O moves behind a `FileSystemHost` interface. The local host uses
  `node:fs` and ripgrep as today. The remote host calls the runner. Only scanning, walking and
  grepping are reimplemented in Rust, and parity tests compare the two hosts on the same files.
- **D8. Command jobs pass output through.** For an exec request, the runner's stdout and stderr carry
  the job's output unchanged and its exit code is the job's. `sshExecBash` keeps its streaming,
  output caps, overflow files and activity reporting.

## Runner protocol

The runner is invoked as `lilac-remote rpc`. Core writes one JSON request line to stdin and keeps
stdin open. File operations answer with one JSON envelope on stdout, `{"ok":true,"value":...}` or
`{"ok":false,"error":{"code":"ENOENT","message":"..."}}`. Error codes and messages follow Node's
`fs` errors. Binary payloads are base64. The protocol is private to one Core build and its bundled
binaries, which always ship together, so it has no compatibility window. `apps/remote-runner/src/protocol.rs`
defines every request.

| Operation                                           | Purpose                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `exec`                                              | Run a bash script in a cwd with an empty stdin; pass output through (D8).                   |
| `env`                                               | Return the home directory and the deny paths canonicalized on the host.                     |
| `realpath`, `canonicalize_as_far_as_exists`, `stat` | Resolve and stat paths.                                                                     |
| `scan_text`                                         | Stream a text file once: sha256, line count and the selected window (`readFile`'s scan).    |
| `read_prefix`, `read_bytes`, `read_text`            | Read the start of a file, a whole file as base64, or a whole file as text.                  |
| `hash_text_files`                                   | Hash several text files in one call, for hashline edits.                                    |
| `write_text`                                        | Write a file, creating parent directories when asked.                                       |
| `unlink`                                            | Remove a file.                                                                              |
| `glob`                                              | Walk from the patterns' literal roots and match with `globset`; Core re-checks each result. |
| `walk`                                              | List entries under roots for Core to match itself, used for extended glob patterns.         |
| `grep`                                              | Search with ripgrep's crates and default walk; return matches with columns and submatches.  |
| `fuzzy_candidates`                                  | Walk for fuzzy search with the same bounds as the local `fzf` fallback.                     |

## Stages

### 1. Runner crate and exec

- [x] `apps/remote-runner` crate with the `rpc` entry point, request decoding and error envelopes.
- [x] `exec`: cwd handling (`~` expansion, missing-cwd message), stdin modes, process group per job,
      stdin-EOF cancellation with grace and kill, Linux subreaper sweep, exit code passthrough.
      A finished job's background daemons keep running, like local bash.
- [x] `scripts/build-remote-runner.ts` builds the host target for development and all four targets
      for images, into `apps/remote-runner/dist/<target>/lilac-remote`. Linux musl targets link with
      `rust-lld`; macOS targets link with zig and a `libiconv` text stub. zig ad-hoc signs arm64.
- [x] Cargo tests cover cancellation, escaped descendants and exit codes (`apps/remote-runner/tests`).

### 2. Core transport

- [x] Deployment (`src/ssh/remote-runner-deploy.ts`): per-host probe through `sh -c` (the login shell
      may be fish), gzip upload by hash, shared per-host gate with per-caller deadlines, unsupported
      hosts cached for 10 minutes. The runner starts through a `sh -c` wrapper that prints
      `lilac-remote-runner-missing` and exits 127 when the binary is gone; Core then redeploys once.
- [x] `sshExecBash` runs `exec` through the runner and cancels by closing stdin. The local client gets
      SIGTERM after 5 s and SIGKILL 2 s later. The fork's drain timer (DF-wu/lilac-mono#118) stops the
      readers 2 s after a terminated client exits.
- [x] Shell fallback for unsupported hosts: the script is one brace group so bash reads it whole, the
      job runs under `set -m` in its own process group, and a watcher reading stdin kills it on EOF.
- [x] Tests (`tests/ssh/remote-runner-transport.test.ts`) with a shim that runs commands through
      `sh -c` like sshd: deploy once, passthrough, cancellation and timeout kill the job tree,
      redeploy, wedged connection settles, both fallbacks.

### 3. FileSystem host seam

Design notes: the host interface mirrors `FileSystem`'s I/O calls (realpath, stat, text scan, byte
reads, text read, write with parents, unlink, search backend, glob walk, fuzzy search) so local
behavior stays the same. Remote round trips stay bounded by folding: stat into the text scan, entry
stats into glob results, and hashline file hashes into one batch call. The host supplies the home
directory used for `~`, because `FileSystem` now runs in Core. `apply-patch-core.ts` uses the host too.

- [x] `FileSystemHost` interface (`packages/fs/src/filesystem-host.ts`); `FileSystem` takes a host,
      which also canonicalizes deny paths and supplies `homeDir`. The local host
      (`node-host.ts`) holds today's I/O; the read scan moved to `text-scan.ts` and the glob walk to
      `glob-walk.ts`.
- [x] `readFile` keeps its formatting, truncation and `nextStart` logic after the host scan, and
      `rankFuzzyCandidates` is shared by the local `fzf` fallback and the remote host.
- [x] Existing `packages/fs` and Core fs tests pass without behavior changes.

### 4. Remote file operations

- [x] Runner operations mirror the host methods: `env` (home and canonical deny paths),
      `realpath`, `canonicalize_as_far_as_exists`, `stat`, `scan_text`, `read_prefix`,
      `read_bytes`, `read_text`, `hash_text_files`, `write_text`, `unlink`, `glob`, `walk`, `grep`,
      `fuzzy_candidates`. Errors use Node's message format. Read-only operations exit when stdin
      closes; writes and unlinks finish first.
- [x] Remote host in Core (`src/ssh/remote-filesystem-host.ts`); `remote-fs.ts` and
      `remote-apply-patch.ts` run `FileSystem` and `applyHunksResult` on it and keep their exported
      result shapes. Glob candidates from `globset` are re-checked with Node's matcher; extended glob
      patterns use a `walk` listing that Core matches.
- [x] Parity tests (`tests/ssh/remote-filesystem-parity.test.ts`) run the same fixtures through the
      local `FileSystem` and the remote host: read windows, byte reads, glob, grep, fuzzy ranking,
      every edit kind, hashline edits and `apply_patch`.

### 5. Removal, packaging and docs

- [x] Removed `remote-runner.cjs`, `packages/remote-fs-runner`, `packages/fs`'s runner protocol,
      their scripts, fingerprint record, tests, CI step, Docker stages and architecture
      registrations.
- [x] `apps/remote-runner` is a Bun workspace whose `index.ts` exports the target list and dist paths
      and whose `test` script runs `cargo fmt --check` and `cargo test`. The toolchain is pinned in
      `rust-toolchain.toml`.
- [x] Docker builds all four targets in a `rust:1.94-slim-trixie` stage with zig and copies them into
      the runtime image (verified with `docker build --target remote-runner`).
- [x] CI installs the pinned toolchain and caches the crate build; Core's test script builds the host
      target.
- [x] `PROJECT.md`, `DEVELOPMENT.md` and `MIGRATIONS.md` describe the runner, its cache directory, the
      removed environment variables and the known limitations.

### 6. macOS verification

- [x] The arm64 binary on a Mac (macOS 27.0.1): exec, stdin-EOF cancellation, the SIGTERM grace
      kill, a surviving daemon and every file operation pass, and `cargo test` passes 7 of 7.
      Fixes from that run: macOS binaries target macOS 11 (zig defaulted to 15), the shell fallback
      disowns its watcher so bash 3.2 prints nothing on stderr, and the tests check processes with
      `ps` off Linux and reset the per-host deployment cache between files.
- [ ] Deploy to a Mac over real SSH (Remote Login was off).
- [ ] Run the x86_64 macOS binary (the Mac had no Rosetta).

## Known limitations

- Remote fuzzy search has no warm index, frecency or typo tolerance. It walks the tree for each query
  and ranks with `fzf`, like the local fallback.
- On macOS a job that calls `setsid` itself can escape cancellation, because macOS has no subreaper.
- A dropped SSH connection cancels running remote jobs (D6).
- Hosts other than Linux and macOS on x86_64 or aarch64 get no file tools over SSH.

## Residuals

Record findings outside this plan here instead of fixing them.

- Remote file tools make more round trips than the JS runners did. Every call starts with `env`,
  because deny paths are canonicalized per call so a retargeted symlink stays denied. A read then
  adds `realpath` and `scan_text`, and an edit adds `realpath`, `read_text` and `write_text`.
  Folding `realpath` into the following operation would cut one round trip each.
- `globset` candidates are re-checked with Node's matcher, which removes false positives but cannot
  recover a path `globset` rejects that Node would accept. Extended glob syntax already avoids
  `globset`. Parity tests cover common patterns only.
- Remote grep skips unreadable files; local `rg` exits 2 and the whole local grep fails.
- The Docker runner stage downloads zig from ziglang.org at build time, verified against the
  checksum in the same index.
