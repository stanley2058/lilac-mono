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
[configuration guide](docs/core-config.md) explains editor hover documentation and completion;
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

### Bus contract tests

Bus integration tests use Redis through the production typed bus. Core tests also use the durable
request coordinator and a temporary SQLite delivery store. Redis must be reachable through `REDIS_URL`
or the default `redis://127.0.0.1:6379`; these tests fail when Redis is unavailable. They run in the
normal workspace test scripts and CI.

Each request producer needs coverage that invokes the real producer and observes its event through
the production bus. A successful `publish` stub does not establish contract compatibility. Stub
external GitHub, Discord, and model calls at their boundaries. Use
`apps/core/tests/helpers/real-core-bus.ts` for isolated Core bus tests, await observable delivery or
commit with a deadline, and close the fixture in cleanup. Restart tests retain and reopen their
SQLite store. Tests must not synchronize with fixed sleeps.

Coverage lives with the subsystem:

| Contract | Tests |
| --- | --- |
| Every catalog event: publish, consume, fetch, reject invalid payloads, quarantine malformed entries | `packages/event-bus/tests/event-contract-redis.test.ts` |
| Redis delivery leases, retries, acknowledgements, recovery, stream retention | `packages/event-bus/tests/redis-streams-bus.test.ts`, `event-delivery.test.ts` |
| Durable request publication, ambiguous outcomes, restart, acceptance and commit races | `apps/core/tests/surface/bridge/request-delivery-real-bus.test.ts` |
| GitHub webhook ingress, review replacement, duplicate delivery and failed publication retries | `apps/core/tests/github/github-webhook-real-bus.test.ts` |
| Adapter events, Discord routing, control requests and output relay | `apps/core/tests/surface/bridge/surface-real-bus.test.ts` |
| Agent prompt queues, steering, follow-up, cancellation, output and failure lifecycle | `apps/core/tests/surface/bridge/bus-agent-runner-redis.test.ts` |
| Native RPC requests, controls, attachment admission, output and reconnect | `apps/core/tests/surface/native/integration.test.ts`, `output-failure.test.ts` |
| Workflow dispatch, restart, cancellation, waits, actions, scheduling and parent/child convergence | `apps/core/tests/workflow/` |
| Heartbeat lifecycle, orchestration controls and attachment output | `apps/core/tests/heartbeat/heartbeat-real-bus.test.ts`, `apps/core/tests/tools/` |

The catalog test checks fixture completeness against the production event catalog. Add a fixture when
adding an event, and add producer/consumer integration coverage when introducing a new bus path.

### Recovery and resilience tests

The ordinary workspace tests also exercise process death, competing consumers, bounded load, and
retained-state upgrades:

- `apps/core/tests/surface/bridge/request-process-crash.test.ts` kills a Bun worker at durable
  request boundaries and recovers through a separate worker with the same Redis and disk state.
- `packages/event-bus/tests/competing-consumers.test.ts` verifies that a replacement consumer fences
  a stale handler after lease takeover.
- `apps/core/tests/surface/bridge/bus-agent-runner-load.test.ts` and
  `packages/event-bus/tests/redis-load.test.ts` exercise queued work, session independence, slow
  consumers, retention, and connection bounds with finite workloads.
- `apps/core/tests/surface/bridge/retained-state-upgrade.test.ts` and the workflow store tests
  exercise supported retained-state upgrades through current recovery code. Documented clean breaks
  remain rejection or non-replay cases.

Run the Docker-dependent cases separately:

```sh
bun run test:resilience
```

This command requires a running Docker daemon and the `redis:7-alpine` image. It creates disposable
Redis containers with AOF persistence and loopback-only ports. It never stops the Redis instance at
`REDIS_URL`. The tests cut real TCP connections, restart Redis with retained data, and boot Core in
child processes with temporary configuration and a local model endpoint. The `.case.ts` suffix keeps
these cases out of default workspace discovery; the explicit command runs them without skipping when
Docker is missing. CI runs this command after its ordinary checks.

The load cases use finite workloads and assert ordering and resource bounds. Recovery retains the
at-least-once semantics for model calls and external effects documented in `MIGRATIONS.md`.

### End-to-end agent scenarios

`apps/core/tests/e2e` boots the real Core runtime in a child process and drives it the way a person
and a model would. Each file starts its own Core with a disposable Redis container, a temporary data
directory, and a scripted model server. Core talks to that server over the real provider wire
protocols: chat completions, OpenAI Responses over SSE, and Responses over WebSocket. Clients are the
production `NativeClient`, wired like the web app (cookie-only socket) or the TUI (bearer header).
Agents reach Level 2 tools through a `tools` command that runs the current tool-bridge client.

```sh
bun run test:e2e
```

A scenario script decides each model step from the conversation Core sent, so a test can assert what
the agent saw (offered tools, tool results, history) and what clients rendered. Route a thread to a
script by putting the tag that `model.script(name, …)` returns in the user's message; the newest tag
in a conversation wins. Use these scenarios for behavior that crosses process or package boundaries.
Keep single-module behavior in ordinary tests.

To debug a failure, keep Core's output with `LILAC_E2E_LOG_DIR=<dir>` and raise its log level with
`LILAC_E2E_LOG_LEVEL=debug`. Failure messages include every model request and reply. A known bug can
land as `test.failing` with a comment that names it; its fix flips the test back. Like the resilience
cases, these need Docker and the `redis:7-alpine` image. CI runs them after the resilience cases.

### S3 blob storage against rustfs

