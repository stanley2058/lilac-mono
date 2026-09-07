# Optional computer use

Status: agreed design, implementation not started. Recorded on 2026-09-07.

Add an optional computer-use integration to the monorepo. Core calls an HTTP MCP gateway that
provisions and controls one ephemeral desktop runner per Lilac session. The gateway owns Docker
lifecycle, session routing, port allocation, authentication, and SQLite bookkeeping. Model-written
Python executes directly inside the runner.

This plan records the final decisions from the design discussion. Startup reconciliation retains the
intersection of SQLite records and matching live Docker runners. It does not recreate missing runners
from database records. Only `provision` creates a runner.

## Scope and repository ownership

Keep both components in this repository. Use this implementation layout:

| Location | Responsibility |
| --- | --- |
| `apps/computer-use-gateway/` | Bun/TypeScript service, HTTP MCP boundary, Docker control, SQLite, lifecycle, and gateway image |
| `packages/computer-use-runner/` | Desktop Dockerfile, Chromium seccomp profile, Python execution loop, and runner checks |
| `apps/core/src/mcp/` | Call-scoped Lilac session header on outgoing HTTP MCP tool calls |
| `apps/core/src/plugins/manager.ts` | Bind trusted run context when assembling MCP tools |
| Deployment documentation and optional Compose configuration | Build and operate the two images without enabling computer use by default |

Import the existing runner assets from `/home/stanley/Sandbox/lilac-mcp/lilac-computer` into the runner
package. The monorepo copy becomes the implementation source. Preserve the external source directory.
The plan-writing change does not copy or modify runtime code.

Register new Bun workspaces in the architecture inventory and connect their checks to the root scripts.
The runner may use Bun package scripts to invoke its Python checks; its execution runtime is Python.
Keep the gateway independent of Core's Redis, runtime, and database instances. Follow Core's SQLite and
cleanup conventions without importing Core-owned persistence code into the gateway.

## Architecture

```text
Lilac session A -- HTTP MCP + bearer + session hash --> gateway --> runner A
Lilac session B -- HTTP MCP + bearer + session hash --> gateway --> runner B
                                                               ^
user browser -- configured public address + allocated host port -- noVNC
```

The gateway is a container with access to the host Docker socket and a persistent SQLite volume.
Runners are sibling containers created through that daemon. Docker publishes each runner's noVNC port
on an allocated Docker-host port. Runners receive neither the Docker socket nor the gateway bearer
secret.

Use one gateway process for this first cut. Serialize provisioning, execution, and termination by
Lilac session. Different sessions can proceed independently. Port reservations also require global
coordination through SQLite uniqueness constraints.

Keep the model loop in Lilac. The gateway does not call another model or run a nested agent.

## MCP and session identity

Expose exactly three raw MCP tool names: `provision`, `execute`, and `terminate`. Core already applies
the configured MCP namespace. A server configured as `computer_use` normally produces names such as
`mcp_computer_use_execute`.

Use Streamable HTTP MCP. Tool discovery is independent of runner existence and never provisions a
desktop. Select and test a protocol version supported by Core's pinned MCP client, including its
modern discovery probe and legacy initialization fallback. Use the existing result conventions for
the negotiated version rather than building a second protocol implementation.

Core sends `x-lilac-session-hash` on HTTP MCP tool calls using the trusted execution context's canonical
`sessionId`. Derive a stable, domain-separated digest; never expose the raw session ID or accept a
model-supplied routing identity. Reserve the header so configured headers or tool arguments cannot
override the generated value. This first cut assumes one trusted Lilac installation per gateway.

Core shares an MCP client per configured server. Bind context per invocation and inject the header at
the outgoing HTTP boundary without mutating shared transport headers. Cover overlapping calls,
asynchronous operations, and cancellation. Preserve existing static headers and OAuth behavior.
Initialization and tool discovery have no Lilac session context and omit this header. The gateway
requires it for all three runner tools. Stdio MCP transports remain unchanged.

MCP transport session IDs and Lilac session hashes are separate identities. Use the latter for runner
routing. Keep session-specific information in tool results, not globally shared tool descriptions.

## Tool contracts

