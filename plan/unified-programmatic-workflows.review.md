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
