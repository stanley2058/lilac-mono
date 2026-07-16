#!/bin/sh
set -eu

if [ "${LILAC_VERIFY_ONLY:-}" = "1" ]; then
  mkdir -p /run/lilac
  : >/run/lilac/verify-only
fi

/usr/bin/node /usr/local/libexec/write-container-environment.mjs
exec "$@"
