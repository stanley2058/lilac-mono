# MIGRATIONS.md

This file documents config-version changes in a form that is readable by both humans and agents.

## Core Config

Lilac parses `core-config.yaml` through a versioned parser into one universal runtime config shape. The app only consumes the universal shape.

Rules:

- New generated configs include `configVersion`.
- Existing configs without `configVersion` are treated as `configVersion: 1`.
- Lilac does not auto-upgrade config files at startup.
- Versioned parsers own defaults for their version.
- New behavior-changing defaults only apply to configs on the version that introduced them.
- If a newer field cannot be represented safely in an older version, that field requires the newer `configVersion`.

## v1

`configVersion: 1` is the initial versioned config contract and matches the defaults used before config versioning was introduced.

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
- `agent.subagents.defaultTimeoutMs` -> `agent.subagents.idleTimeoutMs`; the timeout now measures inactivity rather than total runtime.

Removed v2 fields:

- `agent.subagents.maxTimeoutMs`; the universal runtime config no longer exposes a hard timeout cap. Frozen v1 configs may still contain this field, but it is not carried into the universal config.

New v2 fields:

- `tools.inspect.model`: configurable Gemini model for `content.inspect`; must start with `google/`.
- `models.capability.overrides.<provider/model>.attachment`: optional manual override for model attachment input support.
- `conversation.thread.summarization.enabled`: default-false gate for background conversation thread summarization.
- `conversation.thread.summarization.model`: model used for conversation thread summaries; defaults to `fast`.
- `conversation.thread.summarization.concurrency`: number of threads to summarize concurrently inside one run; defaults to `1`.
- `conversation.thread.summarization.includePromptContext`: default-false option to include `MEMORY.md`, `USER.md`, and optional `ENTITIES.md` as background-only summarization context.
- `conversation.thread.embedding.enabled` and `conversation.thread.embedding.model`: default-false semantic thread embedding generation using an AI SDK embedding model ref.
- `conversation.thread.autoInject.plannerModel`: optional model used for request-time auto-inject query planning; when unset, it inherits `conversation.thread.summarization.model`.
- `conversation.thread.autoInject.minTextUnits`: minimum authored text mass before auto-injecting conversation thread metadata; defaults to `80`.
- `conversation.thread.autoInject.followUpMinTextUnits`: higher text-mass threshold after prior auto-injected thread metadata exists in the same conversation; defaults to `110`.
- `conversation.thread.autoInject.minScore`: minimum final `conversation.thread.search` score for auto-injected metadata; defaults to `0.1`.
- `tools.output`: direct-result preview and transient artifact policy. Defaults to `40KiB`, `7d`, and `50MiB` per session.
- `tools.historicalResultPruning`: compatibility policy for rewriting old tool results. It defaults to disabled with the prior `40000`/`20000` token thresholds retained when enabled.
- `tools.batch.maxCalls`: maximum calls accepted by one batch; defaults to `8`.
- `tools.media`: model-view inline binary limits. Defaults to `10MiB` per part and `20MiB` in total.

Tool byte-size fields accept `B`, `KB`, `MB`, `GB`, `KiB`, `MiB`, and `GiB`. Duration fields accept `ms`, `s`, `m`, `h`, `d`, `w`, and `mo`; `mo` is a fixed 30 days. These fields cannot be configured in the frozen v1 input shape, but v1 receives the same universal runtime defaults.

Default changes from v1:

- `tools.fsBackend: fff`
- `tools.editFile.hashline: true`
- `tools.inspect.model: google/gemini-3.5-flash` (`configVersion: 1` always uses `google/gemini-3-flash`)
- `surface.discord.outputMode: preview`
- `surface.discord.outputPreviewModeFinalStyle: plain`
- `surface.discord.outputNotification: true`
- `surface.discord.markdownTableRender: { enabled: true, style: unicode, maxWidth: 50, fallbackMode: list }`
- `agent.reasoningDisplay: detailed`
- `agent.subagents.idleTimeoutMs: 360000`; explicit v1 `defaultTimeoutMs` values are preserved, while omitted values use the new universal default.
