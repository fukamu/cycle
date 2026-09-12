#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/../..")"
test_root="$(mktemp -d)"
trap 'rm -rf -- "${test_root}"' EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

expect_failure() {
  local description="$1"
  shift
  if "$@" >"${test_root}/last-output" 2>&1; then
    fail "${description} unexpectedly succeeded"
  fi
}

move_exact_line_to_start() {
  local file="$1"
  local line="$2"
  local next="${file}.fixture-next"
  if ! FUKAMU_FIXTURE_LINE="${line}" awk '
    BEGIN {
      line = ENVIRON["FUKAMU_FIXTURE_LINE"]
      print line
    }
    $0 == line {
      matches++
      next
    }
    { print }
    END { if (matches != 1) exit 1 }
  ' "${file}" >"${next}"; then
    rm -f -- "${next}"
    fail "fixture expected one exact wiring line in ${file}"
  fi
  mv -- "${next}" "${file}"
}

new_fixture() {
  local name="$1"
  local fixture="${test_root}/${name}"
  local target
  mkdir -p -- \
    "${fixture}/.fukamu/playbook" \
    "${fixture}/.github/workflows" \
    "${fixture}/docs" \
    "${fixture}/scripts/lib" \
    "${fixture}/scripts/tests"
  cp -- \
    "${repo_root}/.fukamu/playbook/PLAYBOOK.md" \
    "${repo_root}/.fukamu/playbook/config.json" \
    "${repo_root}/.fukamu/playbook/lock.json" \
    "${repo_root}/.fukamu/playbook/overrides.json" \
    "${repo_root}/.fukamu/playbook/validate.py" \
    "${fixture}/.fukamu/playbook/"
  cp -- \
    "${repo_root}/.github/workflows/playbook.yml" \
    "${fixture}/.github/workflows/playbook.yml"
  cp -- \
    "${repo_root}/AGENTS.md" \
    "${repo_root}/README.md" \
    "${fixture}/"
  for target in \
    'docs/closed-beta-admission.md' \
    'docs/database.md' \
    'docs/design.md' \
    'docs/development.md' \
    'docs/environment.md' \
    'docs/operations.md'; do
    cp -- "${repo_root}/${target}" "${fixture}/${target}"
  done
  cp -- \
    "${repo_root}/scripts/check-config-parity.sh" \
    "${repo_root}/scripts/check-docs.sh" \
    "${repo_root}/scripts/check-playbook-adoption.sh" \
    "${repo_root}/scripts/check-security.sh" \
    "${repo_root}/scripts/validate-playbook-config.mjs" \
    "${fixture}/scripts/"
  cp -- "${repo_root}/scripts/tests/run.sh" "${fixture}/scripts/tests/run.sh"
  cp -- \
    "${repo_root}/scripts/lib/common.sh" \
    "${repo_root}/scripts/lib/security-tools.sh" \
    "${fixture}/scripts/lib/"
  chmod +x \
    "${fixture}/scripts/check-playbook-adoption.sh" \
    "${fixture}/scripts/validate-playbook-config.mjs" \
    "${fixture}/.fukamu/playbook/validate.py"
  printf '%s\n' "${fixture}"
}

"${repo_root}/scripts/check-playbook-adoption.sh" >/dev/null \
  || fail "current Playbook adoption failed offline validation"

fixture="$(new_fixture tampered-bundle)"
printf '%s\n' 'tampered' >>"${fixture}/.fukamu/playbook/PLAYBOOK.md"
expect_failure "tampered vendored bundle" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

fixture="$(new_fixture tampered-validator-execution-order)"
validator_execution_marker="${test_root}/tampered-validator-executed"
printf '%s\n' \
  '#!/usr/bin/env python3' \
  'from pathlib import Path' \
  "Path('${validator_execution_marker}').touch()" \
  >"${fixture}/.fukamu/playbook/validate.py"
expect_failure "tampered validator before independent byte validation" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"
[[ ! -e "${validator_execution_marker}" ]] \
  || fail "offline adoption check executed a validator before verifying its bytes"

fixture="$(new_fixture nonempty-overrides)"
printf '%s\n' '{"schemaVersion":1,"overrides":[{}]}' \
  >"${fixture}/.fukamu/playbook/overrides.json"
expect_failure "non-empty unapproved override" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

fixture="$(new_fixture missing-rule-trace)"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.ruleMappings.pop();
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
' "${fixture}/.fukamu/playbook/config.json"
expect_failure "missing Playbook rule trace" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

fixture="$(new_fixture nonexistent-local-section)"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.ruleMappings[0].localSections[0] = "AGENTS.md#Missing heading";
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
' "${fixture}/.fukamu/playbook/config.json"
expect_failure "nonexistent local owner section" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

