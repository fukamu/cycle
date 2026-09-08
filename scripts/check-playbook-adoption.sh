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
Usage: ./scripts/check-playbook-adoption.sh [--source-repository ABSOLUTE_PATH]

Without options, validate the vendored playbook, lock, empty overrides, local
ownership trace, and workflow without network access. During adoption or an
update, pass a complete trusted clone of fukamu/product-engineering-playbook to
also verify the signed version tag, pinned revision, and vendored source bytes.
EOF
}

reject_source_signature_execution_config() {
  local source_root="$1"
  local config_keys
  config_keys="$(trusted_git -C "${source_root}" config --no-includes --local --name-only --list)" \
    || return 1
  local config_key
  while IFS= read -r config_key; do
    [[ -n "${config_key}" ]] || continue
    [[ "${config_key,,}" != gpg.* ]] || return 1
  done <<<"${config_keys}"
}

verify_pinned_source_bytes() {
  local source_root="$1"
  local consumer_root="$2"
  local revision="$3"
  local comparison_root="$4"
  [[ -d "${comparison_root}" && ! -L "${comparison_root}" ]] || return 1

  local source_bundle="${comparison_root}/PLAYBOOK.md"
  local source_validator="${comparison_root}/validate.py"
  [[ ! -e "${source_bundle}" && ! -L "${source_bundle}" ]] || return 1
  [[ ! -e "${source_validator}" && ! -L "${source_validator}" ]] || return 1
  trusted_git -C "${source_root}" show "${revision}:PLAYBOOK.md" >"${source_bundle}" \
    || return 1
  trusted_git -C "${source_root}" show "${revision}:scripts/validate.py" >"${source_validator}" \
    || return 1
  [[ -f "${source_bundle}" && ! -L "${source_bundle}" ]] || return 1
  [[ -f "${source_validator}" && ! -L "${source_validator}" ]] || return 1

  local locked_bundle_hash
  local locked_validator_hash
  local source_bundle_hash
  local source_validator_hash
  local vendored_bundle_hash
  local vendored_validator_hash
  locked_bundle_hash="$(jq -er '.bundleSha256 | select(type == "string")' "${consumer_root}/.fukamu/playbook/lock.json")" \
    || return 1
  locked_validator_hash="$(jq -er '.validatorSha256 | select(type == "string")' "${consumer_root}/.fukamu/playbook/lock.json")" \
    || return 1
  source_bundle_hash="$(sha256sum -- "${source_bundle}" | awk '{print $1}')" \
    || return 1
  source_validator_hash="$(sha256sum -- "${source_validator}" | awk '{print $1}')" \
    || return 1
  vendored_bundle_hash="$(sha256sum -- "${consumer_root}/.fukamu/playbook/PLAYBOOK.md" | awk '{print $1}')" \
    || return 1
  vendored_validator_hash="$(sha256sum -- "${consumer_root}/.fukamu/playbook/validate.py" | awk '{print $1}')" \
    || return 1
  [[ "${source_bundle_hash}" == "${locked_bundle_hash}" && "${vendored_bundle_hash}" == "${locked_bundle_hash}" ]] \
    || return 1
  [[ "${source_validator_hash}" == "${locked_validator_hash}" && "${vendored_validator_hash}" == "${locked_validator_hash}" ]] \
    || return 1
}

signature_evidence_matches_fingerprint() {
  local signature_evidence="$1"
  local approved_fingerprint="$2"
  local -a valid_signers=()
  mapfile -t valid_signers < <(
    awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print $3 }' <<<"${signature_evidence}"
  )
  [[ "${#valid_signers[@]}" -eq 1 && "${valid_signers[0]}" == "${approved_fingerprint}" ]]
}

