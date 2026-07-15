# Unified Programmatic Workflows

## Status

- Decision: clean break from persisted workflow V2/V3 records and semantics.
- Authoring: plain JavaScript files, available in project and personal scopes.
- Invocation: Level-2 tools, documented through a progressively loaded bundled skill.
- Approval: required once for each exact immutable revision and capability profile.
- Inputs: persist both the validated input-schema snapshot and concrete arguments per run.
- UX: durable workflow review/progress messages independent of request output streams.
- Execution: one workflow engine; all agent work continues through `cmd.request.message`.

Implementation progress is tracked in `plan/unified-programmatic-workflows.todo.md`.

## Problem

Lilac currently has several partial orchestration systems:

- Workflow V2 persists Discord reply waits and resumes a conversation with a new request.
- Workflow V3 persists timestamp/cron triggers but treats request publication as completion.
- Deferred subagents dynamically fan out agent requests and inject results into a live parent, but their durable state is limited to short graceful-restart snapshots.
- Request output streams provide rich progress while a request is alive, but are finalized and removed when that request terminates.

Adding a separate dynamic-workflow runtime would create another lane with overlapping scheduling, cancellation, persistence, progress, and recovery behavior. Instead, replace these paths with one durable workflow engine whose trigger, program, and completion target are independent policies.

## Goals

1. Let an agent author reusable workflows as readable plain JavaScript.
2. Keep workflow authoring APIs out of the default Level-1 toolset and teach them through a bundled skill loaded only when needed.
3. Validate workflow shape, declared capabilities, input schema, and invocation arguments before creating a run.
4. Require deterministic human review before the first run of an exact revision.
5. Persist immutable revisions, approvals, schema snapshots, arguments, operation state, and surface bindings.
6. Run large workflows after the originating agent request has terminated.
7. Display review and progress on a durable surface message that survives process restarts.
8. Reuse the existing request bus and agent runner for every agent operation.
9. Support branches, loops, parallel fan-out, pipelines, named phases, waits, schedules, cancellation, pause, and replay.
10. Remove the legacy workflow service/scheduler and deferred-subagent orchestration manager after migration.

## Non-Goals

- Do not preserve or migrate existing persisted V2/V3 workflow records.
- Do not execute workflow source in the core process with `eval`, `node:vm`, dynamic import, or a Bun worker treated as a security boundary.
- Do not give workflow scripts direct filesystem, shell, network, environment, event-bus, MCP, or plugin access.
- Do not dynamically register one callable per workflow definition.
- Do not interpret free-form model output as an approval decision.
- Do not use request output streams as durable workflow progress storage.

## Mental Model

A workflow consists of three independent policies:

| Policy | Examples |
| --- | --- |
| Trigger | Immediate, timestamp, cron, adapter reply, manual invocation |
| Program | JavaScript orchestration over agents and waits |
| Completion target | Detached result, durable surface result, live parent injection, new session request |

Definitions, revisions, and runs are distinct:

| Identity | Meaning |
| --- | --- |
| Definition | Mutable JavaScript file selected by scope and name |
| Revision | Immutable source snapshot plus schema, capabilities, and runtime identity |
| Run | One invocation with a revision, schema snapshot, concrete arguments, origin, and progress target |

## Workflow Locations

Support both scopes:

| Scope | Root |
| --- | --- |
| Project | `<canonical-workspace-root>/.lilac/workflows/` |
| Personal | `${DATA_DIR}/workflows/` |

Rules:

- Definition names use lowercase kebab case and are at most 64 characters.
- A definition is `<name>.js`; nested paths are not part of v1.
- `scope: "project"` and `scope: "personal"` are exact.
- `scope: "auto"` resolves project first, then personal.
- Every trigger response records the actual resolved scope and canonical path.
- Personal definitions are still approved per canonical project context.
- Reject symlinks, non-regular files, path traversal, and canonical containment escapes.
- Project files may be authored with normal editing tools or `workflow.definition.save`.
- Personal files are normally authored through `workflow.definition.save`.

## JavaScript Contract

Workflow files are valid JavaScript modules with one allowed virtual import:

