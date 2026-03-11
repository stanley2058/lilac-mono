# lilac-acp

ACP harness controller for local and automation workflows.

It talks to harnesses over ACP, keeps run state on disk, and executes prompt turns in detached worker processes.

`lilac-acp` is the primary CLI.

`lilac-opencode` still exists as a deprecated alias that forwards to `lilac-acp --harness opencode`.

## Build

From this directory:

```bash
bun install
bun run build
```

This writes:

- `dist/client.js` (compiled controller)
- `dist/index.js` (`lilac-acp` entrypoint)
- `dist/opencode-alias.js` (`lilac-opencode` compatibility alias)

## Usage

Show help/version:

```bash
bun dist/index.js --help
bun dist/index.js --version
```

List launchable harnesses:

```bash
bun dist/index.js harnesses list
```

Search sessions across harnesses:

```bash
bun dist/index.js sessions list \
  --directory /path/to/repo \
  --search "failing tests"
```

Snapshot a known session:

```bash
bun dist/index.js sessions snapshot \
  --directory /path/to/repo \
  --harness opencode \
  --latest \
  --runs 6 \
  --max-chars 1200
```

Submit a prompt in a new session on a specific harness:

```bash
bun dist/index.js prompt submit \
  --directory /path/to/repo \
  --harness opencode \
  --text "Fix the failing tests"
```

Submit and wait for completion:

```bash
bun dist/index.js prompt submit \
  --directory /path/to/repo \
  --harness opencode \
  --title "lilac:discord:123" \
  --text "Continue where we left off" \
  --wait
```

Inspect or cancel a persisted run:

```bash
bun dist/index.js prompt status --run-id run_xxx
bun dist/index.js prompt result --run-id run_xxx
bun dist/index.js prompt wait --run-id run_xxx
bun dist/index.js prompt cancel --run-id run_xxx
```

## Notes

- Output is always JSON.
- `--latest` requires `--harness`.
- `--title` without `--harness` continues only if there is exactly one exact match across all discovered harnesses.
- New sessions require `--harness` so the controller knows where to create them.
- Run state is stored under `~/.local/state/lilac-acp-controller`.
