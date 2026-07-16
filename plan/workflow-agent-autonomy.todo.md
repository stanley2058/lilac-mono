# Workflow Agent Autonomy Todo

Source: `plan/workflow-agent-autonomy.md`

This is the main live implementation tracker. Workflow is runtime and durability, not guardrails. Native profile behavior must be identical for direct and workflow-launched subagents.

Status key: `[ ]` pending, `[~]` in progress, `[x]` factually complete and still aligned, `[-]` explicitly deferred.

## 2026-07-17 Direction Change

- [x] Establish the stronger invariant: workflow owns orchestration/durability only; server-owned native profiles optionally own tools, network, writes, execution, and delegation for every launch path.
- [x] Reject workflow-specific behavioral restrictions even where the current implementation and tests are complete.
- [x] Preserve only direct Level-1 secret/root/Core authority and credential-injection boundaries plus Level-2 durable correctness.
- [x] Require a demonstrated direct retained-boundary crossing; speculative multi-step or paired attacks are not implementation blockers.
- [x] Require the full plan to finish before one final usability-first review/fix/validation loop.
- [x] Require optional worktrees and profile-configured direct network in the full implementation rather than leaving either workflow-gated.

## Stage 0: Aligned Completed Foundation

- [x] Start from the clean baseline after commit `78c065c`.
- [x] Use profile-native `agent()` options: required `profile`; optional `cwd`, `model`, `reasoning`, `label`, and `isolation`.
- [x] Default cwd to invocation cwd and isolation to `shared`.
- [x] Remove authored `editing`, `tools`, `executables`, `level2Callables`, `surfaceOriginOperations`, and `delegation` capability-envelope fields.
- [x] Remove human approval from authenticated trusted-main-agent execution while denying public, restricted, forged, unauthenticated, synthetic, and stale origins.
- [x] Preserve immutable snapshots, journals, ownership, dispatch epochs, publication fencing, terminal receipts, cancellation, waits/triggers, and Redis correlation.
- [x] Complete the breaking runtime/schema v3/20 migration, quarantine incompatible nonterminal state, remove executable old-envelope state, and retain bounded historical audit data.
- [x] Preserve the requested/resolved profile in top-level generated delegation and normal bounded nested `self` delegation.
- [x] Implement broad canonical service-UID cwd, shared family scratch, concurrent shared writers, secret-free child environments, cgroups, cancellation, and process cleanup.
- [x] Journal resolved model/request context so stale redispatch and receipt adoption do not silently change an already-dispatched operation.

## Stage 1: Centralize Native Profiles

- [x] Inventory every direct and workflow profile assembly path, prompt builder, tool source, plugin source, model resolver, network switch, write rule, and delegation rule.
- [x] Make one server-owned native profile registry/configuration path authoritative for direct and workflow-launched subagents.
- [x] Define useful default `explore`, `general`, and `self` behavior once; allow deployments to optionally configure tools, network, writes, execution, and delegation there.
- [x] Make workflow dispatch carry profile identity and durable request context only, with no workflow-generated behavioral envelope.
- [x] Remove workflow-only profile variants, prompt assembly, tool assembly, plugin opt-ins, write behavior, and delegation behavior.
- [x] Remove `workflowExposure` from plugin/tool metadata, schemas, config, manager APIs, built-ins, fixtures, help, and tests.
- [x] Remove workflow-only callable allow/deny lists and `plugins.workflowExternal`; profile configuration decides callable/plugin availability for every launch path.
- [x] Remove tool effect metadata and effect checks used only to narrow workflow profiles.
- [x] Add parity tests asserting that each native profile has identical prompt, tools, plugins, model choices, network, write behavior, and delegation in direct and workflow launches.

## Stage 2: Remove Workflow Guardrails

