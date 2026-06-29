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

New v2 fields:

- `tools.inspect.model`: configurable Gemini model for `content.inspect`; must start with `google/`.
- `models.capability.overrides.<provider/model>.attachment`: optional manual override for model attachment input support.
- `conversation.thread.summarization.enabled`: default-false gate for background conversation thread summarization.
- `conversation.thread.summarization.model`: model used for conversation thread summaries; defaults to `fast`.
- `conversation.thread.summarization.concurrency`: number of threads to summarize concurrently inside one run; defaults to `1`.
- `conversation.thread.summarization.includePromptContext`: default-false option to include `MEMORY.md`, `USER.md`, and optional `ENTITIES.md` as background-only summarization context.
- `conversation.thread.embedding.enabled` and `conversation.thread.embedding.model`: default-false semantic thread embedding generation using an AI SDK embedding model ref.
- `conversation.thread.autoInject.plannerModel`: optional model used for request-time auto-inject query planning; when unset, it inherits `conversation.thread.summarization.model`.

Default changes from v1:

- `tools.fsBackend: fff`
- `tools.editFile.hashline: true`
- `tools.inspect.model: google/gemini-3.5-flash` (`configVersion: 1` always uses `google/gemini-3-flash`)
- `surface.discord.outputMode: preview`
- `surface.discord.outputPreviewModeFinalStyle: plain`
- `surface.discord.outputNotification: true`
- `surface.discord.markdownTableRender: { enabled: true, style: unicode, maxWidth: 50, fallbackMode: list }`
- `agent.reasoningDisplay: detailed`
- `agent.subagents.defaultTimeoutMs: 600000`
- `agent.subagents.maxTimeoutMs: 1200000`
