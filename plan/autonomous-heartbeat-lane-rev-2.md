# Autonomous Heartbeat Lane, Rev 2

## Summary

- Heartbeat is one internal, autonomous lane, not a set of configured jobs.
- Its durable state lives in `HEARTBEAT.md` plus a `heartbeat/inbox/` handoff directory.
- It wakes on a simple global cadence, but only when the rest of the system has been quiet for a configurable recent-activity window.
- It can still check things during soft quiet hours, but prompt instructions tell it not to surface low-priority findings then.
- Proactive surface messages are linked back to a concise heartbeat transcript so follow-up replies in Discord/GitHub can inherit context.

## Core behavior

### 1. One internal heartbeat session

Use a dedicated internal session:

- `session_id = "__heartbeat__"`
- `request_client = "unknown"`

This keeps heartbeat separate from human-facing sessions and prevents automatic relay output. If heartbeat wants to tell a human something, it must do that explicitly with tools such as `surface.messages.send`.

### 2. Canonical files

Use a fixed file layout under the existing prompt workspace:

- `data/prompts/HEARTBEAT.md`
  - canonical watchlist + todo board owned by heartbeat
- `data/prompts/heartbeat/inbox/`
  - append-only handoff notes from normal sessions
- `data/prompts/heartbeat/archive/`
  - processed inbox notes

Rules:

- `HEARTBEAT.md` is the source of truth for ongoing autonomous work.
- Other sessions should prefer writing inbox notes, not directly editing `HEARTBEAT.md`.
- Heartbeat is responsible for consolidating inbox notes into `HEARTBEAT.md` and archiving them.

### 3. Ordinary sessions hand work to heartbeat

When a user asks for recurring monitoring, future follow-up, or “keep an eye on this”, the current session should write an inbox note.

Implementation:

- Add a short global prompt overlay for ordinary runs when heartbeat is enabled:
  - recurring/future watch tasks should be handed to `data/prompts/heartbeat/inbox/`
  - `HEARTBEAT.md` remains heartbeat-owned
- V1 does not need a dedicated `heartbeat.*` tool; existing file tools are enough.

Inbox note format should be one file per note with lightweight frontmatter:

```md
---
createdAt: 2026-03-11T10:15:00.000Z
sourceSessionId: "123456789012345678"
sourceRequestId: "discord:123456789012345678:987654321"
kind: "watch"
priority: "normal"
---
User asked me to watch tech news every morning and tell them about major items.
```

## Wake policy

### 1. Replace `activeHours` with recent-activity quieting

Add global config under `surface.heartbeat`:

```yaml
surface:
  heartbeat:
    enabled: true
    cron: "*/30 * * * *"
    quietAfterActivityMs: 300000   # 5 minutes
    retryBusyMs: 60000
    softQuietHours:
      start: "23:00"
      end: "08:00"
      timezone: "Asia/Taipei"
```

Semantics:

- `every` controls how often heartbeat gets a chance to think.
- `quietAfterActivityMs` is the hard best-effort suppression window.
  - Heartbeat must not start if any non-heartbeat session is currently running.
  - Heartbeat must not start if any non-heartbeat session was active within the last `quietAfterActivityMs`.
- `retryBusyMs` is the backoff after a suppressed wake.
- `softQuietHours` is not enforcement. It only changes heartbeat instructions:
  - do not proactively surface low-priority findings during that window
  - still surface urgent/critical findings if warranted

### 2. Best-effort only at wake time

V1 behavior:

- Do not start heartbeat while the system is busy or recently busy.
- If a human request starts while heartbeat is already running, let heartbeat finish.
- Missed heartbeat ticks are coalesced into one later run.

## Runtime design

### 1. New service

Add `apps/core/src/heartbeat/heartbeat-service.ts`.

Responsibilities:

- schedule interval wakes
- track recent external activity from `evt.request.lifecycle.changed`
- mint internal heartbeat requests
- subscribe to heartbeat request lifecycle
- reload config opportunistically like other services

Start it after the agent runner is online. Stop it before shutdown drain begins.

### 2. Busy tracking

The service subscribes to `evt.request.lifecycle.changed` and keeps:

- `activeExternalRequestIds`
- `lastExternalActivityAt`

External means:

- not `session_id === "__heartbeat__"`
- not `origin.kind === "heartbeat"`

Wake rule:

- if `activeExternalRequestIds.size > 0`, suppress
- else if `Date.now() - lastExternalActivityAt < quietAfterActivityMs`, suppress
- else run heartbeat

### 3. Request shape

Heartbeat publishes a normal `cmd.request.message` with:

- `headers.request_id = "heartbeat:<timestamp>"`
- `headers.session_id = "__heartbeat__"`
- `headers.request_client = "unknown"`
- `data.queue = "prompt"`
- `data.runPolicy = "idle_only_global"`
- `data.origin = { kind: "heartbeat", reason: "interval" | "retry" }`

Prompt body tells heartbeat to:

- read `HEARTBEAT.md`
- ingest notes from `heartbeat/inbox/`
- update `HEARTBEAT.md`
- archive processed inbox files
- perform due checks/actions
- use tools if it wants to tell the human something
- respect `softQuietHours` for low-priority surfacing
- reply `HEARTBEAT_OK` if there is nothing worth retaining beyond file/tool work

## Runner changes

Update [`lilac-spec.ts`](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/event-bus/lilac-spec.ts):

- `RequestRunPolicy = "normal" | "idle_only_session" | "idle_only_global"`
- `RequestOrigin` gains `{ kind: "heartbeat"; reason: "interval" | "retry" }`

