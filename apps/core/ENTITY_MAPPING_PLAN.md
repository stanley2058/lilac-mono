# Entity Mapping (Discord Mentions) - Implementation Plan (v1)

This document proposes a v1 “entity mapping” layer for Lilac.

Goal: allow the agent to write canonical tokens like `@Stanley` and `#dev_channel`, and have them rendered as platform-specific mention syntax on output (Discord: `<@id>`, `<#id>`), without sprinkling ad-hoc replacement logic across the codebase.

This is intentionally scoped to Discord + users + channel/session tokens.

## Scope

In scope (v1):
- Platform: Discord only.
- Entities:
  - Users: canonical `@username` -> Discord `<@userId>`.
  - Sessions/channels: canonical `#token` -> Discord `<#channelId>`.
- Inbound normalization (Discord -> canonical):
  - `<@id>` -> `@username`.
  - `<#id>` -> `#token` if configured, otherwise a best-effort fallback.
- Overrides via config.
- Persisted reverse lookup for `username -> userId` (DB), plus small in-memory caches.

Out of scope (v1):
- Roles (`<@&id>` / `@role`).
- Platforms other than Discord.
- Guaranteeing “no ping but still renders as a mention” beyond Discord’s capabilities.
  - We will keep `allowedMentions: { parse: [], repliedUser: false }` so no notifications are sent.

## Canonical Syntax (Model-Facing)

- User mention: `@<username>`
  - Uses Discord *username* (not display name) to reduce collisions.
  - Case-insensitive matching, but when rendering canonical text we prefer config casing.
- Channel/session token: `#<token>`
  - Token is a config-defined alias (e.g. `dev_channel`).

## Config

Add an optional `entity` section to `CoreConfig` (YAML):

```yaml
entity:
  users:
    Stanley:
      discord: "123"  # raw Discord user id
  sessions:
    discord:
      dev_channel: "456" # raw Discord channel id
```

Rules:
- Config keys under `entity.users` are treated as canonical usernames.
  - Matching is case-insensitive.
  - When normalizing inbound mentions to `@username`, prefer config key casing if the id is configured.
- Config keys under `entity.sessions.discord` are treated as canonical `#token` aliases.
  - Matching is case-insensitive.

## Architecture

### Entity Mapper

Create a centralized module responsible for all mention/entity rewriting:

- New module: `apps/core/src/entity/entity-mapper.ts`

Export a small, pluggable API:

- `type EntityMapper = { normalizeIncomingText(text: string): string; rewriteOutgoingText(text: string): string }`
- `createDiscordEntityMapper(deps: { cfg: CoreConfig; store: DiscordSurfaceStore }): EntityMapper`

This intentionally supports adding more entity rules later (roles, other platforms) by composing rule functions internally.

### Rewrite Rules (Discord v1)

Outbound (canonical -> Discord):
- `@username` -> `<@userId>`
  - Resolution order:
    1) `cfg.entity.users` (case-insensitive match on username)
    2) DB lookup by username (case-insensitive)
    3) leave as-is
- `#token` -> `<#channelId>`
  - Resolution order:
    1) `cfg.entity.sessions.discord` (case-insensitive match on token)
    2) leave as-is

Inbound (Discord -> canonical):
- `<@id>` -> `@username`
  - Resolution order:
    1) If config contains a username mapped to this id, use the config key casing: `@Stanley`
    2) DB lookup for id -> username; output `@<username>`
    3) fallback: `@user_<id>`
- `<#id>` -> `#token`
  - Resolution order:
    1) If config contains a token mapped to this channel id, use that canonical token: `#dev_channel`
    2) DB lookup for id -> channel name; output `#<sanitized_name>`
    3) fallback: `#channel_<id>`

### Markdown / Code Safety

Rewrites must not occur inside:
- fenced code blocks (``` ... ```)
- inline code spans (`...`)

This prevents corrupting snippets and tool output.

Implementation approach (v1):
- A lightweight scanner that splits input into segments of type `{ kind: "text" | "code"; value: string }`.
- Apply regex-based rewrites only on `kind === "text"` segments.

## Persistence: DB + Cache

### Why

Outbound rewriting runs on hot paths (Discord streaming output). It must be synchronous and fast.

We already persist `discord_user_names` (userId -> username) but do not have a reverse index for `username -> userId`.

### DB Changes

Update `apps/core/src/surface/store/discord-surface-store.ts`:

- Add table:
  - `discord_user_ids_by_username`
    - `username_lc TEXT PRIMARY KEY`
    - `user_id TEXT NOT NULL`
    - `updated_ts INTEGER NOT NULL`
  - Add index on `user_id` if needed later.

- Update `upsertUserName(...)`:
  - If `input.username` exists, `INSERT .. ON CONFLICT(username_lc) DO UPDATE` to keep the newest mapping.

- Add methods:
  - `getUserIdByUsername(username: string): string | null`
  - (optional) `getUsernameByUserId(userId: string): string | null` (can reuse existing `getUserName`)

### In-Memory Cache

EntityMapper may keep a small per-process cache to reduce repeated DB calls:
- `Map<string, string>` for username_lc -> userId
- `Map<string, string>` for userId -> canonicalUsername (config casing or DB username)

Caches should be safe to treat as best-effort.

## Wiring Points

### Outbound (agent output -> Discord)

Modify `apps/core/src/surface/discord/output/discord-output-stream.ts`:
- Apply `rewriteOutgoingText` at render time (not per-delta) to avoid token splits.
- Primary path: in embed rendering, replace `getContent: () => this.textAcc` with `getContent: () => rewriteOutgoingText(this.textAcc)`.
- Fallback path: when editing `first` into final plain message (`safeEdit(first, { content: ... })`), rewrite there too.

Keep:
- `allowedMentions: { parse: [], repliedUser: false }` to prevent pings.

### Inbound (Discord events -> SurfaceMessage.text -> model)

Modify `apps/core/src/surface/discord/discord-adapter.ts`:
- When constructing `SurfaceMessage.text` for created/updated messages, normalize:
  - `<@id>` -> `@username` using config casing preference.
  - `<#id>` -> `#token` if configured.

This keeps canonical text consistent for:
- request composition (`apps/core/src/surface/bridge/request-composition.ts`)
- future platforms, since canonicalization happens at the adapter boundary.

## Tests

Add unit tests in `apps/core/tests/entity/entity-mapper.test.ts`:

- Outbound:
  - `@Stanley` -> `<@123>` via config
  - `@someone` -> `<@id>` via DB lookup
  - do not rewrite inside code blocks / inline code
  - punctuation handling: `@Stanley,` -> `<@123>,`

- Inbound:
  - `<@123>` -> `@Stanley` (config casing)
  - `<@999>` -> `@user_999` (fallback)
  - `<#456>` -> `#dev_channel` (config)

If DB tests are needed:
- Use a temp file DB path to test `upsertUserName` + `getUserIdByUsername`.

## Rollout / Compatibility

- If mappings are missing, output stays readable (`@username` / `#token`).
- Config can be introduced incrementally to pin specific usernames/tokens.

## Follow-ups (Not v1)

- Roles: add `@role` rule + `discord_role_names` reverse lookup.
- Slack: add a Slack mapper implementation with `<@U123>` style.
- Bus-level entity rewriting for non-Discord sinks (if/when surfaces expand).
