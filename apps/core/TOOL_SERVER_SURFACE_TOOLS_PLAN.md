
This plan extends Lilac so “adapter operations” live as **tool-server tools** (a 2nd-level tool) while the agent still only has `bash`/`fs` at runtime.

The agent invokes these adapter-backed operations by running the existing `tools` CLI (apps/tool-bridge) via the `bash` tool.

## Goals

- Expose adapter capabilities (Discord for now) as tool-server callables.
- Let the agent do message CRUD against **any allowed channel/guild**:
  - list/read messages (cached-only)
  - send/edit/delete messages (Discord API)
- Let tool inputs accept canonical entity syntax:
  - `sessionId` supports alias tokens defined via entity mapping (`cfg.entity.sessions.discord`).
  - `text` supports `@user` and `#token` rewriting to Discord `<@id>` / `<#id>`.
- `surface.sessions.list` returns both:
  - `channelId` (raw id)
  - `token` (best-effort reverse alias when configured)

## Non-goals (v1)

- Creating/renaming/archiving channels/threads/DMs.
- Fetching message history from Discord for tool reads.
- Building a new agent tool protocol; we reuse the existing tool-server HTTP bridge + `tools` CLI.

## Current State

- Core runtime starts an HTTP tool server in-process:
  - `apps/core/src/tool-server/create-tool-server.ts`
  - callables already exist (`workflow`, `attachment.add`, `attachment.download`, ...)
- Agent runner exposes only `bash` + `fs` tools:
  - `apps/core/src/surface/bridge/bus-agent-runner.ts`
- `bash` tool injects request context env vars:
  - `LILAC_REQUEST_ID`, `LILAC_SESSION_ID`, `LILAC_REQUEST_CLIENT`, `LILAC_CWD`
  - `apps/core/src/tools/bash-impl.ts`
- `tools` CLI forwards those env vars as `x-lilac-*` headers and calls tool-server `/call`:
  - `apps/tool-bridge/client.ts`
- Entity mapping already exists for canonical text rewriting:
  - `apps/core/src/entity/entity-mapper.ts`
  - inbound: `<@id>` -> `@user`, `<#id>` -> `#token`
  - outbound: `@user` -> `<@id>`, `#token` -> `<#id>`

## Proposed Change

### A) Add a tool-server “surface” tool

Create a new `ServerTool` implementation that wraps the active `SurfaceAdapter` instance.

- New file: `apps/core/src/tool-server/tools/surface.ts`
- Register it in the default tool set:
  - `apps/core/src/tool-server/default-tools.ts`
- Inject `adapter` into the tool-server tool list from core runtime:
  - `apps/core/src/runtime/create-core-runtime.ts`

### B) New callable IDs

Naming matches existing dot-style callables.

- `surface.sessions.list`
  - cached-only (adapter store)
  - output includes `{ channelId, guildId?, parentChannelId?, kind, title?, token? }`

- `surface.messages.list`
  - cached-only (adapter store)
  - input: `{ sessionId, limit? }`

- `surface.messages.read`
  - cached-only (adapter store)
  - input: `{ sessionId, messageId }`

- `surface.messages.send`
  - Discord API via adapter
  - input: `{ sessionId, text, replyToMessageId? }`

- `surface.messages.edit`
  - Discord API via adapter
  - input: `{ sessionId, messageId, text }`

- `surface.messages.delete`
  - Discord API via adapter
  - input: `{ sessionId, messageId }`

### C) Session ID aliasing (entity mapping integration)

Tools that accept `sessionId` should accept all of:

- Raw channel id: `1234567890`
- Channel mention: `<#1234567890>`
- Token alias: `ops` or `#ops`

Resolution uses `CoreConfig.entity.sessions.discord` (case-insensitive key match).

Implementation approach:

- Add a small shared resolver (tool-server-side) used by:
  - `apps/core/src/tool-server/tools/surface.ts`
  - `apps/core/src/tool-server/tools/workflow.ts`
- Suggested helper location:
  - `apps/core/src/tool-server/tools/resolve-discord-session-id.ts`

Notes:

- This is separate from `EntityMapper` because `EntityMapper` is currently created inside `DiscordAdapter` (it is not directly accessible from tool-server tools).
- Output token (`surface.sessions.list`) is the reverse mapping:
  - if `cfg.entity.sessions.discord` contains a token that maps to this channelId, return that token.

### D) Text mention rewriting

For outbound message text (`send`, `edit`), we need canonical mentions to become Discord mention syntax.

- `DiscordAdapter.sendMsg()` already supports outbound rewrite via `entityMapper.rewriteOutgoingText`.
- Patch `DiscordAdapter.editMsg()` to also apply `rewriteOutgoingText`.
  - Current `editMsg()` edits `content.text` directly, which bypasses entity mapping.

Additionally, ensure channel tokens in text support common alias shapes:

- Update the outbound channel token regex in `apps/core/src/entity/entity-mapper.ts` so `#token` supports hyphens (e.g. `#release-room`).
  - Today it only matches `[A-Za-z0-9_]`.

### E) Allowlist enforcement

Mutating operations must not allow arbitrary channel IDs.

For `send/edit/delete`:

- Allow if `channelId` is in `cfg.surface.discord.allowedChannelIds`.
- Else allow if channel’s `guildId` is in `cfg.surface.discord.allowedGuildIds`.
  - If we have a cached session row, use its `guildId`.
  - If no cached session row, do a lightweight Discord API channel fetch to obtain guildId (no history fetch).

For reads (`list/read`):

- Cached-only.
- Still apply allowlist filtering to avoid leaking cached data from disallowed channels.

### F) Workflow tool update (sessionId alias)

Update `apps/core/src/tool-server/tools/workflow.ts` so each task’s `sessionId` can be an alias token.

- Before publishing `CmdWorkflowTaskCreate`, resolve `t.sessionId` to the canonical channel id.
- Keep `summary`/`description` canonical (do not rewrite @mentions/#tokens) because they are model-facing metadata, not Discord output.

### G) Attachment tool note

No changes required:

- `attachment.add` and `attachment.download` do not accept `sessionId` or outbound `text`.
- They rely on request context headers for routing to the current request/session.

## Wiring Steps

- Update `apps/core/src/tool-server/default-tools.ts`
  - Accept an optional `adapter?: SurfaceAdapter` param.
  - Add `new Surface({ adapter, bus, config? })` when adapter is provided.
- Update `apps/core/src/runtime/create-core-runtime.ts`
  - Pass the live adapter into `createDefaultToolServerTools({ bus, adapter })`.

## Agent Invocation

No new agent tools are required.

The agent uses the existing `bash` tool to run the `tools` CLI:

- `tools surface.sessions.list --output=json`
- `tools surface.messages.send --sessionId=#ops --text="ping @stanley"`

Context propagation:

- `bash` tool already sets `LILAC_*` env vars.
- `tools` CLI forwards them as `x-lilac-*` headers.

## Testing

- Add a unit test for the new tool-server tool:
  - `apps/core/tests/tool-server/surface.test.ts`
  - Use a FakeAdapter similar to `apps/core/tests/surface/bridge/bus-request-router.test.ts`.
- Add/extend entity mapping tests:
  - ensure `#release-room` (hyphen) works
- Add a regression test for `DiscordAdapter.editMsg()` rewrite behavior.

## Rollout / Compatibility

- If entity mappings are missing, tools should behave predictably:
  - `sessionId` alias fails with a clear error (unknown token) rather than silently sending to the wrong place.
  - outbound `text` is still sent, just without rewritten mentions if no mapping exists.
