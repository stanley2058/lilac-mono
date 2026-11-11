# Agent orchestration control

Status: approved and implemented on 2026-11-11, uncommitted. See "Implementation status" at the end
for evidence, deviations, and residuals. It replaces the earlier thread-centric draft, which proposed
a new `ThreadOrchestrator` module and new native child/task records.

## Goal

Let a primary agent read, message, and stop its subagents, its workflow runs, and other native
threads it is allowed to use. Thread control exists only where the caller's surface provides it,
which today is the native surface. Discord gets no cross-thread control.

## Settled decisions

1. **Extend the workflow engine.** Subagents keep running as one-agent workflow runs. No new
   orchestration subsystem, no new native child or task records, no migration of old children.
2. **One Level 1 tool named `orchestrate`.** `read`, `send`, and `interrupt` are actions on it,
   following the `job` tool pattern. Discovery stays in Level 2 (`surface.sessions.list`,
   `workflow.run.list`), because ids normally come from a delegate result or the user.
3. **One id parameter for every target.** The tool accepts a subagent run id, a scripted workflow
   run id, or a native thread id.
4. **Workflows are read and interrupt only.** `send` rejects a scripted workflow id.
5. **`subagent_delegate` only creates; `send` only continues.** The optional `sessionName` input is
   removed. Following up with an existing child goes through `send`.
6. **Humans cannot message subagents.** The subagent panel stays view-only, as in T3.
7. **Activity view.** `read` offers `view: "messages"` (default) and `view: "activity"`, modeled on
   T3's `t3_thread_read`. Activity shows the calling agent the target's tool calls and output.
8. **No model or reasoning on `send`.** T3's agent tools cannot switch a thread's model either; a
   human can still change it in the UI. Thread sends use the thread's current model. Subagent
   follow-ups reuse the previous run's model and reasoning.
9. **Creation stays explicit.** `profile` is a permission grant and stays a decision made at launch.
   A mistyped `send` target returns an error. It never spawns an agent.
10. **`send` is fire and forget.** There is no wait. Subagent results still resume the parent
    through `subagent_result`. Waiting on another thread is out of scope; if it is ever needed,
    `job` should cover it.
11. **Thread control is a surface capability.** The tool never branches on platform. Thread targets
    work when the caller's surface runtime provides a thread-control port.
12. **Thread sends always post.** A thread `send` always delivers the message to the target
    thread. The deployment `crossThreadSend.triggerRun` setting decides whether it also runs the
    agent, the same split `surface.messages.send` uses.
13. **Subagents can read every target kind.** Sending and interrupting are limited to their own
    children.
14. **A lost `auto` steer becomes a follow-up.** If the target run ends before an `auto` steer
    lands, the message becomes a follow-up run. An explicit `steer` reports `target-ended`.
15. **Sender provenance is deferred.** Showing the sending thread and run inside the target thread
    is a residual.

## T3 reference

Observed in the T3 checkout at `339179f50a` (`/home/stanley/Sandbox/t3code`). Source was read; tests
were not run.

| T3 tool | Behavior | Lilac counterpart |
|---|---|---|
| `delegate_task` | Creates an app-owned child thread and task. Model set via `target`. | `subagent_delegate` |
| `t3_thread_send` | `threadId`, `message`, `mode: auto \| queue \| steer \| restart`, `clientRequestId`. | `orchestrate` `send`, without `restart` |
| `t3_thread_configure` | Rewrites a thread's stored provider, model, options. | Not exposed to agents |
| `t3_thread_read` | Paginated `messages` or `activity`, per-item char cap, text offset continuation. | `orchestrate` `read` |
| `t3_thread_wait` | Pins the run at call time; timeout leaves work running. | Not adopted (decision 10) |
| `t3_thread_interrupt`, `task_cancel` | Stop a run; cancel a task and its delegated descendants. | `orchestrate` `interrupt` |

Two T3 behaviors are deliberately not copied. `task_cancel` on an old terminal task can stop a newer
follow-up in the same child thread; `interrupt` addresses one run id, so it cannot. T3's thread read
acknowledges child results as a side effect; `read` never mutates, and automatic `subagent_result`
delivery stays unchanged.

