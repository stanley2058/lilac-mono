# Optional computer use

Core can use a desktop through an optional HTTP MCP gateway. The gateway runs in its own container,
controls sibling runner containers through the host Docker socket, and keeps lifecycle metadata in
SQLite. Each Lilac session gets one ephemeral desktop and a persistent Python execution process.
The default Core deployment does not start the gateway or build the runner.

The source is `apps/computer-use-gateway/` and `packages/computer-use-runner/`. The runner uses the
pinned `trycua/xfce-cua` image in its Dockerfile, with CUA driver 0.12.4, Chromium, LibreOffice, and a
1440 by 900 XFCE desktop. The imported Chromium seccomp profile remains required. Runners have 1 GiB
of shared memory, a 4 GiB memory limit, and a 1,024-process limit. They receive neither the Docker
socket nor the gateway bearer secret and use Docker's ordinary bridge rather than Core's network.

## Build and deploy

Build both images from the repository root:

```sh
bun run docker:build:computer-use
```

Set `MCP_BEARER_SECRET` to an operator-generated random secret in your deployment environment. Keep
the value out of shell history and source control. The gateway receives the bare secret; Core's
Authorization header must contain `Bearer ` followed by the same value.

For the existing Core Compose project, explicitly add the optional file and profile:

```sh
docker compose -f compose.yaml -f compose.computer-use.yaml --profile computer-use up -d computer-use-gateway
```

This starts only the gateway. It publishes its MCP endpoint on Docker-host loopback port 8081 and
joins Core's Compose network. Core in that project can reach `http://computer-use-gateway:8080/mcp`.
Host clients use `http://127.0.0.1:8081/mcp`. The optional file can also run as its own Compose project;
then configure the gateway address reachable from your Core installation.

The service mounts `/var/run/docker.sock` and a named `computer-use-data` volume at `/data`. It needs
permission to control the daemon and runs as root in the supplied image. That socket gives the gateway
host-level Docker authority. Deploy one trusted Lilac installation and one gateway process per database
and ownership label. Do not run several replicas against the same database or ownership label.

The runner image must exist on the daemon that the gateway controls. Builds, image pulls, and runtime
containers must use the same target daemon. Rootless or remote Docker requires an operator-adjusted
socket mount and host binding. Published viewer ports belong to the daemon's host, not the gateway.

## Configure Core

Add this server to `DATA_DIR/mcp-config.yaml`, preserving other configured servers:

```yaml
configVersion: 1
servers:
  computer_use:
    allowSubagents: false
    transport: http
    url: http://computer-use-gateway:8080/mcp
    headers:
      Authorization:
        file: /data/secret/computer-use-authorization
```

The referenced file contains the complete `Bearer <secret>` header value. Restrict its permissions to
the Core service user. Existing MCP environment-value sources also work. Reload with Core's `mcp.reload`
operator tool, or restart Core. Discovery exposes `mcp_computer_use_provision`,
`mcp_computer_use_execute`, and `mcp_computer_use_terminate` through the normal tool catalog and profile
policy. The server is available only to the primary agent by default. Setting `allowSubagents: true`
also makes it eligible for subagent profiles that allow its tools. No separate plugin installation or
Core config-version migration is needed.

Core derives `x-lilac-session-hash` from the trusted canonical session ID using SHA-256 over
`lilac:mcp-session:v1`, a NUL separator, and the UTF-8 session ID. The header is reserved. Core strips
configured values and injects its digest only for HTTP `tools/call` requests. Discovery and
initialization omit it. Tool arguments and execution-option context cannot override it. The digest
is a routing key, not authentication. MCP transport session IDs remain separate.

