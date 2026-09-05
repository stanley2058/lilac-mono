# MIGRATIONS.md

This file records persisted-data, wire, and protocol migrations. Manual `core-config.yaml` upgrades are
documented separately in [`docs/core-config-migrations.md`](docs/core-config-migrations.md).

## Workflow schema 27 and staged blob publication

Schema 27 adds `workflow_artifact_publications` to the existing workflow database. Its columns are
`object_id`, the primary key, `artifact_id`, `blob_ref_json`, and `created_at`. The JSON field retains the
expected complete `BlobRefV1` before a staged upload becomes durable. Existing schema-26 workflow data
and artifact references remain unchanged. Startup applies the additive migration automatically.
Databases below the schema-26 blob baseline require the existing offline migration.

BlobStore now supports staged reservations with finite cleanup deadlines. Adoption changes a completed
staged reservation to durable ready through a fenced metadata decision. Existing BlobHandleV1 and
BlobRefV1 formats and ordinary upload behavior stay unchanged. A new internal reservation decision file
coordinates adoption and expiry cleanup.

Core startup attempts a bounded batch of retained publication intents before starting workflow producers.
It logs recovery failures and continues; the existing maintenance cycle retries bounded batches and
duplicate-upload cleanup. Workflow staging has a ten-minute deadline. A failure before intent persistence
leaves staging data for expiry cleanup. A failure after adoption leaves a publication row that can
establish canonical ownership or finish deleting a duplicate.

Expiry or deletion of a staged upload with unfinished byte writes retains its reservation and expiry
index. Maintenance revisits that record to remove bytes from a delayed remote write. Only a producer
that confirms its byte writes finished can retire this cleanup ownership. Process loss or an ambiguous
network failure can therefore leave a small cleanup record indefinitely. Expiry scans advance through
retained records so they cannot prevent other objects from being cleaned up.

Older binaries reject workflow schema 27 and do not understand staged reservation fields or the adoption
decision file. Adopted objects retain staging metadata, so finishing pending publication rows and clearing
unfinished uploads does not make the current store backward-compatible. There is no automatic downgrade.
Rollback requires a coordinated pre-upgrade backup of Core's databases and managed blob storage, or a
separately reviewed downgrade. Stop producers before rollback and restore the backup's databases and
managed blob storage together.

Before any rollback that reuses current storage, resolve pending publications and outstanding backend
writes. Retained unfinished-write records cannot be removed merely because their deadline passed;
elapsed time alone does not prove a remote write has stopped. Existing untracked durable blobs from
earlier versions cannot be identified safely by this migration and are not deleted automatically.

A process interrupted immediately after a delayed backend decision write can leave an inert metadata
file after deletion. It cannot resurrect readable content or a durable blob reference. Completed calls
clean that file; removing every such interrupted marker would require a separate backend storage change.

## MCP 2026-07-28 client and OAuth credentials

Core's configured MCP clients negotiate the stateless `2026-07-28` tool protocol and fall back to the
legacy initialization handshake. The MCP configuration contract remains version 1.

OAuth credential files remain version 1 and now accept optional issuer pins on stored tokens, client
information, and authorization-server information. Existing files need no rewrite and acquire the pin
on their next authorization flow. Before rolling back to an older Core build, back up and delete each
affected file under `DATA_DIR/secret/mcp-oauth`, or remove every `issuer` field from its stored tokens,
client information, and authorization-server information. Run `mcp.auth` again after the older build
starts.

## Level-2 Result, Wire, And CLI Clean Break

Level-2 callable settlement is a clean break with no compatibility layer. Every external Level-2
callable must now return a `better-result` `Result`. The runtime accepts the full `better-result`
Result protocol structurally so Results from plugin-local dependency installations work across the
plugin boundary. Raw values and plain `{ status: ... }` wire-shaped objects without the full
protocol remain invalid. Existing external plugins must be updated and rebuilt before loading.
Expected failures are `Result.err(ServerToolFailure)` with `kind`, `code`, `message`, `retryable`,
and optional JSON `details`. Throws are defects, not expected failures, and are handled by the fatal
defect boundary rather than translated into plugin failures.

The `/call` wire response is exactly `{ status: "ok", value }` or
`{ status: "error", error }`, where `error` is the complete `ServerToolFailure`. There is no legacy
raw-success response or legacy failure-envelope decoding.