fixture="$(new_fixture fenced-local-section-decoy)"
sed -i 's/^## Source of Truth$/Source of Truth/' "${fixture}/AGENTS.md"
# shellcheck disable=SC2016 # The Markdown fence is literal fixture content.
printf '\n```text\n## Source of Truth\n```\n' >>"${fixture}/AGENTS.md"
expect_failure "fenced code is not a local owner section" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"
grep -Fq -- "local section heading is not exact" "${test_root}/last-output" \
  || fail "fenced heading decoy failed outside the exact-heading validation"

fixture="$(new_fixture workflow-bypass)"
sed -i \
  's#python3 .fukamu/playbook/validate.py --consumer .#true#' \
  "${fixture}/.github/workflows/playbook.yml"
expect_failure "Playbook workflow validator bypass" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

fixture="$(new_fixture worktree-rule-missing)"
sed -i 's/PE-WRK-002/PE-WRK-MISSING/g' "${fixture}/AGENTS.md"
expect_failure "missing PE-WRK-002 repository routing" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

fixture="$(new_fixture missing-check-docs-wiring)"
sed -i '/check-playbook-adoption[.]sh/d' "${fixture}/scripts/check-docs.sh"
expect_failure "missing Playbook required gate wiring: check-docs.sh" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

fixture="$(new_fixture duplicate-docs-wiring)"
# shellcheck disable=SC2016 # The sed program matches a literal fixture variable reference.
sed -i \
  '/bash "${candidate_root}\/scripts\/check-playbook-adoption[.]sh"/p' \
  "${fixture}/scripts/check-docs.sh"
expect_failure "duplicate Playbook documentation gate wiring" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

fixture="$(new_fixture misordered-check-docs-wiring)"
# shellcheck disable=SC2016 # The move helper receives one literal fixture command.
move_exact_line_to_start \
  "${fixture}/scripts/check-docs.sh" \
  'bash "${candidate_root}/scripts/check-playbook-adoption.sh"'
expect_failure "misordered Playbook required gate wiring: check-docs.sh" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"
grep -Fq -- "does not run the Playbook check at the approved boundary" \
  "${test_root}/last-output" \
  || fail "misordered Playbook wiring did not report its approved boundary: check-docs.sh"

fixture="$(new_fixture tampered-signer-fingerprint)"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const lock = JSON.parse(fs.readFileSync(path, "utf8"));
  lock.tagSignerFingerprint = "0000000000000000000000000000000000000000";
  fs.writeFileSync(path, JSON.stringify(lock, null, 2) + "\n");
' "${fixture}/.fukamu/playbook/lock.json"
expect_failure "unapproved Playbook signer fingerprint" \
  bash "${fixture}/scripts/check-playbook-adoption.sh"

source_checker="${repo_root}/scripts/check-playbook-adoption.sh"
# shellcheck disable=SC2016 # These are literal source-contract fragments.
for required_source_contract in \
  'security_validate_git_repository_inputs "${source_repository}"' \
  'reject_source_signature_execution_config "${source_repository}"' \
  'remote get-url origin' \
  'rev-parse --verify "refs/tags/${tag}^{}"' \
  'verify-tag --raw "${tag}"' \
  'cat-file -e "${revision}^{commit}"' \
  'verify_pinned_source_bytes' \
  '--source-repository "${source_repository}"'; do
  grep -Fq -- "${required_source_contract}" "${source_checker}" \
    || fail "source-backed verifier is missing: ${required_source_contract}"
done

if grep -Eq 'git[[:space:]]+(clone|fetch|pull)' "${source_checker}"; then
  fail "source-backed verifier must not perform an implicit network update"
fi

byte_source="${test_root}/source-bytes"
mkdir -p -- "${byte_source}/scripts"
cp -- \
  "${repo_root}/.fukamu/playbook/PLAYBOOK.md" \
  "${byte_source}/PLAYBOOK.md"
cp -- \
  "${repo_root}/.fukamu/playbook/validate.py" \
  "${byte_source}/scripts/validate.py"
git -C "${byte_source}" init --quiet
git -C "${byte_source}" add --all
git -c commit.gpgSign=false -C "${byte_source}" \
  -c user.name='Playbook test' \
  -c user.email='playbook-test@example.invalid' \
  commit --quiet --message='fixture source'
byte_revision="$(git -C "${byte_source}" rev-parse HEAD)"

