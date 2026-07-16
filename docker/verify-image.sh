#!/usr/bin/env bash
set -Eeuo pipefail

readonly MIN_DOCKER_MAJOR=28

fail() {
  printf 'image workflow runtime verification failed: %s\n' "$1" >&2
  exit 1
}

check_host() {
  command -v docker >/dev/null 2>&1 || fail "docker is unavailable"

  local server_version major cgroup_version os_type
  server_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null) ||
    fail "cannot reach the Docker daemon"
  major=${server_version%%.*}
  [[ $major =~ ^[0-9]+$ ]] || fail "cannot parse Docker server version: $server_version"
  ((major >= MIN_DOCKER_MAJOR)) ||
    fail "Docker server 28 or newer is required (found $server_version)"

  os_type=$(docker info --format '{{.OSType}}' 2>/dev/null) || fail "cannot inspect Docker"
  [[ $os_type == linux ]] || fail "a Linux Docker daemon is required (found $os_type)"

  cgroup_version=$(docker info --format '{{.CgroupVersion}}' 2>/dev/null) ||
    fail "cannot inspect Docker cgroups"
  [[ $cgroup_version == 2 ]] || fail "cgroup v2 is required (found v$cgroup_version)"
}

check_host
if [[ ${1:-} == --check-host ]]; then
  [[ $# -eq 1 ]] || fail "usage: $0 [--check-host|IMAGE]"
  printf 'Docker host supports image workflow runtime verification\n'
  exit 0
fi
[[ $# -le 1 ]] || fail "usage: $0 [--check-host|IMAGE]"

readonly image=${1:-lilac:dev}
container_name="lilac-image-verify-$(date +%s)-$$-${RANDOM}"
readonly container_name

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker image inspect "$image" >/dev/null 2>&1 || fail "image does not exist: $image"

docker run --detach \
  --name "$container_name" \
  --network none \
  --cgroupns private \
  --tmpfs /run:rw,nosuid,nodev,mode=755,size=64m \
  --tmpfs /run/lock:rw,nosuid,nodev,mode=755,size=16m \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=1g \
  --security-opt seccomp=unconfined \
  --security-opt writable-cgroups=true \
  --security-opt systempaths=unconfined \
  --memory 4g \
  --pids-limit 1024 \
  --stop-signal SIGRTMIN+3 \
  --stop-timeout 30 \
  --no-healthcheck \
  --env container=docker \
  --env LILAC_VERIFY_ONLY=1 \
  "$image" >/dev/null

readonly wait_deadline=$((SECONDS + 45))
manager_ready=false
while ((SECONDS < wait_deadline)); do
  running=$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)
  if [[ $running != true ]]; then
    exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container_name" 2>/dev/null || true)
    fail "verify-only container exited before the lilac user manager was ready (exit ${exit_code:-unknown})"
  fi
  if docker exec --user lilac "$container_name" \
    /usr/bin/systemctl --user show --property=ControlGroup --value >/dev/null 2>&1; then
    manager_ready=true
    break
  fi
  sleep 1
done
[[ $manager_ready == true ]] || fail "timed out waiting for the lilac user manager"

pid1=$(docker exec "$container_name" /usr/bin/cat /proc/1/comm)
[[ $pid1 == systemd ]] || fail "container PID 1 is not systemd (found $pid1)"
if docker exec "$container_name" /usr/bin/systemctl is-active --quiet lilac-core.service; then
  fail "Core started during verify-only boot"
fi
core_condition=$(docker exec "$container_name" \
  /usr/bin/systemctl show lilac-core.service --property=ConditionResult --value)
[[ $core_condition == no ]] || fail "Core was not condition-disabled for verify-only boot"

docker exec --user lilac "$container_name" /usr/local/bin/verify-workflow-runtime
docker exec --user lilac \
  --env LILAC_WORKFLOW_SANDBOX_INTEGRATION=1 \
  "$container_name" \
  /home/lilac/.bun/bin/bun test ./apps/core/tests/workflow/workflow-sandbox.test.ts