The `tools` CLI unwraps a successful wire response and writes the JSON value to stdout. A failure is
written as `{ "status": "error", "error": ServerToolFailure }` JSON to stderr, not stdout. Failure
exit codes are `1` internal, `2` usage, `3` denied, `4` not_found, `5` conflict, `6` unavailable,
`7` timeout, and `8` cancelled. Successful calls exit `0`.

This settlement change does not reinterpret report or diagnostic payloads. A callable that
successfully produces a report remains `Result.ok(report)` even when the report records warnings,
validation findings, unhealthy state, or another negative conclusion. `Result.err` means the
callable itself failed to complete as expected.

## Core SQLite

### Prefix-lineage tool authority

Core transcript schema 10 adds `request_transcripts.loaded_catalog_ids_json`. Each completed request
stores the cumulative deferred-tool selection for that exact conversation prefix. Continuations and
forks inherit the newest reachable request or compaction-checkpoint snapshot from the existing Core
primary lineage. A fresh lineage starts with no deferred tools selected.

Startup drops the former `session_loaded_tools` table. Its session-wide union cannot be migrated safely
because it does not record which branch selected a tool. Existing transcripts remain readable and gain
an empty tool snapshot on their next completed descendant when no reachable schema-10 snapshot exists.
Agent-run checkpoints also carry the current selection so crash recovery does not lose a tool loaded
mid-run.

### Agent questions

Core adds `agent_question_calls` and `agent_question_tokens` to `request-delivery.db`. The tables
store pending Discord question tool calls and hashed one-time interaction tokens. Existing databases
create both tables at startup and need no offline migration.

Question calls belong to a request-delivery record and are removed with that record. A Core restart
marks pending questions as interrupted and removes their live tokens. The Discord adapter then clears
the stale controls after reconnecting. Core does not resume an interrupted question tool call.

### Agent-run WAL and graceful-restart clean cut

Core adds `agent_run_wal_metadata`, `agent_run_wal_events`, and `agent_run_wal_heads` to
`request-delivery.db`. The request-delivery record remains the durable admission queue. The WAL stores
replaceable execution progress for every primary and subagent run admitted through the Core bus runner.
Existing accepted records have no WAL head and recover from their original accepted messages.

This recovery contract is at-least-once. A crash may repeat model calls, tool calls, controls, workflow
dispatches, external effects, or terminal output. Core records a terminal run after it initiates the
terminal surface write. Surface delivery after that point is best effort, and recovery does not recreate
the same Discord or GitHub message.

Checkpoint writes run in a serialized, latest-pending-wins background worker and do not delay later model
or tool work. A failed write keeps the last committed checkpoint. A corrupt run payload deletes that
run's journal progress. An incompatible journal contract recreates only the journal-owned tables. None of
these cases deletes or rewrites accepted request records or blocks startup or new admission. If journal
storage remains unavailable after a reset attempt, Core disables journaling for that boot and continues
from accepted work.

The former runtime graceful-restart snapshot subsystem is removed. Runtime startup does not open,
import, migrate, or delete `graceful-restart.db`; existing files remain inert. The offline unified blob
migration retains its frozen decoder only to classify supported historical snapshots during that explicit
operator command.

Before the first upgrade, stop and drain Core and back up `request-delivery.db` when avoiding duplicate
effects matters. No graceful snapshot is imported. Work accepted by an older build may restart from its
original messages if it has no agent-run WAL head.

`discord-search.db` now records URL-free Discord attachment identity metadata in
`discord_search_message_attachments` and an attachment fingerprint on `discord_search_messages`.
Existing rows retain an unknown attachment fingerprint and are not backfilled. Newly indexed or updated
messages record known empty or populated attachment state; attachment bytes and signed Discord CDN URLs
are not persisted.

Discord attachment cache references now interpret `blob_expires_at IS NULL` as durable when the other
reference fields and `blob_cached_at` form a valid cache entry. No table rewrite or backfill runs. A
finite `surface.discord.attachmentCache.ttl` still rejects a durable entry after its recorded cache time
crosses the configured lifetime, then clears that reference lazily when the attachment is next read.

## Core Unified Blob Storage Clean Break

Core now stores managed opaque bytes through `packages/blob-storage`. Current Redis messages and Core
databases carry versioned `BlobHandleV1` or `BlobRefV1` values, not `dataBase64`, data URLs, SQLite byte
columns, or private domain-owned content paths. Local and S3-compatible adapters share the same
adapter-neutral references. Tool-result encryption and domain retention metadata remain owned by their
domains.

