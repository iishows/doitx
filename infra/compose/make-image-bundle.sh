#!/usr/bin/env bash
# Build a self-contained, air-gapped bundle of the images and files this stack needs.
#
# The bundle is consumed on the target host by `bash install-images.sh --offline`, which keeps
# the bundled Compose/env files and refuses to pull: everything must already be loaded. This
# script is the producing half of that path and deliberately does not reimplement any install
# logic.
#
# Images are taken from `docker save` of images already present locally by default; building from
# source is opt-in via --build because the computer image takes a long time to build.
set -Eeuo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
compose_dir="$root/infra/compose"
compose_file="$compose_dir/docker-compose.images.yml"

readonly INSTALLER="install-images.sh"
readonly EGRESS_SCRIPT="restrict-computer-egress.sh"
readonly ENV_EXAMPLE=".env.images.example"
readonly BUNDLED_COMPOSE="docker-compose.images.yml"

fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "==> $*"; }

usage() {
  cat >&2 <<'USAGE'
Usage: bash infra/compose/make-image-bundle.sh [options]

Packages the app, computer, Postgres and busybox images plus the Compose/installer files into
one tarball that `install-images.sh --offline` accepts on a host with no network.

Options:
  --tag <tag>       Tag recorded for the app/computer images (default: git describe, else edge)
  --output <dir>    Directory to write the tarball into (default: dist/offline-bundle)
  --build           Build app and computer from this checkout instead of using local images
  --dry-run         Print what would be saved; write nothing
  -h, --help        Show this help

Environment overrides (same names the Compose file reads):
  RAKAZO_IMAGE, RAKAZO_IMAGE_TAG
  RAKAZO_COMPUTER_IMAGE, RAKAZO_COMPUTER_IMAGE_TAG
  POSTGRES_IMAGE, BUSYBOX_IMAGE
  RAKAZO_BUILD_COMPUTER_BROWSER   Browser baked into the computer image when --build is used
USAGE
}

tag=""
output_dir="$root/dist/offline-bundle"
build=false
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      [[ $# -ge 2 ]] || fail "--tag needs a value."
      tag="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || fail "--output needs a value."
      output_dir="$2"
      shift 2
      ;;
    --build)
      build=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      fail "unknown argument: $1"
      ;;
  esac
done

# --dry-run inspects the host, so docker is still required; gzip/sha256sum are only needed to
# actually write the bundle.
for command_name in docker tar sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "'$command_name' is required."
done
if [[ "$dry_run" != true ]]; then
  command -v gzip >/dev/null 2>&1 || fail "'gzip' is required."
fi
[[ -f "$compose_file" ]] || fail "missing $compose_file."
for required in "$INSTALLER" "$EGRESS_SCRIPT" "$ENV_EXAMPLE"; do
  [[ -f "$compose_dir/$required" ]] || fail "missing infra/compose/$required; cannot bundle it."
done

# Read the image defaults out of the Compose file rather than hardcoding them, so a re-pinned
# Postgres digest or a new repository path flows through without editing this script.
compose_image_default() {
  local variable="$1" first
  # `head` would exit early and SIGPIPE sed under pipefail, so take the first match inline.
  first="$(sed -n "s/^[[:space:]]*image:[[:space:]]*\${${variable}:-\\([^}]*\\)}.*/\1/p" "$compose_file")"
  echo "${first%%$'\n'*}"
}

postgres_ref="${POSTGRES_IMAGE:-$(compose_image_default POSTGRES_IMAGE)}"
busybox_ref="${BUSYBOX_IMAGE:-$(compose_image_default BUSYBOX_IMAGE)}"
[[ -n "$postgres_ref" ]] || fail "could not read the POSTGRES_IMAGE default from $compose_file."
[[ -n "$busybox_ref" ]] || fail "could not read the BUSYBOX_IMAGE default from $compose_file."

app_repo="${RAKAZO_IMAGE:-$(compose_image_default RAKAZO_IMAGE)}"
computer_repo="${RAKAZO_COMPUTER_IMAGE:-$(compose_image_default RAKAZO_COMPUTER_IMAGE)}"

