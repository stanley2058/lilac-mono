# MIGRATIONS.md

## Native web keybindings

Keyboard shortcuts are stored only in the browser under `lilac-keybindings-v1`, scoped to the
installation and principal. The version 1 payload contains physical key codes and modifiers for
each action; null disables an action. Missing, invalid, duplicate, or unsupported payloads use
default bindings without rewriting storage. No Core configuration or server-data migration is needed.


## Native reaction names

Reaction responses add optional `userNames` (at most five display names) and `overflowCount`.
Core projects these fields from current users when personalizing messages; stored messages need no
backfill. Update Core and web together because older strict response validators reject these fields.


## Native deployment settings

Native settings `titleModel`, `outputStreaming`, `oldMessageSelectionMaxAgeMs`,
`storageRetentionMaxAgeMs`, and `crossThreadSend.triggerRun` now live in a singleton
`deployment` record in the native database. Startup creates the record once from the existing
parsed `surface.native` values, including version-owned defaults. Existing database values always
win on later starts. The migration does not rewrite `core-config.yaml`; the old keys remain readable
for initial import only and can be removed after successful startup. Changing those YAML keys no
longer changes a migrated installation's runtime behavior.

Settings > Deployment replaces the response streaming control in Options. All five settings are
instance-wide and owner-only. Saves use an atomic database transaction with a revision check.
New output attempts and title jobs use the latest settings; active output attempts keep their mode.
Message selection and retention maintenance read the current settings when they run.

Native RPC replaces `config.readStreaming` / `config.setStreaming` with `config.readDeployment` /
`config.setDeployment`. Update Core and web together. The native database format remains version 1
with an additional record kind; older builds cannot manage this record. Keep a pre-upgrade database
backup if a rollback is needed.

## Conversation references

Native web adds `references.resolve` and `references.read`, and display-message metadata accepts an
optional `reference` containing surface, session ID and optional source message ID. Update Core and
web together because older strict response validators reject this metadata. References persist as
ordinary Markdown links in existing message and draft text; there is no database migration or backfill.
Core expands those links into agent coordinates under the native thread starter's authority.

Browser panel state accepts thread-preview tabs. Older clients may discard saved tabs when reading
this new variant; sidebar and panel widths remain readable. Native and external message links use
`/?ref=<surface>:<sessionId>&message=<messageId>` with URL-encoded query values. Omitting `message`
opens the session at its normal latest position. A reference grants no access. Missing external
history is not fetched from Discord.

## Retained external runs

The native external conversation view now reads retained agent runs rather than live channel messages.
Display-message metadata adds optional `externalRunId` for conversation dividers. This legacy field
identifies the retained continuation chain, so linked requests share a divider group. Both Discord and GitHub read
cursors now page backward through retained runs; reload open external views when upgrading. Update Core
and web together because older strict response validators reject the new metadata. The authenticated
resource route also serves retained Discord resource IDs, owner-only transcript file references, and
retained sent-file handles. Expired sent files keep placeholders when attachment metadata remains in
the transcript. Existing output retention is unchanged.
No stored-data migration or historical backfill is required.

## Link previews

The authenticated native RPC contract adds `links.preview` for page titles, descriptions, images,
and favicons. Update Core and web together to enable hover previews. Older clients do not call
the new method; newer clients keep ordinary links usable if the method is unavailable.
Metadata uses an in-memory browser query cache. No stored-data migration is required.

## Agent Discord identity

The native service-user record and agent catalog accept optional `discordUserId`. Owners can set
or clear it through `identity.update`; omitted input preserves the existing link, and `null` clears it.
Matching Discord messages use the agent identity in the web chat. This is a display link and does not
change permissions. Existing records need no backfill. Update Core and web together; older strict
parsers cannot read the new field. Clear the link before downgrading to a version without this field.

## External conversation display

External thread responses now include optional `sourceUrl`, and display-message metadata accepts
optional `authorDisplayName`. External authors are rendered from metadata instead of prepended text.
External lists use latest activity first; their opaque cursors still identify the last thread on a page.
Update web and Core together because older strict response validators reject the new fields.
No stored-data migration is required.

## Temporary operator conversations

Native v1 thread records accept optional `ephemeral: { sessionId, lastSeenAt }`. Normal records omit
it. Each operator invocation uses a UUID session identifier and root bearer token on a private,
loopback-only gateway. POST `/api/operator/session` creates or renews that invocation; DELETE ends it.
These endpoints are absent from the public web gateway. Existing native RPC schemas are unchanged.
Expired invocations cannot recreate their deleted thread. Deletion receipts and scrubbed tombstones
remain under the existing native deletion contract. Startup cancels/deletes abandoned temporary
conversations before accepted-request recovery. A downgrade must not read records with the new field;
back up native storage before upgrading and restore the matching backup when rolling back.

