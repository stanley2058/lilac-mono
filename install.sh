#!/usr/bin/env bash
set -euo pipefail

lilac_fail() {
  printf 'Lilac setup: %s\n' "$*" >&2
  exit 1
}

lilac_require() {
  command -v "$1" >/dev/null 2>&1 || lilac_fail "$2"
}

lilac_check_machine() {
  printf 'Checking this machine…\n'
  lilac_require curl 'Install curl, then run this command again.'
  lilac_require docker 'Install Docker with the Compose plugin, then run this command again: https://docs.docker.com/get-started/get-docker/'
  lilac_compose=$(docker compose version --short 2>/dev/null) || lilac_fail 'Docker Compose 2.30 or newer is required. Install the Docker Compose plugin, then try again.'
  lilac_compose=${lilac_compose#v}
  awk -v version="$lilac_compose" 'BEGIN { split(version, parts, "."); exit !(parts[1] > 2 || (parts[1] == 2 && parts[2] >= 30)) }' || lilac_fail 'Docker Compose 2.30 or newer is required. Update the Docker Compose plugin, then try again.'
  docker info >/dev/null 2>&1 || lilac_fail 'Cannot reach Docker. Start Docker and give your user access to its daemon, then try again.'
  [ "$(docker info --format '{{.OSType}}')" = linux ] || lilac_fail 'Docker must run Linux containers.'

  case "$(uname -s)" in
    Linux)
      lilac_os=linux
      lilac_glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || lilac_fail 'Linux requires glibc 2.28 or later. Alpine/musl hosts are not supported.'
      lilac_glibc=${lilac_glibc#glibc }
      awk -v version="$lilac_glibc" 'BEGIN { split(version, parts, "."); exit !(parts[1] > 2 || (parts[1] == 2 && parts[2] >= 28)) }' || lilac_fail 'Linux requires glibc 2.28 or later.'
      ;;
    Darwin)
      lilac_os=darwin
      lilac_macos=$(sw_vers -productVersion)
      [ "${lilac_macos%%.*}" -ge 13 ] || lilac_fail 'macOS 13 or later is required.'
      ;;
    *) lilac_fail 'Supported hosts are Linux and macOS on x64 or arm64.' ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) lilac_arch=x64 ;;
    aarch64|arm64) lilac_arch=arm64 ;;
    *) lilac_fail 'Supported processor architectures are x64 and arm64.' ;;
  esac

  if command -v sha256sum >/dev/null 2>&1; then
    lilac_checksum_command=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    lilac_checksum_command=shasum
  else
    lilac_fail 'Install sha256sum or shasum to verify the installer download.'
  fi

  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    lilac_fail 'An interactive terminal is required. Run this command from a terminal, or connect with ssh -t.'
  fi
}

lilac_download() {
  curl --connect-timeout 15 --retry 2 -fsSL "$1" -o "$2" || lilac_fail 'Could not download the installer release. Check the release URL and your connection, then try again.'
}

lilac_main() {
  lilac_check_machine
  lilac_release_base=${LILAC_RELEASE_BASE_URL:-}
  if [ -z "$lilac_release_base" ]; then
    lilac_release_url=$(curl --connect-timeout 15 --retry 2 -fsSL -o /dev/null -w '%{url_effective}' 'https://github.com/stanley2058/lilac-mono/releases/latest') || lilac_fail 'No published installer release is available, or GitHub could not be reached.'
    case "$lilac_release_url" in
      https://github.com/stanley2058/lilac-mono/releases/tag/*)
        lilac_release_base="https://github.com/stanley2058/lilac-mono/releases/download/${lilac_release_url##*/}"
        ;;
      *) lilac_fail 'GitHub did not return a published installer release.' ;;
    esac
  fi
  lilac_release_base=${lilac_release_base%/}
  lilac_asset="lilac-${lilac_os}-${lilac_arch}"
  lilac_tmp=$(mktemp -d "${TMPDIR:-/tmp}/lilac-install.XXXXXXXX")
  trap 'rm -rf "$lilac_tmp"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf 'Downloading Lilac for %s/%s…\n' "$lilac_os" "$lilac_arch"
  lilac_download "$lilac_release_base/SHA256SUMS" "$lilac_tmp/SHA256SUMS"
  lilac_download "$lilac_release_base/$lilac_asset" "$lilac_tmp/lilac"
  lilac_expected=$(awk -v asset="$lilac_asset" '$2 == asset { print $1 }' "$lilac_tmp/SHA256SUMS")
  [[ "$lilac_expected" =~ ^[0-9a-f]{64}$ ]] || lilac_fail 'The release checksum list has no unique valid entry for this installer.'

  if [ "$lilac_checksum_command" = sha256sum ]; then
    lilac_actual=$(sha256sum "$lilac_tmp/lilac")
  else
    lilac_actual=$(shasum -a 256 "$lilac_tmp/lilac")
  fi
  [ "${lilac_actual%% *}" = "$lilac_expected" ] || lilac_fail 'Installer checksum verification failed. No installer was run.'
  chmod 700 "$lilac_tmp/lilac"
  "$lilac_tmp/lilac" --version || lilac_fail 'The downloaded installer cannot run on this machine.'
  "$lilac_tmp/lilac" "$@" <&3
}

lilac_main "$@"
