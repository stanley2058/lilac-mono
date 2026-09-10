# TOOLS.md - Tool map and environment gotchas

Keep a compact existence map for tools hidden behind the `tools` CLI. Add detail only for environment facts and gotchas that cannot be recovered cheaply from schemas, `--help`, configuration, or the filesystem.

## `tools` CLI catalog

- `fetch` extracts ordinary webpages; `search` discovers pages. Use raw HTTP or browser tooling for headers, status, raw content, or interaction.
- `generate.{image,video}` creates media.
- `skills.{list,read}` finds and loads installed skills.
- `ssh.{hosts,probe,run}` discovers hosts and runs remote shell work.
- `attachment.add_files` attaches local files or `resource://` references to a reply; `resource.materialize` writes resources locally.
- `discovery.search` finds exact phrases and raw prompt or transcript context.
- `conversation.thread.{search,metadata,read}` finds semantic conversation threads, compares candidates, and reads transcripts when thread indexing is enabled.
- `surface.sessions.{list,listParticipants}` inspects sessions and participants.
- `surface.messages.{list,read,send,edit,delete}` handles surface messages.
- `surface.reactions.{list,listDetailed,add,remove}` handles surface reactions.
- `surface.help` explains surface identifiers; `surface.activities.recentAgentWrites` finds recent agent writes.
- `mcp.*` manages configured MCP servers. Load the `mcp-management` skill before changing them.
- Programmatic and scheduled workflows are documented by `workflow-authoring`; load it before using those APIs.

## Local conventions

- JavaScript and TypeScript: prefer `bun` and `bunx` over `node`, `npm`, and `npx` unless the project requires otherwise.
- Python: use `uv run` for scripts and `uvx` for packaged CLIs. Treat system Python as stdlib-only; add imports per command, for example `uv run --with pillow python script.py`.
- `tools` CLI: flags use `--name=value`; pass structured input with `--input=@file` or `--stdin`.
- Remote files: prefer native filesystem tools with `<host>:<path>` targets; use `ssh.run` for multi-step remote shell work.
- `<redacted>` in command output is a display transform; the runtime value is unchanged. Never print the underlying secret.

## Surface gotcha

For Discord URLs, pass the channel ID as `sessionId` and the final message ID as `messageId`; pass neither the full URL nor the guild ID.
