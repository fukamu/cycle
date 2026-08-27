#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/../..")"
# shellcheck source=scripts/lib/common.sh
source "${repo_root}/scripts/lib/common.sh"
# shellcheck source=scripts/lib/security-tools.sh
source "${repo_root}/scripts/lib/security-tools.sh"

require_command docker
require_command git
require_command cmp
require_command find
require_command base64
require_command script
require_command tar
require_command zip
require_local_docker_context >/dev/null

test_root="$(mktemp -d "${TMPDIR:-/tmp}/fukamu-cycle-security-test.XXXXXXXX")"
chmod 700 "${test_root}"
go_cache_root="${test_root}/go-cache"
trivy_cache_root="${test_root}/trivy-cache"
output_root="${test_root}/output"
mkdir -p -- "${go_cache_root}" "${trivy_cache_root}" "${output_root}"
gitleaks_config="${test_root}/gitleaks.toml"
trivy_config="${test_root}/trivy.yaml"

fixture_image_tag="fukamu-cycle-security:negative-$$-${RANDOM}"
fixture_image_cleanup=false

cleanup_security_tests() {
  local status=$?
  trap - EXIT
  if [[ "${fixture_image_cleanup}" == "true" ]]; then
    if ! security_remove_temporary_image "${fixture_image_tag}"; then
      printf 'not ok - could not remove temporary negative-fixture image tag %s\n' "${fixture_image_tag}" >&2
      status=1
    fi
  fi
  if ! chmod -R u+w "${test_root}" 2>/dev/null; then
    printf '%s\n' "not ok - could not make the temporary security-test directory removable" >&2
    status=1
  fi
  if ! rm -rf -- "${test_root}" 2>/dev/null; then
    printf '%s\n' "not ok - could not remove the temporary security-test directory" >&2
    status=1
  fi
  exit "${status}"
}
trap cleanup_security_tests EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

create_nested_tar_fixture() {
  local fixture_root="$1"
  local destination="$2"
  local depth="$3"
  local secret_value="$4"
  local current
  local next
  local level

  mkdir -p -- "${fixture_root}" "$(dirname -- "${destination}")"
  printf 'token=%s\n' "${secret_value}" >"${fixture_root}/secret.txt"
  current="${fixture_root}/secret.txt"
  for ((level = 1; level <= depth; level += 1)); do
    next="${fixture_root}/layer-${level}.tar"
    tar -C "$(dirname -- "${current}")" -cf "${next}" "$(basename -- "${current}")"
    current="${next}"
  done
  cp -- "${current}" "${destination}"
}

expect_failure() {
  local description="$1"
  shift
  if "$@"; then
    fail "${description} unexpectedly succeeded"
  fi
}

add_evil_lock_identity() {
  local lock_path="$1"
  local next_path="${lock_path}.fixture-next"

  awk '
    /^snapshots:$/ {
      matches += 1
      print "  evil-package@1.0.0:"
      print "    resolution: {integrity: sha512-YWJjZA==}"
      print ""
      print
      print ""
      print "  evil-package@1.0.0: {}"
      next
    }
    { print }
    END { if (matches != 1) exit 1 }
  ' "${lock_path}" >"${next_path}" || fail "could not add evil lock identity fixture"
  mv -- "${next_path}" "${lock_path}"
}

assert_report_classification() {
  local expected_status="$1"
  local report_mode="$2"
  local report_path="$3"
  local description="$4"
  local actual_status=0

  security_classify_json_report "${report_path}" "${report_mode}" >/dev/null || actual_status=$?
  if [[ "${actual_status}" -ne "${expected_status}" ]]; then
    fail "${description} returned classifier status ${actual_status}, expected ${expected_status}"
  fi
}

assert_immutable_image_pin() {
  local image_reference="$1"
  local description="$2"
  local immutable_image_pattern='^[^@[:space:]]+:[v]?[0-9]+\.[0-9]+\.[0-9]+[-A-Za-z0-9.]*@sha256:[0-9a-f]{64}$'

  [[ "${image_reference}" =~ ${immutable_image_pattern} ]] || fail "${description} is not pinned by version tag and sha256 digest"
}

assert_snapshot_scanner_wiring() {
  local helper_name="$1"
  local expected_fragment="$2"
  local expected_count="$3"
  local main_script="${repo_root}/scripts/check-security.sh"
  local helper_count
  local snapshot_count

  helper_count="$(awk -v needle="${helper_name} " 'index($0, needle) { count += 1 } END { print count + 0 }' "${main_script}")"
  snapshot_count="$(awk -v needle="${expected_fragment}" 'index($0, needle) { count += 1 } END { print count + 0 }' "${main_script}")"
  [[ "${helper_count}" -eq "${expected_count}" && "${snapshot_count}" -eq "${expected_count}" ]] \
    || fail "${helper_name} is not wired exclusively to the candidate snapshot"
}

security_write_gitleaks_config "${gitleaks_config}" || fail "could not create the script-owned Gitleaks test configuration"
security_write_trivy_config "${trivy_config}" || fail "could not create the script-owned Trivy test configuration"

ignore_fixture="${test_root}/ignore-policy"
mkdir -p -- "${ignore_fixture}"
printf '%s\n' '# exact synthetic fingerprint' '0000000000000000000000000000000000000000:path/to/test.txt:generic-api-key:1' >"${ignore_fixture}/valid"
security_validate_gitleaks_ignore "${ignore_fixture}/valid" || fail "exact Gitleaks fingerprint policy was rejected"
printf '%s\n' 'generic-api-key' >"${ignore_fixture}/malformed"
expect_failure "malformed Gitleaks ignore" security_validate_gitleaks_ignore "${ignore_fixture}/malformed"
printf '%s\n' '0000000000000000000000000000000000000000:*/test.txt:generic-api-key:1' >"${ignore_fixture}/broad"
expect_failure "broad Gitleaks ignore" security_validate_gitleaks_ignore "${ignore_fixture}/broad"
pass "Gitleaks ignore policy accepts only exact commit/path/rule/line fingerprints"
expected_repository_fingerprints=(
  '3690977d68515b1dd494d04aa2c4ba71f510e693:backend/internal/httpapi/router_test.go:generic-api-key:67'
  '065175fc0737f3c1aad504dac45ccc7c6f6c36b9:frontend/playwright.config.ts:generic-api-key:44'
  'b1e272ba46603dcd89800f0383cd6f70f70ea40e:backend/internal/httpapi/router_test.go:generic-api-key:67'
  '8d0be23e39684cca97634b0f22ec094bb4389603:frontend/playwright.config.ts:generic-api-key:44'
  '1ff7a9aa3b896ace4b40c5d8f027c78ed7bc2837:frontend/playwright.config.ts:generic-api-key:44'
)
for expected_fingerprint in "${expected_repository_fingerprints[@]}"; do
  grep -Fqx -- "${expected_fingerprint}" "${repo_root}/.gitleaksignore" \
    || fail "repository Gitleaks fingerprint set is missing ${expected_fingerprint}"
done
repository_fingerprint_count="$(awk '!/^[[:space:]]*(#|$)/ { count += 1 } END { print count + 0 }' "${repo_root}/.gitleaksignore")"
[[ "${repository_fingerprint_count}" -eq "${#expected_repository_fingerprints[@]}" ]] \
  || fail "repository Gitleaks fingerprint set contains an unreviewed entry"
unset expected_fingerprint expected_repository_fingerprints repository_fingerprint_count

assert_immutable_image_pin "${SECURITY_PNPM_IMAGE}" "pnpm scanner runtime"
assert_immutable_image_pin "${SECURITY_NODE_IMAGE}" "JSON classifier runtime"
assert_immutable_image_pin "${SECURITY_GO_IMAGE}" "Go scanner runtime"
assert_immutable_image_pin "${SECURITY_GITLEAKS_IMAGE}" "Gitleaks scanner"
assert_immutable_image_pin "${SECURITY_TRIVY_IMAGE}" "Trivy scanner"
assert_immutable_image_pin "${SECURITY_TERRAFORM_IMAGE}" "Terraform syntax parser"
[[ "${SECURITY_GOSEC_VERSION}" == 'v2.22.11' ]] || fail "gosec version pin changed from v2.22.11"
[[ "${SECURITY_GOVULNCHECK_VERSION}" == 'v1.7.0' ]] || fail "govulncheck version pin changed from v1.7.0"
[[ "${SECURITY_LEGACY_BINARY_BLOB_OID}" == 'ac78d653896d639a4b9f93ae26d5009fcc39a4db' ]] || fail "legacy binary blob allowlist changed without review"
[[ "${SECURITY_LEGACY_BINARY_BLOB_SIZE}" == '9181184' ]] || fail "legacy binary blob size changed without review"
expected_reviewed_blob_oids='00642c8c91ee37c45ce5cea406b4a102997e56cc:02e64350beb2a70155b8762b997bfe948152834b:23d1b139137ce39bf71ebe874614b86d71257ae6:479191b9e5f3ea733e5f78842e82f6df0eac3dd9:5bd22d43e489ec1c6c569faf3086d9fa559261e0:67c128fd0ebd0fba57ba07b3bce8f73d5bb276ba:bb0622f7e163fcd1516e2687e54e9e1b066904ea:cc5455b909a9f30a703ee6808dac190f86b47d7b:cfaf27abc1661d80a66743d5ec10dd13f4822bda:d1cf70a25ef1e83ba780a74dc5c988b18469eec4:daad0b38b5af009b74f9e83fdc1bd64ae5b55b68:ea5334dbb949fda452cd93e10dc7f36a04c2661c:fdc893ea0889c20926d1f3f3e7a131a20def837e'
[[ "${SECURITY_NORMALIZED_TEXT_REVIEWED_BLOB_OIDS}" == "${expected_reviewed_blob_oids}" ]] \
  || fail "normalized-text reviewed blob set changed without exact review"
unset expected_reviewed_blob_oids
[[ "${SECURITY_VULNERABLE_FIXTURE_IMAGE}" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || fail "vulnerable image fixture is not digest-pinned"
pass "security scanner images and Go tools are immutable, exact-version inputs"
trusted_git_body="$(declare -f trusted_git)" || fail "could not inspect trusted Git wrapper"
trusted_git_clean_environment_count="$(awk 'index($0, "env -i") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
trusted_git_git_pager_count="$(awk 'index($0, "GIT_PAGER=cat") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
trusted_git_pager_count="$(awk 'index($0, "PAGER=cat") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
trusted_git_no_pager_count="$(awk 'index($0, "--no-pager") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
trusted_git_fsmonitor_count="$(awk 'index($0, "core.fsmonitor=false") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
trusted_git_untracked_cache_count="$(awk 'index($0, "core.untrackedCache=false") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
trusted_git_hooks_count="$(awk 'index($0, "core.hooksPath=/dev/null") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
trusted_git_no_lazy_fetch_count="$(awk 'index($0, "GIT_NO_LAZY_FETCH=1") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
trusted_git_no_replace_count="$(awk 'index($0, "GIT_NO_REPLACE_OBJECTS=1") { count += 1 } END { print count + 0 }' <<<"${trusted_git_body}")"
[[ "${trusted_git_clean_environment_count}" -eq 1 && "${trusted_git_git_pager_count}" -eq 1 &&
  "${trusted_git_pager_count}" -eq 1 && "${trusted_git_no_pager_count}" -eq 1 && "${trusted_git_fsmonitor_count}" -eq 1 &&
  "${trusted_git_untracked_cache_count}" -eq 1 && "${trusted_git_hooks_count}" -eq 1 &&
  "${trusted_git_no_lazy_fetch_count}" -eq 1 && "${trusted_git_no_replace_count}" -eq 1 ]] \
  || fail "trusted Git wrapper does not clear ambient inputs and disable repository execution hooks"
commit_gate_trusted_git_count="$(awk 'index($0, "trusted_git") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-before-commit.sh")"
check_trusted_git_count="$(awk 'index($0, "trusted_git") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check.sh")"
docs_snapshot_trusted_git_count="$(awk 'index($0, "trusted_git") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/lib/docs-config-candidate-snapshot.sh")"
security_snapshot_trusted_git_count="$(awk 'index($0, "trusted_git") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/lib/security-tools.sh")"
security_entry_trusted_git_count="$(awk 'index($0, "trusted_git") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
[[ "${commit_gate_trusted_git_count}" -eq 14 && "${check_trusted_git_count}" -eq 1 &&
  "${docs_snapshot_trusted_git_count}" -eq 3 && "${security_snapshot_trusted_git_count}" -eq 3 &&
  "${security_entry_trusted_git_count}" -eq 2 ]] \
  || fail "a repository check bypasses the trusted Git wrapper"
unset trusted_git_body trusted_git_clean_environment_count trusted_git_git_pager_count trusted_git_pager_count trusted_git_no_pager_count trusted_git_fsmonitor_count trusted_git_untracked_cache_count trusted_git_hooks_count trusted_git_no_lazy_fetch_count trusted_git_no_replace_count commit_gate_trusted_git_count check_trusted_git_count docs_snapshot_trusted_git_count security_snapshot_trusted_git_count security_entry_trusted_git_count
pass "host Git calls clear ambient Git inputs and disable fsmonitor, untracked-cache, hooks, and replacement objects"
commit_gate_trusted_diff_count="$(awk 'index($0, "trusted_git diff ") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-before-commit.sh")"
commit_gate_hardened_diff_count="$(awk 'index($0, "trusted_git diff --no-ext-diff --no-textconv ") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-before-commit.sh")"
[[ "${commit_gate_trusted_diff_count}" -eq 8 && "${commit_gate_hardened_diff_count}" -eq 8 ]] \
  || fail "commit gate Git diffs permit external diff or textconv execution"
unset commit_gate_trusted_diff_count commit_gate_hardened_diff_count
pass "commit gate disables external diff and textconv helpers on all trusted Git diffs"

