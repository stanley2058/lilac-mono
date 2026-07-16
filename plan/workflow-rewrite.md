# Plan: Workflow Subsystem → Pure Orchestration Runtime

## End state (mental model)

- A workflow is **just a durable program**: deterministic replayable JS that dispatches ordinary agent requests, sleeps, waits for replies, and runs on triggers.
- A workflow child agent is **indistinguishable from any other agent request**: normal profile assembly (`explore`/`general`/`self`), normal tools, normal bash, normal Level-2 access. The workflow layer contributes only durability plumbing: deterministic request ID, dispatch epoch, single-owner claim, terminal receipt, pinned resolved model for replay.
- No workflow-specific security anywhere: no control tokens, no path/denied-root/network policy, no tool allowlists, no exposure profiles, no invocation gate, no cwd guarding (`agent()` takes any cwd; concurrent agents in same or different cwd are fine).
- Program executor is a plain `bun` subprocess (determinism lockdown stays; bwrap/systemd goes).

## Salvaged (the keep list)

`durable-workflow-store` core (journal/replay/receipts/epochs/waits/triggers/completion-deliveries), `workflow-engine`, `workflow-definition` + `workflow-source-compiler` + sandbox NDJSON protocol & child determinism lockdown, `workflow-wait-resolver`, `workflow-trigger-scheduler`, `cron`, `workflow-live-parent-bridge`, `workflow-subagent-dispatcher` (+`subagent.ts` wiring), `workflow-artifact-store`, `workflow-definition-store`, progress projector/view (simplified), `programmatic-workflow.ts` tool, `evt.workflow.*` bus contracts, workflow-authoring skill (rewritten).

## Steps

### Wave 0 — Baseline and plan docs

1. Commit the current working tree as the strip-down base (approvals already removed there).
2. Write `plan/workflow-runtime-simplification.md` + `.todo.md`; mark `unified-programmatic-workflows.md` and `workflow-agent-autonomy.md` as historical (both superseded).

### Wave 1 — Children become ordinary agent requests (the pivotal change)

3. Shrink `WorkflowRequestPolicy` → minimal dispatch envelope: `{runId, operationId, dispatchEpoch, profile, model, reasoning, resolvedModelRequest, cwd, originSession}`. Drop canonical roots, dev/inode identities, safetyMode, isolation, scratch root, control-token issuance.
4. `bus-agent-runner`: keep hint parse + claim/heartbeat/receipt + epoch headers + pinned model + profile consistency. Delete token authorization, inode/realpath/scratch/denied-root assertions, `workflowPolicy`/`workflowControlToken` metadata injection, forced `edit_file`, workflow tool-surface prompt overlay (`subagent-prompt.ts`).
5. `local-tools.ts`: remove `enforceWorkflowLevel1Boundary` wrapping, scratch tools, all workflow conditionals (apply_patch/fuzzy_search denial, forced `node-rg`).
6. `create-tool-server.ts`: delete workflow control-token auth path, `isCallableAllowedForWorkflowChild`, `assertWorkflowNetworkInput`, `authorizeWorkflowPathInput`. Keep operator + control-capability paths (generic, non-workflow). Workflow children reach Level-2 exactly like any agent.
7. `programmatic-workflow.ts`: remove origin/principal/operator gating — no invocation gate. Remove `origin_safety_mode` gating in store (`tryClaimTrustedRun` etc.).

### Wave 2 — Delete the security layer

