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

Send a prompt, continuing the newest root session in that directory:

```bash
bun dist/index.js prompt \
  --directory /path/to/repo \
  --text "Fix the failing tests" \
  --agent build
```

Send a prompt, creating/continuing a session by exact title:

```bash
bun dist/index.js prompt \
  --directory /path/to/repo \
  --title "lilac:discord:123" \
  --text "Continue where we left off"
```

Notes:

- Output is always JSON.
- Permission prompts are auto-approved (default: `always`).
- Question prompts are denied on new sessions by default (prevents non-interactive hangs).
