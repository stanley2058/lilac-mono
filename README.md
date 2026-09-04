<p align="center">
  <img src="assets/logo.svg" alt="Lilac" width="160">
</p>

# Lilac Monorepo

Lilac contains three related agent products built on shared Bun workspaces:

- **Core** is the Redis-backed, event-driven runtime for Discord and optional GitHub ingress. It owns surface routing, agent execution, output relays, durable workflows, and the internal HTTP tool server.
- **Mini Lilac** is a Redis-free local coding agent. A terminal client talks to an HTTP/SSE server with durable SQLite sessions and workspace history.
- **ACP Controller** is the independent `lilac-acp` CLI for launching and continuing sessions through Agent Client Protocol harnesses. It is not a Core surface or a Mini client.

Architecture and ownership are documented in [`PROJECT.md`](PROJECT.md). Repository rules for coding agents are in [`AGENTS.md`](AGENTS.md).

## Install

This is one Bun workspace. Install once from the repository root:

```sh
bun install
```

## Run

Configure Redis, a model provider, and Discord admission using the self-documenting
[`core-config.example.yaml`](packages/utils/config-templates/core-config.example.yaml), then run:

```sh
bun apps/core/src/runtime/main.ts
```

The container deployment includes Redis:

```sh
docker compose up --build -d
bun run docker:verify
```

Initialize and run Mini Lilac from source:

```sh
bun apps/mini-lilac/src/main.ts server init
bun apps/mini-lilac/src/main.ts server
```

Start its client from the target workspace in another terminal:

```sh
bun apps/mini-lilac/src/main.ts
```

Build and inspect the standalone CLIs:

```sh
bun --cwd apps/tool-bridge run build
./apps/tool-bridge/dist/tools --list

bun --cwd apps/acp-controller run build
./apps/acp-controller/dist/index.js --help

bun --cwd apps/mini-lilac run build
./apps/mini-lilac/dist/main.js --help
```

On Linux, `dist/tools` is a Go launcher backed by a resident Bun worker. Other platforms build a
standalone Bun executable and run the client directly; the resident Unix-socket fast path is
Linux-only.

The Core tool server can also run without the event bus and surfaces for development:

```sh
bun apps/tool-bridge/index.ts
```

## Check

```sh
bun run check              # concurrent local repository gates
bun run ci                 # conservative serial CI sequence
bun run test:core          # Core, Tool Bridge, and shared dependencies
bun run test:mini          # Mini applications and shared dependencies
bun run test:all           # every test, including architecture and lint rules
bun run lint
bun run typecheck
bun run fmt:check
```

## Documentation

- [`PROJECT.md`](PROJECT.md): durable architecture, terminology, ownership, and where-to-change guide
- [`core-config.example.yaml`](packages/utils/config-templates/core-config.example.yaml): current Core configuration reference
- [`docs/core-config-migrations.md`](docs/core-config-migrations.md): manual Core config upgrades
- [`plan/README.md`](plan/README.md): active implementation plans
- [`MIGRATIONS.md`](MIGRATIONS.md): persisted-data, wire, and protocol migrations
- [`docs/docker-deployment.md`](docs/docker-deployment.md): container deployment and diagnostics
- [`docs/claude-code.md`](docs/claude-code.md): Claude Code authentication, tools, continuation, and storage
- [`docs/skill-authoring.md`](docs/skill-authoring.md): skill format, discovery, and authoring guidance
- [`PLUGIN_AUTHORING.md`](PLUGIN_AUTHORING.md): Core tool plugin contract
- [`apps/mini-lilac/README.md`](apps/mini-lilac/README.md): Mini Lilac installation and first run
- [`apps/acp-controller/README.md`](apps/acp-controller/README.md): `lilac-acp` usage

## License

Lilac is licensed under MIT. See [`LICENSE`](LICENSE). Vendored projects under `ref/` retain their upstream license terms and are read-only references unless a task explicitly says otherwise.