## Gateway settings

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `MCP_BEARER_SECRET` | Required | Bearer secret for all `/mcp` requests, including discovery |
| `BIND_ADDR` | `127.0.0.1` | Docker host IP for published runner ports; accepts IPv4 or IPv6 |
| `RENDERED_HOST` | `http://localhost` | HTTP(S) scheme and hostname, without port, path, credentials, query, or fragment |
| `PORT_RANGE_START` | `17000` | First allowed viewer host port, inclusive |
| `PORT_RANGE_END` | `17031` | Last allowed viewer host port, inclusive |
| `RUNNER_IMAGE` | `lilac-computer:local` | Runner image available to the controlled daemon |
| `DATABASE_PATH` | `/data/computer-use.sqlite` | Gateway-owned SQLite database |
| `SECCOMP_PATH` | `/opt/lilac/seccomp-chromium.json` | Chromium profile readable by the gateway's Docker CLI |
| `GATEWAY_OWNER` | `lilac-computer-use` | Stable ownership label for this gateway's containers |

The supplied Compose file passes the first six settings. Change the Compose environment explicitly
when overriding database, seccomp, or ownership paths. Keep ownership stable across gateway restarts;
changing it leaves old containers outside the new gateway's authority. Stop and remove the old
installation's runners before changing ownership or discarding its database.

Binding and presentation are independent. For example, `BIND_ADDR=0.0.0.0`,
`RENDERED_HOST=https://vnc.example.com`, and port 17003 publish runner port 6901 on all host IPv4
interfaces and return `https://vnc.example.com:17003/vnc.html`. The runner itself serves HTTP and
WebSocket traffic. An HTTPS rendered address assumes an operator-managed TLS proxy or router. The
gateway does not create certificates, configure proxies, or test external reachability. Allow the
allocated port range through the intended firewall or proxy and preserve WebSocket upgrades.

Loopback binding works for a browser on the Docker host. A remote user needs an operator-configured
reachable binding or tunnel. The gateway does not publish raw VNC or arbitrary application ports.

## Agent use

The model-facing tool instructions live in [server.ts](../apps/computer-use-gateway/src/server.ts).
Read them when reviewing or changing the agent's provisioning, execution, or cleanup sequence.

1. Call `provision` and wait for success before executing code. A new runner uses a one-hour idle timeout.
2. Read `generation`, `viewer_url`, and `viewer_password` from the result. Repeated `provision` returns
   the same desktop and credentials with `created: false`. It refreshes expiry and preserves the timeout
   unless `idle_timeout_seconds` is supplied. Accepted timeouts are 1 through 86,400 seconds.
3. Call `execute` with Python code. Discover command names with `cua_tools()` and read an unfamiliar
   command's schema with `cua_tools(name)` before calling it. Inspect the current desktop before acting,
   check each CUA result's `is_error` before dependent actions, and verify results after short sequences. Variables and desktop state survive calls and turns while the same runner
   and Python process remain alive.
4. Call `terminate` when the desktop task is complete. Keep it alive while awaiting user input or
   sharing the viewer for assistance. Repeating `terminate` succeeds.

The execution namespace supports top-level `await` and these helpers:

```python
print(await cua_tools())                 # Available tool names
print(await cua_tools("click"))          # One tool's argument schema
state = await cua("get_desktop_state", session="lilac")
display(state)                            # Emit CUA text and screenshots
answer = 40                              # Available to later execute calls
```

`await cua(name, **arguments)` calls the installed driver's generic tool API. It returns a CUA
`ToolResult` with `text`, `images`, `structured_json`, and `is_error`. Provisioning initializes the
`lilac` driver session with desktop capture enabled. The helpers are available without imports or
client setup. `display(result)` emits its text and images; `display(image_bytes,
mime_type="image/png")` emits raw image bytes. Coordinates use the actual returned screenshot pixels;
there is no implicit scaling. Application launch inherits the desktop user's display and D-Bus setup.

Each execute result includes current viewer metadata as text while the desktop survives, including
Python-error results. Passwords appear only in provision results and stay separate from viewer URLs.
The password is eight random base64url characters because the current VNC authentication mechanism
uses only eight characters. New desktops get new passwords, including when reusing a host port.

Model code runs directly as `cua` inside the runner. There is no second interpreter sandbox or nested
model loop. Python code is limited to 32,000 characters, text to 64 KiB, images to eight and 12 MiB total
base64, and framed output to 16 MiB. The HTTP body limit is 256 KiB. Executions have a 120-second gateway
deadline, separate from idle expiry. Pending Python async tasks are cancelled before completing a call;
applications deliberately launched in the desktop can keep running. A client may impose a shorter
request timeout. Cancellation, disconnection, or uncertain execution destroys the runner before another
call can execute. The gateway never retries code. Core's broader crash recovery remains at-least-once;
GUI effects are not exactly-once.

