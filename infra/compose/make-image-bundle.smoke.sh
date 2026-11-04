#!/usr/bin/env bash
# Exercise the offline bundle packer without a Docker daemon or a real image.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$scratch/bin"
# Stand-in for the images the packer inspects: everything "present" unless listed in ABSENT.
cat > "$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == info ]]; then exit 0; fi
# Handle `save` before the `$1 $2` match below: its second word is the `-o` flag, so it would
# never match a `save)` pattern.
if [[ "$1" == save ]]; then
  out=""
  previous=""
  for arg in "$@"; do
    if [[ "$previous" == -o ]]; then out="$arg"; previous=""; continue; fi
    [[ "$arg" == save || "$arg" == -o ]] && { previous="$arg"; continue; }
    printf '%s\n' "$arg" >> "$SAVED"
  done
  [[ -n "$out" ]] || exit 1
  printf 'fake-tar\n' > "$out"
  exit 0
fi
case "$1 $2" in
  image\ inspect)
    # The packer uses this two ways: a `--format` query, and a bare existence check. The format
    # string is the word after --format, not a fixed position.
    ref=""
    format=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == --format ]]; then format="$arg"; previous=""; continue; fi
      [[ "$arg" == --format ]] && { previous="$arg"; continue; }
      [[ "$arg" == image || "$arg" == inspect ]] && continue
      ref="$arg"
    done
    if grep -Fxq "$ref" "${ABSENT:-/nonexistent}" 2>/dev/null; then exit 1; fi
    if [[ -n "$format" ]]; then
      case "$format" in
        '{{.Size}}') echo "${IMAGE_SIZE:-1048576}" ;;
        *RepoDigests*) echo "${ref%%[:@]*}@sha256:$(printf '%064d' 7)" ;;
        *) echo sha256:$(printf '%064d' 7) ;;
      esac
      exit 0
    fi
    printf '%s\n' "$ref" >> "$INSPECTED"
    exit 0
    ;;
esac
exit 1
FAKE
# The packer resolves the bundle tag with `git describe`; keep it off the real repository.
cat > "$scratch/bin/git" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *'describe'* ]] || exit 1
[[ -n "${GIT_TAG:-}" ]] || exit 1
printf '%s\n' "$GIT_TAG"
FAKE
cat > "$scratch/bin/df" <<'FAKE'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/fake 100000000 1 %s 1%% /\n' "${FREE_KB:-50000000}"
FAKE
chmod +x "$scratch/bin/"*
export PATH="$scratch/bin:$PATH"
export INSPECTED="$scratch/inspected"
export SAVED="$scratch/saved"
export RAKAZO_IMAGE=registry.example.test/project/app
export RAKAZO_COMPUTER_IMAGE=registry.example.test/project/computer
bundle() {
  : > "$SAVED"
  : > "$INSPECTED"
  bash "$root/infra/compose/make-image-bundle.sh" --output "$scratch/out" "$@" > "$scratch/log" 2>&1
}

# A locally resolvable tag is used as-is, and the four images are saved together.
GIT_TAG=v1.2.3 bundle --tag v1.2.3 || fail 'bundling with present images failed'
grep -Fxq 'registry.example.test/project/app:v1.2.3' "$SAVED" || fail 'app image was not saved'
grep -Fxq 'registry.example.test/project/computer:v1.2.3' "$SAVED" || fail 'computer image was not saved'
grep -Fq 'postgres:16@sha256:' "$SAVED" || fail 'pinned Postgres digest was not saved'
grep -Fxq 'busybox:1' "$SAVED" || fail 'busybox image was not saved'
tarball="$scratch/out/rakazo-offline-bundle-v1.2.3.tar.gz"
[[ -f "$tarball" ]] || fail 'tarball was not written'

# The bundle must carry every file install-images.sh --offline resolves locally. List once:
# `grep -q` exits at the first match, which would SIGPIPE tar and fail the pipeline under pipefail.
tar -tzf "$tarball" > "$scratch/members"
for member in \
  rakazo-offline-bundle-v1.2.3/install-images.sh \
  rakazo-offline-bundle-v1.2.3/docker-compose.images.yml \
  rakazo-offline-bundle-v1.2.3/.env.images.example \
  rakazo-offline-bundle-v1.2.3/restrict-computer-egress.sh \
  rakazo-offline-bundle-v1.2.3/images/rakazo-images.tar; do
  grep -Fxq "$member" "$scratch/members" || fail "bundle is missing $member"
done
# The walkthrough ships inside the bundle: the target host cannot open the repository.
grep -Fxq 'rakazo-offline-bundle-v1.2.3/OFFLINE.md' "$scratch/members" ||
  fail 'bundle is missing the offline walkthrough'
# The operator needs to know which tags were saved, since the env example defaults to edge.
tar -xzOf "$tarball" rakazo-offline-bundle-v1.2.3/BUNDLE_ENV > "$scratch/bundle-env" ||
  fail 'could not read BUNDLE_ENV out of the bundle'
grep -Fxq 'RAKAZO_IMAGE_TAG=v1.2.3' "$scratch/bundle-env" ||
  fail 'BUNDLE_ENV does not record the saved tag'

# A repository override that already carries a tag must not gain a second one.
RAKAZO_COMPUTER_IMAGE=registry.example.test/project/computer:stale bundle --tag v1.2.3 ||
  fail 'bundling with a pre-tagged override failed'
grep -Fxq 'registry.example.test/project/computer:v1.2.3' "$SAVED" ||
  fail 'pre-tagged repository override produced a malformed reference'
if grep -Fq ':stale' "$SAVED"; then fail 'override tag leaked into the saved reference'; fi

# Without --tag, the nearest git tag is used; without one, it falls back to edge.
unset GIT_TAG
bundle || fail 'bundling without a tag or git tag failed'
[[ -f "$scratch/out/rakazo-offline-bundle-edge.tar.gz" ]] || fail 'edge fallback tag was not used'

# A missing image must fail and leave no bundle behind. Export the stub controls: the fake
# `docker` and `df` are subprocesses and only see exported variables.
rm -f "$scratch/out"/*.tar.gz
printf '%s\n' 'registry.example.test/project/app:v9.9.9' > "$scratch/absent"
export ABSENT="$scratch/absent"
bundle --tag v9.9.9 && fail 'missing image was ignored'
unset ABSENT
[[ -z "$(ls -A "$scratch/out" 2>/dev/null)" ]] || fail 'a bundle was written despite a missing image'

# Insufficient free space must fail before saving anything.
export FREE_KB=1
bundle --tag v1.2.3 && fail 'insufficient disk space was ignored'
[[ ! -s "$SAVED" ]] || fail 'images were saved despite insufficient disk space'
unset FREE_KB

# A dry run inspects but writes nothing.
rm -f "$scratch/out"/*.tar.gz
bundle --dry-run --tag v1.2.3 || fail 'dry run failed'
if ls "$scratch/out"/*.tar.gz >/dev/null 2>&1; then fail 'dry run wrote a tarball'; fi
[[ ! -s "$SAVED" ]] || fail 'dry run saved images'

echo 'Offline image bundle smoke passed.'
