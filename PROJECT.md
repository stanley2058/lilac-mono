# Lilac Architecture And Ownership Guide

This is the durable map of the current Lilac monorepo: product boundaries, terminology, ownership, trust boundaries, persistence categories, and the best places to make changes. It intentionally omits route inventories, configuration field catalogs, startup call order, and implementation-plan history.

## Documentation Authority

Current behavior is authoritative in production source, wire schemas, persisted codecs, `scripts/architecture/manifest.ts`, and root `package.json` scripts. This guide summarizes those contracts; it does not replace them.

- `README.md` covers installation, personalization, everyday use, and documentation routing.
- `DEVELOPMENT.md` covers source setup, development commands, builds, and checks.
- `PROJECT.md` is the durable current-system and ownership guide.
- `AGENTS.md` defines repository-wide working constraints.
- `packages/utils/config-templates/core-config.example.yaml` documents current Core configuration, and
  `docs/core-config-migrations.md` records manual version upgrades.
- `MIGRATIONS.md` records persisted-data, wire, and protocol transitions.
- `scripts/architecture/README.md` explains the permanent architecture gate and exact registrations.
- `plan/README.md` identifies active implementation plans. Plans describe intended work, not current behavior until the code ships.
- Component documentation owns operational detail. In particular, see the self-documenting
  `packages/utils/config-templates/core-config.example.yaml`, `docs/core-config-migrations.md`,
  `docs/claude-code.md`, `docs/skill-authoring.md`, `docs/docker-deployment.md`, and `PLUGIN_AUTHORING.md`.

`ref/` is vendored upstream reference material and is read-only unless a task explicitly says otherwise.

## Products And Stable Flows

### Core

Core is the Redis-backed multi-surface runtime in `apps/core`.

Current Core configuration is documented in
`packages/utils/config-templates/core-config.example.yaml`; manual version upgrades are in
`docs/core-config-migrations.md`.

1. Authenticated Discord gateway ingress publishes normalized adapter events to the typed bus. Verified GitHub webhooks can create request messages directly.
2. The Discord router converts eligible adapter events into `cmd.request.message` commands. Visible Discord attachments become structured `resource://` parts before publication. A request is the unit of agent work; `prompt`, `steer`, `followUp`, and `interrupt` describe admission into a session's active work.
3. The request-delivery store durably accepts each prompt or control. The bus agent runner serializes accepted work per session, checkpoints every active primary or subagent run in the agent-run WAL, publishes request lifecycle events, and streams output on `out.req.<request_id>`.
4. A registered surface relay consumes the request output stream and renders it to Discord or GitHub. Relay state is live and process-local. The relay durably links each created output message. A recovered Discord run edits the latest linked message when it still exists and remains editable, otherwise it publishes a fresh continuation. Stale partial output or duplicate terminal output is still possible after a crash.
5. The durable workflow engine uses the same request-delivery and agent-runner path for child-agent operations. Workflow journals, triggers, waits, receipts, and progress remain owned by the workflow engine.

`packages/event-bus/lilac-spec.ts` is the canonical event catalog and payload schema. `request_id`, `session_id`, and `request_client` are the correlation headers; request and output contracts require a request ID where specified by that catalog.

### Computer use

The optional computer-use gateway exposes HTTP MCP `provision`, `execute`, and `terminate` tools.
Core binds each tool invocation to its trusted canonical session ID and sends a domain-separated
SHA-256 digest in `x-lilac-session-hash`. Discovery omits that header; shared clients keep call context
isolated and preserve bearer/OAuth headers. Configured routing headers cannot override it.

The gateway owns one ephemeral runner per session, serializes its operations, publishes a noVNC port,
and persists lifecycle metadata in a separate SQLite database. Startup retains only the intersection
of unexpired ready records and matching usable owned containers; it never respawns missing desktops.
Python variables survive calls and gateway reconnects while the runtime remains alive. Cancellation or
uncertain execution removes the desktop before another call can execute. The gateway does not call a
model. Runners receive neither its Docker socket nor bearer secret.

See [computer-use deployment and operation](docs/computer-use.md) for image builds, optional Compose,
limits, agent instructions, verification, and deferred work. The default Core deployment is unchanged.

