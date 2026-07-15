# Unified Programmatic Workflows Review

## Round 1

Status: implementation and repository validation complete.

### Blockers Fixed

1. Child execution now resolves an opaque server-issued dispatch capability from SQLite. Workflow agents receive only constrained `just-bash` access over a no-network, no-symlink workspace mount; read-only runs cannot persist writes, editing runs write only in a verified owned Git worktree, and Level-2/surface access is filtered by the approved policy.
2. `raw.workflow` now contains only run/operation hints plus an unguessable capability. The runner verifies the authoritative run, operation, approval, request ID, revision, arguments, policy, session, cwd, and lifecycle before starting.
3. Dispatch capabilities are bound to request/session/platform/canonical cwd/project/revision/safety and expire on terminal lifecycle. Runner ownership is leased and refreshed. `/list`, `/help`, suggestions, and `/call` all send and validate the capability. The broader non-workflow Level-2 server remains an internal trusted-network service; workflow authority no longer depends on that network assumption.
4. Definition/run/trigger/control/grant access is bound to the authenticated canonical project and Discord/GitHub principal. Active grants are unique per revision and principal.
5. Operation dispatch and capability issuance are one transaction conditioned on a running, owned run and active exact grant. Revocation/pause/cancel makes later authorization fail independently in the runner.
6. Run inspection redacts arguments, terminal detail, and results by default. Sensitive workflows do not project terminal result values/artifact IDs. Explicit owner-authorized full result/artifact inspection is opt-in.
7. `waitForReply` is limited to the authenticated originating Discord session/user; cross-session and unsupported-platform waits fail closed.
8. Workflow schema regexes use a conservative linear-time subset and reject grouping, alternation, assertions, and backreferences.
9. Runtime startup recomputes revision identity (for public revisions), schema, capability, argument, snapshot, operation-input, and deterministic request hashes and revalidates arguments.
10. Discord safety inheritance uses the server-owned surface session store. Unknown Discord session ancestry resolves restricted instead of trusted.
11. Failure/timeout terminalization interrupts child requests and atomically cancels nonterminal operations, waits, and dispatch capabilities.
12. Request reconciliation uses a leased live runner owner rather than stale stream history. A stale owner causes deterministic request-ID redispatch; a live owner is observed without duplicate publication.
13. Startup uses a real 60-second stale window. Run terminal writes are owner-fenced, dispatch is owner-fenced, runner lease loss aborts immediately, and stale owners do not mutate the new owner's journal.
14. A blocked wait remains operation-local; concurrent siblings keep the run `running`.
15. Level-2 run creation uses a stable request/tool-call idempotency receipt and rejects key reuse with different input.
16. Revocation atomically pauses queued/running/blocked runs. Paused waits no longer resolve or suppress routing, and active engines abort/requeue on the state wakeup.
17. Live-parent and synchronous subagent completion load and validate artifact-backed terminal results before delivery/acknowledgement.
18. Graceful snapshots were bumped to version 2; prior version-1 snapshots are explicitly rejected instead of silently orphaning deferred state.
19. Incremental migrations backfill v2 trigger origin/completion context and v3 live-parent delivery rows, add quarantine metadata, and retain normalized rows during upgrade.
20. Existing approved principal-bound grants queue retries even when adapter reviewer lookup is unavailable; authenticated cached origin identity remains authoritative.
21. Startup projection reconciles every existing binding, including terminal cards, plus missing bindings.
22. GitHub `readMsg` and reviewer/card lookup use the exact issue-comment endpoint.
23. A GitHub comment created before an action-edit failure is returned as a typed partial success, durably bound, and retried without creating another run/card.
24. Surface action tokens rotate before expiry and schedule reprojection; expired controls are not reused from memory.
25. Discord workflow action acknowledgement waits for adapter-to-bus publication and reports durable-publication failure.
26. Tool bridge request context is sent consistently for list/help/suggestions/call; command examples use working shell quoting.
27. Validation rejects lexical shadowing of every reserved workflow host binding, matching compiler instrumentation semantics.
28. Normalization, schema ordering, definition listing, and canonical hashes use one locale-independent UTF-16 code-unit comparator.
29. Workflow agent profiles use the shared runtime profile enum.
30. The bundled pipeline example parses agent JSON before iteration, and JSON CLI flags are shell-quoted.
31. Successful completion rejects outstanding unawaited host calls. All terminal paths clear active waits/operations/dispatches atomically with the run transition.
32. Schedules persist an overlap policy (default `coalesce`), track every trigger-created run, and enforce per-trigger overlap plus the process-wide active-run cap atomically with run creation.
33. Wait resolution and suppression insertion share one SQLite transaction. Router suppression is a non-destructive, expiring lookup, so router redelivery remains suppressed until commit succeeds.
34. Reply/deadline arbitration is one conditional transaction using event time; late replies are consistently rejected.
35. Relative wait deadlines derive from persisted operation creation time, and duplicate wait creation adopts the already-persisted row without resetting duration.
36. GitHub reply waits are rejected at runtime because authenticated normalized GitHub message ingress is not available.
37. Wait creation time is the persisted activation lower bound; historical adapter events cannot satisfy a new wait.
38. Synchronous delegation records `deferredDelivery: false`, so it cannot also inject a deferred completion.
39. Oversized subagent results are loaded from the workflow artifact store and then pass through the existing parent output normalizer.
40. Every child run/operation event refreshes parent activity; bounded recent operation status is forwarded to the parent tool display.

