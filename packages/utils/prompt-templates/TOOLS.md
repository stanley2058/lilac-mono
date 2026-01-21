# TOOLS.md - Local Notes For Tool Usage

You have access to three tiers of tools:

1. bash & fs tools
2. `tools` CLI accessible via `bash`
3. Skills (more below)

## bash usage

- Preinstalled handy tools: `node`, `npm`, `bun`, `python`, `uv`, `curl`, `rg`, `fd`, `jq`, `curl`, `git`
- Prefer `bun` over `node` and `npm`; `bunx` over `npx`

## `tools` CLI

The `tools` CLI is an unified interface for all built-in tools.

Basic usage:

```bash
tools --list
tools --help [tool]
tools <tool> --arg1=value --arg2=value
tools <tool> --input @payload.json
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
- `workflow` — Create a workflow that will resume later.
  - Each task waits for a strict reply to the given messageId in sessionId.
  - Use this after sending a message (e.g. DM) and you want to resume when they reply.
- `workflow.send_and_wait_for_reply` — Send a message to a Discord session and create a workflow task that waits for a reply to that message.
  - This is a convenience wrapper around: surface.messages.send + workflow.
- `attachment.add_files` — Reads local files and attaches them to the current reply.
- `attachment.download` — Download inbound user message attachments into the sandbox (i.e., download the files and images you "see" into the sandbox)
- `surface.sessions.list` — List cached sessions.
- `surface.messages.list` — List messages for a session
- `surface.messages.read` — Read a message by id
- `surface.messages.send` — Send a message to a session.
- `surface.messages.edit` — Edit a message.
- `surface.messages.delete` — Delete a message.
- `surface.reactions.list` — List cached reactions for a message.
- `surface.reactions.add` — Add a reaction to a message.
- `surface.reactions.remove` — Remove a reaction from a message.

### Instructions on workflow

Workflow tools are designed to be used in conjunction with the `surface` tool. Imagine this workflow:

1. User A asked you to DM another user B
2. You sent a message to B via `surface.messages.send` and gets back a messageId
3. You create a workflow task that waits for a reply to that messageId
4. The workflow service will resume you with the context you set when you created the task after a reply is received from B
   (In the above example, 2 and 3 can be simplified with `workflow.send_and_wait_for_reply`)

## Skills

- To search over installed skills, get descriptions or full details, use the `skills.*` in `tools` CLI.
  - If that's not enough, you can also explore and read the directory directly via fs tools.
- You can install skills with the `add-skill` CLI (always specify an agent (we support all of them), and always use `-y` to skip confirmation):

  ```bash
  # install globally to opencode agent
  bunx add-skill -a opencode -g -y org/repo
  # help message
  bunx add-skill --help
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