The image now contains the console and uses its existing Bun runtime. Standalone TUI release assets,
local/Clerk terminal login, and client disk cache support are removed. Existing host TUI binaries and
old credential/cache directories are not automatically deleted. Stop using those binaries and remove
those local files if no longer needed. Web authentication and retained conversations are unchanged.
Operator-only Core startup is enabled by the existing container operator-token hash without enabling
the public native listener or requiring Discord. The native owner ID is reused if web is enabled later.


This file records persisted-data, wire, and protocol migrations. Manual `core-config.yaml` upgrades are
documented separately in [`docs/core-config-migrations.md`](docs/core-config-migrations.md).

## Native surface version 1

The optional native surface adds version-1 JSON/oRPC client contracts, native session/message refs,
and `native-surface.db`. Existing installations keep native disabled. The new store owns users,
memberships, threads, turns, command receipts, upload handles, read/reaction state and bounded replay
changes. It uses its own SQLite schema version and strict per-record codecs. It does not import or
replace Discord's store. Native private projection provenance never enters display payloads.

Version-2 core config accepts optional `surface.native`. Version-1 config normalization leaves native
disabled. Old-message selection and storage retention both default to disabled. Existing v2 config
without this section behaves unchanged. Remove the section before using a strict older parser.

The transcript/resource database advances to schema 13. Schema 12 adds native resource ownership
references, and schema 13 retains canonical native transcripts while native history refers to them.
Global transcript age/count pruning cannot remove native conversation history behind the surface.
Rewind, deletion and explicit native retention release those references through the existing recovery
path. Resource records accept immutable native upload origins; their origin thread controls access.

Native refs are additive to current surface/workflow event schemas. Frozen legacy snapshot validators
still reject native values. Restore a consistent backup before downgrading a database to an older
build, and drain native work before removing the gateway. Keep native state together with existing
request-delivery, WAL, transcript/resource, event-bus and managed blob data.

Browser projection caches are scoped by installation, principal, protocol and projection version.
They are disposable: unsupported versions or invalid coverage require a fresh recent window, while
server conversation history remains authoritative. Never copy one user's cache into another scope.

## Native automatic titles

The optional `autoTitle` flag on `threads.create` marks a supplied title as an automatic fallback.
Updated web and TUI clients opt in for first-line titles and leave manual draft titles unchanged.
Clients that omit the flag keep their explicit titles. Update clients and servers together.

Native v1 thread records accept optional private `titleGeneration` metadata containing the first input
ID and the initial/refinement phase. Existing records without it keep their titles. No backfill or
SQLite schema change is needed. Manual renames remove this metadata; automatic updates also verify
that history has not been rewound or deleted. Older strict parsers cannot read records containing the
new field. Restore a consistent backup before downgrading.

## Native file resolution

The v1 RPC contract adds authenticated `files.resolve` with a thread ID and filesystem path. It
returns the resolved path, filename, media type, and existing authenticated preview URL. Resolution
requires thread edit access and uses the thread's filesystem permissions and deny paths. Existing
published-path records and file-serving routes are reused; no database migration is required.
Update clients and servers together to enable inline-path previews.

## Native web theme selection

The web app stores the selected built-in theme for each color scheme under `lilac-theme-palette-v1`.
The value is browser-wide, like the existing `lilac-theme-v1` scheme preference. The JSON value holds
`light` and `dark` theme IDs. Missing, invalid, unknown, or unavailable values use Lilac for both.
Older clients ignore the key. No backend data or existing browser preferences require migration.

## Native web local panel layouts

The web app stores device-local panel preferences under `lilac-panels-v1`, scoped by installation and
principal. The JSON value contains the global sidebar width/open state and right-panel width/open
state pairs keyed by thread ID. Missing, invalid, or unavailable storage uses the existing defaults.
Older clients ignore the new key. No backend data or existing browser preferences require migration.

The value now also stores each thread's ordered tabs, file targets, and active tab ID in an optional
`tabs` field. Existing values without tabs retain their layouts and start with the Agents tab.
Malformed tab data resets tabs without discarding layout preferences. File targets accept an optional
inclusive `endLine` alongside `line` for range navigation. File contents and subagent transcript
selection are not stored. Builds predating this field reject the extended value and use
default layouts; removing `tabs` from the value restores their ability to read the layout preferences.

