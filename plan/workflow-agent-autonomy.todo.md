# Workflow Agent Autonomy Todo

Source: `plan/workflow-agent-autonomy.md`

Status key: `[ ]` pending, `[~]` in progress, `[x]` reviewed complete, `[-]` explicitly deferred.

## Existing Uncommitted Work

- [x] Review and preserve the inherited per-invocation project-root, generated-subagent ownership, and durable fallback changes.
- [x] Verify inherited changes with targeted tests and typechecking before treating them as a baseline.

## P0 Correctness

- [~] Define a durable result contract for successful isolated worktree editing.
- [~] Persist a patch, ref, or host-applied result before successful worktree cleanup.
- [ ] Preserve failed or ambiguous isolated work for fenced reconciliation.
- [~] Allow approved trusted workflow children to use normal UID-1000 container executables.
- [~] Keep restricted-origin workflow execution on the restricted shell path.
- [~] Enforce protected paths and secret exclusions independently of trusted shell selection.

Current P0 review blockers:

- [ ] Capture or explicitly preserve ignored files, nested repositories, and dirty submodules before cleanup.
- [ ] Expose isolated-edit patch metadata/content through an authorized run API and progress/result view.
- [ ] Quarantine legacy/replayed worktrees whose original base commit was never journaled.
- [ ] Run patch capture without Core credentials/network/helper execution, with timeout and cancellation.
- [ ] Avoid unbounded Bubblewrap mask arguments on real Bun workspaces.
- [ ] Make reviewed Bun and local Git operations actually available without exposing credential-bearing metadata.

## P1 Authority Envelope

- [x] Add per-agent `cwd` selection within reviewed allowed roots, with explicit denial outside them.
- [x] Allow each agent operation to narrow profile, model, reasoning, editing/isolation, tools, and delegation authority.
- [x] Permit mixed read-only exploration and editing operations in one workflow.
- [x] Base editing concurrency checks on actual editing operations.
- [x] Replace misleading Level-2/surface booleans with concrete reviewed callable and destination grants.
- [x] Include dynamic plugin callable identity in review and runtime presence checks.
- [-] Implement bounded dynamic user-authored child delegation in a separate wave; this wave persists and carries only the operation-level delegation policy.

## P2 Interface Correctness

- [ ] Reject unsupported wait platforms before approval or execution.
- [ ] Make progress selection behaviorally meaningful, or remove no-op inputs.
- [ ] Validate model aliases before review/dispatch and bound reasoning selection.
- [ ] Enforce block-level `parallel` concurrency or remove the ineffective option.

## P3 Authoring

- [~] Permit safe top-level pure declarations in workflow source.
- [ ] Provide deterministic run context values and stable ID derivation.
- [x] Update workflow authoring documentation with the normalized P1 runtime contract.

Current P3 review blockers:

- [ ] Reject host API aliases, computed calls, and writes that bypass call-site instrumentation.
- [ ] Enforce a parent-validated host-call manifest and harden transport primordials against workflow mutation.
- [ ] Make helper invocation identity deterministic under concurrent reuse and replay.
- [ ] Replace ambient-global denylisting with a deterministic allowlist or close known time/scheduling gaps.

## Validation And Review

- [x] Run focused workflow, runner, tool, and security-boundary tests.
- [x] Run changed-package TypeScript checks.
- [x] Run root `bun run lint:fix` and `bun run fmt`.
- [x] Review for overly restrictive policy and regressions to approval, snapshot, receipt, replay, cancellation, redaction, and recovery guarantees.
- [ ] Record lower-priority residual issues explicitly; leave no P0/P1 blocker unaddressed.
