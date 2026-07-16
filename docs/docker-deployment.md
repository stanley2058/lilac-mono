# Docker Deployment

Lilac's supported container topology runs systemd as container PID 1. Systemd starts a persistent user manager for the first-class `lilac` user, and that manager creates the transient Bubblewrap units used by workflows.

## Host Contract

- Linux Docker server 28 or newer. The client version alone is not sufficient.
- A unified cgroup v2 host exposing the memory and PID controllers.
- Unprivileged user namespaces enabled: `kernel.unprivileged_userns_clone=1` when that setting exists, and `user.max_user_namespaces` greater than zero.
- On Ubuntu hosts that expose it, `kernel.apparmor_restrict_unprivileged_userns=0`. The default value of `1` blocks Bubblewrap even when the container uses `apparmor=unconfined`.
- Docker's private cgroup namespace with `writable-cgroups=true`.
- `seccomp=unconfined` and `apparmor=unconfined` for nested namespace operations, plus `systempaths=unconfined` for the workflow's private `/proc` mount.
- The `/run`, `/run/lock`, and `/tmp` tmpfs mounts and systemd stop signal in `compose.yaml`.
- Enough headroom for the configured container memory and PID limits.

Do not add `privileged: true`, use the host cgroup namespace, or bind-mount `/sys/fs/cgroup`. Docker 28+ supplies a writable view of only the container's private cgroup hierarchy.

Ubuntu hosts can persist the required namespace settings with:

```sh
printf '%s\n' \
  'kernel.unprivileged_userns_clone = 1' \
  'kernel.apparmor_restrict_unprivileged_userns = 0' \
  | sudo tee /etc/sysctl.d/99-lilac-userns.conf >/dev/null
sudo sysctl --system
```

Disabling `kernel.apparmor_restrict_unprivileged_userns` permits unprivileged user namespaces host-wide. Treat this as part of the host security model: keep the host patched, limit shell access, and dedicate the host to trusted workloads when practical.

The runtime verifies seven dependency groups:

1. Systemd is container PID 1 and the `lilac` user manager is reachable.
2. Trusted Bubblewrap is installed.
3. `systemd-run` is installed for transient user units.
4. `systemctl` is installed for manager and unit inspection.
5. Linux user/PID namespaces and a private Bubblewrap `/proc` work.
6. The cgroup v2 memory controller is delegated, configured, and enforced.
7. The cgroup v2 PID controller is delegated, configured, and enforced.

## Build And Verify

Build and smoke-test the image without Redis, Discord, or provider credentials:

```sh
bun run docker:build --tag lilac:dev .
bun run docker:verify-image
```

The image smoke creates a uniquely named, network-disabled container with Core condition-disabled, waits for the `lilac` user manager, verifies that a service journal entry reaches Docker logs, runs `/usr/local/bin/verify-workflow-runtime` as `lilac`, and then runs the gated workflow-sandbox test with the image's production `/usr/local/bin/bun`. Together these checks exercise log forwarding, the loader, bind mounts, helper process, runtime command, namespace boundary, and cgroup enforcement without Redis, Discord, or provider credentials. The verifier inspects every transient unit it creates and fails unless cleanup leaves each unit inactive or absent. The container is removed on success or failure. To verify another tag, run `bun run docker:verify-image my-registry/lilac:tag`.

The regular source-test job does not enable `LILAC_WORKFLOW_SANDBOX_INTEGRATION`; the Docker image job owns the live workflow-sandbox and end-to-end workflow integration coverage because it supplies the production systemd, Bubblewrap, Bun, and cgroup environment.

Start the deployment and verify the same boundary in the running service:

```sh
docker compose up -d
bun run docker:verify
docker compose ps
docker compose logs -f lilac
```

Compose readiness is the Core `/readyz` endpoint. A healthy container means Core and its HTTP tool server are ready; workflow startup also fails closed if its sandbox preflight cannot establish the required boundary. Systemd journal entries are forwarded to Docker's original output streams, so Core logs remain available both through `docker compose logs lilac` and `docker compose exec -T lilac journalctl -u lilac-core.service --no-pager`.

## Operator CLI

The entrypoint creates a new root-only operator token on every container boot. Use it explicitly to call Level-2 tools outside an active agent request:

```sh
docker compose exec -T lilac /usr/local/bin/tools --operator --list
docker compose exec -T lilac /usr/local/bin/tools --op workflow.run.list --state=running
```