### `provision(idle_timeout_seconds?)`

- Create one runner for the calling session when none exists.
- Use a default idle timeout of 3,600 seconds for a new runner.
- If a usable runner already exists, return its metadata with `created: false` and a message such as
  `Runner already exists`. Preserve its desktop, interpreter namespace, port, and password.
- Refresh the idle deadline on repeated provisioning. An explicitly supplied timeout replaces the
  previous timeout; an omitted timeout preserves the existing runner's setting.
- Concurrent provisioning calls for the same session share one creation operation.
- Return success only after readiness checks pass and the ready state is committed to SQLite.
- Return a capacity error when the allowed port range is exhausted. Never evict another live session
  to satisfy provisioning.
- If an existing runner is unusable, reconcile and remove it before explicitly provisioning a
  replacement. Report the new runner as newly created, with a new generation.

Return model-visible metadata as text, with matching `structuredContent` where supported:

```json
{
  "status": "ready",
  "created": false,
  "message": "Runner already exists",
  "generation": "<opaque runner generation>",
  "viewer_url": "https://vnc.example.com:17003/vnc.html",
  "viewer_password": "<runner password>",
  "idle_timeout_seconds": 3600,
  "expires_at": "<UTC timestamp>"
}
```

The example contains placeholders, not credentials. Generation identifies a particular desktop
lifetime. It is informational; this first cut does not require the model to supply a generation token
with each call.

### `execute(code)`

Execute Python in the calling session's provisioned runner. Return bounded text output, MCP image
blocks for emitted screenshots, and execution errors. Append current runner metadata when the runner
still exists so a blocked agent can give the user the viewer URL without another metadata mechanism.
Returning the password from `provision` is sufficient; avoid repeating it in every execution result.

Fail clearly if the runner is absent, expired, terminated, or has lost its execution runtime. Never
silently provision a replacement or apply old code to a fresh desktop. The model must call `provision`
to obtain a replacement.

An execution deadline is distinct from the idle timeout. Cancellation or HTTP disconnection does not
prove the script stopped. Keep the runner unavailable for subsequent execution until the previous
execution has stopped. If stopping it cannot be confirmed, terminate the runner and report lost state.
Never automatically replay code after an uncertain execution outcome. Core currently disables MCP
tool retries; preserve that behavior. Core's broader crash recovery remains at-least-once, so this
feature does not promise exactly-once GUI effects.

### `terminate()`

Remove the calling session's runner, including its writable container filesystem, and release its
port after removal is confirmed. Succeed when the runner is already absent. Serialize termination
against other operations for that session. Record termination intent before changing Docker so a
gateway restart cannot retain a runner whose termination was already accepted.

### Agent-facing usage contract

Tool descriptions and usage documentation must explain:

- Call `provision` before `execute`. Repeated provisioning retrieves existing connection information.
- Desktop state and Python variables persist while the same runner and execution process remain alive.
- Inspect the current computer state before acting and verify the result after short action sequences.
- Retention follows idle expiry, not Lilac turn boundaries. A runner can survive several turns, and
  failures can destroy it within a turn.
- Human intervention during agent execution is unsupported and has undefined behavior. Coordination,
  ownership transfer, and simultaneous human/agent control are outside this first cut.
- Runner files are temporary. Terminate when finished; when handing the viewer URL to a blocked user,
  leave the runner available until explicit termination or idle expiry.

Core's normal session scheduling makes competing agents unlikely. The gateway still serializes calls;
there is no additional multi-agent ownership or lease protocol in scope.

## Runner execution and readiness

Use the existing desktop image as the starting point. The inspected image contains `cua-driver 0.12.4`
and its Python SDK. It starts D-Bus, VNC, and noVNC, but has no script execution service. Pin the image
and driver versions used by the implementation rather than assuming current upstream matches them.

Run model code directly as the desktop user, `cua`, inside a persistent Python execution process. The
container is the execution isolation boundary; do not add an interpreter sandbox or execute model
code in the gateway. The small runner loop owns code submission, CUA access, stdout/error framing, and
image emission. Describe its actual helpers and coordinate conventions in the execution tool.

