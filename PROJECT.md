# Lilac Monorepo: Structure, Terminology, And Working Mental Model

This repo is an event-driven “agent runtime” built around a typed event bus (Redis Streams), surface adapters (Discord with optional GitHub ingress), and **layered tools** that are **progressively disclosed** to the agent:

- Level 1 (direct AI SDK tools): low-level local tools the LLM can call during generation (`bash`, `read_file`, `glob`, `grep`, `apply_patch`, `batch`, and `subagent_delegate` when enabled).
- Level 2 (tool server + `tools` CLI): a stable HTTP tool API (Elysia) exposed via the `tools` CLI (and usable by the agent through `bash`).
- Level 3 (skills): higher-level, file-based “skill bundles” discovered on disk and loaded on-demand.

All three are “for the agent”; the layering is mostly about keeping the default prompt/tool surface small while still enabling richer capabilities when needed.

The main loop is:

1. Surface ingress receives platform events (Discord adapter events and optional GitHub webhook triggers).
2. Discord adapter events are published onto the bus (`evt.adapter`).
3. A router turns Discord adapter events into request messages (`cmd.request.message`) based on per-session routing mode.
4. GitHub webhook handlers can publish `cmd.request.message` directly for GitHub-triggered runs.
5. An agent runner consumes request messages, runs an LLM (AI SDK) with local tools, and publishes streamed output to request-scoped topics (`out.req.<request_id>`).
6. A relay subscribes to `out.req.<request_id>` and streams output back to surface adapters (Discord and GitHub).
7. Optional: a workflow service creates durable “wait for reply / timeout” tasks and later publishes a resume request.

This document explains where things live, the words used in code, and the project’s “shape” so you don’t have to re-derive it each time.

---

## Repo Layout (What Is Where)

Workspace roots are Bun workspaces (`apps/*`, `packages/*`). `ref/` contains vendored upstreams as git submodules and is treated as read-only.

- `apps/core/`
  - The core runtime process (Discord + optional GitHub surfaces, event bus, router, agent runner, workflow service/scheduler, tool server, and runtime recovery/search services).
  - Entry: `apps/core/src/runtime/main.ts` (starts/stops `createCoreRuntime()`).
  - Most of the “system wiring” is in `apps/core/src/runtime/create-core-runtime.ts`.

- `apps/tool-bridge/`
  - The `tools` CLI + a “dev-mode” tool server.
  - CLI client: `apps/tool-bridge/client.ts`.
  - Tool server (no bus, no surface adapter by default): `apps/tool-bridge/index.ts`.
  - Build script: `apps/tool-bridge/build.ts` (produces `dist/index.js`, used as the `tools` binary).

- `apps/opencode-controller/`
  - OpenCode SDK wrapper CLI (`lilac-opencode`), designed for local and automation/ssh workflows.
  - Entry/client: `apps/opencode-controller/client.ts`.
  - Build script: `apps/opencode-controller/build.ts` (produces `dist/index.js`).

- `packages/event-bus/`
  - The bus implementation and the canonical event spec.
  - Typed event contract: `packages/event-bus/lilac-spec.ts`.
  - Typed bus wrapper: `packages/event-bus/lilac-bus.ts`.
  - Redis Streams transport: `packages/event-bus/redis-streams-bus.ts`.
  - Low-level types: `packages/event-bus/types.ts`.

- `packages/agent/`
  - The “pi-agent-like” wrapper around AI SDK streaming + steering/follow-up/interrupt queues.
  - Core implementation: `packages/agent/ai-sdk-pi-agent.ts`.
  - Optional auto-compaction: `packages/agent/auto-compaction.ts`.

- `packages/utils/`
  - Cross-cutting utilities: env parsing, core config, model providers, prompt templates, skills.
  - Config schema + loader: `packages/utils/core-config.ts`.
  - Provider wiring: `packages/utils/model-provider.ts`.
  - Model selection for “main/fast” slots: `packages/utils/model-slot.ts`.
  - Prompt file workspace management: `packages/utils/agent-prompts.ts`.

- `data/`
  - “Runtime data directory” for local/dev.
  - Prompt workspace lives in `data/prompts/*` by default.
  - `core-config.yaml` is seeded into `DATA_DIR` on startup if missing.
  - In docker compose this directory is bind-mounted for persistence.

