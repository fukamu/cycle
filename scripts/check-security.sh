#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
# shellcheck source=scripts/lib/security-tools.sh
source "${script_dir}/lib/security-tools.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"

usage() {
  cat <<'EOF'
Usage: ./scripts/check-security.sh

Run the pinned M25 security profile: Node and Go dependency vulnerability
checks, Go static analysis, full-history/staged/current-tree secret detection,
Terraform and production Dockerfile checks, then build and scan the production
container image. Scanner, registry, advisory, and vulnerability DB errors fail
the gate closed.
EOF
}

security_require_clean_json_report() {
  local report_path="$1"
  local report_mode="$2"
  local scan_label="$3"
  local classification=0

  security_classify_json_report "${report_path}" "${report_mode}" >/dev/null || classification=$?
  case "${classification}" in
    1) return 0 ;;
    0) die "${scan_label} exited successfully but its valid report contained an in-scope finding." ;;
    *) die "${scan_label} exited successfully without a valid, schema-conformant clean report." ;;
  esac
}

security_fail_from_json_report() {
  local report_path="$1"
  local report_mode="$2"
  local scan_label="$3"
  local classification=0

  security_classify_json_report "${report_path}" "${report_mode}" >&2 || classification=$?
  case "${classification}" in
    0) die "${scan_label} found an in-scope issue." ;;
    1) die "${scan_label} exited non-zero despite returning a valid clean report." ;;
    *) die "${scan_label} failed without a valid, schema-conformant report; raw scanner output is suppressed." ;;
  esac
}

