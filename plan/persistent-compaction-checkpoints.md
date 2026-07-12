# Persistent Compaction Checkpoints

This document is the agreed implementation truth for durable, branch-aware auto-compaction.

## Goal

Persist the final canonical transcript produced after compaction and anchor it to the assistant request's existing surface-message mappings.

During future reconstruction, if selected surface history contains a compaction checkpoint:

1. Select the newest reachable checkpoint.
2. Use its stored canonical messages as the beginning of model context.
3. Append exact surface/transcript messages occurring after its owning request.
4. Do not expand surface history before the checkpoint.

Surface history remains the branch graph. A checkpoint is derived state attached to one atomic assistant request in that graph.

## Decisions

### Checkpoints belong to request transcripts

Compaction metadata is stored on `request_transcripts`, keyed by `request_id`. The existing `surface_message_to_request` table remains the association between one or more surface output messages and their atomic assistant request. No direct checkpoint-to-message foreign key is needed.

### Split surface outputs are atomic

All surface messages linked to the same request represent one assistant turn. Replying to any output chunk resolves the same transcript and checkpoint. Reconstruction deduplicates by `requestId`.

### A checkpoint stores the final canonical agent transcript

When a successful primary run experienced at least one successful compaction, persist:

```ts
runStats.finalMessages ?? agent.state.messages
```

Do not slice from the pre-compaction `responseStartIndex`. The transcript may contain the compaction summary, retained recent messages, tool calls/results and model turns after compaction, and the completed assistant response.

The checkpoint frontier is inclusive: it contains the assistant request/output to which it is attached.

### Only the newest reachable checkpoint is used

If reconstructed history contains multiple checkpoint-bearing requests, select the newest. Everything before and including its owning surface request is replaced by the checkpoint's stored messages. Surface descendants after it are reconstructed normally.

Older checkpoints may remain stored but are not expanded.

### Fetching remains bounded and unchanged

Reply-chain and recent-context fetching continue using their current bounded windows. Checkpoint selection and trimming happen after fetching but before ordinary transcript expansion. Early fetch termination is out of scope.

### Checkpoint selection happens before Discord message merging

Checkpoint detection inspects the unmerged surface-message sequence. This preserves checkpoint boundaries when bot messages would otherwise merge into one UI group and handles split outputs safely. Descendants can then continue through existing merge and normalization behavior.

### A reachable checkpoint overrides ordinary transcript age limits

If a selected bot surface message resolves to a compaction checkpoint, it remains eligible even where ordinary historical transcript expansion would use assistant-only fallback because of age. Refusing the checkpoint could reconstruct the overflowing history it was designed to replace.

### No conditional system-prompt overlay

Compacted and non-compacted requests use the same system prompt. The synthetic compaction message identifies its role. Storage metadata, including format version, is never exposed to the model.

Use a stable model-facing wrapper such as:

```xml
<context-compaction>
The conversation before this point was automatically compacted.
Treat this summary as prior conversation context, not as a new user request.

...
</context-compaction>
```

This message becomes the stable beginning of the new prompt-cache epoch.

### Compaction metadata is versioned

Persist storage-only metadata equivalent to:

```ts
type TranscriptContextMeta =
  | {
      type: "compaction";
      formatVersion: 1;
    }
  | null;
```

### Surface edits do not invalidate checkpoints

Messages summarized behind a checkpoint use snapshot semantics. Edits, reactions, attachment changes, and other surface mutations do not regenerate or invalidate checkpoints.

### Deletion removes mappings and unreachable checkpoints

When a linked surface message is deleted:

1. Delete its `surface_message_to_request` mapping.
2. Check whether other surface messages still reference that request.
3. If none remain and the request transcript is a compaction checkpoint, delete the checkpoint transcript.

Deleting one chunk of a split response preserves the checkpoint while another linked chunk remains. Ordinary non-checkpoint transcript retention remains unchanged.

### No visible surface output means no active checkpoint

