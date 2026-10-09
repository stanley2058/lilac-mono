# Core Config Migrations

## Separate thread query embeddings

`conversation.thread.embedding.queryModel` optionally selects the search-query encoder.
It defaults to `embedding.model`, which remains the document encoder and stored embedding ID.
Both encoders must share a vector space and dimensions. Changing the document model requires
re-embedding existing summary facets. No schema-version or database change is required.

This guide records manual `core-config.yaml` changes between config versions. The current field-level
reference is
[`packages/utils/config-templates/core-config.example.yaml`](../packages/utils/config-templates/core-config.example.yaml).

Lilac parses `core-config.yaml` through a versioned parser into one universal runtime config shape. The
application consumes only the universal shape.

## Versioning Rules

- New generated configs include `configVersion`.
- Existing configs without `configVersion` are treated as `configVersion: 1`.
- Lilac does not auto-upgrade config files at startup.
- Versioned parsers own defaults for their version.
- New behavior-changing defaults apply only to configs on the version that introduced them.
- If a newer field cannot be represented safely in an older version, that field requires the newer
  `configVersion`.

## Native web port

The native web listener now defaults to `8789`, reserving `8787` for the GitHub webhook and `8788`
for the container-local operator console. Version-2 defaults for `surface.native.publicUrl` and
`allowedOrigins` now use `http://localhost:8789`. Configs with native disabled stay disabled.

Explicit port, URL and origin values are preserved. To move an existing deployment, change
`surface.native.port` and the container side of its Compose port mapping together. If the browser's
public URL changes, also update `publicUrl`, `allowedOrigins` and any reverse-proxy destination.
The installer preserves existing deployment port mappings. No config-version bump is required.

## Decision auto-inject lane

Version 2 uses `conversation.thread.autoInjectMode: decision` and
`conversation.thread.decisionAutoInject`. Rename the old `jev` mode and `jevAutoInject` section.
Existing version-2 Jev settings still parse into the new runtime fields without changing thresholds.
If both sections exist, `decisionAutoInject` takes precedence. No config-version bump is required.

The decision lane uses a local shortlist and one call to judge whether past context helps and which
threads to inject. The `llm` lane remains the default. `autoInject.enabled` and
`filterCurrentParticipants` still apply to both lanes.

`decisionAutoInject.model` is an ordered, nonempty array. Configure
`[typesafe/jev-1.13.0, openai/gpt-6-luna]` to use Jev for text and Luna for image attachments.
Text selects the first entry. A supported image in the latest user message selects the first
image-capable entry; if none is configured, the first entry evaluates text only. PDFs alone do not
select Luna. This is routing, not a retry or failure fallback chain. Only the selected model needs
credentials. A single string and bare Jev model IDs remain supported as legacy input. TypeSafe uses `TYPESAFE_AI_API_KEY` and optional `TYPESAFE_AI_BASE_URL`; OpenAI uses
`OPENAI_API_KEY` and optional `OPENAI_BASE_URL`. The endpoint must support `/v1/decisions`.
Missing credentials and evaluation failures continue without injected metadata. A refused question
counts as "no" for that question. A zero recall threshold disables message gating.

OpenAI receives attached images as native inline image parts, independently of the primary agent's
image support. Jev evaluates text only. Shortlisting uses the latest authored text and up to three recent authored user messages; image-only
messages do not run automatic recall. Image preparation uses existing scoped resource access and inline
media limits. Images are kept in memory. No transcript or database migration is needed.

`decisionAutoInject` retains shared `limit`, `candidateLimit`, and `semanticFallback`. The four
probability thresholds now live under `decisionAutoInject.jev` and `decisionAutoInject.luna`.
TypeSafe Jev IDs use the `jev` scope; OpenAI Luna IDs use `luna`. Each scope has independent defaults.
Legacy flat thresholds apply to both scopes, and explicit scoped fields override them individually.
The default model list contains Jev only. Both recall thresholds default to zero, and relevance
thresholds default to 0.2 for Jev and 0.1 for Luna. The default candidate budget is 40. With
`semanticFallback: true`, lexical and semantic retrieval share that budget even when lexical matches
exist. Set it to false for lexical-only retrieval. Explicit configured values retain precedence.

## Native title model

Version 2 accepts `surface.native.titleModel`, defaulting to `fast`. Use `main`, `fast`, a configured
model alias, or an explicit `provider/model` reference. New native conversations keep their immediate
first-line fallback while this model generates a title without tools. An ambiguous initial title may
be refined once using the first user input and final assistant reply. Manual titles always win, and
model failures retain the current title. Existing conversations are not renamed.