This transition is offline and fail-closed. Runtime startup does not read or rewrite legacy blob state.
Before starting the new runtime, stop Core, back up its data, and run:

```sh
bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data
```

If Core sets `SQLITE_URL`, run the migration with the same environment value. The command resolves
`SQLITE_URL` from its working directory exactly as Core does. Without `SQLITE_URL`, it migrates
`<data-dir>/data.sqlite3`.

Use `--dry-run` for a read-only preflight. The normal command preflights and then applies in one
invocation. It accepts only supported legacy schemas, verifies every copied object's SHA-256 and byte
length, rewrites each database only after its required objects exist, and removes replaced legacy byte
columns and files. The offline command emits transcript schema 6 and workflow schema 26; current Core
then applies transcript schemas 7 through 10 and workflow schema 27 during startup. Databases below
those blob baselines, including partially migrated legacy databases, stop startup with the migration command.

The migration copies durable transcript, projection, lineage, and workflow artifact content. It discards
rebuildable Discord downloads, Anthropic fallback media, and legacy tool-result artifacts. It does not
translate queued Redis requests, output events, pending entries, consumer groups, or dead-letter
payloads. Drain accepted work before cutover when it must finish. Export any required legacy Redis
evidence, then remove the inert old versioned namespaces separately.

The operator-approved graceful-restart exception is narrower and explicit. The offline command discards
one exact, valid snapshot v1, v2, v3, or v4 instead of preserving it. Graceful snapshots contain live
process recovery state whose inline provider bytes have no safe owner after the singleton row is consumed;
adding another durable ownership subsystem is outside this clean break. Stop and drain Core before cutover.
`--dry-run` reports the planned graceful snapshot discard without deleting it. Malformed rows, corrupt v5
rows, future versions, and drifted table layouts remain blockers and are never classified for discard.

The operation is transactional per database, not across the object store and every database. If apply
fails after mutation starts, keep Core stopped, restore the operator backup, and rerun. Do not point Core
at a partially copied local root, bucket, or prefix. Whole-store local-to-S3 or S3-to-local moves are also
offline: preserve object IDs, verify all durable references at the destination, then switch configuration.

Configuration remains version 2. An omitted `blobStorage` field, including the universal projection of a
frozen v1 config, selects the local default under `DATA_DIR`. Only v2 can set a local root or select S3.
S3 credentials are names of environment variables in config; literal credentials are invalid.

Core now emits transient tool-result references as `resource://t1_<128-bit-id>`. Existing
`tool-result://<uuid>` references remain readable by Core until their ordinary TTL or eviction removes
them, so this URI change needs no persisted-data migration. Tool-result metadata, session scope,
encryption, quota accounting, and expiry remain separate from retained `resource://r1_` records. Mini
Lilac continues to emit and consume `tool-result://` references.

## Redis Managed Event Delivery V2

Durable event-bus subscriptions use new transport-owned physical consumer-group names and create missing
groups at the current stream end. Existing unversioned groups, pending entries, and stream entries are not
replayed or migrated. They remain in Redis until an operator deliberately removes the old groups or data;
the v2 runtime never treats them as managed work.

The v2 delivery path stores lease, attempt, retry, and terminalization metadata in a separate versioned
Redis namespace. Existing v1 and v2 dead-letter records remain under their old keys and are not readable
through the v3 record codec. New encrypted records use the `:v3:` dead-letter namespace and are finalized
atomically with source acknowledgement. Deployments that need old event or dead-letter evidence must
export it before switching versions.

Durable subscriptions no longer accept a start offset and always handle only entries added after their v2
physical group is created. Publisher-supplied approximate `MAXLEN` retention is removed. Expiring output
streams remain tail-only, and supported trimming preserves all managed pending frontiers.

## Historical Mini Lilac Database Schema 3

The schema 2-to-3 step preserves sessions, runs, commands, and todos, and replaces mutable full
transcript rows and full-prefix undo checkpoint blobs with immutable, hash-chained model/UI nodes.
Session heads and undo checkpoints reference those chains, so common prefixes are shared while legacy
divergent checkpoint branches remain usable. The step drops `run_chunks`, `model_transcript`, and
`ui_messages` and does not run `VACUUM`. When schema 3 was current, the transaction set `user_version`
to 3 only after migration succeeded and versions other than 0, 2, and 3 were rejected. The current
schema 8 startup path described below supersedes that version acceptance and final-version behavior.