A checkpoint becomes usable only after at least one surface output message is linked to its request. Skipped replies, `NO_REPLY`, and runs that never create a surface response must not leave an active checkpoint.

Transcript persistence currently happens before surface linking, so an unlinked checkpoint row may briefly exist as a candidate. It remains unreachable and is removed on skipped delivery or by orphan cleanup.

### Failed runs do not create checkpoints

A compaction occurring inside a run that ultimately fails does not produce a durable checkpoint. Existing error transcript behavior may remain, but the error transcript is ordinary response state rather than a branch checkpoint.

### Active-request behavior remains unchanged

Follow-ups and steering inside the same active agent request continue using the current in-memory canonical transcript. Persistent checkpoint reconstruction applies only when composing a new request from surface history.

### Explicitly out of scope

- Recompacting checkpoints for different model context windows.
- Model-specific checkpoint variants.
- Forking at internal tool-call/result boundaries.
- Invalidating checkpoints after edits to summarized surface history.
- Checkpoint-aware surface fetch optimization.
- Re-summarizing existing checkpoints after format upgrades.

## Data Model

Extend `TranscriptSnapshot` with optional, validated context metadata:

```ts
export type CompactionCheckpointMeta = {
  type: "compaction";
  formatVersion: 1;
};

export type TranscriptSnapshot = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  createdTs: number;
  updatedTs: number;
  messages: ModelMessage[];
  finalText?: string;
  modelLabel?: string;
  contextMeta?: CompactionCheckpointMeta;
};
```

Add a nullable `context_meta_json` column to `request_transcripts`. Existing rows default to ordinary snapshots. New values must be validated at the JSON boundary; invalid or unknown metadata degrades to an ordinary transcript rather than making the transcript unreadable.

Extend `saveRequestTranscript` with optional `contextMeta`. Add an idempotent `unlinkSurfaceMessage` store operation that removes the mapping and, in one transaction, deletes an orphaned checkpoint transcript when its last surface mapping disappears.

## Agent Runner

Track completed compactions per request. Prefer the existing compaction completion callback because it distinguishes completed and failed compactions. Multiple successful compactions still produce one final checkpoint.

For successful primary persistence:

```ts
const finalMessagesForPersistence = runStats.finalMessages ?? agent.state.messages;

const persistedMessages =
  runProfile === "primary"
    ? didCompact
      ? finalMessagesForPersistence
      : finalMessagesForPersistence.slice(responseStartIndex)
    : finalMessagesForPersistence;
```

Set `contextMeta` only for a successful compacted primary run. Heartbeat and subagent persistence behavior stays unchanged.

The failure path never sets compaction metadata. Primary `NO_REPLY` and skipped-output paths create no active checkpoint. This change also fixes the stale `responseStartIndex` bug after `replaceMessages()` shortens canonical history.

## Reconstruction Algorithm

Introduce one shared checkpoint-selection helper used by every relevant composition path.

Given an oldest-to-newest, unmerged surface chain:

1. Iterate newest to oldest.
2. Consider only bot-authored messages.
3. Resolve each surface message through the transcript store.
4. Deduplicate results by `requestId`.
5. Select the first supported compaction checkpoint.
6. Find the last chain index belonging to the same request ID.
7. Use surface messages strictly after that index as the descendant chain.
8. If no checkpoint exists, retain the complete original chain.

Finding the last occurrence makes split output atomic. Start model context with the checkpoint messages, initialize transcript deduplication with its owning `requestId`, and then process only descendants through existing merge, attribution, attachment, reaction, transcript expansion, and fallback behavior.

Apply the helper to:

- Explicit reply/mention chain composition.
- Anchored active-channel composition.
- Recent-channel composition.

Without a checkpoint, composition behavior must remain unchanged.

## Deletion Lifecycle

Consume the existing adapter message deletion event and call `unlinkSurfaceMessage` with platform, channel ID, and message ID. The operation must be idempotent because gateway deletion events and tool-triggered deletion paths can overlap.