## Workspace Ownership

The fail-closed workspace inventory is `ACTIVE_WORKSPACES` in `scripts/architecture/manifest.ts`. Every current workspace has an explicit owner:

### Applications

- `apps/computer-use-gateway`: optional authenticated MCP desktop gateway, Docker lifecycle, and session/port SQLite bookkeeping.
- `apps/core`: Core composition, surfaces, routing, tool adapters/server, workflows, recovery, and Core-owned persistence.
- `apps/installer`: standalone setup CLI, provider and Discord onboarding, configuration updates, and published-image Compose deployment. See `docs/installation.md` for installation and release operations.
- `apps/tool-bridge`: the native `tools` launcher, its resident Bun HTTP client, and the reduced dev-mode Core tool server entry.

### Packages

- `packages/agent`: provider-neutral execution policy, input ownership, canonical history/checkpoints,
  authorized host tool execution, and AI SDK and native OpenAI Responses adapters.
- `packages/bash-safety`: static Bash analysis and accidental-damage policy. It is a guardrail, not isolation.
- `packages/blob-storage`: the adapter-neutral Core managed-blob seam, strict handle/reference codecs,
  supervised uploads, verified reads, expiry, maintenance, and local and S3-compatible adapters.
- `packages/claude-code-bridge`: Claude agent adapter, runtime integration, in-process MCP tool bridge,
  native input delivery, attempt settlement, and continuation metadata.
- `packages/coding-tools`: shared coding-tool schemas and implementations, patch/edit behavior, batching, instruction discovery, and tool guardrails.
- `packages/computer-use-runner`: pinned CUA desktop image, Chromium seccomp profile, persistent Python runtime, and runner checks.
- `packages/event-bus`: event catalog, codecs, typed bus, delivery policy, dead letters, and Redis Streams transport.
- `packages/fs`: local filesystem operations, search backends, edit/hashline primitives, and the remote filesystem protocol.
- `packages/plugin-runtime`: generic Level 1/Level 2 plugin capability contracts, discovery, loading, lifecycle, and reload management.
- `packages/remote-fs-runner`: short-lived publishable remote runner used by Core SSH filesystem tools.
- `packages/tool-results`: bounded model-view output, media projection, and encrypted transient artifact storage.
- `packages/utils`: shared Core configuration, environment, model/provider resolution, prompt workspace, skills parsing/discovery, OAuth helpers, logging, and common utilities.

## Core Surfaces

Three concepts must remain distinct:

- The event bus `AdapterPlatform` is a compatibility wire enum and includes values that Core does not implement.
- `BUILTIN_SURFACE_PROTOCOLS` in `apps/core/src/surface/builtin-surface-protocols.ts` is the exhaustive static catalog for the closed `SessionRef`/`MsgRef` platforms, currently Discord and GitHub. It owns protocol-specific ref construction, request-ID interpretation, and tool target projection. Catalog membership does not enable a surface or grant trust.
- `SurfaceRuntimeRegistry` in `apps/core/src/surface/runtime-descriptor.ts` contains the executable descriptors installed in one Core process. A descriptor explicitly contributes an adapter and optional adapter ingress, request ingress, relay, workflow-progress, and health ports. Resolution is exact; it is not inferred from the wire enum or static catalog.

The registry binds one produced-ref-guarded adapter facade and passes that facade to descriptor ports. Caller refs and adapter-produced refs are checked before shared publication, persistence, or workflow progress. Workflow progress additionally gates exact target, binding, and ref correlation and persists permanent-versus-retryable operation policy. The registry is internal composition, not a dynamic surface plugin API.

Discord owns its gateway ingress, allowlists, mention/active router, local cache/search/thread services, and Discord rendering. GitHub owns webhook verification, trigger parsing, API authentication, acknowledgement state, pagination, and GitHub rendering. Shared code must not infer that a wire-valid platform has those capabilities.

Trust admission starts at authenticated Discord ingress or verified GitHub webhook ingress. A `SurfacePrincipal` is created only from correlated normalized identity carried through the trusted request path. Protocol catalog membership, descriptor registration, a request header, or a claimed platform cannot create authority; conflicting or missing correlation falls back to restricted behavior.