Stream chunks are no longer durable SQLite state. An active session actor keeps a monotonic live log
for replay, tail reconnect, resume projection, and final UI reconstruction. The log is discarded at
run finalization. A process crash therefore retains no partial chunks and startup marks interrupted
runs as errors; finalized canonical transcripts remain durable.

## Historical Mini Lilac Database Schema 4

The schema 3-to-4 step rebuilds the
`sessions` table to widen its status `CHECK` with `compacting` and to add
`input_tokens_estimated`. Every other table cascades from `sessions`, so the rebuild follows
SQLite's documented recipe: `foreign_keys` off and `legacy_alter_table` on around the transaction,
with `PRAGMA foreign_key_check` verified afterwards. No row content changes; existing sessions get
`input_tokens_estimated = 0`. When schema 4 was current, versions other than 0, 2, 3, and 4 were
rejected, and a schema 2 database migrated through 3 to 4 in one startup.

Behaviour changes that accompany the schema:

- Manual compaction sets the session status to `compacting` for its duration instead of leaving it
  `idle`, and `commitCompaction` accepts `compacting` as a valid pre-commit state. An interrupted
  compaction is recovered to `idle` at startup rather than to `error`, because compaction commits
  only on success and therefore never leaves a partial transcript.
- A committed manual compaction now writes the post-compaction token estimate to `input_tokens`
  with `input_tokens_estimated = 1`, where it previously wrote `NULL`. The next turn's reported
  usage clears the flag.

## Historical Mini Lilac Database Schema 5

The schema 4-to-5 step introduces workspace-owned durable history while preserving sessions, runs,
commands, todos, and readable transcripts. It recomputes every transcript-node hash from its parent
hash and serialized value, canonicalizes stored session working directories, creates one `workspaces`
row per canonical directory, and rebuilds session/run ownership around that workspace identity.

Legacy user checkpoints become immutable history states and prompt/steer transitions. Because schema
4 had no workspace snapshots, every migrated state records `workspace_status = unavailable` and
`workspace_unavailable_reason = legacy-migration`; migration does not claim that the filesystem can be
restored. A linear active prompt remains an open transition and can recover. A readable quiescent
history with no checkpoints, or with unusual checkpoint ordering, is preserved as one current
migration state with undo disabled; unusual ordering while a run is active is rejected. Structural
foreign-key, transcript-parent, active-run ownership, and unreadable persisted-data failures abort and
roll back the migration. After successful conversion, `user_checkpoints` is dropped.

The legacy migration codec also removes persisted `data-session` UI parts, converts the old
`data-compaction.data.status` discriminant to `phase` (adding `outcome: compacted` for completed
events), and removes non-user UI messages left empty by that normalization. This compatibility is
specific to legacy database migration; it does not make the old protocol shape valid for current
transcript writes or reads.

## Historical Mini Lilac Database Schema 6

The schema 5-to-6 step rebuilds `history_states` and `history_operations` without changing their rows.
It widens the unavailable/skip reason `CHECK` constraints to admit `platform-unsupported`, preserving
rowids, indexes, history topology, and all existing content. Fresh databases in the current startup
path are created directly with the schema 6 table set before later migrations are applied.

## Mini Lilac Protocol: compaction lifecycle

`miniLilacCompactionEventSchema` replaces its terminal-only `status: "completed" | "failed"` field
with a `phase` discriminant (`started`, `progress`, `completed`, `failed`, `cancelled`) plus
`outcome`, `progress`, `summary`, `elapsedMs`, `durationMs`, and `modelCalls`. Persisted
`data-compaction` UI parts written by older builds carry `status` and no longer parse; they are
rejected at the current transcript boundary rather than silently dropped. The legacy database
migration normalization described under schema 5 is the only compatibility exception.

`POST /sessions/:id/compact` returns a UI message event stream instead of a JSON body. Admission
still happens before the stream opens, so a non-quiescent session is still a 409.

The response stream is a view of the compaction, not its owner. Abandoning the request only detaches
the client: the compaction continues and still commits, and reattaching to it is not supported.
Stopping it is `POST /sessions/:id/compact/cancel`, which answers `{"status":"cancelling"}` or
`{"status":"inactive"}`; the terminal `cancelled` event then arrives on any stream still attached.
Clients that previously cancelled by aborting the request will no longer stop anything.

