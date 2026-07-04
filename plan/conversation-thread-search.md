# Conversation Thread Search Plan

Temporary design snapshot for the `conversation.thread.*` tool family.

## Goals

- Make conversation memory searchable by coherent thread summaries instead of raw substring/message hits.
- Keep the existing `discovery.search` behavior unchanged for now.
- Add explicit thread tools:
  - `conversation.thread.search`: search summarized conversation threads and return compact results.
  - `conversation.thread.read`: read a thread transcript by thread id with pagination.
  - `conversation.thread.runSummarization`: hidden/admin runner that triggers the summarization worker.
- Do not add automatic thread suggestion injection in this phase.

## Thread Storage Model

Threads are derived from existing Discord message data and message relations. Store thread membership by message ids, not duplicated transcript text.

Thread records should store facts, not explicit lifecycle states:

- `threadId`
- `channelId`
- `guildId`
- `parentChannelId`
- `kind`: native Discord thread or inferred active-channel thread
- `startMessageId`
- `endMessageId`
- `startTs`
- `endTs`
- `messageCount`
- `updatedAt`
- `lastSummarizedAt`
- `lastEmbeddedAt`
- `summaryInputHash`
- `embeddingInputHash`
- `summaryVersion`
- `embeddingVersion`

Derived state examples:

- stale: no summary exists, summary hash differs, or `lastSummarizedAt < updatedAt`
- summarized: `lastSummarizedAt >= updatedAt` and `summaryInputHash` matches current input hash
- embedding stale: no embedding exists, embedding hash differs, or `lastEmbeddedAt < lastSummarizedAt`

If a thread no longer has any live messages, remove the thread row, membership rows, summaries, and embeddings.

## Thread Formation

Native Discord reply/thread channels are direct thread candidates.

Active-channel inferred threads should be deterministic initially:

- Walk newest to oldest from the latest unprocessed message.
- Keep adding earlier eligible messages while they remain in the same conversation candidate.
- Persist membership with stable ordinal order.
- Prefer over-fragmenting initially. Merging can be added later.

Eligibility should start with simple signals:

- message is live and chat-like
- same channel/session
- direct reply relation connects to current candidate, or close chronological exchange
- hard break on long silence, session boundary, deleted/system messages, or obvious non-chat separators

## Summary Schema

For phase 1, summaries contain:

- `title`: under 120 characters
- `brief`: under 1024 characters
- `topics`: short non-canonical topic phrases

Topics are embeddable phrases, not global/canonical tags. Avoid building a tag graph or taxonomy.

Summary replacement semantics:

- Recompute title, brief, and topics from the current thread transcript.
- Replace the previous summary as one unit.
- The summarizer should receive the previous summary when available to reduce unnecessary drift after small thread updates.
- Enforce output limits after parsing, even if the model returns oversized fields.

Prompt contract:

- Use strict structured output through the AI SDK output schema facility.
- Parse model output as schema-validated JSON.
- Log and retry later on parse/provider failure.

## Summarization Timing

Universal rule:

- A thread is eligible for summarization at least 1 hour after its last update.
- If an old summarized thread gets a new reply, edit, or delete, its `updatedAt` and input hash change. It becomes eligible again after the quiet period.

Worker behavior:

- Feature-gated behind a default-false config flag.
- Check cheaply every 10 minutes.
- Summarize one thread at a time for consistency.
- Run summarization work in a worker thread so manual backfill can run in the background.
- No fixed per-run cap initially. Admin-triggered backfill is expected to be intentional.
- Log worker progress and failures like other services.
- Failed summaries or embeddings remain eligible for a future worker run.

Hidden runner tool:

- `conversation.thread.runSummarization`
- Hidden from normal model tool listing.
- Inputs to consider:
  - `dryRun?: boolean`
  - `threadId?: string`
  - `beforeTs?: number | string`
  - `afterTs?: number | string`
  - optional session/channel filters if needed later

## Embeddings

Embedding provider/model should go through the same model provider resolution pipeline where practical.

Provider capability decision:

- Fail open because model metadata sources may not reliably identify embedding models.
- Verify it is not obviously not an embedding model, but do not require perfect metadata.
- If embedding fails, keep the summary and make lexical fallback available.
- Failed embedding work should be retried by later worker runs.

Storage:

- sqlite-vec is the likely first vector database.
- Store model/version/hash metadata with embeddings.

Embedding granularity:

- Multiple embeddings per thread are allowed and preferred.
- Summary facets:
  - `combined`: title plus brief plus topics
  - `brief`
  - `topics`
  - `title`
  - `retrievalHints`
  - positive-only aboutness facets:
    - `domains`
    - `situations`
    - `complaintTargets`
    - `entities`
    - `userWouldAskForThisAs`

Ranking aggregation:

- Weighted score by facet, with this priority:
  - combined > brief >> topics >>> title
- If a facet has no embedding or embedding search fails, that facet contributes 0.
- Lexical fallback over title, brief, and topics should still work when embeddings are unavailable.

## Aboutness Retrieval Plan

Encode what a thread is about, not what it is not about. The summarizer sees the full thread context, so it should materialize positive retrieval evidence that future search can compare against the user's query.

Add positive-only aboutness fields to summaries:

- `domains`: broad real-world or project domains, such as day job, workplace, Discord social conflict, architecture, debugging, or career planning.
- `situations`: concrete situations in the thread, such as false accusation, design handoff issue, review frustration, or migration planning.
- `complaintTargets`: what frustration, venting, or criticism is directed at when present, such as company process, coworker handoff, or a flaky API.
- `entities`: important people, projects, tools, organizations, files, commands, or named concepts.
- `userWouldAskForThisAs`: natural future-search phrases someone might type to find this thread.

Do not add precomputed `explicitExcludes` or other negative facets. Negative relevance is query-dependent and hard to enumerate without knowing the future query.

Incremental ladder:

1. Index the new positive aboutness fields as semantic facets. Weight `userWouldAskForThisAs` and `complaintTargets` highest, and keep score aggregation normalized so longer summaries do not win by having more fields.
2. If this does not separate emotionally similar but topically different threads, add request-time LLM aboutness interpretation into the same positive dimensions. For multi-query input, join all query variants and capture aboutness once for the whole request, not once per query.
3. Apply generic aboutness coverage scoring over the recall candidates. Reward positive evidence for the request's subject/domain/target/situation and penalize entity-only or mood-only matches when the request has specific aboutness.
4. If retrieval is still poor, add a top-N LLM reranker that judges whether each candidate is about the original query's intended subject, not merely emotionally similar.
5. Keep verbose attribution/debug output sufficient to inspect which query variants, aboutness fields, and coverage multipliers caused bad matches before adding more heuristics.

## Search Tool

`conversation.thread.search` searches summarized threads.

Default output should be compact and token efficient:

- `threadId`
- `title`
- `brief`

Do not include transcripts, topics, aboutness, importance, time ranges, message counts, session ids, or raw score details by default.

Inputs to consider:

- `query: string`
- `limit?: number`
- `sessionId?: string`
- `participantId?: string`
- `beforeTs?: number | string`
- `afterTs?: number | string`
- `mode?: "hybrid" | "semantic" | "lexical"`
- `verbose?: boolean`

Verbose output can include:

- score components
- topics, retrieval hints, aboutness, importance, time ranges, and message counts
- channel/session ids
- start/end message ids
- summary and embedding version metadata
- derived stale/summarized flags

Search and read must respect the current Discord allowlist, not only historically indexed data.

## Read Tool

`conversation.thread.read` reconstructs a thread transcript from stored membership ordinals and current indexed messages.

Inputs to consider:

- `threadId: string`
- `offset?: number`
- `limit?: number`

Output should include:

- thread metadata
- title, brief, topics if available
- messages in stable membership order
- pagination metadata: `offset`, `limit`, `nextOffset`, `hasMore`

Use offset/limit for phase 1 simplicity.

## Reliability And Cleanup

- Message create/update/delete changes thread input hash and `updatedAt`.
- Deleted messages should disappear from thread reads and force summary/embedding invalidation.
- Empty or inaccessible threads should be cleaned up reactively.
- Summary and embedding jobs should be idempotent.
- Store data versions so prompt/schema/model changes can mark old summaries or embeddings stale.

## Automatic Thread Metadata Injection

Automatic similar-thread metadata injection is implemented behind default-false config:

- `conversation.thread.autoInject.enabled`: default `false`.
- `conversation.thread.autoInject.plannerModel`: optional model used to plan automatic search queries; when unset, it inherits `conversation.thread.summarization.model`.
- `conversation.thread.autoInject.minTextUnits`: default `80`; only run when the latest real user input has enough meaningful authored text so short prompts stay fast.
- `conversation.thread.autoInject.limit`: max injected title entries.
- `conversation.thread.autoInject.minScore`: default `0.1`; minimum final search score after semantic/lexical ranking and aboutness coverage.
- `conversation.thread.autoInject.mode`: `hybrid`, `semantic`, or `lexical`.
- `conversation.thread.autoInject.filterCurrentParticipants`: when enabled, keep only candidate threads that contain at least one Discord user visible in the composed request/reply-chain context. The main agent participant is already required by thread formation and is not part of this filter.

The input gate measures meaningful text units instead of raw characters:

- URLs, Discord mentions/channels/roles/timestamps/custom emoji, whitespace, punctuation, and Markdown syntax do not count.
- Latin letters/numbers count as 1 unit.
- Han, Hiragana, Katakana, and Hangul characters count as 2 units.
- Fenced code blocks count at 0.2x and inline code counts at 0.3x, with total code-derived units capped at 20.
- Attachments/embeds by themselves do not count; only accompanying authored text can trigger injection.

The injection path fabricates a `conversation.thread.search` tool-call/result before the model answers. It first plans compact semantic query variants plus positive aboutness from the latest real user message in the prompt request, then searches with the precomputed aboutness so request-time query interpretation is not duplicated. The generated search query must not use prior assistant output, prior tool results, previous auto-injected metadata, or auto-compaction summaries.

Auto-injection is only considered when starting a `queue: "prompt"` request/run. It intentionally does not run for `followUp`, `steer`, or `interrupt` messages delivered into an already-running request. Those queue modes are stronger real-time control signals to continue, redirect, or interrupt the active response without adding background memory-search latency or extra synthetic context.

Injected result shape is intentionally minimal:

```json
{
  "note": "Auto-injected conversation-thread metadata for possible context. Use only if relevant; thread transcripts were not loaded.",
  "entries": [{ "threadId": "...", "title": "..." }]
}
```

Search or planning failures fail open: no metadata is injected and the normal answer proceeds.

## Deferred

- Canonical tags or graph-like topic systems.
- Model-based boundary classification.
- Merging inferred thread fragments.
- Message-level embeddings.