for gitleaks_helper in \
  security_run_gitleaks_history \
  security_run_gitleaks_staged \
  security_run_gitleaks_directory \
  security_run_gitleaks_normalized_text; do
  gitleaks_helper_body="$(declare -f "${gitleaks_helper}")" || fail "could not inspect ${gitleaks_helper}"
  gitleaks_docker_count="$(awk 'index($0, "docker run --rm") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_network_count="$(awk 'index($0, "--network none") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_read_only_count="$(awk 'index($0, "--read-only") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_tmpfs_count="$(awk 'index($0, "--tmpfs") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_source_ro_count="$(awk 'index($0, "${source_root}:/source:ro") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_config_ro_count="$(awk 'index($0, "${config_path}:/gitleaks/config.toml:ro") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_user_count="$(awk 'index($0, "--user") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_safe_directory_count="$(awk 'index($0, "GIT_CONFIG_VALUE_0=/source") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_no_lazy_fetch_count="$(awk 'index($0, "GIT_NO_LAZY_FETCH=1") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  gitleaks_no_replace_count="$(awk 'index($0, "GIT_NO_REPLACE_OBJECTS=1") { count += 1 } END { print count + 0 }' <<<"${gitleaks_helper_body}")"
  [[ "${gitleaks_docker_count}" -eq 1 && "${gitleaks_network_count}" -eq 1 &&
    "${gitleaks_read_only_count}" -eq 1 && "${gitleaks_tmpfs_count}" -eq 1 &&
    "${gitleaks_source_ro_count}" -eq 1 && "${gitleaks_config_ro_count}" -eq 1 &&
    "${gitleaks_user_count}" -eq 1 && "${gitleaks_safe_directory_count}" -eq 1 &&
    "${gitleaks_no_lazy_fetch_count}" -eq 1 && "${gitleaks_no_replace_count}" -eq 1 ]] \
    || fail "${gitleaks_helper} does not isolate its secret-bearing scanner process or disable replacement objects"
done
unset gitleaks_helper gitleaks_helper_body gitleaks_docker_count gitleaks_network_count gitleaks_read_only_count gitleaks_tmpfs_count gitleaks_source_ro_count gitleaks_config_ro_count gitleaks_user_count gitleaks_safe_directory_count gitleaks_no_lazy_fetch_count gitleaks_no_replace_count
pass "every secret-bearing Gitleaks process is networkless and read-only"

assert_networkless_read_only_parser() {
  local helper_name="$1"
  local expected_commands="$2"
  local helper_body
  local docker_count
  local network_count
  local read_only_count
  local tmpfs_count

  helper_body="$(declare -f "${helper_name}")" || fail "could not inspect ${helper_name}"
  docker_count="$(awk 'index($0, "docker run --rm") { count += 1 } END { print count + 0 }' <<<"${helper_body}")"
  network_count="$(awk 'index($0, "--network none") { count += 1 } END { print count + 0 }' <<<"${helper_body}")"
  read_only_count="$(awk 'index($0, "--read-only") { count += 1 } END { print count + 0 }' <<<"${helper_body}")"
  tmpfs_count="$(awk 'index($0, "--tmpfs") { count += 1 } END { print count + 0 }' <<<"${helper_body}")"
  [[ "${docker_count}" -eq "${expected_commands}" &&
    "${network_count}" -eq "${expected_commands}" &&
    "${read_only_count}" -eq "${expected_commands}" &&
    "${tmpfs_count}" -eq "${expected_commands}" ]] \
    || fail "${helper_name} has a mutable or networked local parser command"
}

assert_networkless_read_only_parser security_validate_text_inventory 1
assert_networkless_read_only_parser security_validate_git_repository_inputs 1
assert_networkless_read_only_parser security_validate_node_audit_policy 4
assert_networkless_read_only_parser security_run_trivy_config 1
assert_networkless_read_only_parser security_validate_terraform_module_policy 1
assert_networkless_read_only_parser security_classify_json_report 1
assert_networkless_read_only_parser security_run_supply_chain_policy 1
node_policy_body="$(declare -f security_validate_node_audit_policy)" || fail "could not inspect Node audit policy helper"
trivy_config_body="$(declare -f security_run_trivy_config)" || fail "could not inspect Trivy config helper"
terraform_module_policy_body="$(declare -f security_validate_terraform_module_policy)" || fail "could not inspect Terraform module policy helper"
report_classifier_body="$(declare -f security_classify_json_report)" || fail "could not inspect report classifier"
supply_chain_policy_body="$(declare -f security_run_supply_chain_policy)" || fail "could not inspect supply-chain policy helper"
node_policy_source_ro_count="$(awk 'index($0, "${source_root}:/workspace:ro") { count += 1 } END { print count + 0 }' <<<"${node_policy_body}")"
trivy_source_ro_count="$(awk 'index($0, "${source_root}:/workspace:ro") { count += 1 } END { print count + 0 }' <<<"${trivy_config_body}")"
trivy_config_ro_count="$(awk 'index($0, "${config_path}:/trivy/config.yaml:ro") { count += 1 } END { print count + 0 }' <<<"${trivy_config_body}")"
terraform_module_source_ro_count="$(awk 'index($0, "${source_root}:/workspace:ro") { count += 1 } END { print count + 0 }' <<<"${terraform_module_policy_body}")"
classifier_input_ro_count="$(awk 'index($0, ":/input:ro") { count += 1 } END { print count + 0 }' <<<"${report_classifier_body}")"
supply_chain_source_ro_count="$(awk 'index($0, "${source_root}:/workspace:ro") { count += 1 } END { print count + 0 }' <<<"${supply_chain_policy_body}")"
text_inventory_body="$(declare -f security_validate_text_inventory)" || fail "could not inspect approved-text inventory helper"
git_repository_body="$(declare -f security_validate_git_repository_inputs)" || fail "could not inspect Git repository guard"
text_inventory_ro_count="$(awk 'index($0, "${source_root}:/source:ro") { count += 1 } END { print count + 0 }' <<<"${text_inventory_body}")"
git_repository_ro_count="$(awk 'index($0, "${source_root}:/source:ro") { count += 1 } END { print count + 0 }' <<<"${git_repository_body}")"
[[ "${node_policy_source_ro_count}" -eq 4 && "${trivy_source_ro_count}" -eq 1 &&
  "${trivy_config_ro_count}" -eq 1 && "${terraform_module_source_ro_count}" -eq 1 && "${classifier_input_ro_count}" -eq 1 &&
  "${supply_chain_source_ro_count}" -eq 1 &&
  "${text_inventory_ro_count}" -eq 1 && "${git_repository_ro_count}" -eq 1 ]] \
  || fail "a network-independent parser has a writable candidate or report input"
unset node_policy_body trivy_config_body terraform_module_policy_body report_classifier_body supply_chain_policy_body node_policy_source_ro_count trivy_source_ro_count trivy_config_ro_count terraform_module_source_ro_count classifier_input_ro_count supply_chain_source_ro_count text_inventory_body git_repository_body text_inventory_ro_count git_repository_ro_count
pass "all network-independent candidate and report parsers are networkless and read-only"

text_policy_fixture="${test_root}/approved-text-policy"
mkdir -p -- "${text_policy_fixture}/candidate"
printf '%s\n' 'plain candidate text' >"${text_policy_fixture}/candidate/plain.txt"
security_validate_candidate_text_files "${text_policy_fixture}/candidate" \
  || fail "approved candidate text fixture was rejected"

printf 'binary\0content\n' >"${text_policy_fixture}/candidate/binary.txt"
expect_failure \
  "NUL-containing candidate fixture" \
  security_validate_candidate_text_files \
  "${text_policy_fixture}/candidate"
unlink -- "${text_policy_fixture}/candidate/binary.txt"

printf '%s\n' 'GIF89a printable content' >"${text_policy_fixture}/candidate/printable.gif"
expect_failure \
  "printable GIF candidate fixture" \
  security_validate_candidate_text_files \
  "${text_policy_fixture}/candidate"
unlink -- "${text_policy_fixture}/candidate/printable.gif"

printf '%s\n' 'PK printable archive marker' >"${text_policy_fixture}/candidate/printable.zip"
expect_failure \
  "printable ZIP candidate fixture" \
  security_validate_candidate_text_files \
  "${text_policy_fixture}/candidate"
unlink -- "${text_policy_fixture}/candidate/printable.zip"

printf '\377invalid UTF-8\n' >"${text_policy_fixture}/candidate/invalid-utf8.txt"
expect_failure \
  "invalid UTF-8 candidate fixture" \
  security_validate_candidate_text_files \
  "${text_policy_fixture}/candidate"
unlink -- "${text_policy_fixture}/candidate/invalid-utf8.txt"

newline_candidate_path="${text_policy_fixture}/candidate/line"$'\n'"break.txt"
printf '%s\n' 'newline path' >"${newline_candidate_path}"
expect_failure \
  "newline candidate path fixture" \
  security_validate_candidate_text_files \
  "${text_policy_fixture}/candidate"
unlink -- "${newline_candidate_path}"

security_validate_git_repository_inputs "${repo_root}" \
  || fail "current repository Git history inputs were rejected"
security_validate_staged_text_files "${repo_root}" \
  || fail "current staged approved-text inventory was rejected"
security_validate_history_text_files "${repo_root}" \
  || fail "reviewed legacy binary blob identity did not match repository history"

git_guard_repo="${text_policy_fixture}/git-guard"
mkdir -p -- "${git_guard_repo}"
git -C "${git_guard_repo}" init --quiet
printf '%s\n' 'first revision' >"${git_guard_repo}/plain.txt"
git -C "${git_guard_repo}" add plain.txt
git -C "${git_guard_repo}" -c user.name='Git Guard Fixture' -c user.email='git-guard-fixture.invalid@example.invalid' commit --quiet -m first
guarded_original_commit="$(git -C "${git_guard_repo}" rev-parse HEAD)"
printf '%s\n' 'second revision' >"${git_guard_repo}/plain.txt"
git -C "${git_guard_repo}" add plain.txt
git -C "${git_guard_repo}" -c user.name='Git Guard Fixture' -c user.email='git-guard-fixture.invalid@example.invalid' commit --quiet -m second
guarded_replacement_commit="$(git -C "${git_guard_repo}" rev-parse HEAD)"
security_validate_git_repository_inputs "${git_guard_repo}" \
  || fail "self-contained Git fixture was rejected"
fsmonitor_marker="${text_policy_fixture}/fsmonitor-executed"
fsmonitor_hook="${text_policy_fixture}/fsmonitor-hook.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  "printf '%s\\n' executed >$(printf '%q' "${fsmonitor_marker}")" \
  >"${fsmonitor_hook}"
chmod 700 "${fsmonitor_hook}"
git -C "${git_guard_repo}" config --local core.fsmonitor "${fsmonitor_hook}"
trusted_git -C "${git_guard_repo}" ls-files --cached >/dev/null \
  || fail "trusted Git could not read a repository with an overridden fsmonitor config"
[[ ! -e "${fsmonitor_marker}" ]] || fail "trusted Git executed repository fsmonitor code"
expect_failure \
  "Git fsmonitor config fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
git -C "${git_guard_repo}" config --local --unset-all core.fsmonitor
pager_marker="${text_policy_fixture}/pager-executed"
pager_hook="${text_policy_fixture}/pager-hook.sh"
pager_driver="${text_policy_fixture}/pager-driver.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  "printf '%s\n' executed >$(printf '%q' "${pager_marker}")" \
  'cat' \
  >"${pager_hook}"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  "source $(printf '%q' "${repo_root}/scripts/lib/common.sh")" \
  "trusted_git -C $(printf '%q' "${git_guard_repo}") diff --no-ext-diff --no-textconv --check || :" \
  >"${pager_driver}"
chmod 700 "${pager_hook}" "${pager_driver}"
git -C "${git_guard_repo}" config --local core.pager "${pager_hook}"
printf 'second revision with trailing whitespace  \n' >"${git_guard_repo}/plain.txt"
[[ "$(trusted_git -C "${git_guard_repo}" var GIT_PAGER)" == "cat" ]] \
  || fail "trusted Git did not override the repository pager"
script -q -e -c "${pager_driver}" /dev/null >"${output_root}/git-pager-pty.log" 2>&1 \
  || fail "trusted Git pager pseudo-TTY fixture failed"
[[ ! -e "${pager_marker}" ]] || fail "trusted Git executed a repository pager command"
expect_failure \
  "Git pager config fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
printf '%s\n' 'second revision' >"${git_guard_repo}/plain.txt"
git -C "${git_guard_repo}" config --local --unset-all core.pager
git -C "${git_guard_repo}" config --local diff.audit.textconv "sh ${text_policy_fixture}/untrusted-diff-helper.sh"
expect_failure \
  "Git local diff helper config fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
git -C "${git_guard_repo}" config --local --unset-all diff.audit.textconv
included_git_config="${text_policy_fixture}/included-git-config"
printf '%s\n' '[core]' '  pager = cat' >"${included_git_config}"
git -C "${git_guard_repo}" config --local include.path "${included_git_config}"
expect_failure \
  "Git local include config fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
git -C "${git_guard_repo}" config --local --unset-all include.path
git -C "${git_guard_repo}" config --local extensions.worktreeConfig true
expect_failure \
  "Git worktree config scope fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
git -C "${git_guard_repo}" config --local --unset-all extensions.worktreeConfig

promisor_repo="${text_policy_fixture}/promisor-repository"
promisor_marker="${text_policy_fixture}/promisor-helper-executed"
promisor_helper="${text_policy_fixture}/promisor-helper.sh"
mkdir -p -- "${promisor_repo}"
git -C "${promisor_repo}" init --quiet
printf '%s\n' 'promised original blob' >"${promisor_repo}/promised.txt"
git -C "${promisor_repo}" add promised.txt
git -C "${promisor_repo}" -c user.name='Promisor Fixture' -c user.email='promisor-fixture.invalid@example.invalid' commit --quiet -m root
promisor_missing_oid="$(git -C "${promisor_repo}" rev-parse HEAD:promised.txt)"
printf '%s\n' 'staged replacement blob' >"${promisor_repo}/promised.txt"
git -C "${promisor_repo}" add promised.txt
printf '%s\n' \
  '#!/usr/bin/env sh' \
  ": >$(printf '%q' "${promisor_marker}")" \
  'exit 1' \
  >"${promisor_helper}"
chmod 700 "${promisor_helper}"
git -C "${promisor_repo}" config --local core.repositoryformatversion 1
git -C "${promisor_repo}" config --local extensions.partialClone origin
git -C "${promisor_repo}" config --local remote.origin.promisor true
git -C "${promisor_repo}" config --local remote.origin.partialCloneFilter blob:none
git -C "${promisor_repo}" config --local remote.origin.url "ext::${promisor_helper}"
git -C "${promisor_repo}" config --local protocol.ext.allow always
promisor_object_path="${promisor_repo}/.git/objects/${promisor_missing_oid:0:2}/${promisor_missing_oid:2}"
[[ -f "${promisor_object_path}" && ! -L "${promisor_object_path}" ]] \
  || fail "promisor fixture blob was not a removable loose object"
unlink -- "${promisor_object_path}"
expect_failure \
  "Git promisor repository fixture" \
  security_validate_git_repository_inputs \
  "${promisor_repo}"
promisor_diff_status=0
trusted_git -C "${promisor_repo}" diff --no-ext-diff --no-textconv --cached --quiet -- || promisor_diff_status=$?
[[ "${promisor_diff_status}" -ne 0 ]] \
  || fail "missing promised object unexpectedly produced a clean Git diff"
[[ ! -e "${promisor_marker}" ]] \
  || fail "trusted Git executed a partial-clone remote helper"
git -C "${promisor_repo}" config --local --unset-all extensions.partialClone
git -C "${promisor_repo}" config --local --remove-section remote.origin
git -C "${promisor_repo}" config --local --unset-all protocol.ext.allow
expect_failure \
  "Git incomplete object graph fixture" \
  security_validate_git_repository_inputs \
  "${promisor_repo}"

git -C "${git_guard_repo}" replace "${guarded_original_commit}" "${guarded_replacement_commit}"
expect_failure \
  "Git replacement ref fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
git -C "${git_guard_repo}" replace -d "${guarded_original_commit}" >/dev/null
printf '%s\n' "${guarded_replacement_commit}" >"${git_guard_repo}/.git/info/grafts"
expect_failure \
  "legacy Git graft fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
unlink -- "${git_guard_repo}/.git/info/grafts"
printf '%s\n' '/tmp/unapproved-alternate-object-store' >"${git_guard_repo}/.git/objects/info/alternates"
expect_failure \
  "Git alternate object store fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
unlink -- "${git_guard_repo}/.git/objects/info/alternates"
printf '%s\n' 'https://example.invalid/unapproved-objects/' >"${git_guard_repo}/.git/objects/info/http-alternates"
expect_failure \
  "Git HTTP alternate object store fixture" \
  security_validate_git_repository_inputs \
  "${git_guard_repo}"
unlink -- "${git_guard_repo}/.git/objects/info/http-alternates"

text_policy_history="${text_policy_fixture}/history"
mkdir -p -- "${text_policy_history}"
git -C "${text_policy_history}" init --quiet
printf '%s\n' 'benign root' >"${text_policy_history}/historical.txt"
git -C "${text_policy_history}" add historical.txt
git -C "${text_policy_history}" -c user.name='Text Policy Fixture' -c user.email='text-policy-fixture.invalid@example.invalid' commit --quiet -m root
printf 'binary\0historical content\n' >"${text_policy_history}/historical.txt"
git -C "${text_policy_history}" add historical.txt
git -C "${text_policy_history}" -c user.name='Text Policy Fixture' -c user.email='text-policy-fixture.invalid@example.invalid' commit --quiet -m 'unknown non-text blob'
printf '%s\n' 'benign replacement' >"${text_policy_history}/historical.txt"
git -C "${text_policy_history}" add historical.txt
git -C "${text_policy_history}" -c user.name='Text Policy Fixture' -c user.email='text-policy-fixture.invalid@example.invalid' commit --quiet -m 'remove non-text blob'
expect_failure \
  "unknown historical non-text blob fixture" \
  security_validate_history_text_files \
  "${text_policy_history}"

text_path_history="${text_policy_fixture}/history-paths"
mkdir -p -- "${text_path_history}"
git -C "${text_path_history}" init --quiet
git -C "${text_path_history}" symbolic-ref HEAD refs/heads/main
printf '%s\n' 'shared approved content' >"${text_path_history}/shared.txt"
git -C "${text_path_history}" add shared.txt
git -C "${text_path_history}" -c user.name='Text Path Fixture' -c user.email='text-path-fixture.invalid@example.invalid' commit --quiet -m root
git -C "${text_path_history}" checkout --quiet -b hidden-unapproved
cp -- "${text_path_history}/shared.txt" "${text_path_history}/shared.gif"
git -C "${text_path_history}" add shared.gif
git -C "${text_path_history}" -c user.name='Text Path Fixture' -c user.email='text-path-fixture.invalid@example.invalid' commit --quiet -m 'same blob at unapproved path'
git -C "${text_path_history}" checkout --quiet main
expect_failure \
  "unapproved same-OID path on secondary ref fixture" \
  security_validate_history_text_files \
  "${text_path_history}"

unset guarded_original_commit guarded_replacement_commit newline_candidate_path fsmonitor_marker fsmonitor_hook pager_marker pager_hook pager_driver included_git_config promisor_repo promisor_marker promisor_helper promisor_missing_oid promisor_object_path promisor_diff_status
pass "candidate, index, and all-ref history accept only approved text; Git graph overrides and exact legacy-binary drift fail closed"

security_tools_source="${repo_root}/scripts/lib/security-tools.sh"
merge_history_option_count="$(awk 'index($0, "--log-opts=--all --full-history -m --text --no-ext-diff --no-textconv") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
exact_registry_count="$(awk 'index($0, "pnpm --config.manage-package-manager-versions=false --registry=https://registry.npmjs.org/ --ignore-pnpmfile audit") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
gosec_directory_exclusion_count="$(awk 'index($0, "-exclude-dir") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
archive_depth_count="$(awk 'index($0, "--max-archive-depth=5") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
decode_depth_count="$(awk 'index($0, "--max-decode-depth=5") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
unbounded_target_count="$(awk 'index($0, "--max-target-megabytes=0") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
production_cgo_count="$(awk 'index($0, "--env CGO_ENABLED=0") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
production_goos_count="$(awk 'index($0, "--env GOOS=linux") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
go_environment_off_count="$(awk 'index($0, "--env GOENV=off") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
local_go_toolchain_count="$(awk 'index($0, "--env GOTOOLCHAIN=local") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
go_workspace_off_count="$(awk 'index($0, "--env GOWORK=off") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
go_readonly_module_count="$(awk 'index($0, "GOFLAGS=-modcacherw -mod=readonly") { count += 1 } END { print count + 0 }' "${security_tools_source}")"
[[ "${merge_history_option_count}" -eq 1 && "${exact_registry_count}" -eq 1 && "${gosec_directory_exclusion_count}" -eq 0 &&
  "${archive_depth_count}" -eq 4 && "${decode_depth_count}" -eq 4 && "${unbounded_target_count}" -eq 4 &&
  "${production_cgo_count}" -eq 2 && "${production_goos_count}" -eq 2 &&
  "${go_environment_off_count}" -eq 3 && "${local_go_toolchain_count}" -eq 3 && "${go_workspace_off_count}" -eq 3 &&
  "${go_readonly_module_count}" -eq 2 ]] || fail "merge history, exact registry, fixed Go module mode, whole-tree gosec, or bounded Gitleaks coverage regressed"
pass "Gitleaks merge history, pnpm registry, local Go toolchain, and whole-tree gosec coverage are exact"

production_dockerfile="${repo_root}/Dockerfile"
docker_go_download_policy_count="$(awk 'index($0, "RUN GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=-mod=readonly go mod download") { count += 1 } END { print count + 0 }' "${production_dockerfile}")"
docker_go_build_policy_count="$(awk 'index($0, "RUN CGO_ENABLED=0 GOOS=linux GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=-mod=readonly") { count += 1 } END { print count + 0 }' "${production_dockerfile}")"
docker_go_build_command_count="$(awk 'index($0, "go build -trimpath -ldflags=\"-s -w\" -o /out/server ./cmd/server") { count += 1 } END { print count + 0 }' "${production_dockerfile}")"
docker_environment_off_count="$(awk 'index($0, "GOENV=off") { count += 1 } END { print count + 0 }' "${production_dockerfile}")"
docker_workspace_off_count="$(awk 'index($0, "GOWORK=off") { count += 1 } END { print count + 0 }' "${production_dockerfile}")"
docker_local_toolchain_count="$(awk 'index($0, "GOTOOLCHAIN=local") { count += 1 } END { print count + 0 }' "${production_dockerfile}")"
docker_readonly_module_count="$(awk 'index($0, "GOFLAGS=-mod=readonly") { count += 1 } END { print count + 0 }' "${production_dockerfile}")"
docker_backend_copy_count="$(awk '$0 == "COPY backend/ ./" { count += 1 } END { print count + 0 }' "${production_dockerfile}")"
[[ "${docker_go_download_policy_count}" -eq 1 && "${docker_go_build_policy_count}" -eq 1 &&
  "${docker_go_build_command_count}" -eq 1 && "${docker_environment_off_count}" -eq 2 && "${docker_workspace_off_count}" -eq 2 &&
  "${docker_local_toolchain_count}" -eq 2 && "${docker_readonly_module_count}" -eq 2 &&
  "${docker_backend_copy_count}" -eq 1 ]] \
  || fail "production Dockerfile can select an unreviewed Go workspace, toolchain, or module mutation"
unset production_dockerfile docker_go_download_policy_count docker_go_build_policy_count docker_go_build_command_count docker_environment_off_count docker_workspace_off_count docker_local_toolchain_count docker_readonly_module_count docker_backend_copy_count
pass "production Dockerfile uses the reviewed Go module and toolchain for download and build"

higher_toolchain_fixture="${test_root}/higher-go-toolchain"
mkdir -p -- "${higher_toolchain_fixture}"
printf '%s\n' \
  'module example.invalid/higher-toolchain-fixture' \
  '' \
  'go 1.99.0' \
  '' \
  'toolchain go1.99.0' \
  >"${higher_toolchain_fixture}/go.mod"
printf '%s\n' 'package fixture' >"${higher_toolchain_fixture}/fixture.go"
higher_toolchain_status=0
docker run --rm \
  --env GOENV=off \
  --env GOTOOLCHAIN=local \
  --volume "${higher_toolchain_fixture}:/workspace:ro" \
  --workdir /workspace \
  "${SECURITY_GO_IMAGE}" \
  go list ./... >"${output_root}/higher-go-toolchain.log" 2>&1 || higher_toolchain_status=$?
[[ "${higher_toolchain_status}" -ne 0 ]] || fail "higher candidate Go toolchain unexpectedly ran with GOTOOLCHAIN=local"
grep -Fq -- 'GOTOOLCHAIN=local' "${output_root}/higher-go-toolchain.log" \
  || fail "higher candidate Go toolchain did not fail at the local-toolchain boundary"
if grep -Fq -- 'downloading go1.99' "${output_root}/higher-go-toolchain.log"; then
  fail "higher candidate Go toolchain triggered an automatic toolchain download"
fi
pass "candidate go.mod cannot replace the digest-pinned local Go toolchain"

go_policy_fixture="${test_root}/go-module-policy"
go_policy_valid="${go_policy_fixture}/valid"
mkdir -p -- "${go_policy_valid}"
printf '%s\n' 'module example.invalid/go-policy-fixture' '' 'go 1.26.0' >"${go_policy_valid}/go.mod"
printf '%s\n' 'example.invalid/placeholder v0.0.0 h1:YWJjZA==' >"${go_policy_valid}/go.sum"
security_validate_go_module_policy \
  "${go_policy_valid}" \
  "${output_root}/go-policy-valid.json" \
  "${output_root}/go-policy-valid.log" \
  || fail "valid Go module policy fixture was rejected"
hidden_parent_fixture="${go_policy_fixture}/.hidden-parent/backend"
mkdir -p -- "$(dirname -- "${hidden_parent_fixture}")"
cp -R -- "${go_policy_valid}" "${hidden_parent_fixture}"
security_validate_go_module_policy \
  "${hidden_parent_fixture}" \
  "${output_root}/go-policy-hidden-parent-valid.json" \
  "${output_root}/go-policy-hidden-parent-valid.log" \
  || fail "Go module policy treated an ancestor outside the module as a hidden package directory"

for forbidden_go_file in go.work go.work.sum; do
  forbidden_fixture="${go_policy_fixture}/${forbidden_go_file}"
  cp -R -- "${go_policy_valid}" "${forbidden_fixture}"
  printf '%s\n' 'unapproved workspace metadata' >"${forbidden_fixture}/${forbidden_go_file}"
  expect_failure \
    "Go module ${forbidden_go_file} fixture" \
    security_validate_go_module_policy \
    "${forbidden_fixture}" \
    "${output_root}/go-policy-${forbidden_go_file}.json" \
    "${output_root}/go-policy-${forbidden_go_file}.log"
done

for root_workspace_file in go.work go.work.sum; do
  root_workspace_fixture="${go_policy_fixture}/root-${root_workspace_file}"
  mkdir -p -- "${root_workspace_fixture}"
  cp -R -- "${go_policy_valid}" "${root_workspace_fixture}/backend"
  printf '%s\n' 'unapproved repository workspace metadata' >"${root_workspace_fixture}/${root_workspace_file}"
  expect_failure \
    "repository root ${root_workspace_file} fixture" \
    security_validate_go_module_policy \
    "${root_workspace_fixture}/backend" \
    "${output_root}/go-policy-root-${root_workspace_file}.json" \
    "${output_root}/go-policy-root-${root_workspace_file}.log" \
    "${root_workspace_fixture}"
done

vendor_fixture="${go_policy_fixture}/nested-vendor"
cp -R -- "${go_policy_valid}" "${vendor_fixture}"
mkdir -p -- "${vendor_fixture}/internal/vendor/example.invalid/unscanned"
expect_failure \
  "Go module nested vendor fixture" \
  security_validate_go_module_policy \
  "${vendor_fixture}" \
  "${output_root}/go-policy-vendor.json" \
  "${output_root}/go-policy-vendor.log"

for excluded_go_directory in testdata .hidden _hidden; do
  excluded_go_fixture="${go_policy_fixture}/excluded-${excluded_go_directory}"
  cp -R -- "${go_policy_valid}" "${excluded_go_fixture}"
  mkdir -p -- "${excluded_go_fixture}/internal/${excluded_go_directory}/unscanned"
  printf '%s\n' 'package unscanned' >"${excluded_go_fixture}/internal/${excluded_go_directory}/unscanned/unscanned.go"
  expect_failure \
    "Go module wildcard-excluded ${excluded_go_directory} package fixture" \
    security_validate_go_module_policy \
    "${excluded_go_fixture}" \
    "${output_root}/go-policy-excluded-${excluded_go_directory}.json" \
    "${output_root}/go-policy-excluded-${excluded_go_directory}.log"
done

replace_fixture="${go_policy_fixture}/replace"
cp -R -- "${go_policy_valid}" "${replace_fixture}"
printf '%s\n' '' 'replace example.invalid/dependency => ./local' >>"${replace_fixture}/go.mod"
expect_failure \
  "Go module replace directive fixture" \
  security_validate_go_module_policy \
  "${replace_fixture}" \
  "${output_root}/go-policy-replace.json" \
  "${output_root}/go-policy-replace.log"

ignore_fixture="${go_policy_fixture}/ignore"
cp -R -- "${go_policy_valid}" "${ignore_fixture}"
printf '%s\n' '' 'ignore internal/hidden' >>"${ignore_fixture}/go.mod"
expect_failure \
  "Go module ignore directive fixture" \
  security_validate_go_module_policy \
  "${ignore_fixture}" \
  "${output_root}/go-policy-ignore.json" \
  "${output_root}/go-policy-ignore.log"

toolchain_fixture="${go_policy_fixture}/toolchain"
cp -R -- "${go_policy_valid}" "${toolchain_fixture}"
printf '%s\n' '' 'toolchain go1.26.6' >>"${toolchain_fixture}/go.mod"
expect_failure \
  "Go module toolchain directive fixture" \
  security_validate_go_module_policy \
  "${toolchain_fixture}" \
  "${output_root}/go-policy-toolchain.json" \
  "${output_root}/go-policy-toolchain.log"

go_policy_body="$(declare -f security_validate_go_module_policy)" || fail "could not inspect Go module policy helper"
go_policy_network_count="$(awk 'index($0, "--network none") { count += 1 } END { print count + 0 }' <<<"${go_policy_body}")"
go_policy_read_only_count="$(awk 'index($0, "--read-only") { count += 1 } END { print count + 0 }' <<<"${go_policy_body}")"
go_policy_tmpfs_count="$(awk 'index($0, "--tmpfs") { count += 1 } END { print count + 0 }' <<<"${go_policy_body}")"
go_policy_environment_off_count="$(awk 'index($0, "--env GOENV=off") { count += 1 } END { print count + 0 }' <<<"${go_policy_body}")"
go_policy_workspace_off_count="$(awk 'index($0, "--env GOWORK=off") { count += 1 } END { print count + 0 }' <<<"${go_policy_body}")"
go_policy_parse_count="$(awk 'index($0, "go mod edit -json") { count += 1 } END { print count + 0 }' <<<"${go_policy_body}")"
go_policy_install_count="$(awk 'index($0, "go install") { count += 1 } END { print count + 0 }' <<<"${go_policy_body}")"
[[ "${go_policy_network_count}" -eq 2 && "${go_policy_read_only_count}" -eq 2 &&
  "${go_policy_tmpfs_count}" -eq 2 && "${go_policy_environment_off_count}" -eq 1 && "${go_policy_workspace_off_count}" -eq 1 &&
  "${go_policy_parse_count}" -eq 1 && "${go_policy_install_count}" -eq 0 ]] \
  || fail "Go module policy can use the network, mutate inputs, or install a tool"
unset forbidden_go_file forbidden_fixture root_workspace_file root_workspace_fixture vendor_fixture excluded_go_directory excluded_go_fixture replace_fixture ignore_fixture toolchain_fixture hidden_parent_fixture
actionless_go_policy_count="$(awk 'index($0, "security_validate_go_module_policy") { count += 1 } END { print count + 0 }' <<<"${go_policy_body}")"
[[ "${actionless_go_policy_count}" -ge 1 ]] || fail "Go module policy helper inspection failed"
unset go_policy_body go_policy_network_count go_policy_read_only_count go_policy_tmpfs_count go_policy_environment_off_count go_policy_workspace_off_count go_policy_parse_count go_policy_install_count actionless_go_policy_count
pass "Go module policy rejects workspace, unscanned Go directories, replace, ignore, and toolchain overrides before tool installation"

gitleaks_log_fixture="${test_root}/gitleaks-log-contract"
mkdir -p -- "${gitleaks_log_fixture}"
printf '%s\n' 'runtime INF no leaks found' >"${gitleaks_log_fixture}/clean.log"
security_validate_gitleaks_log "${gitleaks_log_fixture}/clean.log" || fail "clean Gitleaks log was rejected"
printf '%s\n' 'runtime WRN skipping archive: exceeds max archive depth' >"${gitleaks_log_fixture}/archive-depth.log"
expect_failure "Gitleaks archive-depth warning" security_validate_gitleaks_log "${gitleaks_log_fixture}/archive-depth.log"
printf '%s\n' 'runtime WRN skipping file: too large' >"${gitleaks_log_fixture}/target-size.log"
expect_failure "Gitleaks target-size warning" security_validate_gitleaks_log "${gitleaks_log_fixture}/target-size.log"
printf '%s\n' 'runtime ERR archive parse failure' >"${gitleaks_log_fixture}/scanner-error.log"
expect_failure "Gitleaks scanner error" security_validate_gitleaks_log "${gitleaks_log_fixture}/scanner-error.log"
pass "Gitleaks rejects archive/size skips and scanner errors even when the CLI exits zero"
printf '%s\n' 'runtime INF scanned 123 bytes' >"${gitleaks_log_fixture}/normalized-clean.log"
security_validate_normalized_gitleaks_log "${gitleaks_log_fixture}/normalized-clean.log" \
  || fail "clean normalized Gitleaks log was rejected"
printf '%s\n' 'runtime DBG skipping binary file mime_type=application/pdf' 'runtime INF scanned 0 bytes' >"${gitleaks_log_fixture}/normalized-binary-skip.log"
expect_failure \
  "normalized Gitleaks binary skip" \
  security_validate_normalized_gitleaks_log \
  "${gitleaks_log_fixture}/normalized-binary-skip.log"
printf '%s\n' 'runtime DBG skipping file: global allowlist path=fixture.txt' 'runtime INF scanned 0 bytes' >"${gitleaks_log_fixture}/normalized-path-skip.log"
expect_failure \
  "normalized Gitleaks path skip" \
  security_validate_normalized_gitleaks_log \
  "${gitleaks_log_fixture}/normalized-path-skip.log"
printf '%s\n' 'runtime DBG clean without coverage summary' >"${gitleaks_log_fixture}/normalized-no-summary.log"
expect_failure \
  "normalized Gitleaks missing coverage summary" \
  security_validate_normalized_gitleaks_log \
  "${gitleaks_log_fixture}/normalized-no-summary.log"
pass "normalized Gitleaks requires one coverage summary and rejects every MIME/path skip"

assert_snapshot_scanner_wiring security_run_node_audit "security_run_node_audit \"\${snapshot_root}\"" 1
assert_snapshot_scanner_wiring security_validate_node_audit_policy "security_validate_node_audit_policy \"\${snapshot_root}\"" 1
assert_snapshot_scanner_wiring security_run_govulncheck "security_run_govulncheck \"\${snapshot_root}/backend\"" 1
assert_snapshot_scanner_wiring security_run_gosec "security_run_gosec \"\${snapshot_root}/backend\"" 1
assert_snapshot_scanner_wiring security_validate_go_module_policy "security_validate_go_module_policy \"\${snapshot_root}/backend\"" 1
assert_snapshot_scanner_wiring security_run_trivy_config "security_run_trivy_config \"\${snapshot_root}\"" 2
assert_snapshot_scanner_wiring security_run_gitleaks_directory "security_run_gitleaks_directory \"\${snapshot_root}\"" 1
assert_snapshot_scanner_wiring security_run_supply_chain_policy "security_run_supply_chain_policy \"\${snapshot_root}\"" 1
normalized_gitleaks_call_count="$(awk 'index($0, "security_run_gitleaks_normalized_text") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
normalized_candidate_call_count="$(awk 'index($0, "security_run_gitleaks_normalized_text") && index($0, "${snapshot_root}") && index($0, "candidate") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
normalized_staged_call_count="$(awk 'index($0, "security_run_gitleaks_normalized_text") && index($0, "${repo_root}") && index($0, "staged") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
normalized_history_call_count="$(awk 'index($0, "security_run_gitleaks_normalized_text") && index($0, "${repo_root}") && index($0, "history") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
git_repository_guard_call_count="$(awk 'index($0, "security_validate_git_repository_inputs") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
candidate_text_call_count="$(awk 'index($0, "security_validate_candidate_text_files") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
staged_text_call_count="$(awk 'index($0, "security_validate_staged_text_files") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
history_text_call_count="$(awk 'index($0, "security_validate_history_text_files") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
[[ "${normalized_gitleaks_call_count}" -eq 3 && "${normalized_candidate_call_count}" -eq 1 &&
  "${normalized_staged_call_count}" -eq 1 && "${normalized_history_call_count}" -eq 1 &&
  "${git_repository_guard_call_count}" -eq 1 && "${candidate_text_call_count}" -eq 1 &&
  "${staged_text_call_count}" -eq 1 && "${history_text_call_count}" -eq 1 ]] \
  || fail "approved-text, Git-graph, or normalized secret views are not wired exactly once per required mode"
unset normalized_gitleaks_call_count normalized_candidate_call_count normalized_staged_call_count normalized_history_call_count git_repository_guard_call_count candidate_text_call_count staged_text_call_count history_text_call_count
owned_gitleaks_calls="$(awk 'index($0, "security_run_gitleaks_") && index($0, "${gitleaks_config}") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
owned_trivy_calls="$(awk 'index($0, "security_run_trivy_") && index($0, "${trivy_config}") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
raw_gitleaks_cat_calls="$(awk 'index($0, "cat --") && index($0, "gitleaks-") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
[[ "${owned_gitleaks_calls}" -eq 6 && "${owned_trivy_calls}" -eq 3 && "${raw_gitleaks_cat_calls}" -eq 0 ]] || fail "scanner-owned Gitleaks/Trivy policy or raw-log suppression wiring regressed"
production_build_count="$(awk 'index($0, "docker build") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
production_dockerfile_count="$(awk -v needle="--file \"\${snapshot_root}/Dockerfile\"" 'index($0, needle) { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
production_context_count="$(awk -v needle="  \"\${snapshot_root}\"" '$0 == needle { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
[[ "${production_build_count}" -eq 1 && "${production_dockerfile_count}" -eq 1 && "${production_context_count}" -eq 1 ]] || fail "production image build is not wired exclusively to the candidate snapshot"
production_cleanup_count="$(awk -v needle="security_remove_temporary_image \"\${production_image_tag}\"" 'index($0, needle) { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
cleanup_inspect_guard_count="$(awk 'index($0, "production_image_cleanup") && index($0, "docker image inspect") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
prebuild_tag_guard_count="$(awk 'index($0, "security_require_temporary_image_tag_absent") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check-security.sh")"
[[ "${production_cleanup_count}" -eq 1 && "${cleanup_inspect_guard_count}" -eq 0 && "${prebuild_tag_guard_count}" -eq 1 ]] || fail "production image lifecycle can skip removal or overwrite an unconfirmed tag"
snapshot_creation_line="$(awk 'index($0, "security_create_candidate_snapshot") { print NR; exit }' "${repo_root}/scripts/check-security.sh")"
first_structured_scan_line="$(awk 'index($0, "security_run_node_audit") { print NR; exit }' "${repo_root}/scripts/check-security.sh")"
[[ "${snapshot_creation_line}" =~ ^[1-9][0-9]*$ && "${first_structured_scan_line}" =~ ^[1-9][0-9]*$ && "${snapshot_creation_line}" -lt "${first_structured_scan_line}" ]] || fail "candidate snapshot is not created before structured scanners run"
last_secret_scan_line="$(awk 'index($0, "security_run_gitleaks_") { line = NR } END { print line + 0 }' "${repo_root}/scripts/check-security.sh")"
supply_chain_policy_line="$(awk 'index($0, "security_run_supply_chain_policy") { print NR; exit }' "${repo_root}/scripts/check-security.sh")"
go_policy_line="$(awk 'index($0, "security_validate_go_module_policy") { print NR; exit }' "${repo_root}/scripts/check-security.sh")"
first_network_scan_line="$(awk 'index($0, "security_run_node_audit") || index($0, "security_run_govulncheck") || index($0, "security_run_gosec") || index($0, "security_run_trivy_") || index($0, "docker build") { print NR; exit }' "${repo_root}/scripts/check-security.sh")"
[[ "${last_secret_scan_line}" -gt 0 && "${supply_chain_policy_line}" =~ ^[1-9][0-9]*$ &&
  "${go_policy_line}" =~ ^[1-9][0-9]*$ &&
  "${first_network_scan_line}" =~ ^[1-9][0-9]*$ &&
  "${last_secret_scan_line}" -lt "${supply_chain_policy_line}" &&
  "${supply_chain_policy_line}" -lt "${go_policy_line}" &&
  "${go_policy_line}" -lt "${first_network_scan_line}" ]] \
  || fail "secret scans, supply-chain policy, and Go module policy do not precede networked scanners and image build"
pass "structured scanners, six secret views, supply-chain policy, Git graph guard, and production build are wired to their exact candidate/index/history inputs"

snapshot_fixture="${test_root}/candidate-snapshot"
snapshot_repo="${snapshot_fixture}/repo"
snapshot_output="${snapshot_fixture}/output"
mkdir -p -- "${snapshot_repo}/backend" "${snapshot_repo}/infra/terraform/staging" "${snapshot_output}"
git -C "${snapshot_repo}" init --quiet
printf '%s\n' '.env' '*.key' '*.tfvars' '.terraform/' >"${snapshot_repo}/.gitignore"
printf '%s\n' '{"name":"snapshot-fixture","private":true}' >"${snapshot_repo}/package.json"
printf '%s\n' 'module example.invalid/snapshotfixture' '' 'go 1.26.6' >"${snapshot_repo}/backend/go.mod"
printf '%s\n' 'terraform {}' >"${snapshot_repo}/infra/terraform/staging/main.tf"
printf '%s\n' 'FROM scratch' >"${snapshot_repo}/Dockerfile"
git -C "${snapshot_repo}" add .gitignore package.json backend/go.mod infra/terraform/staging/main.tf Dockerfile
git -C "${snapshot_repo}" -c user.name='Security Fixture' -c user.email='security-fixture.invalid@example.invalid' commit --quiet -m 'candidate snapshot fixture'
printf '%s\n' 'non-ignored candidate' >"${snapshot_repo}/candidate.txt"
ignored_sentinel="$(printf '%s%s' 'ignored-local-' 'credential-sentinel')"
printf '%s\n' "${ignored_sentinel}" >"${snapshot_repo}/.env"
printf '%s\n' "${ignored_sentinel}" >"${snapshot_repo}/backend/local.key"
printf '%s\n' "${ignored_sentinel}" >"${snapshot_repo}/infra/terraform/staging/local.tfvars"
mkdir -p -- "${snapshot_repo}/infra/terraform/staging/.terraform"
printf '%s\n' "${ignored_sentinel}" >"${snapshot_repo}/infra/terraform/staging/.terraform/terraform.tfstate"
security_create_candidate_snapshot "${snapshot_repo}" "${snapshot_output}" "${snapshot_fixture}/manifest.nul" || fail "candidate snapshot creation failed"
for expected_path in package.json backend/go.mod infra/terraform/staging/main.tf Dockerfile candidate.txt; do
  [[ -f "${snapshot_output}/${expected_path}" ]] || fail "candidate snapshot omitted ${expected_path}"
done
for ignored_path in .env backend/local.key infra/terraform/staging/local.tfvars infra/terraform/staging/.terraform/terraform.tfstate; do
  [[ ! -e "${snapshot_output}/${ignored_path}" ]] || fail "candidate snapshot copied ignored input ${ignored_path}"
done
unset ignored_sentinel

tracked_ignored_path="infra/terraform/staging/.terraform/environment"
printf '%s\n' 'unapproved-workspace' >"${snapshot_repo}/${tracked_ignored_path}"
git -C "${snapshot_repo}" add -f "${tracked_ignored_path}"
tracked_ignored_status=0
mkdir -p -- "${snapshot_fixture}/tracked-ignored-output"
security_create_candidate_snapshot \
  "${snapshot_repo}" \
  "${snapshot_fixture}/tracked-ignored-output" \
  "${snapshot_fixture}/tracked-ignored-manifest.nul" \
  || tracked_ignored_status=$?
[[ "${tracked_ignored_status}" -ne 0 ]] || fail "force-tracked ignored Terraform working data entered the candidate snapshot"
git -C "${snapshot_repo}" rm --cached --quiet -- "${tracked_ignored_path}"
unlink -- "${snapshot_repo}/${tracked_ignored_path}"

mv -- "${snapshot_repo}/package.json" "${snapshot_fixture}/deleted-package.json"
mkdir -p -- "${snapshot_fixture}/deletion-output"
security_create_candidate_snapshot "${snapshot_repo}" "${snapshot_fixture}/deletion-output" "${snapshot_fixture}/deletion-manifest.nul" || fail "intentional tracked deletion was not recognized"
[[ ! -e "${snapshot_fixture}/deletion-output/package.json" ]] || fail "deleted tracked candidate was copied"
mv -- "${snapshot_fixture}/deleted-package.json" "${snapshot_repo}/package.json"

concurrent_candidate="${snapshot_repo}/concurrent-delete.txt"
printf '%s\n' 'must not disappear during snapshot creation' >"${concurrent_candidate}"
git -C "${snapshot_repo}" add concurrent-delete.txt
concurrent_git_fixture="${snapshot_fixture}/concurrent-git"
mkdir -p -- "${concurrent_git_fixture}/bin" "${concurrent_git_fixture}/output"
real_git_path="$(command -v git)"
# shellcheck disable=SC2016 # Single-quoted lines are the generated fixture script.
concurrent_git_lines=(
  '#!/usr/bin/env bash'
  'set -Eeuo pipefail'
  "readonly REAL_GIT_PATH=$(printf '%q' "${real_git_path}")"
  "readonly RACE_TARGET_PATH=$(printf '%q' "${concurrent_candidate}")"
  'args=("$@")'
  'for ((index = 0; index + 2 < ${#args[@]}; index += 1)); do'
  '  if [[ "${args[index]}" == "ls-files" && "${args[index + 1]}" == "--cached" && "${args[index + 2]}" == "--others" ]]; then'
  '    "${REAL_GIT_PATH}" "$@"'
  '    command_status=$?'
  '    unlink -- "${RACE_TARGET_PATH}"'
  '    exit "${command_status}"'
  '  fi'
  'done'
  'exec "${REAL_GIT_PATH}" "$@"'
)
printf '%s\n' "${concurrent_git_lines[@]}" >"${concurrent_git_fixture}/bin/git"
chmod 700 "${concurrent_git_fixture}/bin/git"
concurrent_snapshot_status=0
(
  hash -r
  PATH="${concurrent_git_fixture}/bin:${PATH}" \
    security_create_candidate_snapshot \
    "${snapshot_repo}" \
    "${concurrent_git_fixture}/output" \
    "${concurrent_git_fixture}/manifest.nul"
) || concurrent_snapshot_status=$?
[[ "${concurrent_snapshot_status}" -ne 0 ]] || fail "concurrent tracked-file deletion produced a partial candidate snapshot"
[[ ! -e "${concurrent_candidate}" ]] || fail "concurrent deletion fixture did not run at the candidate-enumeration boundary"
printf '%s\n' 'must not disappear during snapshot creation' >"${concurrent_candidate}"

copy_race_fixture="${snapshot_fixture}/copy-race"
mkdir -p -- "${copy_race_fixture}/bin"
real_cp_path="$(command -v cp)"
# shellcheck disable=SC2016 # Single-quoted lines are the generated fixture script.
copy_race_lines=(
  '#!/usr/bin/env bash'
  'set -Eeuo pipefail'
  'if [[ "$3" == "${RACE_SOURCE_PATH}" ]]; then'
  '  case "${RACE_MODE}" in'
  '    content)'
  '      "${REAL_CP_PATH}" "$@"'
  '      command_status=$?'
  '      printf "%s\n" "changed during copy" >"${RACE_SOURCE_PATH}"'
  '      exit "${command_status}"'
  '      ;;'
  '    symlink)'
  '      unlink -- "${RACE_SOURCE_PATH}"'
  '      ln -s -- "${RACE_EXTERNAL_PATH}" "${RACE_SOURCE_PATH}"'
  '      exec "${REAL_CP_PATH}" "$@"'
  '      ;;'
  '    *) exit 97 ;;'
  '  esac'
  'fi'
  'exec "${REAL_CP_PATH}" "$@"'
)
printf '%s\n' "${copy_race_lines[@]}" >"${copy_race_fixture}/bin/cp"
chmod 700 "${copy_race_fixture}/bin/cp"
printf '%s\n' 'external race content' >"${copy_race_fixture}/external.txt"
for copy_race_mode in content symlink; do
  copy_race_source="${snapshot_repo}/copy-race-${copy_race_mode}.txt"
  printf '%s\n' 'stable candidate content' >"${copy_race_source}"
  git -C "${snapshot_repo}" add "copy-race-${copy_race_mode}.txt"
  mkdir -p -- "${copy_race_fixture}/output-${copy_race_mode}"
  copy_race_status=0
  (
    hash -r
    REAL_CP_PATH="${real_cp_path}" \
      RACE_SOURCE_PATH="${copy_race_source}" \
      RACE_EXTERNAL_PATH="${copy_race_fixture}/external.txt" \
      RACE_MODE="${copy_race_mode}" \
      PATH="${copy_race_fixture}/bin:${PATH}" \
      security_create_candidate_snapshot \
      "${snapshot_repo}" \
      "${copy_race_fixture}/output-${copy_race_mode}" \
      "${copy_race_fixture}/manifest-${copy_race_mode}.nul"
  ) || copy_race_status=$?
  [[ "${copy_race_status}" -ne 0 ]] || fail "candidate ${copy_race_mode} mutation during copy was accepted"
  if [[ -L "${copy_race_source}" ]]; then
    unlink -- "${copy_race_source}"
  fi
  printf '%s\n' 'stable candidate content' >"${copy_race_source}"
done
snapshot_helper_body="$(declare -f security_create_candidate_snapshot)" || fail "could not inspect candidate snapshot helper"
snapshot_no_dereference_count="$(awk 'index($0, "cp --no-dereference --") { count += 1 } END { print count + 0 }' <<<"${snapshot_helper_body}")"
snapshot_compare_count="$(awk 'index($0, "cmp --silent --") { count += 1 } END { print count + 0 }' <<<"${snapshot_helper_body}")"
[[ "${snapshot_no_dereference_count}" -eq 1 && "${snapshot_compare_count}" -eq 1 ]] \
  || fail "candidate snapshot copy does not fix symlink semantics and verify stable bytes"
unset copy_race_mode copy_race_source copy_race_status snapshot_helper_body snapshot_no_dereference_count snapshot_compare_count

ln -s -- package.json "${snapshot_repo}/candidate-link"
symlink_entry_status=0
mkdir -p -- "${snapshot_fixture}/symlink-output"
security_create_candidate_snapshot "${snapshot_repo}" "${snapshot_fixture}/symlink-output" "${snapshot_fixture}/symlink-manifest.nul" || symlink_entry_status=$?
[[ "${symlink_entry_status}" -ne 0 ]] || fail "candidate symlink was not rejected"
unlink -- "${snapshot_repo}/candidate-link"

gitlink_oid="$(git -C "${snapshot_repo}" rev-parse HEAD)"
mkdir -p -- "${snapshot_repo}/vendor/module"
git -C "${snapshot_repo}" update-index --add --cacheinfo "160000,${gitlink_oid},vendor/module"
unsupported_entry_status=0
mkdir -p -- "${snapshot_fixture}/unsupported-output"
security_create_candidate_snapshot "${snapshot_repo}" "${snapshot_fixture}/unsupported-output" "${snapshot_fixture}/unsupported-manifest.nul" || unsupported_entry_status=$?
[[ "${unsupported_entry_status}" -ne 0 ]] || fail "unsupported Git candidate entry type was silently omitted"

enumeration_fixture="${test_root}/enumeration-failure"
mkdir -p -- "${enumeration_fixture}/bin" "${enumeration_fixture}/snapshot"
fake_git_lines=(
  '#!/usr/bin/env bash'
  'printf "tracked.txt\\0"'
  'exit 23'
)
printf '%s\n' "${fake_git_lines[@]}" >"${enumeration_fixture}/bin/git"
chmod 700 "${enumeration_fixture}/bin/git"
enumeration_status=0
(
  hash -r
  PATH="${enumeration_fixture}/bin:${PATH}" security_create_candidate_snapshot "${snapshot_repo}" "${enumeration_fixture}/snapshot" "${enumeration_fixture}/manifest.nul"
) || enumeration_status=$?
[[ "${enumeration_status}" -ne 0 ]] || fail "candidate enumeration error was ignored"
[[ ! -e "${enumeration_fixture}/snapshot/tracked.txt" ]] || fail "partial failed enumeration was consumed"
pass "candidate snapshot rejects tracked ignored inputs and fails closed on copy races, enumeration, or entry-type errors"

cleanup_failure_fixture="${test_root}/cleanup-failure"
mkdir -p -- "${cleanup_failure_fixture}/bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 29' >"${cleanup_failure_fixture}/bin/docker"
chmod 700 "${cleanup_failure_fixture}/bin/docker"
cleanup_failure_status=0
(
  hash -r
  PATH="${cleanup_failure_fixture}/bin:${PATH}" security_remove_temporary_image 'runtime-only-fixture:cleanup'
) || cleanup_failure_status=$?
[[ "${cleanup_failure_status}" -ne 0 ]] || fail "temporary-image removal error was ignored"
tag_guard_failure_status=0
(
  hash -r
  PATH="${cleanup_failure_fixture}/bin:${PATH}" security_require_temporary_image_tag_absent 'runtime-only-fixture:guard'
) || tag_guard_failure_status=$?
[[ "${tag_guard_failure_status}" -ne 0 ]] || fail "temporary-image tag query error was treated as confirmed absence"
pass "temporary-image guards propagate daemon, query, and removal errors"

classifier_fixture="${test_root}/classifier"
mkdir -p -- "${classifier_fixture}"
printf '%s\n' '{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}' >"${classifier_fixture}/node-clean.json"
printf '%s\n' '{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}}}' >"${classifier_fixture}/node-clean-total.json"
printf '%s\n' '{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"urgent":1}}}' >"${classifier_fixture}/node-unknown-count.json"
printf '%s\n' '{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":1}}}' >"${classifier_fixture}/node-wrong-total.json"
printf '%s\n' '{"advisories":{"1":{"severity":"high"}},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":1,"critical":0}}}' >"${classifier_fixture}/node-finding.json"
printf '%s\n' '{"advisories":{"1":{"severity":"critical"}},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}' >"${classifier_fixture}/node-inconsistent-finding.json"
printf '%s\n' '{"advisories":{"1":{"severity":"unknown"}},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}' >"${classifier_fixture}/node-unknown-severity.json"
printf '%s\n' '{"Golang errors":{},"Issues":[],"Stats":{"files":1,"lines":1,"nosec":0,"found":0},"GosecVersion":"v2.22.11"}' >"${classifier_fixture}/gosec-clean.json"
printf '%s\n' '{"Golang errors":{},"Issues":[{"severity":"HIGH","confidence":"HIGH","rule_id":"G000","file":"fixture.go","line":"1"}],"Stats":{"files":1,"lines":1,"nosec":0,"found":1},"GosecVersion":"v2.22.11"}' >"${classifier_fixture}/gosec-finding.json"
printf '%s\n' '{"Golang errors":{},"Issues":[],"Stats":{"files":1,"lines":1,"nosec":1,"found":0},"GosecVersion":"v2.22.11"}' >"${classifier_fixture}/gosec-suppressed.json"
printf '%s\n' '{"Golang errors":{},"Issues":[{"severity":"LOW","confidence":"HIGH","rule_id":"G000","file":"fixture.go","line":"1"}],"Stats":{"files":1,"lines":1,"nosec":0,"found":1},"GosecVersion":"v2.22.11"}' >"${classifier_fixture}/gosec-low-severity.json"
printf '%s\n' '{"Golang errors":{},"Issues":[{"severity":"HIGH","confidence":"MEDIUM","rule_id":"G000","file":"fixture.go","line":"1"}],"Stats":{"files":1,"lines":1,"nosec":0,"found":1},"GosecVersion":"v2.22.11"}' >"${classifier_fixture}/gosec-low-confidence.json"
printf '%s\n' '{"Golang errors":{},"Issues":[],"Stats":{"files":0,"lines":0,"nosec":0,"found":0},"GosecVersion":"v2.22.11"}' >"${classifier_fixture}/gosec-zero-coverage.json"
printf '%s\n' '{"Golang errors":{},"Issues":[],"Stats":{"files":1,"lines":1,"nosec":0,"found":0},"GosecVersion":""}' >"${classifier_fixture}/gosec-empty-version.json"
cp -- "${classifier_fixture}/gosec-clean.json" "${classifier_fixture}/gosec-wrong-module.json"
for gosec_report in \
  gosec-clean.json \
  gosec-finding.json \
  gosec-suppressed.json \
  gosec-low-severity.json \
  gosec-low-confidence.json \
  gosec-zero-coverage.json \
  gosec-empty-version.json; do
  printf '%s\n' 'v2.22.11' >"${classifier_fixture}/${gosec_report}.module-version"
done
printf '%s\n' 'v2.22.10' >"${classifier_fixture}/gosec-wrong-module.json.module-version"
printf '%s\n' '{"SchemaVersion":2,"ArtifactType":"filesystem","Trivy":{"Version":"0.73.0"},"Results":[{"Target":"fixture.tf","Class":"config","Type":"terraform","MisconfSummary":{"Successes":1,"Failures":0}}]}' >"${classifier_fixture}/trivy-config-clean.json"
printf '%s\n' '{"SchemaVersion":2,"ArtifactType":"filesystem","Trivy":{"Version":"0.73.0"},"Results":[{"Target":"fixture.tf","Class":"config","Type":"terraform","MisconfSummary":{"Successes":0,"Failures":1},"Misconfigurations":[{"ID":"FIX-0001","Severity":"HIGH","CauseMetadata":{"StartLine":1}}]}]}' >"${classifier_fixture}/trivy-config-finding.json"
printf '%s\n' '{"SchemaVersion":2,"ArtifactType":"filesystem","Trivy":{"Version":"0.73.0"},"Results":[{"Target":"fixture.tf","Class":"config","Type":"terraform","MisconfSummary":{"Successes":1,"Failures":0,"Exceptions":1}}]}' >"${classifier_fixture}/trivy-config-suppressed.json"
printf '%s\n' '{"SchemaVersion":2,"ArtifactType":"container_image","Trivy":{"Version":"0.73.0"},"Metadata":{"OS":{"Family":"alpine","Name":"fixture"}},"Results":[{"Target":"fixture","Class":"os-pkgs","Type":"alpine","Packages":[{"Name":"fixture","Version":"1"}]}]}' >"${classifier_fixture}/trivy-image-clean.json"
printf '%s\n' '{"SchemaVersion":2,"ArtifactType":"container_image","Trivy":{"Version":"0.73.0"},"Metadata":{"OS":{"Family":"alpine","Name":"fixture"}},"Results":[{"Target":"fixture","Class":"os-pkgs","Type":"alpine","Packages":[{"Name":"fixture","Version":"1"}],"Vulnerabilities":[{"VulnerabilityID":"CVE-0000-0000","PkgName":"fixture","InstalledVersion":"1","FixedVersion":"2","Severity":"CRITICAL"}]}]}' >"${classifier_fixture}/trivy-image-finding.json"
printf '%s\n' '{"SchemaVersion":2,"ArtifactType":"container_image","Trivy":{"Version":"0.73.0"},"Metadata":{"OS":{"Family":"alpine","Name":"fixture"}},"Results":[{"Target":"fixture","Class":"os-pkgs","Type":"alpine","Packages":[null]}]}' >"${classifier_fixture}/trivy-image-null-package.json"
printf '%s\n' '{' >"${classifier_fixture}/malformed.json"
printf '%s\n' '{}' >"${classifier_fixture}/missing-schema.json"

assert_report_classification 1 node-vulnerability "${classifier_fixture}/node-clean.json" "clean Node report"
assert_report_classification 1 node-vulnerability "${classifier_fixture}/node-clean-total.json" "clean Node report with total"
assert_report_classification 2 node-vulnerability "${classifier_fixture}/node-unknown-count.json" "unknown Node vulnerability count"
assert_report_classification 2 node-vulnerability "${classifier_fixture}/node-wrong-total.json" "inconsistent Node vulnerability total"
assert_report_classification 0 node-vulnerability "${classifier_fixture}/node-finding.json" "finding Node report"
assert_report_classification 0 node-vulnerability "${classifier_fixture}/node-inconsistent-finding.json" "inconsistent Node advisory report"
assert_report_classification 2 node-vulnerability "${classifier_fixture}/node-unknown-severity.json" "unknown Node advisory severity"
assert_report_classification 1 gosec-high "${classifier_fixture}/gosec-clean.json" "clean gosec report"
assert_report_classification 0 gosec-high "${classifier_fixture}/gosec-finding.json" "finding gosec report"
assert_report_classification 2 gosec-high "${classifier_fixture}/gosec-suppressed.json" "suppressed gosec report"
assert_report_classification 2 gosec-high "${classifier_fixture}/gosec-low-severity.json" "out-of-scope gosec severity"
assert_report_classification 2 gosec-high "${classifier_fixture}/gosec-low-confidence.json" "out-of-scope gosec confidence"
assert_report_classification 2 gosec-high "${classifier_fixture}/gosec-zero-coverage.json" "zero-coverage gosec report"
assert_report_classification 2 gosec-high "${classifier_fixture}/gosec-empty-version.json" "empty-version gosec report"
assert_report_classification 2 gosec-high "${classifier_fixture}/gosec-wrong-module.json" "wrong-module gosec report"
assert_report_classification 1 trivy-misconfiguration "${classifier_fixture}/trivy-config-clean.json" "clean Trivy config report"
assert_report_classification 0 trivy-misconfiguration "${classifier_fixture}/trivy-config-finding.json" "finding Trivy config report"
assert_report_classification 2 trivy-misconfiguration "${classifier_fixture}/trivy-config-suppressed.json" "suppressed Trivy config report"
assert_report_classification 1 trivy-vulnerability "${classifier_fixture}/trivy-image-clean.json" "clean Trivy image report"
assert_report_classification 0 trivy-vulnerability "${classifier_fixture}/trivy-image-finding.json" "finding Trivy image report"
assert_report_classification 2 trivy-vulnerability "${classifier_fixture}/trivy-image-null-package.json" "null-package Trivy image report"
for report_mode in node-vulnerability gosec-high trivy-misconfiguration trivy-vulnerability; do
  assert_report_classification 2 "${report_mode}" "${classifier_fixture}/malformed.json" "malformed ${report_mode} report"
  assert_report_classification 2 "${report_mode}" "${classifier_fixture}/missing-schema.json" "missing-schema ${report_mode} report"
done
assert_report_classification 2 unknown-mode "${classifier_fixture}/node-clean.json" "unknown report mode"
assert_report_classification 2 node-vulnerability "${classifier_fixture}/missing.json" "missing report"
pass "JSON report classifier distinguishes findings, valid clean reports, and invalid reports"

pnpm_policy_fixture="${test_root}/pnpm-policy"
mkdir -p -- "${pnpm_policy_fixture}/frontend" "${pnpm_policy_fixture}/cloudflare"
valid_pnpm_manifest='{"name":"pnpm-policy-fixture","version":"0.1.0","private":true,"packageManager":"pnpm@11.22.0"}'
cp -- "${repo_root}/package.json" "${pnpm_policy_fixture}/package.json"
cp -- "${repo_root}/frontend/package.json" "${pnpm_policy_fixture}/frontend/package.json"
cp -- "${repo_root}/cloudflare/package.json" "${pnpm_policy_fixture}/cloudflare/package.json"
valid_pnpm_workspace_policy=(
  'packages:'
  '  - frontend'
  '  - cloudflare'
  ''
  'allowBuilds:'
  '  esbuild: true'
  '  workerd: true'
)
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
valid_pnpm_lock_policy=(
  "lockfileVersion: '9.0'"
  ''
  'settings:'
  '  autoInstallPeers: true'
  '  excludeLinksFromLockfile: false'
  ''
  'importers:'
  ''
  'packages:'
  ''
  'snapshots:'
)
cp -- "${repo_root}/pnpm-lock.yaml" "${pnpm_policy_fixture}/pnpm-lock.yaml"
security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-valid.log" || fail "valid pnpm audit policy was rejected"
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true}' >"${pnpm_policy_fixture}/package.json"
expect_failure "missing root packageManager" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-package-manager-missing.log"
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true,"packageManager":"pnpm@11"}' >"${pnpm_policy_fixture}/package.json"
expect_failure "non-exact root packageManager" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-package-manager-range.log"
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true,"packageManager":"pnpm@11.21.0"}' >"${pnpm_policy_fixture}/package.json"
expect_failure "wrong root pnpm version" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-package-manager-version.log"

