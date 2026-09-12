# Development

This guide covers running and changing Lilac from a source checkout. For installation with published
images, use the [installation guide](docs/installation.md).

Read [PROJECT.md](PROJECT.md) for architecture and workspace ownership, and [AGENTS.md](AGENTS.md) for
repository rules. The workspace packages live in `apps/*` and `packages/*`. Run the commands below from
the repository root unless stated otherwise.

## Set up the workspace

Use the Bun version pinned in [package.json](package.json), then install dependencies once:

```sh
bun install --frozen-lockfile
```

The full checks also use Node.js, Python 3, `rg`, and `fd`. The Node.js version must support
`--experimental-strip-types`. Building the Linux tool CLI requires Go. Redis-backed integration tests
need a running Redis server and `REDIS_URL`; [CI](.github/workflows/ci.yml) uses Redis 7.

## Run Core from source

Core needs a reachable Redis server, model-provider authentication, and Discord configuration.
Use [.env.example](.env.example) as the reference for environment-variable names. Set `REDIS_URL`,
`DISCORD_TOKEN`, and the credentials for the providers selected in your config, either in the process
environment or a root `.env` file. Leave unused optional variables unset.

Core stores configuration and state in `DATA_DIR`, which defaults to the repository's `data`
directory. Prepare the config without replacing an existing file:

```sh
mkdir -p data
cp -n packages/utils/config-templates/core-config.example.yaml data/core-config.yaml
```

If you set `DATA_DIR`, put `core-config.yaml` in that directory instead. Edit the model selections and
Discord channel/server allowlists before starting Core. The
[config reference](packages/utils/config-templates/core-config.example.yaml) explains the fields;
[config migrations](docs/core-config-migrations.md) documents version changes.

Start the runtime:

```sh
bun apps/core/src/runtime/main.ts
```

The repository's Compose Redis service has no published host port. When running Core on the host,
`REDIS_URL` must point to a Redis endpoint reachable from the host.

## Build and run the containers

Build the Core image and smoke-test it without Redis, Discord, or provider credentials:

```sh
bun run docker:build --tag lilac:dev .
bun run docker:verify-image
```

The repository's [compose.yaml](compose.yaml) builds Core from source and includes Redis. Configure
the `data/core-config.yaml` bind mount and pass the required environment variables into the service.
Compose only forwards variables declared in its service configuration; a provider key in your host
environment or root `.env` file alone does not put it in the container.

```sh
bun run docker:compose:build
docker compose up -d
bun run docker:verify
docker compose ps
docker compose logs -f lilac
```

The build wrappers attach source build metadata. `bun run docker:verify` runs the operator tool CLI
inside the running Core container. See [Docker deployment](docs/docker-deployment.md) for storage,
UID settings, operator access, and diagnostics. The optional desktop gateway and runner are described
in [computer-use deployment](docs/computer-use.md).

## Build the tool CLI

The `tools` executable calls Core's tool server. With Core or the standalone tool server running:

```sh
bun --cwd apps/tool-bridge run build
./apps/tool-bridge/dist/tools --list
```

On Linux, `dist/tools` is a Go launcher backed by a resident Bun worker. Other platforms build a
standalone Bun executable that runs the client directly. The resident Unix-socket path is Linux-only.
When copying the build elsewhere, keep `tools`, `tools-worker`, `tools-build-id`, and
`tools-build-info.json` in the same directory.

The client defaults to `http://localhost:8080`. Set `TOOL_SERVER_BACKEND_URL` when connecting elsewhere.
For operator calls in the Core container, use the commands in
[Docker deployment](docs/docker-deployment.md#operator-token).

For tool-server development without the event bus or surfaces, run this entry point instead of Core:

```sh
bun apps/tool-bridge/index.ts
```

It uses the same `DATA_DIR` and starts the tool server on `LL_TOOL_SERVER_PORT`, defaulting to `8080`.

## Work on the installer

The interactive setup CLI lives in `apps/installer`. Run its focused checks and build a standalone
binary with the root scripts:

```sh
bun run test:installer
bun run typecheck:installer
bun run build:installer
```

The output is `apps/installer/dist/lilac-<platform>-<architecture>`. For example, on Linux x64:

```sh
./apps/installer/dist/lilac-linux-x64 --help
./apps/installer/dist/lilac-linux-x64 --version
```

`build:installer --target` accepts `linux-x64`, `linux-arm64`, `darwin-x64`, or `darwin-arm64`.
`--outdir` selects the output directory. Compiled binaries include Bun and disable automatic loading
of the invoking directory's `.env`, `bunfig.toml`, `tsconfig.json`, and `package.json` files.

See [installation and release operations](docs/installation.md) for the setup flow, image and release
overrides, and scheduled publication. Run interactive setup from the directory you intend to use for
the installation; that directory is its default storage location.

## Run checks

Use the root scripts for repository checks:

```sh
bun run check              # concurrent repository gates
bun run ci                 # conservative serial CI sequence
bun run test:core          # Core, Tool Bridge, and shared dependencies
bun run test:all           # all tests, including architecture and lint rules
bun run lint
bun run typecheck
bun run fmt:check
```

Use focused workspace tests and typechecks while iterating. Run `bun run check` against the final
changes before every commit. Architecture-controlled changes also need the checks and registrations
described in [the architecture gate guide](scripts/architecture/README.md).

Read [MIGRATIONS.md](MIGRATIONS.md) before changing stored data or versioned contracts. Active
implementation plans are indexed in [plan/README.md](plan/README.md).
For extension development, see [plugin authoring](PLUGIN_AUTHORING.md) and
[skill authoring](docs/skill-authoring.md).
