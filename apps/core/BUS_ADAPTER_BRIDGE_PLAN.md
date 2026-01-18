# Bus -> Adapter Bridge + Request Envelope + ModelMessage Input (v1)

This plan defines the next architecture step: connect the Redis Streams event bus (`@stanley2058/lilac-event-bus`) to the surface adapter output streaming API (`SurfaceAdapter.startOutput()`), while also upgrading request input events to carry **AI SDK `ModelMessage[]`** instead of a single text/user tuple.

This is intended to be an implementation reference for `apps/core/` (Discord first).

## Goals

- Use a **durable fanout** subscriber on `evt.request` to receive reply triggers.
- For each reply trigger, start a per-request relay that subscribes to `out.req.${request_id}` and pushes:
  - streaming text (`evt.agent.output.delta.text`)
  - tool status updates (`evt.agent.output.toolcall`)
  - binary outputs (`evt.agent.output.response.binary`)
  - final text (`evt.agent.output.response.text`)
  into `SurfaceOutputStream`.
- Standardize request correlation via a typed **envelope header** (no duplication in payload).
- Remove the 1:1 assumption between a single Discord message and a request:
  - request input becomes **multi-message** (reply chain, aggregation windows), encoded as **AI SDK `ModelMessage[]`**.

## Non-Goals (for this iteration)

- Implement the agent service itself.
- Implement reasoning UI. (Reasoning events should remain plumbable later.)
- Perfect Discord attachment behavior during streaming (Discord message edits cannot reliably add files).

## Canonical Envelope Headers

All request-scoped events must include the following headers:

```ts
{
  request_id: string;       // required for request/workflow/output events
  session_id: string;       // canonical session id; for Discord: channelId
  request_client: string;   // e.g. "discord"
}
```

Rules:
- `request_id` is **required** for:
  - request lifecycle events
  - request reply events
  - workflow events
  - all agent output events
- `request_id` is optional for adapter ingestion events (message.created, reaction.added, etc).
- Publishers should treat missing `request_id` on request-scoped events as an error.

### `request_id` format (assumed stable)

For v1, `request_id` is a 3-part stable identifier:

```
<surface>:<session_id>:<surface_specific_id>
```

Discord example:
- `<surface>`: `discord`
- `<session_id>`: Discord `channelId`
- `<surface_specific_id>`: triggering Discord message id

This allows the surface to reconstruct `replyTo` without requiring extra fields.

## Event Contract Changes (Event Bus)

This plan requires refactoring the bus event contracts in `packages/event-bus/`.

### 1) Make envelope headers typed

Update `packages/event-bus/lilac-bus.ts` types so:
- `LilacMessage<T>['headers']` is typed as:
  - `Record<string, string> & Partial<LilacEnvelopeHeaders>`
- `LilacBus.publish(..., { headers })` accepts the same typed structure.

Define:
- `type LilacEnvelopeHeaders = { request_id?: string; session_id?: string; request_client?: AdapterPlatform }`.

Important: runtime storage remains JSON (Redis Streams stores `headers` as a JSON string), but compile-time typing should guide all publishers/consumers.

### 2) Remove `requestId` from payloads

We should not keep request correlation both in payload and headers.

Remove `requestId` fields from:
- `CmdRequestMessageData`
- `EvtRequestLifecycleChangedData`
- `EvtRequestReplyData`
- `EvtAgentOutputDeltaReasoningData`
- `EvtAgentOutputDeltaTextData`
- `EvtAgentOutputResponseTextData`
- `EvtAgentOutputResponseBinaryData`
- `EvtAgentOutputToolCallData`
- any workflow payloads currently carrying `requestId` (or `requestId?`)

### 3) Replace request payload with AI SDK `ModelMessage[]`

`cmd.request.message` must stop carrying `text/userId/userName/channelId` as payload fields.

New `CmdRequestMessageData` should be something like:

```ts
import type { ModelMessage } from "ai";

export type CmdRequestMessageData = {
  messages: ModelMessage[];
  raw?: unknown;
};
```

Notes:
- Session/user/platform routing comes from headers:
  - `session_id`, `request_id`, `request_client`
- `raw` remains for adapter-specific metadata.
- This design supports requests derived from multiple surface messages.

