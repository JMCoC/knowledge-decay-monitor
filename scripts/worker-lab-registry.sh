#!/usr/bin/env bash
set -euo pipefail

registry=ghcr.io
repository=ghcr.io/jmcoc/kdm-ingestion-lab
package_endpoint=users/JMCoC/packages/container/kdm-ingestion-lab
sha_pattern='^[0-9a-f]{40}$'
digest_pattern='^sha256:[0-9a-f]{64}$'

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ ${GITHUB_ACTIONS:-} == true && ${GITHUB_EVENT_NAME:-} == push &&
  ${GITHUB_REF:-} == refs/heads/develop && ${GITHUB_REPOSITORY:-} == JMCoC/knowledge-decay-monitor &&
  ${TESTED_SHA:-} =~ $sha_pattern && $TESTED_SHA == "${GITHUB_SHA:-}" ]] ||
  fail "Worker Lab requires a tested push to develop."

mode=${1:-}
case "$mode" in
  publish)
    tag="$repository:sha-$TESTED_SHA"
    local_image="kdm-ingestion:$TESTED_SHA"
    image_id=$(docker image inspect --format '{{.Id}}' "$local_image")
    [[ $image_id =~ $digest_pattern && $image_id == "${TESTED_IMAGE_ID:-}" ]] ||
      fail "The local image does not match the image verified by the smoke test."

    package_missing=false
    if visibility=$(gh api "$package_endpoint" --jq '.visibility' 2>&1); then
      [[ $visibility == private ]] || fail "The GHCR package must be private."
    elif [[ $visibility == *'(HTTP 404)'* ]]; then
      package_missing=true
    else
      fail "Could not verify the existing GHCR package visibility."
    fi
    ;;
  pull)
    image_ref=${IMAGE_REF:-}
    image_id=${TESTED_IMAGE_ID:-}
    [[ $image_ref == "$repository@"* && ${image_ref#*@} =~ $digest_pattern &&
      $image_id =~ $digest_pattern ]] || fail "Invalid Worker Lab image reference or ID."
    ;;
  *) fail "Usage: worker-lab-registry.sh <publish|pull>" ;;
esac

# Each invocation starts with an empty config. Leave runner-wide Docker credentials untouched.
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -f -- "$DOCKER_CONFIG/config.json"; rmdir -- "$DOCKER_CONFIG"' EXIT
if ! printf '%s' "${GH_TOKEN:?}" | docker login "$registry" --username "${GITHUB_ACTOR:?}" --password-stdin >/dev/null 2>&1; then
  fail "Could not authenticate to GHCR."
fi
unset GH_TOKEN

if [[ $mode == publish ]]; then
  if pull_result=$(docker pull "$tag" 2>&1); then
    [[ $(docker image inspect --format '{{.Id}}' "$tag") == "$image_id" ]] ||
      fail "The existing SHA tag identifies a different image."
  else
    case "${pull_result,,}" in
      *'manifest unknown'*) ;;
      *'denied: denied'*|*unauthorized*|*'requested access to the resource is denied'*)
        # A package that has never been created can deny an authenticated pull.
        [[ $package_missing == true ]] || fail "GHCR denied access to the existing package."
        ;;
      *) fail "Could not check whether the SHA tag exists in GHCR." ;;
    esac
    docker tag "$local_image" "$tag"
    docker push "$tag"
    if ! pull_result=$(docker pull "$tag" 2>&1); then
      fail "Could not resolve the SHA tag after publishing."
    fi
    [[ $(docker image inspect --format '{{.Id}}' "$tag") == "$image_id" ]] ||
      fail "The published tag does not identify the tested image."
  fi

  digest=$(sed -n 's/^Digest: //p' <<< "$pull_result")
  [[ $digest =~ $digest_pattern ]] || fail "GHCR did not return a valid manifest digest."
  image_ref="$repository@$digest"
else
  docker pull "$image_ref"
  [[ $(docker image inspect --format '{{.Id}}' "$image_ref") == "$image_id" ]] ||
    fail "The image downloaded by digest does not match the tested image."
fi

docker logout "$registry" >/dev/null

if [[ $mode == publish ]]; then
  # Pair a successful authenticated pull with an authorization failure for the same digest.
  if anonymous_result=$(docker manifest inspect "$image_ref" 2>&1); then
    fail "The published GHCR digest is available without authentication."
  fi
  case "${anonymous_result,,}" in
    *'denied: denied'*|*unauthorized*|*'authentication required'*|*'requested access to the resource is denied'*) ;;
    *) fail "Could not verify that GHCR blocks anonymous access to the published digest." ;;
  esac

  printf 'image_ref=%s\nimage_id=%s\n' "$image_ref" "$image_id" >> "$GITHUB_OUTPUT"
fi
