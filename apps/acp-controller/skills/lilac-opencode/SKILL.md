---
name: lilac-opencode
description: Drive OpenCode via the local ACP controller alias.
---

# lilac-opencode

`lilac-opencode` is a deprecated alias for `lilac-acp --harness opencode`.

Use it when you specifically want the OpenCode harness but still want the controller's detached-run workflow and JSON output.

Core commands

1. List OpenCode sessions
   ```bash
   lilac-opencode sessions list \
     --directory /abs/path/to/repo
   ```
2. Session snapshot
   ```bash
   lilac-opencode sessions snapshot \
     --directory /abs/path/to/repo \
     --latest \
     --runs 6 \
     --max-chars 1200
   ```
3. Prompt submit (new session unless you provide a selector)
   ```bash
   lilac-opencode prompt submit \
     --directory /abs/path/to/repo \
     --text "Continue working on the failing tests"
   ```
4. Prompt submit + wait
   ```bash
   lilac-opencode prompt submit \
     --directory /abs/path/to/repo \
     --title "lilac:discord:123" \
     --text "Continue where we left off" \
     --wait
   ```
5. Run lifecycle
   ```bash
   lilac-opencode prompt status --run-id run_xxx
   lilac-opencode prompt result --run-id run_xxx
   lilac-opencode prompt wait --run-id run_xxx
   lilac-opencode prompt cancel --run-id run_xxx
   ```

Important notes

- Output is always a single JSON object.
- `--latest` requires `--harness`, but the alias already injects `--harness opencode`.
- `--title` continues an exact OpenCode match if one exists; otherwise the controller creates a new session and remembers the requested title locally.
- Run state is stored under `~/.local/state/lilac-acp-controller`.