## What Lilac already has

| Need | Existing mechanism |
|---|---|
| Stable child conversation | `sub:<parent-session>:named:<sessionName>` (`apps/core/src/tools/subagent.ts:552`) |
| One id per assignment | `wfrun:subagent:<uuid>` (`apps/core/src/workflow/workflow-subagent-dispatcher.ts:309`) |
| Child model and reasoning per run | Agent operation policy JSON stores requested `model`, `reasoning`, and `resolvedModelRequest` (`apps/core/src/workflow/workflow-operation-policy.ts:8`) |
| Completion delivery and recovery | `live_parent` completion target, live-parent bridge, deferred `subagent_result` |
| Run status and cancel | `workflow.run.get`, `workflow.run.cancel` (`apps/core/src/tool-server/tools/programmatic-workflow.ts:584`, `:597`) |
| Child transcript for display | `NativeSubagents` and `subagentMessages` (`apps/core/src/surface/native/subagents.ts:54`) |
| Tool activity records | Native display parts with label, state, output, exit code (`apps/core/src/surface/native/output-projection.ts:167`) |
| Post, start, or queue in another native thread | Native adapter `post()`: posts only, unless `shouldTriggerRun()` allows a run, then authorizes edit access and calls `acceptSurfaceInput` with `prompt` or `followup` (`apps/core/src/surface/native/adapter.ts:555`) |
| Steer with stale-target fencing (native) | Steer carries `runId`; a mismatch at admission settles the input as `target-ended` (`apps/core/src/surface/native/store.ts:2141`) |
| Steer with stale-target fencing (runner) | `requiresActive` controls that miss the active request are dropped and their delivery marked `abandoned` (`apps/core/src/surface/bridge/bus-agent-runner.ts:2307`) |
| Optional per-surface ports | `SurfaceRuntimeDescriptor.createQuestion`, `createWorkflowProgress` (`apps/core/src/surface/runtime-descriptor.ts:302`) |
| Per-run tool gating | Plugin `isEnabled` on request context and run profile (`apps/core/src/plugins/builtin/job.ts:14`) |

Native thread ids match `identitySchema` (`[A-Za-z0-9_-]+`, `packages/client-protocol/src/replay.ts:11`),
so they cannot contain `:`. A `wfrun:` prefix identifies workflow runs without ambiguity, and
`wfrun:subagent:` identifies subagent runs.

## Design

### The tool

```ts
{ action: "read", id, view?: "messages" | "activity", after?: cursor, limit?, maxCharsPerItem? }
{ action: "send", id, message, mode?: "auto" | "queue" | "steer", commandId? }
{ action: "interrupt", id, runId? }
```

`commandId` is an optional idempotency key. Thread targets reuse the native input receipt; subagent
targets derive a deterministic delivery id from it. The tool builds its action enum per run, so a
caller without send or interrupt authority sees only `read` (see Authority).

### Thread-control port

Add an optional port to `SurfaceRuntimeDescriptor`, next to `createQuestion`:

```ts
readonly createThreadControl?: (guardedAdapter: SurfaceAdapter) => SurfaceThreadControlPort<P>;
```

The port resolves a thread id and implements read, send, and interrupt for that surface's threads,
using the caller's principal. The native runtime provides it. Discord and GitHub do not. The tool
resolves the port from the surface that originated the request, which for a subagent is the root
request's surface, not the child's `request_client: "unknown"`. With no port, a thread id returns
"thread control is unavailable on this surface". This is a private Core interface; it changes no
wire, stored, or plugin contract.

### Target behavior

| Target | `read` | `send` | `interrupt` |
|---|---|---|---|
| Subagent (`wfrun:subagent:…`) | Run state, result if terminal, child transcript as messages or activity | Steer the run if it is active; otherwise start a follow-up run on the same child session | Cancel that exact run |
| Native thread (via port) | Messages or activity, active run id | Post, then start, queue, or steer when cross-thread runs are enabled | Cancel the active run, or the given `runId` if it still matches |
| Scripted workflow (`wfrun:…`) | Run state, operations, result | Rejected | Cancel the run |

