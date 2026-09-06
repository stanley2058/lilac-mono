# Provider-owned agent adapters

Status: approved for implementation on `feature/rework-agent-runner`.

Execution requirements: implement, test, review and fix, recheck, then commit each stage separately.
Use subagents and finish with a review of the complete branch against `77bab9fe`. Track execution
evidence separately from this approved checklist.

## Objective

Extract provider execution from the shared agent executor. Each agent adapter owns its execution
protocol, including model calls, provider continuations, native input delivery, and tool scheduling.
The shared runtime owns request policy, canonical history, durable delivery, and authorized host
services. Adding a provider feature should change its adapter unless the feature adds behavior that
Core must understand or expose.

Deliver three implementations: the existing AI SDK execution loop, native OpenAI Responses WebSocket
execution with mid-turn steering, and Core's existing Claude Code behavior behind the shared interface.
Use composition. Do not introduce a base runner class with provider overrides.

## Current implementation

- `packages/agent/ai-sdk-pi-agent.ts` combines queue policy, model calls, tool scheduling, history,
  checkpoints, and provider-specific behavior. `ModelCallRuntime` already distinguishes local and
  provider tool execution but requires an AI SDK model.
- `apps/core/src/surface/bridge/bus-agent-runner.ts` constructs the agent and separately manages Claude
  injection, interruption, attempts, model fallback, compaction, and host context preparation.
- `packages/utils/openai-responses-websocket-fetch.ts` projects WebSocket events into an SSE response
  for AI SDK. It ends the stream at the first terminal response event and does not expose steering.
- `packages/claude-code-bridge` already depends on `packages/agent` and owns native runtime operations.
  Preserve this dependency direction.
- `packages/mini-lilac-runtime/src/session-service.ts` also consumes `AiSdkPiAgent`. Changes to the
  shared package must preserve Mini's current controls, history, and native Claude continuation.
- Core stores accepted work and replay-safe checkpoints in the existing request-delivery store and
  agent-run WAL. Recovery is at-least-once. Native Claude bindings have separate existing codecs and
  verified lineage requirements.

## Scope and non-goals

In scope:

- A provider-neutral executor and an internal agent-adapter interface.
- Extraction of existing execution behavior into an AI SDK adapter.
- Native OpenAI Responses execution for Core's existing OpenAI WebSocket selection, including steering.
- Migration of Core's Claude execution and control plumbing to an adapter using the existing bridge.
- Compatibility updates and regression verification for shared-package consumers, including Mini.
- Removal of replaced Core execution paths once their replacements pass acceptance checks.

Out of scope:

- Implementing asynchronous tools, native multi-agent orchestration, or other new provider features.
  The interface must not impose a blocking tool batch, but this plan only enables native steering.
- New adapters for every AI SDK provider or native steering for the separate Codex OAuth endpoint.
- New Mini product features, new surface commands, or changes to event-bus, filesystem, or plugin contracts.
- A new persistence subsystem, queue, worker, journal, or generic provider-state database.
- Exactly-once execution, undoing external effects, or resuming an OpenAI socket after process loss.
- Replacing every AI SDK message/tool data type. Execution must be independent of `LanguageModel` and
  `streamText`; existing validated canonical data types can remain where they meet current requirements.
- New dependencies or configuration keys. If implementation proves one necessary, present the exact
  proposed change for approval before adding it.

## Ownership and module placement

| Owner | Responsibilities |
| --- | --- |
| Shared executor in `packages/agent` | Logical run lifecycle, ordered inputs, delivery arbitration, canonical history acceptance, output events, checkpoint requests, follow-up and interrupt policy |
| AI SDK adapter in `packages/agent/adapters/ai-sdk` | Current model/tool loop, AI SDK stream projection, provider payload conversion and execution-specific retry behavior |
| OpenAI adapter in `packages/agent/adapters/openai-responses` | Responses protocol, socket ownership, response chains, steering state, tool-result continuation, usage and provider output projection |
| Claude adapter in `packages/claude-code-bridge` | Native execution and controls, existing attempt runtime integration, Claude event and continuation projection |
| Core composition module under `apps/core/src/agent` | Adapter selection and construction, injected Core context/authority/storage services, binding replacement on model fallback |
| Existing Core host modules | Authentication, tool authority/execution, resources, durable request delivery, transcript/WAL stores, surface publication |