Dependency:
- Add `ai` dependency to `packages/event-bus` (monorepo coupling is acceptable for now).

### 4) Update publish routing in `createLilacBus()`

`packages/event-bus/lilac-bus.ts` currently derives `out.req.*` topic and message correlation key from `data.requestId`.

Update routing to use `headers.request_id`:
- For output event types (`evt.agent.output.*`):
  - `topic = outReqTopic(headers.request_id)`
  - `key = headers.request_id`
  - Throw if missing.

Also update key derivation for request/workflow events:
- `key = headers.request_id` (throw if missing).

### 5) Update tests

Update `packages/event-bus/tests/redis-streams-bus.test.ts`:
- pass `headers: { request_id: ... }` into `bus.publish()` instead of `requestId` in data.
- update `cmd.request.message` tests to send `messages: ModelMessage[]`.

## Adapter -> Bus Publishing Changes (Core)

Update `apps/core/src/surface/bridge/publish-to-bus.ts`:

- `adapter.request` case should publish `cmd.request.message` with:
  - `headers`:
    - `request_id: evt.requestId`
    - `session_id: evt.channelId` (Discord channel id)
    - `request_client: "discord"`
  - payload:
    - `messages: ModelMessage[]`
    - `raw: evt.raw`

This implies `AdapterRequestEvent` in `apps/core/src/surface/events.ts` needs to change:
- replace `channelId/userId/userName/text` with `messages: ModelMessage[]`
- keep `requestId` locally in core (it becomes the bus header value).

## Discord Request Construction (Reply Chain -> ModelMessage[])

When Discord triggers a request (bot mention OR reply-to-bot), we must build a multi-message request payload.

### Inputs

- Trigger message: `msg`
- SQLite cache: `DiscordSurfaceStore`
- Discord API: used only as a fallback if the cache is missing messages.

### Algorithm (high signal)

Given a reply chain:

```
1 -> 2 -> 3 -> 4 (contains @bot and triggers request)
```

Steps:

1) Identify the triggering message (current logic already does this).
2) Walk backward via `message.reference?.messageId`:
   - Collect message ids until:
     - no reference, OR
     - max depth reached (pick a limit; e.g. 20), OR
     - missing and cannot fetch.
3) Resolve each message id to a cached message:
   - Prefer SQLite (`DiscordSurfaceStore.getMessage(channelId, messageId)`)
   - If missing, optionally fetch via Discord API and upsert into SQLite.
4) Order resolved messages **oldest -> newest**.
5) For each message, normalize content:
   - apply mention normalization (`replaceUserMentions`, `replaceRoleMentions`, `replaceChannelMentions`)
   - for mention-triggered requests: strip leading bot mention from the first relevant content (keep current behavior, but applied to the correct message in the chain)
   - optionally apply the 7-minute merge window **within the chain** (same author, <= 7m gap):
     - this reduces “Discord UI chunking” noise.
6) Map each normalized surface message to an AI SDK `ModelMessage`:
   - `role: "user"` for user-authored messages
   - `role: "assistant"` for bot-authored messages (if included in the chain)
   - content encoding: include author metadata in a stable format (js-llmcord style).

Recommended content template (string-only, simplest):

```
[discord user_id=<id> user_name=<name> message_id=<id>]
<normalized_text>
```

This keeps the request multi-message, preserves attribution, and avoids extra `ModelMessage.content` structured parts initially.

### Result

Emit `adapter.request` with:
- `requestId` (local), which becomes `headers.request_id`
- `channelId` (local), which becomes `headers.session_id`
- `messages: ModelMessage[]`
- `raw`: include trigger metadata + message ids included.

## Bus -> Adapter Bridge (Core)

Add a new module:

- `apps/core/src/surface/bridge/subscribe-from-bus.ts`

### Responsibilities

- Create a shared durable subscriber on `evt.request` (fanout).
- Start per-request output relays on `evt.request.reply`.
- Push output events into `SurfaceAdapter.startOutput()`.

### Shared subscriber (evt.request)

Subscription:
- `topic`: `"evt.request"`
- `mode`: `fanout`
- `subscriptionId`: stable per adapter instance (e.g. `"discord-adapter"`)
- `consumerId`: unique per process (e.g. hostname + pid)
- `offset`: `now`