### Proven False Positives

None. Code inspection confirmed each reported blocker or an equivalent unsafe edge in the same implementation path.

### Deferred Residuals

- Live Discord/GitHub credential smoke tests remain deployment validation; deterministic adapter tests cover the code paths in CI.
- Production hosts still must provide Bubblewrap, a user systemd manager, delegated cgroup v2 memory/PID controls, and user namespaces. There is no unsandboxed fallback.

## Round 2

Status: implementation and repository validation complete.

### Critical/High Regressions Fixed

1. Workflow path-bearing Level-2 inputs are resolved under the authoritative canonical workflow cwd, reject outside/symlink/protected paths, and are opened with `O_NOFOLLOW`. `content.inspect.path` and surface-send attachments receive stable `/proc/self/fd` descriptors held open through the call, preventing path-swap exfiltration.
2. `surfaceSends` now exposes only `surface.messages.send` in the originating session. Edit, delete, reactions, reads, global sessions, activity, and other surface APIs are excluded.
3. Every authenticated primary surface request receives an unguessable server-issued Level-2 control capability. It is bound to request, principal, session, platform, canonical cwd, safety mode, expiry, and active runner lifecycle; list/help/suggestions/call all carry it and terminal cleanup expires it.
4. Trigger get/list/cancel now enforce both project scope and trigger-origin principal. Trigger args and last-run fields use schema-aware default redaction.
5. Sensitive schemas collapse phase names and suppress labels, wait prompts, terminal detail, results, and artifact references from progress cards.
6. User-defined input-schema `pattern` is unsupported in runtime v1; no user regex executes in the JavaScript regex engine.
7. Authenticated GitHub requests derive trusted control safety from the signed-webhook/server-owned request origin instead of being categorically restricted.
8. Explore workflows receive contained `read_file`, `glob`, and `grep`; edit-capable explore definitions are rejected statically.
9. AST shadow validation now includes named function expressions and named class expressions.
10. Discord workflow actions await every adapter handler and acknowledge success only after durable publication; failures produce a retry response.
11. GitHub and Discord `readMsg` return null only for authoritative not-found outcomes and propagate transient failures.
12. Agent reconciliation fetches retained output/lifecycle history behind a terminal barrier and never publishes a prompt after a terminal result has been observed.
13. Graceful restart explicitly releases the workflow request-owner lease while preserving dispatch authority, allowing immediate atomic takeover by the restored runner.
14. Worker-created operations/waits and their transitions require the current run owner in the same SQL statement. Stale owners cannot create, claim, transition, or terminalize child journal state after takeover.
15. Run-lease loss aborts only the local workflow sandbox. It does not publish a shared child-request interrupt that could kill a successor's request.
16. Capacity-skipped timestamp triggers retain their original due time and retry instead of becoming inert.
17. Trigger creation has a durable idempotency receipt and fingerprint, deterministic trigger identity, same-input replay, and conflicting-input rejection.
18. Artifact-backed completion loading happens before acknowledgement or fallback activation. Read/normalization failures leave delivery pending.
19. Live-parent and subagent-handle cancellation use `cancelRunAndChildren`, atomically cancelling operations, waits, and dispatch authority.
20. `finishRun` performs its owner-fenced atomic terminal transition before interrupting captured child requests; a stale owner cannot clean up a successor journal.
21. Wait resolver startup catches up retained adapter history before expiring due deadlines, preserving deterministic event-time arbitration for offline on-time replies.
22. Projector reconciliation retains existing bindings and schedules retry on transient GitHub/Discord lookup failures; only authoritative absence clears a binding.
23. Sensitive progress redaction covers every free-form operation phase, label, wait prompt, terminal detail, result, and artifact field.
24. Sync subagent runs now retain a durable completion delivery. Uninterrupted sync loads then acknowledges before return; restored parents opt into pending sync recovery, while live uninterrupted parents cannot receive duplicate injection.
25. The live-parent bridge tails each durable child request output stream, refreshes the parent watchdog on output/reasoning/tool activity, and publishes bounded parent tool-status updates containing actual child activity.
26. Approved profiles are usable without host escape: explore has contained read/search, general/self add contained patch/edit, and all workflow shell access remains the no-network `just-bash` interpreter rooted in the approved workspace/worktree with no secret host environment.