pnpm_order_fixture="${test_root}/pnpm-preflight-order"
mkdir -p -- "${pnpm_order_fixture}/bin"
pnpm_order_log="${pnpm_order_fixture}/docker-calls"
# shellcheck disable=SC2016 # The generated fake expands this variable when it runs.
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >>"${FUKAMU_PNPM_ORDER_LOG}"' 'exit 97' >"${pnpm_order_fixture}/bin/docker"
chmod +x "${pnpm_order_fixture}/bin/docker"
(
  hash -r
  PATH="${pnpm_order_fixture}/bin:${PATH}" \
    FUKAMU_PNPM_ORDER_LOG="${pnpm_order_log}" \
    expect_failure "invalid packageManager preflight order" \
    security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-package-manager-order.log"
)
[[ -s "${pnpm_order_log}" ]] || fail "packageManager preflight did not invoke the pinned Node validator"
if grep -Fq -- "${SECURITY_PNPM_IMAGE}" "${pnpm_order_log}"; then
  fail "invalid packageManager reached pnpm before static policy rejection"
fi
grep -Fq -- "${SECURITY_NODE_IMAGE}" "${pnpm_order_log}" \
  || fail "packageManager preflight did not use the pinned Node runtime"

printf '%s\n' "${valid_pnpm_manifest}" >"${pnpm_policy_fixture}/package.json"
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true,"packageManager":"pnpm@11.22.0","devEngines":{"runtime":{"name":"node","version":"20.0.0","onFail":"download"}}}' >"${pnpm_policy_fixture}/package.json"
expect_failure "root devEngines runtime download policy" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-dev-engines.log"
printf '%s\n' "${valid_pnpm_manifest}" >"${pnpm_policy_fixture}/package.json"
printf '%s\n' '{"name":"pnpm-policy-fixture","version":"0.1.0","private":true,"packageManager":"pnpm@11.22.0","peerDependencies":{"markdown-it":"15.0.0"}}' >"${pnpm_policy_fixture}/package.json"
expect_failure "unmodeled auto-installed peer dependency" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-peer-dependency.log"
printf '%s\n' '{"name":"pnpm-policy-fixture","version":"0.1.0","private":true,"packageManager":"pnpm@11.22.0","dependenciesMeta":{"markdown-it":{"injected":true}}}' >"${pnpm_policy_fixture}/package.json"
expect_failure "unmodeled dependency metadata" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-dependency-meta.log"
printf '%s\n' "${valid_pnpm_manifest}" >"${pnpm_policy_fixture}/package.json"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" 'auditConfig:' '  ignoreGhsas:' '    - GHSA-2345-6789-cfgh' >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
expect_failure "pnpm workspace GHSA suppression" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-ghsa.log"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" 'auditConfig:' '  ignoreCves:' '    - CVE-2000-0000' >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
expect_failure "pnpm workspace CVE suppression" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-cve.log"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true,"packageManager":"pnpm@11.22.0","pnpm":{"auditConfig":{"ignoreGhsas":[]}}}' >"${pnpm_policy_fixture}/package.json"
expect_failure "legacy package pnpm audit suppression" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-package.log"
printf '%s\n' "${valid_pnpm_manifest}" >"${pnpm_policy_fixture}/package.json"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" 'ignoreUnfixable: true' 'ignoreRegistryErrors: true' 'prod: true' 'dev: true' 'optional: false' >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
expect_failure "pnpm audit scope/fail-open settings" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-scope.log"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
printf '%s\n' 'registry=https://registry.attacker.invalid/' >"${pnpm_policy_fixture}/.npmrc"
expect_failure "pnpm attacker registry config" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-registry.log"
printf '%s\n' 'production=true' >"${pnpm_policy_fixture}/.npmrc"
expect_failure "pnpm production-only config" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-production.log"
for only_alias in prod production dev development; do
  printf 'only=%s\n' "${only_alias}" >"${pnpm_policy_fixture}/.npmrc"
  expect_failure "pnpm only=${only_alias} scope alias" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-only-${only_alias}.log"
