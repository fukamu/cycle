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

pass() {
  printf 'ok - %s\n' "$1"
}

assert_failure_contains() {
  local description="$1"
  local expected="$2"
  shift 2
  local output="${test_root}/last-output"
  if "$@" >"${output}" 2>&1; then
    fail "${description} unexpectedly succeeded"
  fi
  grep -Fq -- "${expected}" "${output}" \
    || fail "${description} did not report ${expected}"
}

copy_gate_scripts() {
  local fixture="$1"
  mkdir -p -- "${fixture}/scripts/lib"
  cp -- "${repo_root}/.gitignore" "${fixture}/.gitignore"
  cp -- "${repo_root}/scripts/lib/common.sh" "${fixture}/scripts/lib/common.sh"
  cp -- \
    "${repo_root}/scripts/lib/docs-config-candidate-snapshot.sh" \
    "${fixture}/scripts/lib/docs-config-candidate-snapshot.sh"
  cp -- "${repo_root}/scripts/check-docs.sh" "${fixture}/scripts/check-docs.sh"
  cp -- "${repo_root}/scripts/check-docs.mjs" "${fixture}/scripts/check-docs.mjs"
  cp -- "${repo_root}/scripts/check-config-parity.sh" "${fixture}/scripts/check-config-parity.sh"
  chmod +x "${fixture}/scripts/check-docs.sh" "${fixture}/scripts/check-config-parity.sh"
}

initialize_candidate_fixture() {
  local fixture="$1"
  git -C "${fixture}" -c init.defaultBranch=main init --quiet \
    || fail "fixture Git repository initialization failed"
  git -C "${fixture}" add --all \
    || fail "fixture Git candidate initialization failed"
}

write_installed_tool_proxy() {
  local fixture="$1"
  local name="$2"
  local source="$3"
  local package_dir="${fixture}/node_modules/${name}"
  mkdir -p -- "${package_dir}"
  printf '%s\n' \
    '{' \
    "  \"name\": \"${name}\"," \
    '  "version": "0.0.0",' \
    '  "type": "module",' \
    '  "exports": {' \
    '    ".": "./index.mjs",' \
    '    "./package.json": "./package.json"' \
    '  }' \
    '}' >"${package_dir}/package.json"
  if [[ -n "${source}" ]]; then
    printf 'export { default } from "%s";\n' "${source}" \
      >"${package_dir}/index.mjs"
  else
    printf '%s\n' 'export default {};' >"${package_dir}/index.mjs"
  fi
}

replace_installed_tools_with_mismatched_manifests() {
  local fixture="$1"
  [[ -L "${fixture}/node_modules" ]] \
    || fail "documentation fixture node_modules must begin as a symlink"
  rm -- "${fixture}/node_modules"
  mkdir -p -- "${fixture}/node_modules"
  write_installed_tool_proxy \
    "${fixture}" \
    "markdown-it" \
    "file://${repo_root}/node_modules/markdown-it/dist/markdown-it.mjs"
  write_installed_tool_proxy \
    "${fixture}" \
    "github-slugger" \
    "file://${repo_root}/node_modules/github-slugger/index.js"
  write_installed_tool_proxy "${fixture}" "mermaid" ""
}

new_docs_fixture() {
  local name="$1"
  local fixture="${test_root}/docs-${name}"
  copy_gate_scripts "${fixture}"
  mkdir -p -- "${fixture}/docs"
  cp -- "${repo_root}/package.json" "${fixture}/package.json"
  ln -s -- "${repo_root}/node_modules" "${fixture}/node_modules"
  printf '%s\n' '/node_modules' >>"${fixture}/.gitignore"
  cp -- "${repo_root}/scripts/fixtures/docs-valid.fixture" "${fixture}/README.md"
  cp -- "${repo_root}/scripts/fixtures/docs-target.fixture" "${fixture}/docs/guide.md"
  touch "${fixture}/docs/pixel.png"

  printf '%s\n' \
    '' \
    "## API \`GET /items\`" \
    '' \
    '## Collision' \
    '' \
    '## Collision-1' \
    '' \
    '## Collision' >>"${fixture}/docs/guide.md"
  printf '\357\273\277# BOM heading\r\n## CRLF heading\r\n## Lone CR heading\r## After lone CR\r' \
    >"${fixture}/docs/newlines.md"
  printf '%s\n' \
    '' \
    '[Inline-code heading](docs/guide.md#api-get-items)' \
    '[Collision-safe heading](docs/guide.md#collision-2)' \
    '[BOM heading](docs/newlines.md#bom-heading)' \
    '[CRLF heading](docs/newlines.md#crlf-heading)' \
    '[Lone-CR heading](docs/newlines.md#lone-cr-heading)' \
    '[After lone CR](docs/newlines.md#after-lone-cr)' \
    '![Fixture image](docs/pixel.png)' \
    '' \
    '[Multiline guide](' \
    'docs/guide.md#quick-start' \
    ')' \
    '' \
    '> ```mermaid' \
    '> flowchart LR' \
    '>     C[Quoted] --> D[Parsed]' \
    '> ```' \
    '' \
    'Raw HTML <a href="docs/guide.md#quick-start">guide</a>.' \
    '<img src=docs/pixel.png alt="Raw HTML fixture image">' \
    '' \
    '<!-- [ignored comment](docs/missing-comment.md)' \
    '```mermaid' \
    'flowchart TD' \
    'not valid mermaid syntax @@@' \
    '```' \
    '-->' \
    '' \
    '\[escaped link](docs/missing-escaped.md)' \
    '[undefined reference is literal][not-defined]' >>"${fixture}/README.md"
  initialize_candidate_fixture "${fixture}"
  printf '%s\n' "${fixture}"
}

write_valid_design_trace() {
  local fixture="$1"
  local section
  printf '%s\n' \
    '# Design fixture' \
    '' \
    '## 54.3 Legacy §0–54 trace' \
    '' \
    '| 旧§ | Disposition | Verification |' \
    '|---:|---|---|' >"${fixture}/docs/design.md"
  for ((section = 0; section <= 54; section += 1)); do
    printf '| %d | owner | test |\n' "${section}" \
      >>"${fixture}/docs/design.md"
  done
}