### Proven False Positives

None. Each report identified a reproducible regression or an equivalent unsafe race in the same path.

### Medium/Deployment Residuals

- Live Discord/GitHub credential smoke tests remain deployment validation; deterministic adapter and projector tests cover failure classification and retry behavior.
- Production still requires Bubblewrap, a user systemd manager, delegated cgroup v2 memory/PID controls, and user namespaces. Workflow execution has no unsandboxed fallback.
- Workflow profiles intentionally cannot launch arbitrary host package-manager/compiler processes. Broader command execution requires a separately reviewed OS-sandbox executable allow-policy; current implementation/verification uses contained read/search/edit and the restricted interpreter.

## Round 3

Status: implementation and repository validation complete. Production readiness is not claimed; independent review is required.

### Critical/High Regressions Fixed

1. Workflow Level-1 filesystem tools now enforce the authoritative canonical workflow root themselves. Reads, globs, greps, edits, and patches reject alternate/SSH cwd values, dangerous overrides, absolute and parent escapes, protected paths, symlink traversal, and non-owned write roots; workflow search uses the local `node-rg` backend and excludes fuzzy search.
2. Internal heartbeat runs receive a dedicated principal-free Level-2 capability limited to the required read/search/session/message-send callables. List, help, and call all enforce the same callable allowlist, while workflow/control APIs and filesystem tools remain unavailable.
3. Primary and heartbeat control authorization restores canonical cwd and safety mode from server-held capability policy. Level-2 authorization no longer depends on request-message cache retention or trusts the caller's cwd header.
4. Cancel, pause, resume, and no-op run-control responses now use the same schema-aware redaction as run inspection/listing instead of returning raw sensitive arguments, results, or terminal detail.
5. Sensitive workflows omit the argument hash from default run responses and Discord/GitHub progress review data, preventing equality correlation through a value that could not otherwise be inspected.
6. Agent terminal operation writes and request-dispatch expiry are owner-fenced and transactional. A stale engine cannot publish a terminal transition or deactivate successor authority, and stale runner cleanup can expire only the request claim it still owns.
7. Workflow request authorization validates dispatch, run, operation, revision, and approval state in one SQLite transaction. Agent terminalization and dispatch deactivation are also one transaction, removing authorization/terminal interleavings.
8. Reply deadlines now use an explicit half-open interval: an event timestamp equal to the deadline is expired. This makes exact-deadline arbitration deterministic regardless of whether the event or timer callback executes first.
9. GitHub REST failures now use a typed `GithubApiError` carrying the HTTP status and path. Adapter reads classify only an authentic typed 404 as authoritative absence; forged status-shaped and transient failures propagate.
10. Projector reconciliation preserves bindings on transient lookup/edit failures, while an authoritative edit-time GitHub 404 clears the stale message reference, schedules retry, and recreates the card without reusing the missing target.
11. Surface pause now requeues active operations, clears request IDs/claims, and deactivates dispatch authority in the same transaction that pauses and consumes the action. A paused run cannot leave a child request authorized.

### Additional Hardening

- Surface message attachment path, filename, and MIME-type arrays are schema-capped at the existing ten-attachment surface limit before file processing.

### Regression Coverage

- Added exploit coverage for `/etc`, `/proc`, SSH/alternate cwd, dangerous overrides, symlinks, glob traversal, protected files, edit escapes, patch escapes, and missing owned-worktree authority.
- Added heartbeat callable-allowlist and request-cache-eviction/canonical-cwd tests across list, help, and call.
- Added sensitive run-control and argument-hash redaction assertions for tool responses, GitHub text, Discord text, and review attachments.
- Added stale runner/engine fencing, atomic surface pause, exact-deadline arbitration, typed edit-time 404 recovery, and attachment-count regressions.
- Full validation passed: core 1075 tests, tool bridge 22 tests, plugin runtime 8 tests, utils 215 tests, root harness, repository typecheck, remote runner/tool bridge/ACP builds, lint, format, and post-format checks.