The field is optional; no config rewrite is required. Remove it before using an older parser.

## Image table style

Table rendering now accepts `style: image`. The default remains `unicode`, so existing configurations
keep their text rendering. In v2, set `surface.discord.markdownTableRender.enabled: true` and
`surface.discord.markdownTableRender.style: image`, with `outputMode: preview`,
`outputPreviewModeFinalStyle: plain`, and `outputPreviewModeFinalText: flat`, to send top-level tables as
PNG attachments. The image style falls back to Unicode text in other modes and on rendering failure.

The v1 parser also accepts `image` under `surface.discord.experimental.markdownTableRender.style`, but
v1's reply-chain output uses the Unicode fallback. No config version bump or automatic rewrite is
required. Older builds reject `image`; change the style to `unicode` or `ascii` before downgrading.

## v1

`configVersion: 1` is the initial versioned config contract and matches the defaults used before config
versioning was introduced.

To make an existing implicit v1 config explicit, add:

```yaml
configVersion: 1
```

No field migrations are required for v1.

## v2

`configVersion: 2` uses the universal runtime config field names directly and changes several defaults.

Field renames from v1:

- `tools.experimental_hashline_edit` -> `tools.editFile.hashline`
- `surface.discord.previewFinalOutputStyle` -> `surface.discord.outputPreviewModeFinalStyle`
- `surface.discord.experimental.markdownTableRender` -> `surface.discord.markdownTableRender`

Removed v2 fields:

- `agent.subagents.idleTimeoutMs`; subagent idle timeouts are derived from `agent.idleTimeoutMs` as
  `floor(2/3)`, with a `1000ms` minimum.
- `agent.subagents.defaultTimeoutMs` and `agent.subagents.maxTimeoutMs`; frozen v1 configs may still
  contain these legacy fields, but they are ignored during universal parsing.
- `surface.heartbeat.every`; both current versioned parsers reject it with migration guidance. Replace
  it with a five-field `surface.heartbeat.cron` expression before restarting.

New v2 fields:

- `surface.discord.outputPreviewModeFinalText`: final plain-text grouping after a preview. `flat`
  replies with the first final-answer chunk and sends later chunks directly; `reply-chain` preserves
  the v1 commentary-plus-final reply chain. It applies only when `outputMode: preview` and
  `outputPreviewModeFinalStyle: plain`. The v2 default is `flat`; frozen v1 configs use `reply-chain`.
- `agent.transcriptRetention.maxAge` and `.maxRequests`: completed request transcript retention limits;
  defaults to `180d` and `10000`. Each accepts a positive duration/count or `"unlimited"`. Changes are
  hot-reloaded and apply on the next transcript save. Frozen v1 configs receive the same universal
  defaults but cannot override them.
- `surface.discord.attachmentCache.ttl`: Discord ingress attachment cache lifetime; defaults to `30d`
  and accepts a positive duration or `"unlimited"`. Changes are hot-reloaded. Frozen v1 configs receive
  the same universal default but cannot override it.
- `blobStorage`: one Core managed-blob adapter. Omit it for the local store rooted below `DATA_DIR`, or
  configure `kind: local` with a required absolute `root`, or `kind: s3` with required `bucket`,
  `prefix`, `endpoint`, `region`, and environment-variable names for credentials. S3 also accepts an
  optional session-token environment-variable name and optional path-style addressing. Frozen v1
  configs receive the same universal local default but cannot set this field.
- `workflows.maxActiveRuns`: principal-blind global admission cap across all nonterminal workflow runs,
  including scheduled and generated subagent runs; defaults to `64`. Frozen v1 configs receive the same
  universal fallback but cannot override it.
- `agent.idleTimeoutMs`: primary agent inactivity timeout; defaults to `900000` (15 minutes). Active runs
  have no total runtime cap. Frozen v1 configs receive the same universal fallback but cannot override it.
- `tools.inspect.model`: configurable Gemini model for `content.inspect`; must start with `google/`.
- `tools.web.firecrawl`: optional process-local concurrency policy applied independently to Firecrawl
  fetch and search calls. When present, `maxConcurrency` defaults to `2` and `queueTtl` defaults to `3s`;
  when absent, Firecrawl calls remain unlimited.