## Native personal sidebar queues

The native store adds `native_user_preferences` and `native_thread_preferences`. These additive
SQLite tables hold each user's inactivity threshold, section, order, and activity frontier. Existing
threads enter Active in creation order, newest first, and inactive threads settle when the sidebar is
read. The default threshold is three days. Pinned threads and running conversations do not auto-settle.
New conversation activity re-enqueues settled threads at the top of Active; activity does not reorder
an already active thread. Renaming and changing access do not count as conversation activity.
Moving a thread into another section restarts its inactivity threshold; reordering within a section
does not.

The v1 RPC contract adds `sidebar.preferences`, `sidebar.configure`, `sidebar.list`, and `sidebar.move`.
These operations always use the authenticated user and require read access to each affected thread.
Settling and pinning are personal organization, independent of shared archive or deletion. No background
worker or shared thread mutation is introduced. Update clients and servers together for the new UI.

## Native account profiles

Native users can edit their own display name and avatar. Local profiles use the existing name and
managed avatar fields; startup preserves the owner's edits. Clerk installations save names and images
in Clerk, then project them locally. Display names update Clerk's first name and clear its last name;
sign-in usernames are unchanged. The optional stored `providerAvatarUrl` holds Clerk's profile image
URL. Existing records need no backfill. Older strict record parsers cannot read this new field.

The v1 wire contract adds `profile.get` and `profile.update`, optional `avatarUrl` on display users, and
optional `starterAvatarUrl` on thread summaries. Authenticated `PUT`/`DELETE /api/profile/avatar` edits
only the caller's avatar. `GET /api/users/:id/avatar` reads local public profile images. Managed blob
references and provider user IDs remain private. Clients and servers should be updated together.

## Native display identity and previews

Native v1 user records now accept an optional `avatar` containing a managed blob reference and a
validated raster image media type. Existing records omit it and retain their initials fallback.
The stable `lilac` service-user ID and authority are unchanged; startup preserves its display name
and avatar. Only the owner can change either. Avatar reads require native authentication and are
installation-wide, independent of private thread attachment grants.

Display catalogs optionally carry `agent` identity. Existing disposable client caches without it
remain readable and use the default identity until catalog reconciliation. Thread summaries add
optional `starterDisplayName` and `displayStatus` display fields; the server emits these using existing
thread/read state. The existing `native_surface_read` table is initialized by `NativeStore`, with no
schema or read-state migration.

The filesystem `fs.read_bytes` request accepts optional `prefixBytes` from 1 through 65,536.
Without it, reads retain their whole-file limit and result shape. Prefix reads return at most that
many bytes and add `totalBytes`, the original size reported by the opened file. `bytesLength` remains
the returned prefix length and `fileHash` hashes those returned bytes; prefix reads do not establish
a full-file edit hash. Both local and SSH paths retain their existing denied-path checks.

Text preview endpoints cap returned UTF-8 prefixes at 64 KiB and preserve the originating thread's
resource authorization. Binary data returns a displayable error. Published file previews read a bounded prefix of the
latest file, as before. The new preview endpoints do not create file snapshots.

## Native web local drafts

The existing scoped browser draft cache also holds unsent new conversations under `draft:` IDs.
Draft rows accept optional title and model selection metadata. Existing rows remain readable; no
IndexedDB version or backend schema changes. An older web build may ignore rows with the new optional
metadata. File selections remain in memory and must be reattached after a browser reload.

## Native terminal cache version 1

The terminal client writes versioned private credential and transcript files separately. Its
`cache-v1.json` atomically commits replay checkpoints and hydrated/deferred slots, bounded to 64 threads
and 32 MiB. Cache entries are scoped by installation, principal, protocol and projection version.
Unsupported or corrupt cache files reset from the server; they never migrate canonical history.
Credential files are keyed by the server origin hash and contain session or OAuth refresh credentials,
never the local Basic password. Logout removes the credential and purges the principal's cache.
See [native setup](docs/native-surface.md) for locations and permissions.

Fresh installer deployments default to native web/terminal with authentication. Updating or reinstalling
an existing deployment retains its configured surfaces and port bindings. Existing Core configurations
without `surface.native` remain disabled; no configuration-version bump enables a listener implicitly.

## Native output recovery frontier

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

## Native surface tool output

The internal `evt.native.output` union now accepts a `resource` event for attachments to an active
response. It references an existing native upload and projects the existing `data-resource` display
part. Resource events use the same publication ordinal and checkpoint frontier as text. This does not
change the native client protocol version or add a database table.

