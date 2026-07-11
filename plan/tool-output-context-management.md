# Tool Output Context Management

## Status

Agreed implementation plan.

This document defines how Lilac will bound direct tool output, preserve oversized output for later inspection, and rely on compaction rather than default historical tool-result pruning.

The accompanying implementation checklist is in `plan/tool-output-context-management-todo.md`.

## Motivation

Lilac currently combines tool-specific output limits, model-view binary scrubbing, historical tool-result pruning, and automatic compaction. The historical pruning policy rewrites older model-visible results before compaction can summarize them. It also changes an established prompt prefix, which can reduce provider prompt-cache reuse.

The desired model is:

1. Bound potentially large direct tool results when they are created.
2. Preserve oversized, non-reproducible text as a transient artifact when useful.
3. Keep ordinary conversation history stable.
4. Let hierarchical compaction replace the context window when it becomes full.
5. Keep historical tool-result pruning available only as a default-off compatibility option.

This follows the useful part of Codex's approach: context items are bounded at ingress, ordinary history is not age-pruned, and compaction establishes an intentional new context epoch.

## Goals

- Cap governed text and JSON output at a raw preview limit of `40KiB`.
- Preserve complete oversized Bash, plugin, subagent, and custom-command output as transient artifacts.
- Reuse `read_file` to inspect `tool-result://<id>` resources.
- Keep `read_file`, search, and media behavior tool-specific rather than forcing every result through one generic artifact abstraction.
- Limit batch calls to eight and keep batch eligibility explicit.
- Raise inline media limits enough for explicitly requested images to reach providers that resize them.
- Make historical tool-result pruning default off under `tools.*` configuration.
- Preserve the existing hierarchical compaction strategy and remove reliance on emergency tool-output omission.
- Add measurements for truncation, artifact use, compaction, provider overflow, and prompt-cache behavior.

## Non-Goals

- A general durable artifact platform.
- Cross-host or clustered artifact replication.
- OCR or textual fallback for oversized images.
- Artifact storage for bounded search results.
- A new first-level `read_tool_output` tool.
- A recursive semantic truncator for arbitrary JSON structures.
- A hard per-artifact storage ceiling for runaway custom plugins. Plugin authors and users remain responsible for pathological plugin output.
- Applying the generic artifact policy to second-level tools. Their output reaches the model through a first-level tool and is governed there.

## Scope

### Governed Direct Outputs

The `40KiB` raw preview policy applies to these model-facing outputs:

- `bash`
- Level-1 plugin tools
- synchronous subagent final output
- deferred subagent final output
- custom-command tool-result output

The policy applies to text and JSON after conversion to the representation intended for the model. Media and provider references are handled separately.

### Tool-Specific Outputs

These retain specialized behavior:

- `read_file`: return a bounded source-backed window and continuation metadata; do not create a duplicate artifact.
- `glob`, `grep`, and `fuzzy_search`: retain count limits and add a serialized-size backstop without artifacts.
- `batch`: rely on bounded eligible children and a maximum of eight calls.
- image and other media results: retain inline media within configured limits; do not turn media into textual artifacts.
- editing tools: retain their existing bounded semantic responses.

## Configuration

The settings belong under `tools.*` rather than adding more top-level fields.

Proposed universal shape:

```yaml
tools:
  output:
    maxPreviewBytes: 40KiB
    artifactTtl: 7d
    artifactMaxBytesPerSession: 50MiB

  historicalResultPruning:
    enabled: false
    protectTokens: 40000
    minimumTokens: 20000

  batch:
    maxCalls: 8

  media:
    maxInlineBytesPerPart: 10MiB
    maxInlineBytesTotal: 20MiB
```

The exact serialized names should follow the active v2 config naming convention. The semantic grouping and defaults above are authoritative.

### Friendly Units

Byte-size and duration fields accept friendly string values.

Byte-size examples:

- `40KiB`
- `5MB`
- `50MiB`

Supported byte units should distinguish decimal and binary units:

- decimal: `B`, `KB`, `MB`, `GB`
- binary: `KiB`, `MiB`, `GiB`