Prefer Docker exec for the gateway-to-runner control path to avoid adding a public runner API. Verify
the persistent execution and reconnection mechanics in the first implementation step. A live Docker
container alone does not prove the previous Python namespace survived. Retain it after gateway restart
only if the execution runtime can be reattached and verified; otherwise remove it as an outlier.

Preserve these existing runner settings:

- `seccomp-chromium.json` is applied at container creation. Preserve Chromium's sandbox without
  privileged mode or adding `SYS_ADMIN`.
- Shared memory is 1 GiB, as in the working runner command.
- The configured desktop resolution is 1440 by 900. Returned screenshot coordinates must match actual
  capture dimensions; avoid implicit rescaling.
- Launch applications and the execution process with the desktop user's display and D-Bus environment.

CUA already exposes `health_report`. On Linux it reports session, AT-SPI, and X11 capture capabilities.
Inspect required checks rather than accepting any overall value other than `failed`: `degraded` may
still mean a capability required by the tool is unavailable.

Provisioning readiness requires the execution loop to respond, the required CUA capability checks to
pass, an actual desktop screenshot to succeed, and noVNC to respond. Use the same execution path as
normal tool calls. Docker process state and the existing noVNC-only image healthcheck are insufficient.
The inspected `doctor --json` returned `ok: true` even with desktop startup bypassed and X11/AT-SPI
warnings, so its top-level result is not a readiness gate.

Serialize runtime probes that touch CUA with execution. Bound startup and execution time, output size,
and pending requests. The port range bounds runner count. Keep ordinary checks inexpensive; an
unhealthy runner produces a failure and explicit reprovisioning, not an automatic desktop restart.

## Authentication, networking, and viewer metadata

The gateway accepts a pre-shared secret through container environment and verifies
`Authorization: Bearer ...` on its MCP endpoint. Core supplies the secret through existing MCP header
configuration. Authenticate discovery as well as tool execution. The session hash is a routing key,
not an authentication credential.

Generate one cryptographically random VNC password per new runner. Pass it to that runner as `VNC_PW`,
store it with its SQLite record, and return it through `provision`. Repeated provisioning returns the
same password; a replacement runner receives a new password even if it reuses the port. This replaces
the earlier shared gateway-configured VNC password proposal.

The current TigerVNC `VncAuth` path only uses the first eight password characters. Generate eight
random printable characters supported by that path. Keep the password separate from the viewer URL.
The database must be readable only by the service owner. Operational logs must exclude bearer and VNC
secrets; the VNC password in the intended tool result is part of the authorized viewer handoff.

Separate binding from presentation:

| Setting | Contract |
| --- | --- |
| `BIND_ADDR` | Docker host address used for runner port publication; for example, `0.0.0.0` for all IPv4 interfaces or `127.0.0.1` for loopback |
| Allowed port range | Gateway-owned inclusive host port range allocated at runner creation |
| `RENDERED_HOST` | Operator-supplied scheme and hostname used only to construct viewer URLs |

For example, `BIND_ADDR=0.0.0.0`, `RENDERED_HOST=https://vnc.example.com`, and allocated port `17003`
publish host port `17003` to runner port `6901` and render
`https://vnc.example.com:17003/vnc.html`. The gateway does not infer external topology or configure TLS,
routers, or reverse proxies. Parse the rendered host as a URL origin and set its allocated port and
`/vnc.html` path. Support hostname and IP-literal origins, including bracketed IPv6.

Publish only the required runner viewer port. No gateway port range, dynamic forwarding service, or
arbitrary application-port registration is needed. Docker exec avoids requiring a shared control
network; ordinary container networking still needs to support desktop internet access. Keep runners
off Core's private service network and never distribute gateway authority to them.

MCP resources can be dynamic, but Core currently does not expose resource discovery/read operations.
Use tool-result metadata for viewer discovery. A new metadata tool, resource subscriptions, and Core
resource integration are outside scope.

## SQLite and lifecycle reconciliation

