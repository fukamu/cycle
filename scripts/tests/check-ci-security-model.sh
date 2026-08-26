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
    /^      - uses: actions\/checkout@[^[:space:]]+$/ {
      parsed_uses++
      active = 1
    }
    active && $0 !~ /^      - uses: actions\/checkout@[^[:space:]]+$/ && /^      - / {
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
    terraform-apply)
      expected_name="name: Terraform Apply Staging"
      expected_root_fields="$(printf '%s\n' name on permissions concurrency jobs)"
      expected_jobs="$(printf '%s\n' preflight apply)"
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
      expected_digest="094ebf026e6493f7d13398668771e19e19e99c336a1f254bb20acceb9ed28a44"
      ;;
    terraform-plan)
      expected_digest="c06fb1aaeebabb2b5311c26cdd711144f15c511241fbfc165204c7f06196b949"
      ;;
    terraform-apply)
      expected_digest="b3aad3beb9f05f9662c183994657b42e6102efcfdac24d45d819b8af9a361af9"
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
    /^      - uses: actions\/checkout@[^[:space:]]+$/ {
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
deploy.yml|1
terraform-apply.yml|2
terraform-plan.yml|0
JSON_PARSER_INVENTORY
}

validate_all_workflows() {
  local directory="$1"
  local expected_inventory
  local actual_inventory
  expected_inventory="$(printf '%s\n' ci.yml deploy.yml terraform-apply.yml terraform-plan.yml)"
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
terraform-apply.yml|1|terraform-apply
terraform-plan.yml|1|terraform-plan
WORKFLOW_CHECKOUT_INVENTORY
  validate_json_parser_completion_contract "${directory}" || return 1
  validate_workflow_permissions_contract "${directory}" || return 1
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
  if [[ "${job}" == "quality" ]]; then
    require_exact_line "${job_file}" "    needs: reuse_pr_ci" || return 1
  else
    require_exact_line "${job_file}" "    needs: [reuse_pr_ci, quality]" || return 1
  fi
  extract_job_if "${job_file}" >"${if_file}" || {
    violation "${job} must define one fallback condition"
    return 1
  }
  if [[ "${job}" == "quality" ]]; then
    require_nonblank_lines "${if_file}" \
      "    if: >-" \
      "      always() &&" \
      "      (github.event_name == 'pull_request' ||" \
      "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true')"
  else
    require_nonblank_lines "${if_file}" \
      "    if: >-" \
      "      always() &&" \
      "      (github.event_name == 'pull_request' ||" \
      "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true') &&" \
      "      needs.quality.result == 'success'"
  fi
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
          "    needs: [reuse_pr_ci, quality]" \
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
          "    needs: [reuse_pr_ci, quality]" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    steps:" || return 1
        ;;
      backend)
        require_nonblank_lines "${fields_file}" \
          "    needs: [reuse_pr_ci, quality]" \
          "    if: >-" \
          "    runs-on: ubuntu-latest" \
          "    services:" \
          "    env:" \
          "    defaults:" \
          "    steps:" || return 1
        ;;
      e2e)
        require_nonblank_lines "${fields_file}" \
          "    needs: [reuse_pr_ci, workflow, quality, frontend, backend, infrastructure]" \
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
      "        image: postgres:18.6-alpine3.24" \
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
          "      - uses: actions/checkout@v7" \
          "        with:" \
          "          persist-credentials: false" \
          "      - name: Test CI reuse resolver" \
          "        run: bash .github/scripts/resolve-ci-reuse.test.sh" \
          "      - name: Validate GitHub Actions workflows" \
          "        uses: docker://rhysd/actionlint:1.7.12" \
          "        with:" \
          "          args: -color" || return 1
        ;;
      frontend)
        # shellcheck disable=SC2016 # Expected workflow/fixture command is a literal.
        require_nonblank_lines "${steps_file}" \
          "      - uses: actions/checkout@v7" \
          "        with:" \
          "          persist-credentials: false" \
          "      - uses: pnpm/setup@c9883cc79df532ad1a7b81bf9ab944ceb090d65c" \
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
          "      - uses: actions/checkout@v7" \
          "        with:" \
          "          persist-credentials: false" \
          "      - uses: actions/setup-go@v7" \
          "        with:" \
          '          go-version: "1.26.6"' \
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
          "      - uses: actions/checkout@v7" \
          "        with:" \
          "          persist-credentials: false" \
          "      - uses: pnpm/setup@c9883cc79df532ad1a7b81bf9ab944ceb090d65c" \
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
          "      - uses: hashicorp/setup-terraform@v4" \
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
          "      - uses: actions/checkout@v7" \
          "        with:" \
          "          persist-credentials: false" \
          "      - uses: pnpm/setup@c9883cc79df532ad1a7b81bf9ab944ceb090d65c" \
          "        with:" \
          "          runtime: node@24" \
          "          cache: true" \
          "          install: false" \
          "      - uses: actions/setup-go@v7" \
          "        with:" \
          '          go-version: "1.26.6"' \
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
      - uses: actions/checkout@v7
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
      - uses: actions/checkout@v7
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
        uses: actions/upload-artifact@v7
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
  for filename in deploy.yml terraform-apply.yml terraform-plan.yml; do
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
    "        uses: docker://rhysd/actionlint:1.7.12" \
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
    "      - uses: actions/checkout@v7" \
    "        with:" \
    "          fetch-depth: 0" \
    "          persist-credentials: false" \
    "      - name: Run security gates" \
    "        run: bash ./scripts/check-security.sh" \
    "      - uses: pnpm/setup@c9883cc79df532ad1a7b81bf9ab944ceb090d65c" \
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
    "      - name: Validate Bash scripts and negative fixtures" \
    "        run: bash ./scripts/check-shell.sh" \
    "      - name: Validate documentation" \
    "        run: bash ./scripts/check-docs.sh" \
    "      - name: Validate configuration parity" \
    "        run: bash ./scripts/check-config-parity.sh" || return 1
  extract_named_step "${quality_job}" "Validate Bash scripts and negative fixtures" >"${quality_shell_step}" || {
    violation "quality must contain exactly one canonical Bash validation step"
    return 1
  }
  require_nonblank_lines "${quality_shell_step}" \
    "      - name: Validate Bash scripts and negative fixtures" \
    "        run: bash ./scripts/check-shell.sh" || return 1
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
  require_exact_line "${e2e_job}" \
    "    needs: [reuse_pr_ci, workflow, quality, frontend, backend, infrastructure]" || return 1
  extract_job_if "${e2e_job}" >"${e2e_if}" || {
    violation "e2e must define one dependency condition"
    return 1
  }
  require_nonblank_lines "${e2e_if}" \
    "    if: >-" \
    "      always() &&" \
    "      (github.event_name == 'pull_request' ||" \
    "      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true') &&" \
    "      needs.workflow.result == 'success' &&" \
    "      needs.quality.result == 'success' &&" \
    "      needs.frontend.result == 'success' &&" \
    "      needs.backend.result == 'success' &&" \
    "      needs.infrastructure.result == 'success'" || return 1

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
  for filename in ci.yml deploy.yml terraform-apply.yml terraform-plan.yml; do
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

