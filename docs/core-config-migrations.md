# Core configuration upgrades

Use this guide when changing `core-config.yaml` versions or upgrading a deployment with older
settings. For current fields, defaults, and examples, use [configuration hover and completion](core-config.md).
For database cutovers and rollback, use [MIGRATIONS.md](../MIGRATIONS.md).

## Upgrade procedure

1. Back up the configuration and the coordinated deployment data before upgrading binaries.
2. Keep the existing config version for the first startup. V1 and v2 still parse; startup never
   rewrites a file to v3. An omitted `configVersion` means v1.
3. For native installations with customized YAML deployment settings, start with v2 once and
   verify the imported values in Settings > Deployment before removing those keys.
4. Apply the v3 field conversions below. Update custom skills, scripts, plugins, and tool allowlists
   for removed callables even if you keep v1 or v2.
5. Review delegated authority before setting `configVersion: 3`. V1/v2 default delegation to
   `restricted`; v3 defaults to `full` when the caller can grant it, otherwise the caller's profile.
6. Validate the edited file with the matching local schema, restart where required, and verify the
   selected models, permission profiles, and native deployment settings. Deploy Core and clients together.

The installer supports guided edits to v2 and v3 and preserves the existing version. Its final review
shows resolved permission profiles, including omitted defaults. V1 can be reinstalled unchanged;
convert it manually before using guided edits. The installer does not perform a version migration.

## Review subagent authority

Compare each old profile's authority with its destination profile. Move `explore` to `restricted`,
`self` to `full`, and preserve `general` as a custom profile if its permissions matter. Remove the
per-profile model policy and choose the model per delegation instead. Existing v1/v2 profile model
fields also no longer select the worker model.

Built-in `full` allows all globally enabled tools and callables, network, workspace writes, native
Bash, and further delegation. Built-in `restricted` allows its read-oriented tool/callable list and
network, denies workspace-writing tools and further delegation, and still uses native Bash.
Custom profiles inherit omitted fields from `restricted`. Inspect `level1`, `level2`, `network`,
`workspaceWrites`, `execution`, and `delegation` for every configured profile.

`workspaceWrites: false` restricts tool availability. Native Bash still runs with the Core service
user's filesystem authority. Set `execution: restricted` for virtual restricted Bash, `false` to
remove Bash, or use OS isolation when native commands need filesystem isolation. A child can only
select profiles within its own authority. MCP servers additionally require `allowSubagents: true`;
profile wildcards do not override that server flag.

To retain a read-oriented default after adopting v3, explicitly configure the `full` profile with
the authority you intend, or instruct callers to select `restricted`. The name `full` itself does
not override configured authority. Review this choice before enabling unattended delegation.

## v3

`configVersion: 3` removes the legacy fields listed below, including `agent.subagents.profiles`. Subagent role profiles are
replaced by named permission profiles, and the delegating agent picks the model per call.

Replaced v3 field:

- `agent.subagents.profiles` is rejected with migration guidance. Move authority fields to
  `agent.subagents.permissions.<name>`: `level1`, `level2`, `network`, `workspaceWrites`, `execution`,
  `delegation`, and optional `promptOverlay`. Drop `modelSlot`, `model`, `reasoning`, `options`, and
  `fallback`; subagents run the alias named in `subagent_delegate` or `agent()`, and `models.main`
  otherwise.

New v3 fields:

- `agent.subagents.permissions.full`: always present. Defaults to every tool and callable, network,
  workspace writes, native Bash, and delegation. A delegation without a named profile uses `full`
  when the caller may grant it, and the caller's own profile otherwise.
- `agent.subagents.permissions.restricted`: always present. Defaults to the former `explore` authority.
- `agent.subagents.permissions.<name>`: custom profiles. Names are lowercase slugs of at most 32
  characters, other than `primary`. Omitted fields use the `restricted` defaults.

Mapping a v2 file:

| v2 | v3 |
| --- | --- |
| `profiles.explore` authority and `promptOverlay` | `permissions.restricted` |
| `profiles.self` authority and `promptOverlay` | `permissions.full` |
| `profiles.general` authority | a custom profile, or drop it in favor of `full` |
| `profiles.*.model`, `.modelSlot`, `.reasoning`, `.options`, `.fallback` | removed; choose available catalog models or `models.def` aliases per delegation |

