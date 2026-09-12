#!/usr/bin/env bash
# shellcheck disable=SC2016 # Workflow assertions intentionally use unexpanded GitHub/Bash literals.

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/../..")"
workflow_dir="${repo_root}/.github/workflows"
workflow="${1:-${workflow_dir}/ci.yml}"
test_root="$(mktemp -d)"
trap 'rm -rf -- "${test_root}"' EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

violation() {
  printf 'CI security model violation: %s\n' "$*" >&2
  return 1
}

extract_root_mapping() {
  local file="$1"
  local key="$2"
  awk -v header="${key}:" '
    $0 == header {
      found++
      active = 1
      next
    }
    active && /^[^[:space:]]/ { active = 0 }
    active { print }
    END { if (found != 1) exit 1 }
  ' "${file}"
}

extract_job() {
  local file="$1"
  local job="$2"
  awk -v header="  ${job}:" '
    $0 == header {
      found++
      active = 1
    }
    active && $0 != header && /^  [[:alnum:]_-]+:$/ { active = 0 }
    active { print }
    END { if (found != 1) exit 1 }
  ' "${file}"
}

extract_job_mapping() {
  local job_file="$1"
  local key="$2"
  awk -v header="    ${key}:" '
    $0 == header {
      found++
      active = 1
      next
    }
    active && /^    [^[:space:]]/ { active = 0 }
    active { print }
    END { if (found != 1) exit 1 }
  ' "${job_file}"
}

extract_job_if() {
  local job_file="$1"
  awk '
    $0 == "    if: >-" {
      found++
      active = 1
    }
    active && $0 != "    if: >-" && /^    [^[:space:]]/ { active = 0 }
    active { print }
    END { if (found != 1) exit 1 }
  ' "${job_file}"
}

extract_named_step() {
  local job_file="$1"
  local name="$2"
  awk -v header="      - name: ${name}" '
    $0 == header {
      found++
      active = 1
    }
    active && $0 != header && /^      - / { active = 0 }
    active { print }
    END { if (found != 1) exit 1 }
  ' "${job_file}"
}

extract_checkout_step() {
  local job_file="$1"
  awk '
    /uses:[[:space:]]*actions\/checkout@/ { all_uses++ }
    /^      - uses: actions\/checkout@[^[:space:]]+[[:space:]]+#[[:space:]]+v[^[:space:]]+$/ {
      parsed_uses++
      active = 1
    }
    active && $0 !~ /^      - uses: actions\/checkout@[^[:space:]]+[[:space:]]+#[[:space:]]+v[^[:space:]]+$/ && /^      - / {
      active = 0
    }
    active { print }
    END { if (all_uses != 1 || parsed_uses != 1) exit 1 }
  ' "${job_file}"
}

extract_step_mapping() {
  local step_file="$1"
  local key="$2"
  awk -v header="        ${key}:" '
    $0 == header {
      found++
      active = 1
      next
    }
    active && /^        [^[:space:]]/ { active = 0 }
    active { print }
    END { if (found != 1) exit 1 }
  ' "${step_file}"
}

extract_literal_run_script() {
  local step_file="$1"
  awk '
    $0 == "        run: |" {
      found++
      active = 1
      next
    }
    active && /^        [^[:space:]]/ { active = 0 }
    active {
      if ($0 == "") {
        print
      } else {
        if (substr($0, 1, 10) != "          ") exit 2
        print substr($0, 11)
      }
    }
    END { if (found != 1) exit 1 }
  ' "${step_file}"
}

require_nonblank_lines() {
  local file="$1"
  shift
  local actual
  local expected
  actual="$(awk 'NF' "${file}")"
  expected="$(printf '%s\n' "$@")"
  [[ "${actual}" == "${expected}" ]] \
    || violation "unexpected contract block in ${file}"
}

require_nonblank_block() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(awk 'NF' "${file}")"
  [[ "${actual}" == "${expected}" ]] \
    || violation "unexpected contract block in ${file}"
}

require_exact_line() {
  local file="$1"
  local expected="$2"
  local count
  count="$(awk -v expected="${expected}" '$0 == expected { count++ } END { print count + 0 }' "${file}")"
  [[ "${count}" == "1" ]] || violation "expected one exact line in ${file}: ${expected}"
}

require_dispatch_input_contract() {
  local file="$1"
  local input="$2"
  local required_value="$3"
  local type_value="$4"
  awk -v header="      ${input}:" '
    $0 == header {
      found++
      active = 1
      next
    }
    active && /^      [^[:space:]]/ { active = 0 }
    active && $0 == "        required: " required_value { required++ }
    active && $0 == "        type: " type_value { type_count++ }
    END { if (found != 1 || required != 1 || type_count != 1) exit 1 }
  ' required_value="${required_value}" type_value="${type_value}" "${file}" \
    || violation "manual dispatch input ${input} must be one ${required_value}/${type_value} contract in ${file}"
}

validate_no_defaults_run_shell() {
  local file="$1"
  local defaults_shell_count
  defaults_shell_count="$(
    awk '
      function indentation(line, prefix) {
        prefix = line
        sub(/[^ ].*$/, "", prefix)
        return length(prefix)
      }
      {
        content = $0
        sub(/^ */, "", content)
        indent = indentation($0)

        if (in_defaults && content !~ /^($|#)/ && indent <= defaults_indent) {
          in_defaults = 0
          in_run = 0
        }
        if ((indent == 0 || indent == 4) && content ~ /^defaults[[:space:]]*:/) {
          in_defaults = 1
          in_run = 0
          defaults_indent = indent
          remainder = content
          sub(/^defaults[[:space:]]*:[[:space:]]*/, "", remainder)
          if (remainder ~ /run[[:space:]]*:/ && remainder ~ /shell[[:space:]]*:/) found++
          next
        }
        if (!in_defaults || content ~ /^($|#)/) next

        if (in_run && indent <= run_indent) in_run = 0
        if (content ~ /^run[[:space:]]*:/ && indent > defaults_indent) {
          in_run = 1
          run_indent = indent
          remainder = content
          sub(/^run[[:space:]]*:[[:space:]]*/, "", remainder)
          if (remainder ~ /shell[[:space:]]*:/) found++
          next
        }
        if (in_run && indent > run_indent && content ~ /^shell[[:space:]]*:/) found++
      }
      END { print found + 0 }
    ' "${file}"
  )" || {
    violation "could not inspect defaults.run.shell in ${file}"
    return 1
  }
  [[ "${defaults_shell_count}" == "0" ]] || {
    violation "workflows must not override defaults.run.shell: ${file}"
    return 1
  }
}

validate_workflow_source_guards() {
  local file="$1"
  if grep -Eq '^(defaults|env)[[:space:]]*:' "${file}"; then
    violation "workflows must not define top-level defaults or environment variables: ${file}"
    return 1
  fi
  if grep -Eq '(^|[[:space:]])!(![[:alnum:]_.:/-]+|<[^>]+>|[[:alnum:]_.:/-]+)([[:space:]]|$)' "${file}"; then
    violation "GitHub Actions workflows must not use explicit YAML tags: ${file}"
    return 1
  fi
  if grep -Eq "[\"'][^\"']*[\"'][[:space:]]*:" "${file}"; then
    violation "GitHub Actions workflows must not use quoted mapping keys: ${file}"
    return 1
  fi
  if grep -Eq '(^|[[:space:]{,])<<[[:space:]]*:' "${file}"; then
    violation "GitHub Actions workflows must not use YAML merge keys: ${file}"
    return 1
  fi
  if grep -Eq '(^|[[:space:]]|[{:,]|\[)[&*][[:alnum:]_-]+([^[:alnum:]_-]|$)' "${file}"; then
    violation "GitHub Actions workflows must not use YAML anchors or aliases: ${file}"
    return 1
  fi
  if grep -Fq 'GITHUB_ENV' "${file}"; then
    violation "GitHub Actions workflows must not mutate step configuration through GITHUB_ENV: ${file}"
    return 1
  fi
  if grep -Eq 'runs-on:.*self-hosted' "${file}"; then
    violation "security-sensitive workflows must not use self-hosted runners: ${file}"
    return 1
  fi
  validate_no_defaults_run_shell "${file}" || return 1
}

validate_exact_workflow_structure() {
  local file="$1"
  local contract="$2"
  local actual_name
  local expected_name
  local expected_jobs

  actual_name="$(awk '/^name:/ { print }' "${file}")"

  case "${contract}" in
    ci)
      expected_name="name: CI"
      expected_jobs="$(
        printf '%s\n' \
          reuse_pr_ci release_security classify workflow quality frontend backend infrastructure e2e required_pr_ci attest_pr_ci
      )"
      ;;
    security-audit)
      expected_name="name: Security audit"
      expected_jobs="$(printf '%s\n' audit report_failure)"
      ;;
    deploy)
      expected_name="name: Deploy Staging"
      expected_jobs="$(printf '%s\n' resolve deploy)"
      ;;
    terraform-plan)
      expected_name="name: Terraform Plan Staging"
      expected_jobs="plan"
      ;;
    playbook)
      expected_name="name: Playbook policy"
      expected_jobs="validate"
      ;;
    terraform-apply)
      expected_name="name: Terraform Apply Staging"
      expected_jobs="$(printf '%s\n' preflight apply)"
      ;;
    legacy-retirement)
      expected_name="name: Retire Legacy PDCAI Origin"
      expected_jobs="$(printf '%s\n' preflight deploy)"
      ;;
    *)
      violation "unknown workflow structure contract: ${contract}"
      return 1
      ;;
  esac

  [[ "${actual_name}" == "${expected_name}" ]] || {
    violation "workflow name is not exact for ${contract}: ${file}"
    return 1
  }
  local job
  while IFS= read -r job; do
    [[ "$(grep -Fxc -- "  ${job}:" "${file}")" == "1" ]] || {
      violation "workflow is missing required job ${job} for ${contract}: ${file}"
      return 1
    }
  done <<<"${expected_jobs}"
}

validate_checkout_credential_file() {
  local file="$1"
  awk '
    function finish_checkout() {
      if (!active) return
      if (with_count != 1 || persist_count != 1 || exact_persist_count != 1) {
        invalid = 1
      }
      active = 0
      in_with = 0
    }
    /uses:[[:space:]]*actions\/checkout@/ { all_uses++ }
    /^      - uses: actions\/checkout@[^[:space:]]+[[:space:]]+#[[:space:]]+v[^[:space:]]+$/ {
      finish_checkout()
      parsed_uses++
      active = 1
      with_count = 0
      persist_count = 0
      exact_persist_count = 0
      next
    }
    active && /^      - / { finish_checkout() }
    active {
      if ($0 == "        with:") {
        with_count++
        in_with = 1
        next
      }
      if (in_with && /^        [^[:space:]]/) in_with = 0
      if (/persist-credentials[[:space:]]*:/) {
        persist_count++
        if (in_with && $0 == "          persist-credentials: false") {
          exact_persist_count++
        }
      }
    }
    END {
      finish_checkout()
      if (all_uses != parsed_uses || invalid) exit 1
    }
  ' "${file}" || {
    violation "checkout credential contract mismatch in ${file}"
    return 1
  }
}

validate_json_parser_completion_contract() {
  local directory="$1"
  local file
  local expected
  local actual
  while IFS='|' read -r file expected; do
    actual="$(
      grep -Ec '^[[:space:]]+jq -ser \\$' "${directory}/${file}" || true
    )"
    [[ "${actual}" == "${expected}" ]] || {
      violation "${file} must parse each security-sensitive JSON response to completion"
      return 1
    }
    if grep -Fq 'mapfile -t artifact_names < <(' "${directory}/${file}"; then
      violation "${file} must not hide jq failures behind process substitution"
      return 1
    fi
  done <<'JSON_PARSER_INVENTORY'
deploy.yml|5
retire-legacy-origin.yml|3
terraform-apply.yml|2
terraform-plan.yml|0
JSON_PARSER_INVENTORY
}