# shellcheck source=scripts/check-playbook-adoption.sh
source "${source_checker}"
approved_fingerprint='021197A6B3877512E7B708CA8538108E74DEE186'
approved_signature_evidence="[GNUPG:] VALIDSIG ${approved_fingerprint} 2026-01-01 0 4 0 1 10 00 0 ${approved_fingerprint}"
signature_evidence_matches_fingerprint \
  "${approved_signature_evidence}" "${approved_fingerprint}" \
  || fail "approved single Playbook signer fingerprint was rejected"
if signature_evidence_matches_fingerprint \
  '[GNUPG:] VALIDSIG 0000000000000000000000000000000000000000' \
  "${approved_fingerprint}"; then
  fail "wrong Playbook signer fingerprint was accepted"
fi
if signature_evidence_matches_fingerprint \
  '[GNUPG:] GOODSIG 8538108E74DEE186 Playbook test' \
  "${approved_fingerprint}"; then
  fail "missing Playbook VALIDSIG evidence was accepted"
fi
if signature_evidence_matches_fingerprint \
  "${approved_signature_evidence}"$'\n'"${approved_signature_evidence}" \
  "${approved_fingerprint}"; then
  fail "multiple Playbook VALIDSIG records were accepted"
fi
fixture="$(new_fixture independent-source-byte-match)"
comparison_root="${test_root}/comparison-valid"
mkdir -- "${comparison_root}"
verify_pinned_source_bytes \
  "${byte_source}" "${fixture}" "${byte_revision}" "${comparison_root}" \
  || fail "independent source byte comparison rejected matching bytes"

fixture="$(new_fixture self-attesting-validator)"
printf '%s\n' 'raise SystemExit(0)' >>"${fixture}/.fukamu/playbook/validate.py"
validator_hash="$(sha256sum -- "${fixture}/.fukamu/playbook/validate.py" | awk '{print $1}')"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const hash = process.argv[2];
  const lock = JSON.parse(fs.readFileSync(path, "utf8"));
  lock.validatorSha256 = hash;
  fs.writeFileSync(path, JSON.stringify(lock, null, 2) + "\n");
' "${fixture}/.fukamu/playbook/lock.json" "${validator_hash}"
comparison_root="${test_root}/comparison-self-attesting-validator"
mkdir -- "${comparison_root}"
expect_failure "candidate validator and lock self-attestation" \
  verify_pinned_source_bytes \
  "${byte_source}" "${fixture}" "${byte_revision}" "${comparison_root}"

fixture="$(new_fixture self-attesting-bundle)"
printf '%s\n' 'self-attested bundle change' >>"${fixture}/.fukamu/playbook/PLAYBOOK.md"
bundle_hash="$(sha256sum -- "${fixture}/.fukamu/playbook/PLAYBOOK.md" | awk '{print $1}')"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const hash = process.argv[2];
  const lock = JSON.parse(fs.readFileSync(path, "utf8"));
  lock.bundleSha256 = hash;
  fs.writeFileSync(path, JSON.stringify(lock, null, 2) + "\n");
' "${fixture}/.fukamu/playbook/lock.json" "${bundle_hash}"
comparison_root="${test_root}/comparison-self-attesting-bundle"
mkdir -- "${comparison_root}"
expect_failure "candidate bundle and lock self-attestation" \
  verify_pinned_source_bytes \
  "${byte_source}" "${fixture}" "${byte_revision}" "${comparison_root}"

signature_source="${test_root}/signature-config-source"
mkdir -- "${signature_source}"
git -C "${signature_source}" init --quiet
printf '%s\n' 'fixture' >"${signature_source}/README.md"
git -C "${signature_source}" add --all
git -c commit.gpgSign=false -C "${signature_source}" \
  -c user.name='Playbook test' \
  -c user.email='playbook-test@example.invalid' \
  commit --quiet --message='fixture source'
git -C "${signature_source}" remote add origin \
  https://github.com/fukamu/product-engineering-playbook.git
signature_marker="${test_root}/repository-gpg-program-executed"
signature_helper="${test_root}/repository-gpg-program"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  "touch '${signature_marker}'" \
  'exit 1' \
  >"${signature_helper}"
chmod +x "${signature_helper}"
git -C "${signature_source}" config --local gpg.program "${signature_helper}"
expect_failure "repository-configured signature helper" \
  bash "${source_checker}" --source-repository "${signature_source}"
grep -Fq -- "Source repository contains execution-affecting local gpg configuration" \
  "${test_root}/last-output" \
  || fail "repository gpg.program fixture failed outside the local config boundary"
[[ ! -e "${signature_marker}" ]] \
  || fail "source-backed verification executed repository-local gpg.program"

printf '%s\n' "Playbook adoption tests passed."