## Event Delivery

The typed API wraps Redis Streams and decodes complete `Message<unknown>` envelopes through the canonical event codec registry before handlers receive domain messages.

- `work` is a managed durable consumer group with competing consumers.
- `fanout` is a managed durable consumer group per `subscriptionId`; each distinct subscription receives every event.
- `tail` is a non-durable read without a consumer group and may start at the beginning, now, or a cursor.

Every subscription handler returns `Result<void, TaggedError>` and supplies an explicit delivery policy. Success commits. A managed durable error policy may choose `commit`, `retry`, `park-pending`, `dead-letter`, or `stop`; tail does not retry. `retry` uses the package-owned lease, attempt, and capped-backoff policy. `park-pending` leaves durable work in the Redis pending-entry list and is excluded from automatic reclamation. Contract-invalid transport or event data is dead-lettered by the package policy. Throws, malformed Results, and Panics are defects handled by the registered fatal boundary, not ordinary handler failures. Manual fetch decodes the complete batch and fails on the first invalid entry rather than exposing it as typed data.

Core request publication acquires a finite Redis fencing claim before its final durable-state reread.
Only the exact live token can create or observe the `requestDeliveryId` to stream-ID marker. After Core
records that stream ID, one Redis operation confirms the exact marker and removes it with the claim. An
expired or superseded producer token cannot append a request.

Durable consumers need stable `subscriptionId` values. The transport maps them to versioned physical groups created at the current stream end, leases each invocation, heartbeats live attempts, and reclaims expired attempts with token fencing. Delivery is at-least-once: handlers that perform external effects own their idempotency. The fixed policy allows five attempts before Redis-only dead-letter exhaustion. Managed dead-letter persistence, source acknowledgement, and delivery-metadata cleanup are atomic; ordinary commit atomically acknowledges and removes metadata. `consumerId` identifies one process within a group, and the Redis stream entry ID is the cursor/checkpoint. Tail delivery retains its cursor behavior and no lease.

## Tools, Plugins, And Skills

Lilac uses progressive disclosure, but ownership is more important than the level number.

### Level 1: Agent-Local Tools

Level 1 tools are direct model-callable AI SDK tools assembled for each run. `packages/coding-tools`, `packages/fs`, `packages/bash-safety`, and `packages/tool-results` own portable behavior. Core-specific host, SSH, restricted execution, attachments, artifacts, logging, and bus delegation adapters live in `apps/core/src/tools`. Built-in exposure is declared in `apps/core/src/plugins/builtin`, and `apps/core/src/plugins/manager.ts` applies model, profile, safety, and request context.

Native Bash executes with the Core service user's host authority. Static Bash checks, denied paths, redaction, `network`, and `workspaceWrites` are behavioral guardrails, not security boundaries. Use restricted execution or OS isolation when same-user files, secrets, or network access must be unavailable.

### Level 2: Core Tool Server

Level 2 is Core's Elysia tool service in `apps/core/src/tool-server`, consumed by `apps/tool-bridge/client.ts` and commonly reached by an agent through Level 1 Bash. The same Core plugin manager owns Level 1 and Level 2 registration. Built-ins are composed from `apps/core/src/plugins/builtin`; external plugins are trusted process code discovered under `${DATA_DIR}/plugins` through `packages/plugin-runtime`.

The plugin manager retains each generation while Level 1 toolsets or Level 2 calls hold it. Reload
publishes a new generation and retires the old one; destruction waits for its final holder to release.
Reload does not wait for the active agent run that may have requested it.

Level 2 callables settle with actual `better-result` Results. Expected failures carry the closed
`ServerToolFailure` contract; raw returns are invalid and throws are defects. Core projects Results
onto the strict `{ status: "ok", value } | { status: "error", error }` wire envelope, and the
`tools` CLI writes successful values to stdout and failure JSON to stderr with kind-specific exit
codes. Successfully produced report and diagnostic payloads remain successes even when their
findings are negative. See `PLUGIN_AUTHORING.md` for authoring details and `MIGRATIONS.md` for the
clean-break migration.

