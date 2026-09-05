# Architecture audit, September 5, 2026

Current work: [non-Mini issue tracker](architecture-issues.md). [Mini issues](mini-architecture-issues.md) are deferred by the user. This report preserves the original audit evidence.

Audited checkout: `8ba7f40f` (`fix(core): retry stalled resource downloads`). The worktree was clean before the audit. Six subagents examined Core execution, surfaces/tools, Mini, shared packages, persistence/delivery, and architecture tooling. The primary agent checked the strongest findings against their callers and consolidated overlapping reports.

Five defects deserve the next repair work: workflow takeover, session preparation cleanup, plugin retirement, artifact paging, and ACP locking. Each has a concrete failure path. The remaining priorities address duplicated policy and responsibilities that have spread across callers.

This is an audit and proposed backlog, not an approved implementation plan. No production code changed.

## Priority list

P1 means repair next because accepted work can stall, active resources can be destroyed, or a bounded operation can consume unbounded memory. P2 means a focused refactor has a demonstrated correctness, scaling, or maintenance payoff. P3 means useful cleanup after the higher-impact work. Order within each priority reflects impact and scope. Effort is relative: S is localized, M crosses several modules, L changes ownership across multiple execution paths.

| Rank | Priority | Defect | Effort | Evidence |
| --- | --- | --- | --- | --- |
| 1 | P1 | Workflow recovery never retries fresh leases after restart | S | Engine probe |
| 2 | P1 | Session preparation sits outside its cleanup scope | M | Runner probe |
| 3 | P1 | Plugin reload destroys instances held by active Level 1 runs | M–L | Traced lifecycle |
| 4 | P1 | Blob artifact paging materializes the entire artifact | M | Compared implementations |
| 5 | P1 | ACP's session-index lock survives a killed owner | S–M | Public store probe |
| 6 | P2 | Duplicated tools clients strip restricted-mode help | S immediate, M shared implementation | Traced decoder and output |
| 7 | P2 | Portable utility imports initialize Core environment/providers | S–M | Fresh-process probes |
| 8 | P2 | Mini derives HTTP failure categories from English messages | M | Mapper probe and route trace |
| 9 | P2 | Mini HTTP owns admission and scans all sessions per prompt | M | Traced route and SQL |
| 10 | P2 | Surface consumers repeatedly decode Discord raw payloads | M–L | Traced duplicated policy |
| 11 | P2 | Workflow artifact publication can abandon durable blobs | M, design decision needed | Traced crash window |
| 12 | P2 | Mini history exposes competing throwing and Result interfaces | M | Production dispatch and test doubles |

## Findings

### 1. Workflow recovery never retries fresh leases after restart

[WorkflowEngine.start](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/workflow/workflow-engine.ts:591) scans running workflows once. It tries to reclaim them using the existing 60-second stale fence. The [store correctly refuses fresh claims](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/workflow/durable-workflow-store.ts:1726), but [recurring reconciliation](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/workflow/workflow-engine.ts:763) scans only queued workflows.

A restart within 60 seconds of the last heartbeat can leave the former owner's workflow marked running indefinitely in that process. It can also continue occupying active-run capacity. Startup owns abandoned-run discovery while the recurring loop owns the passage of time, so neither finishes recovery.

**Verification:** A probe using the real engine with fake time and store started at time 1,000, advanced to 62,000, then invoked reconciliation. Queries were `running, blocked, queued, queued`; the only claim attempt occurred at 1,000. Existing [restart coverage](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/tests/workflow/workflow-integration.test.ts:737) advances beyond the lease deadline before starting the replacement engine.

**Fix:** Reconcile stale running workflows in the recurring loop through the existing fenced claim operation. Startup should perform the same initial reconciliation. Preserve live-owner fencing. Test both restart-before-expiry takeover and refusal to steal a live claim.

### 2. Session preparation sits outside its cleanup scope

The runner [marks the session running](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/bridge/bus-agent-runner.ts:4840), then [registers a live parent and awaits readiness](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/bridge/bus-agent-runner.ts:5116). Its guarded execution starts only at [line 5305](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/bridge/bus-agent-runner.ts:5305), with cleanup attached at [line 8717](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/bridge/bus-agent-runner.ts:8717).

Parent setup performs durable reads and [starts child-output subscriptions](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/workflow/workflow-live-parent-bridge.ts:774). An ordinary failure here escapes the cleanup scope. The outer drain supervisor logs it, leaving `running=true`, no `activeRun`, and an acquired parent that was never closed. Later requests in the session do not start. Shutdown cannot abort this state through its active-run path.

**Verification:** A probe using the real runner rejected the first parent's readiness and then enqueued another request in the same session. It observed one parent registration, zero closes, and no active work. The second request never reached registration.

