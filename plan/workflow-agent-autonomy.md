# Workflow Agent Autonomy Plan

## Handoff Status

This plan follows the review of merged PR #18, `feat: unify programmatic workflow runtime`, at head commit `f2e5afe2e1c197133577b9c382760b3c70ddffdb`.

The review focused on restrictions that reduce main-agent or workflow-child performance rather than on the security, durability, and concurrency hardening already recorded in:

- `plan/unified-programmatic-workflows.md`
- `plan/unified-programmatic-workflows.review.md`
- `plan/unified-programmatic-workflows.todo.md`

At handoff time the worktree contains substantial uncommitted workflow fixes from another agent. Do not revert, overwrite, or fold those changes into this work without first inspecting them. The current changes materially improve per-invocation project-root selection, generated-subagent ownership, and fallback delivery, but they do not resolve the other autonomy findings below.

## Desired Operating Model

An authenticated trusted main agent should decide what work happens where in most user-accessible locations inside the container. The container already runs agents as UID 1000, so normal OS permissions should remain the primary boundary for ordinary files.

Explicit exceptions remain appropriate for:

- Secrets and credential directories.
- Core configuration and environment files.
- Root-owned or otherwise OS-inaccessible files.
- Capabilities that cross an external trust boundary, such as network access, surface identity, or privileged host operations.

Keep workflow JavaScript deterministic, replayable, and isolated from direct side effects. Relaxation should apply primarily to approved agent operations invoked by the workflow, not by exposing filesystem, process, or network primitives directly inside the replayed JavaScript sandbox.

## Current Partial Fix

The uncommitted changes remove the process-wide `LILAC_WORKSPACE_DIR` as the only workflow project root:

- `ProgrammaticWorkflow` resolves a canonical `projectRoot` for each authenticated Level-2 invocation.
- A trusted main agent selects that root by running the workflow command from the intended Level-1 shell cwd.
- Direct generated subagents inherit the parent execution cwd.
- Nested generated subagents retain the approved workflow root rather than an operation worktree path.

This is useful but incomplete. Once a workflow starts, each child operation still receives only the selected root or an engine-created worktree. There is no per-agent cwd selection, and every workflow-policy shell still uses restricted `just-bash`.

## Findings

### P0: Worktree Editing Has No Durable Output

`WorkflowEngine` creates a detached worktree for isolated editing and force-removes it after a successful operation. It does not retain a branch or commit, export a patch, or merge changes into the canonical project.

Impact:

- Editing workflows with `maxConcurrent > 1` must use worktree isolation.
- Successful parallel editors can lose all filesystem changes.
- A single editor configured with worktree isolation has the same loss mode.
- Workflow children cannot use host Git through restricted `just-bash` to establish their own durable handoff.

Relevant code:

- `apps/core/src/workflow/workflow-engine.ts`, worktree preparation and cleanup.
- `apps/core/src/workflow/workflow-domain.ts`, parallel editing constraint.

Required outcome:

- A successful isolated editing operation must produce an explicit durable result before cleanup.
- Choose one reviewed protocol: retained commit/ref, captured patch artifact, or a host-mediated apply/merge operation.
- Never report successful editing while silently deleting the only copy of the changes.
- Preserve ambiguous or failed worktrees for reconciliation under the existing fenced recovery rules.

### P0: Trusted Workflow Agents Cannot Use Container Executables

`bashToolWithCwd` selects `executeRestrictedBash` whenever a workflow policy exists, even when the approved run is trusted. Restricted bash is an in-memory `just-bash` interpreter with mounted workspace and session-temp filesystems.

Impact:

- No normal `bun`, Git, package manager, compiler, test runner, browser, language runtime, project script, or installed CLI execution.
- A workflow agent cannot perform the same verification loop as the main agent.
- The limitation applies after explicit workflow review and approval, not only in public/restricted sessions.

Relevant code:

- `apps/core/src/tools/bash.ts`
- `apps/core/src/tools/restricted-bash.ts`
- `apps/core/src/surface/bridge/bus-agent-runner.ts`

Required outcome:

- Approved trusted workflow agents can use the normal UID-1000 local execution path.
- Secret and protected-path exclusions remain enforced independently of shell selection.
- Restricted-origin workflows continue to use restricted execution.
- If executable authority must be reviewed separately, represent it explicitly in the capability profile rather than making all workflows permanently restricted.

