#!/usr/bin/bash
set -euo pipefail

if [[ ${LILAC_VERIFY_BOUNDED:-} != 1 ]]; then
  exec /usr/bin/timeout --signal=TERM --kill-after=20s 75s \
    /usr/bin/env LILAC_VERIFY_BOUNDED=1 "$0" "$@"
fi

fail() {
  printf 'workflow runtime verification failed: %s\n' "$1" >&2
  exit 1
}

[[ $(/usr/bin/id -u) -ne 0 ]] || fail "must run as lilac, not root"
[[ $(/usr/bin/id -un) == lilac ]] || fail "must run as lilac"

for command in /usr/bin/bwrap /usr/bin/systemd-run /usr/bin/systemctl /usr/bin/python3 /usr/bin/timeout; do
  [[ -x $command ]] || fail "$command is unavailable"
done

units=()
cleanup() {
  local active_state inspect_status load_state state unit
  local cleanup_failed=0

  ((${#units[@]} > 0)) || return 0

  /usr/bin/timeout 5s /usr/bin/systemctl --user stop "${units[@]}" >/dev/null 2>&1 || true
  /usr/bin/timeout 5s /usr/bin/systemctl --user reset-failed "${units[@]}" \
    >/dev/null 2>&1 || true

  for unit in "${units[@]}"; do
    inspect_status=0
    state=$(
      /usr/bin/timeout 2s /usr/bin/systemctl --user show "$unit" \
        --property=LoadState --property=ActiveState 2>/dev/null
    ) || inspect_status=$?
    load_state=
    active_state=
    while IFS='=' read -r property value; do
      case $property in
        LoadState) load_state=$value ;;
        ActiveState) active_state=$value ;;
      esac
    done <<<"$state"

    if [[ $load_state == not-found || $active_state == inactive ]]; then
      continue
    fi

    printf 'workflow runtime verification cleanup failed: unit %s remained load=%s active=%s (inspect status %s)\n' \
      "$unit" "${load_state:-unknown}" "${active_state:-unknown}" "$inspect_status" >&2
    cleanup_failed=1
  done

  return "$cleanup_failed"
}
cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  cleanup || status=1
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

manager_cgroup=$(/usr/bin/timeout 5s /usr/bin/systemctl --user show --property=ControlGroup --value) ||
  fail "user manager is unreachable"
[[ $manager_cgroup == /* && $manager_cgroup != *$'\n'* && $manager_cgroup != *..* ]] ||
  fail "user manager returned an invalid cgroup"

[[ -f /sys/fs/cgroup/cgroup.controllers ]] || fail "cgroup v2 is unavailable"
manager_controllers="/sys/fs/cgroup${manager_cgroup}/cgroup.controllers"
[[ -r $manager_controllers ]] || fail "user manager cgroup is unavailable"
read -r -a controllers <"$manager_controllers"
for required in memory pids; do
  found=false
  for controller in "${controllers[@]}"; do
    [[ $controller == "$required" ]] && found=true
  done
  [[ $found == true ]] || fail "$required controller is not delegated to the user manager"
done

suffix="$(/usr/bin/id -u)-$$"
smoke_unit="lilac-verify-bwrap-${suffix}.service"
units+=("$smoke_unit")
/usr/bin/timeout 12s /usr/bin/systemd-run --user --wait --collect --quiet --unit="$smoke_unit" \
  --property=MemoryMax=64M \
  --property=MemorySwapMax=0 \
  --property=TasksMax=16 \
  --property=RuntimeMaxSec=8s \
  /usr/bin/bwrap --unshare-all --die-with-parent --new-session --clearenv --cap-drop ALL \
  --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp /usr/bin/true >/dev/null ||
  fail "transient bubblewrap smoke test failed"

limits_unit="lilac-verify-limits-${suffix}.service"
units+=("$limits_unit")
/usr/bin/timeout 8s /usr/bin/systemd-run --user --collect --quiet --unit="$limits_unit" \
  --property=MemoryMax=33554432 \
  --property=MemorySwapMax=0 \
  --property=TasksMax=8 \
  --property=RuntimeMaxSec=20s \
  /usr/bin/sleep 20 >/dev/null
/usr/bin/timeout 5s /usr/bin/systemctl --user is-active --quiet "$limits_unit" ||
  fail "limit probe did not start"
limits_cgroup=$(
  /usr/bin/timeout 5s /usr/bin/systemctl --user show "$limits_unit" --property=ControlGroup --value
) ||
  fail "cannot inspect limit probe cgroup"
[[ -n $limits_cgroup ]] || fail "limit probe has no cgroup"
limits_path="/sys/fs/cgroup${limits_cgroup}"
[[ $(<"$limits_path/memory.max") == 33554432 ]] || fail "MemoryMax was not applied"
[[ $(<"$limits_path/memory.swap.max") == 0 ]] || fail "MemorySwapMax was not applied"
[[ $(<"$limits_path/pids.max") == 8 ]] || fail "TasksMax was not applied"
/usr/bin/timeout 5s /usr/bin/systemctl --user stop "$limits_unit" >/dev/null

memory_unit="lilac-verify-memory-${suffix}.service"
units+=("$memory_unit")
if /usr/bin/timeout 15s /usr/bin/systemd-run --user --wait --quiet --unit="$memory_unit" \
  --property=MemoryMax=33554432 \
  --property=MemorySwapMax=0 \
  --property=TasksMax=16 \
  --property=RuntimeMaxSec=10s \
  /usr/bin/python3 -c 'chunks=[]
while True:
    chunks.append(bytearray(8 * 1024 * 1024))' >/dev/null 2>&1; then
  fail "memory limit did not terminate the probe"
fi
memory_result=$(
  /usr/bin/timeout 5s /usr/bin/systemctl --user show "$memory_unit" --property=Result --value
) || true
[[ $memory_result == oom-kill ]] || fail "memory probe was not terminated by the cgroup OOM limit"

pids_unit="lilac-verify-pids-${suffix}.service"
units+=("$pids_unit")
/usr/bin/timeout 15s /usr/bin/systemd-run --user --wait --quiet --unit="$pids_unit" \
  --property=MemoryMax=64M \
  --property=MemorySwapMax=0 \
  --property=TasksMax=8 \
  --property=RuntimeMaxSec=10s \
  /usr/bin/python3 -c 'import errno, os, signal
children = []
enforced = False
try:
    for _ in range(32):
        try:
            pid = os.fork()
        except OSError as error:
            enforced = error.errno == errno.EAGAIN
            break
        if pid == 0:
            signal.pause()
        children.append(pid)
finally:
    for pid in children:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for pid in children:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
raise SystemExit(0 if enforced else 1)' >/dev/null || fail "PID limit was not enforced"

cleanup_status=0
cleanup || cleanup_status=$?
units=()
((cleanup_status == 0)) || fail "one or more transient units could not be cleaned up"
trap - EXIT INT TERM
printf 'workflow runtime verification passed\n'
