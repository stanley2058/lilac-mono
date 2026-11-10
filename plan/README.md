# Plans

This directory contains work that has not shipped. Current behavior belongs in `PROJECT.md`; manual Core
config upgrades belong in `docs/core-config-migrations.md`; persisted-data, wire, and protocol
consequences belong in `MIGRATIONS.md`. Completed and superseded plans are removed after their durable
facts are incorporated into those documents and remain available in Git history.

## Active

- [Repository audit fixes (2026-11)](audit-2026-11.md): approved fixes from the November audit, split
  into lanes A to I.

Native surface implementation is complete. See [setup and operation](../docs/native-surface.md)
and [verification](../docs/native-surface-verification.md).

Only plans listed under **Active** are repository-wide implementation plans. A task-specific plan is
authoritative only when the user explicitly approves it for that task.

## Confirmed Residuals

These are confirmed non-active residuals only. They are not approved implementation plans or
promises to implement:

- Conversation-thread search has no top-N reranker beyond its current scoring pipeline.
- Core compaction-checkpoint persistence retains a stale `responseStartIndex` edge for cancelled or
  failed runs after canonical messages were replaced by compaction.
- Core tool-triggered checkpoint deletion depends on receiving the Discord gateway deletion event;
  the deletion tool does not unlink the checkpoint mapping directly.
- Persistent compaction checkpoints have limited end-to-end deletion and time-based cleanup coverage.