**Fix:** Give one session-run module ownership of dequeue, preparation, acquired handles, execution, and settlement. Enter its cleanup scope before publishing active state. Parent registration must also roll back partial acquisition if it cannot return a usable handle. Verify durable-read and subscription failures, owner release, subsequent request progress, and shutdown. Splitting the large file without changing this ownership would leave the defect intact.

### 3. Plugin reload destroys instances held by active Level 1 runs

Core [captures external plugin executables](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/plugins/manager.ts:475) into run-scoped toolsets. Those toolsets have no generation release handle. The tool server's [reload lease](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tool-server/create-tool-server.ts:782) waits for Level 2 HTTP calls only. Reload then [destroys the previous plugin generation](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/plugin-runtime/manager.ts:381). [Config reload](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/runtime/create-core-runtime.ts:2736) invokes that path.

A plugin may allocate a connection during creation and close it during destruction. An active primary or subagent run still holds closures using that connection when reload destroys it. The lifetime owner protects one consumer class while overlooking another.

**Fix:** Let the existing plugin manager own generation lifetimes for both Level 1 toolsets and Level 2 calls. Publish the new generation, retire the old one, and destroy it after its holders release it. Do not make reload wait for all agent runs: a run may itself invoke the reload tool. Test a plugin whose destroy closes an instrumented resource, including reload initiated by an active run.

**Evidence limit:** Two auditors confirmed the call chain. No runtime plugin-race reproduction was run.

### 4. Blob artifact paging materializes the entire artifact

The blob implementation's [readWindow](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/tool-results/src/blob-tool-result-artifact-store.ts:1044) calls [readContent](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/tool-results/src/blob-tool-result-artifact-store.ts:640), which buffers all encrypted bytes, decrypts the complete string, and only then selects the requested page. The local implementation already [streams decryption while retaining the requested window](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/tool-results/src/tool-result-artifact-store.ts:1018).

Both implementations separately own pagination, Unicode accounting, scope/expiry checks, quota eviction, encryption, and cleanup. This duplication has produced a material behavioral difference. A small page consumes memory proportional to the whole artifact in Core, and it holds the store-wide exclusive queue. Core [Bash stream creation](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tools/bash-impl.ts:807) supplies no per-artifact maximum; the scope policy permits a single oversized artifact.

**Fix:** Share the streaming page accumulator above the two byte-storage adapters. Preserve verification and authentication before returning content. Full scanning may still be needed for authentication and total-character counts; retaining the whole artifact is unnecessary. Follow with shared scope/quota policy where behavior is identical. Verify both adapters against the same pagination cases and measure peak memory for a large streamed artifact.

**Evidence limit:** The allocation path and implementation difference are confirmed. No OOM incident or memory benchmark was reproduced.

### 5. ACP's session-index lock survives a killed owner

ACP [acquires its lock by creating a directory](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/acp-controller/run-store.ts:331). Existing directories cause retries until a five-second timeout. Only [normal cleanup](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/acp-controller/run-store.ts:365) removes it. There is no owner identity or stale-owner handling.

A killed worker can leave every subsequent index mutation failing until the directory is removed. This affects prompt creation, discovery updates, and title changes. Prompt creation can fail after a remote session has already been created because the [controller propagates index-update failure](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/acp-controller/controller.ts:2046).

**Verification:** Calling public `upsertSessionIndexEntries([])` in temporary state containing an orphan lock returned `SessionIndexLockTimedOut` after 5,015 ms. The lock remained. Temporary state was removed afterward.

**Fix:** Put cross-process locking behind an ACP-owned module whose lock is released when its owner dies. Prefer OS-released locking if available in the supported runtime; otherwise design verified owner identity and safe takeover. A longer timeout cannot repair ownership. Any new dependency or stored lock format needs a separate implementation decision. Test owner death and concurrent acquisition through subprocesses.

### 6. Duplicated tools clients strip restricted-mode help

Restricted Bash [decodes help responses](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tools/restricted-bash.ts:810) using an object schema containing only `primaryPositional`. Zod strips the other fields. The same decoded object becomes [user-visible help](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tools/restricted-bash.ts:977). Non-positional tools therefore print `{}`; positional tools disclose only that field.

The native client uses the [complete help schema](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/tool-bridge/wire-codecs.ts:12). Command parsing, input sources, headers, response decoding, and failure projection also have parallel implementations. Restricted agents lose parameter documentation at the progressive-disclosure entry point.

**Fix:** Preserve the complete help projection first. Then share existing protocol codecs and pure argument interpretation, with native I/O and virtual-filesystem access in separate adapters. Preserve the existing wire contract. Run matching help, positional-input, JSON-input, and failure-output cases through both clients.