done
pnpm_transport_overrides=(
  'proxy=http://attacker.invalid/'
  'https-proxy=http://attacker.invalid/'
  'strict-ssl=false'
  'ca=low-entropy-sentinel'
  'cafile=/runtime/nonexistent-ca.pem'
  'cert=low-entropy-sentinel'
  'key=low-entropy-sentinel'
  '@runtime:registry=https://attacker.invalid/'
  '_auth=low-entropy-sentinel'
  '_authToken=low-entropy-sentinel'
  'token=low-entropy-sentinel'
  'username=low-entropy-sentinel'
  '_password=low-entropy-sentinel'
  'always-auth=true'
  'ignore-pnpmfile=false'
  'pnpmfile=.pnpmfile.cjs'
  '//registry.npmjs.org/:_authToken=low-entropy-sentinel'
)
for index in "${!pnpm_transport_overrides[@]}"; do
  printf '%s\n' "${pnpm_transport_overrides[${index}]}" >"${pnpm_policy_fixture}/.npmrc"
  expect_failure "pnpm transport/auth override ${index}" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-transport-${index}.log"
done
unlink -- "${pnpm_policy_fixture}/.npmrc"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" 'httpsProxy: http://attacker.invalid/' 'strictSsl: false' >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
expect_failure "pnpm workspace transport override" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-workspace-transport.log"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
pnpmfile_lines=(
  'const fs = require("node:fs");'
  'fs.writeFileSync("/workspace/hook-executed", "executed");'
  'module.exports = { hooks: { readPackage(pkg) { pkg.dependencies = {}; return pkg; } } };'
)
for pnpmfile_name in .pnpmfile.cjs .pnpmfile.js; do
  printf '%s\n' "${pnpmfile_lines[@]}" >"${pnpm_policy_fixture}/${pnpmfile_name}"
  expect_failure "pnpm hook file ${pnpmfile_name}" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-${pnpmfile_name}.log"
  [[ ! -e "${pnpm_policy_fixture}/hook-executed" ]] || fail "pnpm hook file executed before policy rejection"
  unlink -- "${pnpm_policy_fixture}/${pnpmfile_name}"
