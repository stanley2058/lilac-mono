# Lilac Monorepo

<p align="center">
  <strong>Bun monorepo for a Redis-backed AI agent runtime with Discord ingress, optional GitHub ingress, layered tools, and durable workflow resume.</strong>
</p>

<p align="center">
  <a href="./PROJECT.md">Architecture</a>
  ·
  <a href="./AGENTS.md">Agent Guide</a>
  ·
  <a href="./apps/acp-controller/README.md">ACP CLI</a>
  ·
  <a href="https://github.com/stanley2058/lilac-mono">Upstream</a>
</p>

Lilac is an event-driven runtime for request-scoped LLM work. It keeps surface ingress, routing, agent execution, tool access, and workflow resume in one system instead of splitting them across separate bots, scripts, and operator glue.

This repository is a maintained fork of [`stanley2058/lilac-mono`](https://github.com/stanley2058/lilac-mono). The fork context matters, but the main thing this repo provides is the runtime, toolchain, and operator workflows described below.

## What This Repo Does

- Receives work from **Discord** and optional **GitHub issue/PR webhook** flows.
- Routes requests through a **typed Redis Streams event bus**.
- Runs agent turns with **local tools**, **HTTP tool-server callables**, and **on-disk skills**.
- Sends results back to Discord and GitHub surfaces.
- Supports **pause/resume**, scheduled wakeups, and long-lived workflows.
- Ships operator-facing tooling through the **`tools` bridge** and **`lilac-acp` controller**.

## Core Capabilities

### 1. Runtime-first architecture

The center of gravity is `apps/core/`. That runtime wires together Redis, the event bus, Discord ingress, GitHub webhook ingress, routing, agent execution, tool serving, workflow services, transcript/search stores, and heartbeat-driven background prompting.

### 2. Typed event model

`packages/event-bus/` defines the canonical event contract and Redis Streams transport used across ingress, routing, execution, and output delivery.

### 3. Layered tools and skills

The runtime exposes three capability layers:

- **Local tools** such as shell, file reads, search, and patching.
- **Tool-server namespaces** for web, workflow, surface, attachments, onboarding, generation, summarize, SSH, and related runtime operations.
- **On-disk skills** that can be discovered and loaded into runs when needed.

### 4. Durable workflows

The repo includes workflow services for wait-for-reply, send-and-wait, scheduling, cancellation, and resume. This is built into the runtime rather than bolted on as a separate job system.

### 5. Operator tooling

Two supporting apps matter operationally:

- `apps/tool-bridge/`: builds the `tools` bridge and standalone tool-server entrypoints.
- `apps/acp-controller/`: builds `lilac-acp`, a CLI for ACP harness discovery, session inspection, and detached prompt execution.

## How It Works

The runtime flow is:

1. Discord adapter events enter through the surface bridge.
2. The router turns Discord events into request messages.
3. GitHub webhook handlers can publish request messages directly.
4. The agent runner executes with models, tools, and skills.
5. Output is delivered back to Discord or GitHub through the surface layer.
6. Workflow services can resume work later when time or user input arrives.

For the full system mental model, terminology, and file-level architecture, see [`PROJECT.md`](./PROJECT.md).

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/core/` | Main runtime process and supporting subsystems. |
| `apps/tool-bridge/` | `tools` bridge CLI and standalone tool-server entrypoints. |
| `apps/acp-controller/` | `lilac-acp` CLI for ACP harness operations. |
| `packages/event-bus/` | Typed event spec and Redis Streams bus implementation. |
| `packages/agent/` | AI SDK-based agent execution, streaming, and turn control. |
| `packages/utils/` | Runtime config, model/provider resolution, prompts, and skill discovery. |
| `packages/plugin-runtime/` | Shared plugin contract and runtime support. |
| `data/` | Local runtime data and seeded config. |
| `ref/` | Vendored/reference repos; treat as read-only. |

## Verified Commands

### Workspace validation

```bash
bun install
bun test
bun run lint
bun run typecheck
bun run fmt:check
```

### Build commands

```bash
cd apps/tool-bridge && bun run build
cd apps/acp-controller && bun run build
```

Remote runner build used by the core package:

```bash
cd apps/core && bun run build:remote-runner
```

### ACP controller workflow

```bash
cd apps/acp-controller
bun run build
./dist/index.js --help
./dist/index.js harnesses list
./dist/index.js sessions list --directory /path/to/repo --search "failing tests"
```

### Containerized operator stack

```bash
docker compose up --build
```

This container path is real, but it is an operator workflow rather than a zero-config quick start. The runtime expects Redis plus runtime configuration such as surface credentials.

## Operational Prerequisites

- The runtime expects **Redis** and reads seeded runtime config from `data/core-config.yaml`.
- Discord uses `DISCORD_TOKEN` by default unless `surface.discord.tokenEnv` is changed in `core-config.yaml`.
- GitHub webhook ingress requires `GITHUB_WEBHOOK_SECRET`.
- GitHub auth can be configured through user or app credentials, depending on the workflow.

## Further Reading

- [`PROJECT.md`](./PROJECT.md): architecture, terminology, and runtime flow
- [`AGENTS.md`](./AGENTS.md): repo-specific coding and validation rules
- [`apps/acp-controller/README.md`](./apps/acp-controller/README.md): ACP controller usage details

## License

This repository is licensed under MIT. See [`LICENSE`](./LICENSE) for details.

The `ref/` directory contains vendored or reference material that keeps its own upstream license terms.