The S3 blob adapter tests in `packages/blob-storage/tests/s3-real-server.test.ts` run against a real
S3-compatible server. They cover conditional creates under concurrent writers, server-side copy,
private ACLs, ListObjectsV2 paging, multipart uploads, and aborted uploads. Without the
`LILAC_BLOB_S3_TEST_*` variables they are skipped. CI runs them against the rustfs image pinned in
[CI](.github/workflows/ci.yml), which matches production.

Start rustfs, create a bucket with a SigV4-signed `PUT`, and run the tests:

```sh
docker run -d --rm --name lilac-rustfs-test -p 127.0.0.1:9000:9000 \
  -e RUSTFS_ACCESS_KEY=lilac-test-access -e RUSTFS_SECRET_KEY=lilac-test-secret-key \
  rustfs/rustfs:1.0.4
curl -fsS http://127.0.0.1:9000/health
export LILAC_BLOB_S3_TEST_ENDPOINT=http://127.0.0.1:9000
export LILAC_BLOB_S3_TEST_BUCKET=lilac-blob-test
export LILAC_BLOB_S3_TEST_ACCESS_KEY_ID=lilac-test-access
export LILAC_BLOB_S3_TEST_SECRET_ACCESS_KEY=lilac-test-secret-key
curl --fail-with-body -sS --aws-sigv4 "aws:amz:us-east-1:s3" \
  --user "$LILAC_BLOB_S3_TEST_ACCESS_KEY_ID:$LILAC_BLOB_S3_TEST_SECRET_ACCESS_KEY" \
  -X PUT "$LILAC_BLOB_S3_TEST_ENDPOINT/$LILAC_BLOB_S3_TEST_BUCKET"
bun run test:s3
docker stop lilac-rustfs-test
```

`bun run test:s3` fails when the variables are unset instead of skipping. The bucket `PUT` is
idempotent. Each test writes under its own random prefix, so reruns need no cleanup.

### Remote filesystem runner

Core runs remote `glob`, `grep`, and `fuzzy_search` through
`@stanley2058/lilac-remote-fs-runner@<version>`, using the version in
`packages/remote-fs-runner/package.json`. Remote hosts fetch that version from npm with `bunx` or
`npx`, so a change to the runner, to the `packages/fs` code it bundles, or to its dependencies
reaches them only under a new version.

`packages/remote-fs-runner/published-fingerprint.json` records the last published version and a
fingerprint of the bundle inputs. `packages/remote-fs-runner/tests/published-fingerprint.test.ts`
fails when those inputs change while the version stays the same. To release a runner change:

1. Bump `version` in `packages/remote-fs-runner/package.json`. The version tests in
   `packages/remote-fs-runner/tests/version.test.ts` and `apps/core/tests/ssh/ssh-exec.test.ts`
   name it too.
2. Run `bun run build:remote-fs` and `bun run test:remote-fs-package`, then publish the package from
   `packages/remote-fs-runner`.
3. Run `bun run remote-fs:fingerprint` and commit the updated record. The script refuses to record
   new inputs for a version that npm already has.

`bun run test:remote-fs-package` packs the runner with `npm pack` and installs the tarball through
`bunx` and `npx` outside the workspace. It needs npm and registry access, and CI runs it after the
ordinary checks. `apps/core/tests/ssh/remote-fs-runner-boundary.test.ts` runs every protocol
operation through the built runner over the SSH test shim and compares the results with the local
filesystem.

Read [MIGRATIONS.md](MIGRATIONS.md) before changing stored data or versioned contracts. Active
implementation plans are indexed in [plan/README.md](plan/README.md).
For extension development, see [plugin authoring](PLUGIN_AUTHORING.md) and
[skill authoring](docs/skill-authoring.md).

## Client wire compatibility

`bun run test:e2e` includes `wire-compat.e2e.ts`. It starts real Core with the scripted
model and the production NativeClient over HTTP/SSE, and checks bootstrap JSON, oRPC
results and subscription events before client processing, plus cache patches and
committed projection rows, against frozen JSON Schemas in
`packages/client-protocol/compat/previous-release`. Docker is required. Payloads stay
in memory and failures report the kind, JSON Pointer and upgrade guidance.

The baseline was seeded from commit `034b1ae8` (protocol 1, cache projection 2).
It includes all exported protocol schemas and every oRPC output, including inline
outputs and subscription yields. Cache envelopes mirror the TypeScript-only types
in `packages/client/src/cache.ts`; update their test schema if those types change.
Zod's JSON Schema export preserves structural constraints, but cannot represent
custom refinements such as replay byte budgets. Existing Zod tests still own those.
The scenario covers tools, pending/answered questions, uploads, subagent replies and
streams, failed turns and rewind. Workflow list replies are covered; creating a
workflow card is left to the workflow tests. This gate checks old-client decoding;
it does not freeze execution semantics or provide a historical payload corpus.

At a release, run `bun run codegen:client-protocol-compat`, review and commit the
snapshot with the release changes, and update the source commit above. Keep the
previous-release snapshot frozen during development. For an intentional breaking
change, first bump the protocol or cache projection version so affected clients
reload or discard old rows, document deployment/rollback in `MIGRATIONS.md`, then
refresh the snapshot. Do not refresh merely to make an incompatible payload pass.

`bun run codegen:client-protocol-compat:check` validates the checked-in schemas and
required payload kinds without comparing them with HEAD. The same integrity test
runs in the normal, non-Docker test suite. Schema differences between releases are
expected; the real payload validation decides compatibility.