### Remaining Medium/Deployment Residuals

- Live Discord/GitHub credential smoke tests remain deployment validation; deterministic adapter, capability, and projector tests cover the reviewed failure classifications in CI.
- Production still requires Bubblewrap, a user systemd manager, delegated cgroup v2 memory/PID controls, and user namespaces. Workflow execution has no unsandboxed fallback.
- Workflow profiles intentionally cannot launch arbitrary host package-manager/compiler processes. Any broader executable policy remains a separate security design and review.
- Independent security/concurrency review is required before any production-readiness claim.

## Round 4

Status: implementation and repository validation complete. Production readiness is not claimed; independent review is required.

### Critical/High Regressions Fixed

1. Runtime-v1 workflow external tools no longer expose direct `fetch` or `content.inspect`. Workflow children cannot route `file://`, loopback, link-local, private-network, redirect, browser, URL-context, or local-path inputs through those callables. The remaining external allowlist is search/discovery and bounded skill metadata only.
2. Core `content.inspect` now caps remote, local, and decoded base64 sources at 25 MiB. Content-Length is rejected before body reads, streamed responses are cancelled when the cap is crossed, base64 input length is schema-bounded, and decoded/local byte counts are checked before model submission.
3. Trigger create/get/list/cancel responses omit `argsSha256` whenever the pinned revision schema contains any sensitive field, matching run/progress correlation redaction.
4. Request redispatch uses schema-v7 durable terminal receipts, per-dispatch epochs, and a transactional prompt-publication claim. Runners record terminal state before lifecycle publication; a stale epoch blocks a pending redispatch but cannot terminate a newer epoch that already won publication. Output/lifecycle history and live subscriptions are epoch-filtered.
5. Reply expiry captures the durable `evt.adapter` stream watermark and persists it on the wait. A timer can expire a reply only after resolver ingestion has durably advanced through that cutoff. Reply resolution and router suppression both use the same half-open interval (`createdAt <= event.ts < deadlineAt`).
6. Projector retries now re-read bound messages before unchanged-hash short-circuiting, clear retry state when found, clear/recreate on authoritative absence, and retain bindings on transient failures. Discord unknown-channel/message codes 10003/10008 map to a common typed not-found error; GitHub typed 404 handling remains authoritative.
7. Heartbeat `surface.messages.send` is text-only. Attachment path, filename, or MIME fields are rejected before the surface tool or path-opening authority runs.
8. Workflow request policy now carries authoritative `shared` versus `worktree` isolation. Shared editing is confined to the canonical workspace root; worktree editing still requires an owned verified worktree. Both retain canonical path, symlink, protected-file, SSH-cwd, and dangerous-override rejection, and ordinary one-agent editing delegation remains shared.
9. Live-parent child activity subscriptions are removed when the agent operation, run, delivery, cancellation, fallback, or parent session becomes terminal/closed. Sequential child runs no longer accumulate tail subscriptions or Redis subscriber-pool leases.
10. The reported workflow-backed `tool-result://` issue was confirmed as a regression. Child-owned truncation artifacts are now resolved under the child session before parent delivery; the existing parent normalizer then re-bounds and re-homes output. Unavailable child artifacts produce a bounded explanatory preview rather than an unusable cross-session URI.

### Adjacent Boundary Hardening

- Workflow path authority caps attachment path and filename arrays at ten before opening any descriptor, matching the surface schema limit.
- Schema migration 7 backfills active dispatch isolation and epochs while adding terminal receipts, publication state, wait cutoffs, and adapter-stream watermarks.

### Regression Coverage

- Added workflow denial tests for `file://`, loopback/link-local HTTP, URL inspect, and host-file inspect inputs, plus remote/base64 inspect size limits.
- Added sensitive trigger hash assertions across create, replay, get, list, and cancel.
- Added a deterministic terminal-after-history-scan/before-publication race and stale/new epoch ordering coverage.
- Added watermark-gated expiry, exact-deadline router parity, retry lookup/found/absence behavior, Discord typed not-found, heartbeat attachment, shared/worktree editing, and pre-open attachment-count tests.
- Added thirty sequential child subscription lifecycle checks and child artifact transfer coverage.
- Full validation passed: core 1084 tests, event bus 21 tests, tool bridge 22 tests, plugin runtime 8 tests, utils 215 tests, root harness 3 tests, repository typecheck, remote runner/tool bridge/ACP builds, lint, format, and diff checks.

### Proven False Positives

None. The `tool-result://` report reproduced as a cross-session ownership failure and was fixed.

