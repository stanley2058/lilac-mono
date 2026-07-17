# Workflow Runtime Simplification

Status: active implementation plan.

This document supersedes `plan/unified-programmatic-workflows.md` and
`plan/workflow-agent-autonomy.md`. The concise source plan is
`plan/workflow-rewrite.md`; implementation progress is tracked in
`plan/workflow-runtime-simplification.todo.md`.

## Contract

A workflow is a deterministic, replayable program that orchestrates ordinary
agent requests. The workflow runtime owns durable operation identity, dispatch
epochs, claims, receipts, waits, triggers, replay, and progress delivery.

Agent authority comes entirely from the selected native profile. A workflow
launch uses the same profile assembly, tools, Bash behavior, and generic
request-bound Level-2 capability as a direct launch. The workflow layer adds no
path, network, tool, prompt, cwd, or invocation security policy.

The program executor is a plain Bun subprocess. The child keeps its existing
determinism lockdown and NDJSON protocol. The host retains wall-time,
cancellation, output-size, and protocol limits. `maxRuntimeMemoryBytes` is
removed because a plain Bun subprocess does not enforce that contract.

## Durable Invariants

- Deterministic request IDs remain stable for a run, operation, and attempt.
- A dispatch has one active owner and one terminal receipt per dispatch epoch.
- Stale owners and stale epochs cannot publish terminal outcomes.
- The resolved model request is pinned in the durable dispatch policy and is
  reused during replay.
- Terminal journal history remains readable across schema migration.
- Nonterminal runs using the old operation or dispatch contract are
  quarantined and terminalized with an explicit migration reason.
- Existing waits, triggers, completion deliveries, and restart recovery remain
  durable.

## Implementation Sequence

1. Establish this plan and mark earlier plans historical.
2. Land schema v21 atomically with the minimal dispatch envelope, operation
   input cleanup, worktree removal, policy identity cleanup, and old-run
   quarantine. This avoids strict-schema failures while reading persisted v20
   dispatches.
3. Make workflow children use ordinary profile assembly and generic Level-2
   request capabilities, then remove workflow tokens, path authority, scratch,
   trusted Bash, and invocation gates.
4. Spawn the deterministic program child directly with Bun and remove
   systemd, Bubblewrap, cgroup, and user-namespace deployment requirements.
5. Simplify progress projection for one Core process while retaining one
   durable binding, edit coalescing, startup reconciliation, controls, retries,
   and terminal cards.
6. Remove stale plugin, bridge, configuration, prompt, skill, and documentation
   concepts.
7. Prune tests for deleted security machinery and validate replay, receipts,
   epochs, waits, triggers, restart, projection, package types, builds, lint,
   formatting, and the Docker image.

## Explicit Non-Goals

- Do not alter workflow source call-site discipline in this rewrite.
- Do not simplify wait-resolver checkpoint or trim behavior.
- Do not weaken dispatch epochs, ownership fencing, terminal receipts, or
  resolved-model pinning.
- Do not add compatibility shims for active v20 runs; quarantine them clearly.