Persist gateway bookkeeping in its own versioned SQLite database on a mounted volume. Use strict
boundary decoding and repository Result conventions. The minimal record contains the session hash,
runner generation, Docker container ID when known, reserved port, lifecycle state, VNC password, idle
timeout, and expiry. Enforce one live reservation per session and one reservation per host port.
Label Docker containers with gateway ownership and runner identity so cleanup cannot target unrelated
containers. Do not put credentials in labels.

Idle expiry begins or refreshes after provisioning and completed execution. Active execution suspends
idle cleanup. Preserve the recorded timeout and deadline across gateway restarts. Human viewer
connections do not extend retention in this first cut.

SQLite records lifecycle intent; Docker records whether the matching runtime actually exists. On
gateway startup, stop admission and reconcile their intersection:

| SQLite and Docker evidence | Action |
| --- | --- |
| Unexpired ready record and matching live container, identity, binding, and usable execution runtime | Retain; preserve generation, password, and recorded expiry |
| Active database record without its matching usable runner | Invalidate the record, remove any unusable owned container, and require explicit `provision` |
| Owned Docker container without a matching valid ready record | Remove the container |
| Expired, provisioning, or terminating record with a remaining owned container | Finish cleanup; do not adopt or respawn it |
| Partial reservation with no container | Clear it after establishing Docker state |
| Docker inspection unavailable, database unreadable, or reconciliation inconclusive | Fail readiness and retain unresolved ownership/reservations |

This is cleanup to a minimal agreed set, not restoration of desktops from database intent. Startup
never spawns runners. A missing interpreter or desktop cannot be recovered from SQLite. Any new
desktop comes from a later `provision` call with `created: true` and a new generation.

Creation commits the provisioning reservation before Docker creation and commits ready state only
after readiness. Termination and expiry commit terminating intent before Docker removal. A port stays
reserved until removal is confirmed. SQLite transactions do not make Docker operations atomic; these
intent states and startup reconciliation handle crashes between operations without an execution journal
or replay mechanism.

Docker binding is the final availability check because unrelated host processes may occupy a port.
Handle a rejected binding without leaking a reservation or killing the unrelated process. Try another
allowed port for new provisioning, and return capacity failure if none can be allocated. Complete
reconciliation before accepting calls. Existing cleanup retries belong to the same lifecycle service;
do not add a separate durable queue or recovery subsystem.

## Implementation checklist

Implementation has not started. Follow this order and retain the scope above.

- [ ] Import the runner assets and establish the Python execution loop. Demonstrate two calls sharing
  variables and desktop state, text/image output, readiness, cancellation, and the gateway reconnect
  behavior. Completion: the pinned runner can support the execution contract without controller-side
  model-code execution.
- [ ] Add the gateway workspace, strict configuration and boundary codecs, Docker adapter, and SQLite
  lifecycle store. Completion: port ownership, creation, expiry, removal, and startup intersection
  reconciliation pass focused tests, including interrupted operations.
- [ ] Expose authenticated HTTP MCP `provision`, `execute`, and `terminate`. Completion: idempotent
  lifecycle behavior, output projection, viewer metadata, and per-session serialization work through
  the MCP transport.
- [ ] Add Core's call-scoped session header and bind trusted context during MCP tool assembly.
  Completion: concurrent sessions use one shared MCP client without header leakage, while discovery,
  authentication, and stdio behavior remain compatible.
- [ ] Add optional monorepo image builds and deployment instructions. Completion: an operator can
  deploy the gateway with its SQLite volume and Docker socket, configure Core, and provision a runner
  without changing default Core deployment behavior.
- [ ] Run focused tests, changed-workspace typechecks, architecture checks, and the root `bun run check`
  against the final implementation. Completion: all required checks pass and the end-to-end cases
  below have recorded results. Update `PROJECT.md`, `MIGRATIONS.md`, and deployment documentation with
  shipped facts before retiring this plan under the plan directory's normal policy.

New contracts, dependencies, and configuration beyond the described integration remain subject to
`AGENTS.md`. Exact operational limits other than the agreed one-hour idle default, and internal IPC
framing, remain implementation details to document and verify. Keep required deployment settings small;
do not turn every internal limit into a new operator-facing option.

## Acceptance and verification

- Two Lilac sessions get distinct runners, credentials, and ports. Interleaved calls through one MCP
  client retain the correct session header and output ownership.