### P1: Location Authority Is Workflow-Wide, Not Per Operation

The current uncommitted project-root work lets the main agent choose a root per workflow invocation, but an `agent()` call cannot select a cwd within the approved authority envelope. The engine always chooses the canonical project root or a generated worktree.

Impact:

- A child cannot dynamically move to another user-accessible directory or sibling project.
- Multi-repository workflows require separate invocations or an excessively broad root.
- Restricted bash silently maps out-of-root cwd values back to `/workspace`, which can run a command in the wrong location without a clear failure.

Required outcome:

- Add a reviewed per-agent `cwd` option.
- Authorize it against an explicit set of allowed roots or a declared root envelope.
- Reject unauthorized cwd values; never silently substitute another directory.
- Preserve canonicalization and symlink protections where they enforce authority rather than merely restrict convenience.

### P1: Capabilities Cannot Express Mixed Agent Roles

`editing` and `isolation` are workflow-wide. Edit-capable workflows cannot include the `explore` profile, and `agent()` cannot narrow or select editing authority per operation.

Impact:

- The common pattern of parallel read-only exploration followed by one editor cannot be represented in one workflow.
- Authors must use more expensive profiles for exploration or split orchestration across workflows.
- Every enabled non-explore agent receives the same editing authority even when only one operation needs it.

Required outcome:

- Treat revision capabilities as the maximum approved envelope.
- Let each `agent()` operation select a narrower profile containing fields such as `editing`, `isolation`, tools, cwd, and reasoning.
- Permit read-only explore operations alongside editing general/self operations.
- Keep concurrency safety checks based on the actual editing operations, not a single workflow-wide boolean.

### P1: External and Surface Capabilities Are Misleading Booleans

`externalTools: true` currently exposes only `search`, `discovery.search`, `skills.list`, and `skills.brief`. `surfaceSends: true` exposes only same-session `surface.messages.send`.

Impact:

- No fetch/content inspection, browser, generation, SSH, attachment, conversation, or plugin callables.
- No surface read, edit, delete, reactions, or reviewed cross-session coordination.
- The names imply broad capability while runtime behavior is a small hard-coded subset.

Required outcome:

- Replace or supplement booleans with explicit reviewed callable allowlists.
- Support capability groups only as authoring shorthand that normalize to concrete callable IDs.
- Bind surface permissions to explicit allowed destinations and operations.
- Keep path authorization for callables that accept local files.
- Include plugin callable IDs in review identity so dynamically loaded tools cannot expand an existing grant.

### P1: User-Authored Workflow Agents Cannot Dynamically Delegate

Workflow request policy enables `subagent_delegate` only for runs with a `live_parent` completion target. Normal user-authored workflow runs use durable-surface or detached completion targets, so their child agents cannot decide to delegate discovered work.

The current uncommitted changes improve nested delegation ownership and fallback for generated subagent runs, but do not change this gate.

Required outcome:

- Add an explicit subagent capability to user-authored workflow revisions.
- Bound child depth, total agents, models, profiles, tools, editing authority, and completion delivery under the parent revision envelope.
- Journal dynamically delegated children as descendants of the invoking operation.
- Preserve durable completion and cancellation semantics already used by generated delegation workflows.

### P2: Wait API Advertises Unsupported Platforms

`waitForReply` accepts multiple platform values in its schema, but runtime permits only the exact authenticated originating Discord session and user.

Impact:

- GitHub and other platform definitions validate and receive approval before failing when the wait executes.

Required outcome:

- Either implement each advertised platform or reject unsupported platforms during definition/argument validation.
- Prefer capability discovery from active adapters so the authoring skill can describe the actual deployment.
- Keep reviewer and destination authorization deterministic and server-owned.

### P2: Progress Selection Is Ignored

`progress.requestOrigin` is parsed and included in invocation fingerprints but is not used to choose behavior. With a reviewer, progress is always projected to the origin, even when `progress` is omitted. Explicit targets must equal the origin.

Required outcome:

- Define clear modes such as `origin`, `detached`, and reviewed explicit target.
- Make omitted progress behavior explicit and documented.
- Remove fields that are not implemented rather than hashing no-op inputs.
- Ensure idempotency fingerprints contain only behaviorally meaningful values.

### P2: Model Declarations Can Fail Only After Dispatch

Definition validation accepts arbitrary model strings. The agent runner later permits only `inherit` or configured `models.def` aliases with `agentCanSelect: true`.

Required outcome:

- Validate model aliases against current server configuration before review/trigger.
- Return a deterministic validation error listing acceptable aliases.
- Include relevant model-routing configuration identity in the revision or revalidate it before every dispatch.
- Add per-agent reasoning selection bounded by the approved model profile.

### P2: `parallel` Accepts an Ineffective Concurrency Option

`parallel(promises, { concurrency })` receives already-started promises and then calls `Promise.all`. Its concurrency option has no per-block effect; only the workflow-wide semaphore limits agent dispatch.

Required outcome:

- Remove the option, or redesign `parallel` to receive lazy callbacks/items so it can enforce concurrency.
- Keep `pipeline` for bounded mapped fan-out.
- Add a test demonstrating that a block-level concurrency limit changes maximum simultaneous operations.

### P3: Workflow Source Is Needlessly Non-Composable

Definitions permit exactly one import followed by one default export. They cannot contain top-level helper functions/constants or import reviewed local helper modules. Runtime also removes time, ID, and logging APIs without deterministic replacements.

Impact:

- Large generated workflows become one nested `run` method.
- Shared orchestration logic cannot be factored or reused.
- Scheduled workflows cannot read a deterministic run timestamp or generate stable operation-local IDs.

Required outcome:

- First allow top-level pure declarations in the same source file.
- Consider reviewed local-module bundling only after snapshot identity covers the full dependency graph.
- Provide deterministic host values such as run start time, scheduled fire time, run ID, and stable ID derivation.
- Keep dynamic imports, ambient dependencies, and direct side effects forbidden in replayed code.

## Proposed Capability Shape

The exact schema should be designed with existing review identity and migrations, but the direction should resemble a maximum envelope rather than one global execution mode:

```js
capabilities: {
  agents: {
    profiles: ["explore", "general", "self"],
    models: ["inherit", "fast", "deep"],
    reasoning: ["low", "high"],
    maxConcurrent: 8,
    maxTotal: 40,
    maxDepth: 3,
    allowedRoots: ["project", "/home/lilac/shared"],
    tools: ["bash", "read_file", "glob", "grep", "apply_patch", "subagent_delegate"],
    executables: "trusted-container",
    editing: ["shared", "worktree"],
  },
  level2: {
    callables: ["fetch", "search", "content.inspect", "surface.messages.send"],
  },
  surfaces: {
    destinations: ["origin"],
  },
}
```

Each operation should select a subset:

```js
await agent("Implement and verify the fix", {
  profile: "general",
  model: "deep",
  reasoning: "high",
  cwd: args.projectPath,
  editing: "shared",
  tools: ["bash", "read_file", "apply_patch"],
});
```

Do not preserve this example verbatim if a smaller schema fits the existing domain model. The important property is that review grants a bounded maximum while the workflow and child agent can make narrower runtime choices.

## Implementation Sequence

### Phase 1: Prevent Lost Work

1. Specify the isolated-edit result contract.
2. Capture and persist a patch artifact or retained Git ref before worktree cleanup.
3. Add an explicit apply/merge operation with conflict reporting.
4. Verify cancellation, pause, restart, ambiguous receipt, and cleanup behavior.
5. Block worktree editing configurations until a durable output path exists if a safe implementation cannot land immediately.

### Phase 2: Restore Trusted Container Execution

1. Separate workflow trust mode from workflow request authentication.
2. Route approved trusted agent operations through normal local bash under UID 1000.
3. Apply protected-path and secret policy independently of shell implementation.
4. Add explicit executable/tool authority to capability review.
5. Verify builds, tests, package-manager commands, browser commands, cancellation, and output artifacts from a workflow child.

### Phase 3: Per-Agent Authority

1. Extend `agent()` options and schemas with cwd, reasoning, editing/isolation, tools, and delegation policy.
2. Convert revision capabilities into a maximum envelope.
3. Authorize each operation as a subset of that envelope.
4. Permit mixed explore and editing operations.
5. Carry the narrowed operation policy through durable dispatch receipts and recovery.