# A repository override may already carry a tag (for example a stale
# RAKAZO_COMPUTER_IMAGE=registry/computer:edge). Drop it so the bundle tag below is the only one.
strip_tag() {
  local ref="$1" last="${1##*/}"
  if [[ "$last" == *:* ]]; then
    echo "${ref%:*}"
  else
    echo "$ref"
  fi
}
app_repo="$(strip_tag "$app_repo")"
computer_repo="$(strip_tag "$computer_repo")"

if [[ -z "$tag" ]]; then
  tag="${RAKAZO_IMAGE_TAG:-}"
fi
if [[ -z "$tag" ]]; then
  tag="$(git -C "$root" describe --tags --abbrev=0 2>/dev/null || true)"
fi
if [[ -z "$tag" ]]; then
  tag="edge"
fi

app_ref="${app_repo}:${tag}"
computer_ref="${computer_repo}:${tag}"

images=("$app_ref" "$computer_ref" "$postgres_ref" "$busybox_ref")

require_image() {
  local ref="$1"
  docker image inspect "$ref" >/dev/null 2>&1
}

if [[ "$dry_run" == true ]]; then
  note "dry run: no files will be written"
  echo "  bundle version tag: $tag"
  echo "  output directory:   $output_dir"
  echo "  images to save:"
  for ref in "${images[@]}"; do
    if command -v docker >/dev/null 2>&1 && require_image "$ref"; then
      echo "    $ref (present)"
    else
      echo "    $ref (NOT present locally)"
    fi
  done
  echo "  files to include:"
  printf '    %s\n' "$INSTALLER" "$BUNDLED_COMPOSE" "$ENV_EXAMPLE" "$EGRESS_SCRIPT"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "'docker' is required."
docker info >/dev/null 2>&1 || fail "cannot talk to the Docker daemon."

if [[ "$build" == true ]]; then
  note "building app image $app_ref from this checkout"
  docker build --build-arg "GIT_SHA=$(git -C "$root" rev-parse HEAD)" -t "$app_ref" -f "$compose_dir/Dockerfile" "$root" ||
    fail "app image build failed."
  note "building computer image $computer_ref (this is slow)"
  docker build \
    --build-arg "BROWSER=${RAKAZO_BUILD_COMPUTER_BROWSER:-chromium}" \
    -t "$computer_ref" -f "$root/infra/sandboxes/computer/Dockerfile" "$root/infra/sandboxes/computer" ||
    fail "computer image build failed."
fi

missing=()
for ref in "${images[@]}"; do
  require_image "$ref" || missing+=("$ref")
