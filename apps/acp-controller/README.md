# lilac-acp

`lilac-acp` is a multi-harness ACP controller for local, automation, and SSH workflows. It discovers
sessions, captures bounded snapshots, and executes prompt turns in detached worker processes.

Built-in harness IDs are `opencode`, `codex-acp`, `claude-acp`, and `cursor`. `harnesses list` reports
which corresponding executable is launchable on the current `PATH`.

## Build

From this directory:

```bash
bun install
bun run build
```

This writes:

- `dist/client.js` (compiled controller)
- `dist/index.js` (`lilac-acp` entrypoint)

## Usage

Show help or version:

```bash
lilac-acp --help
lilac-acp --version
```

List harnesses:

```bash
lilac-acp harnesses list
```

Search sessions across all discovered harnesses:

```bash
lilac-acp sessions list \
  --directory /path/to/repo \
  --search "failing tests"
```

Snapshot the latest OpenCode session:

```bash
lilac-acp sessions snapshot \
  --directory /path/to/repo \
  --harness opencode \
  --latest \
  --runs 6 \
  --max-chars 1200
```

Submit a prompt in a new OpenCode session. Prompt text can instead be supplied on stdin:

```bash
lilac-acp prompt submit \
  --directory /path/to/repo \
  --harness opencode \
  --text "Fix the failing tests"
```

Continue an exact-titled session and wait for completion:

```bash
lilac-acp prompt submit \
  --directory /path/to/repo \
  --harness codex-acp \
  --title "lilac:discord:123" \
  --text "Continue where we left off" \
  --wait
```

Inspect or cancel a persisted run:

```bash
lilac-acp prompt status --run-id run_xxx
lilac-acp prompt result --run-id run_xxx
lilac-acp prompt wait --run-id run_xxx
lilac-acp prompt cancel --run-id run_xxx
```

`prompt submit` returns after admitting the detached worker unless `--wait` is set. Use `--agent` and
`--model` to request an ACP session mode or model before the prompt. `prompt wait` defaults to a
20-minute timeout; `--timeout-ms` and `--poll-ms` override its polling behavior.

## Session Selection

The stable controller form of a session reference is `<harness-id>::<remote-session-id>`. A fully
qualified `--session-id` selects its harness directly. A raw remote session ID requires `--harness`.

- `--latest` requires `--harness` and selects the most recently updated session in the requested
  directory.
- `--title` is an exact title match. Without `--harness`, continuation succeeds only when exactly one
  discovered harness has that exact match.
- Supplying no session selector creates a session and therefore requires `--harness`.
- `--title` on a new session is retained as the controller's local title even if the harness later
  reports a different title.

Session listing queries live harnesses when available and updates the local index. If a harness is not
launchable, matching cached sessions remain listable with an installation warning.

## Runs And Persistence

Run and session state lives under `$XDG_STATE_HOME/lilac-acp-controller`, falling back to
`~/.local/state/lilac-acp-controller`. Run records include the target, prompt, worker PID, lifecycle
state, session updates, result text, and permission counters. Do not treat this directory as a
secret-free cache when prompts or model output are sensitive.

Session index updates hold an OS advisory lock on the `sessions` directory across the complete
read, merge, and atomic replacement. Concurrent controller processes wait for that lock and report a
timeout after five seconds of contention. The OS releases the lock when its file descriptor closes
or the process exits; abandoned legacy `index.lock` directories do not block updates.

Run lifecycle states are `submitted`, `running`, `completed`, `failed`, and `cancelled`. Status, result,
and wait commands reconcile a nonterminal record with its worker. A submitted record whose worker was
not admitted can be started during reconciliation; a vanished admitted worker becomes failed unless a
cancellation was already requested.

Cancellation is persisted before the controller signals the worker. The worker observes the marker and
asks the active ACP session to cancel; cancelling an already-terminal run is an error. A wait timeout
stops only the waiting command, not the detached run.

Prompt workers automatically prefer the harness's `allow_always` permission option, then `allow_once`;
if neither is offered they select an available rejection option or cancel the request. Use the controller
only with harnesses and working directories where this non-interactive permission policy is acceptable.

## Output

- Default output is JSON for scripting.
- Use `--output human` for readable terminal output.

```bash
lilac-acp sessions list --directory /path/to/repo --output human
lilac-acp prompt wait --run-id run_xxx --output human
```
