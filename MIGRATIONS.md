# Upgrade and rollback reference

Use this reference before changing deployed binaries or stored-data formats. Configuration-file
conversions are in [Core configuration upgrades](docs/core-config-migrations.md); native setup and
day-to-day behavior are in [Native surface](docs/native-surface.md). Git history retains the sequence
of feature introductions. This file keeps the cutover steps and compatibility constraints that still
matter when upgrading an older installation.

## Plan the cutover

1. Identify the installed build, config version, and database schema versions. Configuration,
   native protocol, and SQLite schema versions are independent.
2. Drain work when repeated external effects would be harmful, then stop Core and other producers.
   Recovery is at least once; a backup cannot undo a tool's external effects.
3. Back up Core databases, managed blob storage, and required Redis state as one consistent set.
   Use a coordinated shutdown or consistent SQLite backup; copying a live database without its WAL
   can lose accepted work. Preserve configuration and credential files privately.
4. If transcript storage predates schema 6 or workflow storage predates schema 26, run the offline
   blob migration below before starting current Core. Later supported schema migrations run at startup.
5. Apply configuration and caller conversions. Upgrade Core, tools, web, and shared clients together;
   update the optional computer gateway as described below. Reload old browser tabs.
6. Verify startup health, a new request, retained history, resource reads, and configured integrations.
   Verify native deployment settings and subagent authority after adopting v3.

Rollback uses the matching pre-upgrade databases and blob storage together. Current workflow schema
28, transcript schema 14, and native schema 7 are not readable by older builds. Strict record codecs
can also change within a schema version; a matching version number alone does not establish downgrade
compatibility. Keep producers stopped while restoring. Never remove migration markers to force an
older binary to open current data.

## Configuration and caller changes

### Native transport selection

Native deployment settings add `transport`, with `auto`, `websocket`, and `http-sse` values.
Existing deployment records decode a missing field as `auto` without rewriting the record.
Bootstrap responses publish the policy, and deployment changes trigger the existing bootstrap resync.
Deploy Core, web, and TUI together because older strict wire decoders reject the new fields.
Before downgrading, remove `transport` from the stored deployment settings or restore a pre-upgrade
backup. The native database schema version is unchanged.


