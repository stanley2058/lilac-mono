# Surface Adapters (Core) - Implementation Plan (v1)

This document captures the v1 architecture for "surface adapters" in `apps/core/`.
The first concrete target adapter is Discord.

## Goals

- Provide a cross-platform adapter interface for chat-like surfaces (Discord/Slack/etc).
- Ingest platform events into a local cache (SQLite) for fast lookback/search.
- Publish adapter-level events to the event bus for downstream consumers.
- Publish `cmd.request.message` only for messages that should wake the agent:
  - bot mention, or
  - direct reply to a bot-authored message (preferred trigger when both match)

Non-goals for v1:
- Agent execution loop and response streaming (will be built later).
- Perfect Discord read/unread integration (bots have limited read state).

## Repository Layout (Proposed)

- `apps/core/src/surface/`
- `apps/core/src/surface/types.ts` (platform-agnostic types)
- `apps/core/src/surface/adapter.ts` (adapter interface)
- `apps/core/src/surface/events.ts` (adapter event union)
- `apps/core/src/surface/store/` (SQLite store)
- `apps/core/src/surface/discord/` (Discord implementation)

The adapter should not depend on Redis/event-bus directly. Instead:
- adapter emits events via `subscribe(handler)`
- a small bridge publishes them into `@stanley2058/lilac-event-bus`

## Adapter Interface (v1)

Core lifecycle:
- `connect()`
- `disconnect()`
- `getSelf()`
- `getCapabilities()`

Session/message APIs:
- `listSessions()`
- `sendMsg(sessionRef, contentOpts, sendOpts?)`
- `readMsg(msgRef)`
- `listMsg(sessionRef, limitOpts)`
- `editMsg(msgRef, contentOpts)`
- `deleteMsg(msgRef)`
- `getReplyContext(msgRef, limitOpts)`

Reactions + subscription:
- `addReaction(msgRef, reaction)`
- `removeReaction(msgRef, reaction)`
- `listReactions(msgRef)`
- `subscribe(handler)`

Unread:
- `getUnRead(sessionRef)` (returns full messages)
- `markRead(sessionRef, upToMsgRef?)` (updates adapter-local cursor in DB)

### sendMsg semantics

- Primary semantics: send a new message into the session.
- Replying is an option:
  - `sendOpts.replyTo?: MsgRef`

## Cross-Adapter Types

### References

Refs are typed objects (not opaque strings).

Discord:
- `SessionRef`: `{ platform: "discord"; channelId: string; guildId?: string; parentChannelId?: string }`
  - threads are separate sessions; `parentChannelId` is populated for threads
- `MsgRef`: `{ platform: "discord"; channelId: string; messageId: string }`

### Normalized message/session

- `SurfaceSession`: `{ ref: SessionRef; title?: string; kind: "channel"|"thread"|"dm"; ... }`
- `SurfaceMessage`:
  - `{ ref: MsgRef; session: SessionRef; authorId: string; text: string; ts: number; editedTs?: number; deleted?: boolean; raw?: unknown }`

Note: user objects are not exposed to the agent directly. The adapter must normalize mentions to display names before emitting request text.

## Config (`data/core-config.yaml`)

Config file path:
- `${env.dataDir}/core-config.yaml`

Source of `dataDir`:
- `packages/utils/env.ts` exposes `env.dataDir` (defaults to `${workspaceRoot}/data`, override with `DATA_DIR`).

Discord config (v1):
- `surface.discord.allowedChannelIds: string[]`
- `surface.discord.allowedGuildIds?: string[]`
  - allowlist behavior is OR: either matching is enough
- `surface.discord.dbPath?: string` (default `${env.dataDir}/discord-surface.db`)
- `surface.discord.botName: string`
  - must not contain spaces (enforced by config validation)
- `surface.discord.statusMessage?: string` (sets Discord presence)

Secrets:
- Discord token should remain an env var (e.g. `DISCORD_TOKEN`), referenced by config.

## SQLite Cache

We use an adapter-specific DB file (not the shared `data.sqlite3`) by default:
- `${env.dataDir}/discord-surface.db`

Tables (v1):