if (($# > 0)); then
  [[ "$1" == "--help" && $# -eq 1 ]] || die "This command accepts no options."
  usage
  exit 0
fi

require_command docker
require_command git
require_command cmp
require_command find
require_local_docker_context >/dev/null

cd -- "${repo_root}"
[[ "$(trusted_git rev-parse --is-inside-work-tree 2>/dev/null)" == "true" ]] || die "Security checks must run inside the repository worktree."
[[ "$(trusted_git rev-parse --is-shallow-repository)" == "false" ]] || die "A complete Git history is required for secret scanning. CI checkout must use fetch-depth: 0."
security_validate_git_repository_inputs "${repo_root}" || die "Git history must be self-contained and must not use replace refs, grafts, or alternate object stores."
security_validate_gitleaks_ignore "${repo_root}/.gitleaksignore" || die "Gitleaks ignores must contain only exact 40hex:path:rule:positive-line fingerprints; broad or malformed ignores are forbidden."

security_root=''
production_image_tag=''
production_image_cleanup=false

cleanup_security_check() {
  local status=$?
  trap - EXIT
  if [[ "${production_image_cleanup}" == "true" && -n "${production_image_tag}" ]]; then
    if ! security_remove_temporary_image "${production_image_tag}"; then
      warn "Could not remove temporary production image tag ${production_image_tag}."
      status=1
    fi
  fi
  if [[ -n "${security_root}" && -d "${security_root}" ]]; then
    if ! chmod -R u+w "${security_root}" 2>/dev/null; then
      warn "Could not make the temporary security directory removable."
      status=1
    fi
    if ! rm -rf -- "${security_root}" 2>/dev/null; then
      warn "Could not remove the temporary security directory."
      status=1
    fi
  fi
  exit "${status}"
}

security_root="$(mktemp -d "${TMPDIR:-/tmp}/fukamu-cycle-security.XXXXXXXX")"
trap cleanup_security_check EXIT
chmod 700 "${security_root}"
output_root="${security_root}/output"
go_cache_root="${security_root}/go-cache"
trivy_cache_root="${security_root}/trivy-cache"
snapshot_root="${security_root}/current-tree"
mkdir -p -- "${output_root}" "${go_cache_root}" "${trivy_cache_root}" "${snapshot_root}"
gitleaks_config="${security_root}/gitleaks.toml"
security_write_gitleaks_config "${gitleaks_config}" || die "Could not create the script-owned Gitleaks configuration."
trivy_config="${security_root}/trivy.yaml"
security_write_trivy_config "${trivy_config}" || die "Could not create the script-owned Trivy configuration."
production_image_tag="fukamu-cycle-security:scan-$$-${RANDOM}"

# Build one explicit tracked/non-ignored candidate snapshot before scanners run.
# This prevents dependency, static, and IaC tools from reading ignored local
# credentials, Terraform state, environment files, or dependency stores. Git
# history/staged modes retain their dedicated repository guards; the production
# image is built from this same candidate snapshot.
candidate_manifest="${security_root}/candidate-files.nul"
if ! security_create_candidate_snapshot "${repo_root}" "${snapshot_root}" "${candidate_manifest}"; then
  die "Could not enumerate or copy the tracked/non-ignored candidate tree for security scanning."
fi

printf '%s\n' "[security] Candidate/history approved-text inventory"
if ! security_validate_candidate_text_files "${snapshot_root}"; then
  die "Candidate tree contains an unapproved path/type, non-text content, symlink, special file, or invalid inventory; candidate inputs must be approved text files."
fi
if ! security_validate_staged_text_files "${repo_root}"; then
  die "Git index contains an unapproved path/type or non-text blob, or could not be inventoried safely."
fi
if ! security_validate_history_text_files "${repo_root}"; then
  die "Git history contains an unapproved path/type or non-text blob, or could not be inventoried safely."
fi

# Digest-pinned runtime images may be resolved or pulled first; Docker sends
# only the pinned image reference, never repository bytes. Run every secret
# view before any repository-derived dependency/module request, advisory lookup,
# scanner database/tool download, candidate command, or image build. A candidate
# config/module file containing a credential therefore cannot be sent to an
# external endpoint before the secret gate has examined it.
printf '%s\n' "[security] Git full-history secrets (Gitleaks 8.30.0, redacted)"
if ! security_run_gitleaks_history "${repo_root}" "${gitleaks_config}" ".gitleaksignore" "${output_root}/gitleaks-history.log"; then
  die "Full-history secret scan failed or found a secret; raw scanner metadata is suppressed."
fi

printf '%s\n' "[security] Git staged secrets (Gitleaks 8.30.0, redacted)"
if ! security_run_gitleaks_staged "${repo_root}" "${gitleaks_config}" ".gitleaksignore" "${output_root}/gitleaks-staged.log"; then
  die "Staged secret scan failed or found a secret; raw scanner metadata is suppressed."
fi

printf '%s\n' "[security] Current tracked/candidate-tree secrets (Gitleaks 8.30.0, redacted)"
if ! security_run_gitleaks_directory "${snapshot_root}" "${gitleaks_config}" ".gitleaksignore" "${output_root}/gitleaks-directory.log"; then
  die "Current-tree secret scan failed or found a secret; raw scanner metadata is suppressed."
fi

printf '%s\n' "[security] MIME/path-normalized candidate secrets (Gitleaks 8.30.0, redacted)"
if ! security_run_gitleaks_normalized_text "${snapshot_root}" candidate "${gitleaks_config}" "${output_root}/gitleaks-normalized-candidate.log"; then
  die "Normalized candidate secret scan failed or found a secret; raw scanner metadata is suppressed."
fi

printf '%s\n' "[security] MIME/path-normalized staged secrets (Gitleaks 8.30.0, redacted)"
if ! security_run_gitleaks_normalized_text "${repo_root}" staged "${gitleaks_config}" "${output_root}/gitleaks-normalized-staged.log"; then
  die "Normalized staged secret scan failed or found a secret; raw scanner metadata is suppressed."
fi

printf '%s\n' "[security] MIME/path-normalized history secrets (Gitleaks 8.30.0, redacted)"
if ! security_run_gitleaks_normalized_text "${repo_root}" history "${gitleaks_config}" "${output_root}/gitleaks-normalized-history.log"; then
  die "Normalized history secret scan failed or found a secret; raw scanner metadata is suppressed."
fi

printf '%s\n' "[security] Go module policy (no workspace, vendor, replace, ignore, or toolchain override)"
go_module_report="${output_root}/go-module-policy.json"
if ! security_validate_go_module_policy "${snapshot_root}/backend" "${go_module_report}" "${output_root}/go-module-policy.log" "${snapshot_root}"; then
  die "Go module policy is invalid or permits an unscanned build input; raw module values are suppressed."
fi

printf '%s\n' "[security] Node dependency vulnerabilities (pnpm 11.22.0)"
if ! security_validate_node_audit_policy "${snapshot_root}" "${output_root}" "${output_root}/pnpm-audit-policy.log"; then
  die "Node audit suppression policy is invalid or contains an unapproved ignore; raw policy values are suppressed."
fi
node_report="${output_root}/pnpm-audit.json"
if security_run_node_audit "${snapshot_root}" "${node_report}" "${output_root}/pnpm-audit.log"; then
  security_require_clean_json_report "${node_report}" "node-vulnerability" "Node dependency audit"
else
  security_fail_from_json_report "${node_report}" "node-vulnerability" "Node dependency audit"
fi

printf '%s\n' "[security] Go reachable dependency vulnerabilities (govulncheck ${SECURITY_GOVULNCHECK_VERSION})"
if ! security_run_govulncheck "${snapshot_root}/backend" "${go_cache_root}" "${output_root}/govulncheck.log"; then
  die "Go vulnerability scan failed or found a reachable vulnerability; raw scanner output is suppressed."
fi

printf '%s\n' "[security] Go HIGH/high-confidence static analysis (gosec ${SECURITY_GOSEC_VERSION})"
gosec_report="${output_root}/gosec.json"
if security_run_gosec "${snapshot_root}/backend" "${go_cache_root}" "${output_root}" "$(basename -- "${gosec_report}")" "${output_root}/gosec.log"; then
  security_require_clean_json_report "${gosec_report}" "gosec-high" "Go static analysis"
else
  security_fail_from_json_report "${gosec_report}" "gosec-high" "Go static analysis"
fi

printf '%s\n' "[security] Terraform HIGH/CRITICAL misconfigurations (Trivy 0.73.0)"
terraform_report="${output_root}/trivy-terraform.json"
if security_run_trivy_config "${snapshot_root}" "infra/terraform/staging" "${trivy_cache_root}" "${output_root}" "$(basename -- "${terraform_report}")" "${output_root}/trivy-terraform.log" "${trivy_config}"; then
  security_require_clean_json_report "${terraform_report}" "trivy-misconfiguration" "Terraform security scan"
else
  security_fail_from_json_report "${terraform_report}" "trivy-misconfiguration" "Terraform security scan"
fi

printf '%s\n' "[security] Production Dockerfile HIGH/CRITICAL misconfigurations (Trivy 0.73.0)"
dockerfile_report="${output_root}/trivy-dockerfile.json"
if security_run_trivy_config "${snapshot_root}" "Dockerfile" "${trivy_cache_root}" "${output_root}" "$(basename -- "${dockerfile_report}")" "${output_root}/trivy-dockerfile.log" "${trivy_config}"; then
  security_require_clean_json_report "${dockerfile_report}" "trivy-misconfiguration" "Production Dockerfile scan"
else
  security_fail_from_json_report "${dockerfile_report}" "trivy-misconfiguration" "Production Dockerfile scan"
fi

printf '%s\n' "[security] Build the actual production container image"
if ! security_require_temporary_image_tag_absent "${production_image_tag}"; then
  die "Could not confirm that the temporary production image tag is absent; refusing to build."
fi
build_command=(
  docker build
  --file "${snapshot_root}/Dockerfile"
  --tag "${production_image_tag}"
  "${snapshot_root}"
)
if ! "${build_command[@]}" >"${output_root}/production-build.log" 2>&1; then
  die "Production container build failed; build output is suppressed to avoid leaking context data."
fi
production_image_cleanup=true

production_image_tar="${security_root}/production-image.tar"
if ! docker image save --output "${production_image_tar}" "${production_image_tag}" >"${output_root}/production-save.log" 2>&1; then
  die "Could not export the temporary production image for scanning."
fi

printf '%s\n' "[security] Production image fixable OS HIGH/CRITICAL vulnerabilities (Trivy 0.73.0)"
image_report="${output_root}/trivy-image.json"
if security_run_trivy_image_tar "${production_image_tar}" "${trivy_cache_root}" "${output_root}" "$(basename -- "${image_report}")" "${output_root}/trivy-image.log" "${trivy_config}"; then
  security_require_clean_json_report "${image_report}" "trivy-vulnerability" "Production image scan"
else
  security_fail_from_json_report "${image_report}" "trivy-vulnerability" "Production image scan"
fi

printf '%s\n' "Security profile passed with digest-pinned scanner images and version-pinned Go tools."
