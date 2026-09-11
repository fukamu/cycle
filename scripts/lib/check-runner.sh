# shellcheck shell=bash

# This file is a source-only implementation detail shared by check.sh and the
# staged commit gate. It deliberately omits the full security profile; callers
# own that ordering and this helper is not a standalone validation gate.

run_cycle_checks_after_security() {
  local repo_root="$1"
  local script_dir="$2"
  local scope="$3"
  local run_e2e="$4"
  local run_frontend=false
  local run_backend=false
  local run_infrastructure=false
  local run_repository_quality=false

  [[ "${scope}" == "all" || "${scope}" == "frontend" ]] && run_frontend=true
  [[ "${scope}" == "all" || "${scope}" == "backend" ]] && run_backend=true
  [[ "${scope}" == "all" || "${scope}" == "infrastructure" ]] && run_infrastructure=true
  [[ "${scope}" == "all" ]] && run_repository_quality=true

  if [[ "${run_repository_quality}" == "true" ]]; then
    "${script_dir}/check-docs.sh"
    "${script_dir}/check-config-parity.sh"
    "${script_dir}/check-control-plane-fixtures.sh" --working-tree
  fi

  if [[ "${run_frontend}" == "true" ]]; then
    require_command pnpm
    [[ -d "${repo_root}/node_modules" ]] \
      || die "node_modules is missing. Run ./scripts/setup.sh first."
    (
      cd -- "${repo_root}" || exit 1
      pnpm --filter fukamu-cycle-frontend --fail-if-no-match run format:check
      pnpm --filter fukamu-cycle-frontend --fail-if-no-match run lint
      pnpm --filter fukamu-cycle-frontend --fail-if-no-match run typecheck
      pnpm --filter fukamu-cycle-frontend --fail-if-no-match test
      if [[ "${run_e2e}" == "true" ]]; then
        export VITE_GOOGLE_WEB_CLIENT_ID="fukamu-cycle-e2e-client"
      fi
      pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build
    )
  fi

  if [[ "${run_backend}" == "true" ]]; then
    require_command go
    require_command git
    require_command diff
    (
      generated_dir="${repo_root}/backend/internal/infrastructure/postgres/generated"
      generated_snapshot="$(mktemp -d)"
      trap 'rm -rf -- "${generated_snapshot}"' EXIT
      cp -R -- "${generated_dir}/." "${generated_snapshot}/"

      "${script_dir}/invoke-sqlc.sh" compile generate
      if ! diff -ru -- "${generated_snapshot}" "${generated_dir}"; then
        die "sqlc generate changed generated code. Review and stage the generated files, then rerun checks."
      fi
      rm -rf -- "${generated_snapshot}"
      trap - EXIT

      cd -- "${repo_root}/backend" || exit 1
      untracked_generated="$(
        trusted_git ls-files --others --exclude-standard -- \
          internal/infrastructure/postgres/generated
      )"
      [[ -z "${untracked_generated}" ]] \
        || die "Untracked generated sqlc files must be reviewed and added: ${untracked_generated//$'\n'/, }"

      unformatted="$(gofmt -l .)"
      [[ -z "${unformatted}" ]] \
        || die "gofmt is required for: ${unformatted//$'\n'/, }"

      GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go vet ./...
      GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go test -count=1 ./...

      mkdir -p -- "${repo_root}/.tmp/check"
      GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -buildvcs=false -o "${repo_root}/.tmp/check/server" ./cmd/server
      GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -buildvcs=false -o "${repo_root}/.tmp/check/migrate" ./cmd/migrate
      GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -buildvcs=false -o "${repo_root}/.tmp/check/cleanup" ./cmd/cleanup
      GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -buildvcs=false -o "${repo_root}/.tmp/check/configcheck" ./cmd/configcheck
    )
  fi

  if [[ "${run_infrastructure}" == "true" ]]; then
    require_terraform_version
    require_command pnpm
    require_command docker
    require_local_docker_context >/dev/null
    "${script_dir}/check-docker-context.sh"
    "${script_dir}/check-shell.sh"

    docker compose --file "${repo_root}/compose.local.yaml" config --quiet
    (
      export TF_DATA_DIR="${repo_root}/.tmp/terraform-check"
      mkdir -p -- "${TF_DATA_DIR}"
      cd -- "${repo_root}/infra/terraform/staging" || exit 1
      terraform fmt -check -recursive .
      terraform init -backend=false -input=false
      terraform validate
    )

    [[ -d "${repo_root}/node_modules" ]] \
      || die "node_modules is missing. Run ./scripts/setup.sh first."
    if [[ ! -f "${repo_root}/frontend/dist/index.html" ]]; then
      (
        cd -- "${repo_root}" || exit 1
        pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build
      )
    fi
    (
      cd -- "${repo_root}" || exit 1
      export XDG_CONFIG_HOME="${repo_root}/cloudflare/.wrangler/config"
      pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match run check
      pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match run deploy:dry-run
    )
  fi

  if [[ "${run_e2e}" == "true" ]]; then
    require_disposable_test_database_url "${TEST_DATABASE_URL:-}"
    (
      cd -- "${repo_root}" || exit 1
      unset FUKAMU_CYCLE_GO_BINARY FUKAMU_CYCLE_SERVER_BINARY
      CI=true pnpm --filter fukamu-cycle-frontend --fail-if-no-match run test:e2e
    )
  fi

  printf '%s\n' "Checks completed successfully."
}