Handler behavior:
- On `evt.request.reply`:
  - Read headers:
    - `request_client` (must match this adapter)
    - `session_id` (Discord channel id)
    - `request_id` (stable request id)
  - Start a per-request relay if not already active.
  - `ctx.commit()` after the relay is started (so we don’t lose reply events).

### Routing + reply threading

Since `request_id` is stable in 3 parts, derive:
- `channelId = headers.session_id`
- `replyTo.messageId = third segment of request_id`
- `replyTo = { platform: "discord", channelId, messageId }`

Create output stream:
- `adapter.startOutput({ platform: "discord", channelId }, { replyTo })`

### Per-request output relay (out.req.*)

Subscribe:
- `topic`: `outReqTopic(request_id)`
- `mode`: `tail`
- `offset`: `begin` (prevents missing leading chunks if output starts immediately)

Relay mapping:
- `evt.agent.output.delta.text` -> `out.push({ type: "text.delta", delta })`
- `evt.agent.output.toolcall` -> `out.push({ type: "tool.status", update: { toolCallId, display, status, ok, error } })`
- `evt.agent.output.response.binary`:
  - decode base64 to bytes
  - infer attachment kind:
    - `mimeType.startsWith("image/") ? "image" : "file"`
  - `out.push({ type: "attachment.add", attachment: { kind, mimeType, filename, bytes } })`
- `evt.agent.output.response.text`:
  - `out.push({ type: "text.set", text })`
  - `await out.finish()`
  - stop the output subscription and remove the relay from the active map
- `evt.agent.output.delta.reasoning`: ignore for now, but keep a dedicated case branch for future UI wiring.

### Idempotency / duplicates

- Maintain `activeRelays: Map<string, { stop(): Promise<void> }>` keyed by `request_id`.
- If `evt.request.reply` is delivered more than once (fanout durable), avoid starting a second relay.

### Timeout / leak prevention

- Add an idle timeout (e.g. 2-5 minutes) per relay:
  - if no output messages arrive within the window, `out.abort("timeout")`, stop subscription, cleanup.

## Implementation Checklist (Ordered)

1) `packages/event-bus`
   - Add typed `LilacEnvelopeHeaders`.
   - Change `LilacMessage` and `LilacBus.publish()` typing for headers.
   - Add dependency on `ai`; update `CmdRequestMessageData` to `messages: ModelMessage[]`.
   - Remove `requestId` from all payloads.
   - Update `createLilacBus()` routing and keying to use `headers.request_id`.
   - Update `packages/event-bus/tests/redis-streams-bus.test.ts`.

2) `apps/core` (adapter publishing)
   - Update `AdapterRequestEvent` to carry `messages: ModelMessage[]`.
   - Update DiscordAdapter request trigger to build reply chain -> `ModelMessage[]`.
   - Update `apps/core/src/surface/bridge/publish-to-bus.ts` to publish headers envelope and new payload.

3) `apps/core` (bus -> adapter bridge)
   - Create `apps/core/src/surface/bridge/subscribe-from-bus.ts` implementing:
     - durable fanout subscriber on `evt.request`
     - per-request relay subscriber on `out.req.${request_id}`
   - Export it from `apps/core/src/surface/index.ts`.

4) Tests
   - Add a unit test in `apps/core/tests/surface/bridge/` using a fake `LilacBus` + fake `SurfaceAdapter`:
     - verifies that output events become `SurfaceOutputPart` pushes
     - verifies request routing via headers + request_id parsing
     - verifies finish on `evt.agent.output.response.text`

## Acceptance Criteria

- All request/workflow/output events can be correlated via `msg.headers.request_id`.
- Output events publish fails fast if `request_id` is missing.
- `cmd.request.message` carries `ModelMessage[]` and is no longer 1:1 with a single Discord message.
- The bus->adapter bridge can:
  - start on `evt.request.reply`
  - subscribe to `out.req.${request_id}` from `begin`
  - stream text/tool calls/attachments into Discord via `SurfaceOutputStream`
  - terminate cleanly on final response
  - avoid leaking relays via timeout