validate_terraform_r2_secret_sources() {
  local directory="$1"
  local apply_workflow="${directory}/terraform-apply.yml"
  local plan_job="${test_root}/terraform-plan-secret-sources.job"
  local plan_env="${test_root}/terraform-plan-secret-sources.env"
  local preflight_job="${test_root}/terraform-apply-preflight.job"
  local preflight_steps="${test_root}/terraform-apply-preflight.steps"
  local resolver_step="${test_root}/terraform-apply-resolver.step"
  local confirmation_step="${test_root}/terraform-apply-inventory-confirmation.step"
  local confirmation_script="${test_root}/terraform-apply-inventory-confirmation.sh"
  local confirmation_output="${test_root}/terraform-apply-inventory-confirmation.output"
  local apply_job="${test_root}/terraform-apply-secret-sources.job"
  local apply_env="${test_root}/terraform-apply-secret-sources.env"
  local apply_steps="${test_root}/terraform-apply-secret-sources.steps"
  local apply_run_step="${test_root}/terraform-apply-approved-plan.step"
  local final_main_step="${test_root}/terraform-apply-final-main.step"
  local validation_step="${test_root}/terraform-apply-input-validation.step"
  local validation_script="${test_root}/terraform-apply-input-validation.sh"
  local validation_output="${test_root}/terraform-apply-input-validation.output"
  local first_preflight_step
  local first_apply_step
  local initialize_line
  local final_main_line
  local state_backup_line
  local apply_line
  local actual_env_keys
  local expected_env_keys

  extract_job "${directory}/terraform-plan.yml" plan >"${plan_job}" || {
    violation "Terraform Plan job must exist for R2 secret source validation"
    return 1
  }
  extract_job_mapping "${plan_job}" env >"${plan_env}" || {
    violation "Terraform Plan must define one job environment mapping"
    return 1
  }
  actual_env_keys="$(awk '/^      [A-Za-z_][A-Za-z0-9_]*:/ { key = $1; sub(/:$/, "", key); print key }' "${plan_env}" | LC_ALL=C sort)"
  expected_env_keys="$(printf '%s\n' AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY CLOUDFLARE_API_TOKEN COMMIT_SHA R2_STATE_BUCKET TF_IN_AUTOMATION TF_INPUT TF_VAR_cloudflare_account_id | LC_ALL=C sort)"
  [[ "${actual_env_keys}" == "${expected_env_keys}" ]] || {
    violation "Terraform Plan job environment contains an unknown or missing input"
    return 1
  }
  # GitHub expression literals must remain unexpanded while validating YAML.
  # shellcheck disable=SC2016
  require_exact_line "${plan_env}" \
    '      AWS_ACCESS_KEY_ID: ${{ secrets.TERRAFORM_R2_ACCESS_KEY_ID }}' || return 1
  # shellcheck disable=SC2016
  require_exact_line "${plan_env}" \
    '      AWS_SECRET_ACCESS_KEY: ${{ secrets.TERRAFORM_R2_SECRET_ACCESS_KEY }}' || return 1
  if grep -Fq 'secrets.TERRAFORM_APPLY_R2_' "${plan_env}"; then
    violation "Terraform Plan must not use Apply-only R2 secrets"
    return 1
  fi

  require_exact_line "${apply_workflow}" "      credential_inventory_confirmation:" || return 1
  require_dispatch_input_contract "${apply_workflow}" plan_run_id true string || return 1
  require_dispatch_input_contract "${apply_workflow}" credential_inventory_confirmation true string || return 1
  require_exact_line "${apply_workflow}" \
    "        description: Type CONFIRM APPLY R2 INVENTORY NO FALLBACK after value-free credential inventory checks" || return 1
  # GitHub expression literal must remain unexpanded while validating YAML.
  # shellcheck disable=SC2016
  require_exact_line "${apply_workflow}" \
    '          CREDENTIAL_INVENTORY_CONFIRMATION: ${{ inputs.credential_inventory_confirmation }}' || return 1
  # Shell variables below are intentional workflow literals.
  # shellcheck disable=SC2016
  require_exact_line "${apply_workflow}" \
    '          if [[ "${GITHUB_ACTOR,,}" != "${EXPECTED_APPROVER,,}" || "${GITHUB_TRIGGERING_ACTOR,,}" != "${EXPECTED_APPROVER,,}" ]]; then' || return 1

  extract_job "${apply_workflow}" preflight >"${preflight_job}" || {
    violation "Terraform Apply preflight job must exist for inventory confirmation validation"
    return 1
  }
  extract_job_mapping "${preflight_job}" steps >"${preflight_steps}" || {
    violation "Terraform Apply preflight must define one steps mapping"
    return 1
  }
  first_preflight_step="$(awk 'NF { print; exit }' "${preflight_steps}")"
  [[ "${first_preflight_step}" == "      - name: Verify Terraform credential inventory confirmation" ]] || {
    violation "Terraform Apply must verify credential inventory confirmation before every GitHub API call"
    return 1
  }
  extract_named_step "${preflight_job}" "Verify approver and resolve saved plan" >"${resolver_step}" || {
    violation "Terraform Apply must contain one saved-plan resolver"
    return 1
  }
  awk '
    $0 == "          plan_head_sha=\"$(" { target = 1; next }
    target && $0 == "            jq -ser \\" { found++; target = 0; next }
    target && NF { exit 1 }
    END { if (found != 1) exit 1 }
  ' "${resolver_step}" || {
    violation "Terraform Apply plan-run response must use the strict multi-document parser"
    return 1
  }
  awk '
    $0 == "          artifact_record=\"$(" { target = 1; next }
    target && $0 == "            jq -ser \\" { found++; target = 0; next }
    target && NF { exit 1 }
    END { if (found != 1) exit 1 }
  ' "${resolver_step}" || {
    violation "Terraform Apply artifact response must use the strict multi-document parser"
    return 1
  }
  extract_named_step "${preflight_job}" "Verify Terraform credential inventory confirmation" >"${confirmation_step}" || {
    violation "Terraform Apply must contain one canonical credential inventory confirmation step"
    return 1
  }
  # Workflow expressions and shell variables below are intentional literals.
  # shellcheck disable=SC2016
  require_nonblank_lines "${confirmation_step}" \
    "      - name: Verify Terraform credential inventory confirmation" \
    "        shell: bash" \
    "        env:" \
    '          CREDENTIAL_INVENTORY_CONFIRMATION: ${{ inputs.credential_inventory_confirmation }}' \
    "        run: |" \
    "          set -euo pipefail" \
    "          if [[ \"\${CREDENTIAL_INVENTORY_CONFIRMATION}\" != 'CONFIRM APPLY R2 INVENTORY NO FALLBACK' ]]; then" \
    "            echo '::error::Complete the value-free Terraform credential inventory checks and enter the exact confirmation.'" \
    "            exit 1" \
    "          fi" || return 1
  if grep -Fq 'gh api' "${confirmation_step}"; then
    violation "Terraform Apply inventory confirmation must not access the GitHub API"
    return 1
  fi
  extract_literal_run_script "${confirmation_step}" >"${confirmation_script}" || {
    violation "Terraform Apply inventory confirmation script must be extractable from the workflow"
    return 1
  }
  if env -i \
    PATH=/usr/bin:/bin \
    CREDENTIAL_INVENTORY_CONFIRMATION=not-confirmed \
    bash "${confirmation_script}" >"${confirmation_output}" 2>&1; then
    violation "Terraform Apply inventory confirmation accepted an incorrect value"
    return 1
  fi
  [[ "$(cat "${confirmation_output}")" == "::error::Complete the value-free Terraform credential inventory checks and enter the exact confirmation." ]] || {
    violation "Terraform Apply inventory confirmation failure output is not fixed"
    return 1
  }
  if ! env -i \
    PATH=/usr/bin:/bin \
    CREDENTIAL_INVENTORY_CONFIRMATION='CONFIRM APPLY R2 INVENTORY NO FALLBACK' \
    bash "${confirmation_script}" >"${confirmation_output}" 2>&1; then
    violation "Terraform Apply inventory confirmation rejected the exact confirmation"
    return 1
  fi
  [[ ! -s "${confirmation_output}" ]] || {
    violation "Terraform Apply inventory confirmation success fixture produced unexpected output"
    return 1
  }

  extract_job "${apply_workflow}" apply >"${apply_job}" || {
    violation "Terraform Apply job must exist for R2 secret source validation"
    return 1
  }
  extract_job_mapping "${apply_job}" env >"${apply_env}" || {
    violation "Terraform Apply must define one job environment mapping"
    return 1
  }
  actual_env_keys="$(awk '/^      [A-Za-z_][A-Za-z0-9_]*:/ { key = $1; sub(/:$/, "", key); print key }' "${apply_env}" | LC_ALL=C sort)"
  expected_env_keys="$(printf '%s\n' AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY CLOUDFLARE_API_TOKEN COMMIT_SHA PLAN_ARTIFACT_ID PLAN_ARTIFACT_NAME PLAN_RUN_ID R2_STATE_BUCKET TF_IN_AUTOMATION TF_INPUT TF_VAR_cloudflare_account_id | LC_ALL=C sort)"
  [[ "${actual_env_keys}" == "${expected_env_keys}" ]] || {
    violation "Terraform Apply job environment contains an unknown or missing input"
    return 1
  }
  # shellcheck disable=SC2016
  require_exact_line "${apply_env}" \
    '      AWS_ACCESS_KEY_ID: ${{ secrets.TERRAFORM_APPLY_R2_ACCESS_KEY_ID }}' || return 1
  # shellcheck disable=SC2016
  require_exact_line "${apply_env}" \
    '      AWS_SECRET_ACCESS_KEY: ${{ secrets.TERRAFORM_APPLY_R2_SECRET_ACCESS_KEY }}' || return 1
  # GitHub expression literals must remain unexpanded while validating YAML.
  # shellcheck disable=SC2016
  if grep -Fq '${{ secrets.TERRAFORM_R2_ACCESS_KEY_ID }}' "${apply_env}" \
    || grep -Fq '${{ secrets.TERRAFORM_R2_SECRET_ACCESS_KEY }}' "${apply_env}"; then
    violation "Terraform Apply must not fall back to repository-level R2 secrets"
    return 1
  fi

  extract_job_mapping "${apply_job}" steps >"${apply_steps}" || {
    violation "Terraform Apply must define one steps mapping"
    return 1
  }
  extract_named_step "${apply_job}" "Apply approved saved plan" >"${apply_run_step}" || {
    violation "Terraform Apply must contain the approved saved-plan mutation step"
    return 1
  }
  # RUNNER_TEMP is an intentional workflow literal.
  # shellcheck disable=SC2016
  require_exact_line "${apply_run_step}" \
    '        run: terraform apply -input=false -no-color "${RUNNER_TEMP}/fukamu-cycle-terraform-plan/staging.tfplan"' || return 1
  extract_named_step "${apply_job}" "Re-verify approved plan is still main HEAD" >"${final_main_step}" || {
    violation "Terraform Apply must re-verify main immediately before state protection and Apply"
    return 1
  }
  for invariant in \
    '          current_main_sha="$(' \
    "              \"/repos/\${GITHUB_REPOSITORY}/git/ref/heads/main\" \\" \
    '          if [[ "${COMMIT_SHA}" != "${current_main_sha}" ]]; then'; do
    grep -Fqx -- "${invariant}" "${final_main_step}" || {
      violation "Terraform Apply final main identity guard is incomplete"
      return 1
    }
  done
  initialize_line="$(grep -nFx -- "      - name: Initialize Terraform" "${apply_steps}" | cut -d: -f1)"
  final_main_line="$(grep -nFx -- "      - name: Re-verify approved plan is still main HEAD" "${apply_steps}" | cut -d: -f1)"
  state_backup_line="$(grep -nFx -- "      - name: Back up and drill Terraform state" "${apply_steps}" | cut -d: -f1)"
  apply_line="$(grep -nFx -- "      - name: Apply approved saved plan" "${apply_steps}" | cut -d: -f1)"
  [[ "${initialize_line}" =~ ^[0-9]+$ && "${final_main_line}" =~ ^[0-9]+$ &&
    "${state_backup_line}" =~ ^[0-9]+$ && "${apply_line}" =~ ^[0-9]+$ &&
    "${initialize_line}" -lt "${final_main_line}" &&
    "${final_main_line}" -lt "${state_backup_line}" &&
    "${state_backup_line}" -lt "${apply_line}" ]] || {
    violation "Terraform Apply final main guard, state protection, and mutation order is invalid"
    return 1
  }
  first_apply_step="$(awk 'NF { print; exit }' "${apply_steps}")"
  [[ "${first_apply_step}" == "      - name: Validate Terraform deployment inputs" ]] || {
    violation "Terraform Apply must validate inputs before every external operation"
    return 1
  }
  extract_named_step "${apply_job}" "Validate Terraform deployment inputs" >"${validation_step}" || {
    violation "Terraform Apply must contain one canonical input validation step"
    return 1
  }
  # Shell syntax below is the literal expected workflow body, not this script's variables.
  # shellcheck disable=SC2016
  require_nonblank_lines "${validation_step}" \
    "      - name: Validate Terraform deployment inputs" \
    "        shell: bash" \
    "        run: |" \
    "          set -euo pipefail" \
    "          required=(" \
    "            AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY CLOUDFLARE_API_TOKEN" \
    "            R2_STATE_BUCKET TF_VAR_cloudflare_account_id" \
    "          )" \
    "          missing=0" \
    '          for name in "${required[@]}"; do' \
    '            if [[ -z "${!name}" ]]; then' \
    '              echo "::error::Missing GitHub Terraform Apply input: ${name}"' \
    "              missing=1" \
    "            fi" \
    "          done" \
    '          if [[ ! "${TF_VAR_cloudflare_account_id}" =~ ^[0-9a-f]{32}$ ]]; then' \
    '            echo "::error::TERRAFORM_CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hexadecimal characters."' \
    "            missing=1" \
    "          fi" \
    '          if [[ ! "${R2_STATE_BUCKET}" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then' \
    '            echo "::error::TERRAFORM_R2_STATE_BUCKET must be a 3-63 character R2 bucket name."' \
    "            missing=1" \
    "          fi" \
    '          exit "${missing}"' || return 1

  extract_literal_run_script "${validation_step}" >"${validation_script}" || {
    violation "Terraform Apply input validation script must be extractable from the workflow"
    return 1
  }
  if env -i \
    PATH=/usr/bin:/bin \
    AWS_ACCESS_KEY_ID= \
    AWS_SECRET_ACCESS_KEY= \
    CLOUDFLARE_API_TOKEN=present \
    R2_STATE_BUCKET=cycle-state \
    TF_VAR_cloudflare_account_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    bash "${validation_script}" >"${validation_output}" 2>&1; then
    violation "Terraform Apply input validation accepted empty Apply credentials"
    return 1
  fi
  grep -Fxq \
    "::error::Missing GitHub Terraform Apply input: AWS_ACCESS_KEY_ID" \
    "${validation_output}" || {
    violation "Terraform Apply input validation did not reject an empty access key ID"
    return 1
  }
  grep -Fxq \
    "::error::Missing GitHub Terraform Apply input: AWS_SECRET_ACCESS_KEY" \
    "${validation_output}" || {
    violation "Terraform Apply input validation did not reject an empty secret access key"
    return 1
  }

  if ! env -i \
    PATH=/usr/bin:/bin \
    AWS_ACCESS_KEY_ID=present-id \
    AWS_SECRET_ACCESS_KEY=present-key \
    CLOUDFLARE_API_TOKEN=present \
    R2_STATE_BUCKET=cycle-state \
    TF_VAR_cloudflare_account_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    bash "${validation_script}" >"${validation_output}" 2>&1; then
    violation "Terraform Apply input validation rejected the complete success fixture"
    return 1
  fi
  [[ ! -s "${validation_output}" ]] || {
    violation "Terraform Apply input validation success fixture produced unexpected output"
    return 1
  }
}

validate_deploy_approval_gate() {
  local directory="$1"
  local deploy_workflow="${directory}/deploy.yml"
  local on_block="${test_root}/deploy-on.block"
  local resolve_job="${test_root}/deploy-resolve.job"
  local resolve_steps="${test_root}/deploy-resolve.steps"
  local preflight_step="${test_root}/deploy-dispatch-preflight.step"
  local preflight_script="${test_root}/deploy-dispatch-preflight.sh"
  local resolve_step="${test_root}/deploy-approved-resolution.step"
  local resolve_script="${test_root}/deploy-approved-resolution.sh"
  local deploy_job="${test_root}/deploy-mutation.job"
  local deploy_steps="${test_root}/deploy-mutation.steps"
  local deploy_attempt_step="${test_root}/deploy-attempt.step"
  local deploy_attempt_script="${test_root}/deploy-attempt.sh"
  local authorize_attempt_step="${test_root}/deploy-authorize-attempt.step"
  local authorize_attempt_script="${test_root}/deploy-authorize-attempt.sh"
  local fake_bin="${test_root}/deploy-fake-bin"
  local output="${test_root}/deploy-gate.output"
  local github_output="${test_root}/deploy-gate.github-output"
  local valid_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local stale_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  local first_step

  extract_root_mapping "${deploy_workflow}" on >"${on_block}" || {
    violation "Deploy Staging must define one manual trigger mapping"
    return 1
  }
  for invariant in \
    "  workflow_dispatch:" \
    "      mode:" \
    "        type: choice" \
    "          - normal" \
    "          - recovery" \
    "      infra_evidence_run_id:"; do
    grep -Fqx -- "${invariant}" "${on_block}" || {
      violation "Deploy Staging manual mode contract is incomplete"
      return 1
    }
  done
  if grep -Fq 'recovery_confirmation' "${on_block}"; then
    violation "Deploy Staging must not duplicate the recovery mode choice with a typed phrase"
    return 1
  fi
  if grep -Fq 'workflow_run:' "${deploy_workflow}"; then
    violation "Deploy Staging must not start automatically from workflow_run"
    return 1
  fi
  require_dispatch_input_contract "${deploy_workflow}" mode true choice || return 1
  require_dispatch_input_contract "${deploy_workflow}" infra_evidence_run_id false string || return 1

  extract_job "${deploy_workflow}" resolve >"${resolve_job}" || {
    violation "Deploy Staging resolve job must exist"
    return 1
  }
  if grep -Eq '^    environment:' "${resolve_job}"; then
    violation "Deploy Staging approval preflight must run before the staging Environment"
    return 1
  fi
  extract_job_mapping "${resolve_job}" steps >"${resolve_steps}" || {
    violation "Deploy Staging resolve job must define one steps mapping"
    return 1
  }
  first_step="$(awk 'NF { print; exit }' "${resolve_steps}")"
  [[ "${first_step}" == "      - name: Verify deploy dispatch preflight" ]] || {
    violation "Deploy Staging dispatch preflight must run before every API call"
    return 1
  }
  extract_named_step "${resolve_job}" "Verify deploy dispatch preflight" >"${preflight_step}" || {
    violation "Deploy Staging must contain one dispatch preflight step"
    return 1
  }
  if grep -Eq 'gh api|github\.token|secrets\.' "${preflight_step}"; then
    violation "Deploy Staging dispatch preflight must not access APIs or secrets"
    return 1
  fi
  extract_literal_run_script "${preflight_step}" >"${preflight_script}" || {
    violation "Deploy Staging dispatch preflight script must be extractable"
    return 1
  }

  run_deploy_preflight() {
    local event="$1"
    local ref="$2"
    local ref_name="$3"
    local sha="$4"
    local expected="$5"
    local actor="$6"
    local triggering_actor="$7"
    local mode="$8"
    local infra_evidence_run_id="$9"
    local run_attempt="${10:-1}"
    env -i \
      PATH=/usr/bin:/bin \
      GITHUB_EVENT_NAME="${event}" \
      GITHUB_REF="${ref}" \
      GITHUB_REF_NAME="${ref_name}" \
      GITHUB_SHA="${sha}" \
      EXPECTED_APPROVER="${expected}" \
      GITHUB_ACTOR="${actor}" \
      GITHUB_TRIGGERING_ACTOR="${triggering_actor}" \
      GITHUB_RUN_ATTEMPT="${run_attempt}" \
      MODE="${mode}" \
      INFRA_EVIDENCE_RUN_ID="${infra_evidence_run_id}" \
      bash "${preflight_script}" >"${output}" 2>&1
  }

  if ! run_deploy_preflight \
    workflow_dispatch refs/heads/main main "${valid_sha}" Owner owner OWNER normal 123; then
    violation "Deploy Staging dispatch preflight rejected a valid normal deployment"
    return 1
  fi
  if ! run_deploy_preflight \
    workflow_dispatch refs/heads/main main "${valid_sha}" Owner owner OWNER normal 123 2; then
    violation "Deploy Staging dispatch preflight rejected the single bounded rerun"
    return 1
  fi
  if run_deploy_preflight \
    workflow_dispatch refs/heads/main main "${valid_sha}" Owner owner OWNER normal 123 3; then
    violation "Deploy Staging dispatch preflight accepted an attempt beyond the single bounded rerun"
    return 1
  fi
  if ! run_deploy_preflight \
    workflow_dispatch refs/heads/main main "${valid_sha}" Owner owner OWNER recovery ''; then
    violation "Deploy Staging dispatch preflight rejected a valid recovery deployment"
    return 1
  fi

  local -a invalid_preflights=(
    "workflow_run|refs/heads/main|main|${valid_sha}|Owner|owner|owner|normal|123"
    "workflow_dispatch|refs/heads/topic|topic|${valid_sha}|Owner|owner|owner|normal|123"
    "workflow_dispatch|refs/heads/main|main|invalid|Owner|owner|owner|normal|123"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}||owner|owner|normal|123"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|bad--login|bad--login|bad--login|normal|123"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|attacker|owner|normal|123"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|attacker|normal|123"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|other|123"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|normal|"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|normal|0"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|recovery|123"
  )
  local fixture
  local -a fields
  for fixture in "${invalid_preflights[@]}"; do
    IFS='|' read -r -a fields <<<"${fixture}|_"
    if run_deploy_preflight \
      "${fields[0]}" "${fields[1]}" "${fields[2]}" "${fields[3]}" \
      "${fields[4]}" "${fields[5]}" "${fields[6]}" "${fields[7]}" \
      "${fields[8]}"; then
      violation "Deploy Staging dispatch preflight accepted invalid fixture: ${fixture}"
      return 1
    fi
  done

  extract_named_step "${resolve_job}" "Resolve approved deployment" >"${resolve_step}" || {
    violation "Deploy Staging must contain one approved deployment resolution step"
    return 1
  }
  extract_literal_run_script "${resolve_step}" >"${resolve_script}" || {
    violation "Deploy Staging approved deployment resolution script must be extractable"
    return 1
  }
  mkdir -- "${fake_bin}"
  cat >"${fake_bin}/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
valid_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
stale_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
scenario="${FAKE_SCENARIO}"
evidence_kind="${FAKE_EVIDENCE_KIND:-apply}"
apply_name='Terraform Apply Staging'
apply_path='.github/workflows/terraform-apply.yml'
apply_event='workflow_dispatch'
apply_status='completed'
apply_conclusion='success'
apply_sha="${valid_sha}"
apply_branch='main'
apply_repository='fukamu/cycle'
artifact_sha="${valid_sha}"
artifact_expired=false
artifact_total=1
artifact_run_id=123
artifact_name="terraform-apply-staging-${artifact_sha}"
artifact_extra=false
ci_name='CI'
ci_path='.github/workflows/ci.yml'
ci_event='push'
ci_status='completed'
ci_conclusion='success'
ci_sha="${valid_sha}"
ci_repository='fukamu/cycle'
ci_total=1
ci_id=789
if [[ "${evidence_kind}" == 'plan' ]]; then
  apply_name='Terraform Plan Staging'
  apply_path='.github/workflows/terraform-plan.yml'
  apply_event='workflow_run'
  artifact_name="terraform-plan-staging-${artifact_sha}-no_changes"
fi
case "${scenario}" in
  wrong-workflow) apply_name='Terraform Apply Renamed' ;;
  wrong-path) apply_path='.github/workflows/other.yml' ;;
  wrong-event) apply_event='push' ;;
  incomplete-apply) apply_status='in_progress' ;;
  failed-apply) apply_conclusion='failure' ;;
  stale-apply) apply_sha="${stale_sha}" ;;
  wrong-apply-branch) apply_branch='topic' ;;
  wrong-apply-repository) apply_repository='attacker/cycle' ;;
  wrong-artifact) artifact_sha="${stale_sha}" ;;
  changes-plan) artifact_name="terraform-plan-staging-${valid_sha}-changes_present" ;;
  expired-artifact) artifact_expired=true ;;
  wrong-artifact-run) artifact_run_id=124 ;;
  multiple-artifacts) artifact_total=2; artifact_extra=true ;;
  paginated-artifacts) artifact_total=101 ;;
  wrong-ci-name) ci_name='CI Renamed' ;;
  wrong-ci-path) ci_path='.github/workflows/other.yml' ;;
  wrong-ci-event) ci_event='workflow_dispatch' ;;
  incomplete-ci) ci_status='in_progress' ;;
  failed-ci) ci_conclusion='failure' ;;
  stale-ci) ci_sha="${stale_sha}" ;;
  wrong-ci-repository) ci_repository='attacker/cycle' ;;
  paginated-ci) ci_total=101 ;;
  wrong-ci-id) ci_id=0 ;;
  missing-ci) ci_total=0 ;;
esac
if [[ "${scenario}" == 'wrong-artifact' ]]; then
  if [[ "${evidence_kind}" == 'plan' ]]; then
    artifact_name="terraform-plan-staging-${artifact_sha}-no_changes"
  else
    artifact_name="terraform-apply-staging-${artifact_sha}"
  fi
fi
case "$*" in
  *'/git/ref/heads/main'*)
    printf '{"ref":"refs/heads/main","object":{"type":"commit","sha":"%s"}}\n' "${valid_sha}"
    if [[ "${scenario}" == 'trailing-main-json' ]]; then printf '{}\n'; fi
    ;;
  *'/actions/runs/123/artifacts?per_page=100'*)
    if [[ "${artifact_extra}" == true ]]; then
      printf '{"total_count":2,"artifacts":[{"id":456,"name":"%s","expired":%s,"workflow_run":{"id":%s}},{"id":457,"name":"terraform-plan-staging-%s-changes_present","expired":false,"workflow_run":{"id":123}}]}\n' \
        "${artifact_name}" "${artifact_expired}" "${artifact_run_id}" "${valid_sha}"
    else
      printf '{"total_count":%s,"artifacts":[{"id":456,"name":"%s","expired":%s,"workflow_run":{"id":%s}}]}\n' \
        "${artifact_total}" "${artifact_name}" "${artifact_expired}" "${artifact_run_id}"
    fi
    ;;
  *'/actions/runs/123'*)
    printf '{"id":123,"name":"%s","path":"%s","event":"%s","status":"%s","conclusion":"%s","head_sha":"%s","head_branch":"%s","head_repository":{"full_name":"%s"}}\n' \
      "${apply_name}" "${apply_path}" "${apply_event}" "${apply_status}" "${apply_conclusion}" "${apply_sha}" \
      "${apply_branch}" "${apply_repository}"
    ;;
  *'/actions/workflows/ci.yml/runs'*)
    if [[ "${ci_total}" == '0' ]]; then
      printf '{"total_count":0,"workflow_runs":[]}\n'
    else
      printf '{"total_count":%s,"workflow_runs":[{"id":%s,"name":"%s","path":"%s","event":"%s","status":"%s","conclusion":"%s","head_sha":"%s","head_branch":"main","head_repository":{"full_name":"%s"}}]}\n' \
        "${ci_total}" "${ci_id}" "${ci_name}" "${ci_path}" "${ci_event}" "${ci_status}" "${ci_conclusion}" "${ci_sha}" "${ci_repository}"
    fi
    ;;
  *) exit 97 ;;