### `discord_sessions`
- `channel_id TEXT PRIMARY KEY`
- `guild_id TEXT NULL`
- `parent_channel_id TEXT NULL` (thread parent)
- `name TEXT NULL`
- `type TEXT NOT NULL` (channel/thread/dm)
- `updated_ts INTEGER NOT NULL`
- `raw_json TEXT NULL`

### `discord_messages`
- `(channel_id TEXT, message_id TEXT) PRIMARY KEY`
- `author_id TEXT NOT NULL`
- `content TEXT NOT NULL`
- `ts INTEGER NOT NULL`
- `edited_ts INTEGER NULL`
- `deleted_ts INTEGER NULL`
- `raw_json TEXT NULL`

Indexes:
- `(channel_id, ts)`
- `(channel_id, author_id, ts)`

### `discord_read_state`
- `channel_id TEXT PRIMARY KEY`
- `last_read_ts INTEGER NOT NULL`
- `last_read_message_id TEXT NOT NULL`

### `discord_user_names`
Stores best-effort userId -> display name mapping.

- `user_id TEXT PRIMARY KEY`
- `username TEXT NULL`
- `global_name TEXT NULL`
- `display_name TEXT NULL`
- `updated_ts INTEGER NOT NULL`

This table is updated opportunistically when:
- receiving messages from the user
- receiving messages that mention users (from `msg.mentions.*`)

## Mention Normalization (Critical)

Before emitting `cmd.request.message` into the bus, request text is rewritten:
- replace `<@123>` and `<@!123>` with `@DisplayName`
- output name is sanitized (spaces replaced with `_`) to keep mentions token-like
- bot mentions are rewritten using `surface.discord.botName` (no spaces)

Optional (can be v1 or v1.1):
- `<@&roleId>` -> `@RoleName`
- `<#channelId>` -> `#channel-name`

Event bus fields will include:
- `userName?: string` (author display name)
- `channelName?: string` (best-effort channel/thread name)

## Request Trigger + 7-Minute Merge

A message becomes a request if:
- it mentions the bot, OR
- it is a reply to a bot-authored message

If both conditions match, treat trigger as `reply`.

For request creation only (not for storage), merge same-author messages within the Discord UI grouping window:
- walk backward through cached messages in the same session
- merge consecutive messages while:
  - same author
  - time gap between consecutive messages <= 7 minutes
- merged text order: oldest -> newest joined with `\n\n`

For mention-triggered requests, strip the leading bot mention from the first merged chunk.

## Event Bus Contracts

### Adapter events (always published for allowed channels)
Add new event types to `packages/event-bus/lilac-spec.ts`:
- `evt.adapter.message.created`
- `evt.adapter.message.updated`
- `evt.adapter.message.deleted`
- `evt.adapter.reaction.added`
- `evt.adapter.reaction.removed`

These events reflect the platform surface state and drive cache sync downstream.

### Request events (only on triggers)
Reuse existing:
- `cmd.request.message`

Extend `CmdRequestMessageData` to include:
- `userName?: string`
- `channelName?: string`

`raw` should include trigger metadata:
- `triggerType: "mention" | "reply"`
- `mergedMessageIds: string[]`
- session metadata (`guildId`, `parentChannelId`, etc)

## Discord Adapter (Implementation Notes)

- Use `discord.js`.
- Intents should include `MessageContent` for content ingestion.
- Listen to:
  - `messageCreate` (cache + adapter event; request if trigger)
  - `messageUpdate` (cache + adapter event)
  - `messageDelete` (cache + adapter event)
  - reaction add/remove (cache + adapter event)
- Set presence/status message on ready.

## Reuse from js-llmcord (Outgoing Rendering)

For later (agent output streaming back to Discord), copy utilities from `ref/js-llmcord/` into a reusable module:
- `token-complete.ts`
- `markdown-splitter.ts`
- `markdown-chunker.ts`

This will be used to produce Discord-friendly message chunking and auto-closing markdown.

## Next Steps

1) Implement config loader for `data/core-config.yaml` in `packages/utils/`.
2) Add event-bus contract extensions in `packages/event-bus/lilac-spec.ts`.
3) Implement SQLite store for Discord surface cache.
4) Implement `DiscordAdapter` skeleton with connect/disconnect + event ingestion.
5) Implement request trigger + 7-minute merge + mention normalization.
6) Add a bridge that publishes adapter events + request events to the bus.