done
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true,"packageManager":"pnpm@11.22.0","pnpm":{"hooks":{"readPackage":"runtime-fixture"}}}' >"${pnpm_policy_fixture}/package.json"
expect_failure "pnpm manifest hook config" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-manifest-hook.log"
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true,"packageManager":"pnpm@11.22.0","pnpm":{"patchedDependencies":{"esbuild@0.28.2":"patches/esbuild.patch"}}}' >"${pnpm_policy_fixture}/package.json"
expect_failure "pnpm manifest patched dependency" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-manifest-patch.log"
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true,"packageManager":"pnpm@11.22.0","dependencies":{"fixture":"file:./fixture"}}' >"${pnpm_policy_fixture}/package.json"
expect_failure "pnpm non-registry dependency specifier" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-local-source.log"
printf '%s\n' "${valid_pnpm_manifest}" >"${pnpm_policy_fixture}/package.json"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" 'patchedDependencies:' '  esbuild@0.28.2: patches/esbuild.patch' >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
expect_failure "pnpm workspace patched dependency" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-workspace-patch.log"
printf '%s\n' "${valid_pnpm_workspace_policy[@]}" >"${pnpm_policy_fixture}/pnpm-workspace.yaml"
printf '%s\n' "${valid_pnpm_lock_policy[@]}" 'patchedDependencies:' '  esbuild@0.28.2:' '    hash: runtime-fixture' '    path: patches/esbuild.patch' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm lockfile patched dependency" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-patch.log"
printf '%s\n' "${valid_pnpm_lock_policy[@]}" '"patchedDependencies":' '  esbuild@0.28.2:' '    hash: runtime-fixture' '    path: patches/esbuild.patch' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm lockfile quoted patched dependency" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-quoted-patch.log"
printf '%s\n' "${valid_pnpm_lock_policy[@]}" '!!str patchedDependencies:' '  esbuild@0.28.2:' '    hash: runtime-fixture' '    path: patches/esbuild.patch' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm lockfile tagged patched dependency" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-tagged-patch.log"
printf '%s\n' "${valid_pnpm_lock_policy[@]}" 'packages:' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm lockfile duplicate top-level key" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-duplicate.log"
printf '%s\n' "${valid_pnpm_lock_policy[@]}" '<<: *runtime-policy' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm lockfile merge key" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-merge.log"
printf '%s\n' "lockfileVersion: '9.0'" '' 'settings:' '  autoInstallPeers: true' '  excludeLinksFromLockfile: false' '' 'importers:' '  .:' '    dependencies:' '      fixture:' '        specifier: 1.0.0' '        "version": link:evil' '' 'packages:' '' 'snapshots:' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm quoted local importer version" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-quoted-version.log"
printf '%s\n' "lockfileVersion: '9.0'" '' 'settings:' '  autoInstallPeers: true' '  excludeLinksFromLockfile: false' '' 'importers:' '  .:' '    dependencies:' '      fixture:' '        specifier: 1.0.0' '        "vers\x69on": "l\x69nk:evil"' '' 'packages:' '' 'snapshots:' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm escaped local importer version" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-escaped-version.log"
printf '%s\n' "lockfileVersion: '9.0'" '' 'settings:' '  autoInstallPeers: true' '  excludeLinksFromLockfile: false' '' 'importers:' '' 'packages:' '' 'snapshots:' '  fixture@1.0.0:' '    dependencies:' '      tool: link:evil' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm snapshot local dependency" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-snapshot-link.log"
printf '%s\n' "lockfileVersion: '9.0'" '' 'settings:' '  autoInstallPeers: true' '  excludeLinksFromLockfile: false' '' 'importers:' '' 'packages:' '' '  fixture@1.0.0:' '    resolution: {integrity: sha512-YWJjZA==}' '    "resolution": {tarball: https://attacker.invalid/fixture.tgz}' '' 'snapshots:' >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm duplicate quoted tarball resolution" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-tarball.log"
printf '%s\n' "lockfileVersion: '9.0'" '' 'settings:' '  autoInstallPeers: true' '  excludeLinksFromLockfile: false' '' 'importers:' '  .:' '    dependencies:' '      fixture:' '        specifier: 1.0.0' "        version: '@jsr/std__path@1.0.0'" '' 'packages:' "  '@jsr/std__path@1.0.0':" '    resolution: {integrity: sha512-YWJjZA==}' '' 'snapshots:' "  '@jsr/std__path@1.0.0': {}" >"${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm JSR registry alias" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-jsr.log"