These are proposed internal module locations, not new workspaces or a plugin extension interface.
The shared executor must not import concrete adapters. Core injects them. Shared helpers can be used by
multiple adapters without imposing one execution algorithm. Keep low-level utilities below the adapter
contracts; do not create an import cycle through `packages/utils/model-provider.ts`.

Provider-owned execution logic currently in Core moves into adapters. Core-specific storage,
lineage verification, resource materialization, and authority preparation remain host services.
Construction may branch on provider identity; request/control dispatch must not.

## Interface contract

Finalize names and TypeScript shapes in the first implementation stage. The following semantics are
requirements, not optional interface details.

### Execution lifetime

- Starting execution returns a handle bound to one attempt identity, an ordered event stream, and
  controls for input delivery, interruption, cancellation, and disposal where supported.
- An execution can span multiple provider responses. Only its logical terminal event ends the shared
  run's active execution; a provider response finishing does not imply task completion.
- No tool execution or output publication occurs before the host is ready to observe the handle.
- Controls remain serviceable while output is backpressured or a host tool is running. Stream
  consumption must not be the only way to make control or tool-result progress.
- One attempt owns each provider connection. Late events and callbacks from retired attempts cannot
  alter the replacement attempt, canonical history, or input delivery state.
- Exactly one logical terminal outcome is emitted. Cancellation and disposal settle ownership of
  outstanding host work before releasing resources, following existing host cancellation guarantees.

### Inputs and capabilities

- Keep one shared entry point for `steer`, `followUp`, and `interrupt`. Register stable input IDs before
  delivery. Preserve existing queue order, steering batch modes, and buffered follow-up absorption.
- Capabilities describe delivery behavior for the selected model, transport, and execution mode.
  Distinguish native delivery from boundary delivery and unsupported operations. Do not infer native
  support from a method's presence or the provider name alone.
- Reserve selected inputs before invoking provider delivery. Run existing preparation hooks before
  transfer. While reserved or provider-owned, an input cannot also be drained by the fallback queue.
- Model delivery as local queued, reserved/submitting, provider-owned pending, committed, definitely
  returned, or unresolved. A rejected preparation returns ownership locally. A missing acknowledgement
  after transmission does not prove non-delivery.
- A synchronous method result acknowledges local submission only. Ordered events establish provider
  ownership, commitment, or definite return using the original input ID.
- Definitively returned inputs may use the existing boundary-delivery path when valid. Unresolved
  inputs require attempt retirement/reconciliation under recovery policy before replay.
- Preserve explicit interrupt/cancel semantics. Native steering must not silently replace cancellation.

### Events and canonical history

- Use closed shared event unions for output, tool activity, delivery transitions, replay-safe history
  commits, usage, and execution termination. Keep raw SDK values inside the adapter.
- Partial output is presentation state. Canonical commits contain validated complete history segments
  and the input IDs they commit. The executor validates attempt identity, ordering, and tool exchange
  integrity before passing them to existing storage.
- Preserve placement of steering between predecessor and successor output. Do not flatten a response
  chain into one assistant message or acknowledge delivery before its canonical position is known.
- Account for every response's usage once. Provider response limits and shared run limits remain
  distinct; automatic continuation cannot reset host-enforced limits.
- Keep protocol errors and expected operational failures in domain-owned `Result` unions. Preserve
  Panic propagation. Unknown external events receive an explicit adapter-local classification.

### Host services and tools

- The adapter decides when to request tools and when to submit results. It calls a host execution
  service that owns validation, authorization, tool snapshots, cancellation, output normalization,
  expansion accounting, and artifact/resource handling.
- Never expose raw executable tools as a route around host authority. Preserve Core's restriction
  that Claude built-in tools are disabled and Lilac supplies its tools.
- Tool results remain associated with attempt and call identity. A repeated steering notification
  must not rerun a tool. Reuse settled results within the live attempt.
- Retain existing atomic/cohort behavior in the AI SDK adapter. Do not require every adapter to wait
  for all tools before processing provider events.
- Host context services retain prompt overlays, selected-tool refresh, compaction policy, model
  fallback selection, and authority preparation. Adapters own encoding and applying those decisions.
  Automatic continuations may only inherit host settings while that prepared execution scope remains
  valid; they cannot bypass an authority update that requires a new explicit request.

### Recovery and continuation

- Canonical history remains the portable recovery floor. Native state is interpreted by its adapter;
  storage, retention, and lineage checks remain host-owned.
- Preserve existing Claude binding/attempt codecs and resume eligibility. Do not wrap them in a new
  generic durable format solely to fit the interface.
