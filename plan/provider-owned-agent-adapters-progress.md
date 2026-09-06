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
re-review found no remaining Stage 1 blockers. Final repository recheck is required before commit.