cp -- "${repo_root}/package.json" "${pnpm_policy_fixture}/package.json"
cp -- "${repo_root}/pnpm-lock.yaml" "${pnpm_policy_fixture}/pnpm-lock.yaml"
sed -i '/^      markdown-it:$/,/^      mermaid:$/ s/^        version: 15.0.0$/        version: evil-package@1.0.0/' "${pnpm_policy_fixture}/pnpm-lock.yaml"
[[ "$(grep -Fxc -- '        version: evil-package@1.0.0' "${pnpm_policy_fixture}/pnpm-lock.yaml")" -eq 1 ]] \
  || fail "unscoped npm alias fixture mutation was not exact"
add_evil_lock_identity "${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm unscoped dependency identity substitution" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-unscoped-alias.log"
grep -Fq -- '"from": "evil-package"' "${output_root}/pnpm-lock-graph.json" \
  || fail "unscoped npm alias did not reach lock graph identity validation"

cp -- "${repo_root}/pnpm-lock.yaml" "${pnpm_policy_fixture}/pnpm-lock.yaml"
sed -i '/^  cloudflare:$/,/^      prettier:$/ s/^        version: 24.13.3$/        version: evil-package@1.0.0/' "${pnpm_policy_fixture}/pnpm-lock.yaml"
[[ "$(grep -Fxc -- '        version: evil-package@1.0.0' "${pnpm_policy_fixture}/pnpm-lock.yaml")" -eq 1 ]] \
  || fail "scoped npm alias fixture mutation was not exact"
add_evil_lock_identity "${pnpm_policy_fixture}/pnpm-lock.yaml"
expect_failure "pnpm scoped dependency identity substitution" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-lock-scoped-alias.log"
grep -Fq -- '"from": "evil-package"' "${output_root}/pnpm-lock-graph.json" \
  || fail "scoped npm alias did not reach lock graph identity validation"

printf '%s\n' "${valid_pnpm_manifest}" >"${pnpm_policy_fixture}/package.json"
printf '%s\n' "${valid_pnpm_lock_policy[@]}" >"${pnpm_policy_fixture}/pnpm-lock.yaml"
printf '%s\n' '{"name":"pnpm-policy-fixture","private":true,"packageManager":"pnpm@11.22.0","scripts":{"postinstall":"touch lifecycle-executed"}}' >"${pnpm_policy_fixture}/package.json"
expect_failure "root project install lifecycle" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-root-lifecycle.log"
[[ ! -e "${pnpm_policy_fixture}/lifecycle-executed" ]] || fail "root project lifecycle executed before policy rejection"
printf '%s\n' "${valid_pnpm_manifest}" >"${pnpm_policy_fixture}/package.json"
printf '%s\n' '{"name":"frontend-fixture","private":true,"packageManager":"pnpm@11.22.0"}' >"${pnpm_policy_fixture}/frontend/package.json"
expect_failure "workspace packageManager override" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-workspace-package-manager.log"
cp -- "${repo_root}/frontend/package.json" "${pnpm_policy_fixture}/frontend/package.json"
sed -i 's/"name": "fukamu-cycle-frontend"/"name": "renamed-frontend"/' "${pnpm_policy_fixture}/frontend/package.json"
expect_failure "workspace filter identity change" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-workspace-name.log"
cp -- "${repo_root}/frontend/package.json" "${pnpm_policy_fixture}/frontend/package.json"
sed -i 's/"test": "vitest run"/"test": "true"/' "${pnpm_policy_fixture}/frontend/package.json"
expect_failure "workspace delegated script change" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-workspace-script.log"
cp -- "${repo_root}/frontend/package.json" "${pnpm_policy_fixture}/frontend/package.json"
sed -i '/"scripts": {/a\    "pretest": "true",' "${pnpm_policy_fixture}/frontend/package.json"
expect_failure "workspace delegated pre-hook" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-workspace-pretest.log"
cp -- "${repo_root}/frontend/package.json" "${pnpm_policy_fixture}/frontend/package.json"
printf '%s\n' '{"name":"frontend-fixture","private":true,"scripts":{"prepare":"touch ../lifecycle-executed"}}' >"${pnpm_policy_fixture}/frontend/package.json"
expect_failure "workspace project install lifecycle" security_validate_node_audit_policy "${pnpm_policy_fixture}" "${output_root}" "${output_root}/pnpm-policy-workspace-lifecycle.log"
[[ ! -e "${pnpm_policy_fixture}/lifecycle-executed" ]] || fail "workspace project lifecycle executed before policy rejection"
cp -- "${repo_root}/frontend/package.json" "${pnpm_policy_fixture}/frontend/package.json"
pass "pnpm audit rejects untrusted runtime selection, workspace identity/script changes, suppressions, hooks, patches, and non-registry sources"

secret_fixture="${test_root}/secret"
mkdir -p -- "${secret_fixture}"
git -C "${secret_fixture}" init --quiet
printf '%s\n' '[extend]' 'useDefault = true' '[allowlist]' 'description = "runtime malicious repository config"' 'paths = [".*"]' >"${secret_fixture}/.gitleaks.toml"
runtime_secret="$(printf '%s%s%s%s' 'gh' 'p_' 'A1b2C3d4E5f6G7h8' 'I9j0K1l2M3n4O5p6Q7r8')"
printf 'token=%s # gitleaks:allow\n' "${runtime_secret}" >"${secret_fixture}/historical.txt"
git -C "${secret_fixture}" add .gitleaks.toml historical.txt
git -C "${secret_fixture}" -c user.name='Security Fixture' -c user.email='security-fixture.invalid@example.invalid' commit --quiet -m 'runtime secret fixture'
secret_fixture_original_commit="$(git -C "${secret_fixture}" rev-parse HEAD)"
printf '%s\n' 'benign replacement' >"${secret_fixture}/historical.txt"
git -C "${secret_fixture}" add historical.txt
git -C "${secret_fixture}" -c user.name='Security Fixture' -c user.email='security-fixture.invalid@example.invalid' commit --quiet -m 'remove runtime secret fixture'
secret_fixture_benign_commit="$(git -C "${secret_fixture}" rev-parse HEAD)"

expect_failure "Gitleaks full-history negative fixture" security_run_gitleaks_history "${secret_fixture}" "${gitleaks_config}" "" "${output_root}/gitleaks-history-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-history-negative.log" || fail "Gitleaks history failure did not contain a finding"
if grep -Fq -- "${runtime_secret}" "${output_root}/gitleaks-history-negative.log"; then
  fail "Gitleaks history output exposed the runtime secret"
fi

git -C "${secret_fixture}" replace "${secret_fixture_original_commit}" "${secret_fixture_benign_commit}"
expect_failure "Git replacement ref repository guard" security_validate_git_repository_inputs "${secret_fixture}"
expect_failure "Gitleaks replacement-object history fixture" security_run_gitleaks_history "${secret_fixture}" "${gitleaks_config}" "" "${output_root}/gitleaks-replace-history-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-replace-history-negative.log" || fail "Gitleaks replacement-object history did not retain the real finding"
if grep -Fq -- "${runtime_secret}" "${output_root}/gitleaks-replace-history-negative.log"; then
  fail "Gitleaks replacement-object history output exposed the runtime secret"
fi
git -C "${secret_fixture}" replace -d "${secret_fixture_original_commit}" >/dev/null

printf 'token=%s # gitleaks:allow\n' "${runtime_secret}" >"${secret_fixture}/staged.txt"
git -C "${secret_fixture}" add staged.txt
expect_failure "Gitleaks staged negative fixture" security_run_gitleaks_staged "${secret_fixture}" "${gitleaks_config}" "" "${output_root}/gitleaks-staged-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-staged-negative.log" || fail "Gitleaks staged failure did not contain a finding"
if grep -Fq -- "${runtime_secret}" "${output_root}/gitleaks-staged-negative.log"; then
  fail "Gitleaks staged output exposed the runtime secret"
fi

expect_failure "Gitleaks directory negative fixture" security_run_gitleaks_directory "${secret_fixture}" "${gitleaks_config}" "" "${output_root}/gitleaks-directory-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-directory-negative.log" || fail "Gitleaks directory failure did not contain a finding"
if grep -Fq -- "${runtime_secret}" "${output_root}/gitleaks-directory-negative.log"; then
  fail "Gitleaks directory output exposed the runtime secret"
fi
unset runtime_secret secret_fixture_original_commit secret_fixture_benign_commit
pass "Gitleaks rejects repository config, allow-comment, and replacement-object bypasses without exposing values"

normalized_magic_fixture="${test_root}/normalized-magic"
normalized_magic_candidate="${normalized_magic_fixture}/candidate"
mkdir -p -- "${normalized_magic_candidate}"
normalized_magic_secret="$(printf '%s%s%s%s' 'gh' 'p_' 'M1i2M3e4P5a6T7h8' 'B9y0P1a2S3s4F5i6L7e8')"
printf '%%PDF-1.7\ntoken=%s\n' "${normalized_magic_secret}" >"${normalized_magic_candidate}/pdf.txt"
printf '{\\rtf1 token=%s}\n' "${normalized_magic_secret}" >"${normalized_magic_candidate}/rtf.txt"
printf '%%!PS-Adobe-3.0\ntoken=%s\n' "${normalized_magic_secret}" >"${normalized_magic_candidate}/postscript.txt"
printf 'GIF89atoken=%s\n' "${normalized_magic_secret}" >"${normalized_magic_candidate}/gif.txt"
security_validate_candidate_text_files "${normalized_magic_candidate}" \
  || fail "strict approved-text policy rejected printable MIME-magic fixture"
expect_failure \
  "normalized candidate MIME-magic secret fixture" \
  security_run_gitleaks_normalized_text \
  "${normalized_magic_candidate}" \
  candidate \
  "${gitleaks_config}" \
  "${output_root}/gitleaks-normalized-candidate-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-normalized-candidate-negative.log" \
  || fail "normalized candidate view did not expose printable MIME-magic content to Gitleaks"
if grep -Fq -- "${normalized_magic_secret}" "${output_root}/gitleaks-normalized-candidate-negative.log"; then
  fail "normalized candidate output exposed the runtime secret"
fi

normalized_magic_repo="${normalized_magic_fixture}/repo"
mkdir -p -- "${normalized_magic_repo}"
git -C "${normalized_magic_repo}" init --quiet
printf '%s\n' 'benign root' >"${normalized_magic_repo}/magic.txt"
git -C "${normalized_magic_repo}" add magic.txt
git -C "${normalized_magic_repo}" -c user.name='Normalized Magic Fixture' -c user.email='normalized-magic-fixture.invalid@example.invalid' commit --quiet -m root
printf '%%PDF-1.7\ntoken=%s\n' "${normalized_magic_secret}" >"${normalized_magic_repo}/magic.txt"
git -C "${normalized_magic_repo}" add magic.txt
printf '%s\n' 'benign worktree divergence' >"${normalized_magic_repo}/magic.txt"
security_validate_staged_text_files "${normalized_magic_repo}" \
  || fail "strict staged text policy rejected printable MIME-magic fixture"
expect_failure \
  "normalized staged MIME-magic secret fixture" \
  security_run_gitleaks_normalized_text \
  "${normalized_magic_repo}" \
  staged \
  "${gitleaks_config}" \
  "${output_root}/gitleaks-normalized-staged-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-normalized-staged-negative.log" \
  || fail "normalized staged view did not scan index/worktree divergence"
if grep -Fq -- "${normalized_magic_secret}" "${output_root}/gitleaks-normalized-staged-negative.log"; then
  fail "normalized staged output exposed the runtime secret"
fi
git -C "${normalized_magic_repo}" -c user.name='Normalized Magic Fixture' -c user.email='normalized-magic-fixture.invalid@example.invalid' commit --quiet -m 'MIME-magic secret'
git -C "${normalized_magic_repo}" add magic.txt
git -C "${normalized_magic_repo}" -c user.name='Normalized Magic Fixture' -c user.email='normalized-magic-fixture.invalid@example.invalid' commit --quiet -m 'remove MIME-magic secret'
security_validate_history_text_files "${normalized_magic_repo}" \
  || fail "strict history text policy rejected printable MIME-magic fixture"