workflow_set="$(new_workflow_set_fixture deploy-trigger-workflow-change)"
replace_line_once "${workflow_set}/deploy.yml" \
  "    workflows: [Terraform Apply Staging]" \
  "    workflows: [Terraform Apply Staging Renamed]"
assert_invalid_workflow_set "Deploy trigger workflow change" "${workflow_set}"

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
  "      - uses: actions/checkout@v7" \
  $'      - run: true\n      - uses: actions/checkout@v7'
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

workflow_set="$(new_workflow_set_fixture deploy-missing-pre-migration-main-identity-guard)"
remove_named_step "${workflow_set}/deploy.yml" \
  "Re-verify deployment commit is still main HEAD"
assert_invalid_workflow_set "Deploy missing pre-migration main identity guard" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-pre-migration-main-identity-guard-too-early)"
move_named_step_before "${workflow_set}/deploy.yml" \
  "Re-verify deployment commit is still main HEAD" \
  "Build static frontend"
assert_invalid_workflow_set "Deploy pre-migration main identity guard placed too early" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-missing-post-migration-main-identity-guard)"
remove_named_step "${workflow_set}/deploy.yml" \
  "Re-verify deployment commit after migrations"
assert_invalid_workflow_set "Deploy missing post-migration main identity guard" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-post-migration-main-identity-guard-too-early)"
move_named_step_before "${workflow_set}/deploy.yml" \
  "Re-verify deployment commit after migrations" \
  "Apply database migrations"
assert_invalid_workflow_set "Deploy post-migration main identity guard placed too early" "${workflow_set}"

