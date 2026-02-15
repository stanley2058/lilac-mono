# TOOLS.md - Local Notes For Tool Usage

You have access to three tiers of tools:

1. bash, read_file, glob, grep, apply_patch, batch
2. `tools` CLI accessible via `bash`
3. Skills (more below)

## Parallel tool calls

- Prefer parallel tool execution whenever calls are independent.
- For independent filesystem/search operations (`read_file`, `glob`, `grep`, `bash`), prefer a single `batch` call with multiple `tool_calls`.
- If the model/runtime supports native multiple tool calls in one turn, use that as well for independent calls.
- Keep dependent operations sequential (for example: discover file path -> read file; edit file -> re-read/verify).
- Never batch dependent mutations where order matters.

## bash usage

- Preinstalled handy tools: `node`, `npm`, `bun`, `python`, `uv`, `curl`, `rg`, `fd`, `jq`, `curl`, `git`, `ffmpeg`, `imagemagick (6)`
- Prefer `bun` over `node` and `npm`; `bunx` over `npx`

## Remote Workdirs (SSH-style cwd)

These tools: `bash`, `read_file`, `glob`, `grep`, `apply_patch` supports SSH-style working directory in `cwd`:

- Format: `<host>:<path>`
  - `<host>` must be a configured SSH host alias from the server's SSH config (see `ssh.hosts`).
  - `<path>` may be absolute (`/repo`), tilde (`~/repo`), or relative (`repo` which anchors to `~/repo`).
- When reading remote files, paths may be returned as `ssh://<host>/<path>` to avoid confusion with local paths.

## `tools` CLI

The `tools` CLI is a unified interface for all built-in tools.

Basic usage:

```bash
tools --list
tools --help [tool]
tools <tool> --arg1=value --arg2=value
tools <tool> --input=@payload.json
cat payload.json | tools <tool> --stdin
```

### Built-in Tools

- `fetch` — Fetch a web page
- `search` — Search the web
- `summarize` — Summarize the input using Gemini AI
- `image.generate` — Generate an image with a configured provider and write it to a local file
- `skills.list` — List and search skills discovered from common directories
- `skills.brief` — Load a skill's frontmatter + a truncated SKILL.md body
- `skills.full` — Load a skill's frontmatter + a larger SKILL.md body, plus a top-level directory listing
- `ssh.hosts` — List SSH host aliases from the server's ~/.ssh/config (hidden when none are configured)
- `ssh.run` — Run a command on a remote host over SSH (StrictHostKeyChecking=yes, BatchMode=yes)
- `ssh.probe` — Probe remote host OS + tool availability + git context
- `attachment.add_files` — Reads local files and attaches them to the current reply.
- `attachment.download` — Download inbound user message attachments into the sandbox (i.e., download the files and images you "see" into the sandbox)
- `surface.help` — Explain surface terminology (client/platform/sessionId/messageId) and common sessionId formats.
- `surface.sessions.list` — List cached sessions.
- `surface.messages.list` — List messages for a session (defaults: limit=50,order=ts_desc; use  --help  to see all options).
- `surface.messages.read` — Read a message by id
- `surface.messages.send` — Send a message to a session.
- `surface.messages.edit` — Edit a message.
- `surface.messages.delete` — Delete a message.
- `surface.messages.search` — Search indexed messages in a session.
- `surface.reactions.list` — List reactions for a message (emoji + count).
- `surface.reactions.listDetailed` — List reactions for a message with per-user details.
- `surface.reactions.add` — Add a reaction to a message.
- `surface.reactions.remove` — Remove a reaction from a message.
- `workflow.wait_for_reply.create` — Create a wait_for_reply workflow that resumes later (tasks wait for strict replies to a messageId in sessionId).
- `workflow.wait_for_reply.send_and_wait` — Send a message and create a wait_for_reply task waiting for a reply to that message.
- `workflow.schedule` — Create a scheduled workflow trigger (wait_until / wait_for / cron).
- `workflow.cancel` — Cancel a workflow and its pending tasks.
- `workflow.list` — List workflows from the local workflow store (scheduled only).

### Instructions on workflow

Workflow tools are designed to be used in conjunction with the `surface` tool. Imagine this workflow:

1. User A asked you to DM another user B
2. You sent a message to B via `surface.messages.send` and gets back a messageId
3. You create a workflow task that waits for a reply to that messageId via `workflow.wait_for_reply.create`
4. The workflow service will resume you with the context you set when you created the task after a reply is received from B
   (In the above example, 2 and 3 can be simplified with `workflow.wait_for_reply.send_and_wait`)

## Skills

- Tools that don't fit in the `tools` cli are packaged as skills, search here first if `tools` doesn't immediately contains what you are looking for.
- To search over installed skills, get descriptions or full details, use the `skills.*` in `tools` CLI.
  - If that's not enough, you can also explore and read the directory directly via fs tools.
- You can install skills with the `add-skill` CLI (always specify an agent (we support all of them), and always use `-y` to skip confirmation):

  ```bash
  # install globally to opencode agent
  bunx skills add org/repo -a opencode -g -y
  # help message
  bunx skills --help
  ```

  _Skills can contain executables, don't install skills from untrusted sources!_

### Mental model

A **Skill** is a **directory** containing:

- A required `SKILL.md` that provides **metadata + operational instructions**
- Optional additional docs (guides, references)
- Optional executable scripts/utilities
- Optional templates/resources/data files

### Skill directory structure

Minimum:

```
your-skill/
└── SKILL.md
```

Typical:

```
your-skill/
├── SKILL.md
├── REFERENCE.md          # optional (schemas, rules, templates)
├── GUIDE.md              # optional (longer workflows)
└── scripts/
    ├── validate.py       # optional deterministic helper
    └── transform.ts      # optional deterministic helper
```

`SKILL.md` is mandatory; everything else is optional.

---

Add whatever helps you do your job. This is your cheat sheet.
