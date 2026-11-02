# Data layout

Use this map to find Lilac's own files and state under `DATA_DIR`. In the stock container,
`DATA_DIR` is `/data`. Paths below are relative to it unless noted.

## Confirm before relying on a path

1. Resolve `DATA_DIR` from the process environment, or from the prompt file paths shown in the system
   prompt.
2. List the directory. Deployments can relocate some files through config or environment variables.
3. When a path matters to the answer, confirm its owner in the source named below.

## Agent workspace

| Path | Contents | Owner |
| --- | --- | --- |
| `prompts/` | `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, and `memory/YYYY-MM-DD.md` | `packages/utils/agent-prompts.ts` |
| `prompts/HEARTBEAT.md` | Standing heartbeat instructions | `packages/utils/agent-prompts.ts` |
| `prompts/heartbeat/` | `WORK.md`, `inbox/`, `archive/`, and topic files for watches | `packages/utils/agent-prompts.ts`, `heartbeat` skill |
| `workspace/` | Default project root for workspace work, with its own `AGENTS.md` | `apps/core/src/runtime/create-core-runtime.ts` |
| `skills/<name>/SKILL.md` | Operator-installed skills | `packages/utils/skills.ts` |
| `cmds/` | Custom commands | `packages/utils/custom-commands.ts` |
| `workflows/` | Personal workflow definitions; project workflows live in `<project>/.lilac/workflows/` | `apps/core/src/workflow/workflow-definition-store.ts` |
| `plugins/` | External plugins | `packages/plugin-runtime/discovery.ts` |

## Configuration

| Path | Contents | Owner |
| --- | --- | --- |
| `core-config.yaml` | Core configuration; see [core-config.md](core-config.md) | `packages/utils/core-config.ts` |
| `mcp-config.yaml` | Configured MCP servers; load the `mcp-management` skill before changing it | `apps/core/src/mcp` |
| `.schemas/` | Generated editor schemas for both config files | `apps/core/src/runtime/config-schemas.ts` |
| `secret/` | Tool environment, OAuth tokens, and provider credentials. Do not read or print it. | `apps/core/src/tools/tool-env.ts`, `apps/core/src/mcp/credential-file.ts` |

## Runtime state

| Path | Contents | Owner |
| --- | --- | --- |
| `data.sqlite3` | Durable workflows, runs, journals, and triggers; `SQLITE_URL` can move it | `packages/utils/env.ts`, `apps/core/src/workflow/durable-workflow-store.ts` |
| `request-delivery.db` | Accepted prompts, controls, and delivery receipts | `apps/core/src/runtime/create-core-runtime.ts` |
| `agent-transcripts.db` | Agent run transcripts | `packages/utils/core-config.ts` |
| `native-surface.db` | Native web threads, messages, and settings | `apps/core/src/surface/native` |
| `discord-surface.db` | Discord surface state; `surface.discord.dbPath` can move it | `packages/utils/core-config.ts` |
| `discord-search.db`, `discovery.db` | Search and discovery indexes | `packages/utils/core-config.ts` |
| `blobs/` | Core-managed bytes for the local blob store; `blobStorage` can move it | `apps/core/src/runtime/create-core-blob-store.ts` |
| `tool-results/` | Overflow artifacts from large tool results | `apps/core/src/runtime/create-core-runtime.ts` |
| `.cache/` | Rebuildable caches such as the `fff` file index | `apps/core/src/tools/fs/fs.ts` |

Inspect databases read-only. Open one only when the request puts its contents in scope, and prefer
existing Level 2 callables or the `tools` CLI when they answer the question.
