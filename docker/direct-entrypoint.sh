#!/bin/sh
set -eu

LILAC_OPERATOR_TOKEN_SHA256=$(
  /usr/bin/node /usr/local/libexec/create-operator-token.mjs
)
export LILAC_OPERATOR_TOKEN_SHA256

uid=$(/usr/bin/id -u lilac)
gid=$(/usr/bin/id -g lilac)
/usr/bin/install -d -o "$uid" -g "$gid" -m 0700 /run/lilac/tool-server
/usr/bin/install -d -o root -g root -m 0755 /run/lilac/tool-worker
/usr/bin/install -d -o root -g root -m 0700 /run/lilac/tool-worker/0
/usr/bin/install -d -o "$uid" -g "$gid" -m 0700 "/run/lilac/tool-worker/$uid"
exec /usr/bin/setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"