- [x] Delete `apps/core/src/workflow/workflow-network-policy.ts`.
- [x] Delete `apps/core/tests/workflow/workflow-network-policy.test.ts`.
- [x] Remove workflow URL/SSRF checks and all inspection of URL schemes, credentials, ports, hosts, DNS answers, private/special ranges, destinations, and redirects.
- [x] Remove workflow-specific network branches from web, content inspection, tool-server creation, proxying, and generated help.
- [x] Remove special workflow prompt/tool narrowing, including workflow-only omission of `apply_patch`, directory-output callables, plugins, Bash, or other native tools.
- [x] Remove project-content blacklists, environment/Git filename restrictions, broad-home/project restrictions, and speculative ancestor rejection.
- [x] Remove temporary implementation gates that exist only because the caller is a workflow.
- [x] Delete or rewrite tests that assert removed guardrails; retain tests only for native profile choices, direct boundaries, or durable correctness.

## Stage 3: Retain And Simplify Direct Boundaries

- [x] Reduce denied roots to exact deployment-owned Core state, runtime-control, service-configuration, and credential roots.
- [x] Allow ordinary project content and broad canonical cwd values while masking or denying only exact protected roots; do not reject an ancestor merely because it contains a protected descendant.
- [x] Strip Core/operator/cloud credentials, credential-helper settings, unsafe config, and unrelated service secrets from child environments.
- [x] Verify no reusable workflow-control or service credential enters a child environment, command line, log, prompt, artifact, or result.
- [x] Keep workflow-control access authenticated, request-bound, durably owned, and unavailable to forged/public origins.
- [x] Verify children cannot run as root or obtain Core process/runtime authority.
- [x] Remove tests and implementation justified only by project-content policy or speculative A+B/C chains.
- [x] Add focused tests for direct secret leakage, exact protected-root access, root/Core authority exposure, and unsafe credential injection.

## Stage 4: Restore Native Tools And Network

- [x] Restore every native-profile tool for workflow launches, including editing, patching, directory-output, Bash, plugins, and Level-2 callables according to profile configuration.
- [x] Restore direct outbound network for workflow-launched subagents whenever the selected native profile enables it.
- [x] Ensure workflow runtime does not defer network pending a workflow-specific proxy, internal-service hardening project, egress policy, SSRF classifier, or audit layer.
- [x] Preserve cgroups, cancellation, process-tree cleanup, bounded output/time, ownership, and terminal receipts without treating them as tool/network policy.
- [x] Verify installed Git, Bun, compilers, tests, package scripts, plugin CLIs, and normal network workflows behave the same through direct and workflow launches.
- [x] Add profile configuration tests for intentionally enabled and disabled tools/network/writes/delegation; test no workflow-only override exists.

## Stage 5: Implement Optional Worktrees

- [x] Keep `shared` as the default and allow readers and multiple writers to overlap without mandatory leases, locks, serialization, or automatic worktrees.
- [ ] Remove the temporary-unavailable worktree rejection and all documentation/tests that treat it as an acceptable final gate.
- [ ] Implement explicit `isolation: "worktree"` for suitable Git-backed cwd values with clear validation errors.
- [ ] Publish a durable patch artifact with base identity, tracked changes, and newly created files before successful cleanup.
- [ ] Expose patch metadata/content through authenticated durable run results or artifact retrieval.
- [ ] Preserve and fence failed, cancelled, conflicting, or ambiguous worktrees for reconciliation without losing successful work.
- [ ] Handle untracked files, nested repositories, submodules, ignored files, conflicts, restart, stale ownership, duplicate receipts, and cleanup as concrete durability cases.
- [ ] Run worktree host operations with the same secret-free environment and exact protected-root boundary as native operations, without introducing workflow-only Git/content/network policy.
- [ ] Add end-to-end worktree create/edit/patch/retrieve/apply/conflict/cancel/restart/reconcile/cleanup tests.

## Stage 6: Durable Correctness Revalidation