`compacting` is a session status, and every admission path — prompts included — now requires
`idle`/`error`. A prompt sent during a compaction is rejected rather than raced.

## Mini Lilac Database Schema 7

Schema 7 adds provider-family metadata to history states and pending finalizations, plus
exact-history-state Claude bindings and bounded attempt records for Mini main sessions. Existing
history has unknown provider-family metadata and no native binding, so its next Claude turn starts a
fresh persisted session rather than guessing that native state is synchronized.

Successful Claude turns promote a binding only with their committed terminal history state. Main
bindings remain attached to retained history states, allowing restart, undo, redo, and branch
navigation to select an exact clean native base. Active attempts left by a crash become uncertain at
startup and are never promoted.

## Mini Lilac Database Schema 8

Mini Lilac migrates schema 7 databases to schema 8 transactionally at startup. Schema 8 adds one
current Claude binding and bounded attempt records for named delegated sessions, together
with pending-finalization promotion metadata. Existing named sessions receive no inferred native
binding and start fresh on their next eligible Claude turn. Both caller-supplied and generated names
are eligible; callers continue an automatically named child by reusing the returned name.

Main-session schema 7 behavior is unchanged. Startup recovery marks interrupted named attempts
uncertain and can finish a canonically verified pending success. Foreign keys are checked before
`user_version` becomes 8.

The current startup path accepts a fresh version 0 database and persisted schemas 2 through 8;
schema 1 and every other version are rejected. Fresh databases are created at
the schema 6 table set, and every supported older database receives all applicable steps through 8
in one transaction. Migration uses `foreign_keys = OFF` and `legacy_alter_table = ON` for the required
table rebuilds, verifies foreign keys before setting `user_version = 8`, restores both pragmas, and
does not expose an intermediate schema as the completed startup state.

<a id="core-transcript-database-schemas-1-9"></a>

## Core transcript database schemas 1-10

Core's `agent-transcripts.db` has its own `transcript_schema_migrations` sequence. These are internal
SQLite migrations and do not change `core-config.yaml`; its current config contract remains
`configVersion: 2`.

- Transcript schema 1 records the baseline request transcript/cache tables and the current named
  Claude binding/attempt substrate. Existing transcripts do not gain guessed native bindings.
- Transcript schema 2 adds immutable first-seen surface projections, Core-owned attachment blobs,
  request/checkpoint lineage references, primary lineage manifests, and canonical transcript digests.
  Existing transcript rows are parsed and hashed during migration; an unreadable row aborts the
  migration rather than receiving an unsafe digest.
- Transcript schema 3 adds request-output alias references so split Discord output messages can point
  to one canonical request atom without duplicating history.
- Transcript schema 4 adds Discord-primary Claude bindings and bounded attempt records. A binding is
  usable only when the current composed lineage proves the exact complete-segment prefix; existing
  Discord history starts fresh until a successful current turn establishes that proof.
- Transcript schema 5 adds `terminal_request_id` to every Discord-primary Claude binding. The ID
  points to the exact retained request transcript and lineage manifest that produce the binding's
  atom count, prefix digest, and canonical message count. Migration first considers matching retained
  succeeded attempts, then scans retained durable transcript/manifest rows so a valid binding can be
  backfilled even when bounded attempt retention already pruned its attempt. Every candidate is fully
  recomputed and accepted only when its client/session, provider state, lineage version, atom count,
  digest, and canonical count match exactly. Bindings without one exact durable terminal request are
  deleted rather than guessed.
- Transcript schema 6 is the managed-blob reference baseline produced by the offline blob migration.
  Runtime still refuses schemas below 6 because those databases may contain legacy inline bytes.
- Transcript schema 7 adds strict resource records, transcript resource references, and surface
  projection resource references. The v6 to v7 step is additive and does not rewrite historical
  messages or blobs. A resource row uses one stable canonical-origin key and an optional verified
  BlobStore cache reference. Transcript and projection deletion cascades their reference rows;
  maintenance deletes a zero-reference cache before removing its resource row.
- Transcript schema 8 adds transcript-to-blob ownership references. Provider file bytes are uploaded
  to durable BlobStore objects before persistence, stored in messages as strict blob references, and
  materialized back into provider files on replay. Migration backfills ownership for existing blob
  parts. Transcript retention cascades reference rows. Maintenance claims an unreferenced owned blob
  before deleting its object, which prevents a transcript or surface projection from attaching while
  deletion is in progress.
