#!/usr/bin/env bash
# Capture evidence for "invoking a team computer fills the disk and hangs".
#
# Read-only: samples disk state around a live team-computer invocation. It never
# prunes, stops, or removes anything. Run it, invoke a team computer, read the
# report, then stop it.
#
#   scripts/diagnose-computer-disk.sh watch [seconds] [interval]   # default 300s / 5s
#   scripts/diagnose-computer-disk.sh snapshot <label>
#   scripts/diagnose-computer-disk.sh report <before> <after>
#
# Evidence lands in .diagnostics/computer-disk/ (gitignored).
#
# Set RAKAZO_DOCKER_VHDX if the Docker Desktop disk image is not auto-detected.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/.diagnostics/computer-disk"
mkdir -p "$OUT"

# ---------------------------------------------------------------- host probes

# Docker Desktop stores the disk image (docker_data.vhdx) outside the repo and
# the location is user-configurable, so probe the settings files, then fall back
# to well-known paths.
find_vhdx() {
  if [[ -n "${RAKAZO_DOCKER_VHDX:-}" ]]; then printf '%s\n' "$RAKAZO_DOCKER_VHDX"; return; fi
  local candidates=() settings
  for settings in \
    "${APPDATA:-}/Docker/settings-store.json" \
    "${APPDATA:-}/Docker/settings.json" \
    "$HOME/.docker/desktop/settings-store.json"
  do
    [[ -f "$settings" ]] || continue
    local folder
    folder="$(grep -oE '"DataFolder"[[:space:]]*:[[:space:]]*"[^"]*"' "$settings" 2>/dev/null |
      head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')"
    [[ -n "$folder" ]] && candidates+=("$folder")
  done
  candidates+=(
    "/e/docker/data/disk/docker_data.vhdx"
    "/c/Users/${USER:-}/AppData/Local/Docker/wsl/data/ext4.vhdx"
    "/c/ProgramData/DockerDesktop/vms/0/data/docker_data.vhdx"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    [[ -f "$candidate" ]] && { printf '%s\n' "$candidate"; return; }
  done
}

# Best-effort mount point for a path, so we can report free space next to it.
free_space_for() {
  local path="$1" dir
  dir="$(dirname "$path")"
  df -h "$dir" 2>/dev/null | awk 'NR==2 {print $4" free of "$2" ("$5" used)"}'
}

# Size of a directory in MiB, or "-" if it does not exist.
dir_mib() {
  local path="$1"
  [[ -e "$path" ]] || { printf '%s' "-"; return; }
  du -sm "$path" 2>/dev/null | awk '{print $1}'
}

# ------------------------------------------------------------ docker probes

# True when the daemon answers. Everything docker-side is gated on this so a
# stopped Docker Desktop produces a clear line instead of a wall of errors.
docker_up() { docker info >/dev/null 2>&1; }

# The computer containers this install owns. computer-spec.ts labels them
# "rakazo.managed=true" / "rakazo.botId" / "rakazo.spaceId" (rakazo.computerOwner
# is the *network* label, not the container's).
computer_containers() {
  docker ps -a --filter "label=rakazo.managed=true" \
    --format '{{.Names}}' 2>/dev/null
}

sample() {
  local label="$1" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "### ${label} @ ${now}"

  local vhdx
  vhdx="$(find_vhdx)"
  if [[ -n "$vhdx" ]]; then
    echo "vhdx: ${vhdx}"
    echo "vhdx_bytes: $(stat -c %s "$vhdx" 2>/dev/null || echo '-')"
    echo "host_disk: $(free_space_for "$vhdx")"
  else
    echo "vhdx: NOT FOUND (set RAKAZO_DOCKER_VHDX)"
    echo "host_disk: $(df -h "$ROOT" 2>/dev/null | awk 'NR==2 {print $4" free of "$2" ("$5" used)"}')"
  fi

  if ! docker_up; then
    echo "docker: NOT RUNNING (no container-level evidence; start Docker Desktop)"
    echo
    return
  fi

  echo "docker: up"
  # Docker's own accounting: images / containers / volumes / build cache.
  docker system df 2>/dev/null | sed 's/^/  /'

  # Writable-layer size per computer container: this is where /tmp logs land.
  local container
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    local size
    size="$(docker ps -a --filter "name=^/${container}$" --size \
      --format '{{.Size}}' 2>/dev/null)"
    echo "container ${container} size: ${size}"
    # Inside the container: the two unbounded writers.
    echo "  /tmp/rakazo: $(docker exec "$container" du -sm /tmp/rakazo 2>/dev/null | awk '{print $1}' || echo '-') MiB"
    echo "  browser logs: $(docker exec "$container" sh -c 'ls -l /tmp/rakazo/screen-*-browser.log 2>/dev/null | wc -l' 2>/dev/null || echo '-') file(s)"
    docker exec "$container" sh -c 'ls -lS /tmp/rakazo/*browser.log 2>/dev/null | head -5' 2>/dev/null | sed 's/^/  /'
    echo "  browser-profiles: $(docker exec "$container" sh -c 'du -sm /home/rakazo/.browser-profiles 2>/dev/null' 2>/dev/null | awk '{print $1}' || echo '-') MiB"
    docker exec "$container" sh -c 'du -sm /home/rakazo/.browser-profiles/* 2>/dev/null | sort -rn | head -5' 2>/dev/null | sed 's/^/  /'
  done < <(computer_containers)

  # Host-side home: the same bytes, via the bind mount.
  local home
  for home in "$ROOT"/data/homes/*; do
    [[ -d "$home" ]] || continue
    echo "home $(basename "$home"): $(dir_mib "$home") MiB total, $(dir_mib "$home/.browser-profiles") MiB profiles"
  done
  echo
}

# ------------------------------------------------------------------ reports

diff_snapshots() {
  local before="$1" after="$2"
  echo "== vhdx growth =="
  local b a
  b="$(grep -m1 '^vhdx_bytes:' "$before" | awk '{print $2}')"
  a="$(grep -m1 '^vhdx_bytes:' "$after" | awk '{print $2}')"
  if [[ "$b" =~ ^[0-9]+$ && "$a" =~ ^[0-9]+$ ]]; then
    awk -v b="$b" -v a="$a" 'BEGIN {
      printf "  %d -> %d bytes (delta %+.1f MiB)\n", b, a, (a-b)/1048576
    }'
  else
    echo "  unavailable"
  fi

  echo "== browser log growth (fastest unbounded writer) =="
  local name
  for name in $(grep -oE 'screen-[0-9]+-browser\.log' "$before" | sort -u); do
    local lb la
    lb="$(grep -F "$name" "$before" | awk '{print $5}' | head -1)"
    la="$(grep -F "$name" "$after" | awk '{print $5}' | head -1)"
    echo "  ${name}: ${lb:-?} -> ${la:-?}"
  done

  echo "== docker system df: before =="
  sed -n '/docker: up/,/container /p' "$before" | sed '$d' | grep -v '^container' | sed 's/^/  /'
  echo "== docker system df: after =="
  sed -n '/docker: up/,/container /p' "$after" | sed '$d' | grep -v '^container' | sed 's/^/  /'
}

# --------------------------------------------------------------------- main

cmd_snapshot() {
  local label="$1" file="${OUT}/$1.txt"
  sample "$label" | tee "$file"
  echo "wrote $file" >&2
}

cmd_watch() {
  local total="${1:-300}" interval="${2:-5}" elapsed=0 stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local before="${OUT}/before-${stamp}.txt" after="${OUT}/after-${stamp}.txt"
  echo "Sampling every ${interval}s for ${total}s." >&2
  echo "Invoke a team computer NOW; press Ctrl-C to stop early." >&2
  sample before >"$before"
  echo "before -> $before" >&2
  while ((elapsed < total)); do
    sleep "$interval"
    elapsed=$((elapsed + interval))
    local vhdx bytes
    vhdx="$(find_vhdx)"
    bytes="$(stat -c %s "$vhdx" 2>/dev/null || echo '-')"
    printf '[%4ds] vhdx=%s bytes\n' "$elapsed" "$bytes" >&2
  done
  sample after >"$after"
  echo "after -> $after" >&2
  echo >&2
  diff_snapshots "$before" "$after"
}

case "${1:-watch}" in
  snapshot) shift; cmd_snapshot "${1:?label required}" ;;
  watch)    shift; cmd_watch "${1:-300}" "${2:-5}" ;;
  report)   shift; diff_snapshots "${1:?before file}" "${2:?after file}" ;;
  *) echo "usage: $0 {watch [seconds] [interval]|snapshot <label>|report <before> <after>}" >&2; exit 2 ;;
esac