Duration examples:

- `1m`
- `6d`
- `3mo`

Supported duration units should include at least:

- `ms`, `s`, `m`, `h`, `d`, `w`, `mo`

`m` means minute. `mo` means a fixed 30-day month so parsing is deterministic.

Parsers must reject negative, non-finite, ambiguous, or unsupported values. Universal configuration stores normalized byte and millisecond counts.

The v1 input schema is frozen. Add v2 fields and provide v1-to-universal defaults without modifying the v1 input shape. Update the config template and `MIGRATIONS.md` where v1 and v2 behavior differs.

## Transient Artifacts

### Storage

Store artifacts in a managed directory under the configured Lilac data directory, scoped by session. A representative layout is:

```text
<dataDir>/tool-results/<session-id>/<artifact-id>
```

Requirements:

- use opaque, unguessable IDs;
- write files with mode `0600`;
- associate each artifact with its owning session, request, and tool call;
- sanitize model-facing text before persistence;
- resolve artifacts independently of local or SSH `cwd`;
- keep storage local to the current Lilac deployment for this version;
- clean expired artifacts lazily on reads and writes and during runtime startup.

An artifact reference uses:

```text
tool-result://<id>
```

The URI hides the underlying path. Transcripts may persist the URI, but availability remains transient.

### Lifetime

Artifacts expire seven days after creation. Reads do not extend the expiration time.

An expired, evicted, or otherwise vanished artifact returns a clear model-facing error:

```text
This transient tool result is no longer available because it expired or was evicted. Re-run the original tool call if the output is still needed.
```

Do not expose whether a foreign-session artifact exists. Unauthorized and nonexistent IDs should have equivalent external behavior.

### Session Quota

The default stored artifact quota is `50MiB` per session, measured in stored UTF-8 bytes.

Normal enforcement:

1. Remove expired artifacts.
2. Evict the oldest-created artifacts until the incoming artifact fits.
3. Write the incoming artifact.

Oversized single-result exception:

- If one incoming artifact is larger than `50MiB`, delete every other artifact for that session and retain the oversized artifact as the sole artifact.
- There is no separate hard per-artifact limit in this version.
- A later artifact resumes ordinary quota enforcement and may evict the oversized artifact.

If artifact persistence fails, the original tool call still succeeds or fails according to its actual execution result. Return the bounded preview and state that the complete output could not be retained.

### Artifact Content

Persist the complete sanitized model-facing text, not an arbitrary raw runtime object.

- Bash artifacts preserve explicit stdout and stderr sections.
- JSON plugin/custom output is pretty-serialized before storage.
- Subagent artifacts contain the final child response text.
- Text parts from model-output content may be stored; media and provider references are not serialized into the text artifact.
- Existing secret and control-character sanitization must run before artifact persistence.

## Reading Artifacts

Extend `read_file` to recognize `tool-result://` before normal local or remote path resolution.

Artifact and ordinary text reads accept a discriminated start position. Absolute offsets count Unicode characters, including newlines, rather than bytes; line positions use one-based lines and zero-based Unicode columns:

```ts
read_file({
  path: "tool-result://01J...",
  start: { type: "offset", offset: 0 },
  maxCharacters: 10_000,
});
```

The result reports:

- `startOffset`
- `endOffset`
- `totalCharacters`
- a `nextStart` matching the requested offset or line mode when more content remains
- `hasMore`
- the bounded content window

Character offsets avoid exposing UTF-8 boundary concerns to the model. Implementations may scan from the beginning for this transient-file use case; these files are bounded by the session quota in normal operation. Offset-mode pages are source-exact, while line-mode pages remain line-oriented.

Normal filesystem reads remain line-oriented and source-backed. They do not create artifacts. Preserve the existing head/window behavior, but make truncation and the next usable continuation position explicit. Avoid reporting an `endLine` that causes the model to skip an unseen remainder of a very long line.

## Preview Rules

`40KiB` is the raw retained preview limit. It does not include the surrounding result envelope, truncation metadata, or short instructions.

For generic text:

- retain approximately half from the beginning and half from the end;
- insert an omission marker containing the omitted character count;
- include the artifact URI and `read_file` retrieval instruction.

For generic JSON:

- convert the normalized model-facing result to pretty JSON;
- store the complete serialization;
- return a textual head/tail preview rather than recursively deleting unknown fields;
- keep small JSON results unchanged.

Truncation is not an execution error. Tool success and failure remain based on execution status, while truncation is separate metadata.

## Bash

Keep the current streaming capture, sanitization, overflow assembly, and full-output preservation flow, with these changes:

- use `40KiB` as the configurable raw preview limit;
- replace prefix-only clipping with head/tail clipping;
- preserve stdout and stderr as separate sections;
- guarantee preview space to each non-empty stream and reallocate unused space;
- persist the complete sanitized result as a managed artifact;
- return `tool-result://<id>` instead of an absolute `/tmp` path;
- ensure SSH output is sanitized before artifact persistence;
- report truncation through metadata, not `executionError.type = "truncated"`;
- retain timeout, abort, spawn, and stream failures as actual execution errors.

The model-facing result should identify the original size, show the bounded preview, and explain how to inspect the artifact with `read_file`.

## Read File

For ordinary text files:

- keep source-backed reading;
- keep a bounded head/window rather than creating an artifact;
- return an explicit truncation marker or metadata;
- return a continuation position that cannot skip omitted text;
- retain line-oriented paging for normal use.

For `tool-result://` resources:

- use character-offset paging;
- enforce session ownership;
- ignore `cwd` and SSH path semantics;
- return the agreed vanished-artifact error when unavailable.

For explicitly requested images and PDFs, do not apply text artifact behavior.

## Plugin Level-1 Tools

Plugin tools default to `supportsBatch: false`.

After a plugin's `toModelOutput` conversion, apply the generic direct-output policy:

- small text and JSON remain unchanged;
- oversized text or JSON is stored and replaced with a head/tail preview plus URI;
- textual content parts may be bounded while media/provider references remain intact;
- artifact write failure returns a preview with an availability warning;
- tool execution status is not changed by truncation.

Plugins that explicitly opt into batch execution are responsible for returning intrinsically bounded raw `execute` results because batch currently invokes child `execute` directly.

## Subagents

Apply the generic text policy to both forms of child completion:

- synchronous `subagent_delegate` final text;
- deferred synthetic subagent results.

Artifacts created while returning child output to a parent are owned by the parent session. Progress events and child tool-status displays are not included in the artifact; only the final child response is preserved.

Small subagent responses remain unchanged.

## Custom Commands

Custom commands can inject AI SDK tool-result envelopes without using normal Level-1 execution. Apply the same text/JSON normalization at canonical message ingress:

- keep small valid results unchanged;
- artifact oversized text and JSON;
- preserve media/provider references under the media policy;
- keep the operation's original success/error meaning.

The ingress normalizer must be idempotent so replayed or already-normalized results are not stored repeatedly.

## Search Tools

`glob`, `grep`, and `fuzzy_search` do not create artifacts.

Keep existing count limits and add a deterministic serialized-size backstop so a small number of pathological paths or matching lines cannot create an unbounded result.

When the backstop is reached:

- preserve complete result entries while possible;
- truncate an individually oversized matching line or path with an explicit marker;
- set existing or new truncation metadata;
- tell the model to narrow the query or inspect the source with `read_file`.

The default serialized-size backstop is the same `tools.output.maxPreviewBytes` value.

## Batch

Reduce the maximum batch size from 25 to eight.

Update the batch schema, validation, tests, and prompt/description. The positive prompt should continue to describe supported independent operations, for example:

```text
Supports independent read_file, glob, grep, and bash operations.
```

Do not add a long negative list to the prompt.

Batch does not receive a second aggregate artifact layer. It relies on:

- child tools with intrinsically bounded results;
- explicit `supportsBatch` eligibility;
- plugin tools defaulting to `supportsBatch: false`;
- the eight-call maximum.

## Media

Relax model-view inline binary limits:

- default per-part maximum: `10MiB`;
- default cumulative maximum per model request: `20MiB`.