- Keep OpenAI socket/steering state process-local in this scope. After connection loss, reconcile
  committed input IDs against canonical history and retained accepted controls, retire the old
  attempt, and recover through the existing at-least-once path. Do not claim deduplicated external
  effects across a crash or blindly retry an uncertain send on a live connection.
- Stage 1 must demonstrate that existing accepted-control records plus replay-safe checkpoints retain
  every uncommitted input. If they cannot, native steering remains disabled until an exact versioned
  storage amendment and its migration/rollback behavior are approved. Do not silently weaken recovery.
- Provider-specific retry decisions report replay safety to the shared runtime. Never stack an
  adapter retry with a host retry that can duplicate the same submitted work.

## Implementation stages

### 1. Specify and test the execution contract

- [ ] Inventory current public agent operations, Core/Mini hooks, retry/compaction paths, and native
  Claude lifecycle dependencies. Assign every execution responsibility to adapter or host.
- [ ] Define the internal adapter, host-service, capability, event, and delivery contracts in
  `packages/agent`. Define attempt retirement and input ownership transitions explicitly.
- [ ] Trace queued and provider-delivered controls through Core checkpoint persistence and recovery.
  Resolve the storage sufficiency requirement above before native steering implementation.
- [ ] Build a controllable in-memory adapter fixture and shared contract tests. Cover input ordering,
  output/commit separation, in-flight controls, terminal races, tool authorization, and stale attempts.
- [ ] Specify a compatibility mapping for existing agent events and methods consumed by Core and Mini.

Exit: the interface can represent current AI SDK behavior and a provider-managed response chain without
provider-name branches in the executor. No new wire or stored contract is introduced by extraction.

### 2. Extract current execution into the AI SDK adapter

- [ ] Introduce the provider-neutral executor. Move `streamText`, SDK stream interpretation,
  provider projection, and the current model/tool scheduling loop into the AI SDK adapter.
- [ ] Extract shared host tool execution and history/checkpoint handling without copying their logic.
- [ ] Preserve boundary steering, follow-ups, awaited interrupts, compaction, model fallback,
  selected tools, retries, usage, tool expansion, and idle watchdog behavior.
- [ ] Route current consumers through a temporary `AiSdkPiAgent` compatibility facade where needed.
  The facade delegates; it must not retain a second execution loop.
- [ ] Run focused agent tests and Core/Mini integration tests before enabling native OpenAI execution.

Exit: existing behavior passes through the new seam. AI SDK types required to execute a model no longer
appear in the shared executor contract.

### 3. Implement native OpenAI Responses execution

- [ ] Build the adapter using the existing authenticated provider resolution and WebSocket utilities.
  Move or share protocol helpers; do not import AI SDK's private parser or conversion implementation.
- [ ] Preserve supported Core OpenAI behavior: message/reasoning projection, resource inputs, tools,
  provider options, explicit compaction paths, usage, continuation optimization, and cancellation.
  Establish a supported-feature inventory against the old path before switching selection.
- [ ] Handle response chains, safe response completion, and automatic successors inside the adapter.
- [ ] Implement `response.steer`, accepted/pending/failed handling, and commitment at the matching
  successor creation. Correlate multiple submissions and response IDs without guessing event order.
- [ ] Return client-owned tool results on the same connection and matching parent. Return one explicit
  continuation per parent and never resend accepted steering with it.
- [ ] Gate native steering inside the OpenAI adapter to exactly `gpt-6-astra`, plus documented
  transport/mode compatibility. Preserve ordinary queued delivery
  for incompatible settings, including automatic compaction or conversation-bound requests.
- [ ] Preserve existing transport selection and connection-establishment fallback. A post-submission
  disconnect follows recovery policy, not transparent SSE retry.
- [ ] Leave Codex OAuth and other providers on their current adapter path. Do not infer their feature
  support from the public OpenAI Responses endpoint.

Exit: native steering works while a model response is active, preserves completed work, and passes the
protocol/race matrix below without AI SDK controlling the response chain.

### 4. Move Core composition and Claude execution onto adapters

- [ ] Extract adapter construction from `bus-agent-runner.ts` into the Core composition module.
- [ ] Replace `activeRun.claudeCodeControl` dispatch with shared executor controls.
- [ ] Implement the Claude adapter in the existing bridge, preserving native tools, injection,
  interruption, named/primary attempts, finalization, disposal, and continuation checks.
- [ ] Move protocol-specific preparation/retry decisions out of the bus runner while injecting its
  Core-owned lineage, storage, prompt, and authority services.
