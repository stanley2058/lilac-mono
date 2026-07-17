# Docker Deployment

Lilac runs `tini` as container PID 1 to reap orphaned children and forward signals. Its child is the root entrypoint, which performs startup setup and then replaces itself with Core as the unprivileged `lilac` user. The image does not run systemd, a user manager, or Bubblewrap, and it does not require writable cgroups, user namespaces, privileged mode, or unconfined security profiles. Core and its children write directly to the container's stdout and stderr.

## Start And Verify

Build and smoke-test the image without Redis, Discord, or provider credentials:

```sh
bun run docker:build --tag lilac:dev .
bun run docker:verify-image
```

The image smoke starts a network-disabled container with the normal entrypoint and an inert command. It verifies that `tini` is the root PID 1, reaps an orphan probe, keeps its service child running as `lilac`, and forwards SIGTERM to that child. It also checks direct Docker logs, Bun and the installed `tools` CLI, immutable application and CLI paths, writable `/data`, and the root-only operator token with its hash propagated to the service process.

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

Compose mounts persistent state at `/data` and optional agent configuration and SSH directories under `/home/lilac`. Keep secrets out of the image and source control, restrict deployment environment-file permissions, and recreate the container after rotating credentials:

```sh
docker compose up -d --force-recreate lilac
```

`CONTAINER_UID` is a build argument, not a runtime setting. It must be an available numeric UID from 1000 through 60000. Rebuild after changing it and ensure bind-mounted files are owned by or writable for that UID.

## Diagnostics

```sh
bun run docker:verify-image
bun run docker:verify
docker compose ps
docker compose logs --tail=200 lilac
docker compose exec -T lilac /usr/bin/id
```

The service process and its subprocesses run as `lilac`; `docker compose exec` defaults to root so the operator CLI can read its token. Add `--user lilac` when diagnosing the service user's filesystem access.