`generate.image` executes caller-written JavaScript in a fresh Bun process with the caller's cwd and
Core's container environment. Discovery lists configured OpenAI, OpenRouter, and xAI providers; the
script's `providers` global supplies resolved endpoints and credentials. The built-in `image-generation`
skill owns the default model catalog and native request recipes. Scripts save images and print paths;
the tool returns bounded stdout/stderr, exit status, and truncation state. This is trusted native
execution and is unavailable to restricted sessions. `generate.video` retains its model-based interface.

Request capabilities bind request context, cwd, profile, callable authority, and expiry. They constrain agent calls but are not general public HTTP authentication. The Core tool server belongs on a trusted host/network. Core also owns configured MCP clients process-wide; MCP tools join the run-scoped catalog only through the Core manager and profile policy.

Core ingress resources use opaque `resource://r1_<128-bit-id>` capabilities. The shared Core resource
module validates and resolves them for provider media, Level 1 `read` and `grep`, Level 2
`resource.materialize` and `attachment.add_files`, and the hidden deprecated `attachment.download`
compatibility callable.
`resource.materialize` writes an ordered selection into the invoking `tools` CLI process cwd without
overwriting existing files. The server keeps the capability-authorized cwd separate from that
invocation cwd, and restricted requests can materialize only under their private `/tmp` mapping. Text
and unsupported binary attachments stay marker-only until a tool opens or materializes them.

Core transient tool results use `resource://t1_<128-bit-id>` through the same `read`, `grep`,
`resource.materialize`, and `attachment.add_files` entry points. The run-scoped transient adapter keeps
session authority, TTL, quota eviction, encryption, and paging in `packages/tool-results`; it does not
create retained resource rows or transcript references. Core still accepts `tool-result://<uuid>` as a
compatibility input.

### Level 3: Skills

Skills are `SKILL.md` bundles discovered from Core-owned state plus supported workspace/user compatibility roots. They are metadata-first instruction bundles loaded on demand; discovery does not execute scripts. Parsing and discovery live in `packages/utils/skills.ts`. See `docs/skill-authoring.md`.

Plugin code and skills are different extension mechanisms. Plugins execute trusted code and can contribute Level 1 and Level 2 capabilities. Skills contribute instructions and resources to an already-authorized agent. See `PLUGIN_AUTHORING.md` for the plugin contract.

## Workflows

Core has one current programmatic workflow runtime, `lilac-workflow-js-v4`, under `apps/core/src/workflow`.

- Definitions are JavaScript files in `<project>/.lilac/workflows` or `${DATA_DIR}/workflows`. The request capability's server-authorized cwd selects the project; a shell's later `cd` does not change that selection.
- A run is pinned to immutable source, input-schema, resource-policy, project, and runtime identity. Durable triggers pin that revision and origin when created and later fire without another human review.
- Workflow programs orchestrate; native subagent profiles authorize. `agent()` requires `explore`, `general`, or `self` plus optional cwd, model, reasoning, and label. The selected profile owns Level 1 tools/plugins, Level 2 callables/plugins, Bash mode, writes, network behavior, and delegation exactly as it does for direct subagents.
- Agent cwd is free-form, absolute or relative to the invocation project, and may address any path available to the service UID. Native Bash remains host-authority execution.
- The immutable resource policy bounds agent concurrency and count, nesting, allowed wait kinds, and per-operation idle time; separate limits bound source, input, operation output, and final result sizes.
- The deterministic program child is a plain `bun --smol` subprocess with deterministic-global lockdown and an NDJSON host protocol. It is not an OS security sandbox. The host owns cancellation, operation-idle, output-size, and protocol limits. A workflow has no total wall-time limit.
- Current host operations are agent orchestration, phase/parallel/pipeline composition, Discord-only `waitForReply`, and `sleep`. Reply waits are limited to the authenticated originating Discord session and user.
- Journals, dispatch epochs, owner fencing, pinned resolved-model identity, waits, triggers, cancellation, terminal receipts, generated subagent runs, and progress actions are durable. Replay reuses operation identity rather than rerunning completed effects.
- Recurring reconciliation selects expired running claims before applying its page limit and takes them over through the same atomic claim fence used for startup recovery. Live owners renew their claims through heartbeats.
- Primary-created runs, ordinary workflow children, durable triggers, and generated subagent runs share the global active-run cap. Shared filesystem or external operations may race.
- Progress projection is durable and independent of request output relays. Live-parent completion delivery is durable; when the parent cannot be restored, terminal output remains available through workflow progress/result state.