For v3, follow the [ordered upgrade procedure](docs/core-config-migrations.md#upgrade-procedure).
V1/v2 remain readable. Their legacy profile model choices are ignored; delegated models are selected
per call. V3 changes default delegated authority from restricted to full when the caller can grant it.
The installer previews resolved permission profiles before writing and preserves the config version.

### Subagent permission profiles and config v3

Subagent role profiles (`explore`, `general`, `self`) are replaced by named permission profiles under
`agent.subagents.permissions`, with built-in `full` and `restricted`. `subagent_delegate` takes
`model`, `reasoning`, and an optional `permissions` name instead of `profile`, and its result returns
`permissions` instead of `profile`. A child may request only profiles within its own authority.
Workflow `agent()` keeps its required `profile` option; the value now names a permission profile
other than `primary`. Workflow runs do not record who started them, so a subagent may call
`workflow.run.trigger`, `workflow.run.resume`, or `workflow.trigger.create` only when its profile can
delegate and holds the authority of every configured profile.

Every subagent loads the worker prompt (`AGENTS.md` and `TOOLS.md`) with one subagent overlay, the
skills section, and a list of the unloaded prompt files with their paths. The former `self` profile
loaded the full persona prompt; no subagent does now. Subagents run the delegated model alias, or
`models.main` when none is named.

Stored data keeps the existing `profile` fields. Workflow dispatch policies, completion targets,
agent-run checkpoints, request headers, and the native `subagentSummary.profile` field now hold any
permission profile name. Names written before this change resolve when no configured profile has
that name: `explore` to `restricted`, and `general` or `self` to `full`. Frozen v1 and v2 configs
keep a `general` profile with its configured authority, so their stored `general` runs keep it. A run
whose profile name no longer resolves fails model resolution, and its tool checks grant nothing.
Plugins receive the profile name as a string in `subagentProfile` and `Level1RunProfile`.

Config files need `configVersion: 3` to configure permission profiles; see
[`docs/core-config-migrations.md`](docs/core-config-migrations.md#v3). Frozen v1 and v2 configs keep
parsing. There is no database migration. Deploy Core and web together so the web client accepts
profile names other than the three former roles.

### Config v3 retired tools and settings

`content.inspect`, `surface.messages.search`, and `attachment.download` are removed without aliases
for every config version. Migrate callers to ordinary media reads or a capable model,
`discovery.search`, and `resource.materialize` respectively. `content.inspect`'s dedicated Gemini
video/transcription workflow has no direct replacement. Custom permission allowlists and plugin lists
must drop the retired names. The Discord message cache, ingress indexer and shared discovery path remain;
only the old search callable's first-search history backfill is removed.

Config v3 rejects `tools.inspect`, legacy web/recall spellings, flat decision thresholds, and the five
native YAML deployment settings. V1/v2 input parsing remains supported. Follow
[the v3 migration instructions](docs/core-config-migrations.md#retired-tools-and-v3-configuration-fields)
before changing the config version, especially the one-time native settings import. Existing deployment
records are retained; fresh v3 records use the existing defaults. No persisted schema, table, blob,
or history is deleted by this change.

### Batch retirement

The `batch` tool and tool-call expansion API are removed. Ordinary model-issued calls run concurrently
in received-order groups separated by `write`, `edit`, and `patch` calls, including their legacy
aliases. Each mutation waits for the preceding group and finishes before the following group starts.
Bash calls may race. The Claude MCP bridge applies barriers in request-receipt order; Claude owns when
it submits those requests. Existing `tools.batch.maxCalls`, `supportsBatch`, and `editTargets` fields
remain accepted for configuration/plugin compatibility but no longer control execution. Remove them
from maintained configurations and plugins. Old transcripts remain replayable; a newly attempted
`batch` call receives the ordinary unknown-tool error.

### Skill read tool replacement

`skills.read` replaces `skills.brief` and `skills.full`; both old callables are removed without aliases.
Update scripts, prompt tool maps, and explicit callable allowlists to use `skills.read`. The generated
config and both versioned parsers' default allowlists use the replacement callable. Existing explicit
allowlists are not rewritten.

The new tool accepts `name`, with no `maxChars` option. Its response fields are `path`, `length`,
`metadata`, and `content`, in that order. `content` is the complete raw `SKILL.md`, including frontmatter;
`length` counts its UTF-16 code units. The old body, truncation, and resource-listing fields are removed.
Bash output limits continue to apply. See [skill authoring](docs/skill-authoring.md) for discovery and
catalog behavior.

### Agent tool approval removal

Lilac executes available tools without an approval step. Per-tool `needsApproval` callbacks are no
longer evaluated, and agent options do not expose a `toolApproval` policy. Input validation, tool
availability rules, and cancellation still apply. Existing persisted approval message formats remain
readable; no stored-data or configuration version changes are needed.

### Image generation script interface

`generate.image` now accepts only `{ code: string }`, with JavaScript executed by Bun in the calling
CLI's cwd and Core's inherited container environment. Replace calls using `prompt`, `model`, `size`,
`aspectRatio`, `inputImages`, `maskImage`, or `outputDir` with scripts. The injected global `providers`
maps configured `openai`, `openrouter`, and `xai` connections to `{ baseURL, apiKey? }`. Tool discovery
advertises configured provider names; model choices and request examples live in the built-in
`image-generation` skill.

Successful execution collection returns `{ stdout, stderr, exitCode, truncated }` inside the existing
Level 2 Result envelope, including when a script exits nonzero. Callers must check `exitCode`. Scripts
own image decoding and file writes and should print saved paths. The former image path, MIME, model,
and warning result fields are removed. Each stream is capped at 40 Ki characters and configured image
provider keys are redacted. Scripts have a 10-minute limit and receive caller cancellation through
process termination. A failed or interrupted script is not automatically retried.

The callable now has native container execution authority and is removed from restricted-session
allowances. Trusted callers with permission to call it can execute arbitrary code and access the
container environment. There is no additional sandbox. `generate.video` keeps its existing contract.
No stored data or configuration version changes are needed. Rollback requires restoring old callers
alongside the old tool implementation.

### Level-2 Result, wire, and CLI clean break

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

### Tool launcher build artifacts

Built tool installations now include `tools-build-id` and `tools-build-info.json` beside
`tools` and `tools-worker`. Install all four artifacts together. The launcher and worker
read the shared ID at startup; a missing or malformed ID prevents startup. The ID remains
part of the invocation protocol. Socket names hash the installation path and worker ID
so separate installations cannot share a worker with different metadata.

Docker writes version metadata only in `/app/build/build-info.json` and links the tool
metadata file to it. Local tool builds write their metadata beside the executables.
Metadata changes no longer change the worker ID or require recompiling either executable.

## Native deployment upgrade

Native uses protocol version 1 with strict display and RPC codecs. Deploy Core and clients together
even when the protocol number stays unchanged. Browser projection caches are disposable and scoped
by installation and principal; canonical conversation history remains on the server. Reload external
conversation views after upgrading. Old standalone terminal binaries and their credential/cache files
are no longer used; run the container-local operator console and remove obsolete local files if unwanted.

Native schema migrations run automatically. The current schema is 7:

- Schema 1 establishes the native store. Record additions include deployment settings, DMs,
  temporary operator conversations, HTML previews, identity, and title-generation metadata.
- Schema 2 adds child agent streams. Completed older children are projected lazily from retained
  transcripts; original timing and phase events cannot be reconstructed.
- Schema 3 adds Web Push signing keys and per-browser subscriptions. Existing notification event
  choices are preserved; background push starts disabled.
- Schema 4 adds durable deferred-send groups. Existing records need no rewrite.
- Schema 5 adds optional initiating-device identity. Older inputs retain broadcast notifications.
- Schema 6 adds native questions and optional question-reply references. Existing records are retained.
- Schema 7 adds per-user model favorites, optional reasoning on threads/inputs, and child task/model
  display metadata. Existing aliases and old completion targets remain valid.

Before moving customized native settings to config v3, start with v2 and verify the one-time import
of `titleModel`, `outputStreaming`, `oldMessageSelectionMaxAgeMs`, `storageRetentionMaxAgeMs`, and
`crossThreadSend` in Settings > Deployment. Existing deployment records win. Remove the YAML keys
only after verification; v3 rejects them. The import preserves YAML comments and does not rewrite it.
Fresh v3 deployments use the documented defaults in the configuration upgrade guide.

`dmContextMaxAgeMs` is replaced by `dmContextGapMs` (7,200,000 ms) and `dmTimestampGapMs`
(1,800,000 ms). The stored decoder drops the former setting and applies the new defaults; a custom
age cannot be translated to a pause length. Review both in Settings > Deployment. DMs are permanent;
older builds do not enforce that property, so restore a pre-upgrade backup before rollback.

Update caller integrations as follows:

- Replace `suppressRun` with `triggerRun` on `surface.messages.send`. Its default is false;
  use true only to request destination execution. Heartbeat remains notification-only.
- Replace `config.readStreaming` / `config.setStreaming` with `config.readDeployment` /
  `config.setDeployment` and use the revision returned by the read when saving.
- `question` defaults to deferred and returns an accepted call ID. Explicit sync returns the
  mode/status/call ID plus answers. Update callers expecting only `{ answers }`. Native deferred
  questions survive restart; sync waits are interrupted. Discord pending calls are interrupted.
- `notifications.presence` accepts `clientId` and optional `threadId`, independently of push endpoints.
- Use the shared `streams.*` display APIs for child inspection. Current streams include redacted
  activity details and available reasoning; old transcript-only views omitted those details.

Native question replies use ordinary input submission with `questionReply`; acceptance and resolution
commit atomically. Question-store initialization retains old Discord calls/tokens and assigns sync
mode to those rows. For current notification, question, DM, and reference behavior, see the native
operating guide instead of inferring behavior from the schema that first introduced a feature.

### Native schema 4: deferred surface sends

A default native send returns a queued acknowledgment without a visible message reference. Groups
retain first-send order per destination and become visible after the sender settles and the destination
has no active or pending input. Pending attachments retain their bytes. Startup reconciles groups;
retries do not duplicate delivered messages. Deleting the destination removes its groups, while a
history-generation change or lost write access discards them at delivery checks. There is no expiry
or operation-status API. Avoid resending an accepted message while it waits for delivery.

### Native output recovery frontier

Native runs add an optional `nativeOutput` field to version-1 agent-run WAL checkpoints. It stores
`ordinal`, the last native output publication covered by that checkpoint, and `position`, the display
ordering boundary. Existing checkpoints without this field remain valid. Non-native runs omit it.
The checkpoint writer waits for the captured durable publication barrier before writing the field with
canonical history. A failed publication retains the earlier checkpoint or accepted input.

The new fixed `evt.native.output` topic uses nonexpiring managed durable delivery. Its internal events
carry a publication ordinal separate from their original display position. Native recovery publishes a
reset through the saved ordinal, retaining the checkpointed projection prefix and removing abandoned
output. Recovery from accepted work without a checkpoint retains no prior output. Private native
projection provenance supports this rollback and never enters client payloads.

Drain native runs before downgrading to a build without this contract. Older strict WAL readers may
reject native checkpoints containing the new field and restart from accepted input. At-least-once
model/tool execution remains unchanged; the frontier does not make external effects exactly once.

Active-response attachments share the output publication frontier. Drain native work before rollback;
older builds reject newer output event variants. Keep native state, transcripts, blobs, accepted requests,
and retained output events together. Historical standalone messages without a known request remain
unlinked; startup only restores links it can prove from retained native inputs.

### Native computer viewer through Core

`computer.read.desktop.url` can now be a root-relative `/computer.html?...` URL. Native web resolves
it against the Core origin and uses the dedicated authenticated `/api/computer/socket` lane. Core
connects to the computer-use gateway's new bearer-authenticated `/viewer/socket` endpoint with a
canonical session hash and desktop generation. Deploy Core/web and gateway together and reload
existing browser clients. There is no stored-data migration or runner rebuild requirement. Direct
`provision` viewer URLs are unchanged.

When upgrading from before the original viewer integration, also rebuild the gateway and runner
images and reprovision existing desktops. The later Core-proxy change alone does not require a runner
rebuild. Direct provision viewer URLs retain their contract.

## Storage cutovers and recovery

### Core unified blob storage clean break

Core now stores managed opaque bytes through `packages/blob-storage`. Current Redis messages and Core
databases carry versioned `BlobHandleV1` or `BlobRefV1` values, not `dataBase64`, data URLs, SQLite byte
columns, or private domain-owned content paths. Local and S3-compatible adapters share the same
adapter-neutral references. Tool-result encryption and domain retention metadata remain owned by their
domains.

This transition is offline and fail-closed. Runtime startup does not read or rewrite legacy blob state.
The legacy migration tools were removed after commit `f2c90667`, the last commit containing them.
Older deployments must first check out `f2c90667`, stop Core, back up its data, and run the command
below from that checkout. Complete the migration before upgrading to the current release:

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
then applies transcript schemas 7 through 14 and workflow schemas 27 through 28 during startup. Databases below
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

Blob storage is configurable in v2 and v3. An omitted `blobStorage` field, including the universal projection of a
frozen v1 config, selects the local default under `DATA_DIR`. V2 and v3 can set a local root or select S3.
S3 credentials are names of environment variables in config; literal credentials are invalid.

Core now emits transient tool-result references as `resource://t1_<128-bit-id>`. Existing
`tool-result://<uuid>` references remain readable by Core until their ordinary TTL or eviction removes
them, so this URI change needs no persisted-data migration. Tool-result metadata, session scope,
encryption, quota accounting, and expiry remain separate from retained `resource://r1_` records.

### Workflow schema 27 and staged blob publication

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

### Workflow schema 28: cancellation intent and atomic waits

Core upgrades workflow schema 27 to 28 online. It adds the run-claim index on
`(state, claimed_at, run_id)` and a wait-deadline index. Due waits use separate due-time
and deadline scans. Existing run and wait records retain their values.

Cancelled operations retain an interrupt intent in `workflow_cancellation_outbox` in the
same transaction as cancellation. The engine retries publication with the stored delivery
identity and removes the intent after successful publication. Operations and their waits
now commit together, so recovery cannot observe a newly journaled wait operation without
its wait. Existing incomplete pairs are repaired during replay.

Back up the workflow database before upgrading. Older builds reject schema 28. Drain
workflows and cancellation intents before restoring the pre-upgrade database for rollback.

### Redis managed event delivery v2

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

<a id="core-transcript-database-schemas-1-9"></a>

### Transcript storage

Current `agent-transcripts.db` uses schema 14. Schemas below the managed-blob baseline of 6 require
the offline command above. Startup applies supported later migrations in a transaction and validates
foreign keys. These migrations retain canonical history and add resource/ownership references,
deferred-tool snapshots, deleted-output aliases, native retention, and image-preview metadata.

Native ownership in schemas 12/13 prevents global transcript pruning from deleting native history
behind the surface. Rewind, deletion, and configured native retention release those references.
Schema 14 adds nullable image-preview metadata; originals and resource IDs remain unchanged, and
missing previews regenerate on demand. Restore a pre-upgrade backup for older binaries.

Prefix-lineage tool snapshots replace the old session-wide `session_loaded_tools` union. That table
is dropped because its selection cannot be assigned to a branch safely. Existing descendants inherit
the newest reachable snapshot or start with no deferred selections. Deleted output aliases keep their
request identity for lineage validation but are excluded from live output and recovery targets;
previously removed aliases cannot be reconstructed.

Claude continuation bindings are reverified against retained canonical transcripts and lineage.
Unverifiable bindings are retired and continuation starts fresh. Existing transcripts do not acquire
guessed bindings. Corrupt historical rows can block migration rather than receive invented digests.

### Accepted work and agent-run checkpoints

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
migration at `f2c90667` retains its frozen decoder only for that operator command.

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

### Agent-run checkpoint local MCP images

Version-1 agent-run checkpoints now accept an optional `mcpImages` array. Each entry identifies a tool
result content position and records its absolute local path, MIME type, byte length, SHA-256, and
optional filename. The corresponding stored message contains a text path marker, not inline bytes or
a managed blob reference. Only MCP `image` results successfully written by Core's existing local
materializer use this representation. Embedded MCP resources and ordinary binary `read` results keep
their existing behavior. Final transcript persistence still uses managed blobs for inline images.

Recovery reads each surviving local file and restores its inline image only when its length and hash
match. Missing, unreadable, or changed files become text notices without discarding the checkpoint.
The local files remain temporary and gain no new retention or cleanup policy.

Existing checkpoints without `mcpImages` decode unchanged. No database schema migration or old-image
migration runs. Older Core builds reject checkpoints containing the new field and can discard that run's
journal progress, then recover its original accepted work. Drain active runs before downgrading to avoid
that loss of progress and repeated work.

### Older workflow databases

Workflow source files survive the executable-state clean breaks. For installations predating the
current runtime `lilac-workflow-js-v4`, review source, save current definitions, and recreate triggers.
Legacy `workflows` / `workflow_tasks` tables are inert. Migration 18 removes pre-envelope dependent
runs/triggers/revisions; migration 20 archives bounded audit summaries, quarantines active work,
deactivates dispatches, and removes old executable identities. Migration 21 cancels nonterminal v20
work and active/paused triggers while preserving readable terminal records. Migration 23 archives
v3 summaries and removes v3 executable rows. None of these steps carries old approvals forward.

Current workflows use profile authority and resource bounds. Remove `capabilities`, approval metadata,
`maxRuntimeMemoryBytes`, and per-agent isolation/editing/tool/envelope options from old source. Use
`resources` and the current `agent()` options. Workflow programs run as plain Bun subprocesses with
determinism and protocol controls; systemd, Bubblewrap, cgroups, and user namespaces are no longer
required. Tool authority comes from the permission profile, not a workflow sandbox.

There is no workflow-wide wall-time limit. Child operations retain inactivity limits and cancellation
terminates the program. Replace `parallel(..., { concurrency })` with `parallel(promises)` for already
started work or `pipeline(..., { concurrency })` for bounded fan-out. Reply waits require the authenticated
originating Discord session. Remove `includeSensitiveResult`; terminal results are available through
the ordinary result path while sensitive inputs remain redacted.

Schema 22 retains completion materialization failures for retry. Schema 24 converts unreachable
live-parent deliveries to `orphaned`, clears fallback-card targets, and cancels unreachable active
chains at startup. Terminal results remain retained; orphaned does not mean delivered. Schema 25
persists permanent progress-delivery failures so restart does not repeat them until the target or
surface configuration changes. Retryable failures retain backoff. The schema-26 blob baseline and
schema-27 publication recovery are covered above.

### Shared cross-surface conversation memory

Conversation memory now indexes Discord and native threads in the shared conversation-thread tables
in the Discord search database. The first open without the `conversation_index_v2` marker drops and
recreates only those derived thread, summary, facet, FTS, and embedding tables. Retained Discord
messages, native records, conversation IDs, grants, resources, and canonical transcripts are unchanged.
Native runtime startup drops the obsolete `native_thread_summaries` table. No old summaries are copied.
The materializer rebuilds Discord groups, and native entries are projected from current retained turns.
The existing summarization worker regenerates quiet eligible threads and their embeddings. Recall is
incomplete until that refresh finishes; manual `conversation.thread.runSummarization` can trigger it.

Every conversation-memory result now includes `surface`, and native thread references are
`native:<threadId>`. Deploy Core and its tools together. Both agent origins can search and read all
retained native conversations, independent of native ownership and grants; Discord allowlists still
apply. Native UI read and write permissions remain unchanged. Derived native state is discarded when
its retained message content or history generation changes, including edits, rewinds, and deletion.
Model selection, titles, archiving, and grant changes preserve existing summaries. Downgrading requires
rebuilding the derived index for the older runtime; do not reuse cross-surface derived rows with an older binary.

### Conversation memory entries and DM context windows

A conversation thread can now hold several summary entries, one per distinct subject. Summary, facet,
and embedding rows are keyed by thread and entry ordinal. The first open without the
`conversation_index_v3` marker drops and recreates the derived thread, summary, facet, FTS, and
embedding tables, as the `conversation_index_v2` cutover did. No summaries are copied. Core then
rematerializes every Discord channel once in the background; the marker keeps that rebuild pending
across restarts until it finishes. Native threads are projected from retained turns on the first
refresh. Recall is incomplete until the summarization worker has regenerated every quiet eligible
thread and its embeddings. The worker handles `conversation.thread.summarization.batchSize` threads
every ten minutes; manual `conversation.thread.runSummarization` has no batch limit. Retained Discord messages,
native records, and canonical transcripts are unchanged.

Search and automatic recall return one result per entry. A result keeps its `threadId` and adds
`offset` when the entry's subject starts after the first message; pass it to
`conversation.thread.read`. Verbose results add `entryId`, which is the thread ID for the first entry
and `<threadId>#<ordinal>` for later ones. Metadata and reads list every entry under `entries` when a
thread has more than one. Entry ordinals are reassigned whenever a thread is summarized again.
Automatic recall records entry IDs, so a later turn can recall another subject of a thread it already
recalled. Transcripts written before this change recorded thread IDs, which exclude the first entry.

The permanent native DM is indexed as one conversation thread per context window, using the same
turn-timing gap rule and deployment DM context gap as the agent's context selection. Window IDs are
`native:<threadId>:<firstMessageId>`. A closed window is summarized once; only the open window is
rebuilt when the DM receives a message. `native:<threadId>` for a DM resolves to its newest window in
metadata and reads. Other native threads keep `native:<threadId>`. Changing the DM context gap
re-splits the DM on the next refresh. Downgrading requires rebuilding the derived index for the older
runtime.

### Background jobs

Core creates `background-jobs.db` and the `background-jobs/` log directory on first start. No existing
data changes. Canonical transcripts can gain `job_event` generated messages. A build that predates
them reads one as ordinary tagged user text, so a rollback keeps working but shows the model those
messages without their generated marking. A rollback leaves the new database and logs unused, and any
job still running at that point is not reported or stopped by the older build. Older web clients show
a wake's native turn as an empty row, and an older build cannot parse an in-flight Discord wake's
request ID, so drain work before rolling back.

### Periodic job retention

Core now removes ended jobs and their output files every hour while job wakes are active,
using the existing retention period. Previously this ran only during restart reconciliation.
The job schema is unchanged. Export retained output before it reaches the retention limit;
deleted output cannot be recovered by downgrading.

## MCP and computer-use integration

### MCP subagent access defaults to disabled

Each server in `mcp-config.yaml` now accepts `allowSubagents`, a boolean that defaults to `false`.
The file remains `configVersion: 1`. Existing files still parse, but their MCP tools are no longer
available to subagents, including profiles with wildcard permissions.

Add `allowSubagents: true` to each server whose subagent access should continue, then reload it with
`mcp.reload` or restart Core. The server flag and the profile's Level 1 plugin/tool allowlists must all
permit access. A profile wildcard cannot override `false`. Primary-agent access is unchanged.
Leave computer-use disabled unless subagents should be able to operate their own desktops.

The restriction applies when Core assembles a run's toolset, including resumed runs. Saved catalog
selections cannot restore tools excluded from that toolset. Existing active toolsets retain their
snapshot; finish or interrupt those runs before relying on a changed policy. A failed reload retains
the previous server configuration, so check the reload outcome before starting new work.

Older builds reject server entries containing `allowSubagents`. Remove the field before downgrading;
the older build will again grant MCP access according to profile allowlists alone. This is a tool
access policy, not OS isolation from MCP endpoints for subagents with native host execution.

### MCP value source prefixes

Environment and file references in `mcp-config.yaml` accept an optional string `prefix`.
For example, `Authorization: { env: MCP_TOKEN, prefix: "Bearer " }` adds the authentication
scheme without storing it in the token. Prefixes are prepended verbatim after resolution,
including after whole-file trimming or JSON Pointer selection. The shared value-source format
also supports prefixes in stdio environment values and static OAuth client values.

The file remains `configVersion: 1`; existing configurations keep their behavior. Reload with
`mcp.reload` or restart Core after editing. Older builds reject references containing `prefix`;
remove the field and include the prefix in the referenced value before downgrading.

### MCP 2026-07-28 client and OAuth credentials

Core's configured MCP clients negotiate the stateless `2026-07-28` tool protocol and fall back to the
legacy initialization handshake. The MCP configuration contract remains version 1.

OAuth credential files remain version 1 and now accept optional issuer pins on stored tokens, client
information, and authorization-server information. Existing files need no rewrite and acquire the pin
on their next authorization flow. Before rolling back to an older Core build, back up and delete each
affected file under `DATA_DIR/secret/mcp-oauth`, or remove every `issuer` field from its stored tokens,
client information, and authorization-server information. Run `mcp.auth` again after the older build
starts.

### Computer-use gateway schema 1 and Core session header

The optional gateway creates its own SQLite database, defaulting to `/data/computer-use.sqlite`, with
`PRAGMA user_version=1`. This does not migrate Core's databases. The `runners` table stores session
hash, desktop generation, Docker container ID, Python runtime ID, reserved port, provisioning/ready/
terminating state, viewer password, idle timeout, and absolute expiry. Session, generation, and port
are unique. Runtime IDs distinguish a surviving interpreter from a restarted process. The database
uses WAL and full synchronous commits; its file permissions are 0600.

Startup rejects unknown schema versions or invalid records before admitting MCP calls. It retains only
unexpired ready records matched to usable owned Docker containers and removes owned outliers. It never
restores a missing desktop from metadata. Failed inspection retains unresolved reservations and fails
readiness. Keep the database volume and gateway ownership label together. Removing the volume alone
loses credentials and intent, and does not remove sibling runner containers. There is no downgrade path
for gateway schema 1; stop and explicitly terminate its runners before removing the integration.

Core's MCP configuration remains version 1. HTTP tool calls now reserve `x-lilac-session-hash` for a
SHA-256 digest of `lilac:mcp-session:v1`, a NUL separator, and the trusted UTF-8 canonical session ID.
Static configuration cannot supply this header. Initialization and discovery omit it; stdio is unchanged.
Existing HTTP servers may ignore the added header. An older Core build can discover this gateway but
cannot use its runner tools because it does not supply the required routing identity. Disable this MCP
server before rolling Core back. Bearer authentication still uses the existing static-header contract.

The runner's local newline-JSON protocol carries `info`, `health`, and `execute` requests through Docker
exec and a persistent Unix socket. It is private to the gateway/runner image pair. Deploy compatible
images together; replacing a runner always creates a new desktop generation and password. Existing
runners continue using their original image until termination or expiry.

See [computer-use operation](docs/computer-use.md) for rollout, retention, and verification commands.

## Prompt and heartbeat migration

No config version, wire schema, or database schema changes. Core seeds missing `prompts/HEARTBEAT.md`
and `prompts/heartbeat/WORK.md` from the built-in heartbeat skill. Existing files and legacy inbox/archive
notes remain unchanged. Ask the agent to use the heartbeat skill's migration reference to merge old
responsibilities and active prompt instructions, preserve destinations, and verify delivery. Startup
no longer creates empty legacy inbox/archive directories. The default destination remains optional in
configuration and is selected through conversation during setup; native is not required.

Trusted cross-surface agent capabilities now grant the configured native owner's existing thread access.
Native-origin runs retain their original principal. Restricted or unverified requests receive no owner
fallback, and other users' private DMs remain inaccessible. Heartbeat posts are notifications and do not
admit another agent turn in their destination. This is a deliberate authority-policy change, not a change
to human login or thread-sharing permissions. Deploy Core; web clients need no protocol upgrade.

## Tool-result artifact maintenance

Blob-backed tool-result artifacts now keep a process-local metadata index and schedule cleanup at the
next expiry. Startup still discards the previous process's encrypted artifacts because the encryption
key is ephemeral. No metadata format or blob-reference version changes. Maintenance checks metadata
and expiry without reading every artifact's content. Artifact reads still authenticate their content.
Deploy the tool-results package with Core. Rollback requires no data conversion.

### GitHub webhook delivery identity and bounded media failures

GitHub webhook prompts and synchronize interrupts now derive `requestDeliveryId` from
`X-GitHub-Delivery` and the operation name. Replays use the same durable admission identity.
Previously admitted requests keep their existing IDs. No stored records need rewriting.
Requests without that header keep generated IDs. A webhook HTTP acknowledgement now precedes
GitHub API work. Handler failures are logged and remain eligible for redelivery.

Byte reads use an internal `MEDIA_TOO_LARGE` tag. Remote byte-read failures may include an
internal `errorCode` with that value, so Core can present size guidance without matching error text.
Model-facing read error codes are unchanged; oversized media returns `UNKNOWN`.
Upgrade Core and the published remote filesystem runner together. Existing remote failures
without `errorCode` remain readable and keep their original error text.

SSH multiplexing uses private temporary control sockets with a 60-second idle lifetime.
Bundled remote runners are cached under `${XDG_CACHE_HOME:-$HOME/.cache}/lilac/remote-runners`
by SHA-256 content hash. No database migration is required. Those runner files can be removed
when no tool calls are active; a failed execution invalidates Core's deployment cache so the next call repairs the runner.

## Redis subscription owner leases and reaping

Managed Redis subscriptions now register an owner key per process and subscription incarnation under
`<stream>:subscription-owner:*`, plus an index at `<stream>:subscription-owners:v1`. Owners renew every
10 seconds with a 60-second TTL. An expired ephemeral owner cannot renew or resume its subscription.
Durable subscriptions register their owner again after expiry. A Redis script checks expiry and destroys abandoned ephemeral groups
atomically. Managed-delivery state is cleared afterwards, outside the script. Durable groups remain;
only consumers with no pending entries are deleted. Pending deliveries keep their existing recovery
policy. Reaping runs while a subscription to that stream is active.

Deploy the new Core normally. Groups left by older builds have no owner registration and require
manual inspection and cleanup. Older builds ignore these additive keys. Stop new subscribers before
rolling back; expired registrations can be removed after their groups have been checked.

## Bundled model catalog data asset

The bundled models.dev fallback is now committed JSON, decoded through the existing typed catalog
schema when a catalog cache is seeded. Docker builds use these committed bytes and no longer fetch
models.dev. Refresh the snapshot explicitly with `bun run codegen:model-catalog`, review the JSON
change, and commit it. `bun run build:model-catalog` remains an alias for that command.

The SQLite catalog cache keeps schema version 1 and its existing daily refresh policy. Existing
caches and deployments need no data rewrite. Deployments can roll back without migrating the cache.