main() {
  local source_repository=''
  while (($# > 0)); do
    case "$1" in
      --source-repository)
        (($# >= 2)) || die "--source-repository requires an absolute path."
        source_repository="$2"
        shift 2
        ;;
      --help)
        usage
        exit 0
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  require_command python3
  require_command node
  cd -- "${repo_root}"
  node scripts/validate-playbook-config.mjs .

  if [[ -z "${source_repository}" ]]; then
    PYTHONNOUSERSITE=1 PYTHONPATH='' PYTHONSAFEPATH=1 \
      python3 .fukamu/playbook/validate.py --consumer .
    printf '%s\n' "Playbook adoption checks completed successfully (offline)."
    exit 0
  fi

  require_command git
  require_command docker
  require_command jq
  require_command gpg
  require_command sha256sum
  [[ "${source_repository}" == /* ]] \
    || die "--source-repository must be an absolute path."
  local canonical_source_repository
  canonical_source_repository="$(realpath -e -- "${source_repository}")" \
    || die "Source repository cannot be resolved."
  [[ "${canonical_source_repository}" == "${source_repository}" && -d "${source_repository}" && ! -L "${source_repository}" ]] \
    || die "Source repository must be a canonical non-symlink directory."
  reject_source_signature_execution_config "${source_repository}" \
    || die "Source repository contains execution-affecting local gpg configuration."
  security_validate_git_repository_inputs "${source_repository}" \
    || die "Source repository failed the self-contained Git graph security checks."

  local source_remote
  source_remote="$(trusted_git -C "${source_repository}" remote get-url origin)" \
    || die "Source repository origin cannot be read."
  case "${source_remote}" in
    https://github.com/fukamu/product-engineering-playbook | https://github.com/fukamu/product-engineering-playbook.git | git@github.com:fukamu/product-engineering-playbook.git) ;;
    *) die "Source repository origin is not the approved playbook repository." ;;
  esac

  local version
  local revision
  local tag_signer_fingerprint
  version="$(jq -er '.version | select(type == "string")' .fukamu/playbook/lock.json)" \
    || die "Playbook lock version cannot be read."
  revision="$(jq -er '.revision | select(type == "string")' .fukamu/playbook/lock.json)" \
    || die "Playbook lock revision cannot be read."
  tag_signer_fingerprint="$(jq -er '.tagSignerFingerprint | select(type == "string")' .fukamu/playbook/lock.json)" \
    || die "Playbook lock signer fingerprint cannot be read."
  local tag="v${version}"
  local resolved_tag
  resolved_tag="$(trusted_git -C "${source_repository}" rev-parse --verify "refs/tags/${tag}^{}")" \
    || die "Pinned playbook version tag cannot be resolved."
  [[ "${resolved_tag}" == "${revision}" ]] \
    || die "Pinned playbook version tag does not resolve to the locked revision."
  trusted_git -C "${source_repository}" cat-file -e "${revision}^{commit}" \
    || die "Locked playbook revision is not a commit in the source repository."

  local gpg_path
  local signature_evidence
  gpg_path="$(type -P gpg)" || die "Trusted OpenPGP verifier cannot be resolved."
  signature_evidence="$(
    trusted_git \
      -c "gpg.program=${gpg_path}" \
      -c gpg.format=openpgp \
      -C "${source_repository}" \
      verify-tag --raw "${tag}" 2>&1
  )" || die "Pinned playbook version tag signature could not be verified."
  signature_evidence_matches_fingerprint "${signature_evidence}" "${tag_signer_fingerprint}" \
    || die "Pinned playbook version tag was not signed by the approved fingerprint."

  local source_comparison_root
  source_comparison_root="$(mktemp -d)"
  trap 'rm -rf -- "${source_comparison_root:-}"' EXIT
  verify_pinned_source_bytes \
    "${source_repository}" \
    "${repo_root}" \
    "${revision}" \
    "${source_comparison_root}" \
    || die "Vendored Playbook bytes or lock hashes differ from the signed source revision."

  GIT_ATTR_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_NO_LAZY_FETCH=1 \
    GIT_NO_REPLACE_OBJECTS=1 \
    PYTHONNOUSERSITE=1 \
    PYTHONPATH='' \
    PYTHONSAFEPATH=1 \
    python3 .fukamu/playbook/validate.py \
    --consumer . \
    --source-repository "${source_repository}"

  rm -rf -- "${source_comparison_root}"
  trap - EXIT
  printf '%s\n' "Playbook source-backed adoption checks completed successfully."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