workflow_set="$(new_workflow_set_fixture deploy-post-migration-main-identity-guard-too-late)"
move_named_step_before "${workflow_set}/deploy.yml" \
  "Create ephemeral Worker secrets file" \
  "Re-verify deployment commit after migrations"
assert_invalid_workflow_set "Deploy post-migration main identity guard placed after secret materialization" "${workflow_set}"

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
  "        uses: actions/upload-artifact@v7" \
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
  "    timeout-minutes: 30" \
  $'    timeout-minutes: 30\n    defaults:\n      run:\n        shell: bash {0} || true'
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
  "        uses: actions/upload-artifact@v7" \
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
  "      - uses: actions/checkout@v7" \
  $'      - uses: actions/checkout@v7\n        with:\n          persist-credentials: false\n      - uses: actions/checkout@v7'
assert_invalid "duplicate quality checkout" "${fixture}"

fixture="$(new_fixture misplaced-full-history-fetch)"
replace_job_line "${fixture}" quality "          fetch-depth: 0" "          fetch-depth: 1"
replace_job_line "${fixture}" quality "          runtime: node@24" \
  $'          runtime: node@24\n          fetch-depth: 0'
assert_invalid "full-history fetch-depth outside checkout" "${fixture}"

for full_job in workflow quality frontend backend infrastructure; do
  fallback_line="      needs.reuse_pr_ci.outputs.reuse_pr_ci != 'true')"
  bypassed_fallback_line="      needs.reuse_pr_ci.outputs.reuse_pr_ci == 'false')"
  if [[ "${full_job}" != "quality" ]]; then
    fallback_line+=" &&"
    bypassed_fallback_line+=" &&"
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

fixture="$(new_fixture omitted-workflow-quality-dependency)"
replace_job_line "${fixture}" workflow \
  "    needs: [reuse_pr_ci, quality]" \
  "    needs: reuse_pr_ci"
assert_invalid "workflow without quality dependency" "${fixture}"

fixture="$(new_fixture bypassed-frontend-quality-result)"
replace_job_line "${fixture}" frontend \
  "      needs.quality.result == 'success'" \
  "      needs.quality.result != 'failure'"
assert_invalid "frontend with bypassed quality result" "${fixture}"

fixture="$(new_fixture omitted-backend-quality-result)"
replace_job_line "${fixture}" backend \
  "      needs.quality.result == 'success'" \
  "      true"
assert_invalid "backend without quality result requirement" "${fixture}"

fixture="$(new_fixture omitted-infrastructure-quality-dependency)"
replace_job_line "${fixture}" infrastructure \
  "    needs: [reuse_pr_ci, quality]" \
  "    needs: [reuse_pr_ci]"
assert_invalid "infrastructure without quality dependency" "${fixture}"

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
  "        uses: docker://rhysd/actionlint:1.7.12" \
  "        uses: docker://rhysd/actionlint:latest"
assert_invalid "replaced actionlint consumer" "${fixture}"

fixture="$(new_fixture skipped-actionlint-step)"
replace_job_line "${fixture}" workflow \
  "      - name: Validate GitHub Actions workflows" \
  $'      - if: false\n        name: Validate GitHub Actions workflows'
assert_invalid "skipped actionlint step" "${fixture}"

while IFS='|' read -r gate_slug gate_name gate_run; do
  fixture="$(new_fixture "duplicate-${gate_slug}-gate")"
  duplicate_gate_step="$(printf '      - name: %s\n        run: %s\n      - name: %s' \
    "${gate_name}" "${gate_run}" "${gate_name}")"
  replace_job_line "${fixture}" quality \
    "      - name: ${gate_name}" \
    "${duplicate_gate_step}"
  assert_invalid "duplicate ${gate_name} quality gate" "${fixture}"
done <<'QUALITY_GATES'
shell|Validate Bash scripts and negative fixtures|bash ./scripts/check-shell.sh
docs|Validate documentation|bash ./scripts/check-docs.sh
config|Validate configuration parity|bash ./scripts/check-config-parity.sh
security|Run security gates|bash ./scripts/check-security.sh
QUALITY_GATES

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

fixture="$(new_fixture e2e-quality-bypass)"
replace_job_line "${fixture}" e2e \
  "      needs.quality.result == 'success' &&" \
  "      needs.quality.result != 'failure' &&"
assert_invalid "E2E quality bypass" "${fixture}"

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
