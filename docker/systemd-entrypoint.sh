#!/bin/sh
set -eu

if [ "${LILAC_VERIFY_ONLY:-}" = "1" ]; then
  mkdir -p /run/lilac
  : >/run/lilac/verify-only
fi

/usr/bin/node /usr/local/libexec/write-container-environment.mjs

# Keep a process attached to Docker's original streams. Systemd reopens its own
# stdout and stderr after becoming PID 1, so console forwarding cannot use them.
forward_journal() {
  while [ ! -S /run/systemd/journal/socket ]; do
    sleep 0.1
  done

  while :; do
    status=0
    /usr/bin/journalctl \
      --boot=0 \
      --cursor-file=/run/lilac/docker-journal.cursor \
      --follow \
      --no-pager \
      --no-tail \
      --output=cat || status=$?
    printf 'journal forwarding stopped (status %s); retrying\n' "$status" >&2
    sleep 1
  done
}

forward_journal &
exec "$@"