### Phase 4: Explicit Level-2 and Surface Grants

1. Replace hard-coded workflow-child sets with reviewed callable IDs.
2. Add destination-scoped surface grants.
3. Include plugin/tool identity in approval hashing or runtime revalidation.
4. Preserve descriptor-backed local-path authorization.
5. Update tool listing/help so children see exactly the approved surface.

### Phase 5: Correct Interface Mismatches

1. Align wait schemas with implemented adapters.
2. Implement meaningful progress modes.
3. Validate configured model aliases before review.
4. Fix or remove `parallel` concurrency.
5. Add deterministic workflow context values.

### Phase 6: Improve Authoring Composition

1. Permit safe top-level pure declarations.
2. Update static validation and call-site instrumentation.
3. Decide whether local helper-module snapshotting is necessary.
4. Update the bundled workflow-authoring skill with capability and worktree examples.

## Acceptance Criteria

1. A trusted approved workflow child can run the same project build and test commands as the trusted main agent, subject to UID-1000 permissions and protected-secret policy.
2. A main agent can select an unrelated user-accessible project root without changing global runtime configuration.
3. An individual `agent()` operation can choose an authorized cwd and receives a clear denial for an unauthorized cwd.
4. One workflow can use parallel read-only explore agents followed by a shared or isolated editing agent.
5. Successful worktree editing produces a durable patch/ref and cannot be silently deleted.
6. Workflow revisions explicitly identify allowed Level-1 tools, Level-2 callables, surface operations, destinations, and delegation bounds.
7. User-authored workflow children can dynamically delegate when the revision permits it.
8. Unsupported wait platforms and model aliases fail validation before review or execution.
9. Progress options alter actual projection behavior and no accepted field is a no-op.
10. `parallel` concurrency is either enforced or absent from the public API.
11. Existing approval, immutable snapshot, receipt, replay, cancellation, redaction, and recovery guarantees continue to pass.

## Test Plan

- Unit tests for capability subset validation and per-operation policy serialization.
- Integration test running `bun test` or an equivalent installed executable from a trusted workflow child.
- Integration test proving protected secret paths remain unavailable to that child.
- Multi-root tests covering sibling projects and explicit cwd denial.
- Mixed-profile workflow test with explore fan-out and one persistent editor.
- Worktree patch/ref persistence, apply, conflict, cancellation, pause, restart, and cleanup tests.
- User-authored nested delegation tests covering total/depth bounds and fallback delivery.
- Level-2 callable-list tests driven by explicit grants, including plugins.
- Discord and GitHub wait validation/execution parity tests.
- Progress-mode tests for origin, detached, and explicit destination.
- Model alias and reasoning validation tests against runtime configuration.
- Replay tests for deterministic context values and refactored top-level helpers.

Final validation should follow repository guidance:

```bash
bun test
bunx tsc -p apps/core/tsconfig.json --noEmit
bunx tsc -p packages/plugin-runtime/tsconfig.json --noEmit
bun run lint:fix
bun run fmt
```

## Non-Goals

- Do not give replayed workflow JavaScript direct ambient filesystem, process, network, or secret access.
- Do not run workflow agents as root or add privileged container execution.
- Do not weaken approval identity, immutable snapshots, durable receipts, or recovery fencing.
- Do not add compatibility layers for unshipped capability schemas unless persisted production data requires a migration.
- Do not make every external tool available implicitly; authority should be visible in review.

## Suggested Skills

- `typehint`: use when extending workflow policy, plugin runtime context, and agent option types.
- `writing-great-skills`: use when revising `packages/utils/builtin-skills/workflow-authoring/SKILL.md` after the runtime contract stabilizes.

## First Decision Needed

Choose the trusted execution boundary before implementation:

1. Preferred: normal UID-1000 local tools for trusted approved operations, with independent protected-path/secret controls and explicit reviewed capabilities.
2. Alternative: an OS-sandboxed executable runner that exposes a reviewed command/tool set while mounting approved roots.

The first option best matches the stated operating model and avoids creating a second, permanently weaker agent runtime.