test_docs_gate() {
  local fixture
  local output
  fixture="$(new_docs_fixture valid)"
  bash "${fixture}/scripts/check-docs.sh" >/dev/null \
    || fail "documentation gate rejected parser-semantic links, headings, comments, escapes, newlines, or fences"

  fixture="$(new_docs_fixture ignored-markdown-source)"
  mkdir -p -- "${fixture}/.vscode"
  printf '%s\n' '[ignored missing](missing-local-only.md)' \
    >"${fixture}/.vscode/local.md"
  bash "${fixture}/scripts/check-docs.sh" >/dev/null \
    || fail "documentation gate read an ignored Markdown source"

  fixture="$(new_docs_fixture tracked-formerly-excluded-markdown)"
  mkdir -p -- "${fixture}/.tmp"
  printf '%s\n' '[tracked missing](missing-tracked.md)' \
    >"${fixture}/.tmp/tracked.md"
  git -C "${fixture}" add --force -- .tmp/tracked.md \
    || fail "tracked Markdown fixture could not add its ignored path"
  assert_failure_contains "tracked Markdown in formerly excluded path" \
    "MISSING_LINK_TARGET" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture unrelated-candidate-symlink)"
  ln -s -- "docs/pixel.png" "${fixture}/unrelated-asset-link"
  bash "${fixture}/scripts/check-docs.sh" >/dev/null \
    || fail "documentation gate rejected an unrelated candidate symlink"

  fixture="$(new_docs_fixture candidate-manifest-name)"
  printf '%s\n' 'candidate payload' \
    >"${fixture}/.docs-config-candidate-manifest"
  printf '%s\n' 'deleted payload' \
    >"${fixture}/.docs-config-deleted-manifest"
  bash "${fixture}/scripts/check-docs.sh" >/dev/null \
    || fail "documentation gate collided with a candidate manifest filename"

  fixture="$(new_docs_fixture ignored-target-mask)"
  printf '%s\n' '[ignored mask](.tmp/missing.md)' >>"${fixture}/README.md"
  mkdir -p -- "${fixture}/.tmp"
  printf '%s\n' '# Ignored masking target' >"${fixture}/.tmp/missing.md"
  assert_failure_contains "ignored local target mask" "MISSING_LINK_TARGET" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture missing-target)"
  printf '%s\n' '[missing](docs/missing.md)' >>"${fixture}/README.md"
  assert_failure_contains "missing local target" "MISSING_LINK_TARGET" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture missing-image)"
  printf '%s\n' '![missing image](docs/missing.png)' >>"${fixture}/README.md"
  assert_failure_contains "missing local image" "MISSING_LINK_TARGET" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture raw-html-missing-link)"
  printf '%s\n' '<a href="docs/missing-html.md">missing HTML link</a>' \
    >>"${fixture}/README.md"
  assert_failure_contains "missing raw HTML link" "MISSING_LINK_TARGET" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture raw-html-missing-image)"
  printf '%s\n' '<img src=docs/missing-html.png alt="missing HTML image">' \
    >>"${fixture}/README.md"
  assert_failure_contains "missing raw HTML image" "MISSING_LINK_TARGET" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture multiline-missing-target)"
  printf '%s\n' \
    '[missing multiline](' \
    'docs/missing-multiline.md' \
    ')' >>"${fixture}/README.md"
  assert_failure_contains "multiline missing local target" "MISSING_LINK_TARGET" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture missing-fragment)"
  printf '%s\n' '[missing anchor](docs/guide.md#absent)' >>"${fixture}/README.md"
  assert_failure_contains "missing Markdown anchor" "MISSING_LINK_FRAGMENT" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture legacy-inline-code-fragment)"
  printf '%s\n' '[old custom slug](docs/guide.md#api)' >>"${fixture}/README.md"
  assert_failure_contains "non-GitHub inline-code anchor" "MISSING_LINK_FRAGMENT" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture unused-reference-target)"
  printf '%s\n' '' '[unused]: docs/missing-reference.md' >>"${fixture}/README.md"
  assert_failure_contains "unused reference destination" "MISSING_LINK_TARGET" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture duplicate-reference)"
  printf '%s\n' \
    '' \
    '[duplicate]: docs/guide.md' \
    '[duplicate]: README.md' >>"${fixture}/README.md"
  assert_failure_contains "duplicate reference definition" "DUPLICATE_REFERENCE" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture symlink-inside)"
  ln -s -- "guide.md" "${fixture}/docs/guide-link"
  printf '%s\n' '[inside symlink](docs/guide-link)' >>"${fixture}/README.md"
  assert_failure_contains "symlink inside repository" "SYMLINK_LINK_TARGET_NOT_ALLOWED" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture symlink-escape)"
  ln -s -- "${test_root}" "${fixture}/docs/outside"
  printf '%s\n' '[outside symlink](docs/outside)' >>"${fixture}/README.md"
  assert_failure_contains "symlink outside repository" "SYMLINK_LINK_TARGET_NOT_ALLOWED" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture symlink-component)"
  ln -s -- "docs" "${fixture}/docs-alias"
  printf '%s\n' '[symlink component](docs-alias/guide.md)' >>"${fixture}/README.md"
  assert_failure_contains "link through symlink component" "SYMLINK_LINK_TARGET_NOT_ALLOWED" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture symlink-markdown)"
  ln -s -- "guide.md" "${fixture}/docs/linked.md"
  assert_failure_contains "Markdown symlink in walker" "SYMLINK_MARKDOWN_NOT_ALLOWED" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture unclosed-fence)"
  printf '%s\n' '```text' 'never closed' >>"${fixture}/README.md"
  assert_failure_contains "unclosed fence" "UNCLOSED_FENCE" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture unclosed-blockquote-fence)"
  printf '%s\n' '> ```text' '> never closed' >>"${fixture}/README.md"
  assert_failure_contains "unclosed blockquote fence" "UNCLOSED_FENCE" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture invalid-mermaid)"
  printf '%s\n' '```mermaid' 'flowchart TD' '    A -->' '```' >>"${fixture}/README.md"
  assert_failure_contains "invalid Mermaid syntax" "MERMAID_SYNTAX" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture invalid-blockquote-mermaid)"
  printf '%s\n' \
    '> ```mermaid' \
    '> flowchart TD' \
    '>     A -->' \
    '> ```' >>"${fixture}/README.md"
  assert_failure_contains "invalid blockquote Mermaid syntax" "MERMAID_SYNTAX" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture floating-markdown-it-version)"
  replace_exact_line \
    "${fixture}/package.json" \
    '    "markdown-it": "15.0.0",' \
    '    "markdown-it": "^15.0.0",'
  assert_failure_contains "floating markdown-it version" "MARKDOWN_IT_VERSION" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture floating-github-slugger-version)"
  replace_exact_line \
    "${fixture}/package.json" \
    '    "github-slugger": "2.0.0",' \
    '    "github-slugger": "^2.0.0",'
  assert_failure_contains "floating github-slugger version" "GITHUB_SLUGGER_VERSION" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture floating-mermaid-version)"
  replace_exact_line \
    "${fixture}/package.json" \
    '    "mermaid": "11.16.1"' \
    '    "mermaid": "^11.16.1"'
  assert_failure_contains "floating Mermaid version" "MERMAID_VERSION" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture missing-markdown-it-version)"
  remove_exact_line \
    "${fixture}/package.json" \
    '    "markdown-it": "15.0.0",'
  assert_failure_contains "missing markdown-it version" "MARKDOWN_IT_VERSION" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture missing-github-slugger-version)"
  remove_exact_line \
    "${fixture}/package.json" \
    '    "github-slugger": "2.0.0",'
  assert_failure_contains "missing github-slugger version" "GITHUB_SLUGGER_VERSION" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture missing-mermaid-version)"
  remove_exact_line \
    "${fixture}/package.json" \
    '    "mermaid": "11.16.1"'
  replace_exact_line \
    "${fixture}/package.json" \
    '    "markdown-it": "15.0.0",' \
    '    "markdown-it": "15.0.0"'
  assert_failure_contains "missing Mermaid version" "MERMAID_VERSION" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture installed-tool-version-mismatch)"
  replace_installed_tools_with_mismatched_manifests "${fixture}"
  output="${test_root}/installed-tool-version-output"
  if bash "${fixture}/scripts/check-docs.sh" >"${output}" 2>&1; then
    fail "installed documentation tool version mismatch unexpectedly succeeded"
  fi
  for expected in \
    "MARKDOWN_IT_TOOL_UNAVAILABLE" \
    "GITHUB_SLUGGER_TOOL_UNAVAILABLE" \
    "MERMAID_TOOL_UNAVAILABLE"; do
    grep -Fq -- "${expected}" "${output}" \
      || fail "installed documentation tool mismatch did not report ${expected}"
  done

  fixture="$(new_docs_fixture valid-design-trace)"
  write_valid_design_trace "${fixture}"
  bash "${fixture}/scripts/check-docs.sh" >/dev/null \
    || fail "documentation gate rejected a complete legacy design trace"

  fixture="$(new_docs_fixture missing-design-trace)"
  printf '%s\n' '# Design fixture without a trace' \
    >"${fixture}/docs/design.md"
  assert_failure_contains "missing design legacy trace" \
    "DESIGN_LEGACY_TRACE_MISSING" \
    bash "${fixture}/scripts/check-docs.sh"

  fixture="$(new_docs_fixture duplicate-design-trace-row)"
  write_valid_design_trace "${fixture}"
  replace_exact_line \
    "${fixture}/docs/design.md" \
    '| 27 | owner | test |' \
    '| 28 | owner | test |'
  assert_failure_contains "duplicate design legacy trace row" \
    "DESIGN_LEGACY_TRACE_SEQUENCE" \
    bash "${fixture}/scripts/check-docs.sh"

  pass "documentation gate has parser-semantic and deterministic negative fixtures"
}

new_config_fixture() {
  local name="$1"
  local fixture="${test_root}/config-${name}"
  copy_gate_scripts "${fixture}"
  mkdir -p -- \
    "${fixture}/backend/cmd/cleanup" \
    "${fixture}/backend/cmd/configcheck" \
    "${fixture}/backend/cmd/migrate" \
    "${fixture}/backend/cmd/server" \
    "${fixture}/backend/internal/config" \
    "${fixture}/backend/internal/infrastructure/observability" \
    "${fixture}/backend/internal/infrastructure/postgres" \
    "${fixture}/cloudflare/src/beta-admission" \
    "${fixture}/cloudflare/src/config" \
    "${fixture}/config" \
    "${fixture}/docs" \
    "${fixture}/frontend/vite" \
    "${fixture}/.github/workflows"
  cp -- "${repo_root}/.env.example" "${fixture}/.env.example"
  cp -- "${repo_root}/backend/cmd/cleanup/main.go" "${fixture}/backend/cmd/cleanup/main.go"
  cp -- "${repo_root}/backend/cmd/configcheck/main.go" "${fixture}/backend/cmd/configcheck/main.go"
  cp -- "${repo_root}/backend/cmd/migrate/main.go" "${fixture}/backend/cmd/migrate/main.go"
  cp -- "${repo_root}/backend/cmd/server/main.go" "${fixture}/backend/cmd/server/main.go"
  cp -- "${repo_root}/backend/internal/config/config.go" "${fixture}/backend/internal/config/config.go"
  cp -- "${repo_root}/backend/internal/infrastructure/observability/runtime.go" "${fixture}/backend/internal/infrastructure/observability/runtime.go"
  cp -- "${repo_root}/backend/internal/infrastructure/postgres/cleanup_repository.go" "${fixture}/backend/internal/infrastructure/postgres/cleanup_repository.go"
  cp -- "${repo_root}/cloudflare/package.json" "${fixture}/cloudflare/package.json"
  ln -s -- "${repo_root}/cloudflare/node_modules" "${fixture}/cloudflare/node_modules"
  cp -- "${repo_root}/cloudflare/src/beta-admission/beta-admission.ts" "${fixture}/cloudflare/src/beta-admission/beta-admission.ts"
  cp -- "${repo_root}/cloudflare/src/config/deployment-contract.test.mjs" "${fixture}/cloudflare/src/config/deployment-contract.test.mjs"
  cp -- "${repo_root}/scripts/config-go-ast-inventory.go" "${fixture}/scripts/config-go-ast-inventory.go"
  cp -- "${repo_root}/cloudflare/src/index.ts" "${fixture}/cloudflare/src/index.ts"
  cp -- "${repo_root}/cloudflare/tsconfig.json" "${fixture}/cloudflare/tsconfig.json"
  cp -- "${repo_root}/cloudflare/wrangler.jsonc" "${fixture}/cloudflare/wrangler.jsonc"
  cp -- "${repo_root}/config/deployment-contract.json" "${fixture}/config/deployment-contract.json"
  cp -- "${repo_root}/docs/environment.md" "${fixture}/docs/environment.md"
  cp -- "${repo_root}/frontend/.env.example" "${fixture}/frontend/.env.example"
  cp -- "${repo_root}/frontend/index.html" "${fixture}/frontend/index.html"
  cp -- "${repo_root}/frontend/package.json" "${fixture}/frontend/package.json"
  ln -s -- "${repo_root}/frontend/node_modules" "${fixture}/frontend/node_modules"
  cp -- "${repo_root}/frontend/vite.config.ts" "${fixture}/frontend/vite.config.ts"
  cp -- \
    "${repo_root}/frontend/vite/searchIndexing.ts" \
    "${fixture}/frontend/vite/searchIndexing.ts"
  cp -R -- "${repo_root}/frontend/src" "${fixture}/frontend/src"
  cp -- "${repo_root}/.github/workflows/deploy.yml" "${fixture}/.github/workflows/deploy.yml"
  cp -- "${repo_root}/scripts/validate-deploy-inputs.mjs" "${fixture}/scripts/validate-deploy-inputs.mjs"
  initialize_candidate_fixture "${fixture}"
  printf '%s\n' "${fixture}"
}