Within these limits, explicitly requested images are sent to the provider unchanged and the provider may resize them.

When an image exceeds the applicable inline limit, replace it with a clear message that tells the model to resize the image before reading it again. Include the filename and media type when known. Do not perform OCR.

Non-image binary omission messages should say that the file exceeds the inline limit and must be reduced before reading.

Media limits use friendly size configuration under `tools.media`.

## Historical Tool-Result Pruning

Move the current OpenCode-style historical result-pruning policy behind `tools.historicalResultPruning.enabled`.

Defaults:

- `enabled: false`
- `protectTokens: 40000`
- `minimumTokens: 20000`
- preserve the existing `skill` exemption when enabled

When disabled:

- do not track compacted tool-call IDs;
- do not rewrite old results in the model-facing transform;
- let compaction see the bounded real outputs.

When enabled, preserve the current behavior and placeholder for compatibility. Add direct tests for thresholds, protected turns, protected tools, repeated transforms, and restart behavior.

## Compaction

Keep hierarchical compaction as the primary context-window mechanism.

The current implementation:

- splits selected history into estimated-token chunks;
- summarizes every chunk while carrying the previous summary forward;
- retries likely context overflows with smaller chunks;
- reduces the retained suffix over multiple passes.

After direct outputs are bounded:

- compaction must summarize bounded real tool output rather than historical-pruning placeholders;
- do not add remote-compaction-style preflight rewriting to ordinary inference;
- remove reliance on tool-output-specific emergency omission;
- continue splitting/reducing until the selected transcript has been processed;
- preserve call/result structural repair;
- retain a final budget assertion and surface a clear compaction failure rather than silently deleting a tool result if invariants are violated.

Tests must demonstrate compaction of a transcript containing maximum-size Bash, plugin, subagent, custom-command, search, and media-adjacent results without historical pruning.

## Observability

Add structured measurements without logging artifact content:

- tool result truncated count by tool name and output kind;
- original and preview byte/character estimates;
- artifact created, read, expired, evicted, and write-failed counts;
- stored artifact bytes by session;
- oversized-single-artifact events;
- compaction frequency and reason;
- compaction before/after token and message estimates;
- provider context-overflow count;
- provider cache-read and cache-write tokens where available;
- historical pruning invocation and estimated removed tokens when explicitly enabled.

These measurements support comparing the default-off pruning policy against the old behavior.

## Security And Failure Behavior

- Sanitize before writing artifacts.
- Do not include artifact contents in logs.
- Scope artifact lookup to the active session.
- Treat unauthorized, expired, evicted, and nonexistent URIs equivalently to callers.
- Use atomic writes where practical.
- Stream Bash spill sanitization and encryption so artifact size does not become core-process memory usage.
- A failed artifact write must not turn a successful tool execution into a failure.
- A missing transient artifact must provide a rerun instruction.
- Preserve current secret-redaction tests and add SSH spill coverage.
- Do not promise artifact availability after seven days, data-directory loss, or deployment migration.
- Artifact encryption keys are runtime-only so same-user shell tools cannot bypass session ownership by reading storage files directly. A core restart removes artifacts from the previous process; retained previews and rerunning the original tool remain the recovery path.

## Validation

Implementation is complete when:

- governed direct outputs never expose more than the configured raw preview limit;
- Bash previews include useful beginning and ending context and no longer classify truncation as execution failure;
- artifact paging can recover large single-line output using character offsets;
- seven-day expiry and 50 MiB session quota behavior are deterministic;
- an artifact larger than the quota becomes the sole session artifact;
- a later artifact can evict that oversized artifact under normal quota enforcement;
- batch accepts at most eight calls and its prompt reflects supported independent operations;
- plugin tools default to non-batchable;
- subagent and custom-command bypasses are covered;
- search output has a non-artifact size backstop;
- images up to configured limits reach the model-facing request;
- oversized image messages tell the model to resize before reading;
- historical result pruning is default off but remains functional when enabled;
- compaction succeeds over maximum-size bounded results without emergency tool-output omission;
- config templates, migration notes, typechecks, tests, lint, and formatting pass.
