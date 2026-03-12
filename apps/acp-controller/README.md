# lilac-acp

ACP harness controller for local and automation workflows.

It talks to ACP harnesses, keeps run state on disk, and executes prompt turns in detached worker processes.

`lilac-acp` is a multi-harness CLI. Use `--harness <id>` when you want a specific ACP backend such as OpenCode, Codex, Claude, or Cursor.

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

List launchable harnesses:

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

Submit a prompt in a new OpenCode session:

```bash
lilac-acp prompt submit \
  --directory /path/to/repo \
  --harness opencode \
  --text "Fix the failing tests"
```

Submit and wait on a specific harness:

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

## Output

- Default output is JSON for scripting.
- Use `--output human` for readable terminal output.

```bash
lilac-acp sessions list --directory /path/to/repo --output human
lilac-acp prompt wait --run-id run_xxx --output human
```

## Notes

- `--latest` requires `--harness`.
- `--title` without `--harness` continues only if there is exactly one exact match across all discovered harnesses.
- New sessions require `--harness` so the controller knows where to create them.
- Run state is stored under `~/.local/state/lilac-acp-controller`.