- Transcript schema 9 adds agent-run-checkpoint blob ownership references. A checkpoint pins every
  referenced blob before replacing the agent-run WAL head, then replaces its ownership set with the
  blobs reachable from the latest checkpoint and its retained predecessor. Startup reconciliation
  removes stale pins left by a crash. If the latest checkpoint blob is unavailable, recovery
  atomically promotes the retained predecessor in the WAL. It resumes from the accepted request only
  when neither checkpoint is usable.
- Transcript schema 10 adds a canonical deferred-tool snapshot to every new request transcript and
  removes the session-wide selection table. Historical rows have no snapshot. Descendants use the
  newest reachable prefix snapshot, or start empty when none exists.

Core applies missing versions in one immediate transaction, validates foreign keys, marks interrupted
native attempts uncertain during startup recovery, and promotes recovered pending successes only
after canonical transcript/lineage verification. Primary binding reads lazily reverify the identified
terminal transcript and manifest. A missing, corrupt, or mismatched head is compare-and-delete retired;
a concurrent replacement is re-read rather than deleted, and continuation safely starts fresh when no
verified binding remains.

Core also exposes aggregate retention diagnostics for named/primary binding counts, active/terminal
attempt counts, unverifiable primary bindings, orphan succeeded attempts/manifests, unreferenced
surface projections, total Core-owned blob bytes, and unreferenced blob counts/bytes. Bounded attempt
pruning emits per-owner metadata-pruned diagnostics. These are internal retention/operational
diagnostics and do not add a `core-config.yaml` key; the config contract remains `configVersion: 2`.

## Historical graceful restart snapshot v5

Snapshot v5 used strict `StoredMessageV1` messages and `CorePrimaryLineageV2`. Runtime recovery no longer
reads this database. Existing rows remain inert. The offline unified blob migration still recognizes its
supported historical schemas for explicit discard; malformed, future, corrupt-current, or
correlation-invalid rows remain blocking evidence for that offline command.

## Historical Workflow Schema 18

At schema 18, workflow capability review stored a normalized maximum envelope with per-operation narrowing, exact Level-1 tools, concrete Level-2 callable IDs, destination-scoped origin surface operations, allowed roots, bounded reasoning, and explicit trusted executable authority. Schema 20 later removed that envelope and approval model.

Pre-envelope revisions cannot be interpreted without changing their approval meaning. Migration 18 therefore removes their dependent runs, triggers, approvals, and revision rows. Workflow source files remain in place and must be triggered and reviewed again under the new contract.

## Workflow Runtime Clean Break

This section records the historical unified runtime transition. It did not read or migrate legacy `WorkflowDefinitionV2`/`WorkflowDefinitionV3` records. Existing `workflows` and `workflow_tasks` SQLite tables remain inert. That transition required recreating scheduled jobs as JavaScript definitions plus `workflow.trigger.create`. Its approval identity included immutable source, schema, capability profile, project path, and runtime version, so old approvals did not carry forward. Schema 20 later removed this approval model, and schema 23 replaced the v3 execution identity with v4.

Deferred subagents persist as generated unified workflow runs. Graceful-restart snapshots no longer contain runner-local deferred child handles, output cursors, timers, or buffered completions. Active generated runs and pending live-parent deliveries recover from the durable workflow database. At this clean break, terminal results fell back to a durable progress card when the parent could not be restored; Schema 24 supersedes that behavior by durably orphaning unreachable live-parent deliveries instead.

At the time of this clean break, workflow JavaScript ran inside a fail-closed OS sandbox that required a systemd-PID1 Docker image with Bubblewrap, cgroup v2, and a reachable `lilac` user systemd manager. That deployment requirement is historical and is superseded by Schema 21, which runs the deterministic program child as a plain Bun subprocess. See the Schema 21 section below.

The Level-2 HTTP server remains an internal trusted-network service rather than a generally authenticated public API. Workflow admission adds no caller-specific or principal gate beyond ordinary Level-2 callable routing; every caller and trigger competes against the same global active-run cap.

## Workflow Schema 20

