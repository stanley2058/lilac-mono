# Bus Request Router (Discord -> cmd.request.message) Plan (v1)

This plan defines the "router" layer that turns adapter ingestion events into agent requests.

The router is responsible for:
- deciding whether a surface event should wake the agent
- choosing the correct request identity (`headers.request_id`)
- choosing the queueing behavior (`prompt` / `steer` / `followUp` / `interrupt`)
- batching/debouncing when needed

The agent-runner remains the authoritative source of "which sessions have a running agent" (see `BUS_AGENT_RUNNER_PLAN.md`).

## Goals

- Consume `evt.adapter.message.created` events and publish `cmd.request.message` with the envelope headers:
  - `headers.request_id`
  - `headers.session_id`
  - `headers.request_client: "discord"`
- Support request initiation modes:
  - Direct request:
    - Mention the bot, or reply to a bot message
    - In DMs, mention/reply are not required
  - Polling mode is out of scope for this plan
- Support queueing behaviors:
  - `prompt`: start a new request (new `request_id`)
  - `steer`: add messages to the currently running request for that session
  - `followUp`: only in mention-only mode and only for additional mentions by the same user
  - `interrupt`: reserved (not used by default in this stage)

## Non-goals

- Running the agent (handled by agent-runner).
- Tool execution.
- Workflow orchestration.

## Inputs / Outputs

### Inputs

- `evt.adapter.message.created` events.
  - For Discord, we need enough metadata to know:
    - DM vs channel
    - whether the message mentions the bot
    - whether the message is a reply to a bot message

Recommendation:
- Keep `EvtAdapterMessageCreatedData.text` as the normalized plain text.
- Add structured trigger metadata inside `raw` (platform-specific, best-effort):
  - `raw.discord.isDMBased: boolean`
  - `raw.discord.mentionsBot: boolean`
  - `raw.discord.replyToBot: boolean`
  - `raw.discord.replyToMessageId?: string`
  - `raw.discord.guildId?: string`
  - `raw.discord.parentChannelId?: string`

This keeps the bus contract stable while allowing router logic without needing direct Discord API access.

### Outputs

- `cmd.request.message`
  - topic: `cmd.request`
  - headers: `{ request_id, session_id, request_client: "discord" }`
  - data:
    - `queue: "prompt" | "steer" | "followUp" | "interrupt"`
    - `messages: ModelMessage[]`
    - `raw?: unknown`

## Router state model

The router keeps a lightweight local state cache, but treats the agent-runner as authoritative.

State tracked:
- `activeRequestBySession: Map<session_id, request_id>`
- `activeUserBySession: Map<session_id, user_id>` (for mention-only mode semantics)
- `sessionMode: Map<session_id, "mentionOnly" | "activeObserve">`
- `observeDebounceBuffers` for activeObserve mode:
  - `buffered: Array<{ messageId, userId, ts, text, ... }>`
  - `timer` (debounce)

How the router keeps this in sync with agent-runner:
- Subscribe `evt.request.lifecycle.changed`.
  - When state becomes `running`/`streaming`, treat the request as active for `headers.session_id`.
  - When state becomes `done`/`failed`/`cancelled`, clear active mapping.

This makes agent-runner authoritative without any direct RPC.

## Request identity

The router must mint `headers.request_id`.

Recommended format:

```
discord:<session_id>:<root_message_id>
```

Where `root_message_id` is:
- for a mention-triggered request: the mention message id
- for a reply-triggered request: the reply message id (still replies to the user message; output relay threads via request_id parsing)

Note: this does not force a 1:1 between a single Discord message and a request; it just picks a stable anchor.

## Routing rules (high signal)

### DM behavior

- Trigger: any `evt.adapter.message.created` in a DM session.
- If there is an active request for the session:
  - publish `cmd.request.message` with `queue: "steer"`
- Else:
  - publish `cmd.request.message` with `queue: "prompt"` and mint a new request_id

### Channel: mention-only mode

- Trigger events:
  - message mentions bot, OR
  - message replies to a bot-authored message
- If there is no active request:
  - publish `queue: "prompt"` (new request_id)
  - set `activeUserId = message.author`
- If there is an active request:
  - Non-mention messages (same user, grouped by merge rules) => `queue: "steer"`
  - Additional mentions:
    - If from the same user: `queue: "followUp"` to the active request_id
    - If from other users: `queue: "prompt"` (new request_id)

This matches:
- mention implies "new request" except when same-user mention becomes followUp

### Channel: active observe mode

- Trigger: any message in the session
- If there is no active request:
  - buffer messages for debounce interval
  - on debounce fire: publish one `queue: "prompt"` with the buffered batch and mint request_id from the first buffered message
- If there is an active request:
  - publish `queue: "steer"` for each subsequent message (or for grouped batches)

## Message grouping rules

The router should reuse the existing Discord merge window logic:
- same author
- within `DISCORD_MERGE_WINDOW_MS`

Grouping impacts which messages are sent in each bus command:
- `prompt`: send the whole batch (oldest -> newest)
- `steer`: send a small batch (e.g. grouped messages)
- `followUp`: send the mention-triggered message only, unless you decide to group back-to-back mentions by same user

Important: keep `ModelMessage[]` order stable and deterministic.

## Failure handling

- If required trigger metadata is missing (`raw.discord.*`), default to conservative behavior:
  - in channels: do not trigger
  - in DMs: still trigger
- If router restarts, it will rebuild `activeRequestBySession` from new `evt.request.lifecycle.changed` events.

## Acceptance Criteria

- DMs: user can message without mention, agent starts, subsequent messages during streaming become `steer`.
- Mention-only channels: only mention/reply triggers start; same-user mentions during an active run become `followUp`.
- Active observe: messages are debounced into one `prompt`; subsequent messages become `steer`.
- Router does not need direct Discord API access; it relies on adapter event payload + raw metadata.
