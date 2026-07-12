# Persistent Compaction Checkpoints Implementation Todo

## Repository context

- [x] Map transcript storage schema, migrations, validation, retention, and surface mappings.
- [x] Map primary runner persistence, compaction callbacks, failure, and skipped-output lifecycle.
- [x] Map every surface-history composition path and pre-merge normalization behavior.
- [x] Map adapter deletion events and existing deletion-tool interactions.

## Implementation

- [x] Add versioned compaction context metadata to transcript snapshots and persistence schema.
- [x] Add transactional, idempotent surface unlinking with orphan checkpoint deletion.
- [x] Add conservative cleanup for stale unlinked checkpoint candidates.
- [x] Track successful compactions and persist full final canonical primary transcripts as checkpoints.
- [x] Ensure failed, non-primary, and skipped/no-output runs preserve agreed semantics.
- [x] Add shared newest-reachable checkpoint selection before surface-message merging.
- [x] Integrate checkpoint reconstruction into reply/mention, anchored, and recent composition paths.
- [x] Wire adapter deletion events to surface unlinking.
- [x] Add checkpoint persistence, application, and deletion observability without transcript content.

## Focused tests

- [x] Cover transcript metadata round trips, invalid metadata, split links, unlinking, and cleanup.
- [x] Cover runner persistence for compacted/non-compacted/failed/skipped/non-primary runs and stale indices.
- [x] Cover reconstruction selection, descendants, split outputs, branches, age behavior, and no-checkpoint regressions.
- [x] Cover deletion lifecycle integration.

## Validation

- [x] Run targeted tests while developing.
- [x] Run typecheck for every changed package after final edits.
- [x] Run relevant broader tests/build checks.
- [x] Run final `bun run lint:fix`.
- [x] Run final `bun run fmt`.
- [x] Inspect final diff and repository status.

## Deferred / non-blocking residual items

- Cancelled and failed post-compaction runs retain the pre-existing stale `responseStartIndex` edge case for ordinary error/cancellation transcript persistence.
- Tool-triggered deletion relies on the Discord gateway deletion event to unlink transcript mappings.
- Full runner-to-surface end-to-end lifecycle coverage and time-driven stale-candidate cleanup coverage remain future test hardening.
- Compaction metadata validation accepts and strips unknown extra keys rather than treating them as invalid.

See `persistent-compaction-checkpoints-review.md` for the review rationale and exact references. None of these items block this implementation.
