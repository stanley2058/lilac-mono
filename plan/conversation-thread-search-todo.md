# Conversation Thread Search Implementation Todo

- [x] Inspect current tool registration, runtime wiring, model resolution, and SQLite store patterns.
- [x] Add thread storage tables and store APIs for thread metadata, membership, summaries, and embeddings/facets.
- [x] Add deterministic thread discovery/indexing over existing Discord search messages.
- [x] Add summarization worker skeleton and hidden `conversation.thread.runSummarization` tool.
- [x] Add `conversation.thread.search` with compact default output and lexical fallback.
- [x] Add `conversation.thread.read` with offset/limit pagination over stable thread membership order.
- [x] Wire runtime services and tool registration.
- [x] Add focused tests for storage, search/read tools, and runner behavior.
- [x] Run typecheck, tests, lint, and format validation.

## Follow-Ups

- [x] Add sqlite-vec vector search for summary facets behind an embedding adapter.
- [x] Document the new v2 conversation thread config in `MIGRATIONS.md`.
- [x] Add planned search filters: `sessionId`, `participantId`, `beforeTs`, `afterTs`.
- [x] Add native Discord thread formation with `kind: "discord_thread"` and `parentChannelId`.
- [x] Add reply-relation-aware inferred thread grouping from `discord_message_relations`.
- [x] Add event-driven thread refresh/invalidation after Discord message create/update/delete indexing.
- [x] Add real model-provider-backed embedding generation for production use.
- [x] Move long-running summarization/backfill execution into a Bun Worker isolate with job dispatch.
- [x] Serialize summarization jobs inside the worker isolate and add worker lifecycle logging.
- [x] Harden optional surface DB attachment when Discord surface tables are not migrated yet.
- [x] Allow native Discord threads when their parent channel is allowlisted.
- [x] Use weighted-sum semantic scoring across embedding facets.
- [x] Summarize first 40 text messages plus a truncation notice plus last 160 text messages when a thread exceeds 200 live messages.
- [x] Treat summary/embedding version mismatches as stale and eligible for rerun.
- [x] Add job-aware stage-level summarization logs.
- [x] Add focused coverage for worker queue serialization.
- [x] Push Discord allowlist filtering into store-level thread search before SQL `LIMIT`.
- [x] Add thread summary importance metadata and a small ranking nudge.
- [x] Add configurable `conversation.thread.summarization.model`.
- [x] Add configurable summarization concurrency and force reruns.
- [x] Exclude one-message threads from summarization eligibility.
- [x] Normalize Discord entities before thread summarization.
- [x] Add English-first summarizer guidance and retrieval hints for colloquial search.
- [x] Add positive-only aboutness summary fields and weighted semantic facets.
- [x] If aboutness facets are insufficient, add one request-time LLM aboutness interpretation pass over all query variants plus generic coverage scoring.
- [-] If query interpretation is insufficient, add a top-N LLM reranker for subject-level relevance judgment.
