#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
scope="all"
run_e2e=false

usage() {
  cat <<'EOF'
Usage: ./scripts/check.sh [--scope all|frontend|backend|infrastructure] [--e2e]

Run repository checks by scope. --e2e requires --scope all and a disposable
localhost TEST_DATABASE_URL whose database name ends in _test.
EOF
}

while (($# > 0)); do
  case "$1" in
    --scope)
      (($# >= 2)) || die "--scope requires a value."
      scope="$2"
      shift 2
      ;;
    --e2e)
      run_e2e=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

case "${scope}" in
  all | frontend | backend | infrastructure) ;;
  *) die "--scope must be all, frontend, backend, or infrastructure." ;;
esac
if [[ "${run_e2e}" == "true" && "${scope}" != "all" ]]; then
  die "--e2e requires --scope all because it starts both the frontend build and backend server."
fi

run_frontend=false
run_backend=false
run_infrastructure=false
[[ "${scope}" == "all" || "${scope}" == "frontend" ]] && run_frontend=true
[[ "${scope}" == "all" || "${scope}" == "backend" ]] && run_backend=true
[[ "${scope}" == "all" || "${scope}" == "infrastructure" ]] && run_infrastructure=true

if [[ "${run_frontend}" == "true" ]]; then
  require_command pnpm
  [[ -d "${repo_root}/node_modules" ]] \
    || die "node_modules is missing. Run ./scripts/setup.sh first."
  (
    cd -- "${repo_root}"
    pnpm --filter fukamu-cycle-frontend run format:check
    pnpm --filter fukamu-cycle-frontend run lint
    pnpm --filter fukamu-cycle-frontend run typecheck
    pnpm --filter fukamu-cycle-frontend test
    if [[ "${run_e2e}" == "true" ]]; then
      export VITE_GOOGLE_WEB_CLIENT_ID="fukamu-cycle-e2e-client"
    fi
    pnpm --filter fukamu-cycle-frontend run build
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

    cd -- "${repo_root}/backend"
    untracked_generated="$(
      git ls-files --others --exclude-standard -- \
        internal/infrastructure/postgres/generated
    )"
    [[ -z "${untracked_generated}" ]] \
      || die "Untracked generated sqlc files must be reviewed and added: ${untracked_generated//$'\n'/, }"

    unformatted="$(gofmt -l .)"
    [[ -z "${unformatted}" ]] \
      || die "gofmt is required for: ${unformatted//$'\n'/, }"

    go vet ./...
    go test -count=1 ./...

    mkdir -p -- "${repo_root}/.tmp/check"
    go build -o "${repo_root}/.tmp/check/server" ./cmd/server
    go build -o "${repo_root}/.tmp/check/migrate" ./cmd/migrate
    go build -o "${repo_root}/.tmp/check/cleanup" ./cmd/cleanup
    go build -o "${repo_root}/.tmp/check/configcheck" ./cmd/configcheck
  )
fi

if [[ "${run_infrastructure}" == "true" ]]; then
  require_command terraform
  require_command pnpm
  require_command docker
  require_local_docker_context >/dev/null
  "${script_dir}/check-docker-context.sh"
  "${script_dir}/check-shell.sh"

  docker compose --file "${repo_root}/compose.local.yaml" config --quiet
  (
    export TF_DATA_DIR="${repo_root}/.tmp/terraform-check"
    mkdir -p -- "${TF_DATA_DIR}"
    cd -- "${repo_root}/infra/terraform/staging"
    terraform fmt -check -recursive .
    terraform init -backend=false -input=false
    terraform validate
  )

  [[ -d "${repo_root}/node_modules" ]] \
    || die "node_modules is missing. Run ./scripts/setup.sh first."
  if [[ ! -f "${repo_root}/frontend/dist/index.html" ]]; then
    (
      cd -- "${repo_root}"
      pnpm --filter fukamu-cycle-frontend run build
    )
  fi
  (
    cd -- "${repo_root}"
    export XDG_CONFIG_HOME="${repo_root}/cloudflare/.wrangler/config"
    pnpm --filter fukamu-cycle-cloudflare run check
    pnpm --filter fukamu-cycle-cloudflare run deploy:dry-run
  )
fi

if [[ "${run_e2e}" == "true" ]]; then
  require_disposable_test_database_url "${TEST_DATABASE_URL:-}"
  (
    cd -- "${repo_root}"
    unset FUKAMU_CYCLE_GO_BINARY FUKAMU_CYCLE_SERVER_BINARY
    CI=true pnpm --filter fukamu-cycle-frontend run test:e2e
  )
fi

printf '%s\n' "Checks completed successfully."