- [ ] Route primary, named, direct-subagent, and workflow-child runs through the same selection path.
- [ ] Rebind adapters on model/provider fallback only after the old attempt is retired. Preserve
  cross-provider history projection and reject incompatible native continuation state.

Exit: Core has no provider-specific control dispatch or model/tool execution loop. Its remaining
provider selection and storage wiring are composition responsibilities.

### 5. Complete compatibility, remove replaced paths, and verify

- [ ] Update Mini's shared-package integration without enabling new Mini capabilities. Preserve its
  existing protocol and Claude continuation behavior; retain a delegating facade if still needed.
- [ ] Remove dead Core execution/control code and replaced OpenAI SSE emulation only where no remaining
  AI SDK/Codex/Mini consumer needs it. Avoid unrelated cleanup or broad renames.
- [ ] Update exact architecture registrations for changed external, Result, tool, and codec seams.
- [ ] Update `PROJECT.md` with shipped ownership. Update `MIGRATIONS.md` only if an approved stored or
  protocol change was actually required. Record residual work explicitly.
- [ ] Run final repository checks and validate the acceptance criteria. Remove the completed plan
  after its durable facts have moved into the appropriate documentation.

## Verification matrix

Use deterministic event-controlled fixtures, not fixed sleeps or mandatory live API credentials.

| Area | Required cases |
| --- | --- |
| Shared input policy | One/all steering modes, follow-up absorption, preparation failure, idle input, boundary fallback, explicit interrupt and cancellation |
| Native delivery | Before response creation, during output, multiple submissions, accepted then committed, definite failure, missing acknowledgement, normal completion racing steering |
| Response chains | Steered incomplete predecessor, completed predecessor with successor, multiple successors, output ordering, per-response usage, host limits, exactly one logical terminal event |
| Tools | Steering during host execution, repeated pending notices, saved result reuse, one continuation per parent, denied/invalid tools, cancellation while tools settle |
| Recovery | Disconnect before/after acceptance and commitment, crash before/after checkpoint, retained uncommitted inputs, stale callbacks, no assumed socket resumption |
| Compatibility | SSE, unsupported model/mode, Codex OAuth, cross-provider fallback, resources, reasoning, explicit compaction, selected tools, atomic tool batches |
| Claude/Core | Injection and interruption, native attempt retirement, named/primary continuation, finalization failure, subagent/workflow parity, unchanged surface events |
| Mini | Current input controls, replay/history, tools, native Claude continuation, unchanged client protocol |

Reuse and extend `packages/agent/tests`, `packages/claude-code-bridge/tests`, Core bridge/crash-recovery
tests, and Mini runtime tests. Verify adapter behavior through its public seam; use protocol fixtures
inside each adapter for exact wire translation.

Run focused tests and workspace typechecks for each changed workspace using root scripts. Run
`bun run test:core`, `bun run test:mini`, and `bun run lint:architecture` for integration milestones.
For architecture registration changes, also run the focused gates specified by
`scripts/architecture/README.md`. Run `bun run check` against the final implementation and before every
requested commit. Do not commit or publish a PR unless requested.

## Final acceptance criteria

1. Shared execution policy does not import `streamText`, concrete provider SDKs, or native transport
   implementations and does not branch on provider identity.
2. Each adapter owns its complete execution protocol. AI SDK is an implementation choice, not a
   requirement imposed on native adapters.
3. Host authority and tool-result normalization apply to every adapter, including native execution.
4. OpenAI native steering cannot be delivered again by the ordinary queue while ownership is pending,
   and canonical history records the update in the correct response order.
5. Cancellation, errors, retries, usage, checkpointing, and terminal publication preserve existing
   guarantees. Process recovery remains explicitly at-least-once.
6. Core's current AI SDK providers, Claude behavior, and Mini shared-package consumers pass regression
   checks. No unapproved external contract, dependency, configuration, or stored-data change ships.

## Sources

- [OpenAI mid-turn steering](https://developers.openai.com/api/docs/guides/steering)
- [OpenAI Responses WebSocket event reference](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses)
- [AI SDK Responses implementation](https://github.com/vercel/ai/blob/main/packages/openai/src/responses/openai-responses-language-model.ts)

Recheck provider capabilities and SDK support before stage 3. The previous investigation found no
native steering in AI SDK 7.0.93 / `@ai-sdk/openai` 4.0.60; this plan must not assume that stays true.
