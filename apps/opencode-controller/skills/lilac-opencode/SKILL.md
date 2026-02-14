---
name: lilac-opencode
description: Drive OpenCode sessions via a local controller CLI (auto-allow permissions).
---

# lilac-opencode

Use `lilac-opencode` to control OpenCode sessions non-interactively via the OpenCode SDK.

This is designed for:

- continuing OpenCode work via an automation surface (e.g. SSH)
- running the OpenCode Build agent with auto-approved permissions
- getting stable, machine-readable JSON output

Core commands

1. List sessions
   ```bash
   lilac-opencode sessions list \
     --directory /abs/path/to/repo \
     --roots \
     --limit 20
   ```
2. Session snapshot (compact, for agents)
   ```bash
   lilac-opencode sessions snapshot \
      --directory /abs/path/to/repo \
      --latest \
      --runs 6 \
      --max-chars 1200
   ```
3. Prompt submit (continue newest session in directory, non-blocking)
   ```bash
   lilac-opencode prompt submit \
      --directory /abs/path/to/repo \
      --text "Continue working on the failing tests" \
      --agent build
   ```
4. Prompt submit + wait
   ```bash
   lilac-opencode prompt submit \
      --directory /abs/path/to/repo \
      --title "<RUN_ID|DETERMINISTIC_TITLE>" \
      --text "Continue where we left off" \
      --wait
   ```
5. Prompt (continue or create by exact title)
   Use `--title` to deterministically continue the same OpenCode session across calls.
   ```bash
   lilac-opencode prompt submit \
      --directory /abs/path/to/repo \
      --title "<RUN_ID|DETERMINISTIC_TITLE>" \
      --text "Continue where we left off" \
      --agent build
   ```
6. Prompt (explicit session id)
   ```bash
   lilac-opencode prompt submit \
      --directory /abs/path/to/repo \
      --session-id sess_xxx \
      --text "Do the next step" \
      --agent build
   ```
7. Run lifecycle (recommended async flow)
   ```bash
   lilac-opencode prompt status --run-id run_xxx
   lilac-opencode prompt result --run-id run_xxx
   lilac-opencode prompt wait --run-id run_xxx
   ```

Important flags

- `--directory <path>`: always set this to the repo root you want OpenCode to operate in.
- `--base-url <url>`: OpenCode server URL (default: `http://127.0.0.1:4096`).
- `--ensure-server` / `--no-ensure-server`: if enabled, the tool will start `opencode serve` when the server is not reachable.
- `--opencode-bin <bin>`: path/name of the `opencode` binary used for `opencode serve` (default: `opencode`).
- `--timeout-ms <n>`: wait timeout budget. (default: `1200000` ms = 20 min)
- `--permission-response once|always`: how to auto-approve `permission.asked` (default: `always`).
- `--force`: bypass duplicate/similar prompt submit protection.

Non-interactive safety defaults

- New sessions are created with `question` denied by default (prevents `question.asked` hangs).
- Duplicate/similar prompt submissions are blocked by default unless `--force` is set.
- In-flight permission/question auto handling happens while `prompt wait` is running.

JSON output

- Output is always a single JSON object.
- On errors, `ok=false` and the process exits non-zero.

Remote usage (SSH)

Run the same commands on a remote host (example):

```bash
# On your machine:
ssh myhost "cd /abs/path/to/repo && lilac-opencode prompt submit --title lilac:discord:123 --text 'continue'"
```
