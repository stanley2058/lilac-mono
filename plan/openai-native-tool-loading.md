# Native tool loading for OpenAI and Codex

Status: Draft for review. Implementation has not started.

## Outcome

On supported native OpenAI Responses and Codex paths, discovering an MCP or plugin tool appends
its definition to conversation input through the native tool-search protocol. Discovery does not
change the top-level tool declarations, so ordinary search steps preserve the preceding input prefix.
Other providers retain Lilac's current `find_tools` behavior.

The initial native request sends direct tools and client-executed `tool_search`. Deferred schemas
remain in Lilac until selected. This uses client-executed search, not OpenAI-hosted catalog search.

## Scope and decisions

- Reuse the existing catalog, stable IDs, ranking, query syntax, and selection callback.
- Thread deferred-tool context through Core's runner and the agent execution boundary. Core owns
  catalog construction; adapters receive declarations and selection access without importing Core.
- Keep `LineageToolAuthority` and `loadedCatalogIds` as the authority for inherited selections.
- Separate tools authorized for local execution from definitions advertised in the request's
  top-level `tools` array. Loaded tools remain executable even though their schemas live in history.
- Encode native search calls and outputs only on supported model, endpoint, and adapter combinations.
  Provider name alone is insufficient to select this behavior.
- Keep Claude Code's existing native `ToolSearch` bridge unchanged.
- Keep AI SDK paths, including the current Codex SSE path, on portable discovery in this change.
  Native-to-portable fallback must preserve selected tools and usable history.
- Add no ranking dependency, user configuration option, generic `call_tool` wrapper, new database,
  journal, worker, or hosted-search integration.

## Current ownership

| Concern | Existing owner |
| --- | --- |
| Catalog and portable search | `apps/core/src/mcp/catalog.ts` |
| Toolset assembly and search callback | `apps/core/src/plugins/manager.ts` |
| Runner composition and rebinding | `apps/core/src/surface/bridge/bus-agent-runner.ts` |
| Loaded IDs and prefix inheritance | `apps/core/src/surface/bridge/bus-agent-runner/lineage-tool-authority.ts` |
| Per-step execution authority | `packages/agent/agent-executor.ts`, `agent-execution-host.ts` |
| Native protocol, history encoding, continuation | `packages/agent/adapters/openai-responses/` |
| Codex codec and transport selection | `packages/agent/adapters/codex/` |
| Durable messages and checkpoints | Event-bus message schemas, Core transcript codecs, agent-run checkpoint persistence |

`LineageToolAuthority.snapshot()` returns a sorted cumulative set. It does not retain discovery
positions, search call IDs, or the schema definitions originally disclosed. Reuse that set for
authority; use conversation history for ordered disclosure.

## Native execution and replay

The native adapter maps a `tool_search_call` into the existing host-owned discovery operation.
Successful selection updates lineage authority and produces a `tool_search_output` with matching
definitions and the correlated call ID. Normal tool calls still use Lilac's validators, per-step
authority, execution events, and result normalization.

Each completed disclosure must retain its original schemas and position for replay. Resolve schema
snapshots when tools are selected; do not regenerate old outputs from a later catalog generation.
The cumulative loaded-ID snapshot cannot substitute for these history records.

Use the existing canonical message and provider-metadata mechanism if its contracts support the
required representation. Preserve a portable search-call/result projection so fallback does not
send OpenAI-specific items to another provider. Native replay metadata must survive normalization,
checkpointing, restart, and transcript materialization. Do not rely solely on connection memory or
`previous_response_id`; Codex's codec uses `store: false`.

Native loading records contain tool declarations only, not executable handlers or credentials.
Current local authority remains decisive if a historical declaration names a tool that is no longer
available. Discovery does not authorize tools outside the current profile and catalog.

## Compaction and inherited prefixes

For ordinary replay, emit each retained loading record at its original position. The adapter's
continuation comparison must include these records so a suffix request cannot omit a required load.

At a new prefix boundary, determine which inherited selected tools are already represented by
retained native loading state. Restore only the missing definitions using a stable
`additional_tools` item before messages that require them. Keep that item's contents and position
fixed throughout the new prefix; subsequent discoveries append new native search outputs.

Handle local compaction and server compaction separately. An opaque server compaction item is not
evidence by itself that schemas were retained. Establish the supported endpoint behavior with a
protocol fixture or focused integration check before choosing the restoration rule. If behavior
cannot be established, retain the portable path for that combination.

Old transcripts may have loaded IDs without native loading records. Treat entry into native mode
as a new provider prefix and seed those available selections once. Do not invent historical search
calls. Provider switching may establish a new cache prefix; normal discovery within one native
prefix must preserve it.