remove_exact_line() {
  local file="$1"
  local line="$2"
  local before
  before="$(grep -Fxc -- "${line}" "${file}")"
  [[ "${before}" == "1" ]] || fail "fixture mutation expected one exact line in ${file}"
  sed -i "\|^${line}$|d" "${file}"
}

replace_exact_line() {
  local file="$1"
  local line="$2"
  local replacement="$3"
  local next="${file}.fixture-next"
  if ! awk -v line="${line}" -v replacement="${replacement}" '
    $0 == line {
      matches++
      $0 = replacement
    }
    { print }
    END { if (matches != 1) exit 1 }
  ' "${file}" >"${next}"; then
    rm -f -- "${next}"
    fail "fixture mutation expected one exact line in ${file}"
  fi
  mv -- "${next}" "${file}"
}

replace_exact_line_after_marker() {
  local file="$1"
  local marker="$2"
  local line="$3"
  local replacement="$4"
  local next="${file}.fixture-next"
  if ! awk -v marker="${marker}" -v line="${line}" -v replacement="${replacement}" '
    $0 == marker {
      markers++
      active = 1
    }
    active && $0 == line {
      matches++
      $0 = replacement
      active = 0
    }
    { print }
    END { if (markers != 1 || matches != 1) exit 1 }
  ' "${file}" >"${next}"; then
    rm -f -- "${next}"
    fail "fixture replacement expected one line after marker in ${file}"
  fi
  mv -- "${next}" "${file}"
}

insert_before_exact_line() {
  local file="$1"
  local line="$2"
  local insertion="$3"
  local next="${file}.fixture-next"
  if ! awk -v line="${line}" -v insertion="${insertion}" '
    $0 == line {
      matches++
      print insertion
    }
    { print }
    END { if (matches != 1) exit 1 }
  ' "${file}" >"${next}"; then
    rm -f -- "${next}"
    fail "fixture insertion expected one exact line in ${file}"
  fi
  mv -- "${next}" "${file}"
}

insert_after_exact_line() {
  local file="$1"
  local line="$2"
  local insertion="$3"
  local next="${file}.fixture-next"
  if ! awk -v line="${line}" -v insertion="${insertion}" '
    {
      print
      if ($0 == line) {
        matches++
        print insertion
      }
    }
    END { if (matches != 1) exit 1 }
  ' "${file}" >"${next}"; then
    rm -f -- "${next}"
    fail "fixture insertion expected one exact line in ${file}"
  fi
  mv -- "${next}" "${file}"
}