Frozen v1 and v2 configs keep parsing. Their `explore` profile becomes `restricted`, their `self`
profile becomes `full`, and their `general` profile keeps its name and authority. A delegation without
a named profile uses `restricted`, the former `explore` default. Per-profile model
fields are ignored.

### Model catalog and option rules

V3 discovers selectable models from models.dev for configured runtime providers. The build bundles a
snapshot that seeds a shared SQLite store at `DATA_DIR/cache/models.dev.sqlite`. Every Core worker reads
single rows from it, and only the main isolate fetches. Stale data refreshes at most daily in the
background. Failed refreshes retain the last good data. The store is a rebuildable cache: deleting it, or
upgrading to a build with a different store version, reseeds it from the snapshot. Upgraded installs can
delete the unused `DATA_DIR/cache/models.dev.json`.
`models.catalog.providers.<provider>` accepts `auto` (default), `enabled`, or `disabled`.
Enabling a catalog does not supply credentials or install a provider adapter.

`models.def` aliases, main/fast slots, and fallback chains keep their existing meaning. Add ordered
`models.rules` entries with `match` globs, optional `options`, `reasoning`, `legacy`, and `unset`.
`*` matches any characters, including slashes. Rules apply to the resolved provider/model in file order,
then alias options, then explicit slot/run options. Objects merge recursively; arrays and scalars replace.
`null` remains a provider value. `unset` removes dot-separated option paths at that rule's position.
Capability overrides remain under `models.capability.overrides`. Overrides deep-merge onto upstream
metadata for the same model, preserving omitted fields such as attachment support, modalities, pricing,
and output limits. Arrays replace base arrays. An explicit `inherit` selects a different base, including
another override. If upstream metadata is unavailable, a standalone override must provide
`limit.context` and complete any supplied cost or modality definitions. Providers in
`forceUnknownProviders` still skip upstream lookup. V2/v3 accept partial overrides without `inherit`;
the frozen v1 parser retains its completeness checks.
Codex uses OpenAI metadata. Claude Code's opus/sonnet/haiku/fable aliases inherit the latest stable family
metadata while retaining the harness alias for execution.

V3 delegation accepts every available catalog model or configured alias. `agentCanSelect` is accepted
but ignored in v3; it only controls dynamic alias selection in v2. The `model_catalog` tool provides
bounded provider/search results and exact model lookups, including supported reasoning and option defaults. Composer favorites do not restrict it.
The composer stores favorites per user and reasoning per thread. Changing models resets reasoning to
the new model default. Legacy models remain searchable and visible in Favorites.

`subagent_delegate.title` is an optional task label of up to 80 characters. When omitted, the existing
native title service generates one from the task, with a prompt excerpt while generation is pending.
Task titles remain separate from activity and completion state. Native rows retain the executing
provider/model and permission profile, including the final model after fallback.

### Retired tools and v3 configuration fields

This release removes `content.inspect`, `surface.messages.search`, and `attachment.download` for
all config versions. Remove their names from custom callable/plugin allowlists and update scripts
and skills that invoke them. Use `discovery.search` with `platform: discord` and `sessionId` for
session-scoped memory retrieval, and `resource.materialize` for inbound resources. Discovery searches
the retained index; it does not perform the retired search tool's first-search Discord history backfill.
The Discord message store, ingress indexer, and new-message backfill remain in use.

`content.inspect` has no single replacement. Use ordinary reads/fetches or a suitably capable model
for supported media. Its dedicated Gemini transcription, video analysis, Google search and URL-context
workflow is removed. `tools.inspect` is rejected in v3; v2 accepts and ignores it.

V3 rejects these legacy input forms with migration guidance, including when both old and new keys
are present. V1/v2 retain their existing input compatibility:

- `tools.web.search` becomes `tools.web.extract`.
- `tools.web.extract.provider` becomes `tools.web.extract.providers: [provider]`.
- `conversation.thread.jevAutoInject` becomes `conversation.thread.decisionAutoInject`.
- `conversation.thread.autoInjectMode: jev` becomes `decision`.
- Flat `decisionAutoInject` probability thresholds must move into `jev` and `luna` if retaining
  the legacy section. These thresholds no longer control retrieval. Prefer removing the section
  after transferring its model list to `autoInject.gate`.

