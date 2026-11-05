# Add a host resource pre-check to the install script

## Goal

`install-images.sh` should warn (never fail) before installing when the Docker host
cannot take the stack — the failure that caused the desktop thrashing was a Docker
Desktop VM with too little RAM and `swap=0` in `.wslconfig`. Catch that at install time
instead of letting computers thrash.

Decisions already confirmed: **warn and continue**, cover **memory + swap**, run on
**both** the `--prepare-only` and full-install paths.

## Where it goes

Inline in `infra/compose/install-images.sh`, modelled on the existing
`egress_rules_unsupported()` (line 336): a helper that decides, and a caller that prints
to stderr and continues. **Not** `check-host.sh` — that is runtime monitoring shipped to
`/usr/local/sbin`, not an install-time gate.

Call site: right after `warn_unpassed_settings` (line 393) and **before** the
`--prepare-only` exit (line 395), so one call covers both paths.

## Checks

**Memory.** `docker info --format '{{.MemTotal}}'` (skip quietly if the daemon is
unreachable). Sum every `mem_limit:` declared in `$COMPOSE_FILE` (8g today) and warn if
the VM's total memory is below that sum — below it the stack is unambiguously
over-subscribed. Also print the per-computer figure (`RAKAZO_COMPUTER_MEMORY` + swap) as
context, but do not fail on it: sizing above the sum of ceilings is an operator judgment,
and folding 6g in would warn on nearly every machine and get ignored.

**Swap.** If the effective `RAKAZO_COMPUTER_SWAP` is non-zero (default 2g), check the
host actually has swap backing:
- native Linux → `SwapTotal` in `/proc/meminfo`
- Windows (MSYS/MINGW/CYGWIN) → `swap=` in `${USERPROFILE}/.wslconfig`
- otherwise (macOS / VM) → unreadable; note it and point at the docs

Warn when swap is requested but the host has none, naming the `.wslconfig` fix.

## Changes

1. **`infra/compose/install-images.sh`**
   - `size_to_bytes()` — `awk`-based normalizer for `6g` / `1536m` / `8GB` / bare bytes;
     empty on unparsable input (handles decimals, where bash arithmetic cannot).
   - `warn_host_resources()` — the two checks above, each printing only on a real problem.
   - Small test seams so the logic is offline-testable, matching how the egress smoke test
     stubs `uname`/`docker`: `${RAKAZO_MEMINFO_PATH:-/proc/meminfo}` and
     `${RAKAZO_WSLCONFIG_PATH:-$USERPROFILE/.wslconfig}`.
   - Call it in both paths.

2. **`infra/compose/install-images-resources.smoke.sh`** (new) — picked up automatically by
   `run-smokes.sh`. Cases: enough memory (silent); too little memory (warns with both
   figures); Linux swap present (silent); Linux `SwapTotal:0` (warns); Windows `swap=0`
   (warns); Windows `swap=8GB` (silent); decimal/two-suffix sizes parse.

3. **`docs/self-host.md`** — a short note that the installer pre-checks host memory and
   swap, next to the existing swap requirement at lines 106-110.

## Verification

- `bash infra/compose/run-smokes.sh` (also runs under the `compose-installer-smoke.test.ts`
  vitest, which invokes it).
- Confirm the warning fires here: this host reports `MemTotal` ≈ 5.8 GB against the 8 GB
  sum, so the memory warning is expected to appear.