### 7. Portable utility imports initialize Core environment/providers

The [tool-output normalizer](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/tool-results/src/tool-result-output-normalizer.ts:1) imports the utils barrel for `createLogger`. That barrel exports Core environment and model-provider modules. [Environment initialization](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/utils/env.ts:137) resolves a Core data directory through workspace discovery; [provider initialization](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/utils/model-provider.ts:592) constructs providers and discovers the Claude executable.

**Verification:** A fresh Bun process with `DATA_DIR` absent, cwd `/tmp`, and an absolute import of the normalizer failed with `Workspace root not found from: /tmp (no package.json with workspaces)`. A second probe from the repository intercepted a `Bun.which("claude")` call during that same import.

A portable output helper consequently depends on unrelated Core bootstrap state. This is a concrete loss of package independence.

**Fix:** Use side-effect-free subpath imports for logging, errors, message helpers, and other primitives. Make Core environment/provider construction explicit or lazy under its composition owner. No new workspace is necessary. Add a fresh-process import test outside a workspace without `DATA_DIR`.

### 8. Mini derives HTTP failure categories from English messages

[MiniLilacSessionOperationRejected](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/src/session-service.ts:242) carries an operation and message, but no closed rejection reason. The server [reconstructs HTTP semantics from message patterns](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/mini-lilac-server/src/server.ts:218), with another creation-specific mapper nearby.

An interrupt can record pending steering IDs. A later steering request is then [rejected as interrupted before admission](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/src/session-service.ts:4521). The `/steer` route uses the generic mapper, which has no matching pattern.

**Verification:** Executing that mapper returned status 500 and `internal_error`. An [existing runtime test](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/tests/session-runtime-interruptions.test.ts:195) exercises the valid interruption sequence. This was a mapper probe plus route tracing, not a full HTTP test.

**Fix:** Add closed internal rejection reasons and exhaustively project them onto existing HTTP statuses/codes. Let messages change independently. Test interrupt-before-admission through the route and cover the mapping table. The current protocol need not change.

### 9. Mini HTTP owns admission and scans all sessions per prompt

[existingSession](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/mini-lilac-server/src/server.ts:527) finds one session by calling `listSessionsResult()`. The [store implementation](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/src/sqlite-store.ts:3960) selects and decodes every session and loads history-navigation state for each.

The HTTP route owns find/create, binding comparison, and prompt start under a [server-local lock](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/mini-lilac-server/src/server.ts:603). The runtime actor has its own serialization, and delegated-session admission implements another [find/create/admit sequence](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/src/session-service.ts:6943).

A prompt does work proportional to retained sessions and depends on unrelated session rows decoding successfully. Correct admission also requires callers to know which extra lock and checks to apply.

**Fix:** Put resolve-or-create-and-admit in the runtime under its existing session serialization. Use a targeted lookup distinguishing absence from corruption. HTTP should decode inputs and project results. Verify concurrent admission through different entry points and show that one prompt does not enumerate all stored sessions.

### 10. Surface consumers repeatedly decode Discord raw payloads

[SurfaceMessage](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/types.ts:86) exposes `raw?: unknown` without the attachment and reference semantics its consumers need. The generic surface tool [decodes Discord metadata](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/tool-server/tools/surface.ts:647), knows Discord message type 21, and performs reference enrichment. It also reconstructs attachment selection already owned by [discord-attachment](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/discord/discord-attachment.ts:36).

[Reply-chain composition](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/bridge/request-composition/reply-chain.ts:61) and [search indexing](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/surface/store/discord-search-store.ts:374) parse the same representation again. Discord payload changes therefore spread across tool presentation, prompt composition, indexing, and resources.

**Fix:** Create an internal Discord-owned normalized message projection for the semantics these consumers actually use. Move reference enrichment into that module. Keep raw diagnostic output where needed. Preserve current wire and stored formats. Verify equivalent attachment/reference selection across tools, prompts, and indexing.

**Evidence limit:** This is confirmed duplicated policy and responsibility leakage, without an established data-loss incident.

### 11. Workflow artifact publication can abandon durable blobs

[Artifact publication](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/workflow/workflow-artifact-store.ts:219) uploads with durable retention, awaits completion, then [registers workflow ownership](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/workflow/workflow-artifact-store.ts:248). A crash between these steps leaves an object absent from the workflow database. Duplicate publication attempts also perform [one immediate deletion](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/workflow/workflow-artifact-store.ts:269) of the losing upload; failed cleanup has no retained obligation.