- `__tests__/`
  - Root harness that runs workspace tests: `__tests__/workspaces.test.ts`.

- `compose.yaml` and `Dockerfile`
  - A dev container that runs `apps/core/src/runtime/main.ts` and includes Redis.
  - The docker build installs Bun, system tools (git, rg, browser dependencies, python, etc.), builds tool-bridge, and symlinks `tools` into PATH.
  - Docker compose persists extra home directories for agent ergonomics:
    - `./home/agents:/home/lilac/.agents`
    - `./home/.ssh:/home/lilac/.ssh`

---

## Key Concepts / Terminology

### Bus / Topics / Subscriptions

The event bus is Redis Streams underneath, wrapped in a typed API.

Implementation note: subscriptions use a small Redis connection pool because Redis Streams reads are blocking (`XREAD`/`XREADGROUP`). See `packages/event-bus/redis-connection-pool.ts` and `packages/event-bus/redis-streams-bus.ts`.

- Topic: a logical channel (backed by a Redis Stream key).
  - Examples (static topics): `cmd.request`, `evt.adapter`, `evt.request`, `cmd.workflow`, `evt.workflow`.
  - Output topics are request-scoped: `out.req.<request_id>`.

- Event type: a string like `cmd.request.message`.
  - All canonical event types and payloads live in `packages/event-bus/lilac-spec.ts`.

- Subscription `mode` (delivery semantics):
  - `work`: consumer-group queue semantics (competing consumers).
  - `fanout`: consumer-group broadcast semantics (each subscriptionId sees all events).
  - `tail`: non-durable streaming read (no consumer group).

- subscriptionId: durable identifier for the consumer group (used by `work`/`fanout`).
- consumerId: identity inside the group (often includes pid + random to avoid collisions).
- cursor: Redis stream entry id; used as an offset/checkpoint.

### Envelope Headers (Correlation)

The “request-scoped” part of the system uses consistent headers on bus messages:

- `request_id`: correlates everything for a single agent run.
- `session_id`: the surface session (e.g. Discord channel/thread id or `OWNER/REPO#number` for GitHub).
- `request_client`: source platform (`discord`, `github`, or `unknown`).

Many flows treat missing `request_id` as an error (especially request lifecycle and output events).

### Surface / Adapter / Session

“Surface” is the user-facing platform integration layer.

- Adapter: implements `SurfaceAdapter` (`apps/core/src/surface/discord/discord-adapter.ts`, `apps/core/src/surface/github/github-adapter.ts`).
- Session: a platform container (Discord channel/thread/DM or GitHub `OWNER/REPO#number`).
- Message refs:
  - `SessionRef` / `MsgRef` are small structs that identify sessions/messages across platforms.

The Discord adapter also maintains a local SQLite cache (`discord-surface.db`) for read-history operations.

### Router

The router subscribes to `evt.adapter` and decides whether to create/append to an agent request for Discord events.

- Implementation: `apps/core/src/surface/bridge/bus-request-router.ts`.
- Routing modes:
  - `mention`: only start a new request when the bot is mentioned or replied-to.
  - `active`: treat the session like a group chat and respond more aggressively.

Active-mode details:

- It can debounce multiple messages into a single initial prompt.
- It can optionally run a “gate” (small/fast model) to decide whether the bot should reply.

When the router forwards, it publishes `cmd.request.message` (topic: `cmd.request`) containing `ModelMessage[]`.

GitHub webhook ingress can also publish `cmd.request.message` directly (without passing through routing on `evt.adapter`).

### Request / Queue Modes

A “request” is the unit of agent work and output streaming.

`cmd.request.message` includes a queue mode:

- `prompt`: start a new request.
- `steer`: inject guidance into a currently running request (delivered at safe boundaries; also drains buffered follow-ups).
- `followUp`: append a user follow-up to a currently running request (buffered; delivered at safe boundaries).
- `interrupt`: abort + rewind and restart with the new message.

The agent runner enforces one active request per session at a time (per-session serialization).

### Agent Runner

Consumes `cmd.request` and runs the LLM.