esac
FAKE_GH
  chmod +x -- "${fake_bin}/gh"

  run_deploy_resolver() {
    local scenario="$1"
    local mode="$2"
    local dispatch_sha="$3"
    local evidence_kind="${4:-apply}"
    local infra_evidence_run_id=123
    if [[ "${mode}" == 'recovery' ]]; then infra_evidence_run_id=''; fi
    : >"${github_output}"
    env -i \
      PATH="${fake_bin}:/usr/bin:/bin" \
      FAKE_EVIDENCE_KIND="${evidence_kind}" \
      FAKE_SCENARIO="${scenario}" \
      DISPATCH_SHA="${dispatch_sha}" \
      GH_TOKEN=fake \
      GITHUB_REPOSITORY=fukamu/cycle \
      GITHUB_OUTPUT="${github_output}" \
      INFRA_EVIDENCE_RUN_ID="${infra_evidence_run_id}" \
      MODE="${mode}" \
      bash "${resolve_script}" >"${output}" 2>&1
  }

  if ! run_deploy_resolver success normal "${valid_sha}"; then
    violation "Deploy Staging resolver rejected valid Apply, artifact, and CI evidence"
    return 1
  fi
  require_nonblank_lines "${github_output}" \
    "ci_run_id=789" \
    "commit_sha=${valid_sha}" \
    "infra_evidence_artifact_name=terraform-apply-staging-${valid_sha}" \
    "infra_evidence_kind=applied_plan" \
    "infra_evidence_run_id=123" || return 1
  if ! run_deploy_resolver success normal "${valid_sha}" plan; then
    violation "Deploy Staging resolver rejected valid no-change Plan evidence"
    return 1
  fi
  require_nonblank_lines "${github_output}" \
    "ci_run_id=789" \
    "commit_sha=${valid_sha}" \
    "infra_evidence_artifact_name=terraform-plan-staging-${valid_sha}-no_changes" \
    "infra_evidence_kind=no_changes_plan" \
    "infra_evidence_run_id=123" || return 1
  if run_deploy_resolver changes-plan normal "${valid_sha}" plan; then
    violation "Deploy Staging resolver accepted a changes-present Plan without Apply"
    return 1
  fi
  if ! run_deploy_resolver success recovery "${valid_sha}"; then
    violation "Deploy Staging resolver rejected valid recovery CI evidence"
    return 1
  fi

  local scenario
  for scenario in \
    wrong-workflow wrong-path wrong-event incomplete-apply failed-apply stale-apply \
    wrong-apply-branch wrong-apply-repository wrong-artifact expired-artifact \
    wrong-artifact-run multiple-artifacts paginated-artifacts wrong-ci-name wrong-ci-path wrong-ci-event \
    incomplete-ci failed-ci stale-ci wrong-ci-repository paginated-ci wrong-ci-id missing-ci trailing-main-json; do
    if run_deploy_resolver "${scenario}" normal "${valid_sha}"; then
      violation "Deploy Staging resolver accepted invalid evidence: ${scenario}"
      return 1
    fi
  done
  for scenario in \
    wrong-ci-name wrong-ci-path wrong-ci-event incomplete-ci failed-ci stale-ci \
    wrong-ci-repository paginated-ci wrong-ci-id missing-ci trailing-main-json; do
    if run_deploy_resolver "${scenario}" recovery "${valid_sha}"; then
      violation "Deploy Staging recovery resolver accepted invalid CI evidence: ${scenario}"
      return 1
    fi
  done
  if run_deploy_resolver success normal "${stale_sha}"; then
    violation "Deploy Staging resolver accepted a stale dispatch SHA"
    return 1
  fi
  if run_deploy_resolver success recovery "${stale_sha}"; then
    violation "Deploy Staging recovery resolver accepted a stale dispatch SHA"
    return 1
  fi

  extract_named_step "${resolve_job}" "Authorize deploy job attempt" >"${authorize_attempt_step}" || {
    violation "Deploy Staging must authorize the exact resolved run attempt"
    return 1
  }
  extract_literal_run_script "${authorize_attempt_step}" >"${authorize_attempt_script}" || {
    violation "Deploy Staging attempt authorization script must be extractable"
    return 1
  }
  run_authorize_attempt() {
    local run_attempt="$1"
    local retry_verified="$2"
    : >"${github_output}"
    env -i \
      PATH=/usr/bin:/bin \
      GITHUB_RUN_ATTEMPT="${run_attempt}" \
      RETRY_CHECKPOINT_VERIFIED="${retry_verified}" \
      GITHUB_OUTPUT="${github_output}" \
      bash "${authorize_attempt_script}" >"${output}" 2>&1
  }
  if ! run_authorize_attempt 1 ''; then
    violation "Deploy Staging attempt authorization rejected attempt one"
    return 1
  fi
  grep -Fxq "verified_run_attempt=1" "${github_output}" || {
    violation "Deploy Staging attempt one authorization did not emit its exact attempt"
    return 1
  }
  if ! run_authorize_attempt 2 true; then
    violation "Deploy Staging attempt authorization rejected a verified attempt two"
    return 1
  fi
  grep -Fxq "verified_run_attempt=2" "${github_output}" || {
    violation "Deploy Staging attempt two authorization did not emit its exact attempt"
    return 1
  }
  if run_authorize_attempt 2 false || run_authorize_attempt 3 true; then
    violation "Deploy Staging attempt authorization accepted missing evidence or attempt three"
    return 1
  fi

  extract_job "${deploy_workflow}" deploy >"${deploy_job}" || {
    violation "Deploy Staging mutation job must exist"
    return 1
  }
  extract_job_mapping "${deploy_job}" steps >"${deploy_steps}" || {
    violation "Deploy Staging mutation job must define one steps mapping"
    return 1
  }
  first_step="$(awk 'NF { print; exit }' "${deploy_steps}")"
  [[ "${first_step}" == "      - name: Verify resolved deployment attempt" ]] || {
    violation "Deploy Staging mutation job must reject a partial rerun before checkout or secrets"
    return 1
  }
  extract_named_step "${deploy_job}" "Verify resolved deployment attempt" >"${deploy_attempt_step}" || {
    violation "Deploy Staging mutation job must verify the fresh resolve attempt"
    return 1
  }
  extract_literal_run_script "${deploy_attempt_step}" >"${deploy_attempt_script}" || {
    violation "Deploy Staging mutation attempt guard must be extractable"
    return 1
  }
  run_deploy_attempt_guard() {
    env -i \
      PATH=/usr/bin:/bin \
      GITHUB_RUN_ATTEMPT="$1" \
      VERIFIED_RUN_ATTEMPT="$2" \
      bash "${deploy_attempt_script}" >"${output}" 2>&1
  }
  if ! run_deploy_attempt_guard 1 1 || ! run_deploy_attempt_guard 2 2; then
    violation "Deploy Staging mutation attempt guard rejected an exact fresh resolve"
    return 1
  fi
  if run_deploy_attempt_guard 2 1 || run_deploy_attempt_guard 3 3; then
    violation "Deploy Staging mutation attempt guard accepted a partial rerun or attempt three"
    return 1
  fi

  local resolve_retry_line
  local download_retry_line
  local verify_infra_line
  local verify_retry_line
  local reverify_main_line
  local authorize_line
  resolve_retry_line="$(grep -nF '      - name: Resolve prior safe retry checkpoint' "${resolve_job}" | cut -d: -f1)"
  download_retry_line="$(grep -nF '      - name: Download prior safe retry checkpoint' "${resolve_job}" | cut -d: -f1)"
  verify_infra_line="$(grep -nF '      - name: Verify approved Terraform evidence' "${resolve_job}" | cut -d: -f1)"
  verify_retry_line="$(grep -nF '      - name: Verify prior safe retry checkpoint' "${resolve_job}" | cut -d: -f1)"
  reverify_main_line="$(grep -nF '      - name: Re-verify deployment commit before Staging approval' "${resolve_job}" | cut -d: -f1)"
  authorize_line="$(grep -nF '      - name: Authorize deploy job attempt' "${resolve_job}" | cut -d: -f1)"
  if [[ -z "${resolve_retry_line}" || -z "${download_retry_line}" || -z "${verify_infra_line}" || -z "${verify_retry_line}" || -z "${reverify_main_line}" || -z "${authorize_line}" ]] \
    || ! ((\
    resolve_retry_line < download_retry_line && \
    download_retry_line < verify_infra_line && \
    verify_infra_line < verify_retry_line && \
    verify_retry_line < reverify_main_line && \
    reverify_main_line < authorize_line)) \
    ; then
    violation "Deploy Staging retry provenance, current evidence, and final authorization order is invalid"
    return 1
  fi

}

validate_legacy_retirement_approval_gate() {
  local directory="$1"
  local workflow="${directory}/retire-legacy-origin.yml"
  local on_block="${test_root}/legacy-retirement-on.block"
  local preflight_job="${test_root}/legacy-retirement-preflight.job"
  local preflight_steps="${test_root}/legacy-retirement-preflight.steps"
  local approval_step="${test_root}/legacy-retirement-approval.step"
  local approval_env="${test_root}/legacy-retirement-approval.env"
  local approval_script="${test_root}/legacy-retirement-approval.sh"
  local deploy_job="${test_root}/legacy-retirement-deploy.job"
  local deploy_steps="${test_root}/legacy-retirement-deploy.steps"
  local deploy_environment="${test_root}/legacy-retirement-deploy.environment"
  local deploy_env="${test_root}/legacy-retirement-deploy.env"
  local final_main_step="${test_root}/legacy-retirement-final-main.step"
  local checkout_step="${test_root}/legacy-retirement-checkout.step"
  local fake_bin="${test_root}/legacy-retirement-fake-bin"
  local output="${test_root}/legacy-retirement.output"
  local github_output="${test_root}/legacy-retirement.github-output"
  local valid_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local stale_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  local actual_trigger_keys
  local actual_input_keys
  local first_step

  extract_root_mapping "${workflow}" on >"${on_block}" || {
    violation "Legacy origin retirement must define one trigger mapping"
    return 1
  }
  actual_trigger_keys="$(awk '/^  [[:alnum:]_-]+:/ { key = $1; sub(/:$/, "", key); print key }' "${on_block}")"
  [[ "${actual_trigger_keys}" == "workflow_dispatch" ]] || {
    violation "Legacy origin retirement must remain manual-only"
    return 1
  }
  actual_input_keys="$(awk '/^      [[:alnum:]_-]+:/ { key = $1; sub(/:$/, "", key); print key }' "${on_block}")"
  [[ "${actual_input_keys}" == "confirmation" ]] || {
    violation "Legacy origin retirement must expose only the explicit confirmation input"
    return 1
  }
  require_dispatch_input_contract "${workflow}" confirmation true string || return 1

  extract_job "${workflow}" preflight >"${preflight_job}" || {
    violation "Legacy origin retirement preflight job must exist"
    return 1
  }
  if grep -Eq '^    environment:' "${preflight_job}"; then
    violation "Legacy origin retirement must validate authorization before the staging Environment"
    return 1
  fi
  extract_job_mapping "${preflight_job}" steps >"${preflight_steps}" || return 1
  first_step="$(awk 'NF { print; exit }' "${preflight_steps}")"
  [[ "${first_step}" == "      - name: Verify owner decision and exact main commit" ]] || {
    violation "Legacy origin retirement authorization must run before every API call"
    return 1
  }
  extract_named_step "${preflight_job}" "Verify owner decision and exact main commit" >"${approval_step}" || {
    violation "Legacy origin retirement approval step must exist exactly once"
    return 1
  }
  extract_step_mapping "${approval_step}" env >"${approval_env}" || return 1
  # GitHub expressions below are intentional workflow literals.
  # shellcheck disable=SC2016
  require_nonblank_lines "${approval_env}" \
    '          DISPATCH_SHA: ${{ github.sha }}' \
    '          CONFIRMATION: ${{ inputs.confirmation }}' \
    '          EXPECTED_APPROVER: ${{ vars.LEGACY_RETIREMENT_APPROVER }}' \
    '          GH_TOKEN: ${{ github.token }}' || return 1
  if grep -Eq 'secrets\.|inputs\.commit_sha' "${approval_step}"; then
    violation "Legacy origin retirement must use the dispatch revision without secret or commit input overrides"
    return 1
  fi
  extract_literal_run_script "${approval_step}" >"${approval_script}" || {
    violation "Legacy origin retirement approval script must be extractable"
    return 1
  }

  mkdir -p -- "${fake_bin}"
  cat >"${fake_bin}/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$*" in
  *'/git/ref/heads/main'*)
    printf '{"ref":"refs/heads/main","object":{"sha":"%s"},"url":"https://api.github.com/repos/fukamu/cycle/git/refs/heads/main"}\n' "${FAKE_MAIN_SHA}"
    if [[ "${FAKE_CI_SCENARIO}" == 'trailing-main' ]]; then printf '{}\n'; fi
    ;;
  *'/actions/workflows/ci.yml/runs'*)
    ci_sha="${DISPATCH_SHA}"
    ci_repository='fukamu/cycle'
    ci_name='CI'
    ci_path='.github/workflows/ci.yml'
    ci_event='push'
    ci_status='completed'
    ci_conclusion='success'
    ci_branch='main'
    [[ "${FAKE_CI_SCENARIO}" == 'stale-ci' ]] && ci_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    [[ "${FAKE_CI_SCENARIO}" == 'wrong-repository' ]] && ci_repository='attacker/cycle'
    [[ "${FAKE_CI_SCENARIO}" == 'wrong-name' ]] && ci_name='CI renamed'
    [[ "${FAKE_CI_SCENARIO}" == 'wrong-path' ]] && ci_path='.github/workflows/other.yml'
    [[ "${FAKE_CI_SCENARIO}" == 'wrong-event' ]] && ci_event='workflow_dispatch'
    [[ "${FAKE_CI_SCENARIO}" == 'wrong-status' ]] && ci_status='in_progress'
    [[ "${FAKE_CI_SCENARIO}" == 'wrong-conclusion' ]] && ci_conclusion='failure'
    [[ "${FAKE_CI_SCENARIO}" == 'wrong-branch' ]] && ci_branch='topic'
    if [[ "${FAKE_CI_SCENARIO}" == 'missing' ]]; then
      printf '{"total_count":0,"workflow_runs":[]}\n'
    else
      printf '{"total_count":1,"workflow_runs":[{"name":"%s","path":"%s","event":"%s","status":"%s","conclusion":"%s","head_branch":"%s","head_sha":"%s","head_repository":{"full_name":"%s"}}]}\n' \
        "${ci_name}" "${ci_path}" "${ci_event}" "${ci_status}" "${ci_conclusion}" "${ci_branch}" "${ci_sha}" "${ci_repository}"
      if [[ "${FAKE_CI_SCENARIO}" == 'trailing-ci' ]]; then printf '{}\n'; fi
    fi
    ;;
  *) exit 97 ;;
esac
FAKE_GH
  chmod +x -- "${fake_bin}/gh"

  run_legacy_retirement_preflight() {
    local ref="$1"
    local expected_approver="$2"
    local actor="$3"
    local triggering_actor="$4"
    local confirmation="$5"
    local dispatch_sha="$6"
    local main_sha="$7"
    local ci_scenario="$8"
    : >"${github_output}"
    env -i \
      PATH="${fake_bin}:/usr/bin:/bin" \
      GITHUB_REF="${ref}" \
      EXPECTED_APPROVER="${expected_approver}" \
      GITHUB_ACTOR="${actor}" \
      GITHUB_TRIGGERING_ACTOR="${triggering_actor}" \
      CONFIRMATION="${confirmation}" \
      DISPATCH_SHA="${dispatch_sha}" \
      FAKE_MAIN_SHA="${main_sha}" \
      FAKE_CI_SCENARIO="${ci_scenario}" \
      GITHUB_REPOSITORY=fukamu/cycle \
      GITHUB_OUTPUT="${github_output}" \
      GH_TOKEN=fake \
      bash "${approval_script}" >"${output}" 2>&1
  }

  if ! run_legacy_retirement_preflight \
    refs/heads/main Owner owner OWNER \
    'RETIRE pdcai.matoruru.com WITHOUT RECOVERY' \
    "${valid_sha}" "${valid_sha}" success; then
    violation "Legacy origin retirement rejected valid owner approval on current green main"
    return 1
  fi
  require_nonblank_lines "${github_output}" "commit_sha=${valid_sha}" || return 1

  local -a invalid_preflights=(
    "refs/heads/topic|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|success"
    "refs/heads/main||owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|success"
    "refs/heads/main|Owner|attacker|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|success"
    "refs/heads/main|Owner|owner|attacker|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|success"
    "refs/heads/main|Owner|owner|owner|incorrect|${valid_sha}|${valid_sha}|success"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|invalid|${valid_sha}|success"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${stale_sha}|success"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|missing"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|stale-ci"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|wrong-repository"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|wrong-name"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|wrong-path"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|wrong-event"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|wrong-status"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|wrong-conclusion"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|wrong-branch"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|trailing-main"
    "refs/heads/main|Owner|owner|owner|RETIRE pdcai.matoruru.com WITHOUT RECOVERY|${valid_sha}|${valid_sha}|trailing-ci"
  )
  local fixture
  local -a fields
  for fixture in "${invalid_preflights[@]}"; do
    IFS='|' read -r -a fields <<<"${fixture}|_"
    if run_legacy_retirement_preflight \
      "${fields[0]}" "${fields[1]}" "${fields[2]}" "${fields[3]}" \
      "${fields[4]}" "${fields[5]}" "${fields[6]}" "${fields[7]}"; then
      violation "Legacy origin retirement accepted invalid approval fixture: ${fixture}"
      return 1
    fi
  done

  extract_job "${workflow}" deploy >"${deploy_job}" || {
    violation "Legacy origin retirement deploy job must exist"
    return 1
  }
  require_exact_line "${deploy_job}" "    needs: preflight" || return 1
  extract_job_mapping "${deploy_job}" steps >"${deploy_steps}" || return 1
  first_step="$(awk 'NF { print; exit }' "${deploy_steps}")"
  [[ "${first_step}" == "      - name: Verify approved commit is still main HEAD" ]] || {
    violation "Legacy origin retirement must re-verify current main before checkout or deployment"
    return 1
  }
  extract_named_step "${deploy_job}" "Verify approved commit is still main HEAD" >"${final_main_step}" || return 1
  for invariant in \
    '              "/repos/${GITHUB_REPOSITORY}/git/ref/heads/main"' \
    '          if [[ "${COMMIT_SHA}" != "${current_main_sha}" ]]; then'; do
    grep -Fqx -- "${invariant}" "${final_main_step}" || {
      violation "Legacy origin retirement final main identity guard is incomplete"
      return 1
    }
  done
  extract_job_mapping "${deploy_job}" environment >"${deploy_environment}" || return 1
  require_nonblank_lines "${deploy_environment}" \
    "      name: staging" \
    "      url: https://pdcai.matoruru.com" || return 1
  extract_job_mapping "${deploy_job}" env >"${deploy_env}" || return 1
  # GitHub expression below is an intentional workflow literal.
  # shellcheck disable=SC2016
  require_nonblank_lines "${deploy_env}" \
    '      COMMIT_SHA: ${{ needs.preflight.outputs.commit_sha }}' || return 1
  extract_checkout_step "${deploy_job}" >"${checkout_step}" || return 1
  # Workflow expression below is an intentional literal.
  # shellcheck disable=SC2016
  require_exact_line "${checkout_step}" '          ref: ${{ env.COMMIT_SHA }}' || return 1
}