- [x] Preserve operation journals, resolved requests, ownership takeover, dispatch epochs, publication fencing, terminal receipts, and stale-run rejection.
- [x] Preserve shared family scratch identity across generated descendants, restart, pause/resume, and takeover.
- [x] Preserve process cgroups, timeout/output bounds, cancellation publication, process-tree cleanup, and terminal quiescence.
- [ ] Revalidate direct/profile parity through stale redispatch and receipt adoption without snapshotting workflow-only restrictions.
- [ ] Revalidate worktree artifacts and cleanup under cancellation, restart, owner replacement, stale epochs, duplicate publication, and ambiguous receipts.
- [ ] Revalidate Redis request/result correlation, waits, triggers, scheduler ownership, progress/result fallback, and terminal cleanup after guardrail removal.
- [ ] Fix only concrete durable corruption or retained direct-boundary failures discovered during this stage.

## Stage 7: Schema, Migration, And Documentation Reconciliation

- [x] Remove executable old capability-envelope and approval behavior from runtime v3/schema 20.
- [x] Remove newly introduced workflow-only exposure/network/effect/profile configuration and stale serialized fields without adding compatibility for unshipped guardrails.
- [x] Update `PROJECT.md` to state that workflow is runtime/durability and native profile configuration is shared by all launch paths.
- [x] Update `MIGRATIONS.md` for removal of workflow-only guardrail config/state where persisted.
- [ ] Update workflow authoring guidance and examples for native profile parity, useful tools/network, broad cwd, shared scratch/races, and implemented optional worktrees.
- [x] Update deployment/security docs to describe only exact authority/credential roots, secret-free children, origin authentication, and durable correctness as workflow boundaries.
- [ ] Remove claims that direct network or worktrees are deferred because execution came through workflow runtime.
- [ ] Ensure schemas, generated help, runtime errors, examples, and tests describe the same final contract.

## Stage 8: Full Implementation Validation

- [ ] Run focused native-profile parity, network, tool, filesystem, delegation, worktree, origin-authentication, secret/root, and migration tests.
- [ ] Run durability tests for snapshots, journals, ownership takeover, epochs, receipts, waits, triggers, cancellation, cgroups, Redis correlation, scratch, artifacts, and cleanup.
- [ ] Run all affected package tests and the monorepo test harness.
- [ ] Build the remote runner required for parity tests.
- [ ] Run TypeScript checks for every changed package.
- [ ] Run root lint fix and formatting after implementation stabilizes.
- [ ] Verify no `workflowExposure`, workflow network policy, callable deny list, workflow-only effect metadata, prompt/tool narrowing, project-content blacklist, network gate, or worktree gate remains.
- [ ] Verify direct and workflow launches are behaviorally identical for the same profile.

## Stage 9: One Final Review And Fix Loop

Do not begin this stage until Stages 1-8 are complete.

- [ ] Perform one usability-first review of the complete implementation.
- [ ] Treat only direct secret leakage/credential injection, direct root/Core authority exposure, or concrete durable corruption/lost work as blockers.
- [ ] Ignore or document speculative “A may cross a boundary when paired with B/C” findings; reject recommendations that recreate workflow guardrails.
- [ ] Fix qualifying findings without adding workflow-specific behavioral policy.
- [ ] Run focused and full validation once more after fixes.
- [ ] Document or defer non-blocking residuals explicitly.
- [ ] Mark completion only after the final implementation -> review/fix -> validation loop closes.

## Deferred Residuals

- [-] Aggregate run-level cgroups may follow later if per-operation cgroups, cancellation, ownership, and cleanup remain correct.
- [-] Exactly-once receipts for arbitrary external side effects may follow later; retain exact dispatch/terminal receipts and document external at-least-once behavior.
- [-] Additional native profile variants may be added for concrete deployment needs, but not as workflow-only policy.

## Superseded Review Work

The completed review waves dated 2026-07-16 and earlier on 2026-07-17 remain factual implementation history, but they are not completion evidence for this direction. Their aligned durability work is retained in the stages above. Their workflow SSRF policy, callable exposure, effect metadata, special prompts/tools, project-content restrictions, direct-network gate, and worktree gate are removal targets and must not be restored under new names.
