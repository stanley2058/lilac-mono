# Unified Programmatic Workflows Implementation Todo

> Historical tracker only. `plan/workflow-runtime-simplification.todo.md` is
> the live tracker and supersedes the states and APIs below.

This file is the shared implementation ledger for `plan/unified-programmatic-workflows.md`.

## Agent Rules

- Read the full plan and this todo before changing code.
- Work only on the assigned stage unless a prerequisite fix is unavoidable.
- Do not revert or overwrite unrelated working-tree changes.
- Mark items complete only after implementation and focused verification.
- Add newly discovered work under the relevant stage.
- Record important design decisions and validation results in the log.
- Keep exactly one stage marked `IN PROGRESS` while implementation is active.

## Stage 1: Domain Model and Durable Storage

Status: COMPLETE

- [x] Define immutable workflow revision types and Zod schemas.
- [x] Define approval, run, operation, wait, trigger, surface binding, and surface action types and Zod schemas.
- [x] Define normalized state unions and legal transition helpers.
- [x] Define schema/version and capability normalization/hash contracts.
- [x] Add run-oriented workflow event-bus contracts.
- [x] Add explicit workflow schema migration tracking.
- [x] Implement normalized SQLite tables and indexes.
- [x] Implement transactional revision/run/approval creation.
- [x] Implement run, operation, wait, trigger, binding, action, and approval CRUD/query APIs.
- [x] Implement atomic claims and idempotent state updates.
- [x] Add focused store/schema/event tests.
- [x] Run focused tests and changed-package typechecks.

## Stage 2: Definitions, Tools, and Skill

Status: COMPLETE

- [x] Implement project and personal workflow roots and `auto` precedence.
- [x] Implement canonical path containment and symlink rejection.
- [x] Implement strict workflow-name and `.js` file rules.
- [x] Implement atomic save with optimistic SHA-256 checks.
- [x] Implement immutable content-addressed revision snapshots.
- [x] Implement JavaScript syntax/AST contract validation.
- [x] Implement metadata, JSON input schema, capability, and limit validation.
- [x] Implement concrete argument validation and sensitive-field metadata.
- [x] Implement `workflow.definition.save`.
- [x] Implement `workflow.definition.validate`.
- [x] Implement `workflow.definition.get` and `workflow.definition.list`.
- [x] Implement initial `workflow.run.trigger/get/list/cancel` without execution.
- [x] Register Level-2 callables and update tool bridge help/examples.
- [x] Add the `lilac-builtin` skill source.
- [x] Add bundled `workflow-authoring` skill content.
- [x] Add path, validation, tool-server, CLI, and skill-discovery tests.
- [x] Run focused tests and changed-package typechecks.
- [x] Instantiate `DurableWorkflowStore` from the Stage 2 trigger/inspection tool wiring; Stage 1 intentionally leaves the legacy runtime's store construction unchanged.
- [x] Generate revision, schema, capability, and argument hashes from canonical validated values before calling `createInvocation`.

## Stage 3: Review and Durable Surface Progress

Status: COMPLETE

- [x] Extend surface content with generic action definitions.
- [x] Add authenticated surface action adapter events.
- [x] Implement opaque persisted action tokens with actor/message/expiry binding.
- [x] Implement approval state transitions and expected-reviewer enforcement.
- [x] Implement Discord review and runtime controls.
- [x] Implement GitHub strict review reply flow and router suppression.
- [x] Preserve GitHub agent comment markers on progress edits.
- [x] Implement revision review rendering with exact source access.
- [x] Implement durable workflow progress view model and renderers.
- [x] Implement workflow progress projector with coalescing and retries.
- [x] Persist and restore surface message bindings.
- [x] Reconcile active runs and missing cards on startup.
- [x] Ensure trigger creates the initial review/progress card before returning.
- [x] Add approval, authorization, action replay, projection, and restart tests.
- [x] Run focused tests and changed-package typechecks.

## Stage 4: Runtime and Operation Journal

Status: COMPLETE