expect_failure \
  "normalized historical MIME-magic secret fixture" \
  security_run_gitleaks_normalized_text \
  "${normalized_magic_repo}" \
  history \
  "${gitleaks_config}" \
  "${output_root}/gitleaks-normalized-history-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-normalized-history-negative.log" \
  || fail "normalized history view did not scan the deleted MIME-magic blob"
if grep -Fq -- "${normalized_magic_secret}" "${output_root}/gitleaks-normalized-history-negative.log"; then
  fail "normalized history output exposed the runtime secret"
fi
unset normalized_magic_secret
pass "trusted-prefix views expose printable MIME/path-skipped secrets in candidate, divergent index, and deleted history without exposing values"

normalized_name_fixture="${test_root}/normalized-names"
normalized_name_candidate="${normalized_name_fixture}/candidate"
normalized_name_repo="${normalized_name_fixture}/repo"
normalized_name_secret="$(printf '%s%s%s%s' 'gh' 'p_' 'N8m7L6k5J4h3G2f1' 'E0d9C8b7A6z5Y4x3W2v1')"
normalized_secret_filename="${normalized_name_secret}.txt"
mkdir -p -- "${normalized_name_candidate}" "${normalized_name_repo}"
printf '%s\n' 'benign candidate content' >"${normalized_name_candidate}/${normalized_secret_filename}"
security_validate_candidate_text_files "${normalized_name_candidate}" \
  || fail "strict approved-text policy rejected credential-like candidate filename fixture"
expect_failure \
  "normalized candidate filename-only secret fixture" \
  security_run_gitleaks_normalized_text \
  "${normalized_name_candidate}" \
  candidate \
  "${gitleaks_config}" \
  "${output_root}/gitleaks-normalized-candidate-name-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-normalized-candidate-name-negative.log" \
  || fail "normalized candidate name manifest did not contain a finding"
if grep -Fq -- "${normalized_name_secret}" "${output_root}/gitleaks-normalized-candidate-name-negative.log"; then
  fail "normalized candidate name output exposed the runtime secret"
fi

git -C "${normalized_name_repo}" init --quiet
printf '%s\n' 'benign root' >"${normalized_name_repo}/root.txt"
git -C "${normalized_name_repo}" add root.txt
git -C "${normalized_name_repo}" -c user.name='Normalized Name Fixture' -c user.email='normalized-name-fixture.invalid@example.invalid' commit --quiet -m root
printf '%s\n' 'benign staged content' >"${normalized_name_repo}/${normalized_secret_filename}"
git -C "${normalized_name_repo}" add "${normalized_secret_filename}"
mv -- "${normalized_name_repo}/${normalized_secret_filename}" "${normalized_name_repo}/worktree-benign.txt"
security_validate_staged_text_files "${normalized_name_repo}" \
  || fail "strict staged text policy rejected credential-like index filename fixture"
expect_failure \
  "normalized staged filename-only secret fixture" \
  security_run_gitleaks_normalized_text \
  "${normalized_name_repo}" \
  staged \
  "${gitleaks_config}" \
  "${output_root}/gitleaks-normalized-staged-name-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-normalized-staged-name-negative.log" \
  || fail "normalized staged name manifest did not contain a finding"
if grep -Fq -- "${normalized_name_secret}" "${output_root}/gitleaks-normalized-staged-name-negative.log"; then
  fail "normalized staged name output exposed the runtime secret"
fi
git -C "${normalized_name_repo}" -c user.name='Normalized Name Fixture' -c user.email='normalized-name-fixture.invalid@example.invalid' commit --quiet -m 'add filename fixture'
git -C "${normalized_name_repo}" add --all
git -C "${normalized_name_repo}" -c user.name='Normalized Name Fixture' -c user.email='normalized-name-fixture.invalid@example.invalid' commit --quiet -m 'remove filename fixture'
security_validate_history_text_files "${normalized_name_repo}" \
  || fail "strict history text policy rejected credential-like historical filename fixture"
expect_failure \
  "normalized historical filename-only secret fixture" \
  security_run_gitleaks_normalized_text \
  "${normalized_name_repo}" \
  history \
  "${gitleaks_config}" \
  "${output_root}/gitleaks-normalized-history-name-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-normalized-history-name-negative.log" \
  || fail "normalized historical name manifest did not contain a finding"
if grep -Fq -- "${normalized_name_secret}" "${output_root}/gitleaks-normalized-history-name-negative.log"; then
  fail "normalized historical name output exposed the runtime secret"
fi
unset normalized_secret_filename normalized_name_secret
pass "bounded name manifests reject candidate, divergent index, and deleted-history filename-only secrets without exposing values"

normalized_metadata_fixture="${test_root}/normalized-metadata"
normalized_metadata_secret="$(printf '%s%s%s%s' 'gh' 'p_' 'Q1w2E3r4T5y6U7i8' 'O9p0A1s2D3f4G5h6J7k8')"
for metadata_case in commit tag ref; do
  metadata_repo="${normalized_metadata_fixture}/${metadata_case}"
  mkdir -p -- "${metadata_repo}"
  git -C "${metadata_repo}" init --quiet
  printf '%s\n' 'benign metadata fixture' >"${metadata_repo}/fixture.txt"
  git -C "${metadata_repo}" add fixture.txt
  if [[ "${metadata_case}" == "commit" ]]; then
    git -C "${metadata_repo}" -c user.name='Normalized Metadata Fixture' -c user.email='normalized-metadata-fixture.invalid@example.invalid' commit --quiet -m "${normalized_metadata_secret}"
  else
    git -C "${metadata_repo}" -c user.name='Normalized Metadata Fixture' -c user.email='normalized-metadata-fixture.invalid@example.invalid' commit --quiet -m root
  fi
  if [[ "${metadata_case}" == "tag" ]]; then
    git -C "${metadata_repo}" -c user.name='Normalized Metadata Fixture' -c user.email='normalized-metadata-fixture.invalid@example.invalid' tag -a reviewed-tag -m "${normalized_metadata_secret}"
  elif [[ "${metadata_case}" == "ref" ]]; then
    git -C "${metadata_repo}" branch "${normalized_metadata_secret}"
  fi
  security_validate_history_text_files "${metadata_repo}" \
    || fail "strict history text policy rejected ${metadata_case} metadata fixture"
  expect_failure \
    "normalized ${metadata_case} metadata-only secret fixture" \
    security_run_gitleaks_normalized_text \
    "${metadata_repo}" \
    history \
    "${gitleaks_config}" \
    "${output_root}/gitleaks-normalized-${metadata_case}-metadata-negative.log"
  grep -Fq -- 'leaks found' "${output_root}/gitleaks-normalized-${metadata_case}-metadata-negative.log" \
    || fail "normalized ${metadata_case} metadata view did not contain a finding"
  if grep -Fq -- "${normalized_metadata_secret}" "${output_root}/gitleaks-normalized-${metadata_case}-metadata-negative.log"; then
    fail "normalized ${metadata_case} metadata output exposed the runtime secret"
  fi
done
unset metadata_case metadata_repo normalized_metadata_secret
pass "normalized history rejects secrets present only in commit messages, annotated-tag messages, or lightweight ref names"

merge_secret_fixture="${test_root}/merge-secret"
mkdir -p -- "${merge_secret_fixture}"
git -C "${merge_secret_fixture}" init --quiet
git -C "${merge_secret_fixture}" symbolic-ref HEAD refs/heads/main
printf '%s\n' 'state=base' >"${merge_secret_fixture}/resolution.txt"
git -C "${merge_secret_fixture}" add resolution.txt
git -C "${merge_secret_fixture}" -c user.name='Merge Fixture' -c user.email='merge-fixture.invalid@example.invalid' commit --quiet -m base
git -C "${merge_secret_fixture}" checkout --quiet -b feature
printf '%s\n' 'state=feature' >"${merge_secret_fixture}/resolution.txt"
git -C "${merge_secret_fixture}" add resolution.txt
git -C "${merge_secret_fixture}" -c user.name='Merge Fixture' -c user.email='merge-fixture.invalid@example.invalid' commit --quiet -m feature
git -C "${merge_secret_fixture}" checkout --quiet main
printf '%s\n' 'state=main' >"${merge_secret_fixture}/resolution.txt"
git -C "${merge_secret_fixture}" add resolution.txt
git -C "${merge_secret_fixture}" -c user.name='Merge Fixture' -c user.email='merge-fixture.invalid@example.invalid' commit --quiet -m main
merge_status=0
git -C "${merge_secret_fixture}" \
  -c user.name='Merge Fixture' \
  -c user.email='merge-fixture.invalid@example.invalid' \
  merge --no-ff --no-commit feature >"${output_root}/merge-fixture.log" 2>&1 || merge_status=$?
[[ "${merge_status}" -ne 0 && -f "${merge_secret_fixture}/.git/MERGE_HEAD" ]] || fail "could not create the merge-resolution fixture"
merge_runtime_secret="$(printf '%s%s%s%s' 'gh' 'p_' 'Z9y8X7w6V5u4T3s2' 'R1q0P9o8N7m6L5k4J3h2')"
printf 'state=resolved\ntoken=%s\n' "${merge_runtime_secret}" >"${merge_secret_fixture}/resolution.txt"
git -C "${merge_secret_fixture}" add resolution.txt
git -C "${merge_secret_fixture}" -c user.name='Merge Fixture' -c user.email='merge-fixture.invalid@example.invalid' commit --quiet -m 'merge resolution'
printf '%s\n' 'state=clean' >"${merge_secret_fixture}/resolution.txt"
git -C "${merge_secret_fixture}" add resolution.txt
git -C "${merge_secret_fixture}" -c user.name='Merge Fixture' -c user.email='merge-fixture.invalid@example.invalid' commit --quiet -m 'remove merge resolution secret'
expect_failure "Gitleaks merge-resolution history fixture" security_run_gitleaks_history "${merge_secret_fixture}" "${gitleaks_config}" "" "${output_root}/gitleaks-merge-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-merge-negative.log" || fail "Gitleaks merge-resolution history did not contain a finding"
if grep -Fq -- "${merge_runtime_secret}" "${output_root}/gitleaks-merge-negative.log"; then
  fail "Gitleaks merge-resolution output exposed the runtime secret"
fi
unset merge_runtime_secret
pass "Gitleaks scans merge-resolution history even after a later deletion"

binary_history_fixture="${test_root}/binary-history-secret"
mkdir -p -- "${binary_history_fixture}"
git -C "${binary_history_fixture}" init --quiet
binary_history_secret="$(printf '%s%s%s%s' 'gh' 'p_' 'B1n2A3r4Y5h6I7s8' 'T9o0R1y2S3e4C5r6E7t8')"
printf '%s\n' 'historical.txt binary' >"${binary_history_fixture}/.gitattributes"
printf 'token=%s\n' "${binary_history_secret}" >"${binary_history_fixture}/historical.txt"
git -C "${binary_history_fixture}" add .gitattributes historical.txt
git -C "${binary_history_fixture}" -c user.name='Binary Fixture' -c user.email='binary-fixture.invalid@example.invalid' commit --quiet -m 'binary-attributed secret'
printf '%s\n' 'benign replacement' >"${binary_history_fixture}/historical.txt"
git -C "${binary_history_fixture}" add historical.txt
git -C "${binary_history_fixture}" -c user.name='Binary Fixture' -c user.email='binary-fixture.invalid@example.invalid' commit --quiet -m 'remove binary-attributed secret'
expect_failure \
  "Gitleaks binary-attributed history fixture" \
  security_run_gitleaks_history \
  "${binary_history_fixture}" \
  "${gitleaks_config}" \
  "" \
  "${output_root}/gitleaks-binary-history-negative.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-binary-history-negative.log" \
  || fail "Gitleaks binary-attributed history did not contain a finding"
if grep -Fq -- "${binary_history_secret}" "${output_root}/gitleaks-binary-history-negative.log"; then
  fail "Gitleaks binary-attributed history output exposed the runtime secret"
fi
unset binary_history_secret
pass "Gitleaks forces binary-attributed deleted history through redacted text scanning"

archive_secret_fixture="${test_root}/archive-secret"
archive_secret_repo="${archive_secret_fixture}/repo"
mkdir -p -- "${archive_secret_repo}/input"
git -C "${archive_secret_repo}" init --quiet
archive_runtime_secret="$(printf '%s%s%s%s' 'gh' 'p_' 'K1l2M3n4O5p6Q7r8' 'S9t0U1v2W3x4Y5z6A7b8')"
printf 'token=%s\n' "${archive_runtime_secret}" >"${archive_secret_repo}/input/secret.txt"
tar -C "${archive_secret_repo}/input" -cf "${archive_secret_repo}/current-secret.tar" secret.txt
unlink -- "${archive_secret_repo}/input/secret.txt"
rmdir -- "${archive_secret_repo}/input"
expect_failure "Gitleaks current archive fixture" security_run_gitleaks_directory "${archive_secret_repo}" "${gitleaks_config}" "" "${output_root}/gitleaks-archive-current.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-archive-current.log" || fail "Gitleaks current archive fixture did not contain a finding"
if grep -Fq -- "${archive_runtime_secret}" "${output_root}/gitleaks-archive-current.log"; then
  fail "Gitleaks current archive output exposed the runtime secret"
fi
git -C "${archive_secret_repo}" add current-secret.tar
git -C "${archive_secret_repo}" -c user.name='Archive Fixture' -c user.email='archive-fixture.invalid@example.invalid' commit --quiet -m 'runtime archive fixture'
git -C "${archive_secret_repo}" rm --quiet current-secret.tar
git -C "${archive_secret_repo}" -c user.name='Archive Fixture' -c user.email='archive-fixture.invalid@example.invalid' commit --quiet -m 'remove runtime archive fixture'
expect_failure "Gitleaks deleted archive history fixture" security_run_gitleaks_history "${archive_secret_repo}" "${gitleaks_config}" "" "${output_root}/gitleaks-archive-history.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-archive-history.log" || fail "Gitleaks deleted archive history fixture did not contain a finding"
if grep -Fq -- "${archive_runtime_secret}" "${output_root}/gitleaks-archive-history.log"; then
  fail "Gitleaks archive history output exposed the runtime secret"
fi
pass "Gitleaks scans current and deleted historical archives without exposing values"

archive_bound_fixture="${test_root}/archive-bound"
create_nested_tar_fixture "${archive_bound_fixture}/depth-five-work" "${archive_bound_fixture}/depth-five/nested.tar" 5 "${archive_runtime_secret}"
expect_failure "Gitleaks depth-five archive fixture" security_run_gitleaks_directory "${archive_bound_fixture}/depth-five" "${gitleaks_config}" "" "${output_root}/gitleaks-archive-depth-five.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-archive-depth-five.log" || fail "Gitleaks did not scan the configured archive depth"
if grep -Fq -- "${archive_runtime_secret}" "${output_root}/gitleaks-archive-depth-five.log"; then
  fail "Gitleaks bounded archive output exposed the runtime secret"
fi
create_nested_tar_fixture "${archive_bound_fixture}/depth-six-work" "${archive_bound_fixture}/depth-six/nested.tar" 6 "${archive_runtime_secret}"
expect_failure "Gitleaks over-depth archive fixture" security_run_gitleaks_directory "${archive_bound_fixture}/depth-six" "${gitleaks_config}" "" "${output_root}/gitleaks-archive-depth-six.log"
grep -Fq -- 'WRN skipping archive: exceeds max archive depth' "${output_root}/gitleaks-archive-depth-six.log" || fail "Gitleaks over-depth archive did not emit the required fail-closed warning"

encrypted_archive_fixture="${test_root}/encrypted-archive"
mkdir -p -- "${encrypted_archive_fixture}/input" "${encrypted_archive_fixture}/scan"
printf 'token=%s\n' "${archive_runtime_secret}" >"${encrypted_archive_fixture}/input/secret.txt"
(
  cd -- "${encrypted_archive_fixture}/input"
  zip -q -P runtime-fixture-password "${encrypted_archive_fixture}/scan/encrypted.zip" secret.txt
)
unlink -- "${encrypted_archive_fixture}/input/secret.txt"
rmdir -- "${encrypted_archive_fixture}/input"
expect_failure "Gitleaks encrypted archive fixture" security_run_gitleaks_directory "${encrypted_archive_fixture}/scan" "${gitleaks_config}" "" "${output_root}/gitleaks-archive-encrypted.log"
grep -Fq -- ' ERR ' "${output_root}/gitleaks-archive-encrypted.log" || fail "Gitleaks encrypted archive did not emit a fail-closed scanner error"
if grep -Fq -- "${archive_runtime_secret}" "${output_root}/gitleaks-archive-depth-six.log" "${output_root}/gitleaks-archive-encrypted.log"; then
  fail "Gitleaks skipped-archive output exposed the runtime secret"
fi
pass "Gitleaks scans five archive layers and fails closed on deeper or encrypted archives"