test_config_gate() {
  local canonical_worker_env_vars
  local fake_worker_comment
  local fixture
  local frontend_docs_line
  fixture="$(new_config_fixture valid)"
  insert_before_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    '  void import.meta.url;'
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '  envVars = {' \
    $'  // Benign AST decoy: this.envVars.DATABASE_URL = "ignored";\n  // Object.assign(this.envVars, { DATABASE_URL: "ignored" });'
  insert_before_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    'export default defineConfig(({ mode }) => {' \
    '// Benign AST decoy: loadEnv?.(mode, process["cwd"](), "VITE_");'
  insert_before_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '      environment: "jsdom",' \
    "      benignBuildConfigMarker: 'environment[\"VITE_DEPLOYMENT_ENV\"]',"
  insert_before_exact_line \
    "${fixture}/frontend/index.html" \
    '    <title>FUKAMU Cycle</title>' \
    '    <!-- Benign parser decoy: <script type="module">void import.meta.env.VITE_UNMODELED;</script> -->'
  mkdir -p -- "${fixture}/shared"
  printf '%s\n' \
    'export const frontendEnvironmentDecoy = "import.meta.env.VITE_UNMODELED";' \
    >"${fixture}/shared/frontend-environment-decoy.ts"
  insert_before_exact_line \
    "${fixture}/frontend/src/main.tsx" \
    'import { mountApplication } from "./app/mountApplication";' \
    $'import "../../shared/frontend-environment-decoy.ts";\nimport { mountApplication } from "./app/mountApplication";'
  printf '%s\n' \
    '' \
    '// Benign module decoy: import * as workers from "cloudflare:workers";' \
    '// Reflect.get(workers, "env");' \
    >>"${fixture}/cloudflare/src/beta-admission/beta-admission.ts"
  bash "${fixture}/scripts/check-config-parity.sh" >/dev/null \
    || fail "configuration parity gate rejected canonical syntax or benign AST decoys"

  fixture="$(new_config_fixture backend-go-comments-and-strings)"
  printf '%s\n' \
    '' \
    '// os. /* non-consumer */ Getenv("UNMODELED_ENV")' \
    '// os /* non-consumer */ . LookupEnv' \
    'var _ = "reader. stringValue(UNMODELED_ENV) reader . lookup(key)"' \
    >>"${fixture}/backend/internal/config/config.go"
  bash "${fixture}/scripts/check-config-parity.sh" >/dev/null \
    || fail "configuration parity gate treated Go comments or string literals as environment consumers"

  fixture="$(new_config_fixture deploy-root-env)"
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    'permissions:' \
    $'env:\n  PATH: /tmp/fixture-bin\n'
  assert_failure_contains "deployment root env" \
    "deployment workflow root field inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-extra-job)"
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '  deploy:' \
    $'  unexpected:\n    runs-on: ubuntu-latest\n    steps: []\n'
  assert_failure_contains "deployment extra job" \
    "deployment workflow job ID inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-anonymous-run-step)"
  # shellcheck disable=SC2016 # GitHub runner variable is an intentional fixture literal.
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Deploy Worker, static assets, and Container' \
    '      - run: test ! -f "${RUNNER_TEMP}/fukamu-cycle-worker-secrets.json"'
  assert_failure_contains "deployment anonymous run step" \
    "deployment step inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture ignored-backend-source)"
  mkdir -p -- "${fixture}/backend/.tmp"
  printf '%s\n' \
    'package ignored' \
    'import "os"' \
    'var _ = os.Getenv("UNMODELED_ENV")' \
    >"${fixture}/backend/.tmp/local.go"
  bash "${fixture}/scripts/check-config-parity.sh" >/dev/null \
    || fail "configuration parity gate read an ignored Backend source"

  fixture="$(new_config_fixture ignored-config-mask)"
  printf '%s\n' 'config/deployment-contract.json' >>"${fixture}/.gitignore"
  git -C "${fixture}" rm --cached --quiet -- config/deployment-contract.json \
    || fail "ignored config masking fixture could not remove the tracked path"
  assert_failure_contains "ignored configuration mask" "CONFIG_CANDIDATE_FILE_REQUIRED" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture config-fixed-external-symlink)"
  mv -- \
    "${fixture}/config/deployment-contract.json" \
    "${fixture}/config/deployment-contract.fixture-original.json"
  ln -s -- \
    "${repo_root}/config/deployment-contract.json" \
    "${fixture}/config/deployment-contract.json"
  assert_failure_contains "fixed configuration external symlink" \
    "CONFIG_CANDIDATE_FILE_REQUIRED" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture backend-drift)"
  remove_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t\t\tAIPerIPMinute:             reader.intValue("RATE_AI_PER_IP_MINUTE", 10),'
  assert_failure_contains "Backend config drift" "Backend contract/config.go" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture unknown-backend-reader)"
  replace_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\tpublicOrigin, err := parseURL(reader.stringValue("PUBLIC_ORIGIN", "http://localhost:5173"))' \
    $'\tpublicOrigin, err := parseURL(reader.newValue("PUBLIC_ORIGIN", "http://localhost:5173"))'
  assert_failure_contains "unknown Backend reader method" "Backend config reader methods" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture aliased-backend-reader-method)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\treader := envReader{lookup: lookup}' \
    $'\t_ = readString("UNMODELED_ENV", "")'
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\treader := envReader{lookup: lookup}' \
    $'\treadString := reader.stringValue'
  assert_failure_contains "aliased Backend reader method" \
    "Backend config reader methods must be invoked directly: stringValue" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture shadowed-load-reader-object)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\treader := envReader{lookup: lookup}' \
    $'\t{\n\t\treader := struct{ stringValue func(string, string) string }{\n\t\t\tstringValue: func(string, string) string { return "" },\n\t\t}\n\t\t_ = reader.stringValue("UNMODELED_ENV", "")\n\t}'
  assert_failure_contains "shadowed Backend Load reader object" \
    "Backend config reader methods must be invoked directly: stringValue" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture direct-load-lookup)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\treader := envReader{lookup: lookup}' \
    $'\t_, _ = lookup("UNMODELED_ENV")'
  assert_failure_contains "direct Load lookup" \
    "Backend config Load lookup parameter usage" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture literal-env-reader-lookup)"
  replace_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\tif value, ok := reader.lookup(key); ok {' \
    $'\tif value, ok := reader.lookup("UNMODELED_ENV"); ok {'
  assert_failure_contains "literal envReader lookup" \
    "Backend envReader lookup must use the reader receiver and key parameter" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture aliased-env-reader-receiver)"
  replace_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\tif value, ok := reader.lookup(key); ok {' \
    $'\tcopy := reader\n\tif value, ok := copy.lookup("UNMODELED_ENV"); ok {'
  assert_failure_contains "aliased envReader receiver" \
    "Backend envReader lookup must use the reader receiver and key parameter" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture shadowed-env-reader-receiver-object)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    'func (reader *envReader) stringValue(key string, fallback string) string {' \
    $'\t{\n\t\treader := struct{ lookup LookupEnv }{\n\t\t\tlookup: func(string) (string, bool) { return "", false },\n\t\t}\n\t\t_, _ = reader.lookup("UNMODELED_ENV")\n\t}'
  assert_failure_contains "shadowed envReader method receiver object" \
    "Backend envReader lookup must use the reader receiver and key parameter" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture configcheck-extra-lookup)"
  insert_after_exact_line \
    "${fixture}/backend/cmd/configcheck/main.go" \
    $'\tsettings, err := config.Load(lookup)' \
    $'\t_, _ = lookup("UNMODELED_ENV")'
  assert_failure_contains "configcheck extra environment lookup" \
    "production Backend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture external-backend-key)"
  replace_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t\t\tEnvironment:  reader.stringValue("APP_ENV", "development"),' \
    $'\t\t\tEnvironment:  reader.stringValue("EXTRA_KEY", "development"),'
  assert_failure_contains "contract-external Backend key" "Backend contract/config.go" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture backend-comment-interleaved-getenv)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t"math"' \
    $'\t"os"'
  printf '%s\n' '' 'var _ = os. /* fixture */ Getenv("UNMODELED_ENV")' \
    >>"${fixture}/backend/internal/config/config.go"
  assert_failure_contains "comment-interleaved os.Getenv" \
    "production Backend direct environment access allowlist" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture backend-comment-interleaved-lookupenv)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t"math"' \
    $'\t"os"'
  printf '%s\n' '' 'var _ = os /* fixture */ . LookupEnv' \
    >>"${fixture}/backend/internal/config/config.go"
  assert_failure_contains "comment-interleaved os.LookupEnv method value" \
    "production Backend direct environment access allowlist" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture backend-comment-interleaved-reader-call)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\treader := envReader{lookup: lookup}' \
    $'\t_ = reader. /* fixture */ stringValue("UNMODELED_ENV", "")'
  assert_failure_contains "comment-interleaved envReader call" \
    "Backend contract/config.go" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture backend-comment-interleaved-reader-lookup)"
  replace_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\tif value, ok := reader.lookup(key); ok {' \
    $'\tif value, ok := reader /* fixture */ . lookup("UNMODELED_ENV"); ok {'
  assert_failure_contains "comment-interleaved envReader lookup" \
    "Backend envReader lookup must use the reader receiver and key parameter" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture direct-backend-env)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t"math"' \
    $'\t"os"'
  printf '%s\n' '' 'var _ = os.Getenv("UNMODELED_ENV")' \
    >>"${fixture}/backend/internal/config/config.go"
  assert_failure_contains "direct production Backend env lookup" \
    "production Backend direct environment access" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture shadowed-os-environment-binding)"
  insert_after_exact_line \
    "${fixture}/backend/cmd/migrate/main.go" \
    $'\tlogger := safelog.NewJSON(os.Stdout)' \
    $'\tos := struct{ Getenv func(string) string }{\n\t\tGetenv: func(string) string { return "" },\n\t}'
  assert_failure_contains "shadowed standard os environment binding" \
    "production Backend direct environment access allowlist" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture fake-os-import-binding)"
  replace_exact_line \
    "${fixture}/backend/cmd/migrate/main.go" \
    $'\t"os"' \
    $'\tos "example.invalid/fake"'
  assert_failure_contains "fake package bound as os" \
    "production Backend direct environment access allowlist" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture stale-backend-env-allowlist)"
  remove_exact_line \
    "${fixture}/backend/cmd/migrate/main.go" \
    $'\tdatabaseURL := os.Getenv("DATABASE_URL")'
  assert_failure_contains "stale production Backend env allowlist" \
    "production Backend direct environment access allowlist" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture migrate-env-literal-swap)"
  replace_exact_line \
    "${fixture}/backend/cmd/migrate/main.go" \
    $'\tdatabaseURL := os.Getenv("DATABASE_URL")' \
    $'\tdatabaseURL := os.Getenv("MIGRATIONS_DIR")'
  replace_exact_line \
    "${fixture}/backend/cmd/migrate/main.go" \
    $'\tdirectory := os.Getenv("MIGRATIONS_DIR")' \
    $'\tdirectory := os.Getenv("DATABASE_URL")'
  assert_failure_contains "migrate environment literal swap" \
    "production Backend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture observability-environ-consumer-move)"
  replace_exact_line \
    "${fixture}/backend/internal/infrastructure/observability/runtime.go" \
    $'\tfor _, entry := range os.Environ() {' \
    $'\tentries := os.Environ()\n\tfor _, entry := range entries {'
  assert_failure_contains "observability os.Environ consumer move" \
    "production Backend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture backend-env-mutation)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t"math"' \
    $'\t"os"'
  printf '%s\n' '' 'var _ = os.Setenv("UNMODELED_ENV", "value")' \
    >>"${fixture}/backend/internal/config/config.go"
  assert_failure_contains "production Backend env mutation" \
    "production Backend direct environment access allowlist" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture aliased-backend-env)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t"math"' \
    $'\tenvironment "os"'
  printf '%s\n' '' 'var _, _ = environment.LookupEnv("UNMODELED_ENV")' \
    >>"${fixture}/backend/internal/config/config.go"
  assert_failure_contains "aliased production Backend env lookup" \
    "aliases and dot imports for OS environment packages are forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture unicode-aliased-backend-env)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t"math"' \
    $'\t環境 "os"'
  printf '%s\n' '' 'var _ = 環境.Getenv("UNMODELED_ENV")' \
    >>"${fixture}/backend/internal/config/config.go"
  assert_failure_contains "Unicode-aliased production Backend env lookup" \
    "aliases and dot imports for OS environment packages are forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture raw-string-aliased-backend-env)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t"math"' \
    $'\tenvironment `os`'
  printf '%s\n' '' 'var _ = environment.Getenv("UNMODELED_ENV")' \
    >>"${fixture}/backend/internal/config/config.go"
  assert_failure_contains "raw-string-aliased production Backend env lookup" \
    "aliases and dot imports for OS environment packages are forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture escaped-aliased-backend-env)"
  insert_after_exact_line \
    "${fixture}/backend/internal/config/config.go" \
    $'\t"math"' \
    $'\tenvironment "\\x6f\\x73"'
  printf '%s\n' '' 'var _ = environment.Getenv("UNMODELED_ENV")' \
    >>"${fixture}/backend/internal/config/config.go"
  assert_failure_contains "escaped-aliased production Backend env lookup" \
    "aliases and dot imports for OS environment packages are forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture indirect-backend-env)"
  replace_exact_line \
    "${fixture}/backend/cmd/server/main.go" \
    $'\tsettings, err := config.Load(os.LookupEnv)' \
    $'\tlookupEnv := os.LookupEnv\n\t_, _ = lookupEnv("UNMODELED_ENV")\n\tsettings, err := config.Load(lookupEnv)'
  assert_failure_contains "indirect production Backend env lookup" \
    "production Backend direct environment access allowlist" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture env-drift)"
  remove_exact_line "${fixture}/.env.example" "RATE_AI_PER_IP_MINUTE=10"
  assert_failure_contains ".env.example drift" "Backend contract/.env.example" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture docs-drift)"
  # shellcheck disable=SC2016 # Markdown backticks are intentional literals.
  sed -i '/^| `RATE_AI_PER_IP_MINUTE` |/d' "${fixture}/docs/environment.md"
  assert_failure_contains "environment docs drift" "Backend contract/environment docs" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-drift)"
  remove_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '    DATABASE_URL: required("DATABASE_URL", env.DATABASE_URL),'
  assert_failure_contains "Worker handoff drift" "Backend contract/Container envVars" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-required-label-swap)"
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    $'    DATABASE_URL: required("DATABASE_URL", env.DATABASE_URL),' \
    $'    DATABASE_URL: required("OPENAI_API_KEY", env.DATABASE_URL),'
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    $'    OPENAI_API_KEY: required("OPENAI_API_KEY", env.OPENAI_API_KEY),' \
    $'    OPENAI_API_KEY: required("DATABASE_URL", env.OPENAI_API_KEY),'
  assert_failure_contains "Worker required label swap" \
    "Container envVars required() label must match property key: DATABASE_URL" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-env-source-swap)"
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    $'    DATABASE_URL: required("DATABASE_URL", env.DATABASE_URL),' \
    $'    DATABASE_URL: required("DATABASE_URL", env.OPENAI_API_KEY),'
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    $'    OPENAI_API_KEY: required("OPENAI_API_KEY", env.OPENAI_API_KEY),' \
    $'    OPENAI_API_KEY: required("OPENAI_API_KEY", env.DATABASE_URL),'
  assert_failure_contains "Worker env source swap" \
    "Container envVars required() env source must match property key: DATABASE_URL" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-required-malicious-return)"
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '  return value;' \
    '  return name === "DATABASE_URL" ? "attacker" : value;'
  assert_failure_contains "Worker required malicious return" \
    "Worker required function semantics" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-required-blank-bypass)"
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '  if (value === undefined || value.trim() === "") {' \
    '  if (value === undefined) {'
  assert_failure_contains "Worker required blank-value bypass" \
    "Worker required function semantics" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-backend-decorator)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    '@mutateBackend'
  assert_failure_contains "Worker Backend decorator" \
    "Worker Backend declaration contract" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-backend-alternate-base)"
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    $'class MaliciousContainer extends Container {}\nexport class Backend extends MaliciousContainer {'
  assert_failure_contains "Worker Backend alternate base" \
    "Worker Backend declaration contract" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-backend-nested-only)"
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    $'namespace Hidden {\nexport class Backend extends Container {'
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'function isBackendRequest(url: URL): boolean {' \
    '}'
  assert_failure_contains "Worker Backend nested-only declaration" \
    "Worker Backend declaration contract" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-side-effect-module-environment-import)"
  printf '%s\n' \
    'import * as workers from "cloudflare:workers";' \
    '' \
    'void Reflect.get(workers, "env");' \
    >"${fixture}/cloudflare/src/environment-side-effect.ts"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'import { handleBetaAdmission } from "./beta-admission/beta-admission";' \
    $'import "./environment-side-effect";\nimport { handleBetaAdmission } from "./beta-admission/beta-admission";'
  assert_failure_contains "Worker side-effect module environment import" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-root-shared-environment-import)"
  mkdir -p -- "${fixture}/shared"
  printf '%s\n' \
    'import * as workers from "cloudflare:workers";' \
    '' \
    'export const workerEnvironment = Reflect.get(workers, "env");' \
    >"${fixture}/shared/worker-environment.ts"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'import { handleBetaAdmission } from "./beta-admission/beta-admission";' \
    $'import "../../shared/worker-environment";\nimport { handleBetaAdmission } from "./beta-admission/beta-admission";'
  assert_failure_contains "Worker root shared environment import" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-computed-require-environment-module)"
  printf '%s\n' \
    'const workers = module["require"](("cloudflare:" + "workers") as const);' \
    'void Reflect.get(workers, "env");' \
    >"${fixture}/cloudflare/src/require-environment.ts"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'import { handleBetaAdmission } from "./beta-admission/beta-admission";' \
    $'import "./require-environment";\nimport { handleBetaAdmission } from "./beta-admission/beta-admission";'
  assert_failure_contains "Worker computed require environment module" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-outside-root-local-import)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'import { handleBetaAdmission } from "./beta-admission/beta-admission";' \
    $'import "../../../outside-worker.ts";\nimport { handleBetaAdmission } from "./beta-admission/beta-admission";'
  assert_failure_contains "Worker outside-root local import" \
    "local module reference must remain inside the candidate repository" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-wrapped-dynamic-outside-root-import)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'import { handleBetaAdmission } from "./beta-admission/beta-admission";' \
    $'void import(("../../../../outside-worker.ts") satisfies string);\nimport { handleBetaAdmission } from "./beta-admission/beta-admission";'
  assert_failure_contains "Worker wrapped dynamic outside-root import" \
    "local module reference must remain inside the candidate repository" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-file-url-import)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'import { handleBetaAdmission } from "./beta-admission/beta-admission";' \
    $'import "file:///tmp/outside-worker.ts";\nimport { handleBetaAdmission } from "./beta-admission/beta-admission";'
  assert_failure_contains "Worker file URL import" \
    "file URL module references are forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-nonstatic-dynamic-environment-import)"
  printf '%s\n' \
    'const workerSpecifier = "cloudflare:workers";' \
    'void import(workerSpecifier);' \
    >"${fixture}/cloudflare/src/nonstatic-environment-import.ts"
  assert_failure_contains "Worker nonstatic dynamic environment import" \
    "dynamic module references must use exact statically analyzable strings" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-template-environment-import)"
  # shellcheck disable=SC2016 # Expected TypeScript fixture is a literal template expression.
  printf '%s\n' \
    'void import(`cloudflare:${"workers"}`);' \
    >"${fixture}/cloudflare/src/template-environment-import.ts"
  assert_failure_contains "Worker template environment import" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-aliased-require)"
  printf '%s\n' \
    'const loadModule = require;' \
    'void loadModule("cloudflare:workers");' \
    >"${fixture}/cloudflare/src/aliased-require.ts"
  assert_failure_contains "Worker aliased require" \
    "require references must be direct canonical calls" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-other-source-dynamic-code)"
  mkdir -p -- "${fixture}/shared"
  printf '%s\n' \
    'eval("void globalThis");' \
    >"${fixture}/shared/worker-dynamic-code.ts"
  assert_failure_contains "Worker other source dynamic code" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-computed-global-dynamic-code)"
  printf '%s\n' \
    'const dynamicCodeKey = "eval";' \
    'globalThis[dynamicCodeKey]("void globalThis");' \
    >"${fixture}/cloudflare/src/worker-computed-dynamic-code.ts"
  assert_failure_contains "Worker computed global dynamic code" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-reflect-global-dynamic-code)"
  printf '%s\n' \
    'const dynamicCodeKey = "eval";' \
    'Reflect.get(globalThis, dynamicCodeKey)("void globalThis");' \
    >"${fixture}/cloudflare/src/worker-reflect-dynamic-code.ts"
  assert_failure_contains "Worker Reflect global dynamic code" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-constructor-dynamic-code)"
  printf '%s\n' \
    'void (() => {}).constructor("return globalThis")();' \
    >"${fixture}/cloudflare/src/worker-constructor-dynamic-code.ts"
  assert_failure_contains "Worker constructor dynamic code" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-reflective-constructor-dynamic-code)"
  printf '%s\n' \
    'const dynamicCodeKey = "constructor";' \
    'const functionPrototype = Object.getPrototypeOf(() => {});' \
    'void Object.getOwnPropertyDescriptor(functionPrototype, dynamicCodeKey)?.value("return globalThis")();' \
    >"${fixture}/cloudflare/src/worker-reflective-constructor-dynamic-code.ts"
  assert_failure_contains "Worker reflective constructor dynamic code" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-data-url-module)"
  printf '%s\n' \
    'void import("data:text/javascript,export default 1");' \
    >"${fixture}/cloudflare/src/data-url-module.ts"
  assert_failure_contains "Worker data URL module" \
    "executable URL module references are forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-handler-bindings-eval)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '    if (!isBackendRequest(new URL(request.url))) {' \
    '    eval("void bindings.OPENAI_API_KEY");'
  assert_failure_contains "Worker handler bindings eval" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-handler-bindings-alias)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '    if (!isBackendRequest(new URL(request.url))) {' \
    $'    const aliasedBindings = bindings;\n    void aliasedBindings;'
  assert_failure_contains "Worker handler bindings alias" \
    "Worker handler bindings provenance" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-handler-bindings-reflect)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '    if (!isBackendRequest(new URL(request.url))) {' \
    '    void Reflect.get(bindings, "OPENAI_API_KEY");'
  assert_failure_contains "Worker handler Reflect bindings access" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-handler-bindings-module-pass)"
  printf '%s\n' \
    'export function leakBindings(value: unknown): void {' \
    '  void value;' \
    '}' \
    >"${fixture}/cloudflare/src/leak-bindings.ts"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'import { handleBetaAdmission } from "./beta-admission/beta-admission";' \
    $'import { leakBindings } from "./leak-bindings";\nimport { handleBetaAdmission } from "./beta-admission/beta-admission";'
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '    if (!isBackendRequest(new URL(request.url))) {' \
    '    leakBindings(bindings);'
  assert_failure_contains "Worker handler bindings passed to another module" \
    "Worker handler bindings provenance" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-beta-bindings-extra-access)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/beta-admission/beta-admission.ts" \
    '  if (bindings.BETA_ADMISSION_MODE === "off") return { mode: "off" };' \
    '  void bindings.OPENAI_API_KEY;'
  assert_failure_contains "Worker beta bindings extra access" \
    "Worker handler bindings provenance" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-beta-bindings-arguments-access)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/beta-admission/beta-admission.ts" \
    '  if (bindings.BETA_ADMISSION_MODE === "off") return { mode: "off" };' \
    '  void Reflect.get(arguments[0], "BETA_ADMISSION_MODE");'
  assert_failure_contains "Worker beta bindings arguments access" \
    "Worker cloudflare:workers module reference inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-extra-durable-object-binding)"
  replace_exact_line \
    "${fixture}/cloudflare/wrangler.jsonc" \
    '        "name": "BACKEND",' \
    $'        "name": "UNMODELED",\n        "class_name": "UnmodeledDurableObject",\n      },\n      {\n        "name": "BACKEND",'
  printf '%s\n' \
    '' \
    'export class UnmodeledDurableObject {' \
    '  constructor(_state: DurableObjectState, _bindings: Env) {}' \
    '}' \
    >>"${fixture}/cloudflare/src/index.ts"
  assert_failure_contains "Worker extra Durable Object binding" \
    "Expected values to be strictly deep-equal" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-cloudflare-tsconfig-path-alias)"
  replace_exact_line \
    "${fixture}/cloudflare/tsconfig.json" \
    '    "moduleResolution": "Bundler",' \
    $'    "moduleResolution": "Bundler",\n    "baseUrl": ".",\n    "paths": { "@outside/*": ["../../outside/*"] },'
  assert_failure_contains "Worker Cloudflare tsconfig path alias" \
    "Cloudflare TypeScript baseUrl aliases are forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-object-spread)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    $'    APP_ENV: "production",' \
    $'    ...extraEnvVars,'
  assert_failure_contains "Worker envVars object spread" \
    "Container envVars object spread is forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-computed-key)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    $'    APP_ENV: "production",' \
    $'    ["EXTRA_KEY"]: "value",'
  assert_failure_contains "Worker envVars computed key" \
    "Container envVars computed properties are forbidden" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-shorthand-property)"
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    $'    APP_ENV: "production",' \
    $'    extraEnvVars,'
  assert_failure_contains "Worker envVars shorthand property" \
    "Container envVars has unsupported top-level property syntax" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-fake-canonical-comment)"
  canonical_worker_env_vars="$(
    sed -n '/^  envVars = {$/,/^  };$/p' \
      "${fixture}/cloudflare/src/index.ts"
  )"
  [[ -n "${canonical_worker_env_vars}" ]] \
    || fail "Worker fake canonical fixture could not capture envVars"
  replace_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '  envVars = {' \
    '  runtimeEnvVars = {'
  fake_worker_comment=$'  /* Fake canonical block; not executable.\n'"${canonical_worker_env_vars}"$'\n  */'
  insert_before_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    '  runtimeEnvVars = {' \
    "${fake_worker_comment}"
  assert_failure_contains "Worker fake canonical comment masking actual field drift" \
    "Worker Backend.envVars must be declared exactly once" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-constructor-env-vars-reassignment)"
  insert_after_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    $'  constructor() {\n    super();\n    this.envVars = {};\n  }'
  assert_failure_contains "Worker constructor envVars reassignment" \
    "Worker Backend.envVars must not be accessed or mutated outside its canonical class field" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-method-env-vars-property-mutation)"
  insert_after_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    $'  overwriteDatabaseURL() {\n    this.envVars.DATABASE_URL = "changed";\n  }'
  assert_failure_contains "Worker method envVars property mutation" \
    "Worker Backend.envVars must not be accessed or mutated outside its canonical class field" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-object-assign-env-vars-mutation)"
  insert_after_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    $'  overwriteEnvironment() {\n    Object.assign(this.envVars, { DATABASE_URL: "changed" });\n  }'
  assert_failure_contains "Worker Object.assign envVars mutation" \
    "Worker Backend.envVars must not be accessed or mutated outside its canonical class field" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-computed-env-vars-reassignment)"
  insert_after_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    $'  overwriteEnvironment() {\n    this["env" + "Vars"] = {};\n  }'
  assert_failure_contains "Worker computed envVars reassignment" \
    "Worker Backend.envVars must not be accessed or mutated outside its canonical class field" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-reflect-env-vars-reassignment)"
  insert_after_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    $'  overwriteEnvironment() {\n    Reflect.set(this, "env" + "Vars", {});\n  }'
  assert_failure_contains "Worker Reflect.set envVars reassignment" \
    "Worker Backend.envVars must not be accessed or mutated outside its canonical class field" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-define-property-env-vars-reassignment)"
  insert_after_exact_line \
    "${fixture}/cloudflare/src/index.ts" \
    'export class Backend extends Container {' \
    $'  overwriteEnvironment() {\n    Object.defineProperty(this, "env" + "Vars", { value: {} });\n  }'
  assert_failure_contains "Worker Object.defineProperty envVars reassignment" \
    "Worker Backend.envVars must not be accessed or mutated outside its canonical class field" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-html-environment-interpolation)"
  replace_exact_line \
    "${fixture}/frontend/index.html" \
    '    <title>FUKAMU Cycle</title>' \
    '    <title>%VITE_UNMODELED%</title>'
  assert_failure_contains "Frontend HTML environment interpolation" \
    "production Frontend HTML environment interpolation inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-html-inline-module-consumer)"
  insert_before_exact_line \
    "${fixture}/frontend/index.html" \
    '    <script type="module" src="/src/main.tsx"></script>' \
    '    <script type="module">void import.meta.env.VITE_UNMODELED;</script>'
  assert_failure_contains "Frontend HTML inline module environment consumer" \
    "production Frontend HTML script inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-html-inline-classic-consumer)"
  insert_before_exact_line \
    "${fixture}/frontend/index.html" \
    '    <script type="module" src="/src/main.tsx"></script>' \
    '    <script>void process.env.VITE_UNMODELED;</script>'
  assert_failure_contains "Frontend HTML inline classic environment consumer" \
    "production Frontend HTML script inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-tracked-production-env)"
  printf '%s\n' 'VITE_UNMODELED=must-not-be-bundled' \
    >"${fixture}/frontend/.env.production"
  git -C "${fixture}" add --force -- frontend/.env.production \
    || fail "tracked Frontend production environment fixture could not be added"
  assert_failure_contains "tracked Frontend production environment file" \
    "production Frontend tracked environment-file inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-helper-environment-consumer)"
  insert_before_exact_line \
    "${fixture}/frontend/vite/searchIndexing.ts" \
    'export type DeploymentEnvironment = "staging" | "production" | undefined;' \
    $'const leakedBuildValue = process.env.VITE_UNMODELED;\nvoid leakedBuildValue;'
  assert_failure_contains "Frontend build helper environment consumer" \
    "Frontend build helper environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-unmodeled-consumer)"
  insert_before_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    '  void import.meta.env.VITE_UNMODELED;'
  assert_failure_contains "Frontend unmodeled environment consumer" \
    "production Frontend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-comment-interleaved-consumer)"
  insert_before_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    '  void import /* fixture */./* fixture */ meta.env.VITE_UNMODELED;'
  assert_failure_contains "Frontend comment-interleaved environment consumer" \
    "production Frontend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-unmodeled-js-consumer)"
  printf '%s\n' 'void import.meta.env.VITE_UNMODELED_JS;' \
    >"${fixture}/frontend/src/unmodeled.fixture.js"
  assert_failure_contains "Frontend JavaScript environment consumer" \
    "production Frontend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-unmodeled-mjs-consumer)"
  printf '%s\n' 'void import.meta.env.VITE_UNMODELED_MJS;' \
    >"${fixture}/frontend/src/unmodeled.fixture.mjs"
  assert_failure_contains "Frontend MJS environment consumer" \
    "production Frontend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-root-shared-environment-consumer)"
  mkdir -p -- "${fixture}/shared"
  printf '%s\n' \
    'export const sharedValue = import.meta.env.VITE_UNMODELED_SHARED;' \
    >"${fixture}/shared/frontend-environment.ts"
  insert_before_exact_line \
    "${fixture}/frontend/src/main.tsx" \
    'import { mountApplication } from "./app/mountApplication";' \
    $'import { sharedValue } from "../../shared/frontend-environment.ts";\nimport { mountApplication } from "./app/mountApplication";'
  insert_after_exact_line \
    "${fixture}/frontend/src/main.tsx" \
    'import "./styles.css";' \
    'void sharedValue;'
  assert_failure_contains "Frontend root shared environment consumer" \
    "production Frontend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-outside-root-local-import)"
  insert_before_exact_line \
    "${fixture}/frontend/src/main.tsx" \
    'import { mountApplication } from "./app/mountApplication";' \
    $'import "../../../outside-frontend.ts";\nimport { mountApplication } from "./app/mountApplication";'
  assert_failure_contains "Frontend outside-root local import" \
    "local module reference must remain inside the candidate repository" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-aliased-env)"
  replace_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    $'  const runtimeEnvironment = import.meta.env;\n  const configured = runtimeEnvironment.VITE_APP_REFERRAL_URL?.trim();'
  assert_failure_contains "Frontend aliased environment access" \
    "production Frontend import.meta access must use canonical" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-dynamic-env)"
  replace_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    '  const configured = import.meta.env["VITE_APP_REFERRAL_URL"]?.trim();'
  assert_failure_contains "Frontend dynamic environment access" \
    "production Frontend import.meta access must use canonical" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-parenthesized-import-meta)"
  insert_before_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    '  void (import.meta).env.VITE_UNMODELED;'
  assert_failure_contains "Frontend parenthesized import.meta access" \
    "production Frontend import.meta access must use canonical" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-optional-import-meta)"
  insert_before_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    '  void import.meta?.env.VITE_UNMODELED;'
  assert_failure_contains "Frontend optional import.meta access" \
    "production Frontend import.meta access must use canonical" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-parenthesized-computed-import-meta)"
  insert_before_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    '  void import.meta[("env")].VITE_UNMODELED;'
  assert_failure_contains "Frontend parenthesized computed import.meta access" \
    "production Frontend import.meta access must use canonical" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-aliased-import-meta)"
  insert_before_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    $'  const runtimeMeta = import.meta;\n  void runtimeMeta.env.VITE_UNMODELED;'
  assert_failure_contains "Frontend aliased import.meta access" \
    "production Frontend import.meta access must use canonical" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-destructured-import-meta)"
  insert_before_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    $'  const { env: runtimeEnvironment } = import.meta;\n  void runtimeEnvironment.VITE_UNMODELED;'
  assert_failure_contains "Frontend destructured import.meta access" \
    "production Frontend import.meta access must use canonical" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-test-source-consumer)"
  printf '%s\n' 'void import.meta.env.VITE_UNMODELED_TEST_SOURCE;' \
    >"${fixture}/frontend/src/unmodeled.fixture.test.ts"
  assert_failure_contains "Frontend test-named source environment consumer" \
    "production Frontend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-outside-src-consumer)"
  printf '%s\n' 'void import.meta.env.VITE_UNMODELED_OUTSIDE_SRC;' \
    >"${fixture}/frontend/runtime.fixture.ts"
  assert_failure_contains "Frontend outside-src environment consumer" \
    "production Frontend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-missing-consumer)"
  replace_exact_line \
    "${fixture}/frontend/src/features/app-referral/config.ts" \
    '  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();' \
    '  const configured: string | undefined = undefined;'
  assert_failure_contains "Frontend missing environment consumer" \
    "production Frontend environment consumer inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-config-missing)"
  replace_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '    environment.VITE_DEPLOYMENT_ENV,' \
    '    undefined,'
  replace_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '    plugins: [react(), searchIndexingPlugin(deploymentEnvironment)],' \
    '    plugins: [react()],'
  insert_before_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    'export default defineConfig(({ mode }) => {' \
    $'/* Fake canonical wiring; not executable.\n  const environment = loadEnv(mode, process.cwd(), "VITE_");\n  const deploymentEnvironment = parseDeploymentEnvironment(\n    environment.VITE_DEPLOYMENT_ENV,\n  );\n    plugins: [react(), searchIndexingPlugin(deploymentEnvironment)],\n*/'
  assert_failure_contains "fake canonical comment masking Frontend build-config drift" \
    "Frontend build-config deployment environment wiring" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-config-alias)"
  insert_before_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '  const deploymentEnvironment = parseDeploymentEnvironment(' \
    '  const deploymentEnvironmentSource = environment;'
  replace_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '    environment.VITE_DEPLOYMENT_ENV,' \
    '    deploymentEnvironmentSource.VITE_DEPLOYMENT_ENV,'
  assert_failure_contains "aliased Frontend build-config consumer" \
    "Frontend build-config deployment environment wiring" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-config-dynamic)"
  replace_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '    environment.VITE_DEPLOYMENT_ENV,' \
    '    environment["VITE_DEPLOYMENT_ENV"],'
  assert_failure_contains "dynamic Frontend build-config consumer" \
    "Frontend build-config deployment environment wiring" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-config-fake-define-config)"
  replace_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    'import { defineConfig } from "vitest/config";' \
    'const defineConfig = (configuration: unknown) => ({ configuration });'
  assert_failure_contains "fake local defineConfig binding" \
    "Frontend build-config deployment environment wiring" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-config-optional-load-env)"
  replace_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '  const environment = loadEnv(mode, process.cwd(), "VITE_");' \
    '  const environment = loadEnv?.(mode, process.cwd(), "VITE_");'
  assert_failure_contains "optional loadEnv call" \
    "Frontend build-config deployment environment wiring" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-config-early-return)"
  insert_before_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '  const environment = loadEnv(mode, process.cwd(), "VITE_");' \
    '  if (true) return { plugins: [] };'
  assert_failure_contains "early Frontend build-config return" \
    "Frontend build-config deployment environment wiring" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-config-spread-overwrite)"
  insert_after_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '    plugins: [react(), searchIndexingPlugin(deploymentEnvironment)],' \
    '    ...{ plugins: [] },'
  assert_failure_contains "Frontend build-config spread overwrite" \
    "Frontend build-config deployment environment wiring" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-config-environment-mutation)"
  replace_exact_line \
    "${fixture}/frontend/vite.config.ts" \
    '    plugins: [react(), searchIndexingPlugin(deploymentEnvironment)],' \
    $'    plugins: [\n      react(),\n      Object.assign(environment, { VITE_DEPLOYMENT_ENV: "production" }),\n      searchIndexingPlugin(deploymentEnvironment),\n    ],'
  assert_failure_contains "Frontend build-config loadEnv result mutation" \
    "Frontend build-config deployment environment wiring" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-docs-missing-key)"
  # shellcheck disable=SC2016 # Markdown code spans are intentional fixture literals.
  frontend_docs_line="$(grep -F -- '| `VITE_DEPLOYMENT_ENV` |' "${fixture}/docs/environment.md")"
  replace_exact_line \
    "${fixture}/docs/environment.md" \
    "${frontend_docs_line}" \
    "Frontend deployment environment documentation fixture removed."
  assert_failure_contains "missing Frontend environment documentation" \
    "Frontend contract/environment docs" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-docs-extra-key)"
  # shellcheck disable=SC2016 # Markdown code spans are intentional fixture literals.
  insert_before_exact_line \
    "${fixture}/docs/environment.md" \
    'Frontend public valueとBackendの対応値は同じGitHub Environment入力からbuild/deployします。' \
    '| `VITE_UNMODELED` | fixture | **public**、fixture |'
  assert_failure_contains "extra Frontend environment documentation" \
    "Frontend contract/environment docs" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture frontend-build-drift)"
  # shellcheck disable=SC2016 # GitHub expression is an intentional fixture literal.
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    "        run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build" \
    '          VITE_UNDECLARED_SECRET: ${{ secrets.OPENAI_API_KEY }}'
  assert_failure_contains "Frontend build input drift" \
    "deployment contract/frontend build input" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-frontend-filter-without-fail-if-no-match)"
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    "        run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build" \
    "        run: pnpm --filter fukamu-cycle-frontend run build"
  assert_failure_contains "deployment Frontend filter without fail-if-no-match" \
    "deployment Frontend build command" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-root-shell-default)"
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    'jobs:' \
    $'defaults:
  run:
    shell: bash {0} || true