- [x] Complete and document the JavaScript sandbox/runtime spike.
- [x] Implement safe immutable snapshot loading.
- [x] Implement stable host call-site instrumentation.
- [x] Implement `agent`, `parallel`, `pipeline`, and `phase` host APIs.
- [x] Implement operation journal and normalized input hashing.
- [x] Implement deterministic replay and completed-operation caching.
- [x] Implement run claiming, scheduling, pause, resume, and cancellation.
- [x] Implement limits for concurrency, total agents, depth, time, memory, and output.
- [x] Implement agent request dispatch through `cmd.request.message`.
- [x] Persist request IDs and reconcile request lifecycle after restart.
- [x] Capture final output, failures, cancellation, and structured usage.
- [x] Enforce approved capabilities and originating safety mode per operation.
- [x] Aggregate operation/phase/usage progress for the projector.
- [x] Add replay, crash-window, cancellation, limits, and sandbox tests.
- [x] Run focused tests and changed-package typechecks.

## Stage 5: Waits, Scheduling, and Convergence

Status: COMPLETE

- [x] Implement durable `waitForReply` operations.
- [x] Implement durable `sleep` operations.
- [x] Implement timestamp and cron triggers creating distinct runs.
- [x] Add durable adapter event matching and event cursors.
- [x] Scope and expire router suppression correctly.
- [x] Make scheduled workflow state reflect actual run completion.
- [x] Route deferred subagents through one-agent workflow runs.
- [x] Route synchronous subagents through the same operation path where practical.
- [x] Replace the deferred-subagent manager with a generic completion bridge.
- [x] Remove legacy workflow V2/V3 service, scheduler, definitions, callables, and tests.
- [x] Remove obsolete workflow prompt instructions and inactive Level-1 workflow code.
- [x] Update `PROJECT.md`, `MIGRATIONS.md`, config templates, prompt templates, and examples.
- [x] Add wait, cron, offline recovery, parent completion, and migration tests.
- [x] Run focused tests and changed-package typechecks.

## Stage 6: Integration Hardening

Status: COMPLETE

- [x] Add author-to-result end-to-end tests.
- [x] Add core-restart execution and projection recovery tests.
- [x] Verify Discord review, controls, progress, and terminal display.
- [x] Verify GitHub review, progress edits, markers, and terminal display.
- [x] Verify restricted-mode denial and fail-closed safety lookup.
- [x] Verify sensitive argument redaction and output artifact bounds.
- [x] Audit tool-server authentication/control-plane exposure.
- [x] Audit stale exports, obsolete events, prompts, tests, and dead code.
- [x] Run all changed-package typechecks.
- [x] Run `bun test`.
- [x] Run `bun run lint:fix`.
- [x] Run `bun run fmt`.

## Decisions and Discoveries