A subagent id names one run. `send` treats it as the conversation that run belongs to and returns the
run id that received the message, which is a new id for a follow-up. `interrupt` treats it as that
exact run, so a stale stop cannot hit a newer assignment.

### Send semantics

`send` returns once the message is accepted. It does not wait for the target to respond.

**Thread targets.** The message is always posted to the target thread. When
`crossThreadSend.triggerRun` is off, nothing else happens and the result is `posted`. When it is on:

- Idle target: start a run with the thread's current model (`started`).
- Busy, `queue`: queue a follow-up behind the active run (`queued`).
- Busy, `steer`: steer the active run (`steered`). If the run ends before admission, the input
  settles as `target-ended`, visible through `read`.
- Busy, `auto`: steer. If the run ends before admission, the message is admitted as a follow-up
  instead (decision 14).

Sending to the caller's own thread is rejected. The adapter already treats it as a plain post.

**Subagent targets.** The cross-thread setting does not apply; the child belongs to the caller.

- Active run: publish a `requiresActive` steer to the run's child request (`steered`). A dropped
  `auto` steer becomes a follow-up, as for threads.
- Ended run: dispatch a new run through `WorkflowSubagentDispatcher` with the same `sessionName`,
  the stored `profile` and `depth`, and the previous agent operation's requested `model` and
  `reasoning`. The new run gets a `live_parent` completion target bound to the caller's current
  request and tool call. Follow-ups are always deferred and report back as `subagent_result`
  (`started`).

`restart` (interrupt, then send) is out of scope.

### Read semantics

`read` is bounded and never mutates. It returns a cursor, `hasMore`, and per-item truncation markers.
`view: "activity"` projects tool calls from the records the native panel already renders. Output is
capped at `OUTPUT_LIMIT` (4,096 bytes, `output-projection.ts:25`); full output lives in tool-result
artifacts, which expire. Reading a terminal subagent result does not acknowledge delivery, so the
automatic `subagent_result` still arrives.

### `subagent_delegate` changes

- Remove the `sessionName` input (`packages/coding-tools/src/schemas.ts:332`). Name generation becomes
  unconditional. Stored records, the output, and the panel keep `sessionName`.
- Keep `workflowRunId` in the output. It is the id `orchestrate` accepts.
- Rewrite the description. Keep the deferred `NO_REPLY` parking, which is how results resume the
  parent. Drop "Do not call tools only to wait or check the subagent status", and describe `read`,
  `send`, and `interrupt` on the returned run id.

### Authority and gating

The plugin enables `orchestrate` on native and Discord requests, for primary runs and subagents.
It stays off for heartbeat sessions and the GitHub surface. Caller identity comes from request
context, never from tool arguments.

| Caller | `read` | `send`, `interrupt` |
|---|---|---|
| Primary | Every target kind | Every target kind |
| Subagent | Every target kind | Its own children only |

Per-target rules:

- **Subagent targets.** Send and interrupt require the run's `live_parent` completion target to name
  the caller's session as `parentSessionId`. Read follows the same principal's access to the parent
  conversation.
- **Workflow targets.** The existing `workflow.run.*` project-scope rule.
- **Thread targets.** Enforced by the port. Read requires the principal's native read access; send
  and interrupt require edit access, as `authorizeThread(…, true)` already checks. DMs stay
  starter-only.

Sending to a thread does not make the sender its parent and does not subscribe the sender to its
results.

## Implementation sequence

Each phase ends with focused tests and the typecheck for every changed workspace. Run architecture
checks where tool boundaries change, and `bun run check` before any commit.

### 1. Tool skeleton, port, `read`, and `interrupt`

Add the plugin, the per-run action enum, id resolution, and per-target authorization. Add
`SurfaceThreadControlPort` with the native implementation. Implement `read` for all three target
kinds and `interrupt` through the `workflow.run.cancel` logic and the port. Share store calls with
the Level 2 callables rather than calling them over HTTP.