V3 also rejects `surface.native.titleModel`, `outputStreaming`, `oldMessageSelectionMaxAgeMs`,
`storageRetentionMaxAgeMs`, and `crossThreadSend`. These settings belong in Settings > Deployment.
Before switching a customized v2 installation to v3, start it once with v2 and the existing YAML
settings so Core imports them into the native deployment record. Confirm those settings in the UI,
then remove the YAML keys and set `configVersion: 3`. Existing deployment records always win at startup.

A fresh v3 installation uses `titleModel: fast`, `outputStreaming: paragraph`, unlimited selection
and storage ages (`null`), and `crossThreadSend.triggerRun: true` as its initial deployment settings.
Change these through Settings > Deployment after installation. No database schema change or data
deletion is part of this removal.

## Current recall configuration

Automatic recall uses the query planner and search ranking. Enable it with
`conversation.thread.autoInject.enabled`; summaries and embeddings have separate enable flags.
The optional `autoInject.gate` supports `off`, `shadow`, and `enforce`. Omission leaves the gate off;
a configured gate defaults to shadow. Enforce skips only confident negatives, using
`skipMinProbability` (default 0.8). Failures continue to planning.

Move legacy `autoInjectMode: decision` or `jev` and the decision model list to
`autoInject.gate`. Legacy modes normalize to a shadow gate; an explicit gate takes precedence.
Remove `autoInjectMode`, `decisionAutoInject`, and `jevAutoInject` from maintained files after
transferring the model list. Old candidate budgets, relevance thresholds, and decision message
thresholds remain compatibility inputs and no longer tune retrieval. The v3 rejection rules above
still apply to removed legacy spellings.

Both `minTextUnits` and `followUpMinTextUnits` default to 10. Explicit old values such as 80/110
remain active; remove or lower them to admit short questions. `expansionMinConfidence` defaults
to 0.65; explicit overrides remain active. Gate diagnostics use
`conversation.thread.auto_inject.gate` and correlate by request ID.

`embedding.queryModel` defaults to `embedding.model`. Both encoders must share a vector space and
dimensions. Changing the document encoder requires re-embedding existing summary facets.

## Upgrade from v1 to v2

V2 uses the runtime field names. Apply these conversions before advancing to v3:

- `tools.experimental_hashline_edit` becomes `tools.editFile.hashline`.
- `surface.discord.previewFinalOutputStyle` becomes `surface.discord.outputPreviewModeFinalStyle`.
- `surface.discord.experimental.markdownTableRender` becomes `surface.discord.markdownTableRender`.
- Replace `surface.heartbeat.every` with a five-field `surface.heartbeat.cron`; both parsers reject `every`.
- Remove `agent.subagents.idleTimeoutMs`, `defaultTimeoutMs`, and `maxTimeoutMs`. Child inactivity
  timeouts derive from `agent.idleTimeoutMs` as two thirds, with a 1,000 ms minimum.
- Replace profile `execution: true` with `execution: native`; `false` remains valid.
- Model aliases cannot contain `/`; alias targets must use `provider/model`.

Review changed defaults: v2 selects the `fff` filesystem backend and hashline editing, enables
transient retries, uses detailed reasoning display, and uses Discord preview output with flat
plain-text final replies, notifications, and Unicode table rendering. Explicit overrides retain
precedence. Built-in profiles use native Bash on trusted surfaces; frozen v1 profiles retain their
historical authority. V2 adds configurable retention, blob storage, model fallback, and conversation
memory; consult schema hover for the complete current field reference.

## Other deployment adjustments

- Native web defaults to port 8789. If moving an explicit port, update Compose, `publicUrl`,
  `allowedOrigins`, and any reverse proxy together. The installer preserves existing port mappings.
- `surface.workingIndicators` applies to native and Discord. An explicit
  `surface.discord.workingIndicators` overrides it for Discord only.
- Discord image tables require `markdownTableRender.style: image`, preview output, plain final
  style, and flat final text. Other modes and render failures use Unicode fallback. Remove `image`
  before downgrading to a parser that does not accept it.
- `tools.batch.maxCalls` is accepted for compatibility but ignored. Remove it from maintained
  configurations; models issue ordinary tool calls directly.
- Changing a blob backend requires an offline copy preserving object IDs and verification of
  durable references before switching. See the [blob cutover procedure](../MIGRATIONS.md#core-unified-blob-storage-clean-break).

Version-specific defaults belong to their parser. Optional fields do not require a config rewrite;
newer fields must be removed before using an older parser that rejects them.