- 2026-07-15: Clean break selected; legacy persisted V2/V3 records do not require migration.
- 2026-07-15: Both project and personal workflow file scopes are required.
- 2026-07-15: Workflow authoring guidance will be a bundled progressively loaded skill.
- 2026-07-15: Approval is bound to exact revision, schema, capabilities, project/path, and runtime version.
- 2026-07-15: Every run stores both schema snapshot and concrete arguments.
- 2026-07-15: Workflow progress uses a durable surface projection lane, not request output streams.
- 2026-07-15: Stage 1 adds `DurableWorkflowStore` alongside `SqliteWorkflowStore`; both can use the configured SQLite file, but new records use only the normalized `workflow_*` tables and legacy V2/V3 tables remain untouched.
- 2026-07-15: Workflow schema migration version 1 is tracked in `workflow_schema_migrations`; migration application is immediate and transactional, repeatable on restart, and rejects unknown newer versions or name mismatches.
- 2026-07-15: Nested JSON is validated with Zod on strict reads. Recovery/list queries are tolerant and skip malformed rows so one corrupt record does not prevent reconciliation of other runs.
- 2026-07-15: A partial unique index permits at most one pending or approved grant per revision. Transactional invocation creation reuses that active grant while preserving distinct runs and arguments.
- 2026-07-15: Run, operation, wait, and trigger claims are conditional leases with explicit stale-claim takeover. State updates validate legal transitions and treat an already-applied destination state as an idempotent success.
- 2026-07-15: New run-oriented events remain on `evt.workflow`, are keyed by run ID when available (revision ID for approval-only events), and coexist with all legacy event contracts.
- 2026-07-15: Stage 2 uses the already-installed `typescript-codegen` TypeScript 6 alias for the classic static compiler AST API because the repository's TypeScript 7 package root exports only its version API. Workflow source is parsed and inspected but never imported or executed.
- 2026-07-15: Definition capability hashes cover the canonical normalized capability profile and limits together, so a limit change invalidates the exact-revision grant even though Stage 1 stores one capability hash column.
- 2026-07-15: Input schemas use the explicit `sensitive: true` annotation on any supported schema node. Normalized dotted sensitive paths are returned by definition APIs, while trigger logging redacts the complete concrete `args` object.
- 2026-07-15: Immutable source snapshots are stored as `${DATA_DIR}/workflow-snapshots/<source-sha256>.js` with mode 0600 and persisted as `workflow-source:<source-sha256>` artifact identities.
- 2026-07-15: Stage 2 has no authenticated reviewer lookup in `RequestContext`; trigger persists nullable reviewer fields and leaves new grants `pending`. Stage 3 must resolve the expected reviewer from server-owned origin state before presenting deterministic approval UX.
- 2026-07-15: Stage 3 reviewer authorization is derived from the server-owned `cmd.request` cache. Level-2 headers must exactly match a cached Discord/GitHub origin, and the resolver uses the authenticated adapter message or signed-webhook actor; missing, mismatched, and bot actors fail closed.
- 2026-07-15: Generic action IDs carry opaque random tokens only. SQLite stores their SHA-256 hashes and atomically validates platform, actor, bound progress-card message, action kind/state, expiry, and one-time consumption together with the approval/run transition.
- 2026-07-15: GitHub review replies use the exact full-body syntax `lilac-workflow-action <card-comment-id> <opaque-token>`. Signed webhook handling publishes an authenticated action event before normal trigger parsing, suppressing the reply from agent routing.
- 2026-07-15: The workflow projector owns no request relay state. Workflow events are wakeups, SQLite is authoritative, bindings/errors/retry schedules are persisted, and startup reconciliation recreates missing cards while retaining terminal cards.
- 2026-07-15: Stage 4 runtime spike selected a fail-closed Bubblewrap subprocess inside a transient user-systemd service. Bubblewrap creates user/PID/network namespaces, clears the environment, drops all capabilities, exposes only the Bun executable, runtime libraries, the owned helper, private `/tmp`, minimal `/dev`, and private `/proc`; systemd enforces `MemoryMax`, no swap, `TasksMax`, and `RuntimeMaxSec`. Source/args/host results use bounded Zod-validated JSON-lines stdio. No workflow JavaScript runs in core, and there is no in-process or unsandboxed fallback.
- 2026-07-15: The concrete spike on Bun 1.3.14/Linux verified empty inherited secrets, denied network fetch, denied `/etc/passwd`, async host promise round-trips, deterministic error/result transport, killable infinite-loop cancellation, and cgroup termination of a 400 MiB allocation at the 256 MiB ceiling. Dynamic-code constructors and Bun/process/fetch/worker/console/wall-clock/random globals are lexically unavailable in workflow code; AST validation remains defense in depth, not the security boundary.
- 2026-07-15: Stage 4 operation identity is derived from immutable source hash plus AST call position and deterministic replay path/occurrence. Pipeline paths include stable item indexes. Canonical JSON input hashes detect replay divergence, terminal successful operations are cached, and request IDs are deterministic by run/operation/attempt.
- 2026-07-15: Workflow agent requests use synthetic per-operation sessions and only `cmd.request.message`. The runner validates the workflow policy envelope, forces originating safety mode, approved profile/model, canonical workspace or dedicated edit worktree, and a capability-filtered Level-1 toolset. Workflow request output is not relayed to a surface because its request client is `unknown`; the engine consumes durable request/output streams instead.
- 2026-07-15: Stage 5 wait identity uses the existing operation call-site/path hash. Reply waits default platform/channel/user matching to the authenticated run origin, optionally require a direct reply anchor, persist the adapter stream cursor on resolution, and use an event-specific expiring suppression record to close resolver/router ordering races without suppressing later messages.
- 2026-07-15: Numeric `sleep` values below `100000000000` are durations in milliseconds; larger values are epoch milliseconds, and ISO timestamp strings are accepted. Due/deadline claims are durable and replayed from `workflow_waits` after engine or resolver restart.
- 2026-07-15: Scheduled triggers pin revision, args, origin, completion target, and progress target. Each fire transactionally creates a deterministic distinct run, reuses only an active exact-revision grant, and advances the trigger cursor. Timestamp triggers remain active with no next fire until their run is terminal; cron inspection exposes the authoritative last run state.
- 2026-07-15: Legacy V2/V3 tables remain inert, but runtime startup, event contracts, service/scheduler/store/types, Level-1/Level-2 callables, prompt instructions, exports, and tests were removed. `cron.ts` remains as the unified scheduler's bounded five-field parser.
- 2026-07-15: Deferred and synchronous subagents now create generated immutable one-agent revisions and approved runs through the unified operation engine. A durable live-parent completion bridge owns ordered delivery, acknowledgement, progress wakeups, restart protection, parent cancellation, and parent-absent surface fallback; runner-local child subscriptions, timers, cursors, buffered completions, and graceful snapshot fields were removed.
- 2026-07-15: Stage 6 requires every `workflow.*` Level-2 call to match a server-cached authenticated Discord/GitHub origin and trusted server-side safety resolution. Synthetic workflow child requests and caller-supplied headers cannot authorize workflow controls. The broader Level-2 server remains an internal trusted-network service and is documented as such.
- 2026-07-15: Tool-server config lookup failure now resolves to restricted instead of trusted. All workflow call inputs are fully redacted from debug logs; schema-sensitive arguments and schema-shaped terminal results are redacted from review/progress surfaces.
- 2026-07-15: Workflow operation outputs and terminal results above 64 KiB are stored as content-addressed mode-0600 durable workflow artifacts, still bounded by the approved per-operation/result byte limit. Journal replay verifies and loads operation artifacts; `workflow.run.get --include-result-artifact=true` retrieves a bounded terminal result.
- 2026-07-15: Hard-restart testing found and fixed shutdown incorrectly terminalizing active child operations as cancelled. Engine shutdown now leaves them nonterminal for request-ID reconciliation and deterministic journal replay; explicit user cancellation remains terminal and cascades.
- 2026-07-15: Sandbox dependency detection now checks `bwrap`, `systemd-run`, `systemctl`, cgroup v2, and the user systemd manager with actionable fail-closed errors. There remains no unsandboxed fallback. The development container does not provision user systemd and is explicitly documented as not workflow-runtime-ready without host-specific deployment changes.
- 2026-07-15: Removed obsolete `apps/core/BUS_WORKFLOWS_PLAN_V2.md` and `apps/core/BUS_ATTACHMENTS_WORKFLOWS_PLAN.md`, updated stale `PROJECT.md` runtime/topic/startup references, and replaced the final `workflow.create` tool-bridge fixtures.