New projected assistant messages include `metadata.authorId: lilac`. Older projected messages retain
access through their existing assistant role and projection ID. Startup idempotently restores transcript
links where native input records identify the response's request. Standalone historical messages without
known ownership are left unlinked.

Older core builds reject the new strict event variant. Drain native work and preserve a consistent backup
of native state, transcripts, blobs and retained output events before downgrading.

## MCP value source prefixes

Environment and file references in `mcp-config.yaml` accept an optional string `prefix`.
For example, `Authorization: { env: MCP_TOKEN, prefix: "Bearer " }` adds the authentication
scheme without storing it in the token. Prefixes are prepended verbatim after resolution,
including after whole-file trimming or JSON Pointer selection. The shared value-source format
also supports prefixes in stdio environment values and static OAuth client values.

The file remains `configVersion: 1`; existing configurations keep their behavior. Reload with
`mcp.reload` or restart Core after editing. Older builds reject references containing `prefix`;
remove the field and include the prefix in the referenced value before downgrading.

## Agent tool approval removal

Lilac executes available tools without an approval step. Per-tool `needsApproval` callbacks are no
longer evaluated, and agent options do not expose a `toolApproval` policy. Input validation, tool
availability rules, and cancellation still apply. Existing persisted approval message formats remain
readable; no stored-data or configuration version changes are needed.

## Image generation script interface

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

## Tool launcher build artifacts

Built tool installations now include `tools-build-id` and `tools-build-info.json` beside
`tools` and `tools-worker`. Install all four artifacts together. The launcher and worker
read the shared ID at startup; a missing or malformed ID prevents startup. The ID remains
part of the invocation protocol. Socket names hash the installation path and worker ID
so separate installations cannot share a worker with different metadata.

Docker writes version metadata only in `/app/build/build-info.json` and links the tool
metadata file to it. Local tool builds write their metadata beside the executables.
Metadata changes no longer change the worker ID or require recompiling either executable.

## Skill read tool replacement

`skills.read` replaces `skills.brief` and `skills.full`; both old callables are removed without aliases.
Update scripts, prompt tool maps, and explicit callable allowlists to use `skills.read`. The generated
config and both versioned parsers' default allowlists use the replacement callable. Existing explicit
allowlists are not rewritten.

The new tool accepts `name`, with no `maxChars` option. Its response fields are `path`, `length`,
`metadata`, and `content`, in that order. `content` is the complete raw `SKILL.md`, including frontmatter;
`length` counts its UTF-16 code units. The old body, truncation, and resource-listing fields are removed.
Bash output limits continue to apply. See [skill authoring](docs/skill-authoring.md) for discovery and
catalog behavior.

## MCP subagent access defaults to disabled

Each server in `mcp-config.yaml` now accepts `allowSubagents`, a boolean that defaults to `false`.
The file remains `configVersion: 1`. Existing files still parse, but their MCP tools are no longer
available to subagents, including `general` and `self` profiles with wildcard permissions.

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

## Agent-run checkpoint local MCP images

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

## Computer-use gateway schema 1 and Core session header

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
encryption, quota accounting, and expiry remain separate from retained `resource://r1_` records.

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

<a id="core-transcript-database-schemas-1-9"></a>

## Core transcript database schemas 1-11

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

- Transcript schema 11 adds nullable `deleted_ts` to surface-message aliases. Existing rows remain
  live. Surface deletion marks an alias deleted while transcript lookup and request-alias lineage
  validation retain its request identity. Recovery targets, recent output links, discovery coverage,
  and checkpoint live-output checks exclude deleted aliases. A database trigger removes every alias
  when its request transcript is deleted, including age-based retention and checkpoint cleanup.
  Deleted aliases without a transcript expire under the configured transcript age limit during
  retention cleanup. Unlimited age retention keeps them.
  Previously removed aliases cannot be reconstructed by this migration. Older binaries reject schema
  11; rollback requires a pre-upgrade backup or a separately reviewed downgrade.

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

## Native subagent inspection

The native v1 RPC contract adds `subagents.list` and `subagents.read`. Both require read access to the
parent thread and exclude runs whose parent request is no longer in canonical history. Workflow run
IDs remain opaque, including their existing colon-separated prefixes. The new panel reads existing
workflow and transcript stores; there is no stored-data migration. Update clients and servers together.

Transcript responses contain bounded pages of display text and activity labels. They omit system
prompts, raw reasoning, tool arguments, and provider state. Older runs without retained transcripts
show an unavailable state. Panel visibility and pixel width are local to the current workspace session.

## Shared cross-surface conversation memory

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
