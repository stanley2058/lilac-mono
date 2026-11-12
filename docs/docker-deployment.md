# Docker Deployment

For a guided installation using published images, see [the installation guide](installation.md).
The commands below describe source builds and manual container operation.

The Core image includes the native web app. To enable it in the source Compose deployment, follow
[native setup](native-surface.md), using `surface.native.host: 0.0.0.0` inside the container and
`publicUrl: http://localhost:8789` for local access. Compose publishes port 8789 on host loopback only.
Pass the selected provider's credential environment variables through the deployment environment.
The native surface still requires explicit configuration on existing installations; publishing the
port does not enable it or bypass authentication. Use HTTPS at a reverse proxy for remote access.

Lilac runs `tini` as container PID 1 to reap orphaned children and forward signals. Its child is the root entrypoint, which performs startup setup and then replaces itself with Core as the unprivileged `lilac` user. The image does not run systemd, a user manager, or Bubblewrap, and it does not require writable cgroups, user namespaces, privileged mode, or unconfined security profiles. Core and its children write directly to the container's stdout and stderr.

## Start And Verify

Build and smoke-test the image without Redis, Discord, or provider credentials:

```sh
bun run docker:build --tag lilac:dev .
bun run docker:verify-image
```

The image smoke starts a network-disabled container with the normal entrypoint and an inert command. It verifies that `tini` is the root PID 1, reaps an orphan probe, keeps its service child running as `lilac`, and forwards SIGTERM to that child. It also checks direct Docker logs, Bun and the installed `tools` CLI, immutable application and CLI paths, writable `/data`, and the root-only operator token with its hash propagated to the service process.

Verify an installer-written deployment against a built image, with Docker Compose and Bun installed:

```sh
bun run docker:verify-installation lilac:dev
```

This check writes a temporary installation through the real installer, starts Core and Redis, and
checks health, local authentication, operator tool access, and a completed native HTTP RPC request.
A local fake OpenAI-compatible server supplies the streamed reply. No provider account or Discord
credentials are needed. The check removes its Compose containers, volumes, and temporary files on exit.
The image must use the installer's standard UID 1000. CI runs this check against `lilac:ci`.

Start the Compose deployment and verify operator access against the running Core service:

```sh
docker compose up -d --build
bun run docker:verify
docker compose ps
docker compose logs -f lilac
```

`bun run docker:verify` runs `tools --operator --list` inside the container. This checks that the root CLI can load the generated token and that Core received the matching hash. Compose readiness uses Core's `/readyz` endpoint. The generic `mem_limit` and `pids_limit` settings bound the whole container and can be adjusted with `LILAC_CONTAINER_MEMORY_LIMIT` and `LILAC_CONTAINER_PIDS_LIMIT`.

## Operator Token

The root entrypoint creates a fresh random operator token each time the container starts. It stores the token at `/run/lilac/operator-token` as `root:root` mode `0600`, exports only its SHA-256 hash to Core, and then replaces itself with Core under the `lilac` UID and GID. The token is therefore available to explicit root operator commands but is not readable by Core, agents, or other `lilac` processes.

Use the installed root-owned CLI for operator calls:

```sh
docker compose exec -T lilac /usr/local/bin/tools --operator --list
docker compose exec -T lilac /usr/local/bin/tools --operator workflow.run.list --state=running
```

Use the absolute path so root never resolves an agent-installed executable from `/data/bin`. Running with `--user lilac` intentionally cannot load the operator token. The application tree, CLI bundle, and `/usr/local/bin/bun` are root-owned and not writable by `lilac`.

External plugins are trusted in-process Core code loaded from `/data/plugins`. The operator token is not a hostile-agent boundary if an agent can install or modify those plugins; use this topology only with trusted agents or separately restrict plugin management.

## Storage And UID

Compose mounts persistent state at `/data` and optional agent configuration and SSH directories under `/home/lilac`. Configured MCP servers live in `/data/mcp-config.yaml`; MCP OAuth credentials persist under `/data/secret/mcp-oauth` and are deliberately retained when a server definition is removed. Keep secrets out of the image and source control, restrict deployment environment-file permissions, and recreate the container after rotating credentials:

```sh
docker compose up -d --force-recreate lilac
```

`CONTAINER_UID` is a build argument, not a runtime setting. It must be an available numeric UID from 1000 through 60000. Rebuild after changing it and ensure bind-mounted files are owned by or writable for that UID.

Filesystem-tool denylists and trusted Bash's direct static check reduce accidental reads of `/data/secret`; they are not isolation from trusted same-user execution. Core, trusted Bash, plugins, and MCP stdio children share the `lilac` UID and can access service-readable credentials. Use separate containers, users, or another OS security boundary when agent-executed code must not be able to read them.

## Claude Code Authentication And Storage

See the [shared Claude Code provider reference](claude-code.md) for authentication ownership,
executable resolution, native continuation, retention, and same-user security constraints.

Core's image includes the Claude Agent SDK dependency tree and can use its bundled executable when no
external `claude` executable is on `PATH`. Authentication alone does not select this provider. First
follow the [Core model-selection setup](claude-code.md#core-model-selection), then provide one or both
of these operator-owned authentication inputs; the stock `compose.yaml` provides neither:

- Pass `CLAUDE_CODE_OAUTH_TOKEN` into the Core container.
- Mount an existing authenticated Claude config directory and point `CLAUDE_CONFIG_DIR` at it.

For restart-safe native continuation, set `CLAUDE_CONFIG_DIR` to a writable persistent path. Using
`/data/claude` reuses Compose's existing `/data` bind mount; alternatively mount a dedicated host
directory. The default `~/.claude` is not part of the stock persistent mounts.

## Diagnostics

```sh
bun run docker:verify-image
bun run docker:verify
docker compose ps
docker compose logs --tail=200 lilac
docker compose exec -T lilac /usr/bin/id
```

The service process and its subprocesses run as `lilac`; `docker compose exec` defaults to root so the operator CLI can read its token. Add `--user lilac` when diagnosing the service user's filesystem access.

## Optional computer use

The desktop gateway and runner have separate image builds and an opt-in Compose file. See
[computer-use deployment](computer-use.md). The standard Compose stack does not enable them.

## Config editor schemas

Core publishes the schemas bundled with its build to `DATA_DIR/.schemas/` on startup, before
loading configuration. Upgrades and rollbacks replace changed schema files atomically. Unchanged
files retain their modification times. These files are generated and owned by Core; do not edit them.

New configurations include YAML Language Server comments. Add these once to existing files:

```yaml
# In core-config.yaml:
# yaml-language-server: $schema=./.schemas/core-config.schema.json
```

```yaml
# In mcp-config.yaml:
# yaml-language-server: $schema=./.schemas/mcp-config.schema.json
```

Paths resolve relative to the YAML file. The editor's language server must be able to read both the
configuration and `.schemas` directory, for example through the host's mounted data directory or a
remote editor session. If diagnostics stay stale after an upgrade, restart the YAML language server.
Copying a config elsewhere also requires copying its `.schemas` directory or updating the reference.

Schemas provide structural validation and completion. Runtime validation still checks custom
constraints, including normalized unit values and cross-field relationships. Core V1 remains the
default when `configVersion` is omitted. Schema publication does not modify existing configuration.

When changing config validators, run `bun run codegen:config-schemas` and commit the generated files.
Repository checks detect stale schemas, and the container build regenerates them from its source.