```js
import { defineWorkflow } from "@lilac/workflow";

export default defineWorkflow({
  name: "audit-routes",
  description: "Audit route authorization and verify findings",

  input: {
    type: "object",
    additionalProperties: false,
    required: ["directory"],
    properties: {
      directory: { type: "string" },
    },
  },

  capabilities: {
    agents: {
      profiles: ["explore"],
      models: ["inherit"],
      maxConcurrent: 8,
      maxTotal: 40,
      editing: false,
      isolation: "shared",
    },
    waits: [],
  },

  async run({ args, agent, parallel, pipeline, phase, waitForReply, sleep }) {
    const files = await agent(`List route files under ${args.directory}.`);
    const findings = await pipeline(
      files,
      (file) => agent(`Audit ${file} for missing authorization.`, { label: file }),
      { concurrency: 8 },
    );
    return phase("verify", () =>
      pipeline(findings, (finding) => agent(`Verify this finding:\n${finding}`)),
    );
  },
});
```

The shape validator must enforce:

- Exactly one import, from `@lilac/workflow`, with allowed named imports only.
- Exactly one default export produced by `defineWorkflow({...})`.
- No top-level statements other than the import and export.
- No dynamic import, CommonJS require, eval, Function constructor, or source-map indirection.
- Strict metadata, input schema, capabilities, and limits.
- The metadata name matches the selected filename.
- The source and metadata stay under configured byte, depth, property, enum, and string limits.
- Input schemas describe a JSON object, reject unknown properties by default, use no remote references, and do not coerce or mutate values.
- Arguments are plain JSON-compatible values and reject prototype-polluting keys.
- Edit-capable parallel agents require worktree isolation.

The first runtime version should support:

- `agent(prompt, options?)`
- `parallel(promises, options?)`
- `pipeline(items, callback, options?)`
- `phase(name, callback)`
- `waitForReply(options)`
- `sleep(durationOrTimestamp)`
- ordinary JavaScript conditionals, loops, arrays, and object manipulation
- the validated global `args`

The script has no direct side-effect capabilities. Side effects occur only inside agent requests governed by the revision's approved capability profile and originating safety policy.

## Capability Profile

Approval is bound to a normalized capability profile. At minimum it records:

- Allowed agent profiles.
- Allowed model aliases or `inherit`.
- Whether agents may edit.
- Shared checkout versus worktree isolation.
- Maximum concurrent agents.
- Maximum total agents per run.
- Maximum nesting depth.
- Maximum wall time and per-operation idle time.
- Allowed wait kinds.
- Whether user-visible surface sends are allowed.
- Whether external/network-capable tools may be available to child agents.
- The originating safety mode and any allowed escalation policy.

The engine must enforce the profile on each operation, not only when validating the file.

## Level-2 API

Expose fixed callable IDs through the built-in workflow plugin.

### `workflow.definition.save`

Input:

```ts
{
  scope: "project" | "personal";
  name: string;
  source: string;
  expectedSha256?: string;
}
```

Behavior:

- Resolve the fixed scope root.
- Reject path/symlink escapes.
- Validate source before writing.
- Write atomically with mode `0600` for personal files.
- Refuse overwrites without `expectedSha256` once a file exists.
- Return canonical metadata, path, source hash, schema hash, and capability hash.

### `workflow.definition.validate`

Input:

```ts
{
  scope: "project" | "personal" | "auto";
  name: string;
  args?: Record<string, unknown>;
}
```

Behavior:

- Perform static shape and syntax validation without execution.
- Normalize metadata, input schema, capabilities, and limits.
- Optionally validate concrete arguments.
- Return hashes and a human-readable review summary.

### `workflow.definition.get` and `workflow.definition.list`

- Return scope, name, path, hashes, validation status, and metadata.
- Source is opt-in and size-bounded.
- Listing reads bounded source prefixes or complete bounded files but never imports them.

### `workflow.run.trigger`

Input:

```ts
{
  scope: "project" | "personal" | "auto";
  name: string;
  args: Record<string, unknown>;
  progress?: {
    requestOrigin?: true;
    client?: "discord" | "github";
    sessionId?: string;
  };
}
```

Behavior:

1. Resolve and validate the definition.
2. Validate concrete arguments.
3. Create or reuse a content-addressed immutable revision snapshot.
4. Persist the run, schema snapshot, concrete arguments, argument hash, origin, safety mode, reviewer, and progress target transactionally.
5. Look up approval for the exact immutable review scope.
6. Set the run to `queued` when approved or `awaiting_review` when not approved.
7. Ensure the initial durable progress/review projection exists before returning.
8. Return a run ID immediately; never wait for workflow completion.

### Run and approval management

Expose:

- `workflow.run.get`
- `workflow.run.list`
- `workflow.run.cancel`
- `workflow.run.pause`
- `workflow.run.resume`
- `workflow.approval.revoke`

All tool inputs use Zod validation through the shared guided tool-validation helper. The trigger tool must opt out of generic argument logging or provide schema-aware redaction.

## Bundled Workflow Skill

Add a bundled skill named `workflow-authoring`.

The skill must document:

- When a task warrants a workflow.
- Project and personal storage locations and precedence.
- The complete JavaScript contract and orchestration API.
- Capability declarations and worktree requirements.
- Level-2 save, validate, trigger, inspect, cancel, and approval commands.
- First-run review behavior and revision invalidation.
- Input schema and sensitive-field guidance.
- Examples for fan-out, verification, iterative repair, schedules, and reply waits.

Integrate it through existing progressive skill disclosure:

- Add a `lilac-builtin` skill source.
- Bundle the skill in a package-owned asset directory.
- Give it lower precedence than data, project, and user skills so it can be overridden.
- Include only name and description in normal skill discovery; load full content through the existing skill call.

## Revision and Approval Identity

Approval is keyed by:

```text
canonical project identity
canonical workspace root
workflow scope
normalized workflow-relative path
exact source SHA-256
input schema SHA-256
capability profile SHA-256
workflow runtime version
```

Any change requires review again. Path-only approval is forbidden.

An immutable revision contains:

- Exact source bytes in a content-addressed snapshot.
- Source, schema, and capability hashes.
- Normalized metadata, input schema, capabilities, and limits.
- Runtime/compiler version.
- Canonical project and source identity.

Execution always uses the immutable snapshot, never a mutable definition path. This removes the validation-to-execution race.

## Review Lifecycle

Run states include:

```text
awaiting_review
queued
running
blocked
paused
succeeded
failed
rejected
cancelled
```

Review behavior:

1. The first trigger for an unapproved revision creates a pending approval and an `awaiting_review` run.
2. Multiple invocations of the same pending revision reuse one approval record while keeping distinct run records and arguments.
3. The review presents the exact source snapshot, first invocation arguments, input schema, capability profile, limits, project, path, and hashes.
4. Approval grants future runs of that exact revision and capability scope; argument values are not individually approved but are always schema-validated and persisted.
5. Approval atomically queues all non-cancelled runs waiting on that grant.
6. Rejection marks attached waiting runs rejected.
7. Revocation blocks future invocations and optionally pauses not-yet-started runs.
8. Every scheduled tick rechecks the revision grant.
9. A mutable source change creates a new revision and cannot inherit approval.

The expected reviewer defaults to the authenticated user who caused the originating request. If no authenticated interactive origin or configured reviewer exists, the run remains `awaiting_review` and the trigger returns an actionable error/status without executing.

Approval must be deterministic and handled outside the model. Never pass an arbitrary reply back to an agent to decide whether it means approval.

## Surface Actions

Extend the surface abstraction with generic actions rather than adding workflow-only Discord internals.

```ts
type SurfaceAction = {
  actionId: string;
  label: string;
  style: "primary" | "success" | "danger" | "secondary";
};

type SurfaceActionEvent = {
  actionId: string;
  platform: SurfacePlatform;
  userId: string;
  messageRef: MsgRef;
  ts: number;
};
```

Requirements:

- `ContentOpts` can include actions.
- Action IDs are opaque random tokens stored server-side, not unsigned embedded decisions.
- Action records bind token, message, expected actor, approval/run, allowed action, expiry, and consumed state.
- Discord renders Approve/Reject before execution and Pause/Resume/Cancel while active.
- Discord interaction handling validates channel, message, expected user, token, state, and expiry.
- GitHub initially renders exact reply instructions and resolves signed/opaque approval tokens from webhook-authenticated comments.
- Approval replies/actions are suppressed from normal agent routing.
- GitHub progress edits preserve the agent-comment marker.

## Durable Progress Lane

Request output streams are not reusable because they are keyed by request ID and finalized when a request response completes. Add an independent workflow progress projector.

Responsibilities:

1. Subscribe durably to workflow run, operation, approval, and usage events.
2. Treat events as wakeups and query authoritative SQLite state.
3. Create one persistent progress message per run.
4. Store the target `SessionRef`, resulting `MsgRef`, and last rendered hash.
5. Edit the message as review, phase, operation, usage, and terminal state changes.
6. Coalesce rapid updates and enforce adapter rate limits.
7. Reconcile every active run and missing binding on startup.
8. Continue after the originating request and its relay terminate.
9. Retain terminal cards.
10. Surface projector failures without failing workflow execution; retry them durably.

