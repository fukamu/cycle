#!/usr/bin/env bash

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
  validate_no_defaults_run_shell "${file}" || return 1
}

validate_exact_workflow_structure() {
  local file="$1"
  local contract="$2"
  local actual_name
  local expected_name
  local actual_root_fields
  local expected_root_fields
  local actual_jobs
  local expected_jobs

  actual_name="$(awk '/^name:/ { print }' "${file}")"

  if ! actual_root_fields="$(
    awk '
      /^[^[:space:]#]/ {
        if ($0 !~ /^[[:alnum:]_-]+:/) exit 2
        field = $0
        sub(/:.*/, "", field)
        print field
      }
    ' "${file}"
  )"; then
    violation "workflow root fields must use canonical unquoted keys: ${file}"
    return 1
  fi

  if ! actual_jobs="$(
    awk '
      $0 == "jobs:" {
        found++
        active = 1
        next
      }
      active && /^[^[:space:]]/ { active = 0 }
      active && /^  [^[:space:]#]/ {
        if ($0 !~ /^  [[:alnum:]_-]+:[[:space:]]*$/) exit 2
        job = $0
        sub(/^  /, "", job)
        sub(/:[[:space:]]*$/, "", job)
        print job
      }
      END { if (found != 1) exit 1 }
    ' "${file}"
  )"; then
    violation "workflow jobs must use one canonical mapping with explicit job IDs: ${file}"
    return 1
  fi

  case "${contract}" in
    ci)
      expected_name="name: CI"
      expected_root_fields="$(printf '%s\n' name on permissions jobs)"
      expected_jobs="$(
        printf '%s\n' \
          reuse_pr_ci workflow quality frontend backend infrastructure e2e attest_pr_ci
      )"
      ;;
    deploy)
      expected_name="name: Deploy Staging"
      expected_root_fields="$(printf '%s\n' name on permissions concurrency jobs)"
      expected_jobs="$(printf '%s\n' resolve deploy)"
      ;;
    terraform-plan)
      expected_name="name: Terraform Plan Staging"
      expected_root_fields="$(printf '%s\n' name on permissions concurrency jobs)"
      expected_jobs="plan"
      ;;
    playbook)
      expected_name="name: Playbook policy"
      expected_root_fields="$(printf '%s\n' name on permissions jobs)"
      expected_jobs="validate"
      ;;
    terraform-apply)
      expected_name="name: Terraform Apply Staging"
      expected_root_fields="$(printf '%s\n' name on permissions concurrency jobs)"
      expected_jobs="$(printf '%s\n' preflight apply)"
      ;;
    legacy-retirement)
      expected_name="name: Retire Legacy PDCAI Origin"
      expected_root_fields="$(printf '%s\n' name on permissions concurrency jobs)"
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
  [[ "${actual_root_fields}" == "${expected_root_fields}" ]] || {
    violation "workflow root field inventory is not exact for ${contract}: ${file}"
    return 1
  }
  [[ "${actual_jobs}" == "${expected_jobs}" ]] || {
    violation "workflow job ID inventory is not exact for ${contract}: ${file}"
    return 1
  }
}

validate_secret_workflow_exact_digest() {
  local file="$1"
  local contract="$2"
  local expected_digest
  local actual_digest

  case "${contract}" in
    deploy)
      expected_digest="a5b1ca1d5772103408852e7189a47c6e5e2c4389148e036885f144957ea8579b"
      ;;
    terraform-plan)
      expected_digest="3401da86fcb13bec1335fae58fa523c83cffcc1be7ddabedfcc976e900ec2bd7"
      ;;
    terraform-apply)
      expected_digest="642d2782ef3d1800585818e2025b49d6c6dd3ddc6378d3c472a65a822158f3aa"
      ;;
    legacy-retirement)
      expected_digest="ffe1e152fd4c9f7dac2283751ac12adbf14d86f1080edb4199bcd944776e2036"
      ;;
    *) return 0 ;;
  esac

  actual_digest="$(sha256sum -- "${file}")" || {
    violation "could not hash secret-bearing workflow: ${file}"
    return 1
  }
  actual_digest="${actual_digest%% *}"
  [[ "${actual_digest}" == "${expected_digest}" ]] || {
    violation "secret-bearing workflow content is not exact for ${contract}: ${file}"
    return 1
  }
}

validate_checkout_credential_file() {
  local file="$1"
  local expected_count="$2"
  awk -v expected_count="${expected_count}" '
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
      if (all_uses != expected_count || parsed_uses != expected_count || invalid) exit 1
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
  local confirmation_step="${test_root}/terraform-apply-inventory-confirmation.step"
  local confirmation_script="${test_root}/terraform-apply-inventory-confirmation.sh"
  local confirmation_output="${test_root}/terraform-apply-inventory-confirmation.output"
  local apply_job="${test_root}/terraform-apply-secret-sources.job"
  local apply_env="${test_root}/terraform-apply-secret-sources.env"
  local apply_steps="${test_root}/terraform-apply-secret-sources.steps"
  local validation_step="${test_root}/terraform-apply-input-validation.step"
  local validation_script="${test_root}/terraform-apply-input-validation.sh"
  local validation_output="${test_root}/terraform-apply-input-validation.output"
  local first_preflight_step
  local first_apply_step

  extract_job "${directory}/terraform-plan.yml" plan >"${plan_job}" || {
    violation "Terraform Plan job must exist for R2 secret source validation"
    return 1
  }
  extract_job_mapping "${plan_job}" env >"${plan_env}" || {
    violation "Terraform Plan must define one job environment mapping"
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
  local metadata_step="${test_root}/deploy-apply-metadata.step"
  local metadata_script="${test_root}/deploy-apply-metadata.sh"
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
  require_nonblank_lines "${on_block}" \
    "  workflow_dispatch:" \
    "    inputs:" \
    "      mode:" \
    "        description: Select normal after Terraform Apply, or schema-compatible application recovery" \
    "        required: true" \
    "        type: choice" \
    "        options:" \
    "          - normal" \
    "          - recovery" \
    "      apply_run_id:" \
    "        description: Successful exact-current-main Terraform Apply Staging run ID (normal only)" \
    "        required: false" \
    "        type: string" \
    "      recovery_confirmation:" \
    "        description: Type RECOVER STAGING APPLICATION WITHOUT TERRAFORM APPLY (recovery only)" \
    "        required: false" \
    "        type: string" || return 1
  if grep -Fq 'workflow_run:' "${deploy_workflow}"; then
    violation "Deploy Staging must not start automatically from workflow_run"
    return 1
  fi

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
    local apply_run_id="$9"
    local confirmation="${10}"
    local run_attempt="${11:-1}"
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
      APPLY_RUN_ID="${apply_run_id}" \
      RECOVERY_CONFIRMATION="${confirmation}" \
      bash "${preflight_script}" >"${output}" 2>&1
  }

  if ! run_deploy_preflight \
    workflow_dispatch refs/heads/main main "${valid_sha}" Owner owner OWNER normal 123 ''; then
    violation "Deploy Staging dispatch preflight rejected a valid normal deployment"
    return 1
  fi
  if run_deploy_preflight \
    workflow_dispatch refs/heads/main main "${valid_sha}" Owner owner OWNER normal 123 '' 2; then
    violation "Deploy Staging dispatch preflight accepted a workflow rerun"
    return 1
  fi
  if ! run_deploy_preflight \
    workflow_dispatch refs/heads/main main "${valid_sha}" Owner owner OWNER recovery '' \
    'RECOVER STAGING APPLICATION WITHOUT TERRAFORM APPLY'; then
    violation "Deploy Staging dispatch preflight rejected a valid recovery deployment"
    return 1
  fi

  local -a invalid_preflights=(
    "workflow_run|refs/heads/main|main|${valid_sha}|Owner|owner|owner|normal|123|"
    "workflow_dispatch|refs/heads/topic|topic|${valid_sha}|Owner|owner|owner|normal|123|"
    "workflow_dispatch|refs/heads/main|main|invalid|Owner|owner|owner|normal|123|"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}||owner|owner|normal|123|"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|bad--login|bad--login|bad--login|normal|123|"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|attacker|owner|normal|123|"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|attacker|normal|123|"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|other|123|"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|normal||"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|normal|0|"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|normal|123|unexpected"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|recovery|123|RECOVER STAGING APPLICATION WITHOUT TERRAFORM APPLY"
    "workflow_dispatch|refs/heads/main|main|${valid_sha}|Owner|owner|owner|recovery||wrong"
  )
  local fixture
  local -a fields
  for fixture in "${invalid_preflights[@]}"; do
    IFS='|' read -r -a fields <<<"${fixture}|_"
    if run_deploy_preflight \
      "${fields[0]}" "${fields[1]}" "${fields[2]}" "${fields[3]}" \
      "${fields[4]}" "${fields[5]}" "${fields[6]}" "${fields[7]}" \
      "${fields[8]}" "${fields[9]}"; then
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
ci_name='CI'
ci_path='.github/workflows/ci.yml'
ci_event='push'
ci_status='completed'
ci_conclusion='success'
ci_sha="${valid_sha}"
ci_repository='fukamu/cycle'
ci_total=1
ci_id=789
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
  expired-artifact) artifact_expired=true ;;
  wrong-artifact-run) artifact_run_id=124 ;;
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
case "$*" in
  *'/git/ref/heads/main'*)
    printf '{"ref":"refs/heads/main","object":{"type":"commit","sha":"%s"}}\n' "${valid_sha}"
    if [[ "${scenario}" == 'trailing-main-json' ]]; then printf '{}\n'; fi
    ;;
  *'/actions/runs/123/artifacts?per_page=100'*)
    printf '{"total_count":%s,"artifacts":[{"id":456,"name":"terraform-apply-staging-%s","expired":%s,"workflow_run":{"id":%s}}]}\n' \
      "${artifact_total}" "${artifact_sha}" "${artifact_expired}" "${artifact_run_id}"
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
    local apply_run_id=123
    if [[ "${mode}" == 'recovery' ]]; then apply_run_id=''; fi
    : >"${github_output}"
    env -i \
      PATH="${fake_bin}:/usr/bin:/bin" \
      FAKE_SCENARIO="${scenario}" \
      APPLY_RUN_ID="${apply_run_id}" \
      DISPATCH_SHA="${dispatch_sha}" \
      GH_TOKEN=fake \
      GITHUB_REPOSITORY=fukamu/cycle \
      GITHUB_OUTPUT="${github_output}" \
      MODE="${mode}" \
      bash "${resolve_script}" >"${output}" 2>&1
  }

  if ! run_deploy_resolver success normal "${valid_sha}"; then
    violation "Deploy Staging resolver rejected valid Apply, artifact, and CI evidence"
    return 1
  fi
  require_nonblank_lines "${github_output}" \
    "apply_artifact_name=terraform-apply-staging-${valid_sha}" \
    "apply_run_id=123" \
    "ci_run_id=789" \
    "commit_sha=${valid_sha}" || return 1
  if ! run_deploy_resolver success recovery "${valid_sha}"; then
    violation "Deploy Staging resolver rejected valid recovery CI evidence"
    return 1
  fi

  local scenario
  for scenario in \
    wrong-workflow wrong-path wrong-event incomplete-apply failed-apply stale-apply \
    wrong-apply-branch wrong-apply-repository wrong-artifact expired-artifact \
    wrong-artifact-run paginated-artifacts wrong-ci-name wrong-ci-path wrong-ci-event \
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

  extract_named_step "${resolve_job}" "Verify approved Terraform Apply metadata" >"${metadata_step}" || {
    violation "Deploy Staging must verify downloaded Terraform Apply metadata"
    return 1
  }
  extract_literal_run_script "${metadata_step}" >"${metadata_script}" || {
    violation "Deploy Staging Terraform Apply metadata verifier must be extractable"
    return 1
  }
  local metadata_directory="${test_root}/deploy-metadata"
  mkdir -- "${metadata_directory}"
  printf '%s\n' "${valid_sha}" >"${metadata_directory}/commit-sha"
  if ! env -i PATH=/usr/bin:/bin ARTIFACT_DIRECTORY="${metadata_directory}" COMMIT_SHA="${valid_sha}" \
    bash "${metadata_script}" >"${output}" 2>&1; then
    violation "Deploy Staging metadata verifier rejected the exact commit artifact"
    return 1
  fi
  printf '%s\n' "${stale_sha}" >"${metadata_directory}/commit-sha"
  if env -i PATH=/usr/bin:/bin ARTIFACT_DIRECTORY="${metadata_directory}" COMMIT_SHA="${valid_sha}" \
    bash "${metadata_script}" >"${output}" 2>&1; then
    violation "Deploy Staging metadata verifier accepted a mismatched commit"
    return 1
  fi
  printf '%s\n' "${valid_sha}" >"${metadata_directory}/commit-sha"
  touch "${metadata_directory}/unexpected"
  if env -i PATH=/usr/bin:/bin ARTIFACT_DIRECTORY="${metadata_directory}" COMMIT_SHA="${valid_sha}" \
    bash "${metadata_script}" >"${output}" 2>&1; then
    violation "Deploy Staging metadata verifier accepted an extra artifact entry"
    return 1
  fi
}

validate_playbook_workflow_contract() {
  local file="$1"
  local expected
  expected="$(
    cat <<'EOF'
name: Playbook policy
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0
        with:
          runtime: node@24
          install: false
      - name: Validate vendored playbook and Cycle ownership trace
        env:
          PYTHONNOUSERSITE: "1"
          PYTHONPATH: ""
          PYTHONSAFEPATH: "1"
        run: |
          node scripts/validate-playbook-config.mjs .
          python3 .fukamu/playbook/validate.py --consumer .
EOF
  )"
  require_nonblank_block "${file}" "${expected}" || {
    violation "Playbook policy workflow must retain its exact offline validation contract"
    return 1
  }
}

validate_all_workflows() {
  local directory="$1"
  local expected_inventory
  local actual_inventory
  expected_inventory="$(printf '%s\n' ci.yml deploy.yml playbook.yml retire-legacy-origin.yml terraform-apply.yml terraform-plan.yml)"
  actual_inventory="$(
    find "${directory}" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -printf '%f\n' \
      | LC_ALL=C sort
  )"
  [[ "${actual_inventory}" == "${expected_inventory}" ]] || {
    violation "GitHub Actions workflow inventory is not exact in ${directory}"
    return 1
  }

  local filename
  local expected_count
  local structure_contract
  while IFS='|' read -r filename expected_count structure_contract; do
    validate_workflow_source_guards "${directory}/${filename}" || return 1
    validate_exact_workflow_structure "${directory}/${filename}" "${structure_contract}" || return 1
    validate_secret_workflow_exact_digest "${directory}/${filename}" "${structure_contract}" || return 1
    validate_checkout_credential_file "${directory}/${filename}" "${expected_count}" || return 1
  done <<'WORKFLOW_CHECKOUT_INVENTORY'
ci.yml|8|ci
deploy.yml|1|deploy
playbook.yml|1|playbook
retire-legacy-origin.yml|1|legacy-retirement
terraform-apply.yml|1|terraform-apply
terraform-plan.yml|1|terraform-plan
WORKFLOW_CHECKOUT_INVENTORY
  validate_json_parser_completion_contract "${directory}" || return 1
  validate_workflow_permissions_contract "${directory}" || return 1
  validate_terraform_r2_secret_sources "${directory}" || return 1
  validate_deploy_approval_gate "${directory}" || return 1
  validate_playbook_workflow_contract "${directory}/playbook.yml" || return 1
}

validate_checkout_steps() {
  local file="$1"
  local -a checkout_jobs=(
    reuse_pr_ci
    workflow
    quality
    frontend
    backend
    infrastructure
    e2e
    attest_pr_ci
  )
  local checkout_uses
  checkout_uses="$(awk '/uses:[[:space:]]*actions\/checkout@/ { count++ } END { print count + 0 }' "${file}")"
  [[ "${checkout_uses}" -eq "${#checkout_jobs[@]}" ]] || {
    violation "every CI job must contain exactly one checkout step"
    return 1
  }

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

    local fetch_depth_count
    fetch_depth_count="$(awk '/fetch-depth[[:space:]]*:/ { count++ } END { print count + 0 }' "${checkout_step}")"
    if [[ "${job}" == "quality" ]]; then
      [[ "${fetch_depth_count}" == "1" ]] || {
        violation "quality checkout must define fetch-depth exactly once"
        return 1
      }
      require_exact_line "${checkout_with}" "          fetch-depth: 0" || return 1
    elif [[ "${fetch_depth_count}" != "0" ]]; then
      violation "only the full-history quality checkout may override fetch-depth"
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
  require_exact_line "${job_file}" "    needs: reuse_pr_ci" || return 1
  extract_job_if "${job_file}" >"${if_file}" || {
    violation "${job} must define one fallback condition"
    return 1
  }
  require_nonblank_lines "${if_file}" \
    "    if: >-" \
    "      always() &&" \
    "      (github.event_name == 'pull_request' ||" \
    "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true')"
}

validate_job_structure() {
  local file="$1"
  local job
  local job_file
  local fields_file
  local services_file
  local env_file
  local defaults_file

  for job in reuse_pr_ci workflow quality frontend backend infrastructure e2e attest_pr_ci; do
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
      workflow)
        require_nonblank_lines "${fields_file}" \
          "    needs: reuse_pr_ci" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    steps:" || return 1
        ;;
      quality)
        require_nonblank_lines "${fields_file}" \
          "    name: Security, configuration, and documentation" \
          "    needs: reuse_pr_ci" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    timeout-minutes: 30" \
          "    steps:" || return 1
        ;;
      frontend | infrastructure)
        require_nonblank_lines "${fields_file}" \
          "    needs: reuse_pr_ci" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    steps:" || return 1
        ;;
      backend)
        require_nonblank_lines "${fields_file}" \
          "    needs: reuse_pr_ci" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    services:" \
          "    env:" \
          "    defaults:" \
          "    steps:" || return 1
        ;;
      e2e)
        require_nonblank_lines "${fields_file}" \
          "    needs: reuse_pr_ci" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    services:" \
          "    steps:" || return 1
        ;;
      attest_pr_ci)
        require_nonblank_lines "${fields_file}" \
          "    name: Attest tested PR tree" \
          "    needs:" \
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
    "        shell: bash" || return 1
}

validate_exact_functional_steps() {
  local file="$1"
  local job
  local job_file
  local steps_file
  for job in workflow frontend backend infrastructure e2e; do
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
  local attest_job="${test_root}/control-attest.job"
  local attest_steps="${test_root}/control-attest-steps.block"
  local expected_reuse_steps
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
  for filename in deploy.yml playbook.yml retire-legacy-origin.yml terraform-apply.yml terraform-plan.yml; do
    workflow_file="${directory}/${filename}"
    permissions_file="${test_root}/${filename}-permissions.block"
    extract_root_mapping "${workflow_file}" permissions >"${permissions_file}" || {
      violation "${filename} must define exactly one top-level permissions mapping"
      return 1
    }
    if [[ "$(awk '/^[[:space:]]*permissions:/ { count++ } END { print count + 0 }' "${workflow_file}")" != "1" ]]; then
      violation "${filename} must not define job-level permissions"
      return 1
    fi
    if [[ "${filename}" == "terraform-apply.yml" ]]; then
      require_nonblank_lines "${permissions_file}" \
        "  actions: write" \
        "  contents: read" || return 1
    elif [[ "${filename}" == "playbook.yml" ]]; then
      require_nonblank_lines "${permissions_file}" \
        "  contents: read" || return 1
    else
      require_nonblank_lines "${permissions_file}" \
        "  actions: read" \
        "  contents: read" || return 1
    fi
  done
}

validate_workflow() {
  local file="$1"
  local on_block="${test_root}/on.block"
  local permissions_block="${test_root}/permissions.block"
  local reuse_job="${test_root}/reuse.job"
  local reuse_permissions="${test_root}/reuse-permissions.block"
  local reuse_outputs="${test_root}/reuse-outputs.block"
  local reuse_resolver_step="${test_root}/reuse-resolver.step"
  local workflow_job="${test_root}/workflow.job"
  local actionlint_step="${test_root}/actionlint.step"
  local quality_job="${test_root}/quality.job"
  local quality_steps="${test_root}/quality-steps.block"
  local quality_shell_step="${test_root}/quality-shell.step"
  local quality_control_plane_step="${test_root}/quality-control-plane.step"
  local quality_docs_step="${test_root}/quality-docs.step"
  local quality_config_step="${test_root}/quality-config.step"
  local quality_security_step="${test_root}/quality-security.step"
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
  if grep -Eq '^(      - if:|        if:)' "${file}"; then
    violation "CI steps must not be conditionally skipped"
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

  validate_checkout_steps "${file}" || return 1
  validate_job_structure "${file}" || return 1
  validate_exact_functional_steps "${file}" || return 1
  validate_exact_control_steps "${file}" || return 1

  local full_job
  for full_job in workflow quality frontend backend infrastructure; do
    validate_full_job_fallback "${file}" "${full_job}" || return 1
  done

  extract_job "${file}" workflow >"${workflow_job}" || {
    violation "workflow job must exist exactly once"
    return 1
  }
  extract_named_step "${workflow_job}" "Validate GitHub Actions workflows" >"${actionlint_step}" || {
    violation "workflow job must contain exactly one canonical actionlint step"
    return 1
  }
  require_nonblank_lines "${actionlint_step}" \
    "      - name: Validate GitHub Actions workflows" \
    "        uses: docker://rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 # v1.7.12" \
    "        with:" \
    "          args: -color" || return 1
  [[ "$(awk '/uses:[[:space:]]*docker:\/\/rhysd\/actionlint:/ { count++ } END { print count + 0 }' "${file}")" == "1" ]] || {
    violation "CI must invoke exactly one canonical actionlint consumer"
    return 1
  }

  extract_job "${file}" quality >"${quality_job}" || {
    violation "quality job must exist exactly once"
    return 1
  }
  if grep -Eq '^    (defaults|env|container|services|strategy)[[:space:]]*:' "${quality_job}"; then
    violation "quality must not define defaults, env, container, services, or strategy"
    return 1
  fi
  if grep -Eq "^(      - |        )[\"']?if[\"']?[[:space:]]*:" "${quality_job}"; then
    violation "quality steps must run unconditionally when the quality job runs"
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
  # shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
  require_nonblank_lines "${quality_steps}" \
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
    "        with:" \
    "          fetch-depth: 0" \
    "          persist-credentials: false" \
    "      - name: Run security gates" \
    "        run: bash ./scripts/check-security.sh" \
    "      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0" \
    "        with:" \
    '          go-version: "1.27.0"' \
    "          cache-dependency-path: backend/go.sum" \
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
    "      - name: Validate Bash scripts" \
    "        run: bash ./scripts/check-shell.sh" \
    "      - name: Validate control-plane negative fixtures when applicable" \
    "        env:" \
    '          CONTROL_PLANE_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}' \
    '          CONTROL_PLANE_HEAD_SHA: ${{ github.sha }}' \
    '        run: bash ./scripts/check-control-plane-fixtures.sh --range "${CONTROL_PLANE_BASE_SHA}" "${CONTROL_PLANE_HEAD_SHA}"' \
    "      - name: Validate documentation" \
    "        run: bash ./scripts/check-docs.sh" \
    "      - name: Validate configuration parity" \
    "        run: bash ./scripts/check-config-parity.sh" || return 1
  extract_named_step "${quality_job}" "Validate Bash scripts" >"${quality_shell_step}" || {
    violation "quality must contain exactly one canonical Bash validation step"
    return 1
  }
  require_nonblank_lines "${quality_shell_step}" \
    "      - name: Validate Bash scripts" \
    "        run: bash ./scripts/check-shell.sh" || return 1
  extract_named_step "${quality_job}" "Validate control-plane negative fixtures when applicable" >"${quality_control_plane_step}" || {
    violation "quality must contain exactly one conservative control-plane fixture step"
    return 1
  }
  # shellcheck disable=SC2016 # Expected workflow expressions and shell variables are literals.
  require_nonblank_lines "${quality_control_plane_step}" \
    "      - name: Validate control-plane negative fixtures when applicable" \
    "        env:" \
    '          CONTROL_PLANE_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}' \
    '          CONTROL_PLANE_HEAD_SHA: ${{ github.sha }}' \
    '        run: bash ./scripts/check-control-plane-fixtures.sh --range "${CONTROL_PLANE_BASE_SHA}" "${CONTROL_PLANE_HEAD_SHA}"' || return 1
  extract_named_step "${quality_job}" "Validate documentation" >"${quality_docs_step}" || {
    violation "quality must contain exactly one canonical documentation validation step"
    return 1
  }
  require_nonblank_lines "${quality_docs_step}" \
    "      - name: Validate documentation" \
    "        run: bash ./scripts/check-docs.sh" || return 1
  extract_named_step "${quality_job}" "Validate configuration parity" >"${quality_config_step}" || {
    violation "quality must contain exactly one canonical configuration validation step"
    return 1
  }
  require_nonblank_lines "${quality_config_step}" \
    "      - name: Validate configuration parity" \
    "        run: bash ./scripts/check-config-parity.sh" || return 1
  extract_named_step "${quality_job}" "Run security gates" >"${quality_security_step}" || {
    violation "quality must contain exactly one canonical security validation step"
    return 1
  }
  require_nonblank_lines "${quality_security_step}" \
    "      - name: Run security gates" \
    "        run: bash ./scripts/check-security.sh" || return 1

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
  require_exact_line "${e2e_job}" "    needs: reuse_pr_ci" || return 1
  extract_job_if "${e2e_job}" >"${e2e_if}" || {
    violation "e2e must define one dependency condition"
    return 1
  }
  require_nonblank_lines "${e2e_if}" \
    "    if: >-" \
    "      always() &&" \
    "      (github.event_name == 'pull_request' ||" \
    "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true')" || return 1

  extract_job "${file}" attest_pr_ci >"${attestation_job}" || {
    violation "attest_pr_ci job must exist exactly once"
    return 1
  }
  require_exact_line "${attestation_job}" "    needs:" || return 1
  require_exact_line "${attestation_job}" \
    "      [reuse_pr_ci, workflow, quality, frontend, backend, infrastructure, e2e]" || return 1
  extract_job_if "${attestation_job}" >"${attestation_if}" || {
    violation "attest_pr_ci must define one dependency condition"
    return 1
  }
  require_nonblank_lines "${attestation_if}" \
    "    if: >-" \
    "      always() &&" \
    "      github.event_name == 'pull_request' &&" \
    "      needs.reuse_pr_ci.result == 'skipped' &&" \
    "      needs.workflow.result == 'success' &&" \
    "      needs.quality.result == 'success' &&" \
    "      needs.frontend.result == 'success' &&" \
    "      needs.backend.result == 'success' &&" \
    "      needs.infrastructure.result == 'success' &&" \
    "      needs.e2e.result == 'success'" || return 1
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
  for filename in ci.yml deploy.yml playbook.yml retire-legacy-origin.yml terraform-apply.yml terraform-plan.yml; do
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

if (($# > 1)); then
  fail "Usage: ./scripts/tests/check-ci-security-model.sh [workflow-file]"
fi

validate_workflow "${workflow}" || fail "CI workflow does not satisfy the security model"
validate_all_workflows "${workflow_dir}" || fail "GitHub Actions workflows do not satisfy the shared security model"

workflow_set="$(new_workflow_set_fixture unexpected-yaml-workflow)"
cp -- "${workflow_set}/deploy.yml" "${workflow_set}/bypass.yaml"
assert_invalid_workflow_set "unexpected .yaml workflow" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture missing-playbook-workflow)"
unlink -- "${workflow_set}/playbook.yml"
assert_invalid_workflow_set "missing Playbook policy workflow" "${workflow_set}"

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
  '          artifact_name="$(' \
  '          mapfile -t artifact_names < <('
assert_invalid_workflow_set "Terraform Apply process-substitution artifact parser" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-plan-anonymous-step)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1" \
  $'      - run: true\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'
assert_invalid_workflow_set "Terraform Plan anonymous step" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-extra-named-step)"
replace_line_once "${workflow_set}/terraform-apply.yml" \
  "      - name: Download approved saved plan" \
  $'      - name: Read job credentials\n        run: true\n\n      - name: Download approved saved plan'
assert_invalid_workflow_set "Terraform Apply extra named step" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture terraform-apply-run-change)"
replace_line_once "${workflow_set}/terraform-apply.yml" \
  "        run: terraform apply -input=false -no-color staging.tfplan" \
  "        run: true"
assert_invalid_workflow_set "Terraform Apply run change" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-missing-pre-approval-main-identity-guard)"
remove_named_step "${workflow_set}/deploy.yml" \
  "Re-verify deployment commit before Staging approval"
assert_invalid_workflow_set "Deploy missing pre-approval main identity guard" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-pre-approval-main-identity-guard-too-early)"
move_named_step_before "${workflow_set}/deploy.yml" \
  "Re-verify deployment commit before Staging approval" \
  "Verify approved Terraform Apply metadata"
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

workflow_set="$(new_workflow_set_fixture terraform-plan-action-change)"
replace_line_once "${workflow_set}/terraform-plan.yml" \
  "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1" \
  "        uses: actions/upload-artifact@main"
assert_invalid_workflow_set "Terraform Plan action change" "${workflow_set}"

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

workflow_set="$(new_workflow_set_fixture deploy-extra-job)"
replace_line_once "${workflow_set}/deploy.yml" \
  "  deploy:" \
  $'  exfiltrate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  deploy:'
assert_invalid_workflow_set "deploy extra job" "${workflow_set}"

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

fixture="$(new_fixture extra-ci-job)"
replace_line_once "${fixture}" \
  "  workflow:" \
  $'  bypass:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  workflow:'
assert_invalid "extra CI job" "${fixture}"

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

fixture="$(new_fixture reuse-anonymous-step)"
replace_job_line "${fixture}" reuse_pr_ci \
  "      - name: Resolve reusable PR CI attestation" \
  $'      - run: true\n      - name: Resolve reusable PR CI attestation'
assert_invalid "reuse anonymous step" "${fixture}"

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

fixture="$(new_fixture attest-anonymous-step)"
replace_job_line "${fixture}" attest_pr_ci \
  "      - name: Write tested tree attestation" \
  $'      - run: true\n      - name: Write tested tree attestation'
assert_invalid "attestation anonymous step" "${fixture}"

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
replace_job_line "${fixture}" quality "          fetch-depth: 0" "          fetch-depth: 1"
replace_job_line "${fixture}" quality "          runtime: node@24" \
  $'          runtime: node@24\n          fetch-depth: 0'
assert_invalid "full-history fetch-depth outside checkout" "${fixture}"

for full_job in workflow quality frontend backend infrastructure e2e; do
  fallback_line="      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true')"
  bypassed_fallback_line="      needs.reuse_pr_ci.outputs.reuse_pr_ci == 'false')"

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
  "    needs: reuse_pr_ci" \
  "    needs: [reuse_pr_ci, quality]"
assert_invalid "workflow serialized behind quality" "${fixture}"

fixture="$(new_fixture serialized-frontend-behind-quality)"
replace_job_line "${fixture}" frontend \
  "    needs: reuse_pr_ci" \
  "    needs: [reuse_pr_ci, quality]"
assert_invalid "frontend serialized behind quality" "${fixture}"

fixture="$(new_fixture serialized-backend-behind-quality)"
replace_job_line "${fixture}" backend \
  "    needs: reuse_pr_ci" \
  "    needs: [reuse_pr_ci, quality]"
assert_invalid "backend serialized behind quality" "${fixture}"

fixture="$(new_fixture serialized-infrastructure-behind-quality)"
replace_job_line "${fixture}" infrastructure \
  "    needs: reuse_pr_ci" \
  "    needs: [reuse_pr_ci, quality]"
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
replace_job_line "${fixture}" quality "          fetch-depth: 0" "          fetch-depth: 1"
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
security|Run security gates|bash ./scripts/check-security.sh
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
  "        run: bash ./scripts/check-security.sh" \
  ""
replace_job_line "${fixture}" quality \
  "      - run: pnpm install --frozen-lockfile --ignore-scripts" \
  $'      - run: pnpm install --frozen-lockfile --ignore-scripts\n      - name: Run security gates\n        run: bash ./scripts/check-security.sh'
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
assert_invalid "renamed quality candidate tree guard" "${fixture}"

fixture="$(new_fixture tagged-security-step-key)"
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        !!str if: github.ref == github.sha\n        run: bash ./scripts/check-security.sh'
assert_invalid "tagged key in security gate" "${fixture}"

fixture="$(new_fixture omitted-security-gate)"
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  "        run: printf 'security skipped\\n'"
assert_invalid "omitted security gate" "${fixture}"

fixture="$(new_fixture tolerated-security-failure)"
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        continue-on-error: true\n        run: bash ./scripts/check-security.sh'
assert_invalid "tolerated security failure" "${fixture}"

fixture="$(new_fixture skipped-security-step)"
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        if: false\n        run: bash ./scripts/check-security.sh'
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
  "        run: bash ./scripts/check-security.sh" \
  $'        "if": github.ref == github.sha\n        run: bash ./scripts/check-security.sh'
assert_invalid "quoted skipped security step" "${fixture}"

fixture="$(new_fixture quoted-tolerated-security-failure)"
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        \'continue-on-error\': true\n        run: bash ./scripts/check-security.sh'
assert_invalid "quoted tolerated security failure" "${fixture}"

fixture="$(new_fixture quoted-security-shell-suppresses-failure)"
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        "shell": bash {0} || true\n        run: bash ./scripts/check-security.sh'
assert_invalid "quoted security shell suppresses failure" "${fixture}"

fixture="$(new_fixture security-shell-suppresses-failure)"
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        shell: bash {0} || true\n        run: bash ./scripts/check-security.sh'
assert_invalid "security shell suppresses failure" "${fixture}"

fixture="$(new_fixture anchored-quality-if)"
replace_job_line "${fixture}" workflow \
  "        run: bash .github/scripts/resolve-ci-reuse.test.sh" \
  $'        env:\n          KEY_NAME: &if_key if\n        run: bash .github/scripts/resolve-ci-reuse.test.sh'
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        *if_key: github.ref == github.sha\n        run: bash ./scripts/check-security.sh'
assert_invalid "anchored quality if key" "${fixture}"

fixture="$(new_fixture anchored-quality-continue-on-error)"
replace_job_line "${fixture}" workflow \
  "        run: bash .github/scripts/resolve-ci-reuse.test.sh" \
  $'        env:\n          KEY_NAME: &continue_key continue-on-error\n        run: bash .github/scripts/resolve-ci-reuse.test.sh'
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        *continue_key: true\n        run: bash ./scripts/check-security.sh'
assert_invalid "anchored quality continue-on-error key" "${fixture}"

fixture="$(new_fixture anchored-quality-shell)"
replace_job_line "${fixture}" workflow \
  "        run: bash .github/scripts/resolve-ci-reuse.test.sh" \
  $'        env:\n          KEY_NAME: &shell_key shell\n        run: bash .github/scripts/resolve-ci-reuse.test.sh'
replace_job_line "${fixture}" quality \
  "        run: bash ./scripts/check-security.sh" \
  $'        *shell_key: bash {0} || true\n        run: bash ./scripts/check-security.sh'
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
  "    needs: reuse_pr_ci" \
  "    needs: [reuse_pr_ci, quality]"
assert_invalid "E2E serialized behind quality" "${fixture}"

fixture="$(new_fixture attestation-quality-bypass)"
replace_job_line "${fixture}" attest_pr_ci \
  "      needs.quality.result == 'success' &&" \
  "      needs.quality.result != 'failure' &&"
assert_invalid "attestation quality bypass" "${fixture}"

fixture="$(new_fixture omitted-cleanup-build)"
replace_job_line "${fixture}" backend \
  "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/cleanup" \
  "      - run: GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build ./cmd/server"
assert_invalid "omitted cleanup command build" "${fixture}"

printf '%s\n' "CI workflow security model tests passed."
