# Independent Review: Persistent Compaction Checkpoints

## Verdict

**CLEAR**

No BLOCKER findings were identified in the complete implementation diff against `origin/main`. The successful primary-run path persists the full final canonical transcript after a completed compaction, checkpoint lookup is performed on unmerged surface history, the newest reachable checkpoint establishes an inclusive atomic frontier for split outputs, malformed/unsupported metadata degrades to an ordinary transcript, and deletion of the final linked output removes only checkpoint transcripts.

## Findings

### RESIDUAL/NON-BLOCKING — Cancelled and failed post-compaction runs retain the stale-index edge case

**References:** `apps/core/src/surface/bridge/bus-agent-runner.ts:3851-3872`, `apps/core/src/surface/bridge/bus-agent-runner.ts:4022-4042`

The successful persistence path passes `didCompact: isCompactionCheckpoint` rather than tracking completed compaction independently from checkpoint eligibility. A cancelled run can have `completedCompactionCount > 0` while checkpoint metadata is intentionally suppressed; it therefore falls back to `finalMessages.slice(responseStartIndex)`, even though `replaceMessages()` may have shortened the canonical transcript and made that index stale. The failure path has the same pre-existing slice behavior after a completed compaction.

This can produce an incomplete or empty ordinary transcript for a cancelled/error surface response, causing later reconstruction to omit that turn when the linked transcript is expanded. It does not create an invalid checkpoint, leak a checkpoint onto a failed branch, or affect the normal successful compacted-request path. The agreed plan explicitly permits failed-run error transcript behavior to remain ordinary, so this is classified as residual rather than merge-blocking. A future cleanup should separate “canonical messages were replaced by compaction” from “this run is eligible to become a checkpoint,” then define cancelled/error persistence semantics explicitly.

### RESIDUAL/NON-BLOCKING — Tool-triggered deletion relies on the Discord gateway deletion event

**References:** `apps/core/src/surface/bridge/publish-to-bus.ts:141-160`, `apps/core/src/tool-server/tools/surface.ts:2525`

Checkpoint unlinking is correctly wired to `adapter.message.deleted`, transactionally idempotent in the store, and covered by a bridge test. The `surface.messages.delete` tool itself does not directly call `unlinkSurfaceMessage`; it relies on Discord emitting `messageDelete` after `msg.delete()` succeeds. That is the normal Discord path and should converge, but a missed/disconnected gateway event can leave a stale mapping and checkpoint row until ordinary retention. Direct unlinking after successful tool deletion would make the overlap/idempotency rationale in the plan fully explicit.

This is non-blocking because the authoritative adapter deletion lifecycle is wired correctly and duplicate direct/event calls are already safe.

### RESIDUAL/NON-BLOCKING — End-to-end and cleanup-timing coverage remains thinner than the plan's test matrix

**References:** `apps/core/tests/surface/bridge/checkpoint-selection.test.ts:44-110`, `apps/core/tests/surface/bridge/request-composition.test.ts:2581-2653`, `apps/core/tests/transcript/transcript-store.test.ts:543-574`, `apps/core/tests/surface/bridge/bus-agent-runner.test.ts:51-108`

The focused unit coverage exercises selection, split-output frontiers, branch-before/after behavior, age override, migration, malformed version metadata, unlinking, and the runner's persistence helpers. It does not execute the planned full integration sequence of a real runner compaction, persistence, surface linking, next-request reconstruction, and pre-checkpoint fork. The 24-hour stale-candidate pruning path inside `pruneRetention()` is also not time-driven in tests; tests cover only the explicit immediate candidate deletion API. Runner tests verify pure helper decisions rather than a failed/skipped/full runner lifecycle.

This is a test-confidence limitation, not evidence of incorrect behavior. The implementation paths were inspected directly and the focused suites pass apart from one unrelated ordering-flaky test described below.

### RESIDUAL/NON-BLOCKING — Metadata schema accepts and strips unknown extra keys

**Reference:** `apps/core/src/transcript/transcript-store.ts:12-15`

The Zod object validates the required discriminant/version and safely rejects malformed JSON and unsupported versions. Because the object is not `.strict()`, extra fields are accepted and stripped rather than degrading the metadata to ordinary. This is safe for model isolation and forward compatibility, but is slightly looser than a literal reading of “invalid or unknown metadata degrades to ordinary.” No model-facing metadata exposure results.

## Plan Conformance

The implementation materially conforms to the agreed plan:

- `context_meta_json` is added through an idempotent SQLite migration, with unsupported or malformed values read as ordinary transcripts.
- Successful compacted primary runs persist `runStats.finalMessages ?? agent.state.messages` in full and attach format version 1 metadata.
- Non-compacted primary runs preserve response-only persistence; non-primary behavior remains full-transcript persistence.
- Failed, skipped, non-primary, and cancelled runs do not become checkpoints.
- Selection occurs before Discord message merging and searches newest-to-oldest across bot-authored mapped outputs.
- Split outputs are deduplicated by request ID and the final occurrence of the owning request defines the inclusive frontier.
- Explicit reply/mention, anchored mention, and recent-channel composition paths all use the shared selector.
- Selected checkpoints bypass ordinary transcript-age fallback; descendant messages continue through existing merge, reaction, attribution, attachment, and transcript-expansion behavior.
- Mapping unlink and orphan-checkpoint deletion occur in one SQLite transaction and repeated deletion is safe.
- Skip/empty-delivery cleanup removes an unlinked candidate, while retention provides conservative stale-candidate cleanup.
- Persistence, application, and deletion logs contain identifiers/counts but no transcript content.

## Verification Performed

Reviewed the complete tracked diff against `origin/main` plus the untracked checkpoint selector, selector tests, and implementation plan files. Inspected all production call sites for request composition, transcript linking, adapter deletion, and surface-tool deletion.

Commands run:

```text
git diff --check origin/main
PASS

cd apps/core && bunx tsc -p tsconfig.json --noEmit
PASS

cd packages/agent && bunx tsc -p tsconfig.json --noEmit
PASS

bun run lint
PASS (0 warnings, 0 errors)

bun run fmt:check
PASS

cd packages/agent && bun test tests/auto-compaction.test.ts
PASS (19 tests)

cd apps/core && bun test \
  tests/transcript/transcript-store.test.ts \
  tests/surface/bridge/checkpoint-selection.test.ts \
  tests/surface/bridge/request-composition.test.ts \
  tests/surface/bridge/publish-to-bus.test.ts \
  tests/surface/bridge/bus-agent-runner.test.ts
177 passed, 1 failed
```

The single failure was unrelated to this implementation: `anthropic fallback URL downloads > forces downloads for http urls when fallback order includes vertex or bedrock` asserted invocation order for two concurrently downloaded URLs and observed the reverse order. Re-running that test alone passed:

```text
cd apps/core && bun test tests/surface/bridge/bus-agent-runner.test.ts \
  --test-name-pattern "forces downloads for http urls"
PASS (1 test)
```

## Final Assessment

**CLEAR.** No finding warrants blocking merge. The remaining items are bounded residual risks or coverage limitations and do not undermine the checkpoint lifecycle, branch/fork semantics, migration safety, malformed-version handling, or successful reconstruction behavior delivered by this branch.