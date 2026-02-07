# Bus Request Router Gate Plan (Active Mode Gate + Multi-Turn)

This doc captures the finalized behavior and implementation plan for a router-only
"gate" in active mode.

Scope: router-only.
- It decides whether to publish `cmd.request.message` for a given session message/batch.
- If a message/batch is forwarded, the agent MUST run and output to the channel.
- If skipped, the agent MUST NOT run at all.

Non-scope:
- Proactive/heartbeat scheduling is out of scope.
  - Heartbeat *content* can still be treated as "should reply" by the gate model.

## Repo Touch Points

- Router: `apps/core/src/surface/bridge/bus-request-router.ts`
- Prompt composition: `apps/core/src/surface/bridge/request-composition.ts`
- Config schema: `packages/utils/core-config.ts`
- Config template (seeded into `DATA_DIR/core-config.yaml` on first run): `packages/utils/config-templates/core-config.example.yaml`
- Tests: `apps/core/tests/surface/bridge/bus-request-router.test.ts`

## Definitions

- "DM": Discord channel where adapter sets `raw.discord.isDMBased=true`.
- "Direct mention": adapter sets `raw.discord.mentionsBot=true`.
- "Reply-to-bot": adapter sets `raw.discord.replyToBot=true`.
- "Indirect mention": best-effort case-insensitive substring match of `surface.discord.botName` in message text.

## Current Behavior (Before This Change)

Router implementation: `apps/core/src/surface/bridge/bus-request-router.ts`

- In active mode:
  - If no active request exists: debounce, then publish a new `cmd.request.message` (`queue: "prompt"`).
  - If an active request exists: subsequent messages publish into the active request as `queue: "steer"`.

## Problems This Change Solves

- In busy channels, active mode causes constant replies.
- We want to listen to all messages but only start a new request when a smaller/faster gate model says it needs a reply.

Safety policy:
- If the gate model fails, times out, or returns invalid output: SKIP (do not start a request).

## Finalized Routing Semantics

### DM (No Gate)

DMs are never gated.

- If there is an active request for the session:
  - Replies-to-bot (`replyToBot=true`) fork into a new request and publish as `queue: "prompt"` (queued behind).
  - All other new messages publish to the active request as `queue: "followUp"`.
- If there is no active request:
  - Start a new request (no gate) and publish `queue: "prompt"`.

### Active Channel (Gate + Multi-Turn)

Active channels are gated only when starting a new request.

- If there is an active request for the session:
  - Replies-to-bot (`replyToBot=true`) fork into a new request and publish as `queue: "prompt"`.
    - The agent output will reply to the user's reply message.
    - The runner will queue this request behind the currently running request.
  - All other new messages (including mentions) publish to the active request as `queue: "followUp"`.
  - No gate is evaluated while a request is running.

- If there is no active request:
  - Direct mention or reply-to-bot: bypass gate and start a new request immediately.
    - Also: discard any pending debounce buffer for that session.
  - Otherwise: debounce a short burst and run the gate once on the debounced batch.
    - If gate returns forward=true: start a new request.
    - If gate returns forward=false: skip.

### Prompt Context Size (Active Channel)

When starting a new request in an active channel, the agent prompt must use the latest 8 messages.
- If the request was started by a mention/reply trigger, the trigger message must be included.
- For gate-forwarded requests (no mention/reply), the agent reply must NOT reply-to a specific message.

Note:
- For in-flight messages while a request is running, we do NOT rebuild the latest-8 prompt; they are appended as follow-ups.

### Users Must Stay Separated

(Phase 1 update)

Active channels are treated as group chats. While a request is running, any user may send follow-ups that are injected via `queue: "followUp"`.
Replies-to-bot still fork into queued-behind prompts.

## Gate Hook

Hook point: `flushDebounce(sessionId)` right before publishing a new `queue: "prompt"` request.

The gate runs on the debounced batch.

Gate runs only when:
- session mode is active channel mode (not DM)
- there is no active request for the session
- the debounced batch contains no direct mention and no reply-to-bot triggers
- `surface.router.activeGate.enabled=true`

If gate decides `forward=false`: do not publish `cmd.request.message`.

## Gate I/O

Input:
- sessionId/channelId
- debounced batch messages (author ids + message text)
- metadata:
  - `mentionsBot=false`
  - `replyToBot=false`
  - `isDMBased=false`
  - `indirectMention=true|false`

Output:
- strict JSON: `{ "forward": true|false, "reason"?: string }`

## Model Config

Models are categorized by feature; gate uses `models.fast`.

Config:
- `models.fast.model` (provider/model spec, e.g. `openrouter/openai/gpt-4o-mini`)
- `models.fast.options` (provider options; optional)

Router config:
- `surface.router.activeGate.enabled` (default: false)
- `surface.router.sessionModes.<sessionId>.gate` (optional override for active channels)
- `surface.router.activeGate.timeoutMs` (default: ~2500; suggested range 1500-3000)

## Failure / Safety Policy

- If gate model call errors, returns non-JSON, returns invalid JSON shape, or times out: SKIP.
- Never forward based on uncertainty.

## Reply-To Semantics

- Mention/reply-triggered requests use `replyTo` semantics (request id encodes the trigger message id).
- Gate-forwarded requests must NOT set replyTo (request id must not be parseable as a reply anchor).

## Logging / Observability

Emit a debug/info log line when:
- gate skips a batch (forward=false)
- gate fails/timeouts (skipped)

Do not log full message contents.

## Testing

Add unit tests around router active mode:
- Gate forward=false => router publishes no `cmd.request.message`.
- Gate forward=true => router publishes a single `prompt` (no extra steers from the buffer).
- Gate throws/timeout/invalid output => router skips.
- Active channel with running request => `replyToBot=true` publishes a queued-behind `prompt`; otherwise publishes `followUp` (any user).
- DM behavior => while running, `replyToBot=true` publishes a queued-behind `prompt`; otherwise publishes `followUp`.

## Streaming Note

Multi-turn follow-ups are compatible with streaming because follow-ups are injected between turns.
Avoid using `interrupt` for this feature because the relay layer does not support output reset semantics.
