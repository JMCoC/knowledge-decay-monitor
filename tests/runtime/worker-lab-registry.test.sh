#!/usr/bin/env bash
set -euo pipefail
temporary_dir=$(mktemp -d)
trap 'rm -f -- "$temporary_dir/docker" "$temporary_dir/gh" "$temporary_dir/trace" "$temporary_dir/out" "$temporary_dir/result" "$temporary_dir/pushed"; rmdir -- "$temporary_dir"' EXIT
export CASE_ROOT=$temporary_dir
export PATH="$temporary_dir:$PATH"
export GITHUB_ACTIONS=true GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/develop
export GITHUB_REPOSITORY=JMCoC/knowledge-decay-monitor GITHUB_ACTOR=maintainer
export TESTED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export GITHUB_SHA=$TESTED_SHA
export TESTED_IMAGE_ID=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export REGISTRY_DIGEST=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
export IMAGE_REF=ghcr.io/jmcoc/kdm-ingestion-lab@$REGISTRY_DIGEST
export GITHUB_OUTPUT="$temporary_dir/out"

cat > "$temporary_dir/gh" <<'EOF'
#!/usr/bin/env bash
case "$SCENARIO" in
  new|legacy_new) printf 'gh: Not Found (HTTP 404)\n' >&2; exit 1 ;;
  public) printf 'public\n' ;;
  *) printf 'private\n' ;;
esac
EOF
cat > "$temporary_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1 ${2:-}" >> "$CASE_ROOT/trace"
case "$1" in
  login)
    token=$(cat)
    [[ $token == stub-token ]] || exit 1
    printf '{ "auths": {} }' > "$DOCKER_CONFIG/config.json"
    ;;
  logout) rm -f -- "$DOCKER_CONFIG/config.json" ;;
  image)
    if [[ $SCENARIO == conflict && $* == *ghcr.io/* ]]; then printf 'sha256:wrong\n'
    else printf '%s\n' "$TESTED_IMAGE_ID"
    fi
    ;;
  pull)
    case "$SCENARIO" in
      new)
        if [[ ! -f "$CASE_ROOT/pushed" ]]; then
          printf 'Error response from daemon: error from registry: denied\ndenied\n'; exit 1
        fi ;;
      legacy_new)
        if [[ ! -f "$CASE_ROOT/pushed" ]]; then printf 'denied: denied\n'; exit 1; fi ;;
      denied)
        printf 'Error response from daemon: error from registry: denied\ndenied\n'; exit 1 ;;
      missing_reference)
        if [[ ! -f "$CASE_ROOT/pushed" ]]; then
          printf 'Error response from daemon: failed to resolve reference "%s": %s: not found\n' "$2" "$2"
          exit 1
        fi ;;
      missing_layer)
        printf 'failed to unpack: content digest %s: not found\n' "$REGISTRY_DIGEST"; exit 1 ;;
      missing)
        if [[ ! -f "$CASE_ROOT/pushed" ]]; then printf 'manifest unknown\n'; exit 1; fi ;;
      outage) printf 'network failed\n'; exit 1 ;;
    esac
    printf 'Digest: %s\n' "$REGISTRY_DIGEST"
    ;;
  tag) ;;
  push) touch "$CASE_ROOT/pushed" ;;
  manifest)
    [[ ! -f "$DOCKER_CONFIG/config.json" ]] || exit 2
    if [[ $SCENARIO == anonymously_readable ]]; then exit 0; fi
    printf 'Get "https://ghcr.io/v2/jmcoc/kdm-ingestion-lab/manifests/%s": denied\n' "${3#*@}"
    exit 1
    ;;
  *) exit 3 ;;
esac
EOF
chmod +x "$temporary_dir/docker" "$temporary_dir/gh"

run() {
  : > "$temporary_dir/trace"
  : > "$temporary_dir/out"
  rm -f -- "$temporary_dir/pushed"
  actual=0
  SCENARIO=$1 GH_TOKEN=stub-token bash scripts/worker-lab-registry.sh "$2" > "$temporary_dir/result" 2>&1 || actual=$?
  if [[ $actual != "$3" ]]; then
    cat "$temporary_dir/result"
    printf '%s failed\n' "$1"
    exit 1
  fi
  if [[ $4 == yes ]]; then
    grep -q '^push ' "$temporary_dir/trace"
  elif grep -q '^push ' "$temporary_dir/trace"; then
    printf '%s attempted an unexpected push\n' "$1" >&2
    exit 1
  fi
  if grep -q 'stub-token' "$temporary_dir/result"; then
    printf '%s leaked the simulated token\n' "$1" >&2
    exit 1
  fi
  if [[ -n ${5:-} ]]; then grep -Fq "$5" "$temporary_dir/result"; fi
  printf 'PASS %s %s\n' "$1" "$2"
}

run new publish 0 yes "Attempting first publication"
grep -qx "image_ref=$IMAGE_REF" "$temporary_dir/out"
run legacy_new publish 0 yes
run missing publish 0 yes "SHA tag is absent"
run missing_reference publish 0 yes "SHA tag is absent"
run missing_layer publish 1 no "reason=unclassified_response"
run denied publish 1 no "GHCR denied access to the existing package."
run existing publish 0 no
run conflict publish 1 no
run outage publish 1 no "reason=unclassified_response"
run public publish 1 no
run anonymously_readable publish 1 no
run existing pull 0 no
grep -Fxq "pull $IMAGE_REF" "$temporary_dir/trace"
run conflict pull 1 no
GITHUB_EVENT_NAME=pull_request run pull_request publish 1 no "requires a tested push to develop"