Workflow SQLite state is authoritative for execution and recovery. Do not reintroduce historical approval envelopes, workflow-specific tool authority, worktree isolation, or old workflow schemas without an explicit product and migration decision. Read `MIGRATIONS.md` before changing this contract.

## Storage And Durability

### Core

`DATA_DIR` defaults to `data/` and groups several categories:

- Operator-managed configuration and extensions: Core/MCP config, prompt workspace, skills, plugins, custom commands, personal workflow definitions, and the default tool workspace.
- Secrets and credentials under `secret/`. Tool denylists and redaction reduce accidents, but same-user native code can bypass them; the directory is not an OS security boundary.
- SQLite state for Discord cache/search and conversation threads, discovery, agent transcripts and continuation bindings, workflows, durable request delivery, and the agent-run WAL. The workflow database path may be selected separately by `SQLITE_URL`.
- Transient or rebuildable artifacts and caches, including bounded tool-result artifacts and filesystem-search caches.

Core-managed opaque bytes live behind `packages/blob-storage`. Domain databases, Redis messages, and
dead-letter evidence keep only `BlobHandleV1` or `BlobRefV1` plus domain metadata. One configured local
or S3-compatible adapter owns byte integrity, exact logical expiry, physical cleanup, and pending-upload
fences. References do not reveal the adapter, path, bucket, endpoint, or credentials. Domains retain
ownership, quota, encryption, and deletion policy; the blob module has no cross-domain reference table.
Workflow artifacts first complete an expiring staged upload, persist publication ownership, then adopt
that exact object as durable and register its canonical reference. Startup and existing maintenance
reconcile publication intents and retry duplicate cleanup. Staged bytes are not readable before adoption.
Expired unfinished uploads retain cleanup ownership until byte-write completion is confirmed. Existing
maintenance revisits these records to delete late writes and advances past them to service other objects.
See the [workflow artifact publication design](docs/architecture-blob-publication-design.md) for the
ownership and concurrency decisions.
At runtime, only the Core composition root constructs and closes the store. The offline migration task
owns and closes its separate store. Providers and surfaces open references through registered
materialization modules immediately before use.

Core's transcript database retains surface-message aliases after surface deletion. Deleted aliases
remain valid for transcript lookup and request lineage; recovery targets and surface-coverage checks
use live aliases only. Transcript deletion removes both live and deleted aliases. Deleted aliases
without a transcript expire under the configured transcript age limit. A failed terminal transcript
save produces a failed request outcome through the runner's ordinary failure path.

Core's transcript database also owns resource metadata and retained transcript or surface-projection
references. A structured resource part contains only the opaque URI and display metadata. Discord
attachment IDs, signed CDN URLs, and blob object IDs do not enter messages or model markers. The
resource module refreshes an origin URL in memory, streams at most 512 MiB into BlobStore, verifies the
result, and attaches the cache reference with compare-and-swap semantics. Images and PDFs no larger
than 25 MiB may become verified byte-backed provider parts. Claude Code receives images only.

Possession of an exact retained resource URI grants access without a session or principal comparison.
Plain text containing a URI does not add retention or create a provider file part. When the final
structured transcript or projection reference is deleted, the URI stops resolving. Maintenance first
deletes any resource-owned cached blob, then removes the unretained resource row. Failed blob deletion
leaves the row for a later retry.

`request-delivery.db` owns both accepted request work and the agent-run WAL. Accepted work is the recovery
floor. The WAL stores the latest replay-safe `StoredMessageV1` checkpoint and one predecessor,
recovery-safe lineage, retained control outcomes, and active or terminal state. The runner writes
checkpoints through a serialized, coalescing background worker, so model and tool work can advance before
the latest checkpoint becomes durable. Startup joins both sources while the runner is paused,
terminalizes terminal heads, restores active heads, and starts accepted work without a head from its
original messages. Journal corruption resets only journal progress and never rewrites accepted work.