Acceptance: a native primary reads a subagent's messages and activity while it runs, reads a scripted
workflow's operations, reads an authorized native thread, and stops each one. Interrupting a finished
subagent run does not affect a newer run in the same child session. A subagent can read but cannot
interrupt a sibling. A Discord primary gets "thread control is unavailable on this surface" for a
thread id and works normally for its own subagent ids. Heartbeat runs do not see the tool. Another
user's DM is unreadable.

### 2. `send` to native threads

Post through the port, then use native adapter admission for start and queue when cross-thread runs
are enabled. Add steer through native input admission with the active `runId`, and the `auto`
fallback from `target-ended` to a follow-up.

Acceptance: with the setting off, send posts and starts nothing. With it on, send starts an idle
thread on its current model, steers a busy one, queues with `queue`, and turns a lost `auto` steer
into a follow-up. An explicit `steer` that loses the race shows `target-ended` in `read`. A
read-only target rejects send. A repeated `commandId` returns the original receipt. Human RPC
behavior is unchanged.

### 3. `send` to subagents and the `subagent_delegate` cutover

Add steer to an active child run and follow-up dispatch for an ended one, reading model and
reasoning from the previous agent operation. Remove `sessionName` from the delegate input and update
its description.

Acceptance: the end-to-end case below passes. A follow-up runs on the previous run's model, produces
a new run id and a new `subagent_result`, and leaves the earlier result intact. A mistyped id returns
an error and starts nothing. Discord can continue a child through `send`. Discord delegation, output,
and cancellation suites pass.

### 4. Documentation

Update `PROJECT.md` (Level 1 tools, subagent delegation, surface runtime ports).

### End-to-end case

Primary delegates A and B. It reads A's activity, steers A, receives A's `subagent_result`, sends A a
follow-up, and interrupts B. It then reads and messages an independently created native thread it can
edit, once with cross-thread runs on and once with them off. Repeat the follow-up result delivery
across a Core restart. Use event barriers, not fixed sleeps.

## Gaps to check during implementation

- **Provider-native activity.** Claude Code transcripts live outside Core (`PROJECT.md:445`).
  Confirm whether Claude Code and Codex adapter runs record tool activity in Lilac's display records.
  If they do not, `activity` comes back thin for those children and the tool should say so.
- **Discord child transcripts.** `NativeSubagents` is native-surface code. Discord-launched children
  need their transcript from a surface-agnostic source for `read`.
- **Subagent principal.** Confirm that a child's request context carries the root request's
  initiating principal and surface (`subagent.ts` builds `authenticatedOrigin` from
  `requestInitiator`), so the port can authorize a subagent's thread reads.
- **Runner steer addressing.** Confirm that a `requiresActive` steer to a subagent run's
  `childRequestId` reaches that run, and that the tool can observe the `abandoned` outcome to apply
  the `auto` fallback.
- **Workflow cancel authority.** Confirm the current `workflow.run.cancel` scope check covers a
  primary cancelling its own subagent runs, and does not let a session cancel another session's
  subagents in the same project.
- **Orphan reconciliation.** A follow-up binds a fresh completion target to the caller's current
  request. Confirm orphan reconciliation (`workflow-live-parent-bridge.ts:742`) treats the earlier,
  ended parent request on the same child session correctly.

## Residuals

- Sender provenance in the target thread (which thread and run sent a message).
- Waiting on another thread's run, possibly through `job`.

## Out of scope

Human messages to subagents, model or reasoning changes from agent tools, `restart` mode, sending to
scripted workflows, cross-thread control on Discord, full-transcript forks for new children, worktree
provisioning, and remote-machine control.

## Implementation status

Phases 1 to 4 are implemented. Code:

- Tool: `apps/core/src/tools/orchestrate.ts`; plugin: `apps/core/src/plugins/builtin/orchestrate.ts`.
- Port contract: `apps/core/src/surface/thread-control.ts`; registry wiring in
  `apps/core/src/surface/runtime-descriptor.ts`; native port:
  `apps/core/src/surface/native/thread-control.ts`.
- Shared cancel: `apps/core/src/workflow/workflow-run-cancel.ts`, also used by `workflow.run.cancel`.
- Delegate changes: `apps/core/src/tools/subagent.ts`, `packages/coding-tools/src/schemas.ts`.
- `PROJECT.md` has an Orchestration section.