done
if ((${#missing[@]} > 0)); then
  printf 'FAIL: these images are not present locally:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  cat >&2 <<'HINT'
Pull them (`docker pull <ref>`) or pass --build for the app and computer images. To bundle a
different tag, re-run with `--tag <tag>` matching an image that exists locally.
HINT
  exit 1
fi

# `docker save` writes a tar roughly the size of the uncompressed layers, so the host needs room
# for the images plus that copy. Estimate with the image sizes and refuse rather than filling the
# disk halfway through.
size_file="$(mktemp)"
trap 'rm -f "$size_file"' EXIT
for ref in "${images[@]}"; do
  docker image inspect "$ref" --format '{{.Size}}'
done >"$size_file"
needed_bytes="$(awk '{ total += $1 } END { print total + 0 }' "$size_file")"
mkdir -p "$output_dir" 2>/dev/null || true
available_bytes="$(df -Pk "$output_dir" 2>/dev/null | awk 'NR == 2 { print $4 * 1024 }')"
if [[ -n "$available_bytes" ]] && ((needed_bytes > available_bytes)); then
  needed_gib="$(awk -v b="$needed_bytes" 'BEGIN { printf "%.1f", b / 1073741824 }')"
  available_gib="$(awk -v b="$available_bytes" 'BEGIN { printf "%.1f", b / 1073741824 }')"
  cat >&2 <<MESSAGE
FAIL: not enough free space in ${output_dir}.
  images need about ${needed_gib} GiB, ${available_gib} GiB is available.
Free space first (for example `docker rmi` an older app image, or pass --output to another
filesystem), then re-run.
MESSAGE
  exit 1
fi

bundle_name="rakazo-offline-bundle-${tag}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage" "$size_file"' EXIT
bundle_dir="$stage/$bundle_name"
mkdir -p "$bundle_dir/images"

note "saving ${#images[@]} images into images/rakazo-images.tar"
docker save -o "$bundle_dir/images/rakazo-images.tar" "${images[@]}" || fail "docker save failed."

# Flat layout on purpose: install-images.sh resolves the Compose file, env example and egress
# script relative to the working directory, so they must sit next to it.
install -m 755 "$compose_dir/$INSTALLER" "$bundle_dir/$INSTALLER"
install -m 644 "$compose_dir/$BUNDLED_COMPOSE" "$bundle_dir/$BUNDLED_COMPOSE"
install -m 644 "$compose_dir/$ENV_EXAMPLE" "$bundle_dir/$ENV_EXAMPLE"
install -m 755 "$compose_dir/$EGRESS_SCRIPT" "$bundle_dir/$EGRESS_SCRIPT"

# The env example defaults the image tags to `edge`. Record the tags actually saved so the
# operator does not have to guess why Compose cannot find the loaded images.
cat >"$bundle_dir/BUNDLE_ENV" <<ENVFILE
# Values for .env that match the images inside this bundle.
# install-images.sh copies .env.images.example to .env; set these afterwards.
RAKAZO_IMAGE=$app_repo
RAKAZO_IMAGE_TAG=$tag
RAKAZO_COMPUTER_IMAGE=$computer_repo
RAKAZO_COMPUTER_IMAGE_TAG=$tag
POSTGRES_IMAGE=$postgres_ref
BUSYBOX_IMAGE=$busybox_ref
ENVFILE

cat >"$bundle_dir/README-OFFLINE.md" <<'README'
# Rakazo offline bundle

Everything the stack needs on a host with no network access.

## Load and start

```bash
tar -xzf rakazo-offline-bundle-*.tar.gz
cd rakazo-offline-bundle-*
docker load -i images/rakazo-images.tar
bash install-images.sh --offline
```

Run `install-images.sh` from inside this directory: it resolves the Compose file, env example
and egress script relative to the working directory.

`BUNDLE_ENV` lists the image tags held in this bundle. After the installer creates `.env`, apply
those values there so Compose resolves the loaded images instead of trying to pull them.

See `OFFLINE.md` in this directory for the full walkthrough (Chinese), including the reverse
proxy, health checks, upgrades and troubleshooting. `IMAGES.txt` lists the image digests.
README

# Ship the walkthrough itself: the target host cannot open the repository or the docs site.
offline_doc="$root/docs/self-host-offline-zh.md"
if [[ -f "$offline_doc" ]]; then
  install -m 644 "$offline_doc" "$bundle_dir/OFFLINE.md"
fi

# Provenance: which images are in here, at which digests.
{
  echo "bundle: $bundle_name"
  echo "created from: $(git -C "$root" rev-parse HEAD 2>/dev/null || echo 'unknown revision')"
  echo
  for ref in "${images[@]}"; do
    digest="$(docker image inspect "$ref" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}')"
    echo "$ref"
    echo "  $digest"
  done
} >"$bundle_dir/IMAGES.txt"

note "writing checksums"
(
  cd "$bundle_dir"
  # Images tar is large; hash it and the small files together for a single integrity manifest.
  checksum_targets=(images/rakazo-images.tar "$INSTALLER" "$BUNDLED_COMPOSE" "$ENV_EXAMPLE" "$EGRESS_SCRIPT")
  [[ -f OFFLINE.md ]] && checksum_targets+=(OFFLINE.md)
  sha256sum "${checksum_targets[@]}" >SHA256SUMS
)

tarball="$output_dir/$bundle_name.tar.gz"
note "compressing into $tarball"
mkdir -p "$output_dir"
tar -czf "$tarball" -C "$stage" "$bundle_name" || fail "could not write $tarball."

final_size="$(du -h "$tarball" | awk '{ print $1 }')"
cat <<DONE

Bundle ready: $tarball ($final_size)

Copy it to the target host, then:
  tar -xzf $(basename "$tarball")
  cd $bundle_name
  docker load -i images/rakazo-images.tar
  bash install-images.sh --offline
DONE
