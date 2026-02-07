# Bus Request Router (Discord -> cmd.request.message) Plan (v2)

This plan defines the "router" layer that turns adapter ingestion events into agent requests.

The router is responsible for:
- deciding whether a surface event should wake the agent
- choosing the correct request identity (`headers.request_id`)
- choosing the queueing behavior (`prompt` / `steer` / `followUp` / `interrupt`)
- batching/debouncing when needed

This version also covers the “active streaming reply” UX:
- replies to the currently active streaming bot message stay in the same request
- steer can re-anchor output mid-flight without deleting the in-flight message

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
  - `steer`: inject guidance into a currently running request
  - `followUp`: append a user follow-up to a currently running request
  - `interrupt`: reserved (not used by default)

- Support output re-anchoring while a request is running:
  - Router publishes `cmd.surface.output.reanchor`.
  - Relay freezes the current in-flight message and continues streaming in a new message.

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

Additionally, router consumes surface output events:
- `evt.surface.output.message.created` (published by the reply relay) to track which bot message ids are part of the active output chain.

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
- `activeBySession: Map<session_id, { requestId, activeOutputMessageIds }>`
- `sessionMode: Map<session_id, "mention" | "active">`
- debounce buffers for active mode when starting a new request:
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
  - reply to active output chain:
    - reply + @mention => `queue: "steer"` and request output reanchor to the user's reply message
    - reply only => `queue: "followUp"`
  - reply to other bot message => fork queued-behind `queue: "prompt"`
  - otherwise => `queue: "followUp"`
- Else:
  - publish `cmd.request.message` with `queue: "prompt"` and mint a new request_id

### Channel: mention-only mode

Mention-only sessions ignore non-triggers.

- Trigger events:
  - message mentions bot, OR
  - message replies to a bot-authored message
- If there is no active request:
  - publish `queue: "prompt"` (new request_id)
- If there is an active request:
  - If the message is a reply to the active output chain:
    - reply + @mention => `queue: "steer"` and request output reanchor to the user's reply message
    - reply only => `queue: "followUp"`
  - Otherwise (mention/reply trigger): publish a queued-behind `queue: "prompt"` (preserve reply threading)

### Channel: active mode

Active sessions treat the channel like a group chat.

- If there is no active request:
  - direct mention or reply-to-bot => bypass gate/debounce and start a new `queue: "prompt"`
  - otherwise => debounce a short burst and optionally run the gate
- If there is an active request:
  - reply to active output chain:
    - reply + @mention => `queue: "steer"` and request output reanchor to the user's reply message
    - reply only => `queue: "followUp"`
  - @mention (not a reply) => `queue: "steer"` and request output reanchor (inherit current reply-vs-top-level mode)
  - reply to other bot message => fork queued-behind `queue: "prompt"`
  - otherwise => `queue: "followUp"`

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

- DMs: user can message without mention; while running, replies to active output become followUp/steer; other replies fork prompts.
- Mention-only channels: only mention/reply triggers start; in-flight triggers queue behind unless replying to active output.
- Active channels: gate/debounce when idle; while running, followUps stream into the active request, and mentions can steer with reanchor.
- Router does not need direct Discord API access; it relies on adapter event payload + raw metadata.