- Implementation: `apps/core/src/surface/bridge/bus-agent-runner.ts`.
- Uses `AiSdkPiAgent` from `packages/agent`.
- Publishes:
  - `evt.request.lifecycle.changed` (queued/running/resolved/failed/cancelled)
  - `evt.request.reply` (a “start streaming output now” signal)
  - output stream events on `out.req.<request_id>`:
    - `evt.agent.output.delta.text`
    - `evt.agent.output.response.text`
    - `evt.agent.output.response.binary`
    - `evt.agent.output.toolcall`

### Reply Relay (Bus -> Surface)

When `evt.request.reply` arrives for a request, the relay subscribes to `out.req.<request_id>` and streams output to the adapter.

- Implementation: `apps/core/src/surface/bridge/subscribe-from-bus.ts`.

The relay also supports “re-anchoring” output mid-request (used by steer UX on Discord):

- `cmd.surface.output.reanchor` (topic: `cmd.surface`) tells the relay to freeze the current in-flight message chain and continue streaming in a new message.
- `evt.surface.output.message.created` (topic: `evt.surface`) is published by the relay when a surface message is created for a request.
  - Router uses this to detect “reply to the active streaming message”.

Important detail: `request_id` sometimes encodes “reply-to” behavior.

- If `request_id` is formatted as `discord:<session_id>:<message_id>`, the relay will reply to that Discord message.

### Workflow

Workflow is a durable “wait for something, then resume later” mechanism.

- Service: `apps/core/src/workflow/workflow-service.ts`.
- Scheduler (time-based triggers): `apps/core/src/workflow/workflow-scheduler.ts`.
- Store: `apps/core/src/workflow/workflow-store.ts` (SQLite-backed; default `SQLITE_URL` is `data/data.sqlite3`).

Two workflow “shapes” currently exist:

- v2 (interactive resume): tasks like `discord.wait_for_reply` that resume the agent in a real surface session.
  - When tasks resolve, the workflow service publishes a new `cmd.request.message` resume prompt with request id like `wf:<workflow_id>:<resume_seq>`.

- v3 (scheduled jobs): time-based triggers (`time.wait_until`, `time.cron`) that publish a new `cmd.request.message` when the trigger fires.
  - These runs use a synthetic session (`job:<workflow_id>`) and `request_client="unknown"`.
  - Scheduled jobs should generally use Level-2 tools (`tools surface.messages.send`, etc.) to produce user-visible output.

This is how you can “send a DM, wait for reply, then pick up where you left off” without keeping an in-memory agent around.

### Layered Tools (Progressive Disclosure)

There are three tool “levels”. They all serve the agent; higher levels are usually only used when the agent needs richer capabilities or a more stable interface.

1. Level 1: direct AI SDK tools (agent-local)
   - Used inside `apps/core/src/surface/bridge/bus-agent-runner.ts` via AI SDK tool calling.
   - Implementations: `apps/core/src/tools/*`.
   - Key ones:
      - `bash` (`apps/core/src/tools/bash.ts`), guarded by `apps/core/src/tools/bash-safety/*` unless `dangerouslyAllow=true`.
      - `read_file`, `glob`, `grep` (`apps/core/src/tools/fs/fs.ts`) (denylists include `DATA_DIR/secret`, `~/.ssh`, `~/.aws`, `~/.gnupg`).
      - `apply_patch` (`apps/core/src/tools/apply-patch/index.ts`) (format docs: `apps/core/src/tools/apply-patch/README.md`).
      - `batch` (`apps/core/src/tools/batch.ts`) for concurrent tool execution.
      - `subagent_delegate` (`apps/core/src/tools/subagent.ts`) when `agent.subagents` is enabled and depth limits allow delegation.

2. Level 2: tool server tools + the `tools` CLI
   - Served by Elysia from `apps/core/src/tool-server/create-tool-server.ts`.
   - Exposes endpoints:
     - `GET /health` health check
     - `GET /list` tool catalog
     - `GET /help/:callableId` tool help
     - `POST /call` invoke by `callableId`
     - `POST /reload` re-init tools and refresh callable mapping
   - Tool definitions live in `apps/core/src/tool-server/tools/*`.
   - Default registration: `apps/core/src/tool-server/default-tools.ts`.
   - The tool server uses request context headers (`x-lilac-request-id`, etc.) and an optional request-message cache (`apps/core/src/tool-server/request-message-cache.ts`) for request-scoped behavior.
   - `apps/tool-bridge/client.ts` provides a human-friendly `tools` CLI that calls the tool server; the agent can also invoke it through Level-1 `bash`.

