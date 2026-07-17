#!/bin/sh
set -eu

LILAC_OPERATOR_TOKEN_SHA256=$(
  /usr/bin/node /usr/local/libexec/create-operator-token.mjs
)
export LILAC_OPERATOR_TOKEN_SHA256

uid=$(/usr/bin/id -u lilac)
gid=$(/usr/bin/id -g lilac)
exec /usr/bin/setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"