'
  assert_failure_contains "deployment root shell default" \
    "must not define root or job command defaults" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-needs-drift)"
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '    needs: resolve' \
    '    needs: [resolve]'
  assert_failure_contains "deployment needs drift" \
    "deployment job field inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture skipped-resolve-job)"
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '    if: >-' \
    '    if: false'
  assert_failure_contains "skipped deployment resolve job" \
    "deployment resolve job contract" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture replaced-resolve-command)"
  # shellcheck disable=SC1003 # Trailing backslashes are intentional workflow fixture text.
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Resolve deployment commit' \
    '            gh api \' \
    '            false \'
  assert_failure_contains "replaced deployment resolve command" \
    "deployment resolve step" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture self-hosted-deploy-runner)"
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    '  deploy:' \
    '    runs-on: ubuntu-latest' \
    '    runs-on: self-hosted'
  assert_failure_contains "self-hosted deployment runner" \
    "deployment job field inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture skipped-ci-success-check)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Verify commit has successful CI' \
    '        if: false'
  assert_failure_contains "skipped deployment CI-success verification" \
    "Verify commit has successful CI execution controls" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture checkout-ref-drift)"
  # shellcheck disable=SC2016 # GitHub expression is an intentional workflow fixture literal.
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1' \
    '          ref: ${{ env.COMMIT_SHA }}' \
    '          ref: main'
  assert_failure_contains "deployment checkout ref drift" \
    "deployment checkout step" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture skipped-dependency-install)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Install JavaScript dependencies' \
    '        if: false'
  assert_failure_contains "skipped deployment dependency installation" \
    "dependency installation execution controls" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture skipped-frontend-build)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Build static frontend' \
    '        if: false'
  assert_failure_contains "skipped deployment Frontend build" \
    "Frontend build execution controls" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture disabled-secret-cleanup)"
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Remove ephemeral Worker secrets file' \
    '        if: always()' \
    '        if: false'
  assert_failure_contains "disabled Worker secret cleanup" \
    "deployment Worker secret cleanup step" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture skipped-deployment-smoke-test)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Smoke test' \
    '        if: false'
  assert_failure_contains "skipped deployment smoke test" \
    "deployment smoke test execution controls" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture skipped-deploy-job)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '  deploy:' \
    '    if: false'
  assert_failure_contains "skipped deploy job" \
    "deployment job field inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture tolerated-deploy-job)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '  deploy:' \
    '    continue-on-error: true'
  assert_failure_contains "tolerated deploy job failure" \
    "deployment job field inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-job-shell-default)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '  deploy:' \
    $'    defaults:
      run:
        shell: bash {0} || true'
  assert_failure_contains "deployment job shell default" \
    "must not define root or job command defaults" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-root-bash-env)"
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    'jobs:' \
    $'env:
  BASH_ENV: /tmp/untrusted-root-env'
  assert_failure_contains "deployment root BASH_ENV" \
    "must not expose BASH_ENV at root, job, or step scope" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-job-bash-env)"
  # shellcheck disable=SC2016 # GitHub expression is an intentional fixture literal.
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      COMMIT_SHA: ${{ needs.resolve.outputs.commit_sha }}' \
    '      BASH_ENV: /tmp/untrusted-job-env'
  assert_failure_contains "deployment job BASH_ENV" \
    "must not expose BASH_ENV at root, job, or step scope" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-step-bash-env)"
  # shellcheck disable=SC2016 # GitHub expression is an intentional fixture literal.
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '          MIGRATION_DATABASE_URL: ${{ secrets.NEON_MIGRATION_DATABASE_URL }}' \
    '          BASH_ENV: /tmp/untrusted-step-env'
  assert_failure_contains "deployment step BASH_ENV" \
    "must not expose BASH_ENV at root, job, or step scope" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-job-secret)"
  # shellcheck disable=SC2016 # GitHub expression is an intentional fixture literal.
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      COMMIT_SHA: ${{ needs.resolve.outputs.commit_sha }}' \
    '      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}'
  assert_failure_contains "deployment job secret exposure" \
    "deployment job must not expose secrets" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture checkout-app-secret)"
  # shellcheck disable=SC2016 # GitHub expression is an intentional fixture literal.
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1' \
    $'        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}'
  assert_failure_contains "checkout application secret exposure" \
    "deployment checkout step" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture skipped-backend-configcheck)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Validate Backend runtime configuration' \
    '        if: false'
  assert_failure_contains "skipped Backend configcheck" \
    "Validate Backend runtime configuration execution controls" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture tolerated-migration-failure)"
  insert_after_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Apply database migrations' \
    '        continue-on-error: true'
  assert_failure_contains "tolerated migration failure" \
    "Apply database migrations execution controls" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture custom-migration-shell)"
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Apply database migrations' \
    '        shell: bash' \
    '        shell: bash {0} || true'
  assert_failure_contains "custom migration shell" \
    "Apply database migrations execution controls" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture extra-pre-migration-deploy)"
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Apply database migrations' \
    $'      - name: Premature deploy fixture
        run: pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match exec wrangler deploy