## Implementation Log

- 2026-07-15: Stage 6 started. Auditing the complete unified workflow implementation and documentation before adding author-to-result, hard-restart, adapter, fail-closed security, bounds, sandbox dependency, and Level-2 control-plane integration coverage.
- 2026-07-15: Stage 6 focused core verification passed: 81 tests across 18 files, 410 expectations, 0 failures. This includes real sandbox author-to-result execution through review/action/request bus/projection, hard SQLite reopen recovery, Discord/GitHub presentation, control-plane authorization, fail-closed safety, sensitive redaction, durable artifact bounds, and sandbox dependency denial.
- 2026-07-15: Interim focused package verification passed: event-bus workflow events 3 tests/10 expectations/0 failures; utils skills 7/19/0; tool-bridge 21/52/0. TypeScript passed with no diagnostics in core, event-bus, utils, tool-bridge, and plugin-runtime after the Stage 6 changes.
- 2026-07-15: Final post-format package tests passed: core 1,057 tests across 91 files/5,725 expectations/0 failures; event-bus 20/43/0; utils 215/584/0; tool-bridge 21/52/0; plugin-runtime 8/14/0.
- 2026-07-15: Final root `bun test` passed: 3 harness tests across 2 files/12 expectations/0 failures. The workspace harness ran core, ACP controller, utils, and event-bus package suites successfully.
- 2026-07-15: Final TypeScript checks passed with no diagnostics in `apps/core`, `apps/tool-bridge`, `packages/event-bus`, `packages/utils`, and `packages/plugin-runtime`.
- 2026-07-15: Required builds passed: `apps/core` `bun run build:remote-runner` and `apps/tool-bridge` `bun run build`.
- 2026-07-15: Final `bun run lint:fix` passed with 0 warnings and 0 errors across 402 files. `bun run fmt` completed across 426 files and `bun run fmt:check` passed all 426 files. `git diff --check` passed with no whitespace errors.
- 2026-07-15: Stage 6 complete. Deterministic adapter/webhook coverage replaces unavailable live Discord/GitHub credential smoke; deployment still requires a compatible Bubblewrap/user-systemd/cgroup-v2 host and a trusted-network boundary for the generally unauthenticated Level-2 server.
- 2026-07-16: Post-implementation review complete at `f9568f4`, the effective current `HEAD`. Six independent subsystem reviews returned GO with no critical/high implementation blocker; the review-fix loop is closed at the production blocker threshold, with deferred residuals recorded in the review ledger.