3. Level 3: skills
   - Skills are on-disk bundles: a directory containing a required `SKILL.md` (YAML frontmatter + instructions) and optional helpers/resources.
   - Discovery + parsing lives in `packages/utils/skills.ts`.
   - The tool server exposes skills through `apps/core/src/tool-server/tools/skills.ts` (`skills.list`, `skills.brief`, `skills.full`).
   - Skills are meant to be loaded on-demand (metadata first, then full body) to avoid prompt bloat.

### The `tools` CLI

`apps/tool-bridge/client.ts` is a human-friendly CLI that talks to the tool server.

- It can pass correlation headers via env vars:
  - `LILAC_REQUEST_ID`, `LILAC_SESSION_ID`, `LILAC_REQUEST_CLIENT`, `LILAC_CWD`
- It can point at a non-default tool server via `TOOL_SERVER_BACKEND_URL`.
- It supports `--input=@file.json` and `--stdin` for whole-JSON payloads, plus `--field:value` flags.

---

## Runtime Configuration And State

### DATA_DIR

`DATA_DIR` (default: `<repo>/data`) is where runtime state lives.

Expected contents over time:

- `core-config.yaml` (seeded from `packages/utils/config-templates/core-config.example.yaml` if missing)
- `prompts/` (seeded from `packages/utils/prompt-templates/*` if missing)
- `discord-surface.db` (Discord cache DB; default path)
- `discord-search.db` (Discord search index DB)
- `agent-transcripts.db` (agent transcript/turn cache used by routing/gating)
- `data.sqlite3` (default SQLite DB for workflow store; override via `SQLITE_URL`)
- `graceful-restart.db` (in-flight relay/agent recovery snapshots)
- `skills/` (skill bundles installed/seeded for discovery)
- `secret/` (persisted secrets, e.g. GitHub App credentials, GPG home)
- `workspace/` (default working directory for bash/fs tools in the core runtime)

Onboarding-related tools may also create additional persisted directories under `DATA_DIR` (for example `bin/`, `.bun/`, `.npm-global/`, `.config/`, `tmp/`).

### Prompts

The agent system prompt is built from local prompt files.

- Source templates: `packages/utils/prompt-templates/*`
- Runtime workspace: `DATA_DIR/prompts/*` (see `packages/utils/agent-prompts.ts`)

Prompt sync behavior is template-aware and stateful:

- Prompt sync state: `DATA_DIR/prompts/.prompt-template-state.json`
- If a prompt file still matches the last managed version, template updates are auto-applied in place.
- If a prompt file has local edits and the template changes, a sibling `*.new` file is written (for example `AGENTS.md.new`) and the local file is left untouched.

At run time, the core agent runner appends a compact `## Available Skills` index to the end of the primary agent's system prompt. The index is discovered using the same rules as the `tools skills.list` command.

This makes prompt iteration a file-edit operation rather than a code change.

### core-config.yaml

Loaded via `packages/utils/core-config.ts` and cached by mtime.

Key sections:

- `surface.router`: mention/active routing config.
- `surface.discord`: bot token env var name, allowlists, botName.
- `agent.subagents`: subagent enablement/depth/timeout/profile config.
- `models`: model slots (`main`, `fast`) with optional preset aliases.
- `entity`: optional aliasing/mention rewriting for users/sessions.

### Environment variables

Parsed in `packages/utils/env.ts`. The important ones:

- `REDIS_URL` (required by core runtime)
- `SQLITE_URL` (workflow store sqlite path; default: `data/data.sqlite3`)
- `DATA_DIR` (where config/prompt/db live)
- `LL_TOOL_SERVER_PORT` (tool server port; default 8080)
- `LILAC_WORKSPACE_DIR` (default working directory for agent tools)
- `GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_PORT`, `GITHUB_WEBHOOK_PATH` (enable GitHub webhook ingress)
- Provider keys/base URLs (`OPENAI_*`, `OPENROUTER_*`, `ANTHROPIC_*`, `GEMINI_*`, `AI_GATEWAY_*`, etc.)
- `TAVILY_API_KEY` (enables `tools search` and `tools fetch --mode=tavily`)
- `DISCORD_TOKEN` (or whatever `surface.discord.tokenEnv` points to)

---

## How The Core Runtime Is Wired

`apps/core/src/runtime/create-core-runtime.ts` is the best “single file” overview.

Startup order is intentional:

1. Start Discord search indexer
2. Bridge adapter -> bus (so early Discord events don’t get lost)
3. Workflow service + scheduler (subscribes to adapter events; handles time-based triggers)
4. Router (subscribes to adapter events and request lifecycle)
5. Tool server + request message cache (so tools can see request messages)
6. Connect Discord adapter
7. Bridge bus -> Discord adapter (so output relay is ready)
8. Optionally start GitHub webhook ingress + bus -> GitHub relay (if GitHub App secret exists)
9. Agent runner (so it can’t publish replies before relays are online)
10. Optionally restore graceful-restart snapshots

Shutdown happens in reverse (best-effort).

---

## Common “Where Do I Change X?” Pointers

- Add/modify bus event types: `packages/event-bus/lilac-spec.ts` and routing/key logic in `packages/event-bus/lilac-bus.ts`.
- Change request routing behavior: `apps/core/src/surface/bridge/bus-request-router.ts` and config schema in `packages/utils/core-config.ts`.
- Change agent execution behavior (steer/follow-up/interrupt semantics): `packages/agent/ai-sdk-pi-agent.ts`.
- Change which local tools the LLM can call: `apps/core/src/surface/bridge/bus-agent-runner.ts`.
- Add a new HTTP tool: implement `ServerTool` in `apps/core/src/tool-server/tools/*` and register it in `apps/core/src/tool-server/default-tools.ts`.
- Change how tool invocations are served/logged: `apps/core/src/tool-server/create-tool-server.ts`.
- Change Discord ingestion/persistence/output rendering: `apps/core/src/surface/discord/discord-adapter.ts` and `apps/core/src/surface/discord/output/*`.
- Modify workflow behavior or add a new task kind: `apps/core/src/workflow/*`.
- Modify scheduled workflows: `apps/core/src/workflow/workflow-scheduler.ts` and `apps/core/src/workflow/cron.ts`.
- Modify skill discovery rules: `packages/utils/skills.ts`.

---

## Running / Building / Testing (Quick)

- Run core runtime (expects Redis + Discord token + allowlists):
  - `bun apps/core/src/runtime/main.ts`
  - This command is for humans, DO NOT run it if you are an agent. Otherwise it will hang your bash tool.

- Run tool server only (dev mode; fewer tools enabled because no bus/adapter):
  - `bun apps/tool-bridge/index.ts`
  - This command is for humans, DO NOT run it if you are an agent. Otherwise it will hang your bash tool.

- Build `tools` CLI:
  - `cd apps/tool-bridge && bun run build`

- Build `lilac-opencode` CLI:
  - `cd apps/opencode-controller && bun run build`

- Run tests:
  - Root harness: `bun test`
  - Per workspace: `cd apps/core && bun test` (and similarly for `packages/*` that have tests)

- Docker (includes Redis):
  - `docker compose up --build`
  - This command is for humans, DO NOT run it if you are an agent. Otherwise it will hang your bash tool.

---

## Gotchas / Design Intent

- Discord allowlist is strict: if both `allowedChannelIds` and `allowedGuildIds` are empty, the bot ignores all Discord traffic.
- Request IDs are meaningful:
  - `discord:<channelId>:<messageId>` implies “reply to this message”.
  - `github:<owner/repo#number>:<triggerId>[:<suffix>]` identifies GitHub-triggered runs.
  - `wf:<workflowId>:<seq>` is a workflow resume request.
  - `sub:<parent_request_id>:<uuid>` identifies delegated subagent runs.
  - `req:<uuid>` is used for router-gated “start a request without a direct mention/reply”.
- The tool server is not the AI SDK tool runner; it’s a separate HTTP API that can be used by humans and by the agent (typically via the `tools` CLI).
- Prompts/config are designed to be editable without code changes (seeded into `DATA_DIR`).
- The bus spec is compile-time only (no runtime validation), so producers/consumers must be disciplined about payload shapes.