- Concurrent first provisioning for one session creates one runner. Repeated provisioning preserves
  its generation, password, desktop, and namespace, returns `created: false`, and refreshes expiry.
- Discovery requires bearer authentication but no session header and creates no runner. Missing or
  invalid bearer/session values cannot execute or provision a runner.
- `execute` before provisioning or after state loss fails without allocating a replacement. Code is
  not replayed after cancellation, disconnect, timeout, or uncertain completion.
- A hung script cannot hold a runner indefinitely or overlap a later execution. Termination removes
  the container and filesystem; repeating termination succeeds.
- Port exhaustion and host binding conflicts fail without duplicate ownership or leaked reservations.
  Reusing a port for a new runner does not reuse its password.
- `BIND_ADDR` changes Docker bindings independently of `RENDERED_HOST`. URL rendering preserves the
  supplied scheme and hostname and uses the allocated port. noVNC HTTP and WebSocket access work in a
  local deployment; external proxy correctness remains operator-owned.
- Startup exercises every reconciliation row, including crashes before/after Docker creation, ready
  commit, termination intent, removal, and reservation release. Docker unavailability never becomes an
  empty-list cleanup decision. Unrelated containers remain untouched.
- A surviving valid runner retains its expiry across gateway restart. Expired or incomplete runners
  are removed, and missing runners are not respawned. A lost execution namespace is never represented
  as uninterrupted continuity.
- Probe failures distinguish a running container or working noVNC page from a usable execution runtime
  and screenshot path. Chromium starts with its sandbox under the preserved seccomp profile.
- Screenshots reach the model as images through Core's existing MCP conversion, with correct
  dimensions. Viewer metadata reaches the model as text, including after an execution failure when
  the desktop remains available.
- Tests synchronize on observable state or controlled clocks, not fixed waits. Normal operational
  logs contain neither script bodies/screenshots nor bearer/VNC secrets.

## Follow-ups outside current scope

- Session-scoped file transfer between Core and the runner. Explore temporary SSH tunnels with
  credentials and access restricted to the originating Lilac session. A tunnel alone does not provide
  session isolation because Core sessions do not inherently have separate network namespaces. Define
  authorization, path access, credential expiry, and teardown in that follow-up. This first cut has no
  shared workspace mount, attachment import, or general document export path.
- Human/agent coordination, view-only defaults, pause/resume, handoff leases, and concurrent ownership
  by several agents. Manual changes during agent execution remain undefined behavior.
- MCP resource discovery, dynamic resources/subscriptions, or an independent runner metadata tool.
- Dynamic publication after runner creation, forwarding arbitrary application ports, a gateway port
  proxy, and hosted TLS or reverse-proxy management.
- Durable desktop files, browser profiles, snapshots, interpreter recovery, and automatic replacement
  runners. SQLite stores lifecycle metadata only. Exactly-once GUI execution and replay journals are
  outside scope.
- Multiple gateway replicas, distributed coordination, multiple Lilac installations sharing one
  gateway, and stronger multi-tenant isolation or network policy management.
- Stronger viewer authentication beyond the existing VNC password mechanism, credential rotation
  during a runner lifetime, and separate end-user identities. Random passwords per runner are already
  included in the current scope.
- Mini Lilac integration, additional operating systems, and additional execution languages.

## Research references

- [OpenAI computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use):
  script execution with text/images and separate conversation/runtime state.
- [CUA repository](https://github.com/trycua/cua) and
  [driver health-report documentation](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/mcp-tools.mdx#health_report).
  Current upstream is reference material; verify behavior against the pinned runner version.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
  [tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), and
  [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/) and
  [bridge networking](https://docs.docker.com/engine/network/drivers/bridge/).
- [TigerVNC password limits](https://tigervnc.org/doc/vncpasswd.html).
- Existing repository integration points: `apps/core/src/mcp/registry.ts`,
  `apps/core/src/mcp/modern-result-validation.ts`, `apps/core/src/mcp/binary-result-materializer.ts`,
  `apps/core/src/plugins/manager.ts`, and `packages/plugin-runtime/types.ts`.