- 2026-07-15: Stage 1 started. Implementing the new domain and storage model alongside the legacy V2/V3 runtime; no legacy persisted records will be migrated or removed in this stage.
- 2026-07-15: Stage 1 implementation complete. Added strict domain schemas and transition helpers, explicit migration v1, normalized SQLite storage/queries/claims, transactional invocation creation, additive event contracts, and focused tests.
- 2026-07-15: `cd apps/core && bun test tests/workflow/workflow-domain.test.ts tests/workflow/durable-workflow-store.test.ts tests/workflow/workflow-store.test.ts` passed: 10 tests, 86 expectations, 0 failures.
- 2026-07-15: `cd packages/event-bus && bun test tests/workflow-events.test.ts` passed: 2 tests, 11 expectations, 0 failures.
- 2026-07-15: `cd apps/core && bunx tsc -p tsconfig.json --noEmit` passed with no diagnostics.
- 2026-07-15: `cd packages/event-bus && bunx tsc -p tsconfig.json --noEmit` passed with no diagnostics.
- 2026-07-15: `bun run lint:fix` passed: 0 warnings and 0 errors across 389 files.
- 2026-07-15: `bun run fmt` passed across 413 files.
- 2026-07-15: Stage 2 started. Implementing definition path policy, static validation, immutable snapshots, Level-2 definition/run tools, and progressive bundled skill discovery without executing workflow programs or adding approval surface UX.
- 2026-07-15: `cd apps/core && bun test tests/workflow/workflow-definition.test.ts tests/workflow/workflow-definition-store.test.ts tests/workflow/programmatic-workflow-tool.test.ts tests/workflow/workflow-domain.test.ts tests/workflow/durable-workflow-store.test.ts tests/workflow/workflow-store.test.ts` passed: 18 tests, 131 expectations, 0 failures.
- 2026-07-15: `cd apps/core && bun test tests/plugins/core-tool-plugin-manager.test.ts tests/tool-server-create-tool-server.test.ts` passed: 23 tests, 86 expectations, 0 failures.
- 2026-07-15: `cd packages/utils && bun test tests/skills.test.ts` passed: 7 tests, 19 expectations, 0 failures.
- 2026-07-15: `cd packages/event-bus && bun test tests/workflow-events.test.ts` passed: 2 tests, 11 expectations, 0 failures.
- 2026-07-15: `cd apps/tool-bridge && bun test client.test.ts` passed after the workflow JSON-input case was added: 21 tests, 52 expectations, 0 failures.
- 2026-07-15: `bunx tsc -p tsconfig.json --noEmit` passed in `apps/core`, `apps/tool-bridge`, `packages/utils`, and `packages/event-bus` with no diagnostics.
- 2026-07-15: Final post-format focused core command passed: 41 tests across 8 files, 219 expectations, 0 failures. It covers Stage 1 storage/domain preservation, Stage 2 validator/path/store/tools, built-in plugin registration, and tool-server restrictions.
- 2026-07-15: Final post-format `cd packages/utils && bun test tests/skills.test.ts` passed: 7 tests, 19 expectations, 0 failures; `cd packages/event-bus && bun test tests/workflow-events.test.ts` passed: 2 tests, 11 expectations, 0 failures; `cd apps/tool-bridge && bun test client.test.ts` passed: 21 tests, 52 expectations, 0 failures.
- 2026-07-15: Final post-format `bunx tsc -p tsconfig.json --noEmit` passed in `apps/core`, `apps/tool-bridge`, `packages/utils`, and `packages/event-bus` with no diagnostics.
- 2026-07-15: Final `bun run lint:fix` passed with 0 warnings and 0 errors across 395 files; final `bun run fmt` completed across 419 files.
- 2026-07-15: Stage 2 complete. Triggering creates or reuses immutable revisions and exact grants, persists `awaiting_review` or `queued` runs, and intentionally performs no workflow program execution or approval/progress surface work.
- 2026-07-15: Final containment hardening also rejects symlinks in intermediate scope-root components. The repeated final verification passed: core 42 tests/220 expectations, utils 7/19, event-bus 2/11, tool-bridge 21/52, all four typechecks, lint with 0 warnings/errors, and formatting across 419 files.
- 2026-07-15: Stage 3 started. Implementing authenticated review actions, deterministic approval transitions, durable workflow surface projection, and initial-card synchronization without workflow JavaScript execution or agent dispatch.
- 2026-07-15: Stage 3 focused core verification passed: 80 tests across 13 files, 288 expectations, 0 failures. Coverage includes store transitions/actions, reviewer authorization, trigger synchronization/fail-closed behavior, projector retry/coalescing/restart/missing-card/terminal retention, Discord controls, GitHub reply syntax/markers, request-origin caching, adapter bridge preservation, and plugin registration.
- 2026-07-15: Stage 3 event-bus verification passed: 3 tests, 12 expectations, 0 failures. The new authenticated adapter action event routes on `evt.adapter` by opaque action ID while run-oriented and legacy contracts remain intact.
- 2026-07-15: `packages/utils` workflow skill verification passed: 7 tests, 19 expectations, 0 failures; package typecheck passed with no diagnostics.
- 2026-07-15: Interim `apps/core` and `packages/event-bus` typechecks passed with no diagnostics before final broad verification.
- 2026-07-15: Exact immutable source access is exposed through `workflow.run.get --include-source=true`; it validates the content-addressed snapshot hash instead of reading the mutable definition path.
- 2026-07-15: Active-channel requests with random request IDs now carry authenticated origin message metadata in the server-published `cmd.request` payload. This closes the reviewer-resolution gap without accepting caller-provided Level-2 headers as authority.
- 2026-07-15: Final post-format `cd apps/core && bun test && bunx tsc -p tsconfig.json --noEmit` passed: 1056 tests across 90 files, 5719 expectations, 0 failures, and no type diagnostics.
- 2026-07-15: Final post-format `cd packages/event-bus && bun test && bunx tsc -p tsconfig.json --noEmit` passed: 20 tests across 3 files, 45 expectations, 0 failures, and no type diagnostics.
- 2026-07-15: Final post-format `cd packages/utils && bun test && bunx tsc -p tsconfig.json --noEmit` passed: 215 tests across 29 files, 584 expectations, 0 failures, and no type diagnostics.
- 2026-07-15: Final root `bun run lint:fix` passed with 0 warnings and 0 errors across 404 files; `bun run fmt` completed across 428 files.
- 2026-07-15: Stage 3 complete. No workflow source is executed and no workflow agent request is dispatched; queued runs remain for Stage 4.
- 2026-07-15: Stage 4 started. Evaluating a capability-only JavaScript subprocess boundary and mapping immutable revision, operation journal, request lifecycle/output, projector event, and core runtime contracts before implementation.
- 2026-07-15: Stage 4 focused runtime/store/projector verification passed: 28 tests across 9 workflow files, 206 expectations, 0 failures. Dedicated sandbox/engine verification passed: 9 tests, 33 expectations, 0 failures. Agent-runner/plugin/output-relay regression verification passed: 159 tests across 3 files, 414 expectations, 0 failures. Interim `apps/core` and `packages/event-bus` typechecks passed; event-bus workflow tests passed 3 tests/12 expectations.
- 2026-07-15: Final broad Stage 4 validation passed before formatting: `apps/core` 1,065 tests across 92 files/5,752 expectations/0 failures plus clean TypeScript; `packages/event-bus` 20 tests across 3 files/45 expectations/0 failures plus clean TypeScript. Final post-format focused validation passed: core 29 tests across 9 workflow files/210 expectations/0 failures plus clean TypeScript; event-bus 3 tests/12 expectations/0 failures plus clean TypeScript. Final root `bun run lint:fix` passed with 0 warnings and 0 errors across 410 files; `bun run fmt` completed across 434 files.
- 2026-07-15: Stage 4 complete. Approved queued runs are claimed and executed automatically after agent-runner restart restoration; legacy workflow runtime remains active for Stage 5. Reply waits, sleep, timestamp/cron scheduling, deferred-subagent convergence, and legacy removal were intentionally not implemented.
- 2026-07-15: Stage 5 started. Mapping the unified runtime, durable store, legacy V2/V3 scheduler/service/resolver lane, adapter routing, and deferred/synchronous subagent recovery before implementing parity and clean-break removal.
- 2026-07-15: Stage 5 focused verification passed: core workflow suite 37 tests across 12 files/246 expectations/0 failures; event-bus workflow tests 3/10/0; tool-bridge 21/52/0; utils skills 7/19/0. TypeScript passed with no diagnostics in `apps/core`, `packages/event-bus`, `apps/tool-bridge`, and `packages/utils`.
- 2026-07-15: Stage 5 full affected-package verification passed before final formatting: `apps/core` 1,052 tests across 89 files/5,692 expectations/0 failures; `packages/event-bus` 20/43/0; `packages/utils` 215/584/0. Final post-format focused core verification passed 14 tests across 5 files/77 expectations/0 failures; event-bus full 20/43/0; tool-bridge build plus 21/52/0; utils skills 7/19/0. Post-format TypeScript passed in all four changed packages. Root `bun run lint:fix` passed with 0 warnings and 0 errors across 397 files; `bun run fmt` completed across 421 files.
- 2026-07-15: Stage 5 subagent convergence complete. Added generated one-agent workflow dispatch, exact internal grants, durable live-parent delivery records, shared deferred/sync completion, named-session preservation, progress forwarding, completion-order injection, acknowledgement/deduplication, cancellation cascade, restart recovery protection, and durable surface fallback. Removed `createDeferredSubagentManager`, its output/lifecycle subscriptions and timers, deferred graceful-restart snapshot fields, and manager-specific tests.
- 2026-07-15: Final Stage 5 validation passed after formatting: `apps/core` 1,052 tests/5,682 expectations/0 failures; `packages/event-bus` 20/43/0; `packages/utils` 215/584/0; `apps/tool-bridge` build plus 21/52/0. TypeScript passed in all four packages. Root lint passed with 0 warnings/errors across 400 files; formatting completed across 424 files.

## Stage 6 Handoff

- Stage 5 is complete: reply/sleep waits, durable adapter reconciliation, timestamp/cron scheduling, scoped suppression, actual-run schedule state, generated deferred/sync subagent workflows, durable live-parent completion, and V2/V3 removal all use the unified runtime.
- Preserve the Bubblewrap plus user-systemd fail-closed boundary. Deployment environments must provide Linux user namespaces, `bwrap`, and a user systemd manager with cgroup-v2 memory/pid delegation; do not add an in-process, plain subprocess, AST-only, or inherited-environment fallback.
- Treat SQLite as authoritative for runs, operations, waits, triggers, live-parent delivery, projection, cancellation, and restart recovery. Bus events remain wakeups.
- Stage 6 should add author-to-result and hard-restart E2E coverage, verify Discord/GitHub controls and terminal presentation, audit restricted mode and sensitive output bounds, audit the Level-2 control plane and stale exports, then run root `bun test`, all package typechecks, lint fix, and format.