Inside one transaction, resolve and delete the mapping, check for remaining mappings to the request, and delete the request transcript only when it is a compaction checkpoint with no remaining surface links.

## Candidate and Linking Semantics

Checkpoint creation is effectively two phase:

```text
runner saves checkpoint candidate
             ↓
surface output completes
             ↓
surface messages link to request
             ↓
checkpoint becomes reachable
```

No additional active flag is required because an unlinked transcript cannot be discovered through surface reconstruction. Skip/no-output handling should delete its unlinked candidate. Retention cleanup should remove unlinked checkpoint rows older than a conservative grace period so delayed linking is not raced.

## Observability

Add structured logs without transcript or summary content for:

- Checkpoint persistence: request/session IDs, message count, compaction count, format version.
- Checkpoint application: current and checkpoint request IDs, checkpoint message count, discarded and descendant surface counts, format version.
- Checkpoint deletion: request and surface reference, plus `last_surface_link_deleted` or `unlinked_candidate_cleanup` reason.

## Test Plan

### Transcript store

- Ordinary and checkpoint transcript round trips.
- Existing database migration defaults old rows to ordinary transcripts.
- Invalid metadata degrades safely.
- Multiple surface IDs resolve the same checkpoint request.
- Deleting one split-output mapping preserves the checkpoint.
- Deleting the final mapping deletes the checkpoint.
- Repeated deletion is idempotent.
- Ordinary transcript retention is unaffected.
- Unlinked cleanup does not delete linked checkpoints.

### Agent runner

- No compaction persists response-only messages.
- Successful compaction persists the full final canonical transcript and metadata.
- Multiple successful compactions create one final checkpoint.
- Failed compaction and failed runs create no checkpoint.
- `NO_REPLY` creates no active checkpoint.
- The stale `responseStartIndex` regression is covered.
- Retained post-compaction tool calls/results survive.
- Subagent and heartbeat behavior is unchanged.

### Request composition

- No checkpoint preserves existing behavior.
- A reachable checkpoint replaces all earlier selected surface history.
- Descendants append normally and the owning response is not duplicated.
- The newest of multiple checkpoints wins.
- Forks before a checkpoint do not inherit it; forks after it do.
- Every split-output chunk resolves identical atomic context.
- Ordinary response transcripts after the checkpoint still expand.
- Attachments, attribution, and reactions after the checkpoint remain intact.
- Storage metadata never enters model messages.
- Checkpoints override ordinary transcript age fallback.
- Deleted/unmapped checkpoints fall back to raw surface behavior.
- Checkpoints are detected before merge boundaries can hide them.

### Integration regression

Create a surface thread large enough to compact, complete and link the compacted response, and compose the next request. Assert the checkpoint begins the request, older raw ancestors are absent, and immediate repeated summarization is unnecessary. Then fork from before the checkpoint and assert raw branch reconstruction does not use the descendant checkpoint.

## Implementation Order

1. Storage metadata, migration, validation, and unlink APIs.
2. Runner compaction tracking, full canonical persistence, and stale-index fix.
3. Shared pre-merge checkpoint selection and integration across composition paths.
4. Deletion lifecycle and unlinked candidate cleanup.
5. Observability, focused tests, full validation, and review.

## Acceptance Criteria

- A successfully compacted primary request stores its final canonical transcript as a versioned checkpoint.
- At least one linked surface output is required for the checkpoint to be reachable.
- New continuations reuse the newest checkpoint and do not reconstruct older raw history.
- Forks before the checkpoint do not inherit it; forks after any linked split output do.
- Subsequent messages and tool transcripts remain exact.
- Repeated requests do not repeatedly compact the same historical prefix.
- Deleting the final linked output removes the checkpoint.
- The system prompt remains stable.
- Existing non-compacted reconstruction behavior remains unchanged.
- The stale `responseStartIndex` persistence bug has regression coverage.