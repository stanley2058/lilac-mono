# Lilac Monorepo

Lilac is an event-driven agent runtime: a typed Redis Streams event bus + surface adapters (Discord, with optional GitHub webhook integration) + an agent runner (AI SDK) + an HTTP tool server and `tools` CLI.

- Architecture/terminology: `PROJECT.md`
- Repo conventions for coding agents: `AGENTS.md`

## Layout

- `apps/core/`: core runtime (Discord + optional GitHub surfaces, bus wiring, router, agent runner, workflow, tool server)
- `apps/tool-bridge/`: dev-mode tool server entry + `tools` CLI bundle (builds to `dist/`)
- `apps/opencode-controller/`: OpenCode SDK wrapper CLI (`lilac-opencode`), builds to `dist/`
- `packages/event-bus/`: typed event spec + Redis Streams transport
- `packages/agent/`: AI SDK streaming agent wrapper
- `packages/utils/`: env/config parsing, model providers, prompt + skills utilities
- `data/`: local runtime state (config, prompts, sqlite dbs, default workspace)
- `ref/`: vendored upstream references (treat as read-only unless a task says otherwise)

## Install

This monorepo uses Bun workspaces. Install dependencies in the workspace(s) you work on:

- `cd apps/core && bun install`
- `cd apps/tool-bridge && bun install`
- `cd apps/opencode-controller && bun install`
- `cd packages/event-bus && bun install`
- `cd packages/utils && bun install`
- `cd packages/agent && bun install`

## Build / Test / Typecheck

- Build the `tools` CLI: `cd apps/tool-bridge && bun run build`
- Build the `lilac-opencode` CLI: `cd apps/opencode-controller && bun run build`
- Run all tests (workspace harness): `bun test`
- Run workspace tests: `cd apps/core && bun test`
- Typecheck `lilac-opencode`: `cd apps/opencode-controller && bun run typecheck`
- Typecheck (per workspace): `cd <workspace> && bunx tsc -p tsconfig.json --noEmit`

## Running

Most commands below are long-running.

- Docker dev (includes Redis): `docker compose up --build`
- Core runtime (needs `REDIS_URL` + Discord config): `bun apps/core/src/runtime/main.ts`
  - Important: with default `core-config.yaml`, both Discord allowlists are empty, so the bot ignores all Discord traffic until you set at least one of `surface.discord.allowedChannelIds` or `surface.discord.allowedGuildIds`.
- Tool server only (dev mode): `bun apps/tool-bridge/index.ts`
- `tools` CLI (after building): `./apps/tool-bridge/dist/index.js --list`
  - Target a different server with `TOOL_SERVER_BACKEND_URL=http://host:port`
