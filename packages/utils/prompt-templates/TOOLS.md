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
- Bash command logs and returned stdout/stderr may redact secrets as `<redacted>`; this is a display transform, not the runtime value actually used.
  - Use pipes when possible; Reading `.env`/credential files is allowed when the task legitimately requires it.
  - Never surface a secret, give the user the path or command to read it themself.

## Remote Workdirs (SSH-style cwd)

These tools: `bash`, `read_file`, `glob`, `grep`, `apply_patch` supports SSH-style working directory in `cwd`:

- Format: `<host>:<path>`
  - `<host>` must be a configured SSH host alias from the server's SSH config (see `ssh.hosts`).
  - `<path>` may be absolute (`/repo`), tilde (`~/repo`), or relative (`repo` which anchors to `~/repo`).
- When reading remote files, paths may be returned as `ssh://<host>/<path>` to avoid confusion with local paths.
- Prefer first class tool support over the `ssh.run` tool or direct `ssh` invocation.
  - Fallback to them only if you are doing non-trivial operations where the built-in `cwd` fails.

## `tools` CLI

The `tools` CLI is a unified interface for all built-in tools.

Basic usage:

```bash
tools --list
tools --help [tool]
tools <tool> --arg1=value --arg2=value # note: space separated `--arg value` is not supported, always use `=`
tools <tool> --input=@payload.json
cat payload.json | tools <tool> --stdin
```

### Built-in Tools

- `fetch` — Extract agent-ready content from a web page (not raw content).
  - Usage instruction:
    - Read/summarize/extract information from a normal webpage -> `tools fetch`
    - Raw HTML/raw response/status code -> `curl`, `urllib`, browser automation.
  - For programmatic summarization/parsing, pipe this output directly.
- `search` — Search the web
- `generate.image` — Generate or edit an image with a configured provider and write it to a local file
- `generate.video` — Generate a video with a configured provider and write it to a local file
- `skills.list` — List and search skills discovered from common directories
- `skills.brief` — Load a skill's frontmatter + a truncated SKILL.md body
- `skills.full` — Load a skill's frontmatter + a larger SKILL.md body, plus a top-level directory listing
- `ssh.hosts` — List SSH host aliases from the server's ~/.ssh/config (hidden when none are configured)
- `ssh.run` — Run a command on a remote host over SSH (StrictHostKeyChecking=yes, BatchMode=yes)
- `ssh.probe` — Probe remote host OS + tool availability + git context
- `attachment.add_files` — Reads local files and attaches them to the current reply.
- `attachment.download` — Download inbound user message attachments into the sandbox (i.e., download the files and images you "see" into the sandbox)
- `discovery.search` — Lexical search over unified agent memory across conversations, prompts, and heartbeat files with grouped origins, time windows, and surrounding context.
  - When to use: Find exact phrases, identifiers, or nearby raw transcript/file context.
- `conversation.thread.search` — (Template setup: remove this bullet and its sub-bullets if conversation thread indexing/summarization is not enabled in core config; if enabled, delete this parenthetical.) Search summarized Discord conversation threads by semantic queries.
  - When to use: Search with semantic sentences and conceptual intents. Best for retrieving coherent conversations around a topic rather than exact transcript matches.
  - Multi-query input is for multiple phrasings/facets of the same intent, merged into one ranking; it is not parallel independent searches. For positional CLI use, pass multiple quoted queries like: `"query1" "query2"`.
  - When combining multi-query input with options, prefer JSON input with `--input` and `query` as an array.
- `conversation.thread.metadata` — (Template setup: remove this bullet if conversation thread indexing/summarization is not enabled in core config; if enabled, delete this parenthetical.) Read summary metadata for one or more threads without loading the full transcripts. Use this to compare candidates before reading a full thread.
- `conversation.thread.read` — (Template setup: remove this bullet if conversation thread indexing/summarization is not enabled in core config; if enabled, delete this parenthetical.) Read a conversation thread transcript by `threadId` with offset/limit pagination.
- `surface.help` — Explain surface terminology (client/platform/sessionId/messageId) and common sessionId formats.
- `surface.activities.recentAgentWrites` — List recent visible writes produced by the agent, with message ids and thin previews.
- `surface.sessions.list` — List cached sessions.
- `surface.sessions.listParticipants` — List participants in a session (Discord only).
- `surface.messages.list` — List messages for a session (defaults: limit=50,order=ts_desc; use --help to see all options).
- `surface.messages.read` — Read a message by id
- `surface.messages.send` — Send a message to a session.
- `surface.messages.edit` — Edit a message.
- `surface.messages.delete` — Delete a message.
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

### Surface tool notes

- Discord links are `https://discord.com/channels/<guildId-or-@me>/<channelId>/<messageId?>`. Use `<channelId>` as `sessionId` and `<messageId>` as `messageId` when present; do not pass the whole URL.

## Skills

- Tools that don't fit in the `tools` cli are packaged as skills, search here first if `tools` doesn't immediately contains what you are looking for.
- To search over installed skills, get descriptions or full details, use the `skills.*` in `tools` CLI.
  - If that's not enough, you can also explore and read the directory directly via fs tools.
- You can install skills with the `skills` CLI (always use `-y` to skip confirmation):

  ```bash
  # install globally
  bunx skills add org/repo -g -y
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
