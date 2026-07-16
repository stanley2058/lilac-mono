# Docker Deployment

Lilac's supported container topology runs systemd as container PID 1. Systemd starts a persistent user manager for the first-class `lilac` user, and that manager creates the transient Bubblewrap units used by workflows.

## Host Contract

- Linux Docker server 28 or newer. The client version alone is not sufficient.
- A unified cgroup v2 host exposing the memory and PID controllers.
- Docker's private cgroup namespace with `writable-cgroups=true`.
- `seccomp=unconfined` and `apparmor=unconfined` for nested namespace operations, plus `systempaths=unconfined` for the workflow's private `/proc` mount.
- The `/run`, `/run/lock`, and `/tmp` tmpfs mounts and systemd stop signal in `compose.yaml`.
- Enough headroom for the configured container memory and PID limits.

Do not add `privileged: true`, use the host cgroup namespace, or bind-mount `/sys/fs/cgroup`. Docker 28+ supplies a writable view of only the container's private cgroup hierarchy.

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

The image smoke creates a uniquely named, network-disabled container with Core condition-disabled, waits for the `lilac` user manager, runs `/usr/local/bin/verify-workflow-runtime` as `lilac`, and then runs the gated workflow-sandbox test with the image's production `/home/lilac/.bun/bin/bun`. Together these checks exercise the loader, bind mounts, helper process, runtime command, namespace boundary, and cgroup enforcement without Redis, Discord, or provider credentials. The verifier inspects every transient unit it creates and fails unless cleanup leaves each unit inactive or absent. The container is removed on success or failure. To verify another tag, run `bun run docker:verify-image my-registry/lilac:tag`.

The regular source-test job does not enable `LILAC_WORKFLOW_SANDBOX_INTEGRATION`; the Docker image job owns the live workflow-sandbox and end-to-end workflow integration coverage because it supplies the production systemd, Bubblewrap, Bun, and cgroup environment.

Start the deployment and verify the same boundary in the running service:

```sh
docker compose up -d
bun run docker:verify
docker compose ps
```

Compose readiness is the Core `/readyz` endpoint. A healthy container means Core and its HTTP tool server are ready; workflow startup also fails closed if its sandbox preflight cannot establish the required boundary.

## Security Posture

This is best-effort separation, not total container lockdown or a hostile multi-tenant boundary. Lilac owns the container as a first-class user. The outer seccomp and system-path relaxations permit nested Bubblewrap and systemd cgroup management; the inner workflow boundary still clears the environment, drops capabilities, creates namespaces and a private `/proc`, exposes a minimal filesystem, and enforces memory, PID, and runtime limits.

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
