<p align="center">
  <img src="assets/logo.svg" alt="Lilac" width="160">
</p>

# Lilac Monorepo

Lilac Core is the Redis-backed, event-driven runtime for Discord and optional GitHub ingress. It owns surface routing, agent execution, output relays, durable workflows, and the internal HTTP tool server.

Architecture and ownership are documented in [`PROJECT.md`](PROJECT.md). Repository rules for coding agents are in [`AGENTS.md`](AGENTS.md).

## Install

Install Docker with Compose 2.30 or newer, open a terminal in the directory where you want to keep
Lilac, and run:

```sh
curl -fsSL https://raw.githubusercontent.com/stanley2058/lilac-mono/main/install.sh | bash
```

The installer checks your machine, downloads a standalone CLI, and guides you through model-provider
authentication and Discord setup. Optional integrations can wait. Review the generated configuration
before it pulls the published images and starts Lilac with Redis.

See the [installation guide](docs/installation.md) for supported systems, configuration updates,
reinstalls, and release overrides. Published images run Core as UID `1000`.

For source development, this is one Bun workspace. Install once from the repository root:

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

Build and inspect the standalone tool CLI:

```sh
bun --cwd apps/tool-bridge run build
./apps/tool-bridge/dist/tools --list
```

On Linux, `dist/tools` is a Go launcher backed by a resident Bun worker. Other platforms build a
standalone Bun executable and run the client directly; the resident Unix-socket fast path is
Linux-only.
When installing the built CLI elsewhere, keep `tools`, `tools-worker`, `tools-build-id`, and
`tools-build-info.json` together in the same directory.

The Core tool server can also run without the event bus and surfaces for development:

```sh
bun apps/tool-bridge/index.ts
```

## Check

```sh
bun run check              # concurrent local repository gates
bun run ci                 # conservative serial CI sequence
bun run test:core          # Core, Tool Bridge, and shared dependencies
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
- [`docs/installation.md`](docs/installation.md): guided installation, updates, and scheduled releases
- [`docs/claude-code.md`](docs/claude-code.md): Claude Code authentication, tools, continuation, and storage
- [`docs/skill-authoring.md`](docs/skill-authoring.md): skill format, discovery, and authoring guidance
- [`PLUGIN_AUTHORING.md`](PLUGIN_AUTHORING.md): Core tool plugin contract

## License

Lilac is licensed under MIT. See [`LICENSE`](LICENSE). Vendored projects under `ref/` retain their upstream license terms and are read-only references unless a task explicitly says otherwise.