validate_playbook_workflow_contract() {
  local file="$1"
  local validate_job="${test_root}/playbook-validate.job"
  local validate_body

  grep -Fqx -- "name: Playbook policy" "${file}" || {
    violation "Playbook policy workflow must retain its stable identity"
    return 1
  }
  extract_job "${file}" validate >"${validate_job}" || {
    violation "Playbook policy workflow must retain a validate job"
    return 1
  }
  validate_body="$(cat "${validate_job}")"
  for invariant in \
    "    runs-on: ubuntu-latest" \
    "    timeout-minutes: 5" \
    '          persist-credentials: false' \
    '          PYTHONNOUSERSITE: "1"' \
    '          PYTHONPATH: ""' \
    '          PYTHONSAFEPATH: "1"' \
    "          node scripts/validate-playbook-config.mjs ." \
    "          python3 .fukamu/playbook/validate.py --consumer ."; do
    [[ "${validate_body}" == *"${invariant}"* ]] || {
      violation "Playbook policy workflow is missing a semantic validation invariant"
      return 1
    }
  done
  [[ "$(grep -Fc -- 'node scripts/validate-playbook-config.mjs .' "${validate_job}")" -eq 1 &&
  "$(grep -Fc -- 'python3 .fukamu/playbook/validate.py --consumer .' "${validate_job}")" -eq 1 ]] || {
    violation "Playbook policy validators must each run exactly once"
    return 1
  }
}

validate_security_audit_workflow_contract() {
  local file="$1"
  local on_block="${test_root}/security-audit-on.block"
  local permissions_block="${test_root}/security-audit-permissions.block"
  local concurrency_block="${test_root}/security-audit-concurrency.block"
  local audit_job="${test_root}/security-audit.job"
  local audit_steps="${test_root}/security-audit-steps.block"
  local audit_attempt_step="${test_root}/security-audit-attempt.step"
  local audit_attempt_script="${test_root}/security-audit-attempt.sh"
  local audit_attempt_output="${test_root}/security-audit-attempt.output"
  local audit_checkout="${test_root}/security-audit-checkout.step"
  local audit_current_step="${test_root}/security-audit-current.step"
  local audit_current_script="${test_root}/security-audit-current.sh"
  local audit_current_output="${test_root}/security-audit-current.output"
  local audit_fake_bin="${test_root}/security-audit-bin"
  local report_job="${test_root}/security-audit-report.job"
  local report_permissions="${test_root}/security-audit-report-permissions.block"
  local report_step="${test_root}/security-audit-report.step"

  validate_exact_workflow_structure "${file}" security-audit || return 1
  extract_root_mapping "${file}" on >"${on_block}" || return 1
  require_nonblank_lines "${on_block}" \
    "  workflow_dispatch:" \
    "  schedule:" \
    '    - cron: "0 20 * * 0"' || return 1
  extract_root_mapping "${file}" permissions >"${permissions_block}" || return 1
  require_nonblank_lines "${permissions_block}" "  contents: read" || return 1
  if [[ "$(awk '/^[[:space:]]*permissions:/ { count++ } END { print count + 0 }' "${file}")" != "2" ]]; then
    violation "Security audit may grant job-level permissions only to its issue reporter"
    return 1
  fi
  extract_root_mapping "${file}" concurrency >"${concurrency_block}" || return 1
  require_nonblank_lines "${concurrency_block}" \
    "  group: security-audit" \
    "  cancel-in-progress: false" || return 1

  extract_job "${file}" audit >"${audit_job}" || return 1
  if grep -Eq '^    permissions:' "${audit_job}"; then
    violation "Security audit scan job must inherit the read-only workflow permissions"
    return 1
  fi
  extract_job_mapping "${audit_job}" steps >"${audit_steps}" || return 1
  [[ "$(awk 'NF { print; exit }' "${audit_steps}")" == "      - name: Require a fresh audit workflow run" ]] || {
    violation "Security audit must reject reruns before checkout or scanning"
    return 1
  }
  extract_named_step "${audit_job}" "Require a fresh audit workflow run" >"${audit_attempt_step}" || return 1
  extract_literal_run_script "${audit_attempt_step}" >"${audit_attempt_script}" || return 1
  if ! env -i PATH=/usr/bin:/bin GITHUB_RUN_ATTEMPT=1 GITHUB_REF=refs/heads/main \
    bash "${audit_attempt_script}" >"${audit_attempt_output}" 2>&1; then
    violation "Security audit rejected a fresh workflow run"
    return 1
  fi
  if env -i PATH=/usr/bin:/bin GITHUB_RUN_ATTEMPT=2 GITHUB_REF=refs/heads/main \
    bash "${audit_attempt_script}" >"${audit_attempt_output}" 2>&1; then
    violation "Security audit accepted a rerun that can overwrite failure history"
    return 1
  fi
  if env -i PATH=/usr/bin:/bin GITHUB_RUN_ATTEMPT=1 GITHUB_REF=refs/heads/other \
    bash "${audit_attempt_script}" >"${audit_attempt_output}" 2>&1; then
    violation "Security audit accepted a non-main workflow run"
    return 1
  fi
  extract_checkout_step "${audit_job}" >"${audit_checkout}" || return 1
  require_exact_line "${audit_checkout}" "          fetch-depth: 0" || return 1
  require_exact_line "${audit_steps}" "        run: bash ./scripts/check-security.sh --profile full" || return 1
  extract_named_step "${audit_job}" "Verify audited commit is still current main" >"${audit_current_step}" || {
    violation "Security audit must re-verify current main after the full scan"
    return 1
  }
  extract_literal_run_script "${audit_current_step}" >"${audit_current_script}" || return 1
  mkdir -p -- "${audit_fake_bin}"
  cat >"${audit_fake_bin}/gh" <<'FAKE_SECURITY_AUDIT_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${FAKE_CURRENT_MAIN:-current}" in
  current) printf '%s\n' '{"ref":"refs/heads/main","object":{"type":"commit","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}' ;;
  stale) printf '%s\n' '{"ref":"refs/heads/main","object":{"type":"commit","sha":"cccccccccccccccccccccccccccccccccccccccc"}}' ;;
  trailing)
    printf '%s\n%s\n' \
      '{"ref":"refs/heads/main","object":{"type":"commit","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}' \
      '{"unexpected":true}'
    ;;
esac
FAKE_SECURITY_AUDIT_GH
  chmod +x "${audit_fake_bin}/gh"
  if ! env -i \
    PATH="${audit_fake_bin}:/usr/bin:/bin" \
    FAKE_CURRENT_MAIN=current \
    GH_TOKEN=fake \
    GITHUB_REPOSITORY=fukamu/cycle \
    GITHUB_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    bash "${audit_current_script}" >"${audit_current_output}" 2>&1; then
    violation "Security audit rejected the exact current main after scanning"
    return 1
  fi
  for stale_state in stale trailing; do
    if env -i \
      PATH="${audit_fake_bin}:/usr/bin:/bin" \
      FAKE_CURRENT_MAIN="${stale_state}" \
      GH_TOKEN=fake \
      GITHUB_REPOSITORY=fukamu/cycle \
      GITHUB_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
      bash "${audit_current_script}" >"${audit_current_output}" 2>&1; then
      violation "Security audit accepted stale or ambiguous current main evidence"
      return 1
    fi
  done

  extract_job "${file}" report_failure >"${report_job}" || return 1
  require_exact_line "${report_job}" "    needs: audit" || return 1
  # shellcheck disable=SC2016 # Expected workflow expression is a literal.
  require_exact_line "${report_job}" \
    "    if: \${{ always() && github.event_name == 'schedule' && needs.audit.result != 'success' }}" || return 1
  extract_job_mapping "${report_job}" permissions >"${report_permissions}" || return 1
  require_nonblank_lines "${report_permissions}" "      issues: write" || return 1
  extract_named_step "${report_job}" "Create or update the fixed security audit issue" >"${report_step}" || return 1
  # shellcheck disable=SC1003 # The asserted workflow lines intentionally end in a literal backslash.
  for invariant in \
    '          GH_TOKEN: ${{ github.token }}' \
    "          issue_title='[Security audit] Scheduled full scan failed'" \
    '          search_response="$(gh api --method GET /search/issues \' \
    '              "repos/${GITHUB_REPOSITORY}/issues/${issue_number}/comments" \' \
    '            gh api --method POST "repos/${GITHUB_REPOSITORY}/issues" \' \
    '            .incomplete_results == false and' \
    '            .total_count <= 100 and'; do
    grep -Fqx -- "${invariant}" "${report_step}" || {
      violation "scheduled security audit reporting contract is incomplete"
      return 1
    }
  done
  [[ "$(grep -Fc -- "issue_title='[Security audit] Scheduled full scan failed'" "${report_step}")" == "1" ]] || {
    violation "scheduled security audit issue title must be one fixed value"
    return 1
  }
  if grep -Eq 'actions/checkout|secrets\.|continue-on-error|security[^ ]*\.(log|json)' "${report_job}"; then
    violation "scheduled failure reporting must be checkout-free, secret-free, fail-closed, and free of raw findings"
    return 1
  fi
}

validate_security_audit_release_gate_consumers() {
  local directory="$1"
  local filename
  local job
  local workflow
  local job_file
  local gate_step

  while IFS='|' read -r filename job; do
    workflow="${directory}/${filename}"
    job_file="${test_root}/${filename}-security-audit-consumer.job"
    gate_step="${test_root}/${filename}-security-audit-consumer.step"
    extract_job "${workflow}" "${job}" >"${job_file}" || return 1
    extract_named_step "${job_file}" "Verify security audit release gate" >"${gate_step}" || {
      violation "${filename} must enforce the shared security audit release gate"
      return 1
    }
    # GitHub/runtime expressions below are intentional workflow literals.
    # shellcheck disable=SC2016
    require_nonblank_lines "${gate_step}" \
      "      - name: Verify security audit release gate" \
      "        shell: bash" \
      "        env:" \
      '          GH_TOKEN: ${{ github.token }}' \
      '        run: bash .github/scripts/verify-security-audit-release-gate.sh "${COMMIT_SHA}"' || return 1
    if grep -Eq 'continue-on-error|if:' "${gate_step}"; then
      violation "${filename} security audit release gate must be unconditional and fail closed"
      return 1
    fi
  done <<'SECURITY_AUDIT_RELEASE_CONSUMERS'
terraform-plan.yml|plan
terraform-apply.yml|apply
deploy.yml|deploy
SECURITY_AUDIT_RELEASE_CONSUMERS
}

validate_workflow_concurrency_contract() {
  local directory="$1"
  local filename
  local expected_group
  local concurrency_file
  while IFS='|' read -r filename expected_group; do
    concurrency_file="${test_root}/${filename}-concurrency.block"
    extract_root_mapping "${directory}/${filename}" concurrency >"${concurrency_file}" || return 1
    require_nonblank_lines "${concurrency_file}" \
      "  group: ${expected_group}" \
      "  cancel-in-progress: false" || return 1
  done <<'CONCURRENCY_INVENTORY'
deploy.yml|staging-deploy
retire-legacy-origin.yml|legacy-pdcai-origin-retirement
security-audit.yml|security-audit
terraform-apply.yml|staging-terraform
terraform-plan.yml|staging-terraform
CONCURRENCY_INVENTORY
}

validate_terraform_plan_trigger_contract() {
  local file="$1"
  local on_block="${test_root}/terraform-plan-on.block"

  extract_root_mapping "${file}" on >"${on_block}" || return 1
  require_nonblank_lines "${on_block}" \
    "  workflow_run:" \
    "    workflows: [CI]" \
    "    types: [completed]" \
    "  workflow_dispatch:" || {
    violation "Terraform Plan must retain the CI-completion and manual trigger boundaries"
    return 1
  }
}

validate_all_workflows() {
  local directory="$1"
  local filename
  for filename in ci.yml deploy.yml playbook.yml retire-legacy-origin.yml security-audit.yml terraform-apply.yml terraform-plan.yml; do
    [[ -f "${directory}/${filename}" ]] || {
      violation "required workflow is missing: ${filename}"
      return 1
    }
  done
  validate_exact_workflow_structure "${directory}/ci.yml" ci || return 1
  validate_exact_workflow_structure "${directory}/deploy.yml" deploy || return 1
  validate_exact_workflow_structure "${directory}/playbook.yml" playbook || return 1
  validate_exact_workflow_structure "${directory}/retire-legacy-origin.yml" legacy-retirement || return 1
  validate_exact_workflow_structure "${directory}/security-audit.yml" security-audit || return 1
  validate_exact_workflow_structure "${directory}/terraform-apply.yml" terraform-apply || return 1
  validate_exact_workflow_structure "${directory}/terraform-plan.yml" terraform-plan || return 1
  while IFS= read -r filename; do
    validate_workflow_source_guards "${directory}/${filename}" || return 1
    validate_checkout_credential_file "${directory}/${filename}" || return 1
  done < <(
    find "${directory}" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -printf '%f\n' \
      | LC_ALL=C sort
  )
  validate_workflow_permissions_contract "${directory}" || return 1
  validate_terraform_r2_secret_sources "${directory}" || return 1
  validate_deploy_approval_gate "${directory}" || return 1
  validate_legacy_retirement_approval_gate "${directory}" || return 1
  validate_playbook_workflow_contract "${directory}/playbook.yml" || return 1
  validate_security_audit_workflow_contract "${directory}/security-audit.yml" || return 1
  validate_security_audit_release_gate_consumers "${directory}" || return 1
  validate_workflow_concurrency_contract "${directory}" || return 1
  validate_terraform_plan_trigger_contract "${directory}/terraform-plan.yml" || return 1
}

validate_checkout_steps() {
  local file="$1"
  local -a checkout_jobs=(
    reuse_pr_ci
    release_security
    classify
    workflow
    quality
    frontend
    backend
    infrastructure
    e2e
    required_pr_ci
    attest_pr_ci
  )
  local job
  for job in "${checkout_jobs[@]}"; do
    local job_file="${test_root}/${job}-checkout.job"
    local checkout_step="${test_root}/${job}-checkout.step"
    local checkout_with="${test_root}/${job}-checkout-with.block"
    extract_job "${file}" "${job}" >"${job_file}" || {
      violation "${job} job must exist exactly once for checkout validation"
      return 1
    }
    extract_checkout_step "${job_file}" >"${checkout_step}" || {
      violation "${job} must contain exactly one canonical checkout step"
      return 1
    }
    extract_step_mapping "${checkout_step}" with >"${checkout_with}" || {
      violation "${job} checkout must contain exactly one with mapping"
      return 1
    }
    require_exact_line "${checkout_with}" "          persist-credentials: false" || return 1
    [[ "$(awk '/persist-credentials[[:space:]]*:/ { count++ } END { print count + 0 }' "${checkout_step}")" == "1" ]] || {
      violation "${job} checkout must define persist-credentials exactly once in its own with mapping"
      return 1
    }

    local checkout_key
    while IFS= read -r checkout_key; do
      case "${checkout_key}" in
        persist-credentials | fetch-depth | ref) ;;
        *)
          violation "${job} checkout contains unsupported source or credential override: ${checkout_key}"
          return 1
          ;;
      esac
    done < <(
      awk '/^          [[:alnum:]_-]+:/ { key = $1; sub(/:$/, "", key); print key }' "${checkout_with}"
    )

    local ref_count
    ref_count="$(awk '/^          ref:/ { count++ } END { print count + 0 }' "${checkout_with}")"
    if [[ "${job}" == "required_pr_ci" || "${job}" == "attest_pr_ci" ]]; then
      [[ "${ref_count}" == "1" ]] || {
        violation "${job} checkout must bind to the exact workflow revision"
        return 1
      }
      # shellcheck disable=SC2016 # Expected workflow expression is a literal.
      require_exact_line "${checkout_with}" '          ref: ${{ github.sha }}' || return 1
    elif [[ "${ref_count}" != "0" ]]; then
      violation "${job} checkout must not override its event revision"
      return 1
    fi

    local fetch_depth_count
    fetch_depth_count="$(awk '/fetch-depth[[:space:]]*:/ { count++ } END { print count + 0 }' "${checkout_step}")"
    if [[ "${job}" == "classify" || "${job}" == "release_security" ]]; then
      [[ "${fetch_depth_count}" == "1" ]] || {
        violation "${job} checkout must define fetch-depth exactly once"
        return 1
      }
      require_exact_line "${checkout_with}" "          fetch-depth: 0" || return 1
    elif [[ "${job}" == "quality" ]]; then
      [[ "${fetch_depth_count}" == "1" ]] || {
        violation "quality checkout must define fetch-depth exactly once"
        return 1
      }
      # shellcheck disable=SC2016 # Expected workflow expression is a literal.
      require_exact_line "${checkout_with}" \
        "          fetch-depth: \${{ needs.classify.outputs.change_profile == 'full' && '0' || '1' }}" || return 1
    elif [[ "${fetch_depth_count}" != "0" ]]; then
      violation "only the history-owning quality, classifier, and release-security checkouts may override fetch-depth"
      return 1
    fi
  done
}

validate_full_job_fallback() {
  local file="$1"
  local job="$2"
  local job_file="${test_root}/${job}.job"
  local if_file="${test_root}/${job}-if.block"

  extract_job "${file}" "${job}" >"${job_file}" || {
    violation "${job} job must exist exactly once"
    return 1
  }
  require_exact_line "${job_file}" "    needs: [reuse_pr_ci, classify]" || return 1
  extract_job_if "${job_file}" >"${if_file}" || {
    violation "${job} must define one fallback condition"
    return 1
  }
  case "${job}" in
    quality)
      require_nonblank_lines "${if_file}" \
        "    if: >-" \
        "      always() &&" \
        "      needs.classify.result == 'success' &&" \
        "      (github.event_name == 'pull_request' ||" \
        "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true')"
      ;;
    workflow | infrastructure)
      require_nonblank_lines "${if_file}" \
        "    if: >-" \
        "      always() &&" \
        "      needs.classify.result == 'success' &&" \
        "      (github.event_name == 'pull_request' ||" \
        "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true') &&" \
        "      needs.classify.outputs.change_profile == 'full'"
      ;;
    frontend)
      require_nonblank_lines "${if_file}" \
        "    if: >-" \
        "      always() &&" \
        "      needs.classify.result == 'success' &&" \
        "      (github.event_name == 'pull_request' ||" \
        "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true') &&" \
        "      (needs.classify.outputs.change_profile == 'frontend' ||" \
        "      needs.classify.outputs.change_profile == 'application' ||" \
        "      needs.classify.outputs.change_profile == 'full')"
      ;;
    backend)
      require_nonblank_lines "${if_file}" \
        "    if: >-" \
        "      always() &&" \
        "      needs.classify.result == 'success' &&" \
        "      (github.event_name == 'pull_request' ||" \
        "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true') &&" \
        "      (needs.classify.outputs.change_profile == 'backend' ||" \
        "      needs.classify.outputs.change_profile == 'application' ||" \
        "      needs.classify.outputs.change_profile == 'full')"
      ;;
    e2e)
      require_nonblank_lines "${if_file}" \
        "    if: >-" \
        "      always() &&" \
        "      needs.classify.result == 'success' &&" \
        "      (github.event_name == 'pull_request' ||" \
        "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true') &&" \
        "      needs.classify.outputs.change_profile != 'docs'"
      ;;
    *)
      violation "unknown scoped CI job: ${job}"
      return 1
      ;;
  esac
}