The progress view contains:

- Workflow name, run ID, revision short hash, scope, and path.
- Current state and elapsed time.
- Review status and reviewer when applicable.
- Named phases with completed/running/failed/total operation counts.
- Recent operation labels and status.
- Agent count, concurrency, duration, and structured token usage when available.
- Next trigger time for scheduled definitions.
- Redacted input summary.
- Terminal result summary or failure detail.
- State-appropriate controls.

Discord uses one editable embed/card. GitHub uses one marked editable comment. Source review may use an attachment on Discord and a bounded escaped `<details>` block on GitHub. The exact immutable snapshot remains available through `workflow.definition.get` or run inspection.

## Persistence Model

Introduce explicit schema migrations and normalized tables.

### `workflow_revisions`

- `revision_id`
- project identity and canonical root
- scope, normalized path, name
- source snapshot path or content-addressed artifact ID
- source, schema, capability hashes
- metadata, input schema, capabilities, and limits JSON
- runtime version
- timestamps

### `workflow_approvals`

- `approval_id`
- `revision_id`
- state: pending, approved, rejected, revoked, expired
- expected reviewer platform/user
- decision actor and source message/action
- expiry and decision timestamps
- revocation metadata

### `workflow_runs`

- `run_id`
- `revision_id` and optional `approval_id`
- state and terminal detail
- immutable input-schema JSON snapshot
- concrete arguments JSON and hash
- origin request/session/client/user/safety mode/project cwd
- completion target
- progress target
- result or result artifact
- created, started, updated, and terminal timestamps

### `workflow_operations`

- `run_id`, stable `operation_id`, call-site ID, phase, label
- kind, normalized input, input hash
- state and attempt
- deterministic request ID for agent operations
- output/result artifact, error, usage
- claim, start, update, and terminal timestamps

### `workflow_waits`

- operation identity
- match kind and indexed match key
- due/deadline time
- resolver cursor and result

### `workflow_triggers`

- trigger identity and pinned revision
- immediate/timestamp/cron/reply definition
- next-fire and last-fire state
- scheduling policy and progress target

### `workflow_surface_bindings`

- run ID
- target `SessionRef`
- bound `MsgRef`
- last rendered hash and last error
- retry/next-attempt state

### `workflow_surface_actions`

- opaque token hash
- run/approval identity
- action kind
- expected platform/user/message
- expiry, consumed state, and actor

### `workflow_schema_migrations`

- migration version and timestamp

Use new table names. Legacy V2/V3 tables may remain inert until a later explicit cleanup migration.

## Durable Script Execution

Run workflow JavaScript in a capability-only embedded engine such as QuickJS/WASM or an OS-sandboxed subprocess. Begin implementation with a time-boxed compatibility spike covering:

- ESM or transformed module loading.
- Async host promises.
- Top-level module validation.
- Memory limits and interrupt/CPU limits.
- Cancellation.
- Deterministic error and stack reporting.
- Bun compatibility.

If an embedded engine cannot safely support async host calls, use a subprocess with an OS sandbox, empty environment, no filesystem mounts beyond the immutable source snapshot, no network, bounded stdio, and a JSON-RPC host protocol.

Do not rely on AST checks alone as the runtime security boundary.

## Deterministic Replay

Workflow durability uses replay rather than serializing the JavaScript VM.

1. Instrument every host operation with a stable source call-site ID.
2. Derive pipeline child identities from call-site ID plus stable item identity/index.
3. Journal an operation before dispatch.
4. Hash normalized operation inputs.
5. On replay, return cached output when call-site, kind, and input hash match a terminal successful operation.
6. Reconcile running agent request IDs with durable request lifecycle before retrying.
7. Use deterministic request IDs such as `wfr:<runId>:<operationId>:<attempt>`.
8. New or changed operations execute; unchanged completed operations do not.
9. Reject or version unsupported source edits when explicitly resuming an old run.
10. Disable nondeterministic globals such as wall-clock time and random values; expose deterministic workflow time/ID helpers where required.

The engine may stop the script process while blocked. A matching event, operation completion, resume command, or restart replays the script against the journal.

## Agent Operations

The workflow engine dispatches each agent operation through the existing request bus:

- Use a synthetic child session that cannot deadlock behind the originating parent session.
- Publish `cmd.request.message` with workflow run/operation/attempt headers.
- Apply the approved profile, model, safety mode, tool restrictions, and worktree policy.
- Runtime-v1 workflow children expose contained `read_file` and path-only `glob`, but not native Level-1 `grep`: its backend searches content before result-path authorization and would expose a protected-file match oracle. Content search is available only through restricted bash, whose filesystem authorizes every file before reading it.
- Subscribe durably to request lifecycle and output.
- Mark an operation successful only when the request resolves successfully and its final output is captured.
- Distinguish queued, dispatched, running, succeeded, failed, cancelled, and timed-out states.
- Aggregate structured usage into run progress.
- Cascade workflow cancellation to active child requests.

Normal assistant output from child requests is not directly relayed to Discord/GitHub. The engine consumes it as operation output and the workflow projector renders aggregate progress and final results.

## Waits and Triggers

Implement waits as operation handlers under the same engine:

- `waitForReply` stores a durable adapter-event match and optional deadline.
- `sleep` stores a due timestamp.
- Cron and timestamp schedules create distinct workflow runs pinned to a revision.
- Event matching is surface-neutral at the domain layer, with adapter-specific normalized match data.
- Adapter event consumption must be durable enough to recover replies received around service restarts.
- After the ordered tail resolver activates, startup retires the obsolete `${subscriptionPrefix}:workflow-waits` Redis group so it cannot pin adapter retention. Any existing legacy group fails startup without explicit rollout confirmation; stop every old core instance and set `LILAC_CONFIRM_SINGLE_VERSION_WORKFLOW_WAIT_RESOLVER=1` only for the confirmed single-version rollout.
- Router suppression applies only to active approval/reply waits and expires when the wait is consumed or terminal.

Current V2 wait-for-reply and V3 scheduling APIs are removed after equivalent workflow templates and tools exist.

## Deferred Subagent Convergence

After the engine is stable:

- Implement deferred `subagent_delegate` as a generated one-agent workflow run with a live-parent completion target.
- Implement synchronous delegation as the same operation with a waiting caller.
- Replace the runner-local deferred child manager with a generic workflow completion bridge.
- Preserve synthetic tool-result transcript injection for a live parent.
- If the parent is no longer recoverable, use the persisted fallback completion target and durable progress/result card.
- Remove duplicate child subscriptions, timers, cancellation, and short snapshot-only recovery logic.

## Security Requirements

- Never trust caller-controlled cwd or request headers as an authorization boundary.
- Resolve reviewer identity from server-owned request/origin state.
- Approval decisions only come from authenticated adapter events.
- Keep all workflow callables unavailable in restricted mode until runtime isolation and policy support are proven.
- Bind approval to runtime version so security/runtime changes can invalidate grants.
- Execute immutable snapshots.
- Redact sensitive input fields from logs, progress, review summaries, and errors.
- Bound source, schema, args, operation output, stdout/stderr, and result sizes.
- Store oversized outputs in the existing artifact system.
- Authenticate or restrict the Level-2 tool server before treating it as a privileged workflow control plane.
- Reject arbitrary external module imports and dependency loading.
- Fail closed when safety-mode or origin lookup fails.

## Events

Replace generic V2/V3 lifecycle payloads with run-oriented events, including:

- `evt.workflow.run.changed`
- `evt.workflow.operation.changed`
- `evt.workflow.approval.changed`
- `evt.workflow.progress.requested`
- `evt.workflow.usage.changed`
- `evt.workflow.result.ready`

Events identify run/revision/operation but contain only bounded summaries. SQLite remains authoritative.

## Runtime Wiring

The final core runtime starts:

1. Adapter-to-bus bridge.
2. Unified workflow engine and durable event/wait resolver.
3. Workflow progress projector.
4. Request router with active workflow wait/action suppression.
5. Tool server and workflow Level-2 plugin.
6. Surface relays.
7. Existing agent runner.

Remove separate startup for the legacy workflow service and scheduler. A sandbox helper process is an isolation implementation detail, not a second business workflow lane.

## Staged Implementation

### Stage 1: Domain Model and Durable Storage

- Add revision, approval, run, operation, wait, trigger, surface binding, surface action, and migration schemas/types.
- Implement normalized SQLite store interfaces, transactions, atomic claims, and query indexes.
- Add run-oriented event contracts.
- Keep legacy runtime compiling while new storage is introduced alongside it.
- Add schema, CRUD, transaction, claim, tolerant-read, and restart tests.

