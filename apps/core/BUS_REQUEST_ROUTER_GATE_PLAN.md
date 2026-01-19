# Bus Request Router Gate Plan (Active Mode Reply Filter)

This doc captures a proposed extension to the bus request router to support
Clawdbot-like "listen to all messages" behavior without replying to everything.

Scope: this is a router-only decision layer. It decides whether to publish
`cmd.request.message` for a given adapter message/batch.

IMPORTANT
- If a message/batch is "forwarded", the main agent MUST run and MUST output to the channel.
- If a message/batch is "skipped", the agent MUST NOT run at all.
- Proactive/heartbeat is out of scope.

## Current Behavior

Router implementation: `apps/core/src/surface/bridge/bus-request-router.ts`

- In `active` session mode, any message in the session triggers the router.
- If no active request exists, the router debounces and then publishes a new
  `cmd.request.message` with `queue: "prompt"`.
- If an active request exists, subsequent messages are published with
  `queue: "steer"` into the active request.

Today, the router always wakes the agent in active mode after debounce.

## Problem

In busy channels, active mode causes the bot to reply constantly.
We want to listen to all messages, but only wake the agent when a smaller/faster
"gate" model says the content warrants a reply.

Cost/failure policy:
- If the gate model fails or times out, the default must be SKIP (do not wake).

## Proposed Design

Add a gating hook that runs only when:
- session mode is `active`
- message is not a direct mention/reply-to-bot trigger
- there is no currently active request for the session (i.e. we'd be about to start a new request)

The gate runs on the debounced batch (not per-message), so that a short burst of
messages is classified once.

### Hook point

In `apps/core/src/surface/bridge/bus-request-router.ts`:
- `flushDebounce(sessionId)` is the point where the router mints the new
  request id and publishes `queue: "prompt"`.
- Add: `shouldForwardActiveBatch(...)` right before `publishRequest(...)`.

If gate decides `forward=false`, do not publish `cmd.request.message`.

### Gate I/O

Input:
- sessionId/channelId
- author ids + message text (for the debounced batch; include newest and/or full concatenation)
- metadata:
  - `mentionsBot=false`
  - `replyToBot=false`
  - `isDMBased=false`

Output:
- strict JSON: `{ "forward": true|false, "reason"?: string }`

### Model

Add a dedicated model config, separate from `models.main`:
- `models.routerGate.model` (same provider spec format as main, e.g. `openrouter/openai/gpt-4o-mini`)
- `models.routerGate.options` (provider options; optional)

Optional router config:
- `surface.discord.router.activeGate.enabled` (default: false)
- `surface.discord.router.activeGate.timeoutMs` (default: 1500-3000)

### Failure / safety policy

- If gate model call errors, returns non-JSON, or times out: SKIP.
- Never forward based on uncertainty.

### Testing

Add unit tests around router active mode:
- When gate returns forward=false, router publishes no `cmd.request.message`.
- When gate returns forward=true, router publishes a `prompt` and steers additional buffered messages.
- When gate throws/timeout, router skips.

## Follow-ups / open questions

- Prompt design: what qualifies as "needs reply" (mentions of important tokens, direct questions, etc.).
- Whether to run gate for DMs (likely no; DMs are always active).
- Observability: emit a debug event/log line when gate skips a batch.