- `models.capability.overrides.<provider/model>.attachment`: optional manual override for model attachment
  input support.
- `conversation.thread.summarization.enabled`: default-false gate for background conversation thread
  summarization.
- `conversation.thread.summarization.model`: model used for conversation thread summaries; defaults to
  `fast`.
- `conversation.thread.summarization.concurrency`: number of threads to summarize concurrently inside one
  run; defaults to `1`.
- `conversation.thread.summarization.batchSize`: maximum threads processed by one periodic run; defaults
  to `32`. Manual runs remain unbounded unless they provide a limit. Frozen v1 configs receive the same
  universal fallback but cannot override it.
- `conversation.thread.summarization.includePromptContext`: default-false option to include `MEMORY.md`,
  `USER.md`, and optional `ENTITIES.md` as background-only summarization context.
- `conversation.thread.embedding.enabled` and `conversation.thread.embedding.model`: default-false
  semantic thread embedding generation using an AI SDK embedding model ref.
- `conversation.thread.autoInject.enabled`: default-false gate for request-time conversation thread
  metadata injection.
- `conversation.thread.autoInject.plannerModel`: optional model used for request-time auto-inject query
  planning; when unset, it inherits `conversation.thread.summarization.model`.
- `conversation.thread.autoInject.textPlannerModel`: optional model used instead of `plannerModel` when
  the composed request input contains only text. Image, PDF, and other non-text input continues to use
  `plannerModel`; when unset, all requests retain the existing planner selection.
- `conversation.thread.autoInject.minTextUnits`: minimum authored text mass before auto-injecting
  conversation thread metadata; defaults to `80`.
- `conversation.thread.autoInject.followUpMinTextUnits`: higher text-mass threshold after prior
  auto-injected thread metadata exists in the same conversation; defaults to `110`.
- `conversation.thread.autoInject.limit`: maximum injected search results; defaults to `3`.
- `conversation.thread.autoInject.minScore`: minimum final `conversation.thread.search` score for
  auto-injected metadata; defaults to `0.1`.
- `conversation.thread.autoInject.expansionMinConfidence`: minimum ranking confidence for optional
  auto-injected results after the single recall-floor result; accepts `0` through `1` and defaults to
  `0.57`. Frozen v1 configs receive the same universal default but cannot override it.
- `conversation.thread.autoInject.mode`: search mode (`hybrid`, `semantic`, or `lexical`); defaults to
  `hybrid`.
- `conversation.thread.autoInject.filterCurrentParticipants`: optionally restricts search to threads
  involving any current participant; defaults to `false`. If enabled when no current participant identity
  can be recovered, auto-injection is skipped.
- `tools.output`: direct-result preview and transient artifact policy. Defaults to `40KiB`, `7d`, and
  `50MiB` per session.
- `tools.historicalResultPruning`: compatibility policy for rewriting old tool results. It defaults to
  disabled with the prior `40000`/`20000` token thresholds retained when enabled.
- `tools.batch.maxCalls`: maximum calls accepted by one batch; defaults to `8`.
- Batch now expands children into ordinary Level 1 tool calls. Enabled tools are batchable by default;
  plugin authors can set `supportsBatch: false` to opt out.
- `tools.media`: model-view inline binary limits. Defaults to `10MiB` per part and `20MiB` in total.
- `agent.retry`: transient upstream and replay-safe primary idle-timeout retry policy. Frozen v1 configs
  cannot configure it; the version-specific defaults are listed below.
- `agent.subagents.delegatePromptOverlay`: optional free-form guidance appended to the parent-visible
  `subagent_delegate` tool description.
- `agent.subagents.profiles.<profile>.reasoning` and `.fallback`: optional portable reasoning and ordered
  model fallback policy. A profile fallback takes precedence over the selected model slot or alias
  fallback.
- `agent.subagents.profiles.<profile>.level1`, `.level2`, `.network`, `.workspaceWrites`, `.execution`, and
  `.delegation`: native profile authority and behavior fields. Frozen v1 profiles cannot configure these
  fields and receive their historical built-in universal profiles.
- `models.def.<alias>.reasoning` and `.fallback`, `models.main.reasoning` and `.fallback`, and
  `models.fast.reasoning` and `.fallback`: portable reasoning plus flat ordered fallback chains. Entries
  are a model/alias string or an object with `model` and optional `reasoning`/`options`; v1 cannot configure
  fallback or portable reasoning.