decode_fixture="${test_root}/decode-bound"
mkdir -p -- "${decode_fixture}"
encoded_value="token=${archive_runtime_secret}"
for _ in 1 2 3 4 5; do
  encoded_value="$(printf '%s' "${encoded_value}" | base64 -w 0)"
done
printf '%s\n' "${encoded_value}" >"${decode_fixture}/encoded.txt"
expect_failure "Gitleaks depth-five decode fixture" security_run_gitleaks_directory "${decode_fixture}" "${gitleaks_config}" "" "${output_root}/gitleaks-decode-depth-five.log"
grep -Fq -- 'leaks found' "${output_root}/gitleaks-decode-depth-five.log" || fail "Gitleaks did not scan the configured decode depth"
if grep -Fq -- "${archive_runtime_secret}" "${output_root}/gitleaks-decode-depth-five.log"; then
  fail "Gitleaks decoded output exposed the runtime secret"
fi
encoded_value="$(printf '%s' "${encoded_value}" | base64 -w 0)"
printf '%s\n' "${encoded_value}" >"${decode_fixture}/encoded.txt"
if ! security_run_gitleaks_directory "${decode_fixture}" "${gitleaks_config}" "" "${output_root}/gitleaks-decode-depth-six.log"; then
  fail "Gitleaks decode depth beyond the reviewed bound produced an unexpected signal"
fi
if grep -Fq -- 'Finding:' "${output_root}/gitleaks-decode-depth-six.log"; then
  fail "Gitleaks decode depth beyond the reviewed bound unexpectedly produced a finding"
fi
unset archive_runtime_secret encoded_value
pass "Gitleaks recursive decoding is verified at the reviewed depth-five bound"

iac_fixture="${test_root}/iac"
mkdir -p -- "${iac_fixture}"
iac_lines=(
  'resource "aws_security_group_rule" "public_ssh" {'
  '  type              = "ingress"'
  '  from_port         = 22'
  '  to_port           = 22'
  '  protocol          = "tcp"'
  '  cidr_blocks       = ["0.0.0.0/0"]'
  '  security_group_id = "sg-runtime-fixture"'
  '}'
)
printf '%s\n' "${iac_lines[@]}" >"${iac_fixture}/main.tf"
printf '%s\n' \
  'locals {' \
  '  module_description = "root module text only"' \
  '  module_heredoc     = <<-EOT' \
  '    module "heredoc_decoy" {' \
  '      source = "https://example.invalid/not-a-module.zip"' \
  '    }' \
  '  EOT' \
  '}' \
  '# module "line_comment_decoy" {' \
  '/*' \
  'module "block_comment_decoy" {' \
  '  source = "git::https://example.invalid/not-a-module.git"' \
  '}' \
  '*/' \
  >"${iac_fixture}/module-decoy.tf"
printf '%s\n' 'terraform {' >"${iac_fixture}/broken.tf"
expect_failure "malformed Terraform source fixture" security_run_trivy_config "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" "trivy-iac-malformed.json" "${output_root}/trivy-iac-malformed.log" "${trivy_config}"
[[ ! -e "${output_root}/trivy-iac-malformed.json" ]] \
  || fail "malformed Terraform source reached Trivy after syntax preflight failure"
unlink -- "${iac_fixture}/broken.tf"
printf '%s\n' '{ broken' >"${iac_fixture}/broken.tf.json"
expect_failure "Terraform JSON source fixture" security_run_trivy_config "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" "trivy-iac-json.json" "${output_root}/trivy-iac-json.log" "${trivy_config}"
[[ ! -e "${output_root}/trivy-iac-json.json" ]] \
  || fail "unsupported Terraform JSON source reached Trivy"
unlink -- "${iac_fixture}/broken.tf.json"
terraform_module_cases=(
  'registry|hashicorp/consul/aws'
  'local|./local-module'
  'git|git::https://example.invalid/unscanned.git?ref=v1.0.0'
  'http|https://example.invalid/unscanned-module.zip'
)
for terraform_module_case in "${terraform_module_cases[@]}"; do
  terraform_module_kind="${terraform_module_case%%|*}"
  terraform_module_source="${terraform_module_case#*|}"
  printf '%s\n' \
    "module \"unscanned_${terraform_module_kind}\" {" \
    "  source = \"${terraform_module_source}\"" \
    '}' \
    >"${iac_fixture}/module-${terraform_module_kind}.tf"
  expect_failure \
    "Terraform ${terraform_module_kind} module fixture" \
    security_run_trivy_config \
    "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" \
    "trivy-iac-module-${terraform_module_kind}.json" \
    "${output_root}/trivy-iac-module-${terraform_module_kind}.log" \
    "${trivy_config}"
  [[ ! -e "${output_root}/trivy-iac-module-${terraform_module_kind}.json" ]] \
    || fail "Terraform ${terraform_module_kind} module reached Trivy without a fetched-content scan"
  unlink -- "${iac_fixture}/module-${terraform_module_kind}.tf"
done
printf '%s\n' \
  'module /* policy boundary */ "comment_interleaved" {' \
  '  source = "./local-module"' \
  '}' \
  >"${iac_fixture}/module-comment-interleaved.tf"
expect_failure \
  "Terraform comment-interleaved module fixture" \
  security_run_trivy_config \
  "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" \
  "trivy-iac-module-comment-interleaved.json" \
  "${output_root}/trivy-iac-module-comment-interleaved.log" \
  "${trivy_config}"
[[ ! -e "${output_root}/trivy-iac-module-comment-interleaved.json" ]] \
  || fail "Terraform comment-interleaved module reached Trivy"
unlink -- "${iac_fixture}/module-comment-interleaved.tf"
unset terraform_module_case terraform_module_cases terraform_module_kind terraform_module_source
for terraform_variable_name in \
  terraform.tfvars \
  terraform.tfvars.json \
  override.auto.tfvars \
  override.auto.tfvars.json; do
  printf '%s\n' 'cloudflare_account_id = "00000000000000000000000000000000"' >"${iac_fixture}/${terraform_variable_name}"
  expect_failure \
    "Terraform auto-loaded ${terraform_variable_name} fixture" \
    security_run_trivy_config \
    "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" \
    "trivy-iac-variable-${terraform_variable_name}.json" \
    "${output_root}/trivy-iac-variable-${terraform_variable_name}.log" \
    "${trivy_config}"
  [[ ! -e "${output_root}/trivy-iac-variable-${terraform_variable_name}.json" ]] \
    || fail "Terraform auto-loaded variable file reached Trivy"
  unlink -- "${iac_fixture}/${terraform_variable_name}"
done
unset terraform_variable_name
mkdir -p -- "${iac_fixture}/.terraform/providers/example.invalid/provider"
printf '%s\n' 'untrusted provider cache entry' >"${iac_fixture}/.terraform/providers/example.invalid/provider/binary"
expect_failure \
  "tracked Terraform working directory fixture" \
  security_run_trivy_config \
  "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" \
  "trivy-iac-working-directory.json" \
  "${output_root}/trivy-iac-working-directory.log" \
  "${trivy_config}"
[[ ! -e "${output_root}/trivy-iac-working-directory.json" ]] \
  || fail "Terraform working directory reached Trivy"
unlink -- "${iac_fixture}/.terraform/providers/example.invalid/provider/binary"
rmdir -- \
  "${iac_fixture}/.terraform/providers/example.invalid/provider" \
  "${iac_fixture}/.terraform/providers/example.invalid" \
  "${iac_fixture}/.terraform/providers" \
  "${iac_fixture}/.terraform"
expect_failure "Trivy IaC negative fixture" security_run_trivy_config "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" "trivy-iac-negative.json" "${output_root}/trivy-iac-negative.log" "${trivy_config}"
security_classify_json_report "${output_root}/trivy-iac-negative.json" "trivy-misconfiguration" >/dev/null || fail "Trivy IaC failure did not contain a valid in-scope misconfiguration"
trivy_rule_command=(
  docker run --rm
  --volume "${output_root}:/input:ro"
  "${SECURITY_NODE_IMAGE}"
  node -e
  '
    try {
      const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const ids = (report.Results ?? []).flatMap((result) =>
        (result.Misconfigurations ?? []).map((issue) => issue.ID),
      );
      if (ids.length === 0 || !/^[A-Z0-9-]+$/.test(ids[0])) process.exit(2);
      console.log(ids[0]);
    } catch {
      process.exit(2);
    }
  '
  /input/trivy-iac-negative.json
)
iac_rule_id="$("${trivy_rule_command[@]}" 2>/dev/null)" || fail "could not derive the runtime Trivy fixture rule ID"
printf '%s\n' 'skip-files:' '  - main.tf' >"${iac_fixture}/trivy.yaml"
expect_failure "Trivy repository config negative fixture" security_run_trivy_config "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" "trivy-iac-config.json" "${output_root}/trivy-iac-config.log" "${trivy_config}"
security_classify_json_report "${output_root}/trivy-iac-config.json" "trivy-misconfiguration" >/dev/null || fail "repository trivy.yaml bypassed the script-owned empty config"
printf '%s\n' "${iac_rule_id}" >"${iac_fixture}/.trivyignore"
expect_failure "Trivy repository ignore negative fixture" security_run_trivy_config "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" "trivy-iac-ignorefile.json" "${output_root}/trivy-iac-ignorefile.log" "${trivy_config}"
security_classify_json_report "${output_root}/trivy-iac-ignorefile.json" "trivy-misconfiguration" >/dev/null || fail "repository .trivyignore bypassed the script-owned empty ignore policy"
printf '%s\n' "#trivy:ignore:${iac_rule_id}" "${iac_lines[@]}" >"${iac_fixture}/main.tf"
if ! security_run_trivy_config "${iac_fixture}" "." "${trivy_cache_root}" "${output_root}" "trivy-iac-inline.json" "${output_root}/trivy-iac-inline.log" "${trivy_config}"; then
  fail "Trivy inline-ignore fixture did not produce the expected suppressed clean report"
fi
assert_report_classification 2 trivy-misconfiguration "${output_root}/trivy-iac-inline.json" "Trivy inline-ignore report"
unset iac_rule_id
pass "Terraform syntax preflight rejects unparsed files; Trivy rejects public SSH and repository or inline ignores"

gosec_fixture="${test_root}/gosec"
mkdir -p -- "${gosec_fixture}"
printf '%s\n' 'module example.invalid/securityfixture' '' 'go 1.26.6' >"${gosec_fixture}/go.mod"
gosec_lines=(
  '//go:build !cgo'
  ''
  '// Code generated by a runtime security fixture. DO NOT EDIT.'
  'package main'
  ''
  'import "crypto/tls"'
  ''
  'func main() {'
  '    _ = &tls.Config{MinVersion: tls.VersionTLS10}'
  '}'
)
printf '%s\n' "${gosec_lines[@]}" >"${gosec_fixture}/main.go"
expect_failure "gosec negative fixture" security_run_gosec "${gosec_fixture}" "${go_cache_root}" "${output_root}" "gosec-negative.json" "${output_root}/gosec-negative.log"
security_classify_json_report "${output_root}/gosec-negative.json" "gosec-high" >/dev/null || fail "gosec failure did not contain a valid HIGH/high-confidence issue"
gosec_suppressed_lines=(
  'package main'
  ''
  'import "crypto/tls"'
  ''
  'func main() {'
  '    // #nosec G402 -- runtime fixture verifies that suppressions fail the gate.'
  '    _ = &tls.Config{MinVersion: tls.VersionTLS10}'
  '}'
)
printf '%s\n' "${gosec_suppressed_lines[@]}" >"${gosec_fixture}/main.go"
if ! security_run_gosec "${gosec_fixture}" "${go_cache_root}" "${output_root}" "gosec-suppressed.json" "${output_root}/gosec-suppressed.log"; then
  fail "gosec nosec fixture did not produce the expected suppressed clean report"
fi
assert_report_classification 2 gosec-high "${output_root}/gosec-suppressed.json" "gosec nosec report"
pass "gosec scans generated-marked Go, rejects weak TLS, and treats nosec suppression as invalid"

node_fixture="${test_root}/node-vulnerability"
mkdir -p -- "${node_fixture}"
node_lines=(
  '{'
  '  "name": "security-negative-fixture",'
  '  "version": "1.0.0",'
  '  "private": true,'
  '  "dependencies": {"lodash": "4.17.20"}'
  '}'
)
printf '%s\n' "${node_lines[@]}" >"${node_fixture}/package.json"
node_install_command=(
  docker run --rm
  --user "$(id -u):$(id -g)"
  --env HOME=/tmp
  --volume "${node_fixture}:/workspace"
  --workdir /workspace
  "${SECURITY_PNPM_IMAGE}"
  pnpm install --lockfile-only --ignore-scripts
)
if ! "${node_install_command[@]}" >"${output_root}/pnpm-fixture-install.log" 2>&1; then
  fail "could not create the runtime Node vulnerability lockfile"
fi
expect_failure "pnpm audit negative fixture" security_run_node_audit "${node_fixture}" "${output_root}/pnpm-negative.json" "${output_root}/pnpm-negative.log"
security_classify_json_report "${output_root}/pnpm-negative.json" "node-vulnerability" >/dev/null || fail "pnpm audit failure did not contain a valid HIGH/CRITICAL vulnerability"
pass "pnpm audit rejects a runtime-generated vulnerable Node lockfile"

govuln_fixture="${test_root}/go-vulnerability"
mkdir -p -- "${govuln_fixture}"
govuln_mod_lines=(
  'module example.invalid/vulnfixture'
  ''
  'go 1.26.6'
  ''
  'require golang.org/x/text v0.3.5'
)
printf '%s\n' "${govuln_mod_lines[@]}" >"${govuln_fixture}/go.mod"
govuln_source_lines=(
  '//go:build !cgo'
  ''
  'package main'
  ''
  'import ('
  '    "fmt"'
  '    "golang.org/x/text/language"'
  ')'
  ''
  'func main() {'
  '    tag, _ := language.Parse("en-u-rg-uszzzz")'
  '    fmt.Println(tag)'
  '}'
)
printf '%s\n' "${govuln_source_lines[@]}" >"${govuln_fixture}/main.go"
security_prepare_go_cache "${go_cache_root}"
go_download_command=(
  docker run --rm
  --user "$(id -u):$(id -g)"
  --env HOME=/cache/home
  --env GOCACHE=/cache/build
  --env GOMODCACHE=/cache/mod
  --env GOPATH=/cache/gopath
  --env GOFLAGS=-modcacherw
  --volume "${go_cache_root}:/cache"
  --volume "${govuln_fixture}:/workspace"
  --workdir /workspace
  "${SECURITY_GO_IMAGE}"
  go mod tidy
)
if ! "${go_download_command[@]}" >"${output_root}/govuln-fixture-tidy.log" 2>&1; then
  fail "could not create the runtime Go vulnerability checksum file"
fi
expect_failure "govulncheck negative fixture" security_run_govulncheck "${govuln_fixture}" "${go_cache_root}" "${output_root}/govuln-negative.log"
grep -Fq -- 'Your code is affected by' "${output_root}/govuln-negative.log" || fail "govulncheck failure did not report a reachable vulnerability"
pass "govulncheck rejects a runtime-generated reachable Go vulnerability"

image_fixture="${test_root}/image-vulnerability"
mkdir -p -- "${image_fixture}"
# shellcheck disable=SC2016 # The generated Dockerfile expands this build ARG.
image_lines=(
  'ARG FIXTURE_IMAGE'
  'FROM ${FIXTURE_IMAGE}'
  'USER 65532:65532'
  'CMD ["/bin/true"]'
)
printf '%s\n' "${image_lines[@]}" >"${image_fixture}/Dockerfile"
if ! security_require_temporary_image_tag_absent "${fixture_image_tag}"; then
  fail "could not confirm that the negative-fixture image tag is absent"
fi
image_build_command=(
  docker build
  --build-arg "FIXTURE_IMAGE=${SECURITY_VULNERABLE_FIXTURE_IMAGE}"
  --file "${image_fixture}/Dockerfile"
  --tag "${fixture_image_tag}"
  "${image_fixture}"
)
if ! "${image_build_command[@]}" >"${output_root}/image-fixture-build.log" 2>&1; then
  fail "could not build the runtime container vulnerability fixture"
fi
fixture_image_cleanup=true
fixture_image_tar="${test_root}/vulnerable-image.tar"
if ! docker image save --output "${fixture_image_tar}" "${fixture_image_tag}" >"${output_root}/image-fixture-save.log" 2>&1; then
  fail "could not export the runtime container vulnerability fixture"
fi
expect_failure "Trivy image negative fixture" security_run_trivy_image_tar "${fixture_image_tar}" "${trivy_cache_root}" "${output_root}" "trivy-image-negative.json" "${output_root}/trivy-image-negative.log" "${trivy_config}"
security_classify_json_report "${output_root}/trivy-image-negative.json" "trivy-vulnerability" >/dev/null || fail "Trivy image failure did not contain a valid fixable HIGH/CRITICAL vulnerability"
pass "Trivy rejects a digest-pinned runtime container vulnerability fixture"

printf '%s\n' "Security negative fixtures passed without storing a secret-like tracked fixture."