### Stage 2: Definition Files, Validation, Level-2 Tools, and Skill

- Implement project/personal roots, canonical path policy, discovery, atomic save, hashing, and content-addressed snapshots.
- Implement strict JavaScript AST/shape validation and input/capability normalization.
- Implement definition save/validate/get/list and initial run trigger/get/list/cancel APIs backed by Stage 1 storage.
- Trigger creates `awaiting_review` or `queued` records but does not execute programs yet.
- Add the bundled `workflow-authoring` skill and built-in skill source.
- Add CLI/tool-server/path/security tests.

### Stage 3: Review, Approval, and Durable Surface UX

- Add generic surface actions and adapter events.
- Implement Discord approve/reject/pause/resume/cancel controls.
- Implement GitHub strict approval reply handling and marked editable comments.
- Implement approval state machine, expected-reviewer checks, revocation, and release of waiting runs.
- Implement workflow progress projector, persisted bindings, rate-limit coalescing, and startup reconciliation.
- Ensure trigger waits for initial card creation before returning.
- Add cross-surface approval, authorization, progress, terminal, and restart tests.

### Stage 4: Sandboxed Runtime and Operation Journal

- Complete the JavaScript engine spike and choose the safe execution implementation.
- Implement host APIs, call-site instrumentation, operation journaling, deterministic replay, limits, pause/resume/cancel, and result capture.
- Implement the agent operation handler through `cmd.request.message` with actual lifecycle tracking and usage aggregation.
- Implement immutable snapshot execution and approval recheck.
- Add branch, loop, pipeline, replay, crash-window, cancellation, budget, and sandbox escape tests.

### Stage 5: Waits, Scheduling, and Legacy Convergence

- Implement reply, sleep, timestamp, and cron handlers under the unified engine.
- Add durable adapter event matching and scoped router suppression.
- Replace scheduled-job dispatch semantics with real run completion semantics.
- Route deferred and synchronous subagent delegation through the workflow engine.
- Remove legacy V2/V3 service, scheduler, types, tool callables, prompts, and runner-local deferred manager.
- Update `PROJECT.md`, templates, migrations, and examples.

### Stage 6: Integration Hardening

- Run package and monorepo tests, package typechecks, lint fix, and format.
- Add end-to-end tests for author, validate, review, approve, execute, project progress, restart, and final result.
- Verify Discord and GitHub behavior.
- Verify restricted-mode denial and Level-2 control-plane authentication assumptions.
- Audit stale code, obsolete prompt names, orphan exports, and legacy tables.

## Acceptance Criteria

1. An agent can author a project or personal `.js` workflow and validate it with Level-2 tools.
2. The workflow skill is progressively loaded rather than injected into every prompt.
3. Triggering persists an immutable revision, schema snapshot, concrete arguments, run ID, origin, and progress target.
4. No workflow operation runs before exact-revision approval.
5. Source, schema, capability, path, project, or runtime-version changes force review again.
6. Subsequent invocations of the approved revision skip review, validate arguments, and persist distinct runs.
7. Only the expected authenticated user can approve or reject.
8. The review/progress card exists before the originating trigger request terminates.
9. Progress continues updating after that request's output relay is gone.
10. Core restart restores active runs and progress cards from SQLite.
11. Agent operations use the existing request bus and reflect actual request success/failure.
12. Completed operations are reused during deterministic replay without duplicate side effects.
13. Pause, resume, cancellation, limits, and cancellation cascade are durable.
14. Parallel editing requires worktree isolation.
15. Reply waits and schedules use the same engine and persistence model.
16. Deferred subagents no longer maintain a separate orchestration lane.
17. Legacy V2/V3 runtime paths and obsolete prompt instructions are removed.
18. Tests, typechecks, lint, and formatting pass.

## Validation Commands

Run focused tests during each stage and, before completion:

```bash
bun test
bunx tsc -p apps/core/tsconfig.json --noEmit
bunx tsc -p packages/event-bus/tsconfig.json --noEmit
bunx tsc -p packages/utils/tsconfig.json --noEmit
bun run lint:fix
bun run fmt
```

Run additional package typechecks when a stage changes another package.

## External Reference

- Claude Code dynamic workflows: <https://code.claude.com/docs/en/workflows>
- Claude Agent SDK TypeScript reference: <https://code.claude.com/docs/en/agent-sdk/typescript>
