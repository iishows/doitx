#!/usr/bin/env bash
# Offline checks for install-images.sh's host resource pre-check: stubbed uname, docker
# and swap sources; no daemon required.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-resources-smoke.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# $1 case name, $2 uname, $3 docker MemTotal, $4 compose mem_limits block,
# $5 extra .env line, $6 fake /proc/meminfo (empty = unreadable), $7 fake .wslconfig.
run_case() {
  local work="$tmp/$1"
  mkdir -p "$work/bin" "$work/cwd"
  printf '#!/usr/bin/env bash\necho %s\n' "$2" >"$work/bin/uname"
  cat >"$work/bin/docker" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == info ]]; then
  case "\$*" in
    *MemTotal*) echo "$3" ;;
    *OperatingSystem*) echo "Docker Desktop" ;;
    *) echo '["name=seccomp"]' ;;
  esac
  exit 0
fi
[[ " \$* " == *" config "* ]] && cat >/dev/null && cat <<'EOF'
POSTGRES_PASSWORD=p
POSTGRES_APP_PASSWORD=a
BETTER_AUTH_SECRET=b
ENCRYPTION_KEY=e
SCREEN_PROXY_SECRET=s
SANDBOX_SUPERVISOR_TOKEN=t
EOF
exit 0
STUB
  chmod +x "$work/bin/uname" "$work/bin/docker"
  cat >"$work/cwd/docker-compose.images.yml" <<YAML
services:
  api:
$4
    environment:
      RAKAZO_COMPUTER_MEMORY: \${RAKAZO_COMPUTER_MEMORY:-6g}
      RAKAZO_COMPUTER_SWAP: \${RAKAZO_COMPUTER_SWAP:-2g}
YAML
  : >"$work/cwd/.env.images.example"
  printf 'POSTGRES_PASSWORD=p\nPOSTGRES_APP_PASSWORD=a\n%s\n' "$5" >"$work/cwd/.env"
  if [[ -n "$6" ]]; then printf '%s\n' "$6" >"$work/meminfo"; fi
  if [[ -n "$7" ]]; then printf '%s\n' "$7" >"$work/wslconfig"; fi
  # Real bash, but stubbed uname/docker ahead of it on PATH: re-execing a copied bash
  # cannot find its own libraries on every platform.
  (
    cd "$work/cwd"
    export RAKAZO_MEMINFO_PATH="$work/meminfo"
    export RAKAZO_WSLCONFIG_PATH="$work/wslconfig"
    unset RAKAZO_COMPUTER_SWAP RAKAZO_COMPUTER_MEMORY
    PATH="$work/bin:$PATH" bash "$src" "${@:8}"
  ) >"$work/out.log" 2>&1 || fail "$1: installer exited non-zero: $(cat "$work/out.log")"
}

out_of() { cat "$tmp/$1/out.log"; }
warned_about() { grep -qi "$2" "$tmp/$1/out.log"; }
# The pre-check's own messages, distinct from the egress/proxy warnings the installer also emits.
memory_warned() { warned_about "$1" 'container limits total'; }
swap_warned() { warned_about "$1" 'has none'; }

# The stack's declared ceilings, as the compose fixture renders them.
LIMITS=$'\n    mem_limit: 8g'

# A host with room to spare stays quiet, on both swap backends.
run_case roomy Linux 68719476736 "$LIMITS" "" "MemTotal: 67108864 kB
SwapTotal: 8388608 kB" "" --local --offline --prepare-only
! memory_warned roomy || fail "a roomy host must not warn: $(out_of roomy)"
! swap_warned roomy || fail "a roomy Linux host must not warn about swap"

run_case roomy-windows MINGW64_NT-10.0 68719476736 "$LIMITS" "" "" "[wsl2]
swap=8GB" --local --offline --prepare-only
! memory_warned roomy-windows || fail "a roomy Windows host must not warn"
! swap_warned roomy-windows || fail "a roomy Windows host must not warn about swap"

# Too little RAM for the declared ceilings warns, and names both figures.
run_case cramped Linux 2147483648 "$LIMITS" "" "SwapTotal: 8388608 kB" "" --local --offline --prepare-only
memory_warned cramped || fail "a cramped host must warn: $(out_of cramped)"
grep -q '2.0 GB' "$tmp/cramped/out.log" || fail "the warning must show the host figure"
grep -q '8.0 GB' "$tmp/cramped/out.log" || fail "the warning must show the required figure"
grep -qi 'per computer' "$tmp/cramped/out.log" || fail "the warning must mention per-computer memory"

# Native Linux swap, with and without.
run_case linux-swap Linux 68719476736 "$LIMITS" "RAKAZO_COMPUTER_SWAP=2g" "SwapTotal:       8388608 kB" "" --local --offline --prepare-only
! swap_warned linux-swap || fail "host swap present must not warn: $(out_of linux-swap)"

run_case linux-noswap Linux 68719476736 "$LIMITS" "RAKAZO_COMPUTER_SWAP=2g" "SwapTotal:             0 kB" "" --local --offline --prepare-only
swap_warned linux-noswap || fail "absent host swap must warn: $(out_of linux-noswap)"
warned_about linux-noswap 'thrash' || fail "the swap warning must explain the consequence"

# Windows reads .wslconfig, where the thrashing setups put swap=0.
run_case windows-noswap MINGW64_NT-10.0 68719476736 "$LIMITS" "RAKAZO_COMPUTER_SWAP=2g" "" "[wsl2]
memory=4GB
swap=0" --local --offline --prepare-only
swap_warned windows-noswap || fail ".wslconfig swap=0 must warn: $(out_of windows-noswap)"
warned_about windows-noswap 'thrash' || fail ".wslconfig swap=0 must explain the consequence"

run_case windows-swap MINGW64_NT-10.0 68719476736 "$LIMITS" "RAKAZO_COMPUTER_SWAP=2g" "" "[wsl2]
swap=8GB" --local --offline --prepare-only
! swap_warned windows-swap || fail ".wslconfig swap=8GB must not warn: $(out_of windows-swap)"

# Swap turned off by the operator needs no host swap.
run_case swap-off Linux 68719476736 "$LIMITS" "RAKAZO_COMPUTER_SWAP=0" "SwapTotal:             0 kB" "" --local --offline --prepare-only
! swap_warned swap-off || fail "swap=0 must not warn: $(out_of swap-off)"

# An unreadable swap source says so rather than assuming either way.
run_case swap-unknown Darwin 68719476736 "$LIMITS" "" "" "" --local --offline --prepare-only
warned_about swap-unknown 'could not be read' || fail "an unreadable swap source must say so: $(out_of swap-unknown)"

# A decimal size parses instead of being mistaken for an unreadable source.
run_case decimals MINGW64_NT-10.0 68719476736 "$LIMITS" "RAKAZO_COMPUTER_SWAP=1.5g" "" "[wsl2]
swap=1.5g" --local --offline --prepare-only
! warned_about decimals 'could not be read' || fail "a decimal swap size must parse: $(out_of decimals)"

# The full install path pre-checks too, alongside its other warnings.
run_case full-path Linux 2147483648 "$LIMITS" "" "SwapTotal: 8388608 kB" "" --local --offline
memory_warned full-path || fail "the full install path must also pre-check: $(out_of full-path)"

echo "install-images host resource smoke checks passed."