## Implementation checklist

- [ ] **1. Settle the execution and replay representation.** Trace native model selection, tool
  execution, stored-message metadata, compaction, and fallback. Specify the smallest private
  deferred-tool context and typed loading record, including schema snapshot, call correlation, and
  portable projection. Define the capability decision for native versus portable discovery.
  Completion: exact types, owners, and a transport/model support matrix are recorded, with evidence
  that the chosen replay representation survives existing persistence. If a stored or wire contract
  must change, present the exact schema and migration policy for approval before implementing it,
  as required by `AGENTS.md` and `MIGRATIONS.md`. This draft does not approve an unspecified migration.

- [ ] **2. Thread catalog context and separate exposure from authority.** Pass run-scoped deferred
  declarations and the existing selection operation through the runner and agent boundary. Preserve
  the execution snapshot's direct-plus-selected authority while the native request advertises only
  direct definitions and native search. Apply the same binding on applicable primary, subagent,
  continuation, and model-rebinding paths; retain existing catalog lifetime ownership.
  Completion: host-level tests prove a selected tool executes, an unselected or unavailable tool is
  rejected, and portable bindings still expose selected schemas on the next step.

- [ ] **3. Implement the native search cycle.** Extend Responses request/event codecs and adapter
  dispatch for client-executed search. Reuse existing query parsing and ranking. Return schema-bearing
  native outputs and preserve complete loading records through canonical history. Respect existing
  cancellation and tool-batch settlement rules, including empty results and failed searches.
  Completion: a captured request sequence performs search, loads a previously absent tool, executes
  it through the host, and continues without adding its definition to top-level `tools`.

- [ ] **4. Integrate replay and prefix restoration.** Preserve loading records across full replay,
  reconnect, checkpoint recovery, and normal request inheritance. Add the stable boundary seed for
  inherited selections missing from native loading state. Implement the verified local/server
  compaction rules and conversion between native and portable bindings.
  Completion: replay and restoration tests cover the matrix below without duplicate execution,
  missing declarations, rewritten historical schemas, or repeated seed insertion.

- [ ] **5. Verify and document.** Run focused agent/Core tests and changed-workspace typechecks using
  root scripts. Run architecture checks for affected boundaries and registrations, followed by
  `bun run check` against the final implementation. Update `PROJECT.md` with shipped ownership and
  behavior, and `MIGRATIONS.md` only if an approved contract change requires it. Remove the completed
  plan according to `plan/README.md`.
  Completion: required checks pass and the request-prefix assertions below hold. Record any live
  provider validation that was unavailable; do not claim measured cache savings from fixtures.

## Required verification matrix

| Case | Assertion |
| --- | --- |
| Initial native request | Direct tools plus native search; deferred definitions absent |
| Keyword, exact, required-term, empty search | Existing search semantics and result limits preserved |
| First and subsequent discoveries | Top-level declarations stable; only new input appended |
| Repeated discovery | Valid correlated output; cumulative authority unchanged by duplicates |
| Loaded tool call | Local schema validation and current authority enforced |
| Multiple search calls in a turn | Each output retains its call ID; selection commits consistently |
| Interrupted search or reconnect | No orphan output, duplicate execution, or silently lost selection |
| Full replay and restart | Same completed loading records, schema contents, and relative positions |
| Catalog reload | Historical records unchanged; execution uses current permitted binding |
| Local compaction | Missing inherited definitions restored once before dependent calls |
| Server compaction | Retention/restoration follows verified endpoint behavior |
| Historical transcript with IDs only | New native prefix seeded without fabricated search history |
| Branch or checkpoint continuation | Only selections reachable through that lineage are inherited |
| Native-to-portable fallback | Search history readable; selected schemas in portable tool list |
| Portable-to-native switch | Available inherited selections seeded at the new provider prefix |
| Codex native versus SSE | Native codec path uses loading; existing AI SDK SSE path remains portable |
| Other providers and Claude Code | Existing discovery behavior unchanged |

Use serialized request comparisons to demonstrate stable prefixes. A live cache-hit percentage is
not an acceptance criterion because cache retention and provider routing are outside Lilac's control.

## References

- [OpenAI client-executed tool search](https://developers.openai.com/api/docs/guides/tools-tool-search#client-executed-tool-search)
- [OpenAI additional tool input](https://developers.openai.com/api/docs/guides/tools-tool-search#add-tools-at-a-specific-point-in-the-input)
- Vendored Codex: `ref/codex/codex-rs/core/src/tools/handlers/tool_search_spec.rs`,
  `tool_search.rs`, and `ref/codex/codex-rs/core/tests/suite/search_tool.rs`.