Evidence: `tests/tools/orchestrate.test.ts`, `tests/plugins/builtin-orchestrate.test.ts`,
`tests/surface/native/thread-control.test.ts`, the follow-up case in
`tests/workflow/workflow-subagent-convergence.test.ts`, and the updated
`tests/tools/subagent.test.ts`.

Gap resolutions:

- Discord child transcripts: `read` uses the runner's live snapshot or the transcript store with the
  pure `subagentMessages` projection, so it does not depend on `NativeSubagents`.
- Subagent principal: a child's Level 1 context carries the root user and surface from its durable
  workflow origin. A primary's initiator counts only when its ingress was verified.
- Workflow cancel authority: `orchestrate` checks `parentSessionId` for subagents and project scope
  for workflows itself, instead of relying on `workflow.run.cancel`.
- Runner steer addressing: a steer targets the child's active agent request id and session, the same
  headers the workflow engine uses for its prompt. Covered by the steer integration test added in the
  follow-up pass.
- Model inheritance: read from the previous agent operation's dispatch policy; no stored field was
  added.

Follow-up pass (2026-11-12):

- Decision 14 holds for late races. Native: an `auto` steer carries the `agent-auto-` command
  prefix, and the store requeues it as a follow-up when admission finds its run changed or the
  runner abandons it (`NativeStore.requeueAutoSteer`, a new `abandoned` delivery state), admitting
  it in the same pass. Subagents: `orchestrate` steers only when the runner holds the child's
  request as its active run, and otherwise sends a follow-up. A steer marked `autoFollowUp` that
  still misses the run, at intake or unconsumed when the run ends, becomes a follow-up started by
  the runner from the child's durable records (`subagentFollowUpRegistration`).
- Runner safety: a workflow request's unconsumed controls are abandoned with the run instead of
  being requeued as a prompt, which would have run without dispatch authority
  (`unconsumedControlDisposition`).
- Queued surface sends: `acceptSurfaceInput` failed with "Message is unavailable" for a
  run-triggering `surface.messages.send` to a busy native thread, losing the message. Confirmed and
  fixed: only an input that already has its own turn takes the caller's display, and admission
  renders any service-authored input turn as Lilac's assistant message.
- Cancel hang: not a product bug. The integration fixture's in-memory bus awaits subscriber delivery
  inside `publish`, so a steer published during a cancel can wait on the runner cleanup that waits
  on it. Redis publishing returns after the write.
- Posts with a `commandId` are idempotent.
- `tests/workflow/workflow-subagent-steer.test.ts` drives a steer through the real runner and
  workflow engine into a running child and checks that its next model call receives it.

Review pass (2026-11-12), three Sol reviewers (standards, spec, correctness):

- Thread send and interrupt are primary-only; subagents keep thread reads.
- Keyed subagent steers use a stable delivery ID, and a keyed follow-up retry returns the run it
  already started.
- Workflow operations page like other reads; every read reports `hasMore`.
- A thread read reports input state, so a steer that missed its run shows `target-ended`.
- A converted auto steer is admitted in the same admission pass instead of waiting for the next
  kick.
- Round 2: a keyed retry resolves the first attempt's steer delivery or follow-up before choosing a
  path, and the follow-up lookup pages through every subagent run; an explicit steer the runner
  abandons settles `target-ended`; the runner's follow-up reports to the request and tool call that
  sent the steer; the follow-up builder reuses `buildSubagentDelegationRegistration`.
- Declined: keeping a delivery whose follow-up dispatch failed. Parking it would route accepted work
  into recovery, which replays it under the ended child request without dispatch authority. It ends
  as `follow-up-failed` with an error log instead.
- Round 3: workflow reads page operations from storage, past the first 1,000.

Open after review (round budget reached):

- COR-6, Should, not reproduced: an `auto` subagent steer returns once published. If the steer then
  misses the child and the sending request finishes before the runner registers the follow-up under
  it, orphan handling cancels the follow-up and the message is lost. The window is the time between
  publication and runner intake, while the sender usually needs another model call before it can
  finish. Closing it needs the sending request to stay open until routing confirms the steer landed
  or its follow-up exists.