Update [`bus-agent-runner.ts`](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/bridge/bus-agent-runner.ts):

- If `runPolicy === "idle_only_global"` and any non-heartbeat session is running, cancel instead of queueing.
- Publish lifecycle:
  - `state: "cancelled"`
  - `detail: "idle_only_global_busy"`

Heartbeat transcript handling:

- Ack-only heartbeat runs (`HEARTBEAT_OK`) should not persist transcript.
- Non-ack heartbeat runs should persist a **trimmed handoff transcript**, not the full internal tool-heavy transcript.

Trimmed heartbeat transcript format:

- one assistant message containing the concise heartbeat summary
- no tool-call/tool-result chatter
- this is the artifact later used for context expansion when the user replies to a proactive message

## Soft quiet hours

`softQuietHours` only affects heartbeat instructions, not execution.

Heartbeat prompt should include a block like:

- Current local quiet-hours state: inside / outside
- If inside quiet hours:
  - do not proactively message for low-priority findings
  - you may still update `HEARTBEAT.md`, process inbox, and perform checks
  - you may still notify if something is urgent, critical, or time-sensitive

This keeps the model in control for “important enough to break quiet hours” cases.

## Surface handoff for follow-up conversations

### Problem

If heartbeat posts a proactive message through `surface.messages.send`, the next user reply should not be treated as an isolated fresh thread with no provenance.

### Existing capability we should reuse

Request composition already knows how to expand a bot message by looking up the transcript attached to that surface message. That means we do not need hidden Discord metadata if we can link tool-sent messages back to a stored transcript.

### Required change

When `surface.messages.send` is called from a request context with `ctx.requestId`, record the returned message ref in the transcript store:

- extend the `Surface` tool so it receives `transcriptStore`
- after a successful send, call `transcriptStore.linkSurfaceMessagesToRequest({ requestId: ctx.requestId, created: [ref], last: ref })`

Wire this through:

- [`default-tools.ts`](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tool-server/default-tools.ts)
- [`surface.ts`](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tool-server/tools/surface.ts)

### Important refinement

For heartbeat-origin requests, the transcript linked to that proactive message must be concise. Otherwise a future reply may inherit noisy internal maintenance/tool context.

So:

- persist only the trimmed heartbeat summary for heartbeat requests
- link proactive sent messages to that trimmed request transcript

Result:

1. heartbeat finds something interesting
2. heartbeat sends a Discord message with `surface.messages.send`
3. the tool links that Discord message ref to the heartbeat request id
4. the heartbeat request has a concise persisted summary transcript
5. when the user replies, request composition expands that bot message into the heartbeat summary instead of a cold start

This works both for explicit replies and for recent-message expansion in active-mode channels, as long as the proactive message is still in the recent context window.

## Prompt overlays

### 1. Ordinary sessions

When heartbeat is enabled, add a small overlay for all non-heartbeat runs:

- recurring/future-watch requests belong in `heartbeat/inbox/`
- do not directly take ownership of `HEARTBEAT.md`
- include source session/request in inbox notes

### 2. Heartbeat session

Heartbeat runs get a stronger overlay:

- you own `HEARTBEAT.md`
- you triage `heartbeat/inbox/`
- archive processed notes
- prefer durable file state over relying on transcript memory
- use tools for outward communication
- obey `softQuietHours` for low-priority outreach

## Public APIs / interfaces / types

### Config

Add to [`core-config.ts`](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/utils/core-config.ts):

```ts
surface.heartbeat: {
  enabled: boolean;
  every: string;
  quietAfterActivityMs: number;
  retryBusyMs: number;
  softQuietHours?: {
    start: string;
    end: string;
    timezone?: string;
  };
}
```

Update [`core-config.example.yaml`](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/utils/config-templates/core-config.example.yaml) accordingly.

### Event bus

Extend [`lilac-spec.ts`](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/event-bus/lilac-spec.ts):

- `CmdRequestMessageData.runPolicy`
- `CmdRequestMessageData.origin`

### Tool server

Extend the `Surface` tool wiring to accept `transcriptStore` so tool-sent messages can be linked back to the originating request transcript.

## Test cases and scenarios

- heartbeat wakes on the configured `cron` schedule when no external session is active or recently active
- heartbeat is suppressed while any non-heartbeat request is running
- heartbeat is suppressed for `quietAfterActivityMs` after the last external activity
- suppressed wakes retry after `retryBusyMs`
- soft quiet hours do not block execution, only change instructions
- ordinary sessions create inbox notes for recurring/future-watch asks
- heartbeat ingests inbox notes, updates `HEARTBEAT.md`, and archives inbox files
- ack-only heartbeat runs do not persist transcript
- non-ack heartbeat runs persist trimmed summary transcript only
- `surface.messages.send` links sent message refs to the originating request id
- a user reply to a proactive heartbeat message expands into the trimmed heartbeat summary
- active-mode follow-up after a recent proactive heartbeat message also gets the trimmed summary, not a cold start
- non-heartbeat `surface.messages.send` linking also works and does not regress existing behavior

## Assumptions and defaults

- There is exactly one heartbeat lane in v1.
- `HEARTBEAT.md` is canonical; inbox files are handoff-only.
- Heartbeat cadence is global.
- Per-watch scheduling like “every morning” is encoded by the agent in `HEARTBEAT.md`, interpreted during heartbeat turns.
- The hard suppression mechanism is recent-activity quieting, not `activeHours`.
- Quiet hours are soft and instructional, not enforcement.
- We do not add a dedicated `heartbeat.*` tool in v1.
- We do not add hidden surface metadata; transcript linking is the handoff mechanism.
