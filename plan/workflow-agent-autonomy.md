# Workflow Agent Autonomy

> Historical design only. `plan/workflow-runtime-simplification.md` supersedes
> this transitional autonomy and workflow-security model.

## Status

This document replaces the earlier capability-envelope direction as of the clean baseline after commit `78c065c` and incorporates the 2026-07-17 direction change below.

The product priority is agent usability. The workflow subsystem provides runtime and durability; it is not a guardrail system and must not own behavioral restrictions. Every behavioral choice is either removed or expressed once in optional server-owned subagent profile configuration shared by workflow and non-workflow launches.

## 2026-07-17 Direction Change

Earlier implementation and review added workflow-specific restrictions for network destinations, callable exposure, prompts, tools, project content, write paths, and delegation. That direction is rejected even where the restriction was implemented and tested successfully.

The stronger invariant is:

- A native profile behaves identically whether launched directly or through a workflow.
- A workflow carries profile identity and durable request context only. It does not reconstruct, narrow, expand, or inspect profile behavior.
- The server-owned profile registry may optionally configure tools, network, writes, execution, and delegation. The same registry and assembly path serve workflow and non-workflow subagents.
- Workflow runtime code owns orchestration and Level-2 durable correctness, not behavioral policy.
- Preserve direct Level-1 boundaries only for actual secret access, root or Core authority, exact deployment control roots, and unsafe credential injection.
- Do not add a restriction for a speculative multi-step or paired attack. Require a demonstrated direct crossing of a retained boundary.

Consequences of this change:

- Delete `apps/core/src/workflow/workflow-network-policy.ts` and `apps/core/tests/workflow/workflow-network-policy.test.ts`.
- Remove workflow-specific `workflowExposure`, callable deny lists, URL/SSRF policy, workflow-only tool effect metadata, special prompt/tool narrowing, project-content blacklists, and temporary tool or worktree gates.
- Workflow runtime does not inspect URLs, destinations, private ranges, protocols, ports, DNS results, or redirects. Network behavior comes from the selected native profile.
- Restore useful direct network and native tools according to profile configuration during the full implementation. Do not defer them merely because the launch came through workflow runtime.
- Implement `isolation: "worktree"` as an optional usable mode. Do not leave it schema-visible but runtime-gated.

## Ownership Model

### Workflow Runtime And Durability

Workflow code owns:

- Agent dispatch order, parallelism, pipelines, waits, triggers, cancellation, and result assembly.
- Immutable workflow source and input snapshots.
- Durable operation journals, ownership, retries, dispatch epochs, publication fencing, and terminal receipts.
- Durable request correlation, result delivery, scratch lifecycle, artifact retention, and recovery.
- Cgroups, cancellation, process cleanup, output/time bounds, and operation ownership.
- Optional worktree lifecycle and durable patch/reconciliation correctness.

These are runtime and durability responsibilities. They must not be used as a second permission language.

### Server-Owned Native Profiles

The deployed profile registry owns optional behavioral configuration, including:

- Tools and executable behavior.
- Network availability and behavior.
- Workspace read/write behavior.
- Delegation behavior and ordinary profile bounds.
- Model and reasoning availability.

The initial useful profiles remain `explore`, `general`, and `self`. Their exact behavior is defined by the native registry, not by workflow code. If a deployment changes a profile, that change applies equally to direct and workflow-launched subagents.

A workflow selects a profile but cannot provide workflow-only tool lists, executable lists, callable lists, URL rules, write rules, prompt variants, or delegation policy. The resolved operation journal records profile identity, model request, reasoning, cwd, isolation, and other durable request context needed for dispatch and recovery; it does not create a workflow-specific behavioral envelope.

### Direct Boundaries That Remain

Retain only direct Level-1 boundaries:

- Never run a child as root or grant Core process authority.
- Do not expose exact deployment-owned Core state, runtime control, service configuration, or credential roots.
- Do not inject Core tokens, operator credentials, cloud credentials, credential-helper settings, or reusable service credentials into child environments or command lines.
- Keep internal workflow-control requests authenticated, request-bound, and owned; a child must not obtain a reusable bearer credential.

