# Workflow Runtime Simplification Todo

Source: `plan/workflow-runtime-simplification.md`

Status key: `[ ]` pending, `[~]` in progress, `[x]` complete.

## Wave 0: Baseline and Plans

- [x] Commit the strip-down baseline and source rewrite plan.
- [x] Add the active implementation plan and tracker.
- [x] Mark superseded workflow plans and trackers historical.

## Wave 1: Durable Request Contract

- [x] Add schema v21 and atomically shrink persisted dispatch policy.
- [x] Quarantine and terminalize nonterminal v20 runs and operations.
- [x] Keep terminal runs, journals, results, and receipts readable.
- [x] Reduce resolved `agent()` input to profile, cwd, model, reasoning, label.
- [x] Remove worktree outputs, isolation, approval residue, safety mode, and
  workflow bearer-token storage.
- [x] Preserve pinned resolved-model identity and dispatch fencing tests.

## Wave 2: Ordinary Child Requests

- [x] Use the generic request-bound Level-2 capability for native child
  profiles, regardless of direct or workflow launch.
- [x] Remove workflow control-token and policy metadata from the runner and
  tool server.
- [x] Remove workflow scratch, path, root, descriptor, network, prompt, and
  local-tool branches.
- [x] Remove trusted workflow Bash and route children through profile behavior.
- [x] Remove the workflow invocation principal/origin gate.

## Wave 3: Plain Bun Executor and Docker

- [x] Spawn `bun --smol workflow-sandbox-child.js` directly.
- [x] Retain NDJSON validation, determinism lockdown, cancellation, wall-time,
  output bounds, and forced termination.
- [x] Remove the unenforced workflow runtime memory-limit contract.
- [x] Remove systemd, Bubblewrap, cgroup, and user-namespace deployment setup.
- [x] Preserve generic operator-token setup in the direct container entrypoint.

## Wave 4: Single-Process Projector

- [x] Remove projection claims, generations, marker discovery, orphan journals,
  and outbox leases.
- [x] Keep one durable binding per run, edit-on-change, startup reconciliation,
  retry state, controls, and terminal cards.
- [x] Keep durable action completion state so restart cannot double-publish an
  action.

## Wave 5: Config, Skills, and Docs

- [x] Remove residual workflow path/control fields from plugin contracts.
- [x] Remove the dead tool-bridge workflow-capability header.
- [x] Rewrite workflow authoring and project/tool/deployment documentation.
- [x] Record schema and behavior changes in `MIGRATIONS.md`.

## Wave 6: Validation

- [x] Prune tests belonging only to deleted workflow security machinery.
- [x] Test Core, event bus, utils, tool bridge, and the root harness.
- [x] Typecheck every changed package.
- [x] Build the remote runner and tool bridge.
- [x] Validate the simplified Docker image.
- [x] Run root lint fixes and formatting.