Manual intervention during agent execution has undefined behavior. There is no human/agent ownership
transfer or pause protocol. The gateway serializes all runner operations per Lilac session and lets
different sessions progress independently. It allows at most 256 pending lifecycle requests. The port
range bounds the number of desktops; capacity exhaustion never evicts another live session.

## Readiness, retention, and recovery

Provisioning verifies the Python runtime, required CUA health checks, an actual desktop screenshot,
and noVNC HTTP response. The startup probe deadline is 45 seconds. A live Docker container or the
upstream noVNC-only healthcheck alone is insufficient. `/health` reports whether gateway startup
reconciliation completed. It does not expose secrets or perform a full probe of every desktop.

Completed provisioning and execution refresh idle expiry. Active operations suppress idle cleanup,
which runs every ten seconds. Viewer connections do not extend retention. Gateway shutdown drains
admitted calls and leaves valid runners alive for reattachment. Retention follows expiry, not turn
boundaries; failures can destroy a desktop within a turn. The optional Compose file allows 180 seconds
for graceful shutdown.

SQLite records lifecycle intent and owns port reservations. Creation commits a reservation before
Docker creation, then records ready state after probes pass. Removal commits terminating intent first
and releases the reservation only after confirming removal. Failed cleanup remains reserved for retry.
Docker port binding is the final availability check; conflicts try another configured port.

On gateway startup, retain only unexpired ready records whose owned live containers, generation,
port binding, and execution-process identity match. Preserve the recorded expiry and credentials.
Remove owned outliers and incomplete, expired, or terminating runners. Missing desktops are not
respawned. Failed Docker inspection or unreadable/unknown SQLite state fails readiness and preserves
unresolved reservations. A lost Python process cannot be represented as continuous state; the agent
must explicitly provision a replacement. Unrelated containers are never adopted or removed.

The database is versioned separately from Core and its file permissions are 0600. Preserve the named
volume across upgrades. It contains VNC credentials, so protect backups too. SQLite holds metadata,
not desktop files or interpreter checkpoints. `terminate` removes the container's writable filesystem
and anonymous volumes. Removing the gateway service alone does not remove its sibling runners.

## Verification

```sh
bun run test:computer-use
bun run docker:build:computer-use
bun run test:computer-use:docker
bun run check
```

The Docker tests create and remove uniquely owned disposable containers. They use loopback viewer
ports 17990–17999 and 18100–18109, plus an automatically allocated gateway port. They require a local
Docker socket at `/var/run/docker.sock`, both built images, and access to published loopback ports.
Ordinary repository checks skip them.

The integration checks cover persistent variables, text/images through Core's MCP conversion, two
sessions, gateway restart, lost runtime cleanup, VNC authentication and WebSocket access, image
dimensions, cancellation without replay, and Chromium starting with its sandbox. Focused tests cover
expiry, capacity, binding conflicts, interrupted lifecycle states, authentication, header isolation,
and discovery compatibility. The tested MCP handshake uses the pinned client's modern discovery probe
and the server SDK's legacy initialization fallback.

## Follow-ups outside this release

- Session-scoped file transfer and temporary SSH tunnels. Define session authorization, paths,
  credentials, expiry, and teardown. A tunnel alone does not isolate sessions sharing Core's network.
- Human/agent coordination, view-only defaults, pause/resume, and ownership handoff or leases.
- MCP resources, subscriptions, or a separate metadata tool. Connection metadata currently uses tool
  results because Core does not expose resource discovery/read operations.
- Dynamic port publication, application-port forwarding, a gateway proxy, or hosted TLS management.
- Durable desktop files/profiles, snapshots, interpreter recovery, automatic replacement, or replay.
- Multiple gateway replicas, several Lilac installations per gateway, and stronger tenant isolation.
- Stronger viewer authentication and password rotation during a desktop's lifetime.
- Mini Lilac integration, other operating systems, and additional execution languages.
