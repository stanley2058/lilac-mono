#!/usr/bin/env bash
set -u

# This script prints a single JSON object describing remote capabilities.
# It is designed to be safe and low-impact: no prompts, no network, no writes.

# Placeholder replaced by the server before sending.
CWD=$(cat <<'__LILAC_CWD__'
__LILAC_CWD_VALUE__
__LILAC_CWD__
)

EXPECTED_TOOLS=(
  bash
  sh
  git
  ssh
  tar
  gzip
  base64
  curl
  wget
  jq
  rg
  fd
  node
  npm
  bun
  python3
  python
  uv
  pip
  pip3
  make
  go
  rustc
  cargo
  java
)

json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

first_line() {
  local line=''
  IFS= read -r line || true
  printf '%s' "$line"
}

cap_lines() {
  local max="$1"
  local out=""
  local count=0
  local line=""
  while IFS= read -r line; do
    if [ "$count" -ge "$max" ]; then
      break
    fi
    out+="$line"$'\n'
    count=$((count + 1))
  done
  # Remove trailing newline if present.
  if [ -n "$out" ]; then
    out=${out%$'\n'}
  fi
  printf '%s' "$out"
}

cmd_path() {
  command -v "$1" 2>/dev/null || true
}

cmd_version_line() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf ''
    return 0
  fi

  case "$tool" in
    python3|python)
      "$tool" -V 2>&1 | first_line
      ;;
    pip|pip3)
      "$tool" --version 2>&1 | first_line
      ;;
    ssh)
      "$tool" -V 2>&1 | first_line
      ;;
    java)
      "$tool" -version 2>&1 | first_line
      ;;
    *)
      "$tool" --version 2>&1 | first_line
      ;;
  esac
}

cwd_attempted=""
cwd_used=""
if [ -n "$CWD" ]; then
  cwd_attempted="$CWD"
  if cd "$CWD" 2>/dev/null; then
    cwd_used="$CWD"
  fi
fi

uname_s=$(uname -s 2>/dev/null || true)
uname_m=$(uname -m 2>/dev/null || true)
uname_r=$(uname -r 2>/dev/null || true)
user=$(whoami 2>/dev/null || true)
home=${HOME:-""}
shell=${SHELL:-""}
pwd_now=$(pwd 2>/dev/null || true)

os_id=""
os_version_id=""
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release 2>/dev/null || true
  os_id=${ID:-""}
  os_version_id=${VERSION_ID:-""}
fi

git_is_repo=false
git_top_level=""
git_head=""
git_branch=""
git_status=""
if command -v git >/dev/null 2>&1; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_is_repo=true
    git_top_level=$(git rev-parse --show-toplevel 2>/dev/null || true)
    git_head=$(git rev-parse HEAD 2>/dev/null || true)
    git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    git_status=$(git status --porcelain=v1 2>/dev/null | cap_lines 200 || true)
  fi
fi

printf '{'
printf '"ok":true'

printf ',"system":{'
printf '"uname":{"s":"%s","m":"%s","r":"%s"}' \
  "$(json_escape "$uname_s")" \
  "$(json_escape "$uname_m")" \
  "$(json_escape "$uname_r")"
printf ',"osRelease":{"id":"%s","versionId":"%s"}' \
  "$(json_escape "$os_id")" \
  "$(json_escape "$os_version_id")"
printf ',"user":"%s"' "$(json_escape "$user")"
printf ',"home":"%s"' "$(json_escape "$home")"
printf ',"shell":"%s"' "$(json_escape "$shell")"
printf ',"pwd":"%s"' "$(json_escape "$pwd_now")"
printf '}'

printf ',"cwd":{'
printf '"attempted":"%s"' "$(json_escape "$cwd_attempted")"
printf ',"used":"%s"' "$(json_escape "$cwd_used")"
printf '}'

printf ',"git":{'
printf '"isRepo":%s' "$git_is_repo"
printf ',"topLevel":"%s"' "$(json_escape "$git_top_level")"
printf ',"head":"%s"' "$(json_escape "$git_head")"
printf ',"branch":"%s"' "$(json_escape "$git_branch")"
printf ',"statusPorcelain":"%s"' "$(json_escape "$git_status")"
printf '}'

printf ',"expectedTools":['
first=true
for t in "${EXPECTED_TOOLS[@]}"; do
  if [ "$first" = true ]; then
    first=false
  else
    printf ','
  fi
  printf '"%s"' "$(json_escape "$t")"
done
printf ']'

printf ',"tools":{'
first=true
for t in "${EXPECTED_TOOLS[@]}"; do
  p=$(cmd_path "$t")
  present=false
  if [ -n "$p" ]; then
    present=true
  fi
  v=$(cmd_version_line "$t")

  if [ "$first" = true ]; then
    first=false
  else
    printf ','
  fi

  printf '"%s":{' "$(json_escape "$t")"
  printf '"present":%s' "$present"
  printf ',"path":"%s"' "$(json_escape "$p")"
  printf ',"version":"%s"' "$(json_escape "$v")"
  printf '}'
done
printf '}'

printf '}\n'
