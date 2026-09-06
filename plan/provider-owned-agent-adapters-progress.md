# Agent adapter implementation evidence

Approved spec: [provider-owned-agent-adapters.md](provider-owned-agent-adapters.md).
Implementation base: `77bab9fe`. Branch: `feature/rework-agent-runner`.

## Stage 1

Baseline `bun run check` passed before implementation.

### Recovery audit

Existing accepted request-delivery rows retain complete control input until terminalization. The
agent-run checkpoint records canonical history together with `retainedRequestDeliveries`. Startup
replays accepted controls absent from that checkpoint and suppresses controls already represented in
it. `apps/core/tests/surface/bridge/agent-run-crash-recovery.test.ts` covers both cases in "reapplies an
accepted control and reconciles one already retained by a checkpoint", plus terminal-owner recovery
in "converges terminal owners after crashes before and during retained control terminalization".

No stored format amendment is required for the planned at-least-once recovery policy, provided the
integration obeys these conditions:

- Register the Core request-delivery-to-input-ID mapping before native delivery starts. The current
  `applyToRunningAgent` registers it after `agent.steer()` returns; synchronous commitment inside
  `steer()` would race that registration.
- Provider acceptance reserves input against fallback but does not make it canonical. Commit the
  input and predecessor output in order before including its delivery in a checkpoint.
- Reconcile uncertain delivery inside the logical run after retiring its provider attempt. Do not
  publish a terminal response first: `publishTerminalResponseText` initiates the WAL terminal marker,
  and startup can then terminalize the owner and its retained controls.
- Preserve accepted ownership through existing nonterminal recovery when execution cannot continue.
  A process crash may repeat work; no exactly-once guarantee is added.

### Compatibility inventory

The shared executor retains queue admission, preparation hooks, canonical history acceptance,
checkpoint requests, idle/interrupt policy, and normalized tool authority. Adapters own model calls,
tool scheduling, provider response chains, input transport, and provider execution retry safety.
Core continues to own surface publication, resource materialization, durable stores, model fallback
selection, and native lineage verification. The compatibility facade retains current constructor,
model setters, subscriptions, context preparation, tool controls, and recovery methods for Core/Mini.

Stages 2-5 must preserve this mapping while replacing execution. Stage-specific verification and
review results will be appended here without modifying the approved implementation checklist.

### Verification and review

Added 13 deterministic contract tests covering input snapshots, preparation, queue ownership,
canonical placement, checkpoints, stale attempts, terminal races, and controls during pending tools.
Focused tests and agent typecheck passed. Full repository checks passed before review.

The standards review found no blockers. The spec review found cross-event same-intent ordering was
not enforced. The fix rejects an out-of-order commit without changing history, ownership, or event
sequence; regression tests cover ordered retries and steering priority over follow-ups. The spec
re-review found no remaining Stage 1 blockers. The final repository recheck passed. Committed as
`e4edce09`.

## Stage 2

Extracted the provider-neutral executor, AI SDK execution adapter, shared tool host, and
compatibility facade. The facade preserves canonical message-array identity because compaction uses
it to detect concurrent history replacement. Adapter state reads return detached snapshots.

The shared ownership contract now supports prepared batches: buffered follow-ups can merge into one
steering message while every original delivery ID remains attributable to that canonical message.
Partial commitment or return of a merged batch is invalid. The originals remain available for recovery.

The extracted path passed the existing agent suite and the Core/Mini integration milestone. Core ran
2,950 tests and Mini runtime ran 466 tests without failures. Architecture registration tests passed.
New executor fixtures exposed uncertain submission settlement, subsequent native batch scheduling,
merged input attribution, and tool exclusivity defects. Each was fixed and covered by regression tests.

The standards review found no blockers. The spec review found that adapter state reads could mutate
canonical history and failed startup skipped disposal. The fixes detach nested state and put startup
inside the disposal/retirement path. Tests cover returned startup failures, Panic identity, retired host
access, replacement execution, and nested snapshot mutation. The spec re-review found no remaining
blockers. All 275 agent tests pass, including 14 neutral executor tests. The final `bun run check` passed.
Committed as `ce60cee7`.

## Stage 3

Rechecked AI SDK 7.0.93 and `@ai-sdk/openai` 4.0.60 distributions and the upstream Responses
implementation. None exposes `response.steer`. The native implementation uses the documented
WebSocket protocol and gates native steering to exactly `gpt-6-astra` with compatible execution settings.

The connection helper shares authentication, endpoint shaping, beta headers, and Bun socket setup
with the existing fetch path. Auto fallback is permitted only before submission and uses a separately
constructed SSE-only provider. The old fetch wrapper remains available for other consumers.

Native context preparation preserves declaration metadata and tool authority. A prepared successor
refreshes host context before submission without consuming the next step; the matching successor
begins that reserved step. An event acknowledgement waits for canonical projection and checkpoint
publication before the adapter makes a history-dependent host call.

Recovery uses the existing bounded retry policy after attempt retirement. There is no live recovery
scheduler after retry exhaustion. Unresolved accepted work must remain available for startup recovery,
with Core suppressing terminal WAL and delivery markers before failure publication in Stage 4.

The review loop fixed conversation-bound replay of stored assistant items, expansion children omitted
from tool continuations, and a second continuation sent after a late steering failure. Deterministic
tests cover each case, queued controls before successor creation, and ordering after definite return.
Cleanup preserves execution and cleanup Panic identity. A final terminal-race review found that input
arriving during socket close could fail successful completion; the executor now fences delivery at the
completed boundary and retains later input for a replacement after retirement.

Both standards and spec re-reviews found no remaining blockers. All 344 agent tests pass, including
54 native protocol/codec/socket tests. The final `bun run check` passed before the Stage 3 commit.