validate_job_structure() {
  local file="$1"
  local job
  local job_file
  local fields_file
  local services_file
  local env_file
  local defaults_file

  for job in reuse_pr_ci release_security classify workflow quality frontend backend infrastructure e2e required_pr_ci attest_pr_ci; do
    job_file="${test_root}/${job}-structure.job"
    fields_file="${test_root}/${job}-fields.block"
    extract_job "${file}" "${job}" >"${job_file}" || {
      violation "${job} job must exist exactly once for structural validation"
      return 1
    }
    awk '/^    [[:alnum:]_-]+:/ { print }' "${job_file}" >"${fields_file}"
    case "${job}" in
      reuse_pr_ci)
        require_nonblank_lines "${fields_file}" \
          "    name: Reuse verified PR CI" \
          "    if: github.event_name == 'push'" \
          "    permissions:" \
          "    runs-on: ubuntu-latest" \
          "    outputs:" \
          "    steps:" || return 1
        ;;
      release_security)
        require_nonblank_lines "${fields_file}" \
          "    name: Release security" \
          "    if: github.event_name == 'push'" \
          "    runs-on: ubuntu-latest" \
          "    timeout-minutes: 30" \
          "    steps:" || return 1
        ;;
      classify)
        require_nonblank_lines "${fields_file}" \
          "    name: Classify candidate changes" \
          "    needs: reuse_pr_ci" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    outputs:" \
          "    steps:" || return 1
        ;;
      workflow)
        require_nonblank_lines "${fields_file}" \
          "    needs: [reuse_pr_ci, classify]" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    steps:" || return 1
        ;;
      quality)
        require_nonblank_lines "${fields_file}" \
          "    name: Security, configuration, and documentation" \
          "    needs: [reuse_pr_ci, classify]" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    timeout-minutes: 30" \
          "    steps:" || return 1
        ;;
      frontend | infrastructure)
        require_nonblank_lines "${fields_file}" \
          "    needs: [reuse_pr_ci, classify]" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    steps:" || return 1
        ;;
      backend)
        require_nonblank_lines "${fields_file}" \
          "    needs: [reuse_pr_ci, classify]" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    services:" \
          "    env:" \
          "    defaults:" \
          "    steps:" || return 1
        ;;
      e2e)
        require_nonblank_lines "${fields_file}" \
          "    needs: [reuse_pr_ci, classify]" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    services:" \
          "    steps:" || return 1
        ;;
      required_pr_ci)
        require_nonblank_lines "${fields_file}" \
          "    name: Required PR CI" \
          "    needs:" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    outputs:" \
          "    steps:" || return 1
        ;;
      attest_pr_ci)
        require_nonblank_lines "${fields_file}" \
          "    name: Attest tested PR tree" \
          "    needs: [reuse_pr_ci, classify, required_pr_ci]" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    steps:" || return 1
        ;;
    esac
  done

  for job in backend e2e; do
    job_file="${test_root}/${job}-structure.job"
    services_file="${test_root}/${job}-services.block"
    extract_job_mapping "${job_file}" services >"${services_file}" || {
      violation "${job} must define exactly one PostgreSQL service mapping"
      return 1
    }
    require_nonblank_lines "${services_file}" \
      "      postgres:" \
      "        image: postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2" \
      "        env:" \
      "          POSTGRES_USER: fukamu_cycle" \
      "          POSTGRES_PASSWORD: fukamu_cycle" \
      "          POSTGRES_DB: fukamu_cycle_test" \
      "        ports:" \
      "          - 5432:5432" \
      "        options: >-" \
      "          --health-cmd \"pg_isready -U fukamu_cycle -d fukamu_cycle_test\"" \
      "          --health-interval 5s" \
      "          --health-timeout 5s" \
      "          --health-retries 10" || return 1
  done

  job_file="${test_root}/backend-structure.job"
  env_file="${test_root}/backend-env.block"
  extract_job_mapping "${job_file}" env >"${env_file}" || {
    violation "backend must define exactly one job environment mapping"
    return 1
  }
  require_nonblank_lines "${env_file}" \
    "      TEST_DATABASE_URL: postgres://fukamu_cycle:fukamu_cycle@localhost:5432/fukamu_cycle_test?sslmode=disable" || return 1
  defaults_file="${test_root}/backend-defaults.block"
  extract_job_mapping "${job_file}" defaults >"${defaults_file}" || {
    violation "backend must define exactly one defaults mapping"
    return 1
  }
  require_nonblank_lines "${defaults_file}" \
    "      run:" \
    "        working-directory: backend" || return 1

  local step_shells="${test_root}/ci-step-shells.block"
  awk '/^      - shell:|^        shell:/ { print }' "${file}" >"${step_shells}"
  require_nonblank_lines "${step_shells}" \
    "        shell: bash" \
    "        shell: bash" \
    "        shell: bash" \
    "        shell: bash" \
    "        shell: bash" || return 1
}

validate_exact_functional_steps() {
  local file="$1"
  local job
  local job_file
  local steps_file
  for job in release_security workflow frontend backend infrastructure e2e; do
    job_file="${test_root}/${job}-exact-steps.job"
    steps_file="${test_root}/${job}-exact-steps.block"
    extract_job "${file}" "${job}" >"${job_file}" || {
      violation "${job} job must exist exactly once for step validation"
      return 1
    }
    extract_job_mapping "${job_file}" steps >"${steps_file}" || {
      violation "${job} must define exactly one steps mapping"
      return 1
    }
    case "${job}" in
      release_security)
        require_nonblank_lines "${steps_file}" \
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
          "        with:" \
          "          fetch-depth: 0" \
          "          persist-credentials: false" \
          "      - name: Run full security gates for the exact main commit" \
          "        run: bash ./scripts/check-security.sh --profile full" || return 1
        ;;
      workflow)
        require_nonblank_lines "${steps_file}" \
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
          "        with:" \
          "          persist-credentials: false" \
          "      - name: Test CI reuse resolver" \
          "        run: bash .github/scripts/resolve-ci-reuse.test.sh" \
          "      - name: Validate GitHub Actions workflows" \
          "        uses: docker://rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 # v1.7.12" \
          "        with:" \
          "          args: -color" || return 1
        ;;
      frontend)
        # shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
        require_nonblank_lines "${steps_file}" \
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
          "        with:" \
          "          persist-credentials: false" \
          "      - uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0" \
          "        with:" \
          "          runtime: node@24" \
          "          cache: true" \
          "          install: false" \
          "      - run: pnpm install --frozen-lockfile --ignore-scripts" \
          "      - name: Verify dependency install preserved candidate tree" \
          "        run: |" \
          "          set -euo pipefail" \
          "          git diff --quiet --" \
          "          git diff --cached --quiet --" \
          '          untracked_files="$(git ls-files --others --exclude-standard)"' \
          '          [[ -z "${untracked_files}" ]]' \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run format:check" \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run lint" \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run typecheck" \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match test" \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build" || return 1
        ;;
      backend)
        # shellcheck disable=SC2016 # Expected workflow command is a literal.
        require_nonblank_lines "${steps_file}" \
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
          "        with:" \
          "          persist-credentials: false" \
          "      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0" \
          "        with:" \
          '          go-version: "1.27.0"' \
          "          cache-dependency-path: backend/go.sum" \
          "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1" \
          "      - run: sqlc compile" \
          "      - run: sqlc generate" \
          "      - run: git diff --exit-code" \
          '      - run: test -z "$(git ls-files --others --exclude-standard -- internal/infrastructure/postgres/generated)"' \
          '      - run: test -z "$(gofmt -l .)"' \
          "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go vet ./..." \
          "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go test ./..." \
          "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/server" \
          "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/migrate" \
          "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/cleanup" \
          "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/configcheck" || return 1
        ;;
      infrastructure)
        # shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
        require_nonblank_lines "${steps_file}" \
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
          "        with:" \
          "          persist-credentials: false" \
          "      - uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0" \
          "        with:" \
          "          runtime: node@24" \
          "          cache: true" \
          "          install: false" \
          "      - run: pnpm install --frozen-lockfile --ignore-scripts" \
          "      - name: Verify dependency install preserved candidate tree" \
          "        run: |" \
          "          set -euo pipefail" \
          "          git diff --quiet --" \
          "          git diff --cached --quiet --" \
          '          untracked_files="$(git ls-files --others --exclude-standard)"' \
          '          [[ -z "${untracked_files}" ]]' \
          "      - run: docker compose --file compose.local.yaml config --quiet" \
          "      - name: Audit Docker build contexts" \
          "        run: bash ./scripts/check-docker-context.sh" \
          "      - uses: hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1" \
          "        with:" \
          "          terraform_version: 1.15.8" \
          "      - run: terraform fmt -check -recursive ." \
          "        working-directory: infra/terraform/staging" \
          "      - run: terraform init -backend=false -input=false" \
          "        working-directory: infra/terraform/staging" \
          "      - run: terraform validate" \
          "        working-directory: infra/terraform/staging" \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build" \
          "      - run: pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match run check" \
          "      - run: pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match run deploy:dry-run" || return 1
        ;;
      e2e)
        # shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
        require_nonblank_lines "${steps_file}" \
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
          "        with:" \
          "          persist-credentials: false" \
          "      - uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0" \
          "        with:" \
          "          runtime: node@24" \
          "          cache: true" \
          "          install: false" \
          "      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0" \
          "        with:" \
          '          go-version: "1.27.0"' \
          "          cache-dependency-path: backend/go.sum" \
          "      - run: pnpm install --frozen-lockfile --ignore-scripts" \
          "      - name: Verify dependency install preserved candidate tree" \
          "        run: |" \
          "          set -euo pipefail" \
          "          git diff --quiet --" \
          "          git diff --cached --quiet --" \
          '          untracked_files="$(git ls-files --others --exclude-standard)"' \
          '          [[ -z "${untracked_files}" ]]' \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match exec playwright install --with-deps chromium" \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build" \
          "        env:" \
          "          VITE_GOOGLE_WEB_CLIENT_ID: fukamu-cycle-e2e-client" \
          "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run test:e2e" \
          "        env:" \
          "          TEST_DATABASE_URL: postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:5432/fukamu_cycle_test?sslmode=disable" || return 1
        ;;
    esac
  done
}

validate_exact_control_steps() {
  local file="$1"
  local reuse_job="${test_root}/control-reuse.job"
  local reuse_steps="${test_root}/control-reuse-steps.block"
  local classify_job="${test_root}/control-classify.job"
  local classify_steps="${test_root}/control-classify-steps.block"
  local required_job="${test_root}/control-required.job"
  local required_steps="${test_root}/control-required-steps.block"
  local attest_job="${test_root}/control-attest.job"
  local attest_steps="${test_root}/control-attest-steps.block"
  local expected_reuse_steps
  local expected_classify_steps
  local expected_required_steps
  local expected_attest_steps

  extract_job "${file}" reuse_pr_ci >"${reuse_job}" || {
    violation "reuse_pr_ci must exist exactly once for control-step validation"
    return 1
  }
  extract_job_mapping "${reuse_job}" steps >"${reuse_steps}" || {
    violation "reuse_pr_ci must define exactly one steps mapping"
    return 1
  }
  expected_reuse_steps="$(
    cat <<'EOF'
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Resolve reusable PR CI attestation
        id: resolve
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: bash .github/scripts/resolve-ci-reuse.sh "${GITHUB_SHA}" "${GITHUB_REPOSITORY}" "${GITHUB_OUTPUT}"
      - name: Publish reuse decision
        shell: bash
        env:
          REUSE_PR_CI: ${{ steps.resolve.outputs.reuse_pr_ci }}
          SOURCE_PR_NUMBER: ${{ steps.resolve.outputs.source_pr_number }}
          SOURCE_RUN_ID: ${{ steps.resolve.outputs.source_run_id }}
          TESTED_TREE: ${{ steps.resolve.outputs.tested_tree }}
        run: |
          if [[ "${REUSE_PR_CI}" == "true" ]]; then
            {
              echo '## Reused verified pull request CI'
              echo
              echo "- Pull request: #${SOURCE_PR_NUMBER}"
              echo "- CI run: ${SOURCE_RUN_ID}"
              echo "- Exact tested tree: \`${TESTED_TREE}\`"
            } >> "${GITHUB_STEP_SUMMARY}"
          else
            echo 'PR CI could not be safely reused; the full CI suite will run.' >> "${GITHUB_STEP_SUMMARY}"
          fi
EOF
  )"
  require_nonblank_block "${reuse_steps}" "${expected_reuse_steps}" || return 1

  extract_job "${file}" classify >"${classify_job}" || {
    violation "classify must exist exactly once for control-step validation"
    return 1
  }
  extract_job_mapping "${classify_job}" steps >"${classify_steps}" || {
    violation "classify must define exactly one steps mapping"
    return 1
  }
  expected_classify_steps="$(
    cat <<'EOF'
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Resolve conservative change profile
        id: classify
        shell: bash
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.sha }}
        run: |
          set -euo pipefail
          if [[ "${GITHUB_EVENT_NAME}" == "push" ]]; then
            {
              echo 'change_profile=full'
              echo 'change_reason=main_reuse_fallback'
            } >> "${GITHUB_OUTPUT}"
          else
            bash ./scripts/check-control-plane-fixtures.sh \
              --classify-only --range "${BASE_SHA}" "${HEAD_SHA}" >> "${GITHUB_OUTPUT}"
          fi
EOF
  )"
  require_nonblank_block "${classify_steps}" "${expected_classify_steps}" || return 1

  extract_job "${file}" required_pr_ci >"${required_job}" || {
    violation "required_pr_ci must exist exactly once for control-step validation"
    return 1
  }
  extract_job_mapping "${required_job}" steps >"${required_steps}" || {
    violation "required_pr_ci must define exactly one steps mapping"
    return 1
  }
  expected_required_steps="$(
    cat <<'EOF'
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.sha }}
          persist-credentials: false
      - uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0
        with:
          runtime: node@24
          install: false
      - name: Verify exact required job matrix
        id: verify
        shell: bash
        env:
          CHANGE_PROFILE: ${{ needs.classify.outputs.change_profile }}
          REUSE_RESULT: ${{ needs.reuse_pr_ci.result }}
          CLASSIFY_RESULT: ${{ needs.classify.result }}
          WORKFLOW_RESULT: ${{ needs.workflow.result }}
          QUALITY_RESULT: ${{ needs.quality.result }}
          FRONTEND_RESULT: ${{ needs.frontend.result }}
          BACKEND_RESULT: ${{ needs.backend.result }}
          INFRASTRUCTURE_RESULT: ${{ needs.infrastructure.result }}
          E2E_RESULT: ${{ needs.e2e.result }}
        run: |
          node ./scripts/verify-ci-change-profile.mjs \
            "${CHANGE_PROFILE}" \
            "reuse_pr_ci=${REUSE_RESULT}" \
            "classify=${CLASSIFY_RESULT}" \
            "workflow=${WORKFLOW_RESULT}" \
            "quality=${QUALITY_RESULT}" \
            "frontend=${FRONTEND_RESULT}" \
            "backend=${BACKEND_RESULT}" \
            "infrastructure=${INFRASTRUCTURE_RESULT}" \
            "e2e=${E2E_RESULT}" >> "${GITHUB_OUTPUT}"
EOF
  )"
  require_nonblank_block "${required_steps}" "${expected_required_steps}" || return 1

  extract_job "${file}" attest_pr_ci >"${attest_job}" || {
    violation "attest_pr_ci must exist exactly once for control-step validation"
    return 1
  }
  extract_job_mapping "${attest_job}" steps >"${attest_steps}" || {
    violation "attest_pr_ci must define exactly one steps mapping"
    return 1
  }
  expected_attest_steps="$(
    cat <<'EOF'
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.sha }}
          persist-credentials: false
      - name: Write tested tree attestation
        id: metadata
        shell: bash
        env:
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          CHANGE_PROFILE: ${{ needs.classify.outputs.change_profile }}
          REQUIRED_JOBS: ${{ needs.required_pr_ci.outputs.required_jobs }}
        run: |
          set -euo pipefail
          tested_tree="$(git rev-parse 'HEAD^{tree}')"
          artifact_name="pr-ci-${PR_NUMBER}-${HEAD_SHA}-${tested_tree}"
          mkdir -p "${RUNNER_TEMP}/fukamu-cycle-pr-ci-attestation"
          {
            echo "pull_request=${PR_NUMBER}"
            echo "head_sha=${HEAD_SHA}"
            echo "tested_commit=${GITHUB_SHA}"
            echo "tested_tree=${tested_tree}"
            echo "workflow_run=${GITHUB_RUN_ID}"
            echo "change_profile=${CHANGE_PROFILE}"
            echo "required_jobs=${REQUIRED_JOBS}"
          } > "${RUNNER_TEMP}/fukamu-cycle-pr-ci-attestation/attestation.txt"
          echo "artifact_name=${artifact_name}" >> "${GITHUB_OUTPUT}"
      - name: Upload tested tree attestation
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: ${{ steps.metadata.outputs.artifact_name }}
          path: ${{ runner.temp }}/fukamu-cycle-pr-ci-attestation/attestation.txt
          if-no-files-found: error
          retention-days: 30
EOF
  )"
  require_nonblank_block "${attest_steps}" "${expected_attest_steps}" || return 1
}

validate_workflow_permissions_contract() {
  local directory="$1"
  local filename
  local permissions_file
  local workflow_file
  local expected_permission_count
  while IFS= read -r filename; do
    workflow_file="${directory}/${filename}"
    permissions_file="${test_root}/${filename}-permissions.block"
    extract_root_mapping "${workflow_file}" permissions >"${permissions_file}" || {
      violation "${filename} must define exactly one top-level permissions mapping"
      return 1
    }
    expected_permission_count=1
    case "${filename}" in
      ci.yml)
        require_nonblank_lines "${permissions_file}" "  contents: read" || return 1
        expected_permission_count=2
        ;;
      terraform-apply.yml)
        require_nonblank_lines "${permissions_file}" \
          "  actions: write" \
          "  contents: read" || return 1
        ;;
      deploy.yml | retire-legacy-origin.yml | terraform-plan.yml)
        require_nonblank_lines "${permissions_file}" \
          "  actions: read" \
          "  contents: read" || return 1
        ;;
      security-audit.yml)
        require_nonblank_lines "${permissions_file}" "  contents: read" || return 1
        expected_permission_count=2
        ;;
      *)
        require_nonblank_lines "${permissions_file}" "  contents: read" || return 1
        ;;
    esac
    if [[ "$(awk '/^[[:space:]]*permissions:/ { count++ } END { print count + 0 }' "${workflow_file}")" != "${expected_permission_count}" ]]; then
      violation "${filename} has an unapproved job-level permissions mapping"
      return 1
    fi
  done < <(
    find "${directory}" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -printf '%f\n' \
      | LC_ALL=C sort
  )
}