Agent recovery is at-least-once. A crash can repeat model calls, tools, controls, external effects, or a
terminal surface write. Ordinarily, a run becomes terminal when Core initiates its terminal output write.
An exhausted failure with unresolved native input preserves accepted deliveries, its workflow claim,
and a nonterminal WAL checkpoint before publishing failure feedback. That work resumes through startup
recovery; there is no live recovery scheduler after retry exhaustion. Core does
not wait for a Discord or GitHub acknowledgement. Discord recovery best-effort reconnects to the latest
durably linked output message. A missing, deleted, or uneditable message falls back to a fresh reply.

Runtime startup does not open `graceful-restart.db`. Existing files are inert. The offline unified blob
migration keeps a frozen graceful-snapshot decoder only so it can classify and discard supported legacy
blob-bearing snapshots; runtime code has no graceful-snapshot import path.

Redis Streams is separate durable bus state. Project workflow source lives in each project's `.lilac/workflows`, outside `DATA_DIR`. The workspace operated on by tools is user data, not Lilac metadata.

### Computer use

The gateway owns `/data/computer-use.sqlite`, separate from Core storage. Schema 1 stores session and
runtime identities, port reservations, lifecycle state, viewer credentials, idle timeouts, and expiry.
Its Docker containers own the temporary desktop filesystem. Startup retains only matching usable,
unexpired ready runners and removes owned outliers; SQLite does not restore a lost desktop. See
[computer-use operation](docs/computer-use.md) for cleanup, volume ownership, and deployment.

### Provider-Owned State

`packages/agent/agent-executor.ts` owns logical runs, ordered input IDs, canonical commits, and host
authority. Adapters own model calls, transport, response chains, tool scheduling, and native controls.
`apps/core/src/agent` selects and constructs adapters and supplies Core history, compaction, and lifecycle
services. Model fallback disposes the previous execution before constructing its replacement. Core's
bus runner retains durable delivery, lineage/storage finalization, resource authority, and publication.

Core selects native OpenAI and Codex adapters for WebSocket execution. Codex owns OAuth/account headers,
stateless request normalization, backend event repairs, and its SSE fallback. Codex steering remains at
turn boundaries. The OpenAI adapter gates native steering to exactly `gpt-6-astra` in compatible
single-agent settings. Conversation binding and automatic compaction use boundary delivery.

Native tool discovery uses client-executed OpenAI `tool_search` on the official OpenAI API and
Codex native paths for the supported GPT-5.4, GPT-5.5, GPT-5.6, and GPT-6 Astra model families.
The runner supplies deferred catalog declarations through the agent context; local execution still
uses direct-plus-selected tool authority. Search reuses Core's `find_tools` ranking and lineage
selection, while the adapter appends schema-bearing `tool_search_output` items instead of changing
top-level tool declarations. Search-call and schema-snapshot metadata lives in existing message-part
`providerOptions`. Inherited selections missing from retained loading records receive a stable
`additional_tools` seed attached to the new prefix's first message. Replay uses the original snapshots
even after catalog reload; current local authority and validators still decide whether a call can run.
The adapter owns loading projection, and the executor commits its prepared canonical metadata.

AI SDK paths, including OpenAI and Codex SSE, keep portable discovery. Their model-view projection
removes native search metadata and item IDs while retaining ordinary `find_tools` exchanges and
selected declarations. Unknown endpoints/models, explicit conversation/previous-response binding,
tool-choice restrictions, configured server compaction, and retained opaque compaction items also
keep portable discovery. Local compaction can restore inherited selections through a new native seed.
Claude Code continues to own discovery through its existing `ToolSearch` bridge.

Both adapters share the official OpenAI SDK transport, connection leases, continuation matching, and
output reconstruction. A reusable socket survives executions with a five-minute idle expiry; concurrent
executions use dedicated sockets. Credentials and endpoint determine connection reuse. Cached response
IDs expire after 30 minutes. A rejected internal previous-response optimization retries once with full
input before exposing output. Codex turn state survives matching failed-request retries and pending tool
continuations, but does not carry into a new user turn after a completed answer. A narrow patch to the
pinned SDK restores the existing bridge's empty/non-object JSON tolerance and binary UTF8 JSON decoding.