Denied roots must be exact deployment authority or credential roots. Do not blacklist ordinary project content, environment-like filenames, Git metadata, broad home/project trees, or an ancestor merely because a protected descendant exists. Access to the exact protected root remains blocked or masked while the rest of an otherwise valid cwd remains useful.

Level-2 protections are limited to durable correctness: immutable journals, ownership, epochs, request/receipt correlation, cgroups, cancellation, terminal publication, and artifact lifecycle. A concern that requires combining behavior A with hypothetical behavior B or C is not a blocker unless the combination demonstrates a direct secret, root/Core authority, credential-injection, or durable-corruption crossing.

## Invocation And Operation Model

### Trusted Invocation Auto-Runs

An invocation authenticated as the trusted main agent runs without human approval. This includes direct runs and durable triggers created or enabled by that principal. Restricted, public, unauthenticated, synthetic, stale, or forged origins remain denied because origin authentication is a direct authority boundary, not workflow behavioral policy.

Workflow children do not become trusted main-agent callers merely because they run inside a trusted workflow. Workflow-control access remains server-issued, request-bound, and tied to durable ownership. Explicit waits and human replies remain orchestration behavior, not approval gates.

### Profile-Native `agent()`

The public operation shape remains small:

```js
await agent("Implement and verify the change", {
  profile: "general",
  cwd: args.project,
  model: "deep",
  reasoning: "high",
  label: "implementation",
  isolation: "shared",
});
```

`profile` is required. `cwd` defaults to the invocation cwd. `model`, `reasoning`, `label`, and `isolation` are optional. `isolation` accepts `shared` or `worktree` and defaults to `shared`.

Remove these operation and revision concepts without recreating them elsewhere in workflow policy:

- `editing`
- `tools`
- `executables`
- `level2Callables`
- `surfaceOriginOperations`
- `delegation`
- `workflowExposure`
- Workflow callable deny lists or plugin opt-in lists
- Workflow-only effect metadata and prompt/tool filtering
- Capability envelopes and Level-1, Level-2, executable, surface, root, or delegation allowlists

Model and reasoning choices obey the selected native profile and deployment model configuration. Invalid aliases fail deterministically before dispatch. Top-level generated `subagent_delegate` workflows preserve the selected profile, and `self` delegation uses the same native behavior and ordinary bounds as a direct `self` launch.

## Filesystem And Execution

### Broad Canonical Cwd

The trusted main agent and its subagents may select any canonical absolute cwd accessible to the service UID except an exact deployment authority or credential root. Authority is not confined to the invocation project, a workspace allowlist, revision-approved roots, project-content patterns, or speculative ancestor checks.

The runtime canonicalizes cwd, rejects missing or inaccessible directories, applies exact protected-root masking/denial, and returns explicit errors rather than silently substituting another cwd. Ordinary service-UID filesystem permissions govern everything else.

### Shared Run Scratch

Each workflow family receives one secret-free, server-created scratch directory shared by its operations and generated descendants. Its identity and lifecycle are journaled, recovery reuses it while the family is live, and cleanup does not race active or recoverable work. Cross-run scratch access remains denied because it violates durable ownership.

Scratch implementation may use descriptor-relative access to preserve the selected path and ownership under races. It must not become a reason to narrow the native profile's normal tools or ordinary project access.

### Useful Native Tools And Network

When a selected profile exposes Bash, filesystem tools, Level-2 callables, plugins, or network access, a workflow launch exposes the same behavior as a direct launch. Workflow runtime adds no URL inspection, destination classification, protocol/port rules, redirect checks, callable filtering, workflow-only plugin opt-in, prompt narrowing, `apply_patch` omission, or directory-output omission.

Trusted Bash executes installed Git, Bun, compilers, tests, package scripts, configured plugin CLIs, and other native-profile tools as the service UID. Its environment remains secret-free and its processes remain cgrouped, cancellable, bounded, and durably owned.