- `models.def.<alias>.comment`: optional guidance shown when an agent selects a model for a subagent.
- `models.def.<alias>.agentCanSelect`: explicitly opts an alias into dynamic selection through
  `subagent_delegate`; defaults to `false`. It does not restrict static profiles, model slots, or explicit
  human overrides.
- `surface.discord.markdownMathRender`: Discord markdown math rendering policy. Defaults to
  `{ enabled: false, maxWidth: 50, fallbackMode: source }`; frozen v1 configs receive this disabled
  universal fallback but cannot configure it.

Local example:

```yaml
configVersion: 2
blobStorage:
  kind: local
  root: /var/lib/lilac/blobs
```

S3-compatible example:

```yaml
configVersion: 2
blobStorage:
  kind: s3
  bucket: lilac
  prefix: production/blobs
  endpoint: https://s3.example.com
  region: us-east-1
  accessKeyIdEnv: LILAC_S3_ACCESS_KEY_ID
  secretAccessKeyEnv: LILAC_S3_SECRET_ACCESS_KEY
  # sessionTokenEnv: LILAC_S3_SESSION_TOKEN
  # forcePathStyle: true
```

The bucket must already exist. Core does not create it or manage its lifecycle policy. Credentials are
read only from the named environment variables. To move an existing Core data set between local and S3,
stop Core, copy the whole blob store while preserving object IDs, verify all durable references, and
switch config only after verification. The persisted-data cutover is documented in
[`MIGRATIONS.md`](../MIGRATIONS.md#core-unified-blob-storage-clean-break).

Changed v2 fields:

- `agent.subagents.profiles.<profile>.execution` is `false | "restricted" | "native"`. `false` omits Bash,
  `restricted` exposes the virtual restricted Bash implementation, and `native` exposes trusted host Bash
  unless the surface is restricted. This intentionally replaces the earlier v2 boolean contract: change
  `true` to `native`; `false` remains valid.
- For a normal profile/slot selection, fallback precedence is profile, model slot, then the alias selected
  by that slot; an explicitly present empty chain suppresses lower-precedence inheritance. An explicit
  alias request override uses that alias's chain, while an explicit `provider/model` override has no
  fallback chain.
- Automatic model fallback exhausts each candidate's retry budget before moving on, stays within the head
  model's provider family, and is disabled for a `claude-code` head. There is no global fallback enable
  flag or switch cap. v2 model aliases must not contain `/`, and each `models.def.<alias>.model` must use
  `provider/model` format.

Tool byte-size fields accept `B`, `KB`, `MB`, `GB`, `KiB`, `MiB`, and `GiB`. Duration fields accept `ms`,
`s`, `m`, `h`, `d`, `w`, and `mo`; `mo` is a fixed 30 days. These fields cannot be configured in the
frozen v1 input shape, but v1 receives the same universal runtime defaults.

Default changes from v1:

- `tools.fsBackend: fff`
- `tools.editFile.hashline: true`
- `tools.inspect.model: google/gemini-3.5-flash` (`configVersion: 1` always uses
  `google/gemini-3-flash`)
- `surface.discord.outputMode: preview`
- `surface.discord.outputPreviewModeFinalStyle: plain`
- `surface.discord.outputPreviewModeFinalText: flat`
- `surface.discord.outputNotification: true`
- `surface.discord.markdownTableRender: { enabled: true, style: unicode, maxWidth: 50, fallbackMode: list }`
- `agent.reasoningDisplay: detailed`
- `agent.retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 30000 }`; v1 universal
  parsing uses `{ enabled: false, maxRetries: 0, baseDelayMs: 2000, maxDelayMs: 30000 }`.
- Subagent idle timeouts derive from the primary agent timeout as `floor(2/3)`, with a `1000ms` minimum.
  This produces `600000` for the default `900000ms` primary timeout. Frozen v1 legacy timeout fields are
  ignored.
- The built-in `explore` profile includes restricted Bash; `general` and `self` use native Bash. Frozen v1
  profiles retain their historical no-Bash explore and native-Bash general/self behavior.

## Native deployment settings move to the database

Native startup imports `surface.native.titleModel`, `outputStreaming`,
`oldMessageSelectionMaxAgeMs`, `storageRetentionMaxAgeMs`, and `crossThreadSend` once into
the native database. After that, use Settings > Deployment. The old YAML keys are accepted
only as initial import values and may be removed after startup; they do not override database
settings. The import preserves the YAML file, including comments. See MIGRATIONS.md.