Blob maintenance handles [expiry-based cleanup](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/blob-storage/src/store.ts:776). It cannot discover the missing domain ownership of durable objects. Repeated interrupted publication can therefore accumulate unreachable storage. This finding concerns abandoned uploads, independent of how long valid workflow results should be retained.

**Fix direction:** Give artifact publication one lifecycle owner for reservation, registration, and cleanup. The upload identity must remain recoverable before durable publication can orphan it, and failed cleanup must remain actionable. A complete design may require stored-contract changes, which need approval under repository rules. Do not quietly add a new journal or global reference registry. Verify interruption between upload and registration and failure during duplicate cleanup.

**Evidence limit:** The crash window and missing cleanup ownership are source-traced. No crash injection or storage-growth measurement was run.

### 12. Mini history exposes competing throwing and Result interfaces

Workspace-history Result methods [compare methods against class prototypes](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/src/workspace-history-store.ts:1516) to decide whether to execute an overridden throwing method or the internal Result implementation. There are 15 such checks. [Test doubles subclass the concrete store](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/tests/session-runtime-test-support.ts:625), and the runtime factory requires that concrete type.

Wrapping or overriding a method changes its Result counterpart's execution path. Tests depend on one interface while production generally uses another, forcing production dispatch logic to preserve the relationship. Locking and failure handling acquire extra paths to maintain.

**Fix:** Make Result methods canonical and have throwing compatibility wrappers call them in one direction. Use a narrow interface at the existing runtime factory seam so tests provide adapters rather than subclasses. Remove prototype detection after migrating the test doubles. Preserve externally consumed compatibility methods and check error identity and lock release.

## Follow-up backlog

These are worthwhile after the failures above. They should remain separate changes.

| Priority | Defect and evidence | Bounded change |
| --- | --- | --- |
| P2 | Mini's [subagent viewer](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/mini-lilac-tui/src/app.tsx:1122) duplicates [controller stream orchestration](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/mini-lilac-tui/src/controller.ts:631). Primary streams reconnect; subagent read failures terminate the viewer. | Share a read-only transcript follower with cancellation, reconnect, cursor/reset handling, and buffered updates. Keep composer controls in the controller. |
| P2 | Mini repeats history capture registration/cleanup in [live execution](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/src/session-service.ts:1361) and [startup recovery](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/mini-lilac-runtime/src/session-service.ts:6055), alongside duplicated finalization policy. | Extract existing history coordination, starting with capture registration and commit/cleanup. Preserve transaction and recovery semantics. |
| P2 | Named and primary Claude continuation repeat attempt allocation, fencing, outcomes, and pruning in [named reservation](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/transcript/transcript-store.ts:4253) and [primary reservation](/home/stanley/Sandbox/lilac-mcp/lilac-mono/apps/core/src/transcript/transcript-store.ts:4902). | Share attempt lifecycle operations while keeping their different canonical-proof checks separate. Keep tables and transactions intact. |
| P3 | [Coding-tool canonicalization](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/coding-tools/src/guardrails.ts:64) duplicates the existing [filesystem export](/home/stanley/Sandbox/lilac-mcp/lilac-mono/packages/fs/src/fs-impl.ts:62). | Delegate after tilde expansion. Preserve error projection and guardrail policy. |
| P3 | The [semantic source classifier](/home/stanley/Sandbox/lilac-mcp/lilac-mono/scripts/architecture/source-policy.ts:12) excludes every `fixtures/` directory; the [syntax classifier](/home/stanley/Sandbox/lilac-mcp/lilac-mono/scripts/oxlint-plugins/syntax-policy.mts:48) includes production `src/fixtures`. A probe confirmed disagreement. No current imported production fixture was found. | Share source classification and test scanner parity. This is an enforcement gap, not an observed runtime failure. |
| P3 | Root [test:core](/home/stanley/Sandbox/lilac-mcp/lilac-mono/package.json:34) manually lists packages and omits blob-storage, a direct Core dependency. | Correct the omission and validate product test lists against workspace dependencies. Full repository checks already include it. |

## Scope and verification limits

`bun run lint:architecture` passed, including the semantic runner and production syntax gate, which reported zero errors. No full repository test suite or typecheck was run because this audit changed no production code. Existing tests were inspected; focused probes were run for workflow takeover, runner preparation failure, ACP locking, utility imports, Mini error projection, and source-classifier parity.

The audit used source inspection across the six assigned areas rather than line-by-line coverage of every file. The prioritization separates reproduced failures from source-traced consequences and maintenance risks. Large files alone did not qualify as defects.

Core and Mini product independence, at-least-once recovery, process-local active output, native host authority, and strict Result rules are documented choices. This report does not recommend changing those contracts. Confirmed compaction residuals already listed in `plan/README.md` were not presented as new discoveries.