8. Delete: `workflow-level1-boundary.ts`, `workflow-path-authority.ts`, `workflow-protected-path.ts`, `workflow-denied-root-policy.ts`, `workflow-network-policy.ts`, `workflow-descriptor-path.ts`, `workflow-scratch.ts`.
9. `restricted-bash.ts`: delete `executeTrustedWorkflowBash` + all `TrustedWorkflow*` helpers + tools proxy (~1,450 lines); relocate the one shared protected-path helper the non-workflow restricted bash uses. `bash.ts`: delete workflow branch — workflow children get whatever bash their profile gets.
10. `web.ts`/`content-inspect.ts`: remove `fetchWorkflowPublicUrl` usage; keep the generic 25 MiB inspect cap (harmless, generic).
11. Shrink `workflow-operation-policy.ts`: `agent()` schema = `{prompt, options{profile, cwd?, model?, reasoning?, label?}}` — drop `isolation`, denied-root asserts, identity capture. Free-form cwd, no containment.

### Wave 3 — Plain-subprocess program executor

12. `workflow-sandbox.ts`: drop `assertWorkflowSandboxAvailable` + systemd-run/bwrap command build; spawn `bun --smol workflow-sandbox-child.js` directly. Keep NDJSON protocol, manifest verification, cancellation, wall-time via host timer. Keep child determinism lockdown as-is.
13. Docker: remove `verify-workflow-runtime.sh`, `user-manager-delegate.conf`, cgroup-delegation and user-namespace requirements; simplify entrypoint (operator token + log forwarding can stay without systemd PID1 if feasible). Update `docs/docker-deployment.md`, `compose.yaml`.

### Wave 4 — Store/schema cleanup

14. Delete worktree stack: `workflow-worktree-artifact.ts`, `workflow_worktree_outputs` + methods, engine branches, `isolation` everywhere, tool `worktree-output` subcommand.
15. New schema migration (v21/next): drop approval residue (`workflow_approvals`, `approval_id` cols), `token_sha256`, worktree tables, safety-mode columns; shrink `policy_json` to the new envelope. Existing journaled dispatches: terminalized runs stay readable; nonterminal old runs quarantined with explicit reason (same pattern as schema 20).
16. Remove `matchesWorkflowRequestPolicyIdentity` inode/root comparisons → compare only the minimal envelope fields.

### Wave 5 — Projector simplification

17. Assume single core process (matches the rest of lilac-mono): strip projection claims/generations, orphan journals, marker-based card discovery, outbox leases. Keep: one durable binding per run, coalesced edit-on-change, startup reconciliation, pause/resume/cancel buttons, terminal cards.

### Wave 6 — Config, plugins, docs

18. Remove workflow Level-2 exposure: `plugins/manager.ts` branches, `server-tools.ts` `workflowExposure` metadata, `plugin-runtime/types.ts` fields, `plugins.workflowExternal` from core-config v2 (+v1 fallback removal note in `MIGRATIONS.md`, example yaml).
19. Rewrite `workflow-authoring` SKILL.md for the reduced contract; update `PROJECT.md` ("workflows orchestrate; profiles authorize"), `MIGRATIONS.md`, `TOOLS.md`.
20. Tool-bridge: remove dead `x-lilac-workflow-capability` header; keep operator mode (generic, though its main consumer is gone — optional later removal).

### Wave 7 — Validation

21. Prune the large body of security-exploit tests tied to deleted machinery; keep runtime/durability tests (replay, receipts, epochs, waits, triggers, restart, projector).
22. `bun test` (core, event-bus, utils, tool-bridge, root harness), `bunx tsc` per changed package, remote-runner build, `bun run lint:fix`, `bun run fmt`.

## Explicitly out / follow-ups

- **Not touching**: deterministic replay core, receipts/epochs/fencing (that's the runtime's actual value), wait-resolver checkpoint/trim machinery (works; optional later simplification).
- **Follow-up candidate**: relax the strict AST host-call discipline in `workflow-definition.ts` (helpers callable from exactly one site, no host calls in plain loops) via occurrence-based operation identity — an authoring-usability win, separable from this wave.

Net effect: roughly **10–15k lines deleted** (incl. tests), Docker loses the systemd/bwrap/cgroup requirements, and the workflow subsystem becomes what it should have been: a focused durable orchestration runtime where all agent authority comes from profiles.