validate_required_ci_commands() {
  local file="$1"
  local job
  local invariant
  local job_file

  while IFS='|' read -r job invariant; do
    job_file="${test_root}/${job}-required-commands.job"
    extract_job "${file}" "${job}" >"${job_file}" || return 1
    require_exact_line "${job_file}" "${invariant}" || return 1
  done <<'REQUIRED_CI_COMMANDS'
release_security|        run: bash ./scripts/check-security.sh --profile full
classify|          BASE_SHA: ${{ github.event.pull_request.base.sha }}
classify|          HEAD_SHA: ${{ github.sha }}
classify|              echo 'change_profile=full'
classify|              --classify-only --range "${BASE_SHA}" "${HEAD_SHA}" >> "${GITHUB_OUTPUT}"
workflow|        run: bash .github/scripts/resolve-ci-reuse.test.sh
quality|      - run: pnpm install --frozen-lockfile --ignore-scripts
quality|          git diff --cached --quiet --
quality|          CONTROL_PLANE_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}
quality|          CONTROL_PLANE_HEAD_SHA: ${{ github.sha }}
quality|        run: bash .github/scripts/verify-security-audit-release-gate.test.sh
frontend|      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run format:check
frontend|      - run: pnpm install --frozen-lockfile --ignore-scripts
frontend|          git diff --cached --quiet --
frontend|      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run lint
frontend|      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run typecheck
frontend|      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match test
frontend|      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build
backend|      - run: sqlc compile
backend|      - run: sqlc generate
backend|      - run: git diff --exit-code
backend|      - run: test -z "$(git ls-files --others --exclude-standard -- internal/infrastructure/postgres/generated)"
backend|      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go vet ./...
backend|      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go test ./...
backend|      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/server
backend|      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/migrate
backend|      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/cleanup
backend|      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/configcheck
infrastructure|      - run: docker compose --file compose.local.yaml config --quiet
infrastructure|      - run: pnpm install --frozen-lockfile --ignore-scripts
infrastructure|          git diff --cached --quiet --
infrastructure|        run: bash ./scripts/check-docker-context.sh
infrastructure|      - run: terraform fmt -check -recursive .
infrastructure|      - run: terraform init -backend=false -input=false
infrastructure|      - run: terraform validate
infrastructure|      - run: pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match run check
infrastructure|      - run: pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match run deploy:dry-run
e2e|      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match exec playwright install --with-deps chromium
e2e|      - run: pnpm install --frozen-lockfile --ignore-scripts
e2e|          git diff --cached --quiet --
e2e|      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build
e2e|      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run test:e2e
attest_pr_ci|          tested_tree="$(git rev-parse 'HEAD^{tree}')"
attest_pr_ci|          artifact_name="pr-ci-${PR_NUMBER}-${HEAD_SHA}-${tested_tree}"
attest_pr_ci|        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
attest_pr_ci|          if-no-files-found: error
REQUIRED_CI_COMMANDS
}

validate_workflow() {
  local file="$1"
  local on_block="${test_root}/on.block"
  local permissions_block="${test_root}/permissions.block"
  local reuse_job="${test_root}/reuse.job"
  local reuse_permissions="${test_root}/reuse-permissions.block"
  local reuse_outputs="${test_root}/reuse-outputs.block"
  local reuse_resolver_step="${test_root}/reuse-resolver.step"
  local classify_job="${test_root}/classify.job"
  local classify_if="${test_root}/classify-if.block"
  local classify_outputs="${test_root}/classify-outputs.block"
  local required_job="${test_root}/required.job"
  local required_if="${test_root}/required-if.block"
  local required_outputs="${test_root}/required-outputs.block"
  local required_verify_step="${test_root}/required-verify.step"
  local required_verify_script="${test_root}/required-verify.sh"
  local workflow_job="${test_root}/workflow.job"
  local quality_job="${test_root}/quality.job"
  local quality_steps="${test_root}/quality-steps.block"
  local backend_job="${test_root}/backend.job"
  local e2e_job="${test_root}/e2e.job"
  local e2e_if="${test_root}/e2e-if.block"
  local attestation_job="${test_root}/attestation.job"
  local attestation_if="${test_root}/attestation-if.block"

  [[ -f "${file}" ]] || {
    violation "workflow file does not exist: ${file}"
    return 1
  }
  validate_workflow_source_guards "${file}" || return 1
  validate_exact_workflow_structure "${file}" ci || return 1
  if grep -Eq '^(defaults|env)[[:space:]]*:' "${file}"; then
    violation "CI must not define top-level defaults or environment variables"
    return 1
  fi
  if grep -Eq '(^|[^[:alnum:]_])BASH_ENV([^[:alnum:]_]|$)' "${file}"; then
    violation "CI must not define BASH_ENV at any scope"
    return 1
  fi
  local step_if_count
  local approved_step_if_count
  step_if_count="$(grep -Ec '^(      - if:|        if:)' "${file}" || true)"
  approved_step_if_count="$(grep -Fxc -- "        if: github.event_name == 'pull_request'" "${file}" || true)"
  if [[ "${step_if_count}" != "1" || "${approved_step_if_count}" != "1" ]]; then
    violation "only the exact pull-request security selection step may be conditionally skipped"
    return 1
  fi
  if grep -Eq "^[[:space:]]+(-[[:space:]]+)?[\"']?continue-on-error[\"']?[[:space:]]*:" "${file}"; then
    violation "CI jobs and steps must not suppress failures with continue-on-error"
    return 1
  fi

  extract_root_mapping "${file}" on >"${on_block}" || {
    violation "the workflow must define one top-level on mapping"
    return 1
  }
  require_nonblank_lines "${on_block}" \
    "  pull_request:" \
    "  push:" \
    "    branches: [main]" || return 1

  extract_root_mapping "${file}" permissions >"${permissions_block}" || {
    violation "the workflow must define one top-level permissions mapping"
    return 1
  }
  require_nonblank_lines "${permissions_block}" "  contents: read" || return 1
  [[ "$(awk '/^[[:space:]]*permissions:/ { count++ } END { print count + 0 }' "${file}")" == "2" ]] || {
    violation "only top-level and reuse_pr_ci permissions mappings are allowed"
    return 1
  }

  extract_job "${file}" reuse_pr_ci >"${reuse_job}" || {
    violation "reuse_pr_ci job must exist exactly once"
    return 1
  }
  require_exact_line "${reuse_job}" "    if: github.event_name == 'push'" || return 1
  extract_job_mapping "${reuse_job}" permissions >"${reuse_permissions}" || {
    violation "reuse_pr_ci must define one permissions mapping"
    return 1
  }
  require_nonblank_lines "${reuse_permissions}" \
    "      actions: read" \
    "      contents: read" \
    "      pull-requests: read" || return 1

  extract_job_mapping "${reuse_job}" outputs >"${reuse_outputs}" || {
    violation "reuse_pr_ci must define one outputs mapping"
    return 1
  }
  # These GitHub expression literals must remain unexpanded while validating YAML.
  # shellcheck disable=SC2016
  require_nonblank_lines "${reuse_outputs}" \
    '      reuse_pr_ci: ${{ steps.resolve.outputs.reuse_pr_ci }}' \
    '      source_pr_number: ${{ steps.resolve.outputs.source_pr_number }}' \
    '      source_run_id: ${{ steps.resolve.outputs.source_run_id }}' \
    '      tested_tree: ${{ steps.resolve.outputs.tested_tree }}' || return 1
  extract_named_step "${reuse_job}" "Resolve reusable PR CI attestation" >"${reuse_resolver_step}" || {
    violation "reuse_pr_ci must contain exactly one canonical resolver step"
    return 1
  }
  # These workflow/runtime expression literals must remain unexpanded.
  # shellcheck disable=SC2016
  require_nonblank_lines "${reuse_resolver_step}" \
    "      - name: Resolve reusable PR CI attestation" \
    "        id: resolve" \
    "        shell: bash" \
    "        env:" \
    '          GH_TOKEN: ${{ github.token }}' \
    '        run: bash .github/scripts/resolve-ci-reuse.sh "${GITHUB_SHA}" "${GITHUB_REPOSITORY}" "${GITHUB_OUTPUT}"' || return 1
  require_exact_line "${reuse_job}" "        id: resolve" || return 1

  extract_job "${file}" classify >"${classify_job}" || {
    violation "classify job must exist exactly once"
    return 1
  }
  require_exact_line "${classify_job}" "    needs: reuse_pr_ci" || return 1
  extract_job_if "${classify_job}" >"${classify_if}" || {
    violation "classify must define one fallback condition"
    return 1
  }
  require_nonblank_lines "${classify_if}" \
    "    if: >-" \
    "      always() &&" \
    "      (github.event_name == 'pull_request' ||" \
    "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true')" || return 1
  extract_job_mapping "${classify_job}" outputs >"${classify_outputs}" || {
    violation "classify must define one outputs mapping"
    return 1
  }
  # shellcheck disable=SC2016 # Expected workflow expressions are literals.
  require_nonblank_lines "${classify_outputs}" \
    '      change_profile: ${{ steps.classify.outputs.change_profile }}' \
    '      change_reason: ${{ steps.classify.outputs.change_reason }}' || return 1

  extract_job "${file}" required_pr_ci >"${required_job}" || {
    violation "required_pr_ci job must exist exactly once"
    return 1
  }
  require_exact_line "${required_job}" "    needs:" || return 1
  require_exact_line "${required_job}" \
    "      [reuse_pr_ci, classify, workflow, quality, frontend, backend, infrastructure, e2e]" || return 1
  extract_job_if "${required_job}" >"${required_if}" || {
    violation "required_pr_ci must define one PR condition"
    return 1
  }
  require_nonblank_lines "${required_if}" \
    "    if: >-" \
    "      always() &&" \
    "      github.event_name == 'pull_request'" || return 1
  extract_job_mapping "${required_job}" outputs >"${required_outputs}" || {
    violation "required_pr_ci must define one outputs mapping"
    return 1
  }
  # shellcheck disable=SC2016 # Expected workflow expression is literal.
  require_nonblank_lines "${required_outputs}" \
    '      required_jobs: ${{ steps.verify.outputs.required_jobs }}' || return 1
  extract_named_step "${required_job}" "Verify exact required job matrix" >"${required_verify_step}" || {
    violation "required_pr_ci must run the required-job matrix verifier"
    return 1
  }
  extract_literal_run_script "${required_verify_step}" >"${required_verify_script}" || return 1
  if ! grep -Eq '^node[[:space:]]+\./scripts/verify-ci-change-profile[.]mjs[[:space:]]+\\$' "${required_verify_script}"; then
    violation "required_pr_ci must execute the required-job matrix verifier"
    return 1
  fi
  local required_verifier_argument
  for required_verifier_argument in \
    CHANGE_PROFILE \
    REUSE_RESULT \
    CLASSIFY_RESULT \
    WORKFLOW_RESULT \
    QUALITY_RESULT \
    FRONTEND_RESULT \
    BACKEND_RESULT \
    INFRASTRUCTURE_RESULT \
    E2E_RESULT \
    GITHUB_OUTPUT; do
    grep -Fq -- "\${${required_verifier_argument}}" "${required_verify_script}" || {
      violation "required_pr_ci verifier is missing ${required_verifier_argument}"
      return 1
    }
  done
  if grep -Eq '\|\||(^|[[:space:]])continue([[:space:]]|$)' "${required_verify_script}"; then
    violation "required_pr_ci verifier must fail closed"
    return 1
  fi

  validate_checkout_steps "${file}" || return 1
  validate_required_ci_commands "${file}" || return 1

  local full_job
  for full_job in workflow quality frontend backend infrastructure; do
    validate_full_job_fallback "${file}" "${full_job}" || return 1
  done

  extract_job "${file}" workflow >"${workflow_job}" || {
    violation "workflow job must exist exactly once"
    return 1
  }
  [[ "$(awk '/uses:[[:space:]]*docker:\/\/rhysd\/actionlint:/ { count++ } END { print count + 0 }' "${file}")" == "1" ]] || {
    violation "CI must invoke exactly one canonical actionlint consumer"
    return 1
  }
  require_exact_line "${workflow_job}" \
    "        run: bash .github/scripts/resolve-ci-reuse.test.sh" || return 1
  require_exact_line "${workflow_job}" \
    "        uses: docker://rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 # v1.7.12" || return 1

  extract_job "${file}" quality >"${quality_job}" || {
    violation "quality job must exist exactly once"
    return 1
  }
  if grep -Eq '^    (defaults|env|container|services|strategy)[[:space:]]*:' "${quality_job}"; then
    violation "quality must not define defaults, env, container, services, or strategy"
    return 1
  fi
  if [[ "$(grep -Ec "^(      - |        )[\"']?if[\"']?[[:space:]]*:" "${quality_job}" || true)" != "1" ||
  "$(grep -Fxc -- "        if: github.event_name == 'pull_request'" "${quality_job}" || true)" != "1" ]]; then
    violation "quality may skip only its PR security selector on main, where release_security owns the full gate"
    return 1
  fi
  if grep -Eq "^(      - |        )[\"']?shell[\"']?[[:space:]]*:" "${quality_job}"; then
    violation "quality commands must use the GitHub runner's standard fail-fast shell"
    return 1
  fi
  extract_job_mapping "${quality_job}" steps >"${quality_steps}" || {
    violation "quality must define exactly one steps mapping"
    return 1
  }
  # The gate owns required behavior and ordering boundaries, not presentation-only
  # names or a closed inventory of otherwise harmless setup steps.
  for invariant in \
    "        if: github.event_name == 'pull_request'" \
    "          SECURITY_PROFILE: \${{ needs.classify.outputs.change_profile == 'full' && 'full' || 'candidate' }}" \
    '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
    "      - run: pnpm install --frozen-lockfile --ignore-scripts" \
    "          git diff --quiet --" \
    "          git diff --cached --quiet --" \
    '          untracked_files="$(git ls-files --others --exclude-standard)"' \
    '          [[ -z "${untracked_files}" ]]' \
    "        run: bash ./scripts/check-shell.sh" \
    '        run: bash ./scripts/check-control-plane-fixtures.sh --range "${CONTROL_PLANE_BASE_SHA}" "${CONTROL_PLANE_HEAD_SHA}"' \
    "        run: bash ./scripts/check-docs.sh" \
    "        run: bash ./scripts/check-config-parity.sh"; do
    require_exact_line "${quality_steps}" "${invariant}" || return 1
  done
  local quality_security_line
  local quality_install_line
  local quality_tree_guard_line
  quality_security_line="$(grep -nFx -- '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' "${quality_steps}" | cut -d: -f1)"
  quality_install_line="$(grep -nFx -- "      - run: pnpm install --frozen-lockfile --ignore-scripts" "${quality_steps}" | cut -d: -f1)"
  quality_tree_guard_line="$(grep -nFx -- "          git diff --cached --quiet --" "${quality_steps}" | cut -d: -f1)"
  [[ "${quality_security_line}" =~ ^[0-9]+$ && "${quality_install_line}" =~ ^[0-9]+$ &&
    "${quality_tree_guard_line}" =~ ^[0-9]+$ &&
    "${quality_security_line}" -lt "${quality_install_line}" &&
    "${quality_install_line}" -lt "${quality_tree_guard_line}" ]] || {
    violation "quality security, dependency install, and tree verification order is invalid"
    return 1
  }

  extract_job "${file}" backend >"${backend_job}" || {
    violation "backend job must exist exactly once"
    return 1
  }
  require_exact_line "${backend_job}" \
    "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/cleanup" || return 1

  extract_job "${file}" e2e >"${e2e_job}" || {
    violation "e2e job must exist exactly once"
    return 1
  }
  require_exact_line "${e2e_job}" "    needs: [reuse_pr_ci, classify]" || return 1
  extract_job_if "${e2e_job}" >"${e2e_if}" || {
    violation "e2e must define one dependency condition"
    return 1
  }
  require_nonblank_lines "${e2e_if}" \
    "    if: >-" \
    "      always() &&" \
    "      needs.classify.result == 'success' &&" \
    "      (github.event_name == 'pull_request' ||" \
    "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true') &&" \
    "      needs.classify.outputs.change_profile != 'docs'" || return 1

  extract_job "${file}" attest_pr_ci >"${attestation_job}" || {
    violation "attest_pr_ci job must exist exactly once"
    return 1
  }
  require_exact_line "${attestation_job}" \
    "    needs: [reuse_pr_ci, classify, required_pr_ci]" || return 1
  extract_job_if "${attestation_job}" >"${attestation_if}" || {
    violation "attest_pr_ci must define one dependency condition"
    return 1
  }
  require_nonblank_lines "${attestation_if}" \
    "    if: >-" \
    "      always() &&" \
    "      github.event_name == 'pull_request' &&" \
    "      needs.reuse_pr_ci.result == 'skipped' &&" \
    "      needs.classify.result == 'success' &&" \
    "      needs.required_pr_ci.result == 'success'" || return 1
}

replace_line_once() {
  local file="$1"
  local old="$2"
  local replacement="$3"
  local next="${file}.next"
  awk -v old="${old}" -v replacement="${replacement}" '
    $0 == old {
      matches++
      if (matches == 1) $0 = replacement
    }
    { print }
    END { if (matches == 0) exit 1 }
  ' "${file}" >"${next}" || fail "fixture mutation target was not found: ${old}"
  mv -- "${next}" "${file}"
}

replace_job_line() {
  local file="$1"
  local job="$2"
  local old="$3"
  local replacement="$4"
  local next="${file}.next"
  awk -v header="  ${job}:" -v old="${old}" -v replacement="${replacement}" '
    $0 == header {
      jobs++
      active = 1
    }
    active && $0 != header && /^  [[:alnum:]_-]+:$/ { active = 0 }
    active && $0 == old {
      matches++
      $0 = replacement
    }
    { print }
    END { if (jobs != 1 || matches != 1) exit 1 }
  ' "${file}" >"${next}" || fail "fixture mutation target was not unique in ${job}: ${old}"
  mv -- "${next}" "${file}"
}

replace_raw_line_once() {
  local file="$1"
  local old="$2"
  local replacement="$3"
  local next="${file}.next"
  OLD_LINE="${old}" REPLACEMENT_LINE="${replacement}" awk '
    BEGIN {
      old = ENVIRON["OLD_LINE"]
      replacement = ENVIRON["REPLACEMENT_LINE"]
    }
    $0 == old {
      matches++
      if (matches == 1) $0 = replacement
    }
    { print }
    END { if (matches == 0) exit 1 }
  ' "${file}" >"${next}" || fail "fixture raw mutation target was not found: ${old}"
  mv -- "${next}" "${file}"
}

remove_named_step() {
  local file="$1"
  local name="$2"
  local next="${file}.next"
  awk -v header="      - name: ${name}" '
    $0 == header {
      matches++
      removing = 1
      next
    }
    removing && /^      - / {
      removing = 0
    }
    !removing { print }
    END { if (matches != 1) exit 1 }
  ' "${file}" >"${next}" || fail "fixture step removal target was not unique: ${name}"
  mv -- "${next}" "${file}"
}

move_named_step_before() {
  local file="$1"
  local moving_name="$2"
  local target_name="$3"
  local next="${file}.next"
  awk \
    -v moving_header="      - name: ${moving_name}" \
    -v target_header="      - name: ${target_name}" '
    {
      lines[NR] = $0
      if ($0 == moving_header) {
        moving_count++
        moving_start = NR
      }
      if ($0 == target_header) {
        target_count++
        target_start = NR
      }
    }
    END {
      if (moving_count != 1 || target_count != 1 || target_start >= moving_start) {
        exit 1
      }
      moving_end = NR
      for (line = moving_start + 1; line <= NR; line++) {
        if (lines[line] ~ /^      - /) {
          moving_end = line - 1
          break
        }
      }
      for (line = 1; line < target_start; line++) print lines[line]
      for (line = moving_start; line <= moving_end; line++) print lines[line]
      for (line = target_start; line < moving_start; line++) print lines[line]
      for (line = moving_end + 1; line <= NR; line++) print lines[line]
    }
  ' "${file}" >"${next}" \
    || fail "fixture could not move ${moving_name} before ${target_name}"
  mv -- "${next}" "${file}"
}

new_fixture() {
  local name="$1"
  local fixture="${test_root}/${name}.yml"
  cp -- "${workflow}" "${fixture}"
  printf '%s\n' "${fixture}"
}

new_workflow_set_fixture() {
  local name="$1"
  local directory="${test_root}/workflow-set-${name}"
  mkdir -- "${directory}"
  local filename
  for filename in ci.yml deploy.yml playbook.yml retire-legacy-origin.yml security-audit.yml terraform-apply.yml terraform-plan.yml; do
    cp -- "${workflow_dir}/${filename}" "${directory}/${filename}"
  done
  printf '%s\n' "${directory}"
}

assert_invalid() {
  local description="$1"
  local fixture="$2"
  if validate_workflow "${fixture}" >"${test_root}/last-output" 2>&1; then
    fail "${description} fixture unexpectedly passed"
  fi
}

assert_invalid_workflow_set() {
  local description="$1"
  local directory="$2"
  if validate_all_workflows "${directory}" >"${test_root}/last-output" 2>&1; then
    fail "${description} workflow-set fixture unexpectedly passed"
  fi
}

assert_valid() {
  local description="$1"
  local fixture="$2"
  validate_workflow "${fixture}" >"${test_root}/last-output" 2>&1 \
    || fail "${description} fixture unexpectedly failed: $(cat "${test_root}/last-output")"
}

if (($# > 1)); then
  fail "Usage: ./scripts/tests/check-ci-security-model.sh [workflow-file]"
fi

validate_workflow "${workflow}" || fail "CI workflow does not satisfy the security model"
validate_all_workflows "${workflow_dir}" || fail "GitHub Actions workflows do not satisfy the shared security model"

fixture="$(new_fixture harmless-quality-step)"
replace_job_line "${fixture}" quality \
  "      - name: Validate Bash scripts" \
  $'      - name: Explain quality scope\n        run: echo quality checks are starting\n      - name: Validate Bash scripts'
assert_valid "harmless additional quality step" "${fixture}"

workflow_set="$(new_workflow_set_fixture missing-playbook-workflow)"
unlink -- "${workflow_set}/playbook.yml"
assert_invalid_workflow_set "missing Playbook policy workflow" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture unknown-workflow-write-permission)"
cat >"${workflow_set}/additional.yml" <<'UNKNOWN_WORKFLOW'
name: Additional checks
on:
  workflow_dispatch:
permissions:
  contents: write
jobs:
  explain:
    runs-on: ubuntu-latest
    steps:
      - run: echo additional check
UNKNOWN_WORKFLOW
assert_invalid_workflow_set "unknown workflow write permission" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture renamed-playbook-workflow)"
replace_line_once "${workflow_set}/playbook.yml" \
  "name: Playbook policy" \
  "name: Playbook policy renamed"
assert_invalid_workflow_set "renamed Playbook policy workflow" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture playbook-permission-escalation)"
replace_line_once "${workflow_set}/playbook.yml" \
  "  contents: read" \
  "  contents: write"
assert_invalid_workflow_set "Playbook workflow permission escalation" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture security-audit-scan-permission-escalation)"
replace_line_once "${workflow_set}/security-audit.yml" \
  "    timeout-minutes: 30" \
  $'    timeout-minutes: 30\n    permissions:\n      contents: write'
assert_invalid_workflow_set "Security audit scan permission escalation" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-security-audit-release-gate-bypass)"
# shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
replace_line_once "${workflow_set}/deploy.yml" \
  '        run: bash .github/scripts/verify-security-audit-release-gate.sh "${COMMIT_SHA}"' \
  "        run: true"
assert_invalid_workflow_set "Deploy security audit release gate bypass" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture playbook-self-hosted-runner)"
replace_line_once "${workflow_set}/playbook.yml" \
  "    runs-on: ubuntu-latest" \
  "    runs-on: self-hosted"
assert_invalid_workflow_set "Playbook workflow self-hosted runner" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture playbook-timeout-change)"
replace_line_once "${workflow_set}/playbook.yml" \
  "    timeout-minutes: 5" \
  "    timeout-minutes: 60"
assert_invalid_workflow_set "Playbook workflow timeout change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture playbook-validator-bypass)"
replace_line_once "${workflow_set}/playbook.yml" \
  "          python3 .fukamu/playbook/validate.py --consumer ." \
  "          true"
assert_invalid_workflow_set "Playbook vendored validator bypass" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture playbook-trace-bypass)"
replace_line_once "${workflow_set}/playbook.yml" \
  "          node scripts/validate-playbook-config.mjs ." \
  "          true"
assert_invalid_workflow_set "Playbook Cycle trace validator bypass" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture renamed-deploy-workflow)"
replace_line_once "${workflow_set}/deploy.yml" \
  "name: Deploy Staging" \
  "name: Deploy Staging Renamed"
assert_invalid_workflow_set "renamed deploy workflow" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture renamed-terraform-plan-workflow)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "name: Terraform Plan Staging" \
  "name: Terraform Plan Staging Renamed"
assert_invalid_workflow_set "renamed Terraform Plan workflow" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture renamed-terraform-apply-workflow)"
replace_line_once "${workflow_set}/terraform-apply.yml" \
  "name: Terraform Apply Staging" \
  "name: Terraform Apply Staging Renamed"
assert_invalid_workflow_set "renamed Terraform Apply workflow" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-automatic-trigger)"
replace_line_once "${workflow_set}/deploy.yml" \
  "  workflow_dispatch:" \
  "  workflow_run:"
assert_invalid_workflow_set "Deploy automatic workflow trigger" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture legacy-retirement-automatic-trigger)"
replace_line_once "${workflow_set}/retire-legacy-origin.yml" \
  "  workflow_dispatch:" \
  "  workflow_run:"
assert_invalid_workflow_set "Legacy retirement automatic workflow trigger" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture legacy-retirement-rerun-actor-bypass)"
# shellcheck disable=SC2016 # Expected workflow/fixture commands are literals.
replace_line_once "${workflow_set}/retire-legacy-origin.yml" \
  '          if [[ "${GITHUB_ACTOR,,}" != "${EXPECTED_APPROVER,,}" || "${GITHUB_TRIGGERING_ACTOR,,}" != "${EXPECTED_APPROVER,,}" ]]; then' \
  '          if [[ "${GITHUB_ACTOR,,}" != "${EXPECTED_APPROVER,,}" ]]; then'
assert_invalid_workflow_set "Legacy retirement rerun actor bypass" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture legacy-retirement-confirmation-bypass)"
# shellcheck disable=SC2016 # Expected workflow/fixture commands are literals.
replace_line_once "${workflow_set}/retire-legacy-origin.yml" \
  '          if [[ "${CONFIRMATION}" != '\''RETIRE pdcai.matoruru.com WITHOUT RECOVERY'\'' ]]; then' \
  '          if false; then'
assert_invalid_workflow_set "Legacy retirement confirmation bypass" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture legacy-retirement-main-identity-bypass)"
# shellcheck disable=SC2016 # Expected workflow/fixture commands are literals.
replace_line_once "${workflow_set}/retire-legacy-origin.yml" \
  '          if [[ "${DISPATCH_SHA}" != "${current_main_sha}" ]]; then' \
  '          if false; then'
assert_invalid_workflow_set "Legacy retirement current main identity bypass" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture legacy-retirement-missing-final-main-guard)"
remove_named_step "${workflow_set}/retire-legacy-origin.yml" \
  "Verify approved commit is still main HEAD"
assert_invalid_workflow_set "Legacy retirement missing final main identity guard" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-concurrency-change)"
replace_line_once "${workflow_set}/deploy.yml" \
  "  cancel-in-progress: false" \
  "  cancel-in-progress: true"
assert_invalid_workflow_set "Deploy concurrency change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-plan-trigger-change)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "    workflows: [CI]" \
  "    workflows: [CI Renamed]"
assert_invalid_workflow_set "Terraform Plan trigger workflow change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-plan-concurrency-change)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "  cancel-in-progress: false" \
  "  cancel-in-progress: true"
assert_invalid_workflow_set "Terraform Plan concurrency change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-input-change)"
replace_line_once "${workflow_set}/terraform-apply.yml" \
  "        required: true" \
  "        required: false"
assert_invalid_workflow_set "Terraform Apply input change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-rerun-actor-bypass)"
# shellcheck disable=SC2016 # Expected workflow/fixture commands are literals.
replace_line_once "${workflow_set}/terraform-apply.yml" \
  '          if [[ "${GITHUB_ACTOR,,}" != "${EXPECTED_APPROVER,,}" || "${GITHUB_TRIGGERING_ACTOR,,}" != "${EXPECTED_APPROVER,,}" ]]; then' \
  '          if [[ "${GITHUB_ACTOR,,}" != "${EXPECTED_APPROVER,,}" ]]; then'
assert_invalid_workflow_set "Terraform Apply rerun actor bypass" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-malformed-trailing-artifact-response)"
replace_raw_line_once "${workflow_set}/deploy.yml" \
  "              jq -ser \\" \
  "              jq -er \\"
assert_invalid_workflow_set "Deploy parser accepting malformed trailing artifact response" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-malformed-trailing-plan-run-response)"
replace_raw_line_once "${workflow_set}/terraform-apply.yml" \
  "            jq -ser \\" \
  "            jq -er \\"
assert_invalid_workflow_set "Terraform Apply parser accepting malformed trailing plan-run response" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-process-substitution-artifact-parser)"
# shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
replace_line_once "${workflow_set}/terraform-apply.yml" \
  '          artifact_record="$(' \
  '          mapfile -t artifact_names < <('
assert_invalid_workflow_set "Terraform Apply process-substitution artifact parser" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-run-change)"
# shellcheck disable=SC2016 # RUNNER_TEMP is an intentional workflow fixture literal.
replace_line_once "${workflow_set}/terraform-apply.yml" \
  '        run: terraform apply -input=false -no-color "${RUNNER_TEMP}/fukamu-cycle-terraform-plan/staging.tfplan"' \
  "        run: true"
assert_invalid_workflow_set "Terraform Apply run change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-missing-pre-approval-main-identity-guard)"
remove_named_step "${workflow_set}/deploy.yml" \
  "Re-verify deployment commit before Staging approval"
assert_invalid_workflow_set "Deploy missing pre-approval main identity guard" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-pre-approval-main-identity-guard-too-early)"
move_named_step_before "${workflow_set}/deploy.yml" \
  "Re-verify deployment commit before Staging approval" \
  "Verify approved Terraform evidence"
assert_invalid_workflow_set "Deploy pre-approval main identity guard placed too early" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-missing-final-main-identity-guard)"
remove_named_step "${workflow_set}/terraform-apply.yml" \
  "Re-verify approved plan is still main HEAD"
assert_invalid_workflow_set \
  "Terraform Apply missing final main identity guard" \
  "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-final-main-identity-guard-too-early)"
move_named_step_before "${workflow_set}/terraform-apply.yml" \
  "Re-verify approved plan is still main HEAD" \
  "Initialize Terraform"
assert_invalid_workflow_set \
  "Terraform Apply final main identity guard placed too early" \
  "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-plan-runner-change)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "    runs-on: ubuntu-latest" \
  "    runs-on: self-hosted"
assert_invalid_workflow_set "Terraform Plan runner change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-plan-secret-source-change)"
# shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
replace_line_once "${workflow_set}/terraform-plan.yml" \
  '      AWS_ACCESS_KEY_ID: ${{ secrets.TERRAFORM_R2_ACCESS_KEY_ID }}' \
  '      AWS_ACCESS_KEY_ID: ${{ secrets.TERRAFORM_R2_SECRET_ACCESS_KEY }}'
assert_invalid_workflow_set "Terraform Plan secret source change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-plan-apply-secret-source)"
# shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
replace_line_once "${workflow_set}/terraform-plan.yml" \
  '      AWS_ACCESS_KEY_ID: ${{ secrets.TERRAFORM_R2_ACCESS_KEY_ID }}' \
  '      AWS_ACCESS_KEY_ID: ${{ secrets.TERRAFORM_APPLY_R2_ACCESS_KEY_ID }}'
assert_invalid_workflow_set "Terraform Plan using Apply-only R2 secret" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-repository-secret-fallback)"
# shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
replace_line_once "${workflow_set}/terraform-apply.yml" \
  '      AWS_ACCESS_KEY_ID: ${{ secrets.TERRAFORM_APPLY_R2_ACCESS_KEY_ID }}' \
  '      AWS_ACCESS_KEY_ID: ${{ secrets.TERRAFORM_R2_ACCESS_KEY_ID }}'
assert_invalid_workflow_set "Terraform Apply repository R2 secret fallback" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-inventory-confirmation-too-late)"
move_named_step_before "${workflow_set}/terraform-apply.yml" \
  "Verify approver and resolve saved plan" \
  "Verify Terraform credential inventory confirmation"
assert_invalid_workflow_set "Terraform Apply inventory confirmation placed after GitHub API access" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-input-validation-too-late)"
move_named_step_before "${workflow_set}/terraform-apply.yml" \
  "Verify approved plan is still main HEAD" \
  "Validate Terraform deployment inputs"
assert_invalid_workflow_set "Terraform Apply input validation placed after external access" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-job-env-extra)"
replace_line_once "${workflow_set}/terraform-apply.yml" \
  '      TF_INPUT: "false"' \
  $'      TF_INPUT: "false"\n      NODE_OPTIONS: --require=/tmp/untrusted.js'
assert_invalid_workflow_set "Terraform Apply extra job environment" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-root-path)"
replace_line_once "${workflow_set}/deploy.yml" \
  "permissions:" \
  $'env:\n  PATH: /tmp/untrusted-bin\n\npermissions:'
assert_invalid_workflow_set "deploy root PATH" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture missing-checkout-credential-guard)"
replace_line_once "${workflow_set}/deploy.yml" "          persist-credentials: false" ""
assert_invalid_workflow_set "missing checkout credential guard" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture true-checkout-credential-guard)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "          persist-credentials: false" \
  "          persist-credentials: true"
assert_invalid_workflow_set "true checkout credential guard" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture checkout-credential-decoy)"
replace_line_once "${workflow_set}/deploy.yml" "          persist-credentials: false" ""
replace_line_once "${workflow_set}/deploy.yml" \
  "          runtime: node@24" \
  $'          runtime: node@24\n          persist-credentials: false'
assert_invalid_workflow_set "checkout credential guard in a different step" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture other-workflow-yaml-anchor)"
replace_line_once "${workflow_set}/deploy.yml" \
  "  group: staging-deploy" \
  "  group: &deployment_group staging-deploy"
assert_invalid_workflow_set "YAML anchor outside ci.yml" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture other-workflow-explicit-yaml-tag)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "        shell: bash" \
  "        !!str shell: bash"
assert_invalid_workflow_set "explicit YAML tag outside ci.yml" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture other-workflow-verbatim-yaml-tag)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "        shell: bash" \
  "        !<tag:yaml.org,2002:str> shell: bash"
assert_invalid_workflow_set "verbatim YAML tag outside ci.yml" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture other-workflow-quoted-mapping-key)"
replace_line_once "${workflow_set}/terraform-apply.yml" \
  "        shell: bash" \
  '        "shell": bash'
assert_invalid_workflow_set "quoted mapping key outside ci.yml" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture other-workflow-yaml-merge-key)"
replace_line_once "${workflow_set}/deploy.yml" \
  "      - name: Validate required deployment inputs" \
  $'      - name: Validate required deployment inputs\n        <<: *deployment_defaults'
assert_invalid_workflow_set "YAML merge key outside ci.yml" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture github-env-config-override)"
# GITHUB_ENV is fixture input and must remain unexpanded.
# shellcheck disable=SC2016
replace_line_once "${workflow_set}/deploy.yml" \
  "        run: node ./scripts/validate-deploy-inputs.mjs" \
  $'        run: |\n          echo PUBLIC_ORIGIN=https://example.invalid >> "$GITHUB_ENV"\n          node ./scripts/validate-deploy-inputs.mjs'
assert_invalid_workflow_set "GITHUB_ENV configuration override" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-permission-escalation)"
replace_line_once "${workflow_set}/deploy.yml" \
  "  contents: read" \
  "  contents: write"
assert_invalid_workflow_set "deploy permission escalation" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-plan-permission-escalation)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "  actions: read" \
  "  actions: write"
assert_invalid_workflow_set "Terraform Plan permission escalation" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-permission-escalation)"
replace_line_once "${workflow_set}/terraform-apply.yml" \
  "  contents: read" \
  "  contents: write"
assert_invalid_workflow_set "Terraform Apply permission escalation" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-default-shell-bypass)"
replace_line_once "${workflow_set}/deploy.yml" \
  "    timeout-minutes: 45" \
  $'    timeout-minutes: 45\n    defaults:\n      run:\n        shell: bash {0} || true'
assert_invalid_workflow_set "deploy defaults.run.shell failure bypass" "${workflow_set}"

fixture="$(new_fixture renamed-ci-workflow)"
replace_line_once "${fixture}" \
  "name: CI" \
  "name: CI Renamed"
assert_invalid "renamed CI workflow" "${fixture}"

fixture="$(new_fixture top-level-write-permission)"
replace_line_once "${fixture}" "  contents: read" "  contents: write"
assert_invalid "top-level write permission" "${fixture}"

fixture="$(new_fixture root-default-shell-bypass)"
replace_line_once "${fixture}" \
  "permissions:" \
  $'defaults:\n  run:\n    shell: bash {0} || true\n\npermissions:'
assert_invalid "root defaults.run.shell failure bypass" "${fixture}"

fixture="$(new_fixture root-bash-env)"
replace_line_once "${fixture}" \
  "permissions:" \
  $'env:\n  BASH_ENV: /tmp/fukamu-ci-shell-bypass\n\npermissions:'
assert_invalid "root BASH_ENV" "${fixture}"

fixture="$(new_fixture pull-request-reuse)"
replace_job_line "${fixture}" reuse_pr_ci "    if: github.event_name == 'push'" \
  "    if: github.event_name == 'pull_request'"
assert_invalid "PR-side CI reuse" "${fixture}"

fixture="$(new_fixture elevated-reuse-permission)"
replace_job_line "${fixture}" reuse_pr_ci "      actions: read" "      actions: write"
assert_invalid "elevated reuse permission" "${fixture}"

fixture="$(new_fixture static-reuse-output)"
# This GitHub expression is fixture input and must remain unexpanded.
# shellcheck disable=SC2016
replace_job_line "${fixture}" reuse_pr_ci \
  '      reuse_pr_ci: ${{ steps.resolve.outputs.reuse_pr_ci }}' \
  "      reuse_pr_ci: true"
assert_invalid "static reusable-CI decision output" "${fixture}"

fixture="$(new_fixture replaced-reuse-resolver)"
# These runtime variable references are fixture input and must remain unexpanded.
# shellcheck disable=SC2016
replace_job_line "${fixture}" reuse_pr_ci \
  '        run: bash .github/scripts/resolve-ci-reuse.sh "${GITHUB_SHA}" "${GITHUB_REPOSITORY}" "${GITHUB_OUTPUT}"' \
  "        run: exit 0"
assert_invalid "replaced reusable-CI resolver consumer" "${fixture}"

fixture="$(new_fixture reuse-checkout-repository-override)"
replace_job_line "${fixture}" reuse_pr_ci \
  "          persist-credentials: false" \
  $'          persist-credentials: false\n          repository: attacker/public-repository'
assert_invalid "reuse checkout repository override" "${fixture}"

fixture="$(new_fixture reuse-checkout-ref-override)"
replace_job_line "${fixture}" reuse_pr_ci \
  "          persist-credentials: false" \
  $'          persist-credentials: false\n          ref: refs/heads/main'
assert_invalid "reuse checkout ref override" "${fixture}"

fixture="$(new_fixture attest-checkout-ref-change)"
# shellcheck disable=SC2016 # GitHub expression is an intentional fixture literal.
replace_job_line "${fixture}" attest_pr_ci \
  '          ref: ${{ github.sha }}' \
  "          ref: refs/heads/main"
assert_invalid "attestation checkout ref change" "${fixture}"

fixture="$(new_fixture attest-upload-action-change)"
replace_job_line "${fixture}" attest_pr_ci \
  "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1" \
  "        uses: actions/upload-artifact@main"
assert_invalid "attestation upload action change" "${fixture}"

fixture="$(new_fixture classifier-base-is-head)"
# shellcheck disable=SC2016 # GitHub expression is an intentional fixture literal.
replace_job_line "${fixture}" classify \
  '          BASE_SHA: ${{ github.event.pull_request.base.sha }}' \
  '          BASE_SHA: ${{ github.sha }}'
assert_invalid "classifier without PR base revision" "${fixture}"

fixture="$(new_fixture classifier-main-not-full)"
replace_job_line "${fixture}" classify \
  "              echo 'change_profile=full'" \
  "              echo 'change_profile=docs'"
assert_invalid "classifier without full main fallback" "${fixture}"

fixture="$(new_fixture classifier-command-bypass)"
# shellcheck disable=SC2016 # Runtime variables are intentional fixture literals.
replace_job_line "${fixture}" classify \
  '              --classify-only --range "${BASE_SHA}" "${HEAD_SHA}" >> "${GITHUB_OUTPUT}"' \
  '              echo "change_profile=docs" >> "${GITHUB_OUTPUT}"'
assert_invalid "classifier command bypass" "${fixture}"

fixture="$(new_fixture required-verifier-bypass)"
replace_raw_line_once "${fixture}" \
  "          node ./scripts/verify-ci-change-profile.mjs \\" \
  "          true \\"
assert_invalid "required job matrix verifier bypass" "${fixture}"

fixture="$(new_fixture required-checkout-ref-change)"
# shellcheck disable=SC2016 # GitHub expression is an intentional fixture literal.
replace_job_line "${fixture}" required_pr_ci \
  '          ref: ${{ github.sha }}' \
  "          ref: refs/heads/main"
assert_invalid "required aggregator checkout ref change" "${fixture}"

fixture="$(new_fixture persisted-checkout-credentials)"
replace_line_once "${fixture}" "          persist-credentials: false" \
  "          persist-credentials: true"
assert_invalid "persisted checkout credentials" "${fixture}"

fixture="$(new_fixture duplicate-quality-checkout)"
replace_job_line "${fixture}" quality \
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
  $'      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'
assert_invalid "duplicate quality checkout" "${fixture}"

fixture="$(new_fixture misplaced-full-history-fetch)"
replace_job_line "${fixture}" quality \
  "          fetch-depth: \${{ needs.classify.outputs.change_profile == 'full' && '0' || '1' }}" \
  ""
replace_job_line "${fixture}" quality "          runtime: node@24" \
  $'          runtime: node@24\n          fetch-depth: ${{ needs.classify.outputs.change_profile == '\''full'\'' && '\''0'\'' || '\''1'\'' }}'
assert_invalid "full-history fetch-depth outside checkout" "${fixture}"

for full_job in workflow quality frontend backend infrastructure e2e; do
  if [[ "${full_job}" == "quality" ]]; then
    fallback_line="      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true')"
    bypassed_fallback_line="      needs.reuse_pr_ci.outputs.reuse_pr_ci == 'false')"
  else
    fallback_line="      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true') &&"
    bypassed_fallback_line="      needs.reuse_pr_ci.outputs.reuse_pr_ci == 'false') &&"
  fi

  fixture="$(new_fixture "${full_job}-without-main-fallback")"
  replace_job_line "${fixture}" "${full_job}" \
    "${fallback_line}" \
    "${bypassed_fallback_line}"
  assert_invalid "${full_job} without fail-closed main fallback" "${fixture}"

  fixture="$(new_fixture "${full_job}-tagged-duplicate-fallback")"
  replace_job_line "${fixture}" "${full_job}" \
    "${fallback_line}" \
    "${fallback_line}"$'\n    !!str if: github.ref == github.sha'
  assert_invalid "${full_job} with tagged duplicate fallback" "${fixture}"

  fixture="$(new_fixture "${full_job}-quoted-duplicate-fallback")"
  replace_job_line "${fixture}" "${full_job}" \
    "${fallback_line}" \
    "${fallback_line}"$'\n    "if": github.ref == github.sha'
  assert_invalid "${full_job} with quoted duplicate fallback" "${fixture}"
done

fixture="$(new_fixture skipped-backend-test-step)"
replace_job_line "${fixture}" backend \
  "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go test ./..." \
  $'      - if: false\n        run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go test ./...'
assert_invalid "conditionally skipped backend test step" "${fixture}"

fixture="$(new_fixture backend-go-workspace-auto)"
replace_job_line "${fixture}" backend \
  "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go test ./..." \
  "      - run: go test ./..."
assert_invalid "backend Go test without fixed workspace and module mode" "${fixture}"

fixture="$(new_fixture tolerant-frontend-test-shell)"
replace_job_line "${fixture}" frontend \
  "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match test" \
  $'      - shell: bash {0} || true\n        run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match test'
assert_invalid "failure-tolerant frontend test shell" "${fixture}"

fixture="$(new_fixture backend-job-bash-env)"
replace_job_line "${fixture}" backend \
  "    env:" \
  $'    env:\n      BASH_ENV: /tmp/fukamu-backend-shell-bypass'
assert_invalid "backend job BASH_ENV" "${fixture}"

fixture="$(new_fixture skipped-e2e-test-step)"
replace_job_line "${fixture}" e2e \
  "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run test:e2e" \
  $'      - if: false\n        run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run test:e2e'
assert_invalid "conditionally skipped E2E test step" "${fixture}"

fixture="$(new_fixture replaced-frontend-test-command)"
replace_job_line "${fixture}" frontend \
  "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match test" \
  "      - run: true"
assert_invalid "replaced frontend test command" "${fixture}"

fixture="$(new_fixture frontend-filter-without-fail-if-no-match)"
replace_job_line "${fixture}" frontend \
  "      - run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match test" \
  "      - run: pnpm --filter fukamu-cycle-frontend test"
assert_invalid "frontend filter without fail-if-no-match" "${fixture}"

fixture="$(new_fixture self-hosted-functional-runner)"
replace_job_line "${fixture}" backend \
  "    runs-on: ubuntu-latest" \
  "    runs-on: self-hosted"
assert_invalid "self-hosted functional runner" "${fixture}"

fixture="$(new_fixture serialized-workflow-behind-quality)"
replace_job_line "${fixture}" workflow \
  "    needs: [reuse_pr_ci, classify]" \
  "    needs: [reuse_pr_ci, classify, quality]"
assert_invalid "workflow serialized behind quality" "${fixture}"

fixture="$(new_fixture serialized-frontend-behind-quality)"
replace_job_line "${fixture}" frontend \
  "    needs: [reuse_pr_ci, classify]" \
  "    needs: [reuse_pr_ci, classify, quality]"
assert_invalid "frontend serialized behind quality" "${fixture}"

fixture="$(new_fixture serialized-backend-behind-quality)"
replace_job_line "${fixture}" backend \
  "    needs: [reuse_pr_ci, classify]" \
  "    needs: [reuse_pr_ci, classify, quality]"
assert_invalid "backend serialized behind quality" "${fixture}"

fixture="$(new_fixture serialized-infrastructure-behind-quality)"
replace_job_line "${fixture}" infrastructure \
  "    needs: [reuse_pr_ci, classify]" \
  "    needs: [reuse_pr_ci, classify, quality]"
assert_invalid "infrastructure serialized behind quality" "${fixture}"

for install_job in frontend infrastructure e2e; do
  fixture="$(new_fixture "${install_job}-install-scripts-enabled")"
  replace_job_line "${fixture}" "${install_job}" \
    "      - run: pnpm install --frozen-lockfile --ignore-scripts" \
    "      - run: pnpm install --frozen-lockfile"
  assert_invalid "${install_job} dependency install with lifecycle scripts enabled" "${fixture}"

  fixture="$(new_fixture "${install_job}-omitted-install-tree-guard")"
  replace_job_line "${fixture}" "${install_job}" \
    "          git diff --cached --quiet --" \
    "          true"
  assert_invalid "${install_job} dependency install without exact candidate tree guard" "${fixture}"
done

fixture="$(new_fixture backend-untracked-sqlc-output-check-omitted)"
# shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
replace_job_line "${fixture}" backend \
  '      - run: test -z "$(git ls-files --others --exclude-standard -- internal/infrastructure/postgres/generated)"' \
  "      - run: true"
assert_invalid "backend without untracked sqlc output check" "${fixture}"

fixture="$(new_fixture shallow-quality-checkout)"
replace_job_line "${fixture}" quality \
  "          fetch-depth: \${{ needs.classify.outputs.change_profile == 'full' && '0' || '1' }}" \
  "          fetch-depth: 1"
assert_invalid "shallow quality checkout" "${fixture}"

while IFS='|' read -r field value; do
  fixture="$(new_fixture "quality-${field}")"
  replace_job_line "${fixture}" quality \
    "    timeout-minutes: 30" \
    "    timeout-minutes: 30"$'\n'"    ${field}: ${value}"
  assert_invalid "quality job-level ${field}" "${fixture}"
done <<'QUALITY_FORBIDDEN_JOB_FIELDS'
defaults|{}
env|{}
container|{}
services|{}
strategy|{}
QUALITY_FORBIDDEN_JOB_FIELDS

fixture="$(new_fixture replaced-actionlint-consumer)"
replace_job_line "${fixture}" workflow \
  "        uses: docker://rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 # v1.7.12" \
  "        uses: docker://rhysd/actionlint:latest"
assert_invalid "replaced actionlint consumer" "${fixture}"

fixture="$(new_fixture skipped-actionlint-step)"
replace_job_line "${fixture}" workflow \
  "      - name: Validate GitHub Actions workflows" \
  $'      - if: false\n        name: Validate GitHub Actions workflows'
assert_invalid "skipped actionlint step" "${fixture}"

# shellcheck disable=SC2016 # Expected workflow shell variables are literals.
control_plane_gate_run='bash ./scripts/check-control-plane-fixtures.sh --range "${CONTROL_PLANE_BASE_SHA}" "${CONTROL_PLANE_HEAD_SHA}"'
while IFS='|' read -r gate_slug gate_name gate_run; do
  if [[ "${gate_slug}" == "control" ]]; then
    gate_run="${control_plane_gate_run}"
  fi
  fixture="$(new_fixture "duplicate-${gate_slug}-gate")"
  duplicate_gate_step="$(printf '      - name: %s\n        run: %s\n      - name: %s' \
    "${gate_name}" "${gate_run}" "${gate_name}")"
  replace_job_line "${fixture}" quality \
    "      - name: ${gate_name}" \
    "${duplicate_gate_step}"
  assert_invalid "duplicate ${gate_name} quality gate" "${fixture}"
done <<'QUALITY_GATES'
shell|Validate Bash scripts|bash ./scripts/check-shell.sh
control|Validate control-plane negative fixtures when applicable|CONTROL_PLANE_GATE_RUN
docs|Validate documentation|bash ./scripts/check-docs.sh
config|Validate configuration parity|bash ./scripts/check-config-parity.sh
security|Run security gates|bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"
QUALITY_GATES
unset control_plane_gate_run

fixture="$(new_fixture replaced-control-plane-classifier)"
# shellcheck disable=SC2016 # Expected workflow shell variables are literals.
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-control-plane-fixtures.sh --range "${CONTROL_PLANE_BASE_SHA}" "${CONTROL_PLANE_HEAD_SHA}"' \
  "        run: true"
assert_invalid "replaced control-plane fixture classifier" "${fixture}"

fixture="$(new_fixture altered-control-plane-base)"
# shellcheck disable=SC2016 # Expected workflow expressions are literals.
replace_job_line "${fixture}" quality \
  '          CONTROL_PLANE_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}' \
  '          CONTROL_PLANE_BASE_SHA: ${{ github.sha }}'
assert_invalid "altered control-plane fixture base" "${fixture}"

fixture="$(new_fixture reordered-security-gate)"
replace_job_line "${fixture}" quality \
  "      - name: Run security gates" \
  ""
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  ""
replace_job_line "${fixture}" quality \
  "      - run: pnpm install --frozen-lockfile --ignore-scripts" \
  $'      - run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Run security gates\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "security gate after dependency installation" "${fixture}"

fixture="$(new_fixture quality-install-scripts-enabled)"
replace_job_line "${fixture}" quality \
  "      - run: pnpm install --frozen-lockfile --ignore-scripts" \
  "      - run: pnpm install --frozen-lockfile"
assert_invalid "quality dependency install with lifecycle scripts enabled" "${fixture}"

fixture="$(new_fixture omitted-post-install-tree-guard)"
replace_job_line "${fixture}" quality \
  "          git diff --cached --quiet --" \
  "          true"
assert_invalid "quality dependency install without exact candidate tree guard" "${fixture}"

fixture="$(new_fixture renamed-post-install-tree-guard)"
replace_job_line "${fixture}" quality \
  "      - name: Verify dependency install preserved candidate tree" \
  "      - name: Trust dependency install"
assert_valid "renamed quality candidate tree guard" "${fixture}"

fixture="$(new_fixture tagged-security-step-key)"
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        !!str if: github.ref == github.sha\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "tagged key in security gate" "${fixture}"

fixture="$(new_fixture omitted-security-gate)"
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  "        run: printf 'security skipped\\n'"
assert_invalid "omitted security gate" "${fixture}"

fixture="$(new_fixture tolerated-security-failure)"
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        continue-on-error: true\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "tolerated security failure" "${fixture}"

fixture="$(new_fixture skipped-security-step)"
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        if: false\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "skipped security step" "${fixture}"

fixture="$(new_fixture sequence-leading-skipped-security-step)"
replace_job_line "${fixture}" quality \
  "      - name: Run security gates" \
  $'      - if: false\n        name: Run security gates'
assert_invalid "sequence-leading skipped security step" "${fixture}"

fixture="$(new_fixture sequence-leading-tolerated-security-failure)"
replace_job_line "${fixture}" quality \
  "      - name: Run security gates" \
  $'      - continue-on-error: true\n        name: Run security gates'
assert_invalid "sequence-leading tolerated security failure" "${fixture}"

fixture="$(new_fixture quoted-skipped-security-step)"
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        "if": github.ref == github.sha\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "quoted skipped security step" "${fixture}"

fixture="$(new_fixture quoted-tolerated-security-failure)"
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        \'continue-on-error\': true\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "quoted tolerated security failure" "${fixture}"

fixture="$(new_fixture quoted-security-shell-suppresses-failure)"
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        "shell": bash {0} || true\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "quoted security shell suppresses failure" "${fixture}"

fixture="$(new_fixture security-shell-suppresses-failure)"
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        shell: bash {0} || true\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "security shell suppresses failure" "${fixture}"

fixture="$(new_fixture anchored-quality-if)"
replace_job_line "${fixture}" workflow \
  "        run: bash .github/scripts/resolve-ci-reuse.test.sh" \
  $'        env:\n          KEY_NAME: &if_key if\n        run: bash .github/scripts/resolve-ci-reuse.test.sh'
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        *if_key: github.ref == github.sha\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "anchored quality if key" "${fixture}"

fixture="$(new_fixture anchored-quality-continue-on-error)"
replace_job_line "${fixture}" workflow \
  "        run: bash .github/scripts/resolve-ci-reuse.test.sh" \
  $'        env:\n          KEY_NAME: &continue_key continue-on-error\n        run: bash .github/scripts/resolve-ci-reuse.test.sh'
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        *continue_key: true\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "anchored quality continue-on-error key" "${fixture}"

fixture="$(new_fixture anchored-quality-shell)"
replace_job_line "${fixture}" workflow \
  "        run: bash .github/scripts/resolve-ci-reuse.test.sh" \
  $'        env:\n          KEY_NAME: &shell_key shell\n        run: bash .github/scripts/resolve-ci-reuse.test.sh'
replace_job_line "${fixture}" quality \
  '        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"' \
  $'        *shell_key: bash {0} || true\n        run: bash ./scripts/check-security.sh --profile "${SECURITY_PROFILE}"'
assert_invalid "anchored quality shell key" "${fixture}"

fixture="$(new_fixture merged-quality-step)"
replace_job_line "${fixture}" workflow \
  "      - name: Test CI reuse resolver" \
  $'      - &bypass_step\n        name: Test CI reuse resolver\n        if: github.ref == github.sha\n        shell: bash {0} || true'
replace_job_line "${fixture}" quality \
  "      - name: Run security gates" \
  $'      - name: Run security gates\n        <<: *bypass_step'
assert_invalid "merged quality step" "${fixture}"

fixture="$(new_fixture serialized-e2e-behind-quality)"
replace_job_line "${fixture}" e2e \
  "    needs: [reuse_pr_ci, classify]" \
  "    needs: [reuse_pr_ci, classify, quality]"
assert_invalid "E2E serialized behind quality" "${fixture}"

fixture="$(new_fixture attestation-aggregator-bypass)"
replace_job_line "${fixture}" attest_pr_ci \
  "      needs.required_pr_ci.result == 'success'" \
  "      needs.required_pr_ci.result != 'failure'"
assert_invalid "attestation required aggregator bypass" "${fixture}"

fixture="$(new_fixture omitted-cleanup-build)"
replace_job_line "${fixture}" backend \
  "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/cleanup" \
  "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/server"
assert_invalid "omitted cleanup command build" "${fixture}"

printf '%s\n' "CI workflow security model tests passed."