Auto transport may fall back to SSE only before submission; uncertain connection loss after submission
retires and reconciles the attempt. Acceptance reserves an input, while successor creation establishes
its canonical position. Socket, continuation, and steering state remain process-local. Existing accepted
controls and checkpoints provide the recovery floor. Conversion preserves AI SDK-compatible durable
messages and provider metadata, including IDs that Codex omits from its outgoing requests.

Native Responses diagnostics use the `agent:responses` logging module. Core supplies request and session
IDs; execution and connection scopes add attempt, connection, and response IDs where available. Logs
cover adapter selection, connection reuse and retirement, continuation decisions, retries, steering,
fallback, and termination. Opt-in `LILAC_LLM_WIRE_DEBUG` traces use the existing directory, byte limits,
event limits, and shared redaction/writer in `packages/utils/llm-wire-debug.ts`. Native traces record
outgoing events after request normalization and continuation selection and incoming SDK events before
provider repairs. Reused connections attribute events to the current lease; idle events omit request
ownership. Payloads belong to the opt-in traces, not operational logs.

`AiSdkPiAgent` is a delegating compatibility facade. The WebSocket-to-SSE utility remains in use
by legacy Codex OAuth consumers; native Core WebSocket execution does not depend on that emulation.

Claude native authentication, configuration, and transcripts live under `CLAUDE_CONFIG_DIR` or Claude's own default, outside Core stores. Lilac persists only its own bindings and attempt metadata and does not own Claude credentials or transcript retention. See `docs/claude-code.md` for the continuation and deployment contract.

Persisted formats are trust boundaries. Their codecs distinguish current, migrated, valid missing-defaulted, unsupported-version, malformed-serialization, and corrupt-field outcomes as applicable. Reads do not silently rewrite data. SQLite state transitions that pair domain changes with outbox records must remain atomic. Read `MIGRATIONS.md` and `scripts/architecture/README.md` before changing any stored contract.

## Trust And Failure Boundaries

- External HTTP, Redis, SDK, MCP, SSH, filesystem, subprocess, and persistence values are decoded or projected at registered boundaries before entering domain code.
- Open protocol values are normalized into closed local unions with explicit fallbacks. Internal services should not carry domain-bearing `unknown`.
- Expected failures use domain-owned `Result` error unions, including terminal errors for fallible streams. Production code composes Results declaratively rather than reading their branch discriminants. A positive `isErr()` guard may settle only an immutable local produced directly by object-form `Result.try` or `Result.tryPromise`; the registered SQLite rollback adapter separately owns its direct Err check required before driver commit. `Panic` is reserved for registered hard invariants and defects and must not be converted into an ordinary error.
- Object-form `Result.try` and `Result.tryPromise` are the intrinsic external-exception capture boundaries; their catch functions return closed data and never throw, reject, or signal a host. Production `TryStatement` syntax is forbidden. Framework signaling, rollback sentinels, compatibility output, and defect supervision remain allowed only at exact registrations in `scripts/architecture/manifest.ts`. Cleanup uses lexical disposal when its suppression semantics are valid, or explicit Result settlement when failure precedence matters. The manifest also registers event delivery, persisted codecs, SQLite transactions, tool codecs, and cross-workspace consumers.
- Presentation receives closed render-ready projections, not raw SDK/tool payloads or ad hoc parsers.
- Core's Level 2 server has no public authentication contract and must remain on a trusted network.
- Plugins, native tools, workflow agent processes, and other same-user processes are trusted code with service-user authority unless an explicit restricted or OS-isolated boundary says otherwise.

Run `bun run lint:architecture` for the semantic and production-syntax architecture gate. The root `bun run check` overlaps generated-code, lint, tests, typecheck, architecture, and format gates; `bun run ci` runs the conservative serial sequence.

## Runtime Lifecycle Invariants

`apps/core/src/runtime/create-core-runtime.ts` is the composition root. Its exact startup ordering is an implementation detail; preserve these phases and invariants:

- **Prepare:** establish `DATA_DIR`, configuration, stores, artifact/MCP services, and the built-in surface runtime registry before exposing dependent work.
- **Admit safely:** install adapter-event and durable wait/action consumers before connecting producers that could emit matching events.
- **Expose output before execution:** connect and validate registered adapters, establish workflow projection and tool services, then start request ingress and relays before the agent runner can publish replies.
- **Recover accepted work:** start the agent runner paused, load agent-run journal heads, join them to accepted request deliveries, reconcile terminal heads, enqueue active checkpoints and original accepted work, then activate every recovered session queue. Journal failure resets progress or disables journaling for that boot without blocking request recovery.
- **Enable durable producers:** triggers, workflow execution, heartbeat, and background workers start only when the durable queues or consumers needed to avoid losing their work are available. Overall readiness waits for recovery and the remaining required services, and is withdrawn when critical subscriptions become unhealthy.
- **Drain before release:** stop ingress and request producers first, drain agent and relay work to a bounded deadline, then stop consumers and release surface, store, and bus resources. A run interrupted at the drain deadline remains accepted and recovers from its WAL checkpoint or original work. Settle local resource cache fills before closing the shared BlobStore. Surface lifecycle cleanup follows registry ownership and reverse-order release where required; cleanup is best-effort without hiding Panics.

These invariants matter more than a fragile numbered list. Update this section only when the lifecycle contract changes, not when independent setup calls move within a phase.

## Where To Change Things

- Event names, payloads, routing, keys, or codecs: `packages/event-bus/lilac-spec.ts` and compatibility fixtures; delivery behavior belongs in `event-delivery.ts`, `lilac-bus.ts`, and the transport.
- Core process composition or lifecycle: `apps/core/src/runtime/create-core-runtime.ts`, `compose-builtin-surface-runtimes.ts`, and `surface-runtime-lifecycle.ts`.
- Surface ref semantics versus executable participation: `apps/core/src/surface/builtin-surface-protocols.ts`, protocol modules, `runtime-descriptor.ts`, and the platform's runtime descriptor.
- Discord request admission and queue selection: `apps/core/src/surface/discord/discord-request-router.ts`.
- Core resource URI, origin, cache, classification, access, and materialization behavior:
  `apps/core/src/resource`; Discord origin refresh belongs in
  `apps/core/src/surface/discord/discord-resource-origin.ts`.
- Shared run/input/history policy: `packages/agent/agent-executor.ts`; provider execution:
  `packages/agent/adapters` and `packages/claude-code-bridge/claude-code-agent-adapter.ts`; Core adapter
  composition: `apps/core/src/agent`. Core bus/session policy stays in
  `apps/core/src/surface/bridge/bus-agent-runner.ts`.
- Portable coding tools: `packages/coding-tools`, `packages/fs`, `packages/bash-safety`, and `packages/tool-results`. Core host adapters belong in `apps/core/src/tools`.
- Core Level 1 or Level 2 exposure: `apps/core/src/plugins/builtin`, `apps/core/src/plugins/manager.ts`, and the implementation under `apps/core/src/tools` or `apps/core/src/tool-server/tools`.
- Plugin contract, loading, or lifecycle: `packages/plugin-runtime` and `PLUGIN_AUTHORING.md`.
- Core HTTP tool serving, request capability, or health: `apps/core/src/tool-server/create-tool-server.ts`, `request-control-authority.ts`, and `health-state.ts`.
- Skills parsing and Core discovery: `packages/utils/skills.ts`; authoring guidance: `docs/skill-authoring.md`.
- Workflow definition, runtime, persistence, scheduling, waits, or progress: the corresponding owner in `apps/core/src/workflow`; Level 2 adaptation is `apps/core/src/tool-server/tools/programmatic-workflow.ts`.
- Core config/model/provider/prompt behavior: `packages/utils`; config version changes also require
  `docs/core-config-migrations.md`.
- Core managed opaque bytes, adapter behavior, handle/reference codecs, integrity, or expiry:
  `packages/blob-storage`; domain retention and ownership stay with the consuming Core module.
- Architecture boundary registration or a new workspace: `scripts/architecture/manifest.ts` and its focused tests; read `scripts/architecture/README.md` first.
