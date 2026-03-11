# Deferred Subagents As The First Async-Agent Primitive

## Summary

Use the existing subagent request path and bus agent runner, but change `subagent_delegate` so it supports **deferred delegation** as a first-class mode.

The parent request remains open while deferred children run. When a child finishes, the runner injects a synthetic tool-call/tool-result pair into the live parent transcript at the next safe boundary and continues the parent run automatically.

Guidance for when to use deferred vs sync should live **in the tool description and schema contract**, not in `TOOLS.md`.

## Proposed behavior

1. The parent model calls `subagent_delegate`.
2. `mode` defaults to `"deferred"`.
3. In deferred mode, the tool immediately starts the child request and returns an accepted handle.
4. The parent keeps working.
5. The runner tracks outstanding deferred children for the active parent request.
6. When a child completes, the runner buffers a synthetic completion payload.
7. At the next safe idle boundary, the runner appends a synthetic assistant tool-call plus tool-result pair and continues the parent run.
8. The parent request does not resolve until all deferred children are terminal and all completed child results have been injected.
9. If the parent is cancelled, all outstanding children are cancelled too.

## Tool contract

### `subagent_delegate` input

Add:
- `mode?: "deferred" | "sync"` with default `"deferred"`
- `blockingReason?: string`

Validation:
- `blockingReason` is required when `mode === "sync"`
- `blockingReason` must be omitted or ignored when `mode === "deferred"`

### `subagent_delegate` output

Use a discriminated union:

- Deferred accepted:
  - `{ ok: true, mode: "deferred", status: "accepted", profile, childRequestId, childSessionId, timeoutMs }`
- Sync terminal:
  - current resolved/failed/cancelled/timeout shape, plus `mode: "sync"`

## Tool description guidance

Put the decision rule directly into the `subagent_delegate` description:

- Deferred is the default and should be used for parallelizable work.
- Sync should be used only when the child result is immediately required before any meaningful next step.
- If the agent can continue with other useful work first, it should choose deferred.
- Deferred results are automatically inserted later as a tool result; the agent does not need to poll or manually join.

Include examples in the description:

- Prefer deferred:
  - repository exploration
  - independent evidence gathering
  - parallel investigations
  - work whose result can be incorporated later

- Prefer sync:
  - the child answer determines the next edit/decision
  - the child result is needed before responding
  - the child is doing the one blocking computation

## Runtime design

- Keep child execution on the existing `cmd.request.message` path.
- Do not use workflows for v1.
- Do not introduce a separate async-agent service for v1.
- Add runner-local deferred child tracking for each active parent request:
  - `parentToolCallId`
  - `childRequestId`
  - `childSessionId`
  - `profile`
  - `mode`
  - `timeoutMs`
  - terminal status
  - `finalText`
  - `detail`
  - timestamps
- Subscribe to child lifecycle/output exactly like the current sync implementation, but do not block the tool call in deferred mode.
- Mirror child progress back to the parent tool status stream.

## Tool status stream changes

Extend tool-call status beyond `"start" | "end"`:

- `"start"` for initial launch
- `"update"` for deferred child progress while parent continues
- `"end"` only for final settlement or cancellation of the parent-visible delegated task

Use `"update"` to show:
- child tool activity summary
- child completion/failure/timeout state before transcript injection if useful

## Parent transcript injection

When a deferred child reaches terminal state, inject:

1. Assistant message containing a synthetic tool call
2. Tool message containing the synthetic tool result

Recommended synthetic tool name:
- `subagent_result`

Tool result payload should include:
- `ok`
- `status`
- `profile`
- `childRequestId`
- `childSessionId`
- `durationMs`
- `finalText`
- `detail?`

This preserves valid tool-call/result transcript structure for the model.

## Runner changes

### Bus agent runner

Add a deferred-subagent manager per active parent run.

Responsibilities:
- register deferred children launched by the tool
- watch child lifecycle and output topics
- buffer completed child results
- trigger parent continuation when new child results are ready
- keep the parent request open while deferred children are outstanding
- cascade cancellation to children
- include deferred child state in graceful restart snapshots

### Agent control surface

Add an idle-only API in `AiSdkPiAgent`:
- `appendMessages(messages: ModelMessage[])`

This allows the runner to inject synthetic completion pairs safely without `replaceMessages()`.

Runner loop behavior:
- after `agent.waitForIdle()`, if completions are buffered, inject them and call `continue()`
- if no completions are buffered but deferred children are still outstanding, keep the request alive and wait
- when user follow-ups arrive during this waiting state, resume the same parent request

## Observability

When `mode: "sync"` is used, record `blockingReason` in logs.

Purpose:
- understand whether models are overusing sync
- tune tool description wording later
- avoid hidden prompt-only policy

No runtime auto-rewrite of sync to deferred in v1.

## Recovery / restart

Extend graceful restart snapshots to persist:
- outstanding deferred child handles
- buffered child completions not yet injected
- parent-visible delegated task state

On restore:
- re-subscribe to child lifecycle/output
- continue waiting for outstanding children
- inject any already-buffered completions before parent resolution

## Tests and acceptance

- Deferred mode returns immediately and parent continues.
- Omitted `mode` behaves as deferred.
- Sync mode requires `blockingReason`.
- Deferred child completion is injected as a synthetic tool-call/result pair and parent continues automatically.
- Multiple deferred children complete out of order and are injected in completion order.
- Parent request remains unresolved while deferred children are outstanding.
- User follow-up during waiting resumes the same parent request correctly.
- Parent cancellation cancels all outstanding children.
- Child timeout/failure becomes a failed synthetic tool result, not lost output.
- Graceful restart restores outstanding deferred children and buffered completions.
- Existing sync behavior remains intact when `mode: "sync"` is used.

## Assumptions and defaults

- “Async agent” means deferred subagents.
- Parent should stay open, not resume later.
- Deferred is the default mode.
- Tool-level description is the primary policy surface for choosing deferred vs sync.
- `TOOLS.md` is not part of this design.