Schema 20 introduced the profile-native trusted-auto-run clean break for runtime `lilac-workflow-js-v3`. This section records that transition; schema 21 removed its remaining approval tables, and schema 23 replaced v3 executable state. Workflow definitions use `resources` for orchestration bounds, and the public durable hash is `resourcePolicySha256`. The former maximum capability envelope, exact grant identity, approval API/state/actions, `awaiting_review`, and shared-editor lease runtime are removed.

Migration from schema 19 does not translate old authority:

- Every v19 revision receives a bounded `workflow_legacy_audit_records` summary before its executable rows are removed.
- Terminal v19 runs are retained only as audit summaries because their maximum-envelope revision shape is not readable as a v3 resource policy.
- Nonterminal v19 runs and operations, plus active/paused triggers, receive explicit `workflow_quarantine` reasons before deletion.
- All old request dispatches are deactivated before dependent rows are deleted, so no old dispatch can be adopted or redispatched under current defaults.
- Standalone v19 terminal receipts are archived as bounded `terminal_receipt` audit records and deleted with their old runs; no receipt can outlive the executable identity it referred to.
- Old triggers and generated subagent revisions are deleted and must be recreated from current source by an authenticated trusted principal.
- At schema 20, historical approval tables and columns remained inert to avoid a SQLite table rebuild. The v3 runtime did not read or write approval records. Schema 21 later dropped those tables and columns.
- `workflow_shared_editor_leases` is dropped. Shared writers are intentionally concurrent.

After migration 20, source files remained on disk and were statically revalidated into a new v3 snapshot on their first trusted invocation. Removed `capabilities` metadata fails validation with migration guidance; rename resource bounds to `resources` and use only profile-native `agent()` options.

The unshipped workflow-only `plugins.workflowExternal`, plugin `workflowExposure`, and Level-1 effect metadata were removed rather than migrated. Config v2 now owns Level-1 tools/plugins, Level-2 callables/plugins, direct network, workspace writes, execution, and delegation under each `agent.subagents.profiles.*` entry. Config v1 remains frozen and receives the useful built-in profile defaults during universal parsing. These native profiles apply identically to direct and workflow-launched subagents and are not serialized into workflow revisions or operation guardrail envelopes.

## Workflow Schema 21

Schema 21 was the workflow-runtime-simplification clean break for the historical v3 runtime. The guiding rule is that workflows orchestrate and profiles authorize: the workflow layer keeps durable operation identity, dispatch epochs, single-owner claims, terminal receipts, waits, triggers, replay, and progress, and drops every workflow-specific security concept. This is an atomic migration that shrinks the persisted dispatch policy while still reading persisted v20 dispatches.

Resolved `agent()` input is reduced to `profile`, `cwd`, `model`, `reasoning`, and `label`. `cwd` is free-form and no longer canonicalized against protected roots. Agent authority comes entirely from the selected native profile: profiles own tools, Bash, Level-2 callables, network, and delegation, identically for direct and workflow launches. The former `isolation`, `editing`, `tools`, `executables`, `level2Callables`, `surfaceOriginOperations`, and `delegation` agent options are removed and fail validation with migration guidance.

Schema 21 spawned the deterministic program child directly with `bun --smol workflow-sandbox-child.js`. The child kept its determinism lockdown and NDJSON protocol, and the host retained wall-time, cancellation, output-size, and protocol limits with forced termination. Schema 23 later removed the workflow-wide wall-time limit. `maxRuntimeMemoryBytes` is removed because a plain Bun subprocess does not enforce that contract; it is stripped from persisted revision limits. Workflow execution no longer requires systemd, Bubblewrap, cgroup v2, or user namespaces, and there is no plain-subprocess fallback to fail closed against.

The persisted state migration is a clean break rather than a reinterpretation:

- The minimal durable dispatch policy is `{ runId, operationId, dispatchEpoch, profile, model, reasoning, resolvedModelRequest, cwd, originSession, stableNamedContinuation? }`. The optional stable identity is present only for eligible live-parent named subagents and is verified against that run's persisted completion target. Old `policy_json` is rewritten into this envelope; the former `canonicalCwd` becomes `cwd`, and canonical-root, inode, safety-mode, isolation, scratch-root, and control-token identity are dropped.
- Terminal runs, operations, journals, results, and receipts stay readable. Pinned resolved-model identity and dispatch fencing are preserved.
- Nonterminal v20 runs and operations are quarantined with explicit reasons, then terminalized as `cancelled` with an explicit migration reason; their pending waits are cancelled.
- Active and paused triggers are quarantined and cancelled; they must be recreated from current source by an authenticated trusted principal.
- All active request dispatches are deactivated so no old dispatch can be adopted or redispatched under the current defaults.
- `maxRuntimeMemoryBytes` and revision `safety` metadata are removed from revision rows, and `safetyMode` is removed from trigger origins.
- Approval residue is dropped: the `workflow_approvals` table, the `approval_id` columns on `workflow_runs` and `workflow_surface_actions`, the `origin_safety_mode` column, and the approval-state index.
- Worktree residue is dropped: `workflow_worktree_outputs` and its cleanup index.
- Single-process projector residue is dropped: projection claims, orphans, missing-binding tables and triggers, and reconciliation state. One durable surface binding per run, the action outbox, edit-on-change, startup reconciliation, retry state, controls, and terminal cards are retained.