The token is stored at `/run/lilac/operator-token` as `root:root` mode `0600`; Core receives only its SHA-256 hash. Operator calls have trusted authorization to ordinary Level-2 callables, but workflow execution still requires an authenticated server-owned main-agent principal and tool implementations still run as the unprivileged `lilac` service user. Use the absolute CLI path shown above so root never resolves an agent-installed executable from `/data/bin`. Running the command with `--user lilac` intentionally fails because agents and other `lilac` processes cannot read the operator token. The image also keeps `/app`, the installed CLI bundle, and their Bun executable root-owned so `lilac` cannot directly replace either side of the authentication boundary.

External plugins are trusted in-process Core code loaded from `/data/plugins`. The operator token is not a hostile-agent boundary if an agent is allowed to install or modify those plugins; use the Docker topology only with trusted agents, or separately restrict external plugin management to operators.

## Security Posture

This is best-effort separation, not total container lockdown or a hostile multi-tenant boundary. Lilac owns the container as a first-class user. The outer seccomp and system-path relaxations permit nested Bubblewrap and systemd cgroup management; the inner workflow boundary still clears the environment, drops capabilities, creates namespaces and a private `/proc`, exposes a minimal filesystem, and enforces memory, PID, and runtime limits.

Trusted subagent Bash receives installed image executables and its selected canonical cwd, but not Core/operator/cloud/GitHub credentials. Bubblewrap shares the host network namespace when the selected native profile enables network and unshares it when disabled; workflow launch does not alter that choice. A per-operation host-mediated Unix-socket `tools` proxy provides request-bound Level-2 transport identity without placing its control token in the child environment or command line; operation cancellation and downstream disconnect abort its upstream request. The deployment-owned denied-root policy blocks exact Core state/config/plugin/secret roots, `/run/lilac`, root-owned Lilac control/config roots, and configured home credential roots. Ordinary project `.env*`, Git metadata, broad project/home ancestors, and directories containing a protected descendant are not denied. Bubblewrap mounts descriptor-pinned system executables, Bun, workspace, workflow-family scratch, support data, and dependency overlays for the child lifetime; secret-free scratch is available at `/run/lilac/scratch`.

Before each trusted Bash dispatch, Core performs a cancellable, deadline-bound metadata walk from the pinned root descriptor. Ordinary single-link files require one `lstat`; only directories and hardlinked files are opened for inode verification. The walk permits up to two million workspace and Bun-cache entries and one hundred thousand distinct hardlink inodes, and runs inside the deployment's Core service cgroup; the command itself remains in its stricter per-operation transient unit. Hardlinks crossing the authorized root are rejected, with Bun cache sources allowed only for read-only dependency overlays. `LILAC_WORKFLOW_BASH_INTEGRATION=1 bun test tests/tools/bash.test.ts` covers real Git/Bun/Python execution, protected aliases, external dependency hardlinks, cancellation, and transient-unit cleanup on a workflow-ready host.

Keep secrets out of the image and source control. Restrict the permissions of the deployment environment file and do not print `docker compose config` or inspect the container environment in diagnostics. The entrypoint writes the container environment to a root-readable runtime file for the Core unit. After rotating a token or key, recreate rather than merely restart the container:

```sh
docker compose up -d --force-recreate lilac
```

## Custom UID

`CONTAINER_UID` is a build argument, not a runtime setting. It must be a free numeric UID from 1000 through 60000. The image bakes that UID into the `lilac` account, user-manager dependency, runtime directory, and service environment. Rebuild the image after changing it, and ensure bind-mounted files are owned or writable by the selected UID.

## Diagnostics

These commands do not resolve or display Compose environment values:

```sh
docker version --format 'server={{.Server.Version}}'
docker info --format 'os={{.OSType}} cgroup={{.CgroupVersion}} driver={{.CgroupDriver}}'
bun run docker:verify-image
bun run docker:verify
docker compose exec -T lilac systemctl --failed --no-pager
docker compose exec -T --user lilac lilac systemctl --user --failed --no-pager
```

An engine older than Docker 28 fails before the image smoke starts. A failure from `verify-workflow-runtime` identifies the unavailable manager, namespace operation, controller, configured cgroup value, enforcement probe, or transient-unit cleanup problem. A subsequent Bun test failure identifies a production workflow loader, bind, helper, or runtime-command regression. Avoid `docker inspect`, `docker compose config` without `--quiet`, and commands that dump `/run/lilac/container.env` because those can expose credentials.