Direct network must be restored according to profile configuration as part of full implementation. A deployment may choose a restricted or offline profile, but workflow runtime cannot impose that choice or maintain a separate SSRF policy.

### Shared Concurrency And Optional Worktrees

`shared` operations work in the selected cwd. Readers and writers may overlap; there is no mandatory writer lease, serialization rule, repository lock, or automatic worktree conversion. Filesystem side effects may race, and workflow authors can serialize dependent work when needed.

`isolation: "worktree"` must be implemented as an optional usable mode, not left behind a temporary-unavailable gate. A successful worktree operation publishes a durable patch artifact before cleanup, including base identity, tracked changes, and newly created files. Failed or ambiguous worktrees remain fenced and recoverable until reconciliation. Cancellation, restart, receipt adoption, artifact retrieval, and cleanup must not lose successful work.

Worktree host operations use the same secret-free environment and direct authority boundaries as other native operations. Do not add workflow-specific Git, content, network, or helper restrictions unless a concrete operation directly exposes a retained secret/root/Core boundary.

## Durable Guarantees To Keep

Preserve:

- Immutable content-addressed workflow source and input snapshots.
- Deterministic workflow evaluation and journaled host operations.
- Source, input, request, idempotency, receipt, and artifact hashes where behaviorally meaningful.
- Dispatch epochs, publication fencing, durable terminal receipts, and stale-run rejection.
- Durable run/operation ownership with takeover and recovery rules.
- Redis request/result correlation and epoch-filtered lifecycle delivery.
- Cgroups, bounded output/time, cancellation, pause/resume, process-tree cleanup, and terminal cleanup.
- Durable sleeps, waits, triggers, scheduler ownership, and authenticated trigger creation.
- Result/progress delivery and fallback when a live parent is absent.
- Worktree patch publication and reconciliation before destructive cleanup.

Do not hash behavioral restriction lists into workflow identity. Journal the profile identity and durable operation request context. Already-dispatched operations retain their exact durable request for retry or receipt adoption; new operations use the current native server profile path exactly as direct launches do.

## Schema And Migration

This remains a deliberate breaking schema change with no compatibility layer for the old capability envelope.

1. Keep the profile-native `agent()` schema and resource bounds.
2. Remove approval execution paths and old capability/per-operation authority state.
3. Preserve immutable historical snapshots, journals, receipts, and terminal audit records where practical.
4. Do not resume active old-schema runs under new semantics; drain or terminalize them explicitly.
5. Revalidate and re-snapshot definitions before their first new-schema run.
6. Recreate trusted triggers against authenticated ownership and new snapshots.
7. Preserve selected profiles in generated delegation without downgrade.
8. Remove all newly introduced workflow-only guardrail schema/config, including `workflowExposure` and workflow external-plugin lists; profile configuration is the only behavioral configuration.

## Implementation Order

1. Centralize native subagent profile configuration and assembly so direct and workflow launches use the same profile identity, tools, prompt, writes, network, plugins, and delegation behavior.
2. Delete workflow-specific network policy and remove URL/destination/redirect inspection from workflow paths.
3. Remove workflow-specific callable exposure, deny lists, effect metadata, prompt/tool narrowing, project-content blacklists, and temporary tool gates.
4. Simplify protected paths and child environments to the direct Level-1 boundaries: exact deployment authority/credential roots and no unsafe credential injection.
5. Restore unrestricted native tools and direct network according to profile configuration, with parity tests comparing direct and workflow launches.
6. Implement optional worktrees fully with durable patch publication, retrieval, cancellation, recovery, reconciliation, and cleanup.
7. Reconcile schemas, migrations, docs, examples, and tests with the final contract; run focused and full validation.
8. Only after the entire plan is implemented, perform one usability-first review, fix qualifying findings, validate again, and document or defer non-blocking residuals.

## Test Strategy

### Native Profile Parity