### Remaining Medium/Deployment Residuals

- Live Discord/GitHub credential smoke tests remain deployment validation; deterministic adapter, projector, capability, and concurrency tests cover the reviewed paths in CI.
- Production still requires Bubblewrap, a user systemd manager, delegated cgroup v2 memory/PID controls, and user namespaces. Workflow execution has no unsandboxed fallback.
- Workflow profiles intentionally cannot launch arbitrary host package-manager/compiler processes. Any broader executable policy remains a separate security design and review.
- Independent security/concurrency review is required before any production-readiness claim.

## Round 5

Status: implementation and repository validation complete. Production readiness is not claimed; independent review is required.

### Critical/High Regressions Fixed

1. Schema-v8 workflow terminal receipts now persist the exact dispatch epoch, terminal state/detail, JSON output or workflow artifact reference, and usage. When prompt publication loses to a receipt, the engine reads that receipt immediately and applies the revision's output limit while converging the operation and final run/result instead of waiting for lifecycle traffic from an ignored epoch.
2. Terminal receipt insertion is fenced by the active dispatch row's exact request/run/operation/epoch, successful runner ownership claim, active state, and completed prompt-publication claim. The runner only attempts insertion after server authorization and that exact epoch claim. Unauthorized or stale queued commands can still emit their rejected lifecycle for observability but cannot create a durable terminal receipt.
3. Reply expiry no longer uses a maximum observed stream cursor. A due reply wait appends an opaque resolver barrier to `evt.adapter`, persists its identity/cursor, and expires only after that exact marker is processed. The resolver holds a durable single-owner lease and consumes the stream in broker order with a sequential tail consumer, so all earlier on-time events are resolved before the marker; exact-deadline events remain excluded by the shared half-open predicate.
4. Surface action consumption, approval/run transitions, and approval/run/progress event records now commit with a durable workflow action outbox in one SQLite transaction. The action resolver retries Redis publication from that outbox on delivery, timer reconciliation, and restart. The progress projector independently projects pending progress rows and marks them only after a successful card update, preventing event loss or consumed-event redelivery from leaving a card stale.
5. Restricted `just-bash` workspace writes now validate every write, append, mkdir, remove, copy destination, move source/destination, chmod, hard-link destination, and timestamp mutation. Workspace symlink creation is denied, protected reads/sources remain denied, the writable root must be canonical, and the base filesystem rejects `..` mount escapes. `.git`, `.env*`, `core-config.yaml`, credential directories, and secret directories cannot be read or changed. Level-1 shared edits use the same expanded secret-directory protection.
6. Receipt convergence reaches the existing unique durable live-parent delivery record for generated subagents. Deferred completion remains pending exactly once until acknowledgement; synchronous completion is consumed without deferred redelivery. Action outbox recovery projects one idempotent progress card state rather than creating duplicate cards.

### Adjacent Boundary Hardening

- `skills.full` is no longer callable or discoverable by workflow children because full skill expansion may cross the reviewed project/global/symlink capability boundary. `skills.list` and bounded `skills.brief` remain available when external reads are approved.

### Regression Coverage

- Added a deterministic receipt-wins-publication test that asserts succeeded operation state, usage, final run state, and final run result.
- Added stale-old-runner versus newer-unpublished-epoch receipt fencing and generated subagent receipt assertions.
- Added ordered historical reply/barrier, exact-deadline, durable single-resolver lease, and restart timer coverage.
- Added action publication failure, process restart, outbox replay, direct projector recovery, and no-duplicate-card assertions.
- Added reproduced restricted-bash overwrite, append, remove, move, copy, mkdir, hard-link, symlink, and mount-escape attempts against protected workspace paths.
- Full validation passed: core 1087 tests, event bus 21 tests, tool bridge 22 tests, plugin runtime 8 tests, utils 215 tests, root harness 3 tests, repository typecheck, remote runner/tool bridge/ACP builds, lint, format, and diff checks.

### Proven False Positives

None.

### Remaining Medium/Deployment Residuals

- Live Discord/GitHub credential smoke tests remain deployment validation; deterministic adapter, projector, capability, outbox, and concurrency tests cover the reviewed paths in CI.
- Production still requires Bubblewrap, a user systemd manager, delegated cgroup v2 memory/PID controls, and user namespaces. Workflow execution has no unsandboxed fallback.
- Workflow profiles intentionally cannot launch arbitrary host package-manager/compiler processes. Any broader executable policy remains a separate security design and review.
- Independent security/concurrency review is required before any production-readiness claim.
