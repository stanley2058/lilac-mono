# lilac-opencode

Small CLI wrapper around the OpenCode SDK (v2).

This is designed to be invoked locally or via Lilac's `ssh.run` tool.

## Build

From this directory:

```bash
bun install
bun run build
```

This writes:

- `dist/client.js` (compiled)
- `dist/index.js` (executable wrapper)

## Usage

Help/version:

```bash
bun dist/index.js --help
bun dist/index.js --version
```

List sessions (scoped to a repo directory):

```bash
bun dist/index.js sessions list --directory /path/to/repo --roots --limit 20
```

Fetch a small session snapshot (for agents):

```bash
bun dist/index.js sessions snapshot \
  --directory /path/to/repo \
  --latest \
  --runs 6 \
  --max-chars 1200
```

Submit a prompt (non-blocking), continuing the newest root session in that directory:

```bash
bun dist/index.js prompt submit \
  --directory /path/to/repo \
  --text "Fix the failing tests" \
  --agent build
```

Submit and wait for completion in one command:

```bash
bun dist/index.js prompt submit \
  --directory /path/to/repo \
  --title "lilac:discord:123" \
  --text "Continue where we left off" \
  --wait
```

Inspect run progress/result later:

```bash
bun dist/index.js prompt status --run-id run_xxx
bun dist/index.js prompt result --run-id run_xxx
bun dist/index.js prompt wait --run-id run_xxx
```

Submit by exact session title (continue-or-create):

```bash
bun dist/index.js prompt submit \
  --directory /path/to/repo \
  --title "lilac:discord:123" \
  --text "Continue where we left off"
```

Notes:

- Output is always JSON.
- `prompt submit` protects against accidental double-submit by default.
- If prompt text is an exact/similar recent duplicate, submit is blocked unless `--force` is set.
- Permission prompts are auto-approved and questions auto-rejected while `prompt wait` is running.