- The same profile resolves to the same tools, prompt, plugins, network, write behavior, and delegation whether launched directly or through workflow.
- Workflow code carries profile identity and durable request context but cannot add or subtract behavioral authority.
- Profile configuration can intentionally choose tool/network/write/delegation behavior without workflow-specific schema.
- Generated and nested delegation preserve native profile behavior.

### Direct Boundaries And Durability

- Child environments contain no Core/operator/cloud/service credentials or credential-helper configuration.
- Exact deployment authority and credential roots remain inaccessible without denying ordinary project content or broad ancestor cwd values.
- Trusted-origin authentication and request-bound workflow control reject forged, stale, public, and unauthenticated access.
- Journals, ownership takeover, epochs, receipts, cancellation, cgroups, waits, triggers, Redis correlation, scratch ownership, and terminal cleanup retain their behavior.

### Network, Tools, And Worktrees

- Workflow-launched network behavior exactly matches selected profile configuration, including useful direct network where enabled.
- Tests prove workflow runtime does not classify URLs, destinations, private ranges, protocols, ports, DNS answers, or redirects.
- Native tools such as `apply_patch`, directory-output callables, plugins, and Bash are not removed solely because the launch is a workflow.
- Concurrent shared writers remain allowed.
- Optional worktree runs publish retrievable durable patches and cover untracked files, conflicts, cancellation, restart, ambiguous receipts, reconciliation, and cleanup.

## Review Process

Finish the entire implementation plan before beginning final review. Do not alternate implementation with speculative guardrail review waves.

The final review is usability-first. Fix findings that demonstrate:

- Direct secret leakage or unsafe credential injection.
- Direct root or Core authority exposure.
- Concrete durable corruption, lost successful work, ownership failure, epoch/receipt violation, or cancellation/process cleanup failure.

Ignore or record as non-blocking findings that depend on speculative chains such as “A may cross a boundary when paired with B/C,” and reject recommendations that rebuild a complex workflow guardrail system. Residual improvements may be documented or deferred after the final implement -> review/fix -> validate loop.

## Documentation Deliverables

Update product, migration, authoring, deployment, and test documentation to use one mental model:

- Workflows orchestrate and make execution durable.
- Native server-owned profiles configure behavior for every launch path.
- Exact deployment authority/credential roots and secret-free child environments are direct boundaries.
- Network and tools follow profile configuration.
- Shared execution is usable and optional worktrees are implemented.
- Workflow-specific exposure, URL, content, prompt, tool, and delegation restrictions do not exist.

## Accepted Tradeoffs

- Native profile authority is intentionally the same through workflows as through direct launches.
- Broad service-UID cwd and profile-configured network increase capability relative to the previous workflow-only sandbox; exact authority roots, secret-free environments, and OS permissions remain the direct boundaries.
- Shared writers can race and lose edits. Explicit orchestration or optional worktrees handle cases that need isolation.
- Profile changes affect new operations. Already-dispatched operations retain durable request context for correct recovery.
- Agent side effects are not deterministic even though workflow orchestration and durable recovery are deterministic.
- Aggregate run-level cgroups and exactly-once receipts for arbitrary external side effects may remain documented residuals if operation-level durability is correct.

## Non-Goals

- Do not run agents as root or inject reusable service credentials.
- Do not expose Core runtime authority to children.
- Do not make restricted/public origins trusted through workflow schema.
- Do not recreate workflow capability envelopes, URL policy, callable policy, content policy, or special workflow prompts under new names.
- Do not promise serializable shared edits or exactly-once behavior for arbitrary external side effects.
- Do not block useful native behavior based only on speculative composition with another allowed behavior.

## Completion Gate

Completion requires the full implementation, migration, documentation, and tests to agree; direct and workflow profile behavior to be identical; profile-configured direct network and native tools to work; optional worktrees to be usable without losing successful changes; retained Level-1 boundaries and Level-2 durability to pass; and one final usability-first review/fix/validation loop to close. Non-blocking residuals may be explicitly deferred or documented.
