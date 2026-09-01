#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/../..")"
checker="${repo_root}/scripts/check-supply-chain.mjs"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/fukamu-cycle-supply-chain-test.XXXXXXXX")"
trap 'rm -rf -- "${test_root}"' EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

new_fixture() {
  local name="$1"
  local fixture="${test_root}/${name}"
  mkdir -p -- "${fixture}/.github/workflows" "${fixture}/scripts/lib"
  cp -- "${repo_root}"/.github/workflows/*.yml "${fixture}/.github/workflows/"
  cp -- "${repo_root}/.github/dependabot.yml" "${fixture}/.github/dependabot.yml"
  cp -- "${repo_root}/Dockerfile" "${repo_root}/Dockerfile.local" \
    "${repo_root}/compose.local.yaml" "${repo_root}/README.md" "${fixture}/"
  cp -R -- "${repo_root}/docs" "${fixture}/docs"
  cp -- "${repo_root}/scripts/lib/security-tools.sh" \
    "${repo_root}/scripts/lib/tool-images.sh" "${fixture}/scripts/lib/"
  cp -- "${repo_root}/scripts/check-before-commit.sh" \
    "${repo_root}/scripts/check-shell.sh" \
    "${repo_root}/scripts/invoke-sqlc.sh" \
    "${repo_root}/scripts/reset-local-db.sh" "${fixture}/scripts/"
  printf '%s\n' "${fixture}"
}

replace_first() {
  local file="$1"
  local old="$2"
  local replacement="$3"
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const old = process.argv[2];
    const replacement = process.argv[3];
    const source = fs.readFileSync(file, "utf8");
    const offset = source.indexOf(old);
    if (offset < 0) process.exit(1);
    fs.writeFileSync(
      file,
      source.slice(0, offset) + replacement + source.slice(offset + old.length),
    );
  ' "${file}" "${old}" "${replacement}" \
    || fail "could not construct negative fixture ${file}"
}

assert_policy_failure() {
  local description="$1"
  local fixture="$2"
  local output="${test_root}/last-output"
  local status=0
  node "${checker}" "${fixture}" >"${output}" 2>&1 || status=$?
  [[ "${status}" -eq 1 ]] \
    || fail "${description} returned ${status}; expected a policy rejection"
  grep -Eq '^[^:]+:[1-9][0-9]*: ' "${output}" \
    || fail "${description} did not return a stable path/line diagnostic"
}

checkout_pin='actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'
actionlint_pin='docker://rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 # v1.7.12'
postgres_pin='postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2'
syntax_pin='docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e'
golang_alpine_pin='golang:1.27.0-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc'
shellcheck_pin='koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d'

fixture="$(new_fixture valid)"
node "${checker}" "${fixture}" >"${test_root}/positive-output" \
  || fail "canonical immutable supply-chain fixture was rejected"
grep -Fq -- 'Supply-chain policy passed' "${test_root}/positive-output" \
  || fail "canonical fixture did not report policy success"
pass "canonical Actions/Compose grouping and individual Docker updates pass"

fixture="$(new_fixture mutable-action)"
replace_first "${fixture}/.github/workflows/ci.yml" \
  "${checkout_pin}" 'actions/checkout@v7 # v7.0.1'
assert_policy_failure "mutable GitHub Action tag" "${fixture}"

fixture="$(new_fixture missing-action-version-comment)"
replace_first "${fixture}/.github/workflows/ci.yml" \
  "${checkout_pin}" 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
assert_policy_failure "Action SHA without a version comment" "${fixture}"

fixture="$(new_fixture mutable-docker-action)"
replace_first "${fixture}/.github/workflows/ci.yml" \
  "${actionlint_pin}" 'docker://rhysd/actionlint:1.7.12 # v1.7.12'
assert_policy_failure "Docker Action without a digest" "${fixture}"

fixture="$(new_fixture mutable-workflow-image)"
replace_first "${fixture}/.github/workflows/ci.yml" \
  "${postgres_pin}" 'postgres:18.6-alpine3.24'
assert_policy_failure "workflow service image without a digest" "${fixture}"

fixture="$(new_fixture mutable-buildkit-syntax)"
replace_first "${fixture}/Dockerfile" "${syntax_pin}" 'docker/dockerfile:1.7'
assert_policy_failure "BuildKit syntax image without a digest" "${fixture}"

fixture="$(new_fixture mutable-base-image)"
replace_first "${fixture}/Dockerfile" \
  "${golang_alpine_pin}" 'golang:1.27.0-alpine'
assert_policy_failure "Dockerfile base image without a digest" "${fixture}"

fixture="$(new_fixture mutable-compose-image)"
replace_first "${fixture}/compose.local.yaml" \
  "${postgres_pin}" 'postgres:18.6-alpine3.24'
assert_policy_failure "Compose image without a digest" "${fixture}"

fixture="$(new_fixture mutable-tool-image)"
replace_first "${fixture}/scripts/lib/tool-images.sh" \
  "${shellcheck_pin}" 'koalaman/shellcheck:v0.11.0'
assert_policy_failure "operational tool image without a digest" "${fixture}"

fixture="$(new_fixture duplicate-tool-image-constant)"
shellcheck_declaration="readonly SUPPLY_CHAIN_SHELLCHECK_IMAGE='${shellcheck_pin}'"
replace_first "${fixture}/scripts/lib/tool-images.sh" \
  "${shellcheck_declaration}" \
  "${shellcheck_declaration}"$'\n'"${shellcheck_declaration}"
assert_policy_failure "duplicate operational tool image constant" "${fixture}"

fixture="$(new_fixture cross-file-digest-drift)"
replace_first "${fixture}/compose.local.yaml" \
  "${postgres_pin}" \
  'postgres:18.6-alpine3.24@sha256:0000000000000000000000000000000000000000000000000000000000000000'
assert_policy_failure "same image tag with conflicting digests" "${fixture}"

dependabot_docker_block=$'  - package-ecosystem: "docker"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n      day: "tuesday"\n      time: "05:00"\n      timezone: "Asia/Tokyo"\n    open-pull-requests-limit: 1'

fixture="$(new_fixture dependabot-docker-group-reintroduced)"
replace_first "${fixture}/.github/dependabot.yml" \
  "${dependabot_docker_block}" \
  $'  - package-ecosystem: "docker"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n      day: "tuesday"\n      time: "05:00"\n      timezone: "Asia/Tokyo"\n    groups:\n      docker-version-updates:\n        applies-to: "version-updates"\n        patterns:\n          - "*"\n    open-pull-requests-limit: 1'
assert_policy_failure "Dependabot Docker wildcard group reintroduced" "${fixture}"

fixture="$(new_fixture dependabot-docker-schedule-drift)"
replace_first "${fixture}/.github/dependabot.yml" \
  "${dependabot_docker_block}" \
  $'  - package-ecosystem: "docker"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n      day: "thursday"\n      time: "05:00"\n      timezone: "Asia/Tokyo"\n    open-pull-requests-limit: 1'
assert_policy_failure "Dependabot Docker schedule drift" "${fixture}"

fixture="$(new_fixture dependabot-docker-open-limit-drift)"
replace_first "${fixture}/.github/dependabot.yml" \
  "${dependabot_docker_block}" \
  $'  - package-ecosystem: "docker"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n      day: "tuesday"\n      time: "05:00"\n      timezone: "Asia/Tokyo"\n    open-pull-requests-limit: 2'
assert_policy_failure "Dependabot Docker open PR limit drift" "${fixture}"

fixture="$(new_fixture dependabot-actions-group-removed)"
replace_first "${fixture}/.github/dependabot.yml" \
  $'    groups:\n      github-actions-version-updates:\n        applies-to: "version-updates"\n        patterns:\n          - "*"\n' ''
assert_policy_failure "Dependabot GitHub Actions group removed" "${fixture}"

fixture="$(new_fixture dependabot-compose-group-removed)"
replace_first "${fixture}/.github/dependabot.yml" \
  $'    groups:\n      docker-compose-version-updates:\n        applies-to: "version-updates"\n        patterns:\n          - "*"\n' ''
assert_policy_failure "Dependabot Docker Compose group removed" "${fixture}"

fixture="$(new_fixture dependabot-ecosystem-drift)"
replace_first "${fixture}/.github/dependabot.yml" \
  '  - package-ecosystem: "docker-compose"' \
  '  - package-ecosystem: "npm"'
assert_policy_failure "Dependabot ecosystem drift" "${fixture}"

fixture="$(new_fixture local-alias-misuse)"
replace_first "${fixture}/compose.local.yaml" \
  "${postgres_pin}" 'fukamu-cycle-local-app:dev'
assert_policy_failure "local build alias used by a pull-only service" "${fixture}"

fixture="$(new_fixture mutable-documentation)"
replace_first "${fixture}/docs/database.md" \
  "${postgres_pin}" 'postgres:18.6-alpine3.24'
assert_policy_failure "documentation with a mutable copied image command" "${fixture}"

fixture="$(new_fixture symlinked-policy-input)"
unlink -- "${fixture}/.github/dependabot.yml"
ln -s -- "${repo_root}/.github/dependabot.yml" \
  "${fixture}/.github/dependabot.yml"
assert_policy_failure "symlinked supply-chain policy input" "${fixture}"

pass "mutable refs, drift, update-policy changes, local alias misuse, and symlinks fail closed"