The workflow-only security modules removed in this break (Level-1 boundary, path authority, protected-path, denied-root policy, network policy, descriptor path, scratch, and worktree artifact) are deleted rather than migrated. The dead tool-bridge `x-lilac-workflow-capability` header and plugin `workflowPathAuthority` guidance are removed. Level-2 `workflow.*` access follows native profile configuration and the generic profile-bound request capability; there is no workflow-specific active-request or principal gate.

## Workflow schema 22

Schema 22 adds durable materialization attempt/error state to live-parent completion deliveries. Deferred subagent results retry artifact loading and output normalization across process restarts before Core inserts an explicit failed synthetic result, preventing transient delivery failures from either losing successful child output or waiting forever.

## Workflow Schema 23

Schema 23 and runtime `lilac-workflow-js-v4` remove the workflow-wide wall-time contract. Workflow programs, sleeps, reply waits, pauses, and recovery have no total elapsed-time limit. Individual child-agent operations retain `operationIdleTimeoutMs`, and explicit cancellation still forcibly terminates the workflow subprocess.

The v4 API also removes the unused public `parallel(..., { concurrency })` option; `parallel(promises)` joins already-created promises, while `pipeline(..., { concurrency })` provides bounded fan-out. Reply waits are explicitly limited to the authenticated originating Discord session. Literal host-call option objects receive static validation before a definition is saved or triggered.

Terminal results, terminal detail, and requested result artifacts are returned without sensitivity gating. Sensitive input fields, argument hashes, and progress values remain redacted. The obsolete `includeSensitiveResult` run-inspection option is removed.

This is a clean break for persisted v3 execution identity. Migration 23 archives bounded summaries for old revisions, runs, triggers, and terminal receipts; quarantines nonterminal runs and active triggers; deactivates dispatches; and removes v3 executable rows. Source definition files remain on disk and can be corrected and saved as v4 definitions. The request-dispatch table no longer has a hard expiry column; active state, run and operation state, dispatch epochs, owner heartbeats, idle cancellation, and exact terminal receipts govern its lifecycle.

## Workflow Schema 24

Schema 24 makes an unreachable live-parent delivery a durable `orphaned` state instead of creating a
fallback progress card. Migration rebuilds `workflow_completion_deliveries`, converts every historical
`fallback` delivery to `orphaned`, and clears `progress_target_json` on the corresponding live-parent
run so the retired fallback card is not recreated. Other delivery fields, including materialization
attempt/error state, are preserved.

At startup, pending live-parent chains are retained only when their parent request is restorable or
reachable through another retained active workflow request. An unreachable nonterminal run has its
operations and waits cancelled, active dispatches deactivated, and run terminalized as `cancelled`
before its delivery becomes `orphaned`. An unreachable terminal run keeps its terminal state and
result, but its delivery becomes `orphaned`. This reconciliation is idempotent and does not reinterpret
an orphan as delivered.

## Workflow Schema 25

Schema 25 adds nullable `permanent_failure_json` to each durable workflow surface binding. Existing
v24 bindings keep their message reference, rendered hash, retry count, next attempt, errors, and
timestamps and receive no permanent failure. The v24 persistence reader also treats the absent field
as `null`; v25 rows require the field.

A permanent surface failure or missing registered progress port now persists a gate containing the
operation/reason, failure time, message, and surface configuration revision. The projector clears its
retry time and revokes active controls, and startup reconciliation does not repeat the same permanent
failure while the target and configuration revision still match. A changed target or progress-port
configuration clears the stale gate and allows projection to be attempted again; retryable failures
continue to use the existing durable backoff state.
