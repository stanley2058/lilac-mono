# Plans

This directory contains work that has not shipped. Current behavior belongs in `PROJECT.md`; manual Core
config upgrades belong in `docs/core-config-migrations.md`; persisted-data, wire, and protocol
consequences belong in `MIGRATIONS.md`. Completed and superseded plans are removed after their durable
facts are incorporated into those documents and remain available in Git history.

## Active

No repository-wide implementation plans are active.

Only plans listed under **Active** are repository-wide implementation plans. A task-specific plan is
authoritative only when the user explicitly approves it for that task.

## Confirmed Residuals

These are confirmed non-active residuals only. They are not approved implementation plans or
promises to implement:

- Mini compaction has no undo warning/reversibility contract and cannot be requested while a run is
  active.
- Mini compaction does not implement suffix-first overflow handling; retained-suffix overflow can
  re-summarize history first.
- Mini has no pre-threshold compaction nudge, `/compact <focus>` control, or `/context` inspection
  command.
- Conversation-thread search has no top-N reranker beyond its current scoring pipeline.
- Core compaction-checkpoint persistence retains a stale `responseStartIndex` edge for cancelled or
  failed runs after canonical messages were replaced by compaction.
- Core tool-triggered checkpoint deletion depends on receiving the Discord gateway deletion event;
  the deletion tool does not unlink the checkpoint mapping directly.
- Persistent compaction checkpoints have limited end-to-end deletion and time-based cleanup coverage.