'
  assert_failure_contains "extra pre-migration deploy" \
    "deployment step inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture extra-migration-command)"
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '      - name: Apply database migrations' \
    $'      - name: Extra migration fixture
        working-directory: backend
        run: go run ./cmd/migrate
'
  assert_failure_contains "extra migration command" \
    "deployment step inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture validation-secret-source-swap)"
  # shellcheck disable=SC2016 # GitHub expressions are intentional fixture literals.
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    "      - name: Validate required deployment inputs" \
    '          DATABASE_URL: ${{ secrets.NEON_DATABASE_URL }}' \
    '          DATABASE_URL: ${{ secrets.OPENAI_API_KEY }}'
  assert_failure_contains "validation secret source swap" \
    "deployment contract/input validation secret environment" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture secret-file-source-swap)"
  # shellcheck disable=SC2016 # GitHub expressions are intentional fixture literals.
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    "      - name: Create ephemeral Worker secrets file" \
    '          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}' \
    '          OPENAI_API_KEY: ${{ secrets.NEON_DATABASE_URL }}'
  assert_failure_contains "Worker secret-file source swap" \
    "deployment contract/workflow Worker secret file environment" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture cloudflare-secret-source-swap)"
  # shellcheck disable=SC2016 # GitHub expressions are intentional fixture literals.
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    "      - name: Deploy Worker, static assets, and Container" \
    '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}' \
    '          CLOUDFLARE_API_TOKEN: ${{ secrets.OPENAI_API_KEY }}'
  assert_failure_contains "Cloudflare credential source swap" \
    "deployment contract/workflow Worker deploy step" \
    bash "${fixture}/scripts/check-config-parity.sh"
  fixture="$(new_config_fixture secret-classification-drift)"
  # shellcheck disable=SC2016 # GitHub expressions are intentional fixture literals.
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    "      - name: Validate Backend runtime configuration" \
    '          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}' \
    '          OPENAI_API_KEY: ${{ secrets.NEON_DATABASE_URL }}'
  assert_failure_contains "deployment secret classification drift" \
    "deployment contract/configcheck environment" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture workflow-expression-suffix)"
  # shellcheck disable=SC2016 # GitHub expressions are intentional fixture literals.
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    "      - name: Apply database migrations" \
    '          DATABASE_URL: ${{ secrets.NEON_MIGRATION_DATABASE_URL }}' \
    '          DATABASE_URL: ${{ secrets.NEON_MIGRATION_DATABASE_URL || secrets.NEON_DATABASE_URL }}'
  assert_failure_contains "deployment workflow expression suffix" \
    "deployment contract/migration environment" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture migration-source-swap)"
  # shellcheck disable=SC2016 # GitHub expressions are intentional fixture literals.
  replace_exact_line_after_marker \
    "${fixture}/.github/workflows/deploy.yml" \
    "      - name: Apply database migrations" \
    '          DATABASE_URL: ${{ secrets.NEON_MIGRATION_DATABASE_URL }}' \
    '          DATABASE_URL: ${{ secrets.NEON_DATABASE_URL }}'
  assert_failure_contains "migration database source swap" \
    "deployment contract/migration environment" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-variable-source-swap)"
  # shellcheck disable=SC2016 # Bash parameter expansions are intentional fixture literals.
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '            variable_args+=(--var "${name}:${!name}")' \
    '            variable_args+=(--var "${name}:${AI_MODEL}")'
  assert_failure_contains "Worker variable source swap" \
    "deployment contract/workflow Worker target/source mappings" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-variable-loop-source)"
  # shellcheck disable=SC2016 # Bash parameter expansion is an intentional fixture literal.
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '          for name in "${variable_names[@]}"; do' \
    '          for name in AI_MODEL; do'
  assert_failure_contains "Worker variable loop source drift" \
    "deployment contract/workflow Worker variable loop" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-variable-array-reassignment)"
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    $'          variable_args=()' \
    $'          variable_names=(PUBLIC_ORIGIN)'
  assert_failure_contains "Worker variable array reassignment" \
    "deployment contract/workflow Worker deploy step" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-modeled-source-reassignment)"
  # shellcheck disable=SC2016 # Bash parameter expansions are intentional fixture literals.
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    $'          variable_args=()' \
    $'          PUBLIC_ORIGIN="${DATABASE_URL}"'
  assert_failure_contains "Worker modeled source reassignment" \
    "deployment contract/workflow Worker deploy step" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-conditional-condition)"
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    "          if [[ \"\${BETA_ADMISSION_MODE}\" == 'closed' ]]; then" \
    "          if [[ \"\${BETA_ADMISSION_MODE}\" == 'off' ]]; then"
  assert_failure_contains "Worker conditional condition drift" \
    "deployment contract/workflow closed-Beta variable condition" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture duplicate-worker-deploy-step)"
  insert_before_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    $'      - name: Deploy Worker, static assets, and Container' \
    $'      - name: Deploy Worker, static assets, and Container\n        shell: bash\n        run: true'
  assert_failure_contains "duplicate Worker deploy step" \
    "deployment step inventory" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-variable-consumer-swap)"
  # shellcheck disable=SC2016 # Bash array expansions are intentional fixture literals.
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    $'            "${variable_args[@]}" \\' \
    $'            "${variable_names[@]}" \\'
  assert_failure_contains "Wrangler variable argument consumer swap" \
    "deployment contract/workflow Worker variable argument lifecycle" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-secret-source-swap)"
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    $'          const values = Object.fromEntries(names.map((name) => [name, process.env[name]]));' \
    $'          const values = Object.fromEntries(names.map((name) => [name, process.env.OPENAI_API_KEY]));'
  assert_failure_contains "Worker secret source swap" \
    "deployment contract/workflow Worker secret sources" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-secret-file-destination)"
  # shellcheck disable=SC2016 # GitHub expressions are intentional fixture literals.
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    '          SECRETS_FILE: ${{ runner.temp }}/fukamu-cycle-worker-secrets.json' \
    '          SECRETS_FILE: ${{ runner.temp }}/different-worker-secrets.json'
  assert_failure_contains "Worker secret file destination drift" \
    "deployment contract/workflow Worker secret file environment" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-secret-file-mode)"
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    $'          fs.writeFileSync(process.env.SECRETS_FILE, JSON.stringify(values), { mode: 0o600 });' \
    $'          fs.writeFileSync(process.env.SECRETS_FILE, JSON.stringify(values), { mode: 0o644 });'
  assert_failure_contains "Worker secret file mode drift" \
    "deployment contract/workflow Worker secret file write" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture worker-secret-file-consumer)"
  # shellcheck disable=SC2016 # Bash parameter expansions are intentional fixture literals.
  replace_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    $'            --secrets-file "${RUNNER_TEMP}/fukamu-cycle-worker-secrets.json" \\' \
    $'            --secrets-file "${RUNNER_TEMP}/different-worker-secrets.json" \\'
  assert_failure_contains "Wrangler secret file consumer drift" \
    "deployment contract/workflow Wrangler deploy consumer" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture wrangler-variable-sentinel)"
  replace_exact_line \
    "${fixture}/cloudflare/wrangler.jsonc" \
    $'    "RATE_AI_PER_IP_MINUTE": "SET_BY_DEPLOY_WORKFLOW",' \
    $'    "RATE_AI_PER_IP_MINUTE": "STALE_LOCAL_VALUE",'
  assert_failure_contains "Wrangler variable sentinel drift" \
    "deployment contract/Wrangler variable sentinels" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture deploy-drift)"
  remove_exact_line \
    "${fixture}/cloudflare/wrangler.jsonc" \
    $'    "RATE_AI_PER_IP_MINUTE": "SET_BY_DEPLOY_WORKFLOW",'
  assert_failure_contains "deploy contract drift" "deployment contract/Wrangler vars" \
    bash "${fixture}/scripts/check-config-parity.sh"

  fixture="$(new_config_fixture workflow-drift)"
  remove_exact_line \
    "${fixture}/.github/workflows/deploy.yml" \
    $'            RATE_AI_PER_USER_MINUTE RATE_AI_PER_SESSION_MINUTE RATE_AI_PER_IP_MINUTE'
  assert_failure_contains "deployment workflow drift" "deployment contract/workflow Worker variables" \
    bash "${fixture}/scripts/check-config-parity.sh"

  pass "configuration parity gate has deterministic cross-boundary negative fixtures"
}

test_docs_gate
test_config_gate
