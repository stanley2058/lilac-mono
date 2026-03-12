---
name: lilac-acp
description: Drive ACP harnesses through the local Lilac controller.
---

# lilac-acp

`lilac-acp` is the ACP controller CLI for detached prompt runs, session search, and session snapshots across supported harnesses.

Use it when you want a local controller that can target OpenCode or other ACP harnesses explicitly with `--harness`.

Core commands

1. List harnesses
   ```bash
   lilac-acp harnesses list
   ```
2. List sessions across harnesses
   ```bash
   lilac-acp sessions list \
     --directory /abs/path/to/repo
   ```
3. Snapshot a specific harness session
   ```bash
   lilac-acp sessions snapshot \
     --directory /abs/path/to/repo \
     --harness opencode \
     --latest \
     --runs 6 \
     --max-chars 1200
   ```
4. Prompt submit (new session unless you provide a selector)
   ```bash
   lilac-acp prompt submit \
     --directory /abs/path/to/repo \
     --harness opencode \
     --text "Continue working on the failing tests"
   ```
5. Prompt submit + wait
   ```bash
   lilac-acp prompt submit \
     --directory /abs/path/to/repo \
     --harness codex-acp \
     --title "lilac:discord:123" \
     --text "Continue where we left off" \
     --wait
   ```
6. Run lifecycle
   ```bash
   lilac-acp prompt status --run-id run_xxx
   lilac-acp prompt result --run-id run_xxx
   lilac-acp prompt wait --run-id run_xxx
   lilac-acp prompt cancel --run-id run_xxx
   ```

Important notes

- Output defaults to a single JSON object.
- Use `--output human` for readable terminal output.
- `--latest` requires `--harness`.
- `--title` without `--harness` continues only when there is exactly one exact match across all discovered harnesses.
- Run state is stored under `~/.local/state/lilac-acp-controller`.
