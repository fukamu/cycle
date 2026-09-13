import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readRepositoryFile = (path) =>
  readFileSync(join(repositoryRoot, path), "utf8");
const contract = JSON.parse(
  readRepositoryFile("config/deployment-contract.json"),
);
const expectedParse5Version = "8.0.1";
const parse5ModulePath = process.env.FUKAMU_CONFIG_PARSE5_MODULE;
assert.ok(
  parse5ModulePath,
  "FUKAMU_CONFIG_PARSE5_MODULE must identify the pinned HTML parser",
);
const parse5Package = JSON.parse(
  readFileSync(resolve(dirname(parse5ModulePath), "../package.json"), "utf8"),
);
assert.equal(
  parse5Package.version,
  expectedParse5Version,
  "configuration parity must use the pinned HTML parser",
);
const { parse: parseHtml } = await import(pathToFileURL(parse5ModulePath).href);
const frontendPackage = JSON.parse(readRepositoryFile("frontend/package.json"));
assert.equal(
  frontendPackage.devDependencies.parse5,
  expectedParse5Version,
  "Frontend HTML parser dependency must remain exactly pinned",
);
const expectedTypeScriptVersion = "5.9.3";
const maximumSyntaxDiagnostics = 8;
const typeScriptModulePath = process.env.FUKAMU_CONFIG_TYPESCRIPT_MODULE;
assert.ok(
  typeScriptModulePath,
  "FUKAMU_CONFIG_TYPESCRIPT_MODULE must identify the pinned TypeScript parser",
);
const typescript = (await import(pathToFileURL(typeScriptModulePath).href))
  .default;
assert.equal(
  typescript.version,
  expectedTypeScriptVersion,
  "configuration parity must use the pinned TypeScript parser",
);
const cloudflarePackage = JSON.parse(
  readRepositoryFile("cloudflare/package.json"),
);
assert.equal(
  cloudflarePackage.devDependencies.typescript,
  expectedTypeScriptVersion,
  "Cloudflare TypeScript parser dependency must remain exactly pinned",
);
const workflow = readRepositoryFile(".github/workflows/deploy.yml");
const resolveJobPreamble = between(workflow, "  resolve:\n", "\n    steps:\n");
const deployDispatchPreflightStep = extractStep(
  workflow,
  "Verify deploy dispatch preflight",
);
const resolveStep = extractStep(workflow, "Resolve approved deployment");
const candidateDeployAndDrainScript = readRepositoryFile(
  "scripts/run-staging-candidate-deploy-and-drain.sh",
);
const workerSecretsMaterializer = readRepositoryFile(
  "scripts/materialize-staging-worker-secrets.mjs",
);
const drainEvidenceCLI = readRepositoryFile(
  "scripts/check-cloudflare-drain-evidence.mjs",
);
const rolloutEvidenceWriter = readRepositoryFile(
  "scripts/write-staging-rollout-evidence.mjs",
);
const stagingRolloutBrowserEntry = readRepositoryFile(
  "frontend/e2e/staging-csrf-rollout-entry.mjs",
);
const stagingRolloutContract = readRepositoryFile(
  "scripts/lib/staging-csrf-rollout.mjs",
);
const stagingDeployRetryCheckpoint = readRepositoryFile(
  "scripts/staging-deploy-retry-checkpoint.mjs",
);
const stagingDeployRetryResolver = readRepositoryFile(
  "scripts/resolve-staging-deploy-retry.mjs",
);
const validationStep = extractStep(
  workflow,
  "Validate required deployment inputs",
);
const validationCommand = extractRunCommand(validationStep);
const validationRequiredKeys = requiredInputNames(contract);
const backendSecretSources = secretSourceMappings(
  contract.backend.secrets,
  contract.deploy.aliases,
);
const validationSecretSources = secretSourceMappings(
  [
    ...contract.backend.secrets,
    ...contract.deploy.requiredOnly,
    ...contract.closedBeta.conditionalSecrets,
  ],
  contract.deploy.aliases,
);
const workerSecretSources = secretSourceMappings(
  [...contract.backend.secrets, ...contract.closedBeta.conditionalSecrets],
  contract.deploy.aliases,
);
const cloudflareDeploySecretSources = secretSourceMappings([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
]);
const supportedBackendReaderMethods = new Set([
  "boolValue",
  "durationDays",
  "durationMinutes",
  "durationSeconds",
  "floatList",
  "floatValue",
  "int32Value",
  "intValue",
  "stringValue",
]);
const productionFrontendEnvironmentAccessAllowlist = [
  "frontend/src/features/app-referral/config.ts:VITE_APP_REFERRAL_URL",
  "frontend/src/features/auth/GoogleIdentityButton.tsx:VITE_GOOGLE_WEB_CLIENT_ID",
  "frontend/src/features/auth/turnstile.ts:VITE_TURNSTILE_SITE_KEY",
];
const productionBackendEnvironmentAccessAllowlist = [
  "backend/cmd/cleanup/main.go:os.LookupEnv:consumer=os.Exit(runCleanupCommand(ctx, os.Args[1:], os.LookupEnv, os.Stdout, dependencies))",
  "backend/cmd/configcheck/main.go:os.LookupEnv:consumer=return checkConfigurationWithLookup(os.LookupEnv)",
  "backend/cmd/kpireport/main.go:os.LookupEnv:consumer=lookupEnvironment := os.LookupEnv",
  "backend/cmd/migrate/main.go:os.Getenv:DATABASE_URL",
  "backend/cmd/migrate/main.go:os.Getenv:MIGRATIONS_DIR",
  "backend/cmd/server/main.go:os.LookupEnv:consumer=settings, err := config.Load(os.LookupEnv)",
  "backend/internal/infrastructure/observability/runtime.go:os.Environ:<all>",
  "backend/internal/infrastructure/postgres/cleanup_repository.go:os.LookupEnv:consumer=poolConfig, err := cleanupPoolConfig(databaseURL, os.LookupEnv)",
  "backend/internal/infrastructure/postgres/kpi_report_repository.go:os.LookupEnv:consumer=poolConfig, err := kpiReportPoolConfig(databaseURL, os.LookupEnv)",
];
const approvedCleanupPostgresEnvironmentVariables = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGAPPNAME",
  "PGCONNECT_TIMEOUT",
  "PGSSLMODE",
  "PGSSLKEY",
  "PGSSLCERT",
  "PGSSLSNI",
  "PGSSLROOTCERT",
  "PGSSLPASSWORD",
  "PGSSLNEGOTIATION",
  "PGTARGETSESSIONATTRS",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGTZ",
  "PGOPTIONS",
  "PGMINPROTOCOLVERSION",
  "PGMAXPROTOCOLVERSION",
  "PGCHANNELBINDING",
  "PGREQUIREAUTH",
];

test("deployment contract is the exact repository handoff classification", () => {
  const { backend, closedBeta, deploy, frontend } = contract;
  assert.equal(contract.version, 1);
  assert.doesNotMatch(
    workflow,
    /^(?:defaults| {4}defaults):/m,
    "deployment workflow must not define root or job command defaults",
  );
  assert.doesNotMatch(
    workflow,
    /^\s*BASH_ENV\s*:/m,
    "deployment workflow must not expose BASH_ENV at root, job, or step scope",
  );
  assert.equal(
    between(workflow, "permissions:\n", "\nconcurrency:\n").trimEnd(),
    ["  actions: read", "  contents: read"].join("\n"),
    "deployment workflow permissions must remain read-only",
  );
  assert.equal(
    between(workflow, "concurrency:\n", "\njobs:\n").trimEnd(),
    ["  group: staging-deploy", "  cancel-in-progress: false"].join("\n"),
    "deployment workflow must serialize staging changes without cancelling an active rollout",
  );
  const resolveJob = between(workflow, "  resolve:\n", "\n  deploy:\n");
  for (const requiredResolveLine of [
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    outputs:",
    "      ci_run_id: ${{ steps.resolve.outputs.ci_run_id }}",
    "      commit_sha: ${{ steps.resolve.outputs.commit_sha }}",
    "      infra_evidence_kind: ${{ steps.resolve.outputs.infra_evidence_kind }}",
    "      infra_evidence_run_id: ${{ steps.resolve.outputs.infra_evidence_run_id }}",
    "      infra_plan_sha256: ${{ steps.verify_evidence.outputs.plan_sha256 }}",
    "      verified_run_attempt: ${{ steps.authorize_attempt.outputs.verified_run_attempt }}",
  ]) {
    assert.equal(
      resolveJobPreamble.split(requiredResolveLine).length - 1,
      1,
      `deployment resolve job contract: ${requiredResolveLine}`,
    );
  }
  assert.doesNotMatch(
    resolveJobPreamble,
    /^    (?:if|continue-on-error):/m,
    "deployment resolve job execution controls",
  );
  assert.doesNotMatch(
    between(workflow, "on:\n", "\npermissions:\n"),
    /\bworkflow_run\b/,
    "Staging deployment must never start automatically from workflow_run",
  );
  const dispatchContract = between(workflow, "on:\n", "\npermissions:\n");
  for (const invariant of [
    "  workflow_dispatch:",
    "      mode:",
    "        type: choice",
    "          - normal",
    "          - recovery",
    "      infra_evidence_run_id:",
  ]) {
    assert.ok(
      dispatchContract.split("\n").includes(invariant),
      `deployment manual trigger must retain ${invariant.trim()}`,
    );
  }
  assert.doesNotMatch(
    dispatchContract,
    /recovery_confirmation/,
    "the recovery mode choice must not be duplicated by a typed phrase",
  );
  const modeInput = between(
    dispatchContract,
    "      mode:\n",
    "      infra_evidence_run_id:\n",
  );
  assert.match(modeInput, /^        required: true$/m);
  assert.match(modeInput, /^        type: choice$/m);
  assert.deepEqual(
    modeInput.split("\n").filter((line) => /^          - /.test(line)),
    ["          - normal", "          - recovery"],
  );
  const evidenceInput = dispatchContract.slice(
    dispatchContract.indexOf("      infra_evidence_run_id:\n"),
  );
  assert.match(evidenceInput, /^        required: false$/m);
  assert.match(evidenceInput, /^        type: string$/m);
  assertStepExecutionControls(
    deployDispatchPreflightStep,
    "Verify deploy dispatch preflight",
    "bash",
  );
  assert.deepEqual(stepEnvironmentMappings(deployDispatchPreflightStep), {
    EXPECTED_APPROVER: {
      kind: "literal",
      value: "${{ vars.STAGING_DEPLOY_APPROVER }}",
    },
    INFRA_EVIDENCE_RUN_ID: {
      kind: "literal",
      value: "${{ inputs.infra_evidence_run_id }}",
    },
    MODE: { kind: "literal", value: "${{ inputs.mode }}" },
  });
  for (const fragment of [
    "Deploy Staging accepts manual workflow dispatch only.",
    "Deploy Staging permits at most one checkpoint-authorized workflow rerun.",
    "Deploy Staging is allowed only from main.",
    "Missing repository variable STAGING_DEPLOY_APPROVER.",
    "Deploy Staging actor and triggering actor must both match STAGING_DEPLOY_APPROVER.",
    "Normal deployment requires a numeric Terraform infrastructure evidence run ID.",
    "Recovery deployment must not include a Terraform infrastructure evidence run ID.",
    "Deploy Staging mode must be normal or recovery.",
    '[[ ! "${EXPECTED_APPROVER}" =~ ^[[:alnum:]]([[:alnum:]-]{0,37}[[:alnum:]])?$ || "${EXPECTED_APPROVER}" =~ -- ]]',
    '[[ "${GITHUB_ACTOR,,}" != "${EXPECTED_APPROVER,,}" || "${GITHUB_TRIGGERING_ACTOR,,}" != "${EXPECTED_APPROVER,,}" ]]',
    "[[ \"${GITHUB_RUN_ATTEMPT}\" != '1' && \"${GITHUB_RUN_ATTEMPT}\" != '2' ]]",
    '[[ ! "${INFRA_EVIDENCE_RUN_ID}" =~ ^[1-9][0-9]*$ ]]',
  ]) {
    assert.equal(
      deployDispatchPreflightStep.split(fragment).length - 1,
      1,
      `deployment dispatch preflight must contain exactly one guard: ${fragment}`,
    );
  }
  assert.match(
    deployDispatchPreflightStep,
    /case "\$\{MODE\}" in[\s\S]*normal\)[\s\S]*recovery\)[\s\S]*\*\)/,
    "deployment dispatch preflight must fail closed across the two approved modes",
  );
  assertStepExecutionControls(
    resolveStep,
    "Resolve approved deployment",
    "bash",
  );
  assert.equal(extractStepProperty(resolveStep, "id"), "resolve");
  assert.deepEqual(stepEnvironmentMappings(resolveStep), {
    DISPATCH_SHA: { kind: "literal", value: "${{ github.sha }}" },
    GH_TOKEN: { kind: "literal", value: "${{ github.token }}" },
    INFRA_EVIDENCE_RUN_ID: {
      kind: "literal",
      value: "${{ inputs.infra_evidence_run_id }}",
    },
    MODE: { kind: "literal", value: "${{ inputs.mode }}" },
  });
  assert.equal(
    resolveStep.split("gh api \\").length - 1,
    4,
    "approved deployment resolution must keep the exact GitHub API invocation count",
  );
  for (const fragment of [
    '"/repos/${GITHUB_REPOSITORY}/git/ref/heads/main"',
    '"/repos/${GITHUB_REPOSITORY}/actions/runs/${INFRA_EVIDENCE_RUN_ID}"',
    '"/repos/${GITHUB_REPOSITORY}/actions/runs/${INFRA_EVIDENCE_RUN_ID}/artifacts?per_page=100"',
    '"/repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs"',
    '.name == "Terraform Plan Staging"',
    '.path == ".github/workflows/terraform-plan.yml"',
    '.name == "Terraform Apply Staging"',
    '.path == ".github/workflows/terraform-apply.yml"',
    "(.[0].id | tostring) == $run_id",
    '.event == "workflow_dispatch"',
    '.status == "completed"',
    '.conclusion == "success"',
    '.head_branch == "main"',
    ".head_repository.full_name == $repository",
    '"terraform-plan-staging-${evidence_head_sha}-no_changes"',
    '"terraform-apply-staging-${evidence_head_sha}"',
    "if ($matches | length) == 1 then",
    '.name == "CI"',
    '.path == ".github/workflows/ci.yml"',
    'echo "ci_run_id=${successful_ci_run_id}"',
    'echo "commit_sha=${current_main_sha}"',
    'echo "infra_evidence_kind=${infra_evidence_kind}"',
    'echo "infra_evidence_run_id=${INFRA_EVIDENCE_RUN_ID}"',
  ]) {
    assert.ok(
      resolveStep.includes(fragment),
      `approved deployment resolution is missing: ${fragment}`,
    );
  }
  const resolveNodeSetupStep = extractUsesStep(
    resolveJob,
    "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0",
  );
  assert.equal(
    resolveNodeSetupStep.trimEnd(),
    [
      "      - uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0",
      "        with:",
      "          runtime: node@24",
      "          install: false",
    ].join("\n"),
    "Terraform and retry evidence verification must pin Node 24",
  );
  const downloadTerraformEvidenceStep = extractStep(
    workflow,
    "Download approved Terraform evidence",
  );
  assert.equal(
    downloadTerraformEvidenceStep.trimEnd(),
    [
      "      - name: Download approved Terraform evidence",
      "        if: inputs.mode == 'normal'",
      "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
      "        with:",
      "          name: ${{ steps.resolve.outputs.infra_evidence_artifact_name }}",
      "          path: ${{ runner.temp }}/fukamu-cycle-terraform-evidence",
      "          github-token: ${{ github.token }}",
      "          run-id: ${{ steps.resolve.outputs.infra_evidence_run_id }}",
    ].join("\n"),
    "normal mode must download only the resolved Terraform evidence",
  );
  const verifyTerraformEvidenceStep = extractStep(
    workflow,
    "Verify approved Terraform evidence",
  );
  assert.equal(
    extractStepProperty(verifyTerraformEvidenceStep, "if"),
    "inputs.mode == 'normal'",
  );
  assert.equal(
    extractStepProperty(verifyTerraformEvidenceStep, "id"),
    "verify_evidence",
  );
  assert.deepEqual(stepEnvironmentMappings(verifyTerraformEvidenceStep), {
    EXPECTED_COMMIT_SHA: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.commit_sha }}",
    },
    EXPECTED_WORKFLOW_RUN_ID: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.infra_evidence_run_id }}",
    },
    INFRA_EVIDENCE_KIND: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.infra_evidence_kind }}",
    },
    TERRAFORM_EVIDENCE_DIRECTORY: {
      kind: "literal",
      value: "${{ runner.temp }}/fukamu-cycle-terraform-evidence",
    },
  });
  for (const fragment of [
    "no_changes_plan)",
    "TERRAFORM_EVIDENCE_OPERATION=verify_plan",
    "EXPECTED_PLAN_RESULT=no_changes",
    "applied_plan)",
    "TERRAFORM_EVIDENCE_OPERATION=verify_apply",
    'plan_sha256="$(node ./scripts/terraform-evidence.mjs)"',
    'echo "plan_sha256=${plan_sha256}" >> "${GITHUB_OUTPUT}"',
  ]) {
    assert.ok(
      verifyTerraformEvidenceStep.includes(fragment),
      `Terraform evidence verification is missing: ${fragment}`,
    );
  }
  const resolveRetryStep = extractStep(
    workflow,
    "Resolve prior safe retry checkpoint",
  );
  assert.equal(extractStepProperty(resolveRetryStep, "shell"), "bash");
  assert.doesNotMatch(resolveRetryStep, /^        continue-on-error:/m);
  assert.equal(
    extractStepProperty(resolveRetryStep, "if"),
    "github.run_attempt == '2'",
  );
  assert.equal(extractStepProperty(resolveRetryStep, "id"), "resolve_retry");
  assert.deepEqual(stepEnvironmentMappings(resolveRetryStep), {
    COMMIT_SHA: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.commit_sha }}",
    },
    DEPLOY_MODE: { kind: "literal", value: "${{ inputs.mode }}" },
    EXPECTED_APPROVER: {
      kind: "literal",
      value: "${{ vars.STAGING_DEPLOY_APPROVER }}",
    },
    GH_TOKEN: { kind: "literal", value: "${{ github.token }}" },
  });
  for (const fragment of [
    'cache_key="$(node ./scripts/resolve-staging-deploy-retry.mjs)"',
    "^staging-deploy-retry-[0-9a-f]{40}-[1-9][0-9]*-1$",
    'echo "cache_key=${cache_key}" >> "${GITHUB_OUTPUT}"',
  ]) {
    assert.equal(
      resolveRetryStep.split(fragment).length - 1,
      1,
      `retry checkpoint resolution must remain closed and unique: ${fragment}`,
    );
  }

  const restoreRetryStep = extractStep(
    workflow,
    "Restore prior safe retry checkpoint",
  );
  assert.equal(
    restoreRetryStep.trimEnd(),
    [
      "      - name: Restore prior safe retry checkpoint",
      "        if: github.run_attempt == '2'",
      "        id: restore_retry",
      "        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0",
      "        with:",
      "          path: ${{ runner.temp }}/fukamu-cycle-staging-deploy-retry.json",
      "          key: ${{ steps.resolve_retry.outputs.cache_key }}",
      "          fail-on-cache-miss: true",
    ].join("\n"),
    "attempt 2 must restore only the exact immutable checkpoint cache key resolved from its own workflow run",
  );

  const verifyRetryStep = extractStep(
    workflow,
    "Verify prior safe retry checkpoint",
  );
  assert.equal(
    extractStepProperty(verifyRetryStep, "if"),
    "github.run_attempt == '2'",
  );
  assert.equal(extractStepProperty(verifyRetryStep, "id"), "verify_retry");
  assert.deepEqual(stepEnvironmentMappings(verifyRetryStep), {
    COMMIT_SHA: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.commit_sha }}",
    },
    DEPLOY_MODE: { kind: "literal", value: "${{ inputs.mode }}" },
    EXACT_MAIN_CI_RUN_ID: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.ci_run_id }}",
    },
    INFRA_EVIDENCE_KIND: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.infra_evidence_kind }}",
    },
    INFRA_EVIDENCE_RUN_ID: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.infra_evidence_run_id }}",
    },
    INFRA_PLAN_SHA256: {
      kind: "literal",
      value: "${{ steps.verify_evidence.outputs.plan_sha256 }}",
    },
    RETRY_CACHE_HIT: {
      kind: "literal",
      value: "${{ steps.restore_retry.outputs.cache-hit }}",
    },
    STAGING_DEPLOY_CHECKPOINT_OPERATION: {
      kind: "literal",
      value: "verify_retry",
    },
    STAGING_DEPLOY_RETRY_EVIDENCE_FILE: {
      kind: "literal",
      value: "${{ runner.temp }}/fukamu-cycle-staging-deploy-retry.json",
    },
  });
  for (const fragment of [
    "if [[ \"${RETRY_CACHE_HIT}\" != 'true' ]]; then",
    "node ./scripts/staging-deploy-retry-checkpoint.mjs",
    "echo 'verified=true' >> \"${GITHUB_OUTPUT}\"",
  ]) {
    assert.equal(
      verifyRetryStep.split(fragment).length - 1,
      1,
      `retry checkpoint verification must remain fail-closed: ${fragment}`,
    );
  }
  const preApprovalMainGuard = extractStep(
    workflow,
    "Re-verify deployment commit before Staging approval",
  );
  assertStepExecutionControls(
    preApprovalMainGuard,
    "Re-verify deployment commit before Staging approval",
    "bash",
  );
  assert.deepEqual(stepEnvironmentMappings(preApprovalMainGuard), {
    COMMIT_SHA: {
      kind: "literal",
      value: "${{ steps.resolve.outputs.commit_sha }}",
    },
    GH_TOKEN: { kind: "literal", value: "${{ github.token }}" },
  });
  assert.equal(
    preApprovalMainGuard.split(
      '"/repos/${GITHUB_REPOSITORY}/git/ref/heads/main"',
    ).length - 1,
    1,
    "the deployment commit must be checked against current main immediately before staging approval",
  );
  const authorizeAttemptStep = extractStep(
    workflow,
    "Authorize deploy job attempt",
  );
  assertStepExecutionControls(
    authorizeAttemptStep,
    "Authorize deploy job attempt",
    "bash",
  );
  assert.equal(
    extractStepProperty(authorizeAttemptStep, "id"),
    "authorize_attempt",
  );
  assert.deepEqual(stepEnvironmentMappings(authorizeAttemptStep), {
    RETRY_CHECKPOINT_VERIFIED: {
      kind: "literal",
      value: "${{ steps.verify_retry.outputs.verified }}",
    },
  });
  for (const fragment of [
    'case "${GITHUB_RUN_ATTEMPT}" in',
    "1) ;;",
    "2)",
    "[[ \"${RETRY_CHECKPOINT_VERIFIED}\" != 'true' ]]",
    "*)",
    'echo "verified_run_attempt=${GITHUB_RUN_ATTEMPT}" >> "${GITHUB_OUTPUT}"',
  ]) {
    assert.equal(
      authorizeAttemptStep.split(fragment).length - 1,
      1,
      `deploy attempt authorization must bind attempts 1 and 2 exactly once: ${fragment}`,
    );
  }
  assert.ok(
    resolveJob.indexOf("      - name: Resolve prior safe retry checkpoint\n") <
      resolveJob.indexOf(
        "      - name: Restore prior safe retry checkpoint\n",
      ) &&
      resolveJob.indexOf(
        "      - name: Restore prior safe retry checkpoint\n",
      ) <
        resolveJob.indexOf(
          "      - name: Verify prior safe retry checkpoint\n",
        ) &&
      resolveJob.indexOf("      - name: Verify prior safe retry checkpoint\n") <
        resolveJob.indexOf("      - name: Authorize deploy job attempt\n"),
    "attempt 2 must resolve, restore, verify, and authorize its checkpoint in order",
  );

  const deployJob = between(workflow, "  deploy:\n", "");
  const deployJobPreamble = between(workflow, "  deploy:\n", "\n    steps:\n");
  for (const expectedJobLine of [
    "    needs: resolve",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 45",
    "      name: staging",
    "      url: https://cycle.staging.fukamu.matoruru.com",
  ]) {
    assert.equal(
      deployJobPreamble.split(expectedJobLine).length - 1,
      1,
      `deployment job contract: ${expectedJobLine}`,
    );
  }
  assert.doesNotMatch(
    deployJobPreamble,
    /^    (?:if|continue-on-error):/m,
    "deployment job execution controls",
  );
  assert.equal(backend.fixed.length, 5);
  assert.deepEqual(backend.omitted, ["STATIC_DIR"]);
  assert.equal(backend.githubVariables.length, 38);
  assert.deepEqual(backend.derived, { AI_PRICING_MODEL: "AI_MODEL" });
  assert.equal(backend.secrets.length, 9);
  assert.equal(
    backend.githubVariables.includes("OTEL_EXPORTER_OTLP_ENDPOINT"),
    true,
  );
  assert.equal(backend.secrets.includes("OTEL_EXPORTER_OTLP_HEADERS"), true);
  assert.equal(backend.secrets.includes("OTEL_EXPORTER_OTLP_ENDPOINT"), false);
  assert.equal(
    backend.githubVariables.includes("OTEL_EXPORTER_OTLP_HEADERS"),
    false,
  );

  const backendKeys = [
    ...backend.fixed,
    ...backend.omitted,
    ...backend.githubVariables,
    ...Object.keys(backend.derived),
    ...backend.secrets,
  ];
  assertExactSet(backendKeys, configLookupKeys(), "Backend contract/config.go");
  assertNoUnapprovedProductionBackendEnvironmentAccess();
  assertApprovedProductionBackendEnvironmentConsumers();
  assertExactSet(
    backendKeys,
    environmentExampleKeys(),
    "Backend contract/.env.example",
  );
  assertExactSet(
    backendKeys,
    documentedBackendKeys(),
    "Backend contract/environment docs",
  );

  const handedToBackend = backendKeys.filter(
    (key) => !backend.omitted.includes(key),
  );
  const workerEnvironmentMappings = backendWorkerEnvironmentMappings();
  assertExactSet(
    handedToBackend,
    Object.keys(workerEnvironmentMappings),
    "Backend contract/Container envVars",
  );
  const requiredIndexMappings = Object.fromEntries(
    Object.entries(workerEnvironmentMappings).filter(
      ([, mapping]) => mapping.kind === "required",
    ),
  );
  assertExactSet(
    [
      ...backend.githubVariables,
      ...Object.keys(backend.derived),
      ...backend.secrets,
    ],
    Object.keys(requiredIndexMappings),
    "classified dynamic Container envVars",
  );

  const wrangler = parseJSONC(readRepositoryFile("cloudflare/wrangler.jsonc"));
  assertExactSet(
    [
      "$schema",
      "name",
      "main",
      "compatibility_date",
      "workers_dev",
      "preview_urls",
      "routes",
      "assets",
      "containers",
      "durable_objects",
      "migrations",
      "vars",
      "secrets",
      "observability",
    ],
    Object.keys(wrangler),
    "deployment contract/Wrangler root fields",
  );
  assert.equal(wrangler.main, "src/index.ts", "Wrangler Worker entry point");
  assert.deepEqual(wrangler.containers, [
    {
      class_name: "Backend",
      image: "../Dockerfile",
      max_instances: 1,
      instance_type: "lite",
      constraints: { regions: ["APAC"] },
    },
  ]);
  assert.deepEqual(wrangler.durable_objects, {
    bindings: [{ name: "BACKEND", class_name: "Backend" }],
  });
  assert.deepEqual(wrangler.migrations, [
    { tag: "v1", new_sqlite_classes: ["Backend"] },
  ]);
  const cloudflareTsconfig = JSON.parse(
    readRepositoryFile("cloudflare/tsconfig.json"),
  );
  assert.equal(
    Object.hasOwn(cloudflareTsconfig.compilerOptions, "baseUrl"),
    false,
    "Cloudflare TypeScript baseUrl aliases are forbidden",
  );
  assert.equal(
    Object.hasOwn(cloudflareTsconfig.compilerOptions, "paths"),
    false,
    "Cloudflare TypeScript path aliases are forbidden",
  );
  const expectedWranglerVariableNames = [
    ...backend.githubVariables,
    ...Object.keys(backend.derived),
    closedBeta.mode.name,
    ...closedBeta.conditionalVariables,
  ];
  assertExactSet(
    expectedWranglerVariableNames,
    Object.keys(wrangler.vars),
    "deployment contract/Wrangler vars",
  );
  assert.deepEqual(
    wrangler.vars,
    Object.fromEntries(
      expectedWranglerVariableNames.map((name) => [
        name,
        "SET_BY_DEPLOY_WORKFLOW",
      ]),
    ),
    "deployment contract/Wrangler variable sentinels",
  );
  assertExactSet(
    backend.secrets,
    wrangler.secrets.required,
    "deployment contract/Wrangler required secrets",
  );

  const jobEnvironment = between(deployJobPreamble, "    env:\n", "");
  for (const fragment of [
    "      COMMIT_SHA: ${{ needs.resolve.outputs.commit_sha }}",
    "      EXACT_MAIN_CI_RUN_ID: ${{ needs.resolve.outputs.ci_run_id }}",
    "      INFRA_EVIDENCE_KIND: ${{ needs.resolve.outputs.infra_evidence_kind }}",
    "      INFRA_EVIDENCE_RUN_ID: ${{ needs.resolve.outputs.infra_evidence_run_id }}",
    "      INFRA_PLAN_SHA256: ${{ needs.resolve.outputs.infra_plan_sha256 }}",
    "      DEPLOY_MODE: ${{ inputs.mode }}",
  ]) {
    assert.equal(
      jobEnvironment.split(fragment).length - 1,
      1,
      `deployment retry identity must remain bound at job scope: ${fragment}`,
    );
  }
  const workflowVariableMappings = expressionMappings(jobEnvironment, "vars");
  const expectedVariableSources = unique([
    ...backend.githubVariables,
    closedBeta.mode.name,
    ...closedBeta.conditionalVariables,
    ...Object.values(frontend.required),
    ...Object.values(frontend.optional),
  ]);
  assert.deepEqual(
    workflowVariableMappings,
    Object.fromEntries(expectedVariableSources.map((name) => [name, name])),
    "deployment contract/workflow variable classification",
  );

  assert.deepEqual(
    expressionMappings(jobEnvironment, "secrets"),
    {},
    "deployment job must not expose secrets",
  );

  const verifyResolvedAttemptStep = extractStep(
    workflow,
    "Verify resolved deployment attempt",
  );
  assertStepExecutionControls(
    verifyResolvedAttemptStep,
    "Verify resolved deployment attempt",
    "bash",
  );
  assert.deepEqual(stepEnvironmentMappings(verifyResolvedAttemptStep), {
    VERIFIED_RUN_ATTEMPT: {
      kind: "literal",
      value: "${{ needs.resolve.outputs.verified_run_attempt }}",
    },
  });
  assert.equal(
    verifyResolvedAttemptStep.split(
      '[[ ! "${GITHUB_RUN_ATTEMPT}" =~ ^[12]$ || "${VERIFIED_RUN_ATTEMPT}" != "${GITHUB_RUN_ATTEMPT}" ]]',
    ).length - 1,
    1,
    "the deploy job must reject partial reruns and attempts outside the bound",
  );
  assert.equal(
    matches(deployJob, /^      - ([^\n]+)$/gm)[0],
    "name: Verify resolved deployment attempt",
    "the resolved-attempt comparison must be the first deploy step",
  );

  const checkoutStep = extractUsesStep(
    deployJob,
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  );
  assertStepExecutionControls(checkoutStep, "deployment checkout", null);
  assert.equal(
    checkoutStep.trimEnd(),
    [
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "        with:",
      "          ref: ${{ env.COMMIT_SHA }}",
      "          persist-credentials: false",
    ].join("\n"),
    "deployment checkout step",
  );
  const pnpmSetupStep = extractUsesStep(
    deployJob,
    "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0",
  );
  assertStepExecutionControls(pnpmSetupStep, "deployment pnpm setup", null);
  assert.equal(
    pnpmSetupStep.trimEnd(),
    [
      "      - uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0",
      "        with:",
      "          runtime: node@24",
      "          cache: true",
      "          install: false",
    ].join("\n"),
    "deployment pnpm setup step",
  );
  const initializeRetryCheckpointStep = extractStep(
    workflow,
    "Initialize deployment retry checkpoint state",
  );
  assertStepExecutionControls(
    initializeRetryCheckpointStep,
    "Initialize deployment retry checkpoint state",
    null,
  );
  assert.equal(
    initializeRetryCheckpointStep.trimEnd(),
    [
      "      - name: Initialize deployment retry checkpoint state",
      "        env:",
      "          STAGING_DEPLOY_CHECKPOINT_OPERATION: initialize",
      "          STAGING_DEPLOY_CHECKPOINT_STATE_FILE: ${{ runner.temp }}/fukamu-cycle-staging-deploy-retry-state.json",
      "          STAGING_DEPLOY_RETRY_EVIDENCE_FILE: ${{ runner.temp }}/fukamu-cycle-staging-deploy-retry.json",
      "        run: node ./scripts/staging-deploy-retry-checkpoint.mjs",
    ].join("\n"),
    "the deploy job must initialize its exclusive checkpoint state before staging work",
  );
  const goSetupStep = extractUsesStep(
    workflow,
    "actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0",
  );
  assertStepExecutionControls(goSetupStep, "deployment Go setup", null);
  assert.equal(
    goSetupStep.trimEnd(),
    [
      "      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0",
      "        with:",
      "          go-version: 1.27.0",
      "          cache-dependency-path: backend/go.sum",
    ].join("\n"),
    "deployment Go setup step",
  );
  const installStep = extractStep(workflow, "Install JavaScript dependencies");
  assertStepExecutionControls(installStep, "dependency installation", null);
  assert.equal(
    installStep.trimEnd(),
    [
      "      - name: Install JavaScript dependencies",
      "        run: pnpm install --frozen-lockfile --ignore-scripts",
    ].join("\n"),
    "deployment dependency installation step",
  );
  const installTreeGuardStep = extractStep(
    workflow,
    "Verify dependency install preserved candidate tree",
  );
  assertStepExecutionControls(
    installTreeGuardStep,
    "dependency tree guard",
    null,
  );
  assert.equal(
    installTreeGuardStep.trimEnd(),
    [
      "      - name: Verify dependency install preserved candidate tree",
      "        run: |",
      "          set -euo pipefail",
      "          git diff --quiet --",
      "          git diff --cached --quiet --",
      '          untracked_files="$(git ls-files --others --exclude-standard)"',
      '          [[ -z "${untracked_files}" ]]',
    ].join("\n"),
    "deployment dependency tree guard step",
  );
  const browserInstallStep = extractStep(workflow, "Install staging Chromium");
  assertStepExecutionControls(
    browserInstallStep,
    "staging Chromium installation",
    null,
  );
  assert.equal(
    browserInstallStep.trimEnd(),
    [
      "      - name: Install staging Chromium",
      "        run: pnpm --filter fukamu-cycle-frontend --fail-if-no-match exec playwright install --with-deps chromium",
    ].join("\n"),
    "deployment staging Chromium installation step",
  );

  const expectedRequiredInputs = requiredInputNames(contract);
  assertExactSet(
    expectedRequiredInputs,
    validationRequiredKeys,
    "deployment contract/workflow required inputs",
  );
  assert.equal(validationCommand, "node ./scripts/validate-deploy-inputs.mjs");
  assert.deepEqual(
    stepEnvironmentMappings(validationStep),
    secretEnvironmentMappings(validationSecretSources),
    "deployment contract/input validation secret environment",
  );
  assert.doesNotMatch(validationStep, /run:\s*\|/);
  assert.doesNotMatch(
    validationStep,
    /\brequired=\(|\bjq\b|BETA_INVITES must|BETA_ADMISSION_COOKIE_TTL_DAYS must/,
  );
  assertStepExecutionControls(
    validationStep,
    "Validate required deployment inputs",
    null,
  );

  const stableRolloutStep = extractStep(
    workflow,
    "Run stable CSRF initial rollout and authoritative drain",
  );
  assertStepExecutionControls(
    stableRolloutStep,
    "Run stable CSRF initial rollout and authoritative drain",
    "bash",
  );
  assert.deepEqual(
    stepEnvironmentMappings(stableRolloutStep),
    {
      DEPLOY_MODE: { kind: "literal", value: "${{ inputs.mode }}" },
      EXACT_MAIN_CI_RUN_ID: {
        kind: "literal",
        value: "${{ needs.resolve.outputs.ci_run_id }}",
      },
      GH_TOKEN: { kind: "literal", value: "${{ github.token }}" },
      STAGING_BASE_URL: { kind: "environment", value: "PUBLIC_ORIGIN" },
      STAGING_ADMISSION_MODE: { kind: "literal", value: "auto" },
      STAGING_E2E_INVITE_TOKEN: {
        kind: "secret",
        value: "STAGING_E2E_INVITE_TOKEN",
      },
      STAGING_DEPLOY_CHECKPOINT_STATE_FILE: {
        kind: "literal",
        value:
          "${{ runner.temp }}/fukamu-cycle-staging-deploy-retry-state.json",
      },
      MIGRATION_DATABASE_URL: {
        kind: "secret",
        value: "NEON_MIGRATION_DATABASE_URL",
      },
      ...secretEnvironmentMappings(workerSecretSources),
      ...secretEnvironmentMappings(cloudflareDeploySecretSources),
    },
    "deployment contract/stable rollout environment",
  );
  assert.deepEqual(
    between(stableRolloutStep, "        run: |\n", "").split("\n").slice(0, 2),
    [
      "          set -euo pipefail",
      "          bash ./scripts/check-staging-csrf-rollout.sh",
    ],
    "stable rollout must run through the same-process browser orchestrator",
  );
  assert.equal(
    stableRolloutStep.split("bash ./scripts/check-staging-csrf-rollout.sh")
      .length - 1,
    1,
    "stable rollout must invoke exactly one browser orchestrator",
  );
  for (const fragment of [
    "STAGING_ROLLOUT_EVIDENCE_STAGE=smoke_passed",
    'STAGING_ROLLOUT_PENDING_EVIDENCE_FILE="${RUNNER_TEMP}/fukamu-cycle-stable-csrf-rollout-drained.json"',
    'STAGING_ROLLOUT_EVIDENCE_FILE="${RUNNER_TEMP}/fukamu-cycle-stable-csrf-rollout-smoke-passed.json"',
    "node ./scripts/write-staging-rollout-evidence.mjs",
  ]) {
    assert.equal(
      stableRolloutStep.split(fragment).length - 1,
      1,
      `stable rollout smoke evidence must be finalized exactly once: ${fragment}`,
    );
  }
  const fixedChildSpawn = [
    "  const child = spawn(",
    '    "bash",',
    '    ["./scripts/run-staging-candidate-deploy-and-drain.sh"],',
    "    {",
    "      cwd: repositoryRoot,",
    "      detached: true,",
    "      shell: false,",
    '      stdio: ["ignore", "ignore", "pipe"],',
    "    },",
    "  );",
  ].join("\n");
  assert.equal(
    stagingRolloutBrowserEntry.split(fixedChildSpawn).length - 1,
    1,
    "the live Browser process must await the exact fixed child command without arguments or inherited stdout",
  );
  assert.equal(
    stagingRolloutBrowserEntry.split(
      "selectCloudflareDrainDiagnostic(standardError)",
    ).length - 1,
    1,
    "the live Browser process must expose only one parsed closed drain diagnostic",
  );
  assert.equal(
    stagingRolloutBrowserEntry.split("await deploymentChildCompletion").length -
      1,
    1,
    "the live Browser process must await the deployment and drain child",
  );
  assert.ok(
    stagingRolloutContract.indexOf("await adapter.runDeployAndDrain();") <
      stagingRolloutContract.indexOf(
        "await adapter.prepareCandidateSession();",
      ),
    "the live candidate session must be created only after deployment and authoritative drain",
  );
  const anonymousSessionRoute = between(
    stagingRolloutBrowserEntry,
    "export function createStagingDeployAnonymousSessionRoute({\n",
    "\nexport function markStagingDeployCleanupFromRevokedResult(\n",
  );
  assert.equal(
    anonymousSessionRoute.split("markCleanupUnverified();").length - 1,
    1,
    "the anonymous-session request must make cleanup unverified exactly once",
  );
  assert.ok(
    anonymousSessionRoute.indexOf("markCleanupUnverified();") <
      anonymousSessionRoute.indexOf("await route.continue();"),
    "cleanup must become unverified before the anonymous POST is released",
  );
  assert.ok(
    stagingRolloutBrowserEntry.indexOf(
      'await pageA.route("**/api/v1/session/anonymous", anonymousSessionRoute);',
    ) <
      stagingRolloutBrowserEntry.indexOf(
        "session = await enterStagingCritical({",
      ),
    "the cleanup fence must be installed before anonymous session creation",
  );
  const revokedSessionVerification = between(
    stagingRolloutBrowserEntry,
    "export function markStagingDeployCleanupFromRevokedResult(\n",
    "\nfunction configurePage(page, timeout) {\n",
  );
  assert.equal(
    revokedSessionVerification.split("markCleanupVerified();").length - 1,
    1,
    "cleanup must become verified exactly once after revoked-session proof",
  );
  for (const fragment of [
    "result?.status === 401",
    'result?.code === "SESSION_EXPIRED"',
    "result?.authenticatedUserIDAbsent === true",
  ]) {
    assert.notEqual(
      revokedSessionVerification.indexOf(fragment),
      -1,
      `cleanup verification must include the complete 401 proof: ${fragment}`,
    );
    assert.ok(
      revokedSessionVerification.indexOf(fragment) <
        revokedSessionVerification.indexOf("markCleanupVerified();"),
      `cleanup verification must require the complete 401 proof: ${fragment}`,
    );
  }
  const primaryAccountCleanup = between(
    stagingRolloutContract,
    '    phase = "account_delete";\n',
    "  } catch (failure) {\n",
  );
  assert.ok(
    primaryAccountCleanup.indexOf("await retryAccountDelete(") <
      primaryAccountCleanup.indexOf("accountDeleted = true;") &&
      primaryAccountCleanup.indexOf("accountDeleted = true;") <
        primaryAccountCleanup.indexOf("await adapter.verifyRevokedSession()"),
    "the primary cleanup path must verify a valid account delete before the revoked-session 401",
  );
  const fallbackAccountCleanup = between(
    stagingRolloutContract,
    "  if (candidateUserID !== undefined && !accountDeleted) {\n",
    "\n  try {\n    await adapter.close();",
  );
  assert.ok(
    fallbackAccountCleanup.indexOf("await retryAccountDelete(") <
      fallbackAccountCleanup.indexOf("accountDeleted = true;") &&
      fallbackAccountCleanup.indexOf("accountDeleted = true;") <
        fallbackAccountCleanup.indexOf("if (accountDeleted) {") &&
      fallbackAccountCleanup.indexOf("if (accountDeleted) {") <
        fallbackAccountCleanup.indexOf("await adapter.verifyRevokedSession()"),
    "the fallback cleanup path must verify a valid account delete before the revoked-session 401",
  );
  const boundedAccountDelete = between(
    stagingRolloutContract,
    "async function retryAccountDelete(\n",
    "\n}\n",
  );
  for (const fragment of [
    "result.status === 204",
    "result.authenticatedUserIDVerified === true",
  ]) {
    assert.equal(
      boundedAccountDelete.split(fragment).length - 1,
      1,
      `account cleanup success must require the complete delete proof: ${fragment}`,
    );
  }
  const mutationBoundaryCheckpoint = [
    "STAGING_DEPLOY_CHECKPOINT_OPERATION=mark_mutation_boundary \\",
    "  node ./scripts/staging-deploy-retry-checkpoint.mjs",
  ].join("\n");
  assert.equal(
    candidateDeployAndDrainScript.split(mutationBoundaryCheckpoint).length - 1,
    1,
    "the release mutation boundary must be crossed exactly once",
  );
  assert.ok(
    candidateDeployAndDrainScript.indexOf("cloudflare_drain_baseline_ready") <
      candidateDeployAndDrainScript.indexOf(mutationBoundaryCheckpoint) &&
      candidateDeployAndDrainScript.indexOf(mutationBoundaryCheckpoint) <
        candidateDeployAndDrainScript.indexOf("go run ./cmd/migrate"),
    "the mutation boundary must be durably crossed after read-only preflight and before migration",
  );

  for (const fragment of [
    "const maximumCheckpointBytes = 16 * 1024;",
    'const stateKind = "staging_deploy_retry_state";',
    'const evidenceKind = "staging_deploy_retry_checkpoint";',
    "hasOnlyKeys(value, stateKeys)",
    "hasOnlyKeys(value, evidenceKeys)",
    "constants.O_EXCL",
    "fstatSync(descriptor)",
    "0o600",
    "fsyncSync(descriptor)",
    'metadata.deployRunAttempt !== "1"',
    'metadata.deployRunAttempt !== "2"',
    'value.result !== "no_mutation_started"',
    'value.mutationBoundary !== "not_crossed"',
    "!/^(?:not_started|verified)$/.test(value.cleanupState)",
  ]) {
    assert.equal(
      stagingDeployRetryCheckpoint.split(fragment).length - 1,
      1,
      `retry checkpoint must keep bounded, exclusive, closed evidence: ${fragment}`,
    );
  }
  assert.equal(
    stagingDeployRetryCheckpoint.split("constants.O_NOFOLLOW ?? 0").length - 1,
    2,
    "retry checkpoint reads and writes must both reject final-component symlinks",
  );
  assert.ok(
    stagingDeployRetryCheckpoint.indexOf(
      'current.mutationBoundary !== "not_crossed"',
    ) <
      stagingDeployRetryCheckpoint.indexOf(
        'return { ...current, mutationBoundary: "crossed" };',
      ),
    "mutation-boundary transition must only move from not_crossed to crossed",
  );
  assert.doesNotMatch(
    stagingDeployRetryCheckpoint,
    /console\.(?:log|debug|info)|JSON\.stringify\([^)]*(?:process\.env|environment)/,
    "retry checkpoint output must not expose its environment or private state",
  );

  for (const fragment of [
    "const maximumResponseBytes = 64 * 1024;",
    'environment.GITHUB_RUN_ATTEMPT !== "2"',
    "value.id.toString() !== metadata.runID",
    "value.run_attempt !== 1",
    "value.name !== workflowName",
    "value.path !== workflowPath",
    'value.event !== "workflow_dispatch"',
    'value.status !== "completed"',
    'value.conclusion !== "failure"',
    "value.head_sha !== metadata.commitSHA",
    'value.head_branch !== "main"',
    "value.repository.full_name !== metadata.repository",
    "const cacheKey = `staging-deploy-retry-${metadata.commitSHA}-${metadata.runID}-1`;",
    'redirect: "error"',
    "signal: AbortSignal.timeout(30_000)",
  ]) {
    assert.equal(
      stagingDeployRetryResolver.split(fragment).length - 1,
      1,
      `retry resolver must keep a bounded exact-attempt cache contract: ${fragment}`,
    );
  }
  assert.equal(
    stagingDeployRetryResolver.split("stdout.write(`${cacheKey}\\n`);").length -
      1,
    1,
    "retry resolution may output only the validated exact cache key",
  );
  assert.doesNotMatch(
    stagingDeployRetryResolver,
    /console\.(?:log|debug|info)|stdout\.write\([^\n]*token/i,
    "retry resolution must not log credentials or unvalidated API payloads",
  );

  const uploadEvidenceStep = extractStep(
    workflow,
    "Upload stable CSRF rollout evidence",
  );
  assert.equal(
    uploadEvidenceStep.trimEnd(),
    [
      "      - name: Upload stable CSRF rollout evidence",
      "        if: ${{ always() }}",
      "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
      "        with:",
      "          name: stable-csrf-rollout-${{ env.COMMIT_SHA }}-${{ github.run_id }}-${{ github.run_attempt }}",
      "          path: |",
      "            ${{ runner.temp }}/fukamu-cycle-stable-csrf-rollout-drained.json",
      "            ${{ runner.temp }}/fukamu-cycle-stable-csrf-rollout-smoke-passed.json",
      "          if-no-files-found: ignore",
      "          retention-days: 90",
    ].join("\n"),
    "stable rollout evidence must be uploaded after both success and failure without masking the rollout result",
  );

  const finalizeRetryCheckpointStep = extractStep(
    workflow,
    "Finalize safe deployment retry checkpoint",
  );
  assert.equal(
    finalizeRetryCheckpointStep.trimEnd(),
    [
      "      - name: Finalize safe deployment retry checkpoint",
      "        if: ${{ always() && github.run_attempt == '1' }}",
      "        id: finalize_retry",
      "        env:",
      "          STAGING_DEPLOY_CHECKPOINT_OPERATION: finalize",
      "          STAGING_DEPLOY_CHECKPOINT_STATE_FILE: ${{ runner.temp }}/fukamu-cycle-staging-deploy-retry-state.json",
      "          STAGING_DEPLOY_RETRY_EVIDENCE_FILE: ${{ runner.temp }}/fukamu-cycle-staging-deploy-retry.json",
      "        run: |",
      "          set -euo pipefail",
      '          result="$(node ./scripts/staging-deploy-retry-checkpoint.mjs)"',
      '          case "${result}" in',
      "            staging_deploy_retry_checkpoint_created)",
      "              echo 'created=true' >> \"${GITHUB_OUTPUT}\"",
      "              ;;",
      "            staging_deploy_retry_checkpoint_not_created)",
      "              echo 'created=false' >> \"${GITHUB_OUTPUT}\"",
      "              ;;",
      "            *)",
      "              echo '::error::Staging deploy retry checkpoint result is invalid.'",
      "              exit 1",
      "              ;;",
      "          esac",
    ].join("\n"),
    "attempt 1 must finalize retry evidence after every deploy outcome",
  );
  const saveRetryCheckpointStep = extractStep(
    workflow,
    "Save safe deployment retry checkpoint for attempt two",
  );
  assert.equal(
    saveRetryCheckpointStep.trimEnd(),
    [
      "      - name: Save safe deployment retry checkpoint for attempt two",
      "        if: ${{ always() && github.run_attempt == '1' && steps.finalize_retry.outputs.created == 'true' }}",
      "        uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0",
      "        with:",
      "          path: ${{ runner.temp }}/fukamu-cycle-staging-deploy-retry.json",
      "          key: staging-deploy-retry-${{ env.COMMIT_SHA }}-${{ github.run_id }}-1",
    ].join("\n"),
    "attempt 1 must save one exact run- and SHA-bound checkpoint cache key",
  );
  const uploadRetryCheckpointStep = extractStep(
    workflow,
    "Upload safe deployment retry checkpoint",
  );
  assert.equal(
    uploadRetryCheckpointStep.trimEnd(),
    [
      "      - name: Upload safe deployment retry checkpoint",
      "        if: ${{ always() && github.run_attempt == '1' && steps.finalize_retry.outputs.created == 'true' }}",
      "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
      "        with:",
      "          name: staging-deploy-retry-${{ env.COMMIT_SHA }}-${{ github.run_id }}-1",
      "          path: ${{ runner.temp }}/fukamu-cycle-staging-deploy-retry.json",
      "          if-no-files-found: error",
      "          retention-days: 90",
    ].join("\n"),
    "attempt 1 retry evidence must use an immutable run- and SHA-bound artifact name",
  );
  assert.ok(
    deployJob.indexOf(
      "      - name: Run post-deploy staging critical journey\n",
    ) <
      deployJob.indexOf(
        "      - name: Finalize safe deployment retry checkpoint\n",
      ) &&
      deployJob.indexOf(
        "      - name: Finalize safe deployment retry checkpoint\n",
      ) <
        deployJob.indexOf(
          "      - name: Save safe deployment retry checkpoint for attempt two\n",
        ) &&
      deployJob.indexOf(
        "      - name: Save safe deployment retry checkpoint for attempt two\n",
      ) <
        deployJob.indexOf(
          "      - name: Upload safe deployment retry checkpoint\n",
        ) &&
      deployJob.trimEnd().endsWith(uploadRetryCheckpointStep.trimEnd()),
    "retry checkpoint finalization, cache save, and audit upload must be the final deploy steps",
  );

  assert.equal(
    candidateDeployAndDrainScript.split("go run ./cmd/migrate").length - 1,
    1,
    "the child script must be the sole migration consumer",
  );
  assert.equal(
    candidateDeployAndDrainScript.split("wrangler deploy").length - 1,
    1,
    "the child script must be the sole Wrangler deploy consumer",
  );
  assert.equal(
    workflow.split("go run ./cmd/migrate").length - 1,
    0,
    "the workflow must not bypass the fixed rollout child for migrations",
  );
  assert.equal(
    workflow.split("wrangler deploy").length - 1,
    0,
    "the workflow must not bypass the fixed rollout child for deployment",
  );
  assertExactSet(
    [...backend.githubVariables, closedBeta.mode.name],
    extractBashArray(candidateDeployAndDrainScript, "variable_names"),
    "deployment contract/fixed child Worker variables",
  );
  assert.equal(
    candidateDeployAndDrainScript.split(
      'variable_args+=(--var "${name}:${!name}")',
    ).length - 1,
    1,
    "the fixed child must map each classified Worker variable exactly once",
  );
  for (const name of closedBeta.conditionalVariables) {
    assert.equal(
      candidateDeployAndDrainScript.split(
        `--var "${name}:${bashParameter(name)}"`,
      ).length - 1,
      1,
      `the fixed child must map conditional Worker variable ${name}`,
    );
  }
  for (const [target, source] of Object.entries(backend.derived)) {
    assert.equal(
      candidateDeployAndDrainScript.split(
        `--var "${target}:${bashParameter(source)}"`,
      ).length - 1,
      1,
      `the fixed child must map derived Worker variable ${target}`,
    );
  }
  for (const fragment of [
    "set -Eeuo pipefail",
    "trap cleanup EXIT",
    'secrets_file="${RUNNER_TEMP}/fukamu-cycle-worker-secrets.json"',
    "coproc DRAIN_EVIDENCE { node ./scripts/check-cloudflare-drain-evidence.mjs; }",
    '[[ "${baseline_signal}" == "cloudflare_drain_baseline_ready" ]]',
    'DATABASE_URL="${MIGRATION_DATABASE_URL}"',
    "go run ./cmd/migrate",
    "node ./scripts/materialize-staging-worker-secrets.mjs",
    "wrangler deploy \\",
    '--secrets-file "${secrets_file}" \\',
    "--containers-rollout=immediate \\",
    '--tag "${COMMIT_SHA}"',
    "printf '%s\\n' \"candidate_deploy_completed\"",
    "STAGING_ROLLOUT_EVIDENCE_STAGE=drained",
    "node ./scripts/write-staging-rollout-evidence.mjs",
  ]) {
    assert.equal(
      candidateDeployAndDrainScript.split(fragment).length - 1,
      1,
      `candidate deployment child contract is missing or duplicated: ${fragment}`,
    );
  }
  assert.equal(
    candidateDeployAndDrainScript.split('rm -f -- "${secrets_file}"').length -
      1,
    2,
    "ephemeral Worker secrets must be removed both on EXIT and immediately after deploy",
  );
  assert.equal(
    candidateDeployAndDrainScript.split("    go run ./cmd/migrate\n").length -
      1,
    1,
    "the candidate migration command must remain fail-closed",
  );
  assert.equal(
    candidateDeployAndDrainScript.split("variable_names=(").length - 1,
    1,
    "the fixed child must define the classified Worker variable array exactly once",
  );
  assert.equal(
    candidateDeployAndDrainScript.split(
      'for name in "${variable_names[@]}"; do',
    ).length - 1,
    1,
    "the fixed child must iterate only the classified Worker variable array",
  );
  assert.equal(
    candidateDeployAndDrainScript.split('  "${variable_args[@]}" \\').length -
      1,
    1,
    "Wrangler must consume the classified Worker variable arguments exactly once",
  );
  assert.equal(
    candidateDeployAndDrainScript.split(
      'if [[ "${BETA_ADMISSION_MODE}" == "closed" ]]; then',
    ).length - 1,
    1,
    "the fixed child must gate closed-Beta variables on closed mode",
  );
  assert.doesNotMatch(
    candidateDeployAndDrainScript,
    /^PUBLIC_ORIGIN=/m,
    "the fixed child must not rewrite a modeled Worker variable source",
  );
  assert.ok(
    candidateDeployAndDrainScript.indexOf("cloudflare_drain_baseline_ready") <
      candidateDeployAndDrainScript.indexOf("go run ./cmd/migrate") &&
      candidateDeployAndDrainScript.indexOf("go run ./cmd/migrate") <
        candidateDeployAndDrainScript.indexOf("wrangler deploy") &&
      candidateDeployAndDrainScript.indexOf("wrangler deploy") <
        candidateDeployAndDrainScript.indexOf("candidate_deploy_completed") &&
      candidateDeployAndDrainScript.indexOf("candidate_deploy_completed") <
        candidateDeployAndDrainScript.indexOf(
          "node ./scripts/write-staging-rollout-evidence.mjs",
        ),
    "baseline, migration, tagged deploy, drain handshake, and evidence order",
  );

  const materializedSecretNames = between(
    workerSecretsMaterializer,
    "const requiredSecretNames = Object.freeze([",
    "]);",
  );
  assertExactSet(
    backend.secrets,
    matches(materializedSecretNames, /"([A-Z][A-Z0-9_]*)"/g),
    "deployment contract/Worker secret materializer",
  );
  assert.ok(
    workerSecretsMaterializer.includes(
      'names.push("BETA_ADMISSION_COOKIE_KEY")',
    ),
    "closed-Beta secret must be materialized only for closed mode",
  );
  assertExactSet(
    closedBeta.conditionalSecrets,
    matches(workerSecretsMaterializer, /names\.push\("([A-Z][A-Z0-9_]*)"\)/g),
    "deployment contract/conditional Worker secret materializer",
  );
  assert.ok(
    workerSecretsMaterializer.includes('flag: "wx"') &&
      workerSecretsMaterializer.includes("mode: 0o600"),
    "Worker secret materialization must be exclusive and owner-only",
  );
  assert.doesNotMatch(
    workerSecretsMaterializer,
    /console\.(?:log|debug|info)|process\.stdout\.write/,
    "Worker secret materializer must not log secret-bearing output",
  );
  assert.equal(
    workerSecretsMaterializer.split(
      "const values = Object.fromEntries(names.map((name) => [name, env[name]]));",
    ).length - 1,
    1,
    "Worker secret materializer must read each classified secret by its own name",
  );
  assert.ok(
    drainEvidenceCLI.includes(
      'const wakeSignal = "cloudflare_drain_baseline_ready\\n"',
    ) &&
      drainEvidenceCLI.includes(
        'const wakeAcknowledgement = "candidate_deploy_completed\\n"',
      ),
    "authoritative drain CLI must implement the exact bounded handshake",
  );
  assert.ok(
    rolloutEvidenceWriter.includes('flag: "wx"') &&
      rolloutEvidenceWriter.includes("mode: 0o600") &&
      rolloutEvidenceWriter.includes("cloudflareDrain") &&
      rolloutEvidenceWriter.includes('"drained_smoke_pending"') &&
      rolloutEvidenceWriter.includes('"smoke_passed"') &&
      rolloutEvidenceWriter.includes("exactMainCIWorkflowRunID"),
    "release evidence must be exclusive, owner-only, and include Cloudflare proof",
  );
  const smokeTestStep = extractStep(workflow, "Smoke test");
  assertStepExecutionControls(smokeTestStep, "deployment smoke test", "bash");
  assert.equal(
    smokeTestStep.trimEnd(),
    [
      "      - name: Smoke test",
      "        shell: bash",
      "        run: |",
      "          set -euo pipefail",
      '          curl --fail --silent --show-error --retry 30 --retry-all-errors --retry-delay 10 --max-time 30 "${PUBLIC_ORIGIN}/healthz"',
      '          curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 --max-time 30 "${PUBLIC_ORIGIN}/readyz"',
    ].join("\n"),
    "deployment smoke test step",
  );
  const stagingPreflightStep = extractStep(
    workflow,
    "Verify current Staging health and readiness before migration",
  );
  assertStepExecutionControls(
    stagingPreflightStep,
    "deployment pre-switch staging health and readiness",
    "bash",
  );
  assert.equal(
    stagingPreflightStep.trimEnd(),
    [
      "      - name: Verify current Staging health and readiness before migration",
      "        shell: bash",
      "        env:",
      "          STAGING_BASE_URL: ${{ env.PUBLIC_ORIGIN }}",
      "          STAGING_CRITICAL_MODE: preflight",
      "        run: bash ./scripts/check-staging-critical.sh",
    ].join("\n"),
    "deployment pre-switch staging health and readiness step",
  );
  assert.deepEqual(stepEnvironmentMappings(stagingPreflightStep), {
    STAGING_BASE_URL: {
      kind: "environment",
      value: "PUBLIC_ORIGIN",
    },
    STAGING_CRITICAL_MODE: { kind: "literal", value: "preflight" },
  });
  assert.equal(
    workflow.includes("STAGING_CRITICAL_MODE: baseline"),
    false,
    "the one-time CSRF harness must own the only pre-mutation anonymous journey",
  );

  const postDeployStagingCriticalStep = extractStep(
    workflow,
    "Run post-deploy staging critical journey",
  );
  assertStepExecutionControls(
    postDeployStagingCriticalStep,
    "deployment post-deploy staging critical journey",
    "bash",
  );
  assert.equal(
    postDeployStagingCriticalStep.trimEnd(),
    [
      "      - name: Run post-deploy staging critical journey",
      "        shell: bash",
      "        env:",
      "          STAGING_BASE_URL: ${{ env.PUBLIC_ORIGIN }}",
      "          STAGING_CRITICAL_MODE: full",
      "          STAGING_ADMISSION_MODE: ${{ env.BETA_ADMISSION_MODE }}",
      "          STAGING_E2E_INVITE_TOKEN: ${{ secrets.STAGING_E2E_INVITE_TOKEN }}",
      "        run: bash ./scripts/check-staging-critical.sh",
    ].join("\n"),
    "deployment post-deploy staging critical journey step",
  );
  assert.deepEqual(stepEnvironmentMappings(postDeployStagingCriticalStep), {
    STAGING_BASE_URL: {
      kind: "environment",
      value: "PUBLIC_ORIGIN",
    },
    STAGING_CRITICAL_MODE: { kind: "literal", value: "full" },
    STAGING_ADMISSION_MODE: {
      kind: "environment",
      value: "BETA_ADMISSION_MODE",
    },
    STAGING_E2E_INVITE_TOKEN: {
      kind: "secret",
      value: "STAGING_E2E_INVITE_TOKEN",
    },
  });

  const frontendExampleKeys = matches(
    readRepositoryFile("frontend/.env.example"),
    /^([A-Z][A-Z0-9_]*)=/gm,
  );
  assertExactSet(
    [
      ...Object.keys(frontend.fixed),
      ...Object.keys(frontend.required),
      ...Object.keys(frontend.optional),
    ],
    frontendExampleKeys,
    "deployment contract/frontend example",
  );
  const frontendBuildStep = extractStep(workflow, "Build static frontend");
  assertStepExecutionControls(frontendBuildStep, "Frontend build", null);
  assert.equal(
    extractRunCommand(frontendBuildStep),
    "pnpm --filter fukamu-cycle-frontend --fail-if-no-match run build",
    "deployment Frontend build command",
  );
  assert.deepEqual(buildEnvironmentMappings(frontendBuildStep), {
    ...frontend.fixed,
    ...frontend.required,
    ...frontend.optional,
  });
  assertApprovedProductionFrontendEnvironmentConsumers(frontend);
  assertDeploymentEnvironmentBuildConfigConsumer(frontend);
  assertExactSet(
    [
      ...Object.keys(frontend.fixed),
      ...Object.keys(frontend.required),
      ...Object.keys(frontend.optional),
    ],
    documentedFrontendKeys(),
    "Frontend contract/environment docs",
  );

  const backendValidationStep = extractStep(
    workflow,
    "Validate Backend runtime configuration",
  );
  assertStepExecutionControls(
    backendValidationStep,
    "Validate Backend runtime configuration",
    "bash",
  );
  assert.equal(
    extractStepProperty(backendValidationStep, "working-directory"),
    "backend",
  );
  assert.equal(
    extractRunCommand(backendValidationStep),
    "GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go run ./cmd/configcheck",
  );
  const backendValidationEnvironment = stepEnvironmentMappings(
    backendValidationStep,
  );
  assertExactSet(
    [
      ...backend.fixed,
      ...backend.omitted,
      ...Object.keys(backend.derived),
      ...backend.secrets,
    ],
    Object.keys(backendValidationEnvironment),
    "deployment contract/configcheck fixed and derived inputs",
  );
  assert.deepEqual(
    backendValidationEnvironment,
    {
      APP_ENV: { kind: "literal", value: "production" },
      HTTP_ADDRESS: { kind: "literal", value: ":8080" },
      STATIC_DIR: { kind: "literal", value: "" },
      AI_PROVIDER: { kind: "literal", value: "openai" },
      AI_PRICING_MODEL: {
        kind: "environment",
        value: backend.derived.AI_PRICING_MODEL,
      },
      ...secretEnvironmentMappings(backendSecretSources),
      TURNSTILE_ENABLED: { kind: "literal", value: "true" },
      TURNSTILE_EXPECTED_ACTION: {
        kind: "literal",
        value: "anonymous_bootstrap",
      },
    },
    "deployment contract/configcheck environment",
  );
  const backendValidationFixedLiterals = Object.fromEntries(
    Object.entries(backendValidationEnvironment)
      .filter(
        ([key, mapping]) => key !== "STATIC_DIR" && mapping.kind === "literal",
      )
      .map(([key, mapping]) => [key, mapping.value]),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(workerEnvironmentMappings)
        .filter(([, mapping]) => mapping.kind === "literal")
        .map(([key, mapping]) => [key, mapping.value]),
    ),
    backendValidationFixedLiterals,
    "Container and configcheck fixed literal inputs",
  );
  assert.deepEqual(
    secretStepMappings(backendValidationStep),
    backendSecretSources,
    "deployment contract/configcheck runtime secrets",
  );
  assert.equal(
    matches(
      workflow,
      /^          OTEL_EXPORTER_OTLP_HEADERS: \$\{\{ secrets\.OTEL_EXPORTER_OTLP_HEADERS \}\}$/gm,
    ).length,
    3,
    "OTLP header credential must be exposed to exactly the three required steps",
  );
  const browserInstallPosition = workflow.indexOf(
    "      - name: Install staging Chromium\n",
  );
  const retryCheckpointInitializationPosition = workflow.indexOf(
    "      - name: Initialize deployment retry checkpoint state\n",
  );
  const frontendBuildPosition = workflow.indexOf(
    "      - name: Build static frontend\n",
  );
  const backendValidationPosition = workflow.indexOf(
    "      - name: Validate Backend runtime configuration\n",
  );
  const stagingPreflightPosition = workflow.indexOf(
    "      - name: Verify current Staging health and readiness before migration\n",
  );
  const rolloutPosition = workflow.indexOf(
    "      - name: Run stable CSRF initial rollout and authoritative drain\n",
  );
  const evidenceUploadPosition = workflow.indexOf(
    "      - name: Upload stable CSRF rollout evidence\n",
  );
  const smokeTestPosition = workflow.indexOf("      - name: Smoke test\n");
  const postDeployStagingCriticalPosition = workflow.indexOf(
    "      - name: Run post-deploy staging critical journey\n",
  );
  const retryCheckpointFinalizationPosition = workflow.indexOf(
    "      - name: Finalize safe deployment retry checkpoint\n",
  );
  const retryCheckpointSavePosition = workflow.indexOf(
    "      - name: Save safe deployment retry checkpoint for attempt two\n",
  );
  const retryCheckpointUploadPosition = workflow.indexOf(
    "      - name: Upload safe deployment retry checkpoint\n",
  );
  assert.ok(
    retryCheckpointInitializationPosition < browserInstallPosition &&
      browserInstallPosition < frontendBuildPosition &&
      frontendBuildPosition < backendValidationPosition &&
      backendValidationPosition < stagingPreflightPosition &&
      stagingPreflightPosition < rolloutPosition &&
      rolloutPosition < evidenceUploadPosition &&
      evidenceUploadPosition < smokeTestPosition &&
      smokeTestPosition < postDeployStagingCriticalPosition &&
      postDeployStagingCriticalPosition < retryCheckpointFinalizationPosition &&
      retryCheckpointFinalizationPosition < retryCheckpointSavePosition &&
      retryCheckpointSavePosition < retryCheckpointUploadPosition,
    "checkpoint init, browser install, build, runtime validation, pre-switch health/readiness, same-process rollout/drain, evidence, smoke, post journey, and checkpoint finalization order",
  );

  const expectedStepSecretSources = [
    ...Object.values(validationSecretSources),
    ...Object.values(backendSecretSources),
    "NEON_MIGRATION_DATABASE_URL",
    ...Object.values(workerSecretSources),
    ...Object.values(cloudflareDeploySecretSources),
    "STAGING_E2E_INVITE_TOKEN",
    "STAGING_E2E_INVITE_TOKEN",
  ].sort();
  assert.deepEqual(
    matches(deployJob, /\$\{\{ secrets\.([A-Z][A-Z0-9_]*) \}\}/g).sort(),
    expectedStepSecretSources,
    "deployment job secret exposure must be exact and step-scoped",
  );
  for (const [label, step] of [
    [
      "checkout",
      extractUsesStep(
        deployJob,
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      ),
    ],
    [
      "pnpm setup",
      extractUsesStep(
        deployJob,
        "pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0",
      ),
    ],
    [
      "Go setup",
      extractUsesStep(
        workflow,
        "actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0",
      ),
    ],
    [
      "dependency installation",
      extractStep(workflow, "Install JavaScript dependencies"),
    ],
    [
      "staging Chromium installation",
      extractStep(workflow, "Install staging Chromium"),
    ],
    ["Frontend build", extractStep(workflow, "Build static frontend")],
  ]) {
    assert.doesNotMatch(
      step,
      /\$\{\{\s*secrets\./,
      `${label} must not receive application or deployment secrets`,
    );
  }
});

test("current workflow rejects whitespace-only required input", () => {
  const result = runWorkflowValidation({ AI_MODEL: " \t " });
  assert.equal(
    result.error,
    undefined,
    "workflow validator command did not run",
  );
  assert.notEqual(
    result.status,
    0,
    "Validate required deployment inputs accepted whitespace-only AI_MODEL",
  );
});

test("current workflow rejects whitespace-only reasoning effort", () => {
  const result = runWorkflowValidation({ AI_REASONING_EFFORT: " \t " });
  assert.equal(
    result.error,
    undefined,
    "workflow validator command did not run",
  );
  assert.notEqual(
    result.status,
    0,
    "Validate required deployment inputs accepted whitespace-only AI_REASONING_EFFORT",
  );
});

test("current workflow rejects runtime-invalid non-empty BETA_INVITES", () => {
  const result = runWorkflowValidation({
    BETA_ADMISSION_MODE: "closed",
    BETA_ADMISSION_COOKIE_TTL_DAYS: "180",
    BETA_INVITES: "[{}]",
    BETA_ADMISSION_COOKIE_KEY: "A".repeat(43),
  });
  assert.equal(
    result.error,
    undefined,
    "workflow validator command did not run",
  );
  assert.notEqual(
    result.status,
    0,
    "Validate required deployment inputs accepted BETA_INVITES=[{}]",
  );
});

test("current workflow accepts complete valid off-mode inputs", () => {
  const result = runWorkflowValidation({});
  assert.equal(
    result.error,
    undefined,
    "workflow validator command did not run",
  );
  assert.equal(
    result.status,
    0,
    `Validate required deployment inputs rejected valid inputs:\n${result.stderr}`,
  );
});

let cachedBackendGoInventory;

function backendGoInventory() {
  if (cachedBackendGoInventory !== undefined) {
    return cachedBackendGoInventory;
  }
  const goEnvironment = {
    ...process.env,
    GOENV: "off",
    GOFLAGS: "",
    GOPROXY: "off",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
  };
  const versionResult = spawnSync("go", ["env", "GOVERSION"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: goEnvironment,
  });
  assert.equal(versionResult.error, undefined, "Go AST parser did not run");
  assert.equal(
    versionResult.status,
    0,
    `Go AST parser version check failed: ${versionResult.stderr}`,
  );
  assert.equal(
    versionResult.stdout.trim(),
    "go1.27.0",
    "configuration parity must use Go 1.27.0",
  );

  const backendFiles = repositoryFiles("backend", ".go").filter(
    (path) => !path.endsWith("_test.go"),
  );
  assert.ok(backendFiles.length > 0, "Backend Go sources not found");
  const result = spawnSync(
    "go",
    [
      "run",
      join(repositoryRoot, "scripts/config-go-ast-inventory.go"),
      repositoryRoot,
      ...backendFiles,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: goEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, "Backend Go AST inventory did not run");
  assert.equal(
    result.status,
    0,
    `Backend Go AST inventory failed: ${result.stderr}`,
  );
  assert.equal(result.stderr, "", "Backend Go AST inventory wrote stderr");
  try {
    cachedBackendGoInventory = JSON.parse(result.stdout);
  } catch {
    assert.fail("Backend Go AST inventory returned invalid JSON");
  }
  return cachedBackendGoInventory;
}

function configLookupKeys() {
  const backendInventory = backendGoInventory();
  assert.deepEqual(
    backendInventory.lookupParameters.filter(
      ({ path, function: functionName }) =>
        path === "backend/internal/config/config.go" && functionName === "Load",
    ),
    [
      {
        path: "backend/internal/config/config.go",
        function: "Load",
        name: "lookup",
        type: "LookupEnv",
        uses: [{ kind: "value", expression: "lookup: lookup" }],
      },
    ],
    "Backend config Load lookup parameter usage",
  );
  const inventory = backendInventory.config;
  const readerMethodNames = inventory.readerMethods;
  assert.ok(
    readerMethodNames.length > 0,
    "Backend config reader methods not found",
  );
  const readerMethodSet = new Set(readerMethodNames);
  const calls = [];
  for (const access of inventory.loadAccesses) {
    if (access.kind !== "call") {
      const approvedFieldRead =
        access.receiver === "reader" && access.member === "err";
      assert.equal(
        approvedFieldRead,
        true,
        `Backend config reader methods must be invoked directly: ${access.member}`,
      );
      continue;
    }
    assert.equal(
      access.receiver,
      "reader",
      `Backend config reader methods must be invoked directly: ${access.member}`,
    );
    assert.equal(
      readerMethodSet.has(access.member),
      true,
      `Backend config reader methods must be explicitly supported: ${access.member}`,
    );
    assert.match(
      access.key,
      /^[A-Z][A-Z0-9_]*$/,
      `Backend config reader ${access.member} must use a literal environment key`,
    );
    calls.push({ method: access.member, key: access.key });
  }

  const unsupportedMethods = calls
    .filter(({ method }) => !supportedBackendReaderMethods.has(method))
    .map(({ method, key }) => `${method}:${key}`);
  assert.deepEqual(
    unsupportedMethods,
    [],
    "Backend config reader methods must be explicitly supported",
  );
  assert.deepEqual(
    inventory.lookupAccesses,
    [
      "boolValue",
      "durationValue",
      "floatList",
      "floatValue",
      "int32Value",
      "intValue",
      "stringValue",
    ].map((functionName) => ({
      function: functionName,
      receiver: "reader",
      kind: "call",
      key: "key",
    })),
    "Backend envReader lookup must use the reader receiver and key parameter",
  );
  return calls.map(({ key }) => key);
}

function assertDeploymentEnvironmentBuildConfigConsumer(frontend) {
  assert.deepEqual(frontend.fixed, { VITE_DEPLOYMENT_ENV: "staging" });

  const configuration = parseTypeScriptRepositoryFile(
    "frontend/vite.config.ts",
    "Frontend build-config deployment environment wiring",
  );
  assertFrontendDeploymentEnvironmentWiring(configuration);
  const searchIndexingModule = readRepositoryFile(
    "frontend/vite/searchIndexing.ts",
  );
  assert.match(
    searchIndexingModule,
    /^export function parseDeploymentEnvironment\(/m,
    "Frontend build config must use the canonical deployment environment parser",
  );
  assert.match(
    searchIndexingModule,
    /^export function searchIndexingPlugin\(/m,
    "Frontend build config must use the canonical search indexing plugin",
  );
  assertNoAdditionalFrontendBuildEnvironmentConsumers();
}

function parseTypeScriptRepositoryFile(path, parseFailureMessage) {
  const sourceFile = typescript.createSourceFile(
    path,
    readRepositoryFile(path),
    typescript.ScriptTarget.Latest,
    true,
    frontendScriptKind(path),
  );
  assert.deepEqual(
    sourceFile.parseDiagnostics.map((diagnostic) =>
      typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
    [],
    parseFailureMessage,
  );
  return sourceFile;
}

function pushSyntaxDiagnostic(diagnostics, sourceFile, path, node) {
  if (diagnostics.length >= maximumSyntaxDiagnostics) return;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile, false),
  );
  diagnostics.push(
    `${path}:${line + 1}:${character + 1} (${typescript.SyntaxKind[node.kind]})`,
  );
}

function assertSameSyntaxNode(actualNode, expectedNode, label) {
  assert.equal(actualNode === expectedNode, true, label);
}

function assertExactSyntaxNodeSequence(actualNodes, expectedNodes, label) {
  assert.equal(actualNodes.length, expectedNodes.length, label);
  for (const [index, node] of actualNodes.entries()) {
    assertSameSyntaxNode(node, expectedNodes[index], `${label}: node ${index}`);
  }
}

function syntaxNameText(name) {
  if (
    typescript.isIdentifier(name) ||
    typescript.isStringLiteral(name) ||
    typescript.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (
    typescript.isComputedPropertyName(name) &&
    (typescript.isStringLiteral(name.expression) ||
      typescript.isNoSubstitutionTemplateLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return undefined;
}

function staticStringExpressionValue(node) {
  if (
    typescript.isStringLiteral(node) ||
    typescript.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  if (
    typescript.isParenthesizedExpression(node) ||
    typescript.isAsExpression(node) ||
    typescript.isTypeAssertionExpression(node) ||
    typescript.isSatisfiesExpression(node) ||
    typescript.isNonNullExpression(node)
  ) {
    return staticStringExpressionValue(node.expression);
  }
  if (typescript.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expressionValue = staticStringExpressionValue(span.expression);
      if (expressionValue === undefined) return undefined;
      value += expressionValue + span.literal.text;
    }
    return value;
  }
  if (
    typescript.isBinaryExpression(node) &&
    node.operatorToken.kind === typescript.SyntaxKind.PlusToken
  ) {
    const left = staticStringExpressionValue(node.left);
    const right = staticStringExpressionValue(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function isRequireLikeExpression(node) {
  if (node === undefined) return false;
  if (
    typescript.isParenthesizedExpression(node) ||
    typescript.isAsExpression(node) ||
    typescript.isTypeAssertionExpression(node) ||
    typescript.isSatisfiesExpression(node) ||
    typescript.isNonNullExpression(node)
  ) {
    return isRequireLikeExpression(node.expression);
  }
  return (
    (typescript.isIdentifier(node) && node.text === "require") ||
    (typescript.isPropertyAccessExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === "module" &&
      node.name.text === "require") ||
    (typescript.isElementAccessExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === "module" &&
      staticStringExpressionValue(node.argumentExpression) === "require") ||
    ((typescript.isPropertyAccessExpression(node) ||
      typescript.isElementAccessExpression(node)) &&
      (typescript.isPropertyAccessExpression(node)
        ? node.name.text === "require"
        : staticStringExpressionValue(node.argumentExpression) === "require"))
  );
}

function isCanonicalRequireCall(node) {
  if (
    !typescript.isCallExpression(node) ||
    node.questionDotToken !== undefined
  ) {
    return false;
  }
  const callee = node.expression;
  return (
    (typescript.isIdentifier(callee) && callee.text === "require") ||
    (typescript.isPropertyAccessExpression(callee) &&
      callee.questionDotToken === undefined &&
      typescript.isIdentifier(callee.expression) &&
      callee.expression.text === "module" &&
      callee.name.text === "require") ||
    (typescript.isElementAccessExpression(callee) &&
      callee.questionDotToken === undefined &&
      typescript.isIdentifier(callee.expression) &&
      callee.expression.text === "module" &&
      staticStringExpressionValue(callee.argumentExpression) === "require")
  );
}

function moduleReferenceSpecifier(node) {
  if (
    (typescript.isImportDeclaration(node) ||
      typescript.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    typescript.isStringLiteral(node.moduleSpecifier)
  ) {
    return { node: node.moduleSpecifier, value: node.moduleSpecifier.text };
  }
  if (
    typescript.isImportEqualsDeclaration(node) &&
    typescript.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined
  ) {
    const value = staticStringExpressionValue(node.moduleReference.expression);
    return {
      kind: "import-equals",
      node: node.moduleReference.expression,
      value,
    };
  }
  if (
    typescript.isImportTypeNode(node) &&
    typescript.isLiteralTypeNode(node.argument)
  ) {
    const value = staticStringExpressionValue(node.argument.literal);
    return { kind: "import-type", node: node.argument.literal, value };
  }
  if (
    typescript.isCallExpression(node) &&
    node.expression.kind === typescript.SyntaxKind.ImportKeyword
  ) {
    return {
      call: node,
      kind: "dynamic-import",
      node: node.arguments[0] ?? node,
      value:
        node.arguments.length === 1
          ? staticStringExpressionValue(node.arguments[0])
          : undefined,
    };
  }
  if (
    typescript.isCallExpression(node) &&
    isRequireLikeExpression(node.expression)
  ) {
    return {
      call: node,
      kind: "require",
      node: node.arguments[0] ?? node,
      value:
        isCanonicalRequireCall(node) && node.arguments.length === 1
          ? staticStringExpressionValue(node.arguments[0])
          : undefined,
    };
  }
  return undefined;
}

function isApprovedNonStaticDynamicImport(path, reference) {
  if (reference.kind !== "dynamic-import" || reference.call === undefined) {
    return false;
  }
  const argument = reference.call.arguments[0];
  if (
    path === "cloudflare/src/config/deployment-contract.test.mjs" &&
    typescript.isPropertyAccessExpression(argument) &&
    argument.name.text === "href" &&
    typescript.isCallExpression(argument.expression) &&
    typescript.isIdentifier(argument.expression.expression) &&
    argument.expression.expression.text === "pathToFileURL" &&
    argument.expression.arguments.length === 1 &&
    typescript.isIdentifier(argument.expression.arguments[0]) &&
    ["parse5ModulePath", "typeScriptModulePath"].includes(
      argument.expression.arguments[0].text,
    )
  ) {
    return true;
  }
  return (
    path === "scripts/check-docs.mjs" &&
    typescript.isCallExpression(argument) &&
    typescript.isIdentifier(argument.expression) &&
    argument.expression.text === "pathToFileURL" &&
    argument.arguments.length === 1 &&
    typescript.isIdentifier(argument.arguments[0]) &&
    argument.arguments[0].text === "domPurifyESMPath"
  );
}

function assertCandidateLocalModuleReference(path, reference) {
  const specifier = reference.value.split(/[?#]/, 1)[0];
  assert.equal(
    specifier.startsWith("file:"),
    false,
    `${path}: file URL module references are forbidden: ${reference.value}`,
  );
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(specifier)?.[0];
  assert.ok(
    scheme === undefined ||
      scheme === "node:" ||
      specifier === "cloudflare:workers",
    `${path}: executable URL module references are forbidden: ${reference.value}`,
  );
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return;
  const absoluteTarget = resolve(repositoryRoot, dirname(path), specifier);
  assert.ok(
    absoluteTarget.startsWith(`${repositoryRoot}/`),
    `${path}: local module reference must remain inside the candidate repository: ${reference.value}`,
  );
}

function assertWorkerEnvironmentModuleReferenceInventory(
  canonicalSourceFile,
  canonicalImport,
) {
  const label = "Worker cloudflare:workers module reference inventory";
  const executableExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/;
  const sourcePaths = repositoryFiles("", "").filter(
    (path) =>
      executableExtension.test(path) && !/\.d\.(?:cts|mts|ts)$/.test(path),
  );
  const references = [];
  for (const path of sourcePaths) {
    const sourceFile =
      path === "cloudflare/src/index.ts"
        ? canonicalSourceFile
        : parseTypeScriptRepositoryFile(
            path,
            `${path}: Worker source must parse before module reference analysis`,
          );
    assertNoDynamicWorkerCode(sourceFile, path, label);
    const visit = (node) => {
      if (
        isRequireLikeExpression(node) &&
        !isRequireLikeExpression(node.parent)
      ) {
        assert.ok(
          typescript.isCallExpression(node.parent) &&
            node.parent.expression === node &&
            isCanonicalRequireCall(node.parent),
          `${path}: require references must be direct canonical calls`,
        );
      }
      const reference = moduleReferenceSpecifier(node);
      if (reference !== undefined) {
        assert.ok(
          reference.value !== undefined ||
            isApprovedNonStaticDynamicImport(path, reference),
          `${path}: dynamic module references must use exact statically analyzable strings`,
        );
        if (reference.value !== undefined) {
          assertCandidateLocalModuleReference(path, reference);
        }
      }
      if (reference?.value === "cloudflare:workers") {
        references.push({ path, node: reference.node });
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const canonicalImportDeclaration = canonicalImport.parent.parent.parent;
  assert.ok(typescript.isImportDeclaration(canonicalImportDeclaration), label);
  assert.deepEqual(
    references.map(({ path }) => path),
    ["cloudflare/src/index.ts"],
    label,
  );
  assertSameSyntaxNode(
    references[0].node,
    canonicalImportDeclaration.moduleSpecifier,
    label,
  );
}

function assertCanonicalIdentifierParameter(parameter, name, label) {
  assert.ok(
    typescript.isIdentifier(parameter.name) &&
      parameter.name.text === name &&
      parameter.dotDotDotToken === undefined &&
      parameter.questionToken === undefined &&
      parameter.initializer === undefined &&
      (parameter.modifiers?.length ?? 0) === 0,
    label,
  );
}

function collectDirectIdentifierCalls(root, name) {
  const calls = [];
  const visit = (node) => {
    if (
      typescript.isCallExpression(node) &&
      node.questionDotToken === undefined &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      calls.push(node);
    }
    typescript.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function isApprovedFunctionIdentifier(path, node) {
  if (
    path !== "frontend/src/shared/autosave/AutoSaveScopeProvider.test.tsx" ||
    !typescript.isCallExpression(node.parent) ||
    node.parent.arguments.length !== 1 ||
    node.parent.arguments[0] !== node ||
    !typescript.isPropertyAccessExpression(node.parent.expression)
  ) {
    return false;
  }
  const callee = node.parent.expression;
  return (
    typescript.isIdentifier(callee.expression) &&
    callee.expression.text === "expect" &&
    callee.name.text === "any"
  );
}

function isDirectGlobalObjectExpression(node) {
  if (
    typescript.isParenthesizedExpression(node) ||
    typescript.isAsExpression(node) ||
    typescript.isTypeAssertionExpression(node) ||
    typescript.isSatisfiesExpression(node) ||
    typescript.isNonNullExpression(node)
  ) {
    return isDirectGlobalObjectExpression(node.expression);
  }
  return (
    typescript.isIdentifier(node) &&
    ["globalThis", "window", "self"].includes(node.text)
  );
}

function isApprovedReflectiveRead(path, node) {
  if (
    !typescript.isCallExpression(node) ||
    node.questionDotToken !== undefined ||
    !typescript.isPropertyAccessExpression(node.expression) ||
    node.expression.questionDotToken !== undefined ||
    !typescript.isIdentifier(node.expression.expression) ||
    node.arguments.length !== 2
  ) {
    return false;
  }
  const objectName = node.expression.expression.text;
  const methodName = node.expression.name.text;
  const parent = node.parent;
  if (
    path === "frontend/src/shared/api/client.ts" &&
    objectName === "Reflect" &&
    methodName === "get" &&
    typescript.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    typescript.isIdentifier(parent.name) &&
    typescript.isIdentifier(node.arguments[0]) &&
    typescript.isStringLiteral(node.arguments[1])
  ) {
    return (
      (parent.name.text === "user" &&
        node.arguments[0].text === "payload" &&
        node.arguments[1].text === "user") ||
      (parent.name.text === "userId" &&
        node.arguments[0].text === "user" &&
        node.arguments[1].text === "id")
    );
  }
  if (
    path ===
      "frontend/src/features/app-referral/AppReferralPromotion.test.tsx" &&
    objectName === "Object" &&
    methodName === "getOwnPropertyDescriptor" &&
    typescript.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    typescript.isIdentifier(parent.name) &&
    typescript.isIdentifier(node.arguments[0]) &&
    node.arguments[0].text === "navigator" &&
    typescript.isStringLiteral(node.arguments[1])
  ) {
    return (
      (parent.name.text === "originalShare" &&
        node.arguments[1].text === "share") ||
      (parent.name.text === "originalClipboard" &&
        node.arguments[1].text === "clipboard")
    );
  }
  return false;
}

function assertNoDynamicWorkerCode(sourceFile, path, label) {
  const dynamicMemberAccessDiagnostics = [];
  const dynamicIdentifierDiagnostics = [];
  const recordDynamicMemberAccess = (node) =>
    pushSyntaxDiagnostic(
      dynamicMemberAccessDiagnostics,
      sourceFile,
      path,
      node,
    );
  const recordDynamicIdentifier = (node) =>
    pushSyntaxDiagnostic(dynamicIdentifierDiagnostics, sourceFile, path, node);
  const visit = (node) => {
    if (
      typescript.isElementAccessExpression(node) &&
      (isDirectGlobalObjectExpression(node.expression) ||
        [
          "eval",
          "Function",
          "require",
          "constructor",
          "__proto__",
          "prototype",
        ].includes(staticStringExpressionValue(node.argumentExpression)))
    ) {
      recordDynamicMemberAccess(node);
    }
    if (
      typescript.isPropertyAccessExpression(node) &&
      node.name.text === "constructor"
    ) {
      recordDynamicMemberAccess(node);
    }
    if (
      typescript.isPropertyAccessExpression(node) &&
      (node.name.text === "__proto__" || node.name.text === "prototype")
    ) {
      recordDynamicMemberAccess(node);
    }
    if (
      typescript.isCallExpression(node) &&
      typescript.isPropertyAccessExpression(node.expression) &&
      typescript.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Reflect" &&
      node.expression.name.text === "get" &&
      node.arguments.length >= 2 &&
      (isDirectGlobalObjectExpression(node.arguments[0]) ||
        ["eval", "Function", "require", "constructor"].includes(
          staticStringExpressionValue(node.arguments[1]),
        ))
    ) {
      recordDynamicMemberAccess(node);
    }
    if (
      typescript.isCallExpression(node) &&
      typescript.isPropertyAccessExpression(node.expression) &&
      typescript.isIdentifier(node.expression.expression) &&
      ((node.expression.expression.text === "Reflect" &&
        ["get", "getOwnPropertyDescriptor", "getPrototypeOf"].includes(
          node.expression.name.text,
        )) ||
        (node.expression.expression.text === "Object" &&
          [
            "getOwnPropertyDescriptor",
            "getOwnPropertyDescriptors",
            "getPrototypeOf",
          ].includes(node.expression.name.text))) &&
      !isApprovedReflectiveRead(path, node)
    ) {
      recordDynamicMemberAccess(node);
    }
    if (
      typescript.isIdentifier(node) &&
      (node.text === "eval" ||
        (node.text === "Function" && !isApprovedFunctionIdentifier(path, node)))
    ) {
      recordDynamicIdentifier(node);
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.deepEqual(dynamicMemberAccessDiagnostics, [], `${path}: ${label}`);
  assert.deepEqual(dynamicIdentifierDiagnostics, [], `${path}: ${label}`);
}

function assertWorkerBindingProvenance(sourceFile, getContainerImport) {
  const label = "Worker handler bindings provenance";
  assert.ok(getContainerImport !== undefined, label);
  const [handleBetaAdmissionImport] = assertExactNamedImport(
    sourceFile,
    "./beta-admission/beta-admission",
    ["handleBetaAdmission"],
    label,
  );
  const defaultExports = sourceFile.statements.filter(
    (statement) =>
      typescript.isExportAssignment(statement) &&
      statement.isExportEquals !== true,
  );
  assert.equal(defaultExports.length, 1, label);
  const handlerSatisfies = defaultExports[0].expression;
  assert.ok(typescript.isSatisfiesExpression(handlerSatisfies), label);
  assert.ok(
    typescript.isTypeReferenceNode(handlerSatisfies.type) &&
      typescript.isIdentifier(handlerSatisfies.type.typeName) &&
      handlerSatisfies.type.typeName.text === "ExportedHandler" &&
      handlerSatisfies.type.typeArguments?.length === 1 &&
      typescript.isTypeReferenceNode(handlerSatisfies.type.typeArguments[0]) &&
      typescript.isIdentifier(
        handlerSatisfies.type.typeArguments[0].typeName,
      ) &&
      handlerSatisfies.type.typeArguments[0].typeName.text === "Env",
    label,
  );
  assert.ok(
    typescript.isObjectLiteralExpression(handlerSatisfies.expression) &&
      handlerSatisfies.expression.properties.length === 1,
    label,
  );
  const fetchMethod = handlerSatisfies.expression.properties[0];
  assert.ok(
    typescript.isMethodDeclaration(fetchMethod) &&
      typescript.isIdentifier(fetchMethod.name) &&
      fetchMethod.name.text === "fetch" &&
      fetchMethod.questionToken === undefined &&
      fetchMethod.asteriskToken === undefined &&
      fetchMethod.parameters.length === 2 &&
      fetchMethod.body !== undefined,
    label,
  );
  assert.deepEqual(
    (fetchMethod.modifiers ?? []).map((modifier) => modifier.kind),
    [typescript.SyntaxKind.AsyncKeyword],
    label,
  );
  assertCanonicalIdentifierParameter(
    fetchMethod.parameters[0],
    "request",
    label,
  );
  assertCanonicalIdentifierParameter(
    fetchMethod.parameters[1],
    "bindings",
    label,
  );

  const bindingAccesses = [];
  const visitBindingAccesses = (node) => {
    if (
      typescript.isPropertyAccessExpression(node) &&
      node.questionDotToken === undefined &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === "bindings" &&
      typescript.isIdentifier(node.name)
    ) {
      bindingAccesses.push(node);
    }
    typescript.forEachChild(node, visitBindingAccesses);
  };
  visitBindingAccesses(fetchMethod);
  assert.deepEqual(
    bindingAccesses.map((access) => access.name.text),
    ["ASSETS", "BACKEND"],
    label,
  );

  const handleBetaAdmissionCalls = collectDirectIdentifierCalls(
    fetchMethod,
    "handleBetaAdmission",
  );
  assert.equal(handleBetaAdmissionCalls.length, 1, label);
  const handleBetaAdmissionCall = handleBetaAdmissionCalls[0];
  assert.equal(handleBetaAdmissionCall.arguments.length, 2, label);
  assert.ok(
    typescript.isIdentifier(handleBetaAdmissionCall.arguments[1]) &&
      handleBetaAdmissionCall.arguments[1].text === "bindings",
    label,
  );
  const getContainerCalls = collectDirectIdentifierCalls(
    fetchMethod,
    "getContainer",
  );
  assert.equal(getContainerCalls.length, 1, label);
  const getContainerCall = getContainerCalls[0];
  assert.equal(getContainerCall.arguments.length, 2, label);
  assertSameSyntaxNode(
    getContainerCall.arguments[0],
    bindingAccesses[1],
    label,
  );
  const assetsAccess = bindingAccesses[0];
  assert.ok(
    typescript.isPropertyAccessExpression(assetsAccess.parent) &&
      assetsAccess.parent.expression === assetsAccess &&
      assetsAccess.parent.name.text === "fetch" &&
      typescript.isCallExpression(assetsAccess.parent.parent) &&
      assetsAccess.parent.parent.expression === assetsAccess.parent,
    label,
  );
  assertIdentifierNodeInventory(
    fetchMethod,
    "bindings",
    [
      fetchMethod.parameters[1].name,
      bindingAccesses[0].expression,
      handleBetaAdmissionCall.arguments[1],
      bindingAccesses[1].expression,
    ],
    label,
  );
  assertIdentifierNodeInventory(fetchMethod, "arguments", [], label);
  assertIdentifierNodeInventory(
    sourceFile,
    "handleBetaAdmission",
    [handleBetaAdmissionImport.name, handleBetaAdmissionCall.expression],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "getContainer",
    [getContainerImport.name, getContainerCall.expression],
    label,
  );

  const betaSourceFile = parseTypeScriptRepositoryFile(
    "cloudflare/src/beta-admission/beta-admission.ts",
    "Worker beta-admission source must parse before bindings analysis",
  );
  const exactTopLevelFunction = (name) => {
    const declarations = betaSourceFile.statements.filter(
      (statement) =>
        typescript.isFunctionDeclaration(statement) &&
        typescript.isIdentifier(statement.name) &&
        statement.name.text === name,
    );
    assert.equal(declarations.length, 1, label);
    assert.ok(declarations[0].body !== undefined, label);
    return declarations[0];
  };
  const admissionFunction = exactTopLevelFunction("handleBetaAdmission");
  assert.equal(admissionFunction.parameters.length, 3, label);
  assertCanonicalIdentifierParameter(
    admissionFunction.parameters[1],
    "bindings",
    label,
  );
  const parseCalls = collectDirectIdentifierCalls(
    admissionFunction,
    "parseBetaAdmissionConfig",
  );
  assert.equal(parseCalls.length, 1, label);
  const parseCall = parseCalls[0];
  assert.equal(parseCall.arguments.length, 1, label);
  assert.ok(
    typescript.isIdentifier(parseCall.arguments[0]) &&
      parseCall.arguments[0].text === "bindings",
    label,
  );
  assertIdentifierNodeInventory(
    admissionFunction,
    "bindings",
    [admissionFunction.parameters[1].name, parseCall.arguments[0]],
    label,
  );
  assertIdentifierNodeInventory(admissionFunction, "arguments", [], label);

  const parserFunction = exactTopLevelFunction("parseBetaAdmissionConfig");
  assert.equal(parserFunction.parameters.length, 1, label);
  assertCanonicalIdentifierParameter(
    parserFunction.parameters[0],
    "bindings",
    label,
  );
  const parserAccesses = [];
  const visitParserAccesses = (node) => {
    if (
      typescript.isPropertyAccessExpression(node) &&
      node.questionDotToken === undefined &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === "bindings" &&
      typescript.isIdentifier(node.name)
    ) {
      parserAccesses.push(node);
    }
    typescript.forEachChild(node, visitParserAccesses);
  };
  visitParserAccesses(parserFunction);
  assert.deepEqual(
    parserAccesses.map((access) => access.name.text),
    [
      "BETA_ADMISSION_MODE",
      "BETA_ADMISSION_MODE",
      "PUBLIC_ORIGIN",
      "PUBLIC_ORIGIN",
      "BETA_ADMISSION_COOKIE_TTL_DAYS",
      "BETA_ADMISSION_COOKIE_KEY",
      "BETA_INVITES",
    ],
    label,
  );
  assertIdentifierNodeInventory(
    parserFunction,
    "bindings",
    [
      parserFunction.parameters[0].name,
      ...parserAccesses.map((access) => access.expression),
    ],
    label,
  );
  assertIdentifierNodeInventory(parserFunction, "arguments", [], label);
  assertIdentifierNodeInventory(
    betaSourceFile,
    "parseBetaAdmissionConfig",
    [parseCall.expression, parserFunction.name],
    label,
  );
}

function backendWorkerEnvironmentMappings() {
  const path = "cloudflare/src/index.ts";
  const sourceFile = parseTypeScriptRepositoryFile(
    path,
    "Worker source must parse before Container envVars analysis",
  );
  const [workerEnvironmentImport] = assertExactNamedImport(
    sourceFile,
    "cloudflare:workers",
    ["env"],
    "Worker env binding must use the canonical cloudflare:workers named import",
  );
  assertWorkerEnvironmentModuleReferenceInventory(
    sourceFile,
    workerEnvironmentImport,
  );
  const containerImports = assertExactNamedImport(
    sourceFile,
    "@cloudflare/containers",
    ["Container", "getContainer"],
    "Worker Container bindings must use the canonical @cloudflare/containers named imports",
  );
  const containerImport = containerImports.find(
    (element) => element.name.text === "Container",
  );
  const getContainerImport = containerImports.find(
    (element) => element.name.text === "getContainer",
  );
  assertWorkerBindingProvenance(sourceFile, getContainerImport);
  const requiredFunctions = sourceFile.statements.filter(
    (statement) =>
      typescript.isFunctionDeclaration(statement) &&
      typescript.isIdentifier(statement.name) &&
      statement.name.text === "required",
  );
  assert.equal(
    requiredFunctions.length,
    1,
    "Worker required binding must be a single top-level function declaration",
  );
  const requiredFunction = requiredFunctions[0];
  assert.equal(
    requiredFunction.modifiers?.length ?? 0,
    0,
    "Worker required binding must be a single top-level function declaration",
  );
  assert.ok(
    requiredFunction.asteriskToken === undefined,
    "Worker required binding must be a single top-level function declaration",
  );
  assert.ok(
    requiredFunction.body !== undefined,
    "Worker required binding must be a single top-level function declaration",
  );
  assert.deepEqual(
    requiredFunction.parameters.map((parameter) => {
      assert.ok(
        typescript.isIdentifier(parameter.name) &&
          parameter.dotDotDotToken === undefined &&
          parameter.questionToken === undefined &&
          parameter.initializer === undefined,
        "Worker required binding must keep canonical parameters",
      );
      return parameter.name.text;
    }),
    ["name", "value"],
    "Worker required binding must keep canonical parameters",
  );
  const requiredSemanticsLabel = "Worker required function semantics";
  assert.ok(
    requiredFunction.questionToken === undefined,
    requiredSemanticsLabel,
  );
  assert.equal(
    requiredFunction.parameters[0].type?.kind,
    typescript.SyntaxKind.StringKeyword,
    requiredSemanticsLabel,
  );
  const valueType = requiredFunction.parameters[1].type;
  assert.ok(typescript.isUnionTypeNode(valueType), requiredSemanticsLabel);
  assert.deepEqual(
    valueType.types.map((type) => type.kind),
    [
      typescript.SyntaxKind.StringKeyword,
      typescript.SyntaxKind.UndefinedKeyword,
    ],
    requiredSemanticsLabel,
  );
  assert.equal(
    requiredFunction.type?.kind,
    typescript.SyntaxKind.StringKeyword,
    requiredSemanticsLabel,
  );
  assert.equal(
    requiredFunction.body.statements.length,
    2,
    requiredSemanticsLabel,
  );
  const [guardStatement, returnStatement] = requiredFunction.body.statements;
  assert.ok(typescript.isIfStatement(guardStatement), requiredSemanticsLabel);
  assert.ok(guardStatement.elseStatement === undefined, requiredSemanticsLabel);
  assert.ok(
    typescript.isBinaryExpression(guardStatement.expression) &&
      guardStatement.expression.operatorToken.kind ===
        typescript.SyntaxKind.BarBarToken,
    requiredSemanticsLabel,
  );
  const undefinedGuard = guardStatement.expression.left;
  const blankGuard = guardStatement.expression.right;
  assert.ok(
    typescript.isBinaryExpression(undefinedGuard) &&
      undefinedGuard.operatorToken.kind ===
        typescript.SyntaxKind.EqualsEqualsEqualsToken &&
      typescript.isIdentifier(undefinedGuard.left) &&
      undefinedGuard.left.text === "value" &&
      typescript.isIdentifier(undefinedGuard.right) &&
      undefinedGuard.right.text === "undefined",
    requiredSemanticsLabel,
  );
  assert.ok(
    typescript.isBinaryExpression(blankGuard) &&
      blankGuard.operatorToken.kind ===
        typescript.SyntaxKind.EqualsEqualsEqualsToken &&
      typescript.isStringLiteral(blankGuard.right) &&
      blankGuard.right.text === "",
    requiredSemanticsLabel,
  );
  const trimCall = blankGuard.left;
  assert.ok(
    typescript.isCallExpression(trimCall) &&
      trimCall.questionDotToken === undefined &&
      trimCall.arguments.length === 0 &&
      typescript.isPropertyAccessExpression(trimCall.expression) &&
      trimCall.expression.questionDotToken === undefined &&
      typescript.isIdentifier(trimCall.expression.expression) &&
      trimCall.expression.expression.text === "value" &&
      typescript.isIdentifier(trimCall.expression.name) &&
      trimCall.expression.name.text === "trim",
    requiredSemanticsLabel,
  );
  assert.ok(
    typescript.isBlock(guardStatement.thenStatement) &&
      guardStatement.thenStatement.statements.length === 1 &&
      typescript.isThrowStatement(guardStatement.thenStatement.statements[0]),
    requiredSemanticsLabel,
  );
  const throwStatement = guardStatement.thenStatement.statements[0];
  assert.ok(
    typescript.isNewExpression(throwStatement.expression) &&
      typescript.isIdentifier(throwStatement.expression.expression) &&
      throwStatement.expression.expression.text === "Error" &&
      (throwStatement.expression.typeArguments?.length ?? 0) === 0 &&
      throwStatement.expression.arguments?.length === 1,
    requiredSemanticsLabel,
  );
  const errorConstructor = throwStatement.expression;
  const errorMessage = errorConstructor.arguments[0];
  assert.ok(
    typescript.isTemplateExpression(errorMessage) &&
      errorMessage.head.text === "Missing required Worker secret: " &&
      errorMessage.templateSpans.length === 1,
    requiredSemanticsLabel,
  );
  const errorMessageSpan = errorMessage.templateSpans[0];
  assert.ok(
    typescript.isIdentifier(errorMessageSpan.expression) &&
      errorMessageSpan.expression.text === "name" &&
      typescript.isTemplateTail(errorMessageSpan.literal) &&
      errorMessageSpan.literal.text === "",
    requiredSemanticsLabel,
  );
  assert.ok(
    typescript.isReturnStatement(returnStatement) &&
      typescript.isIdentifier(returnStatement.expression) &&
      returnStatement.expression.text === "value",
    requiredSemanticsLabel,
  );
  assertIdentifierNodeInventory(
    requiredFunction,
    "name",
    [requiredFunction.parameters[0].name, errorMessageSpan.expression],
    requiredSemanticsLabel,
  );
  assertIdentifierNodeInventory(
    requiredFunction,
    "value",
    [
      requiredFunction.parameters[1].name,
      undefinedGuard.left,
      trimCall.expression.expression,
      returnStatement.expression,
    ],
    requiredSemanticsLabel,
  );
  assertIdentifierNodeInventory(
    requiredFunction,
    "undefined",
    [undefinedGuard.right],
    requiredSemanticsLabel,
  );
  assertIdentifierNodeInventory(
    requiredFunction,
    "Error",
    [errorConstructor.expression],
    requiredSemanticsLabel,
  );
  const backendClasses = [];
  const collectBackendClasses = (node) => {
    if (
      typescript.isClassDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.name.text === "Backend"
    ) {
      backendClasses.push(node);
    }
    typescript.forEachChild(node, collectBackendClasses);
  };
  collectBackendClasses(sourceFile);
  assert.equal(
    backendClasses.length,
    1,
    "Worker Backend class must be declared exactly once",
  );

  const backendClass = backendClasses[0];
  const backendDeclarationLabel = "Worker Backend declaration contract";
  assertSameSyntaxNode(
    backendClass.parent,
    sourceFile,
    backendDeclarationLabel,
  );
  assert.equal(
    sourceFile.statements.includes(backendClass),
    true,
    backendDeclarationLabel,
  );
  assert.deepEqual(
    (backendClass.modifiers ?? []).map((modifier) => modifier.kind),
    [typescript.SyntaxKind.ExportKeyword],
    backendDeclarationLabel,
  );
  assert.ok(backendClass.typeParameters === undefined, backendDeclarationLabel);
  assert.equal(
    backendClass.heritageClauses?.length,
    1,
    backendDeclarationLabel,
  );
  const extendsClause = backendClass.heritageClauses[0];
  assert.equal(
    extendsClause.token,
    typescript.SyntaxKind.ExtendsKeyword,
    backendDeclarationLabel,
  );
  assert.equal(extendsClause.types.length, 1, backendDeclarationLabel);
  const backendBaseType = extendsClause.types[0];
  assert.equal(
    backendBaseType.typeArguments?.length ?? 0,
    0,
    backendDeclarationLabel,
  );
  assert.ok(
    typescript.isIdentifier(backendBaseType.expression) &&
      backendBaseType.expression.text === "Container",
    backendDeclarationLabel,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "Container",
    [containerImport.name, backendBaseType.expression],
    "Worker Container binding provenance",
  );
  const envVarsMembers = backendClass.members.filter(
    (member) =>
      member.name !== undefined && syntaxNameText(member.name) === "envVars",
  );
  assert.equal(
    envVarsMembers.length,
    1,
    "Worker Backend.envVars must be declared exactly once",
  );
  const envVarsMember = envVarsMembers[0];
  assert.ok(
    typescript.isPropertyDeclaration(envVarsMember),
    "Worker Backend.envVars must be a PropertyDeclaration",
  );
  assert.ok(
    typescript.isIdentifier(envVarsMember.name) &&
      envVarsMember.name.text === "envVars",
    "Worker Backend.envVars must use a direct identifier name",
  );
  assert.ok(
    envVarsMember.questionToken === undefined,
    "Worker Backend.envVars must not be optional",
  );
  assert.ok(
    envVarsMember.exclamationToken === undefined,
    "Worker Backend.envVars must not use definite assignment syntax",
  );
  assert.equal(
    envVarsMember.modifiers?.length ?? 0,
    0,
    "Worker Backend.envVars must not use modifiers",
  );
  assert.ok(
    typescript.isObjectLiteralExpression(envVarsMember.initializer),
    "Worker Backend.envVars initializer must be an ObjectLiteralExpression",
  );
  const envVarsSyntaxUses = [];
  const collectEnvVarsSyntaxUses = (node) => {
    const staticPropertyKey =
      typescript.isCallExpression(node) && node.arguments.length >= 2
        ? staticStringExpressionValue(node.arguments[1])
        : undefined;
    const directReflectiveMutation =
      staticPropertyKey === "envVars" &&
      typescript.isPropertyAccessExpression(node.expression) &&
      node.expression.questionDotToken === undefined &&
      typescript.isIdentifier(node.expression.expression) &&
      ((node.expression.expression.text === "Reflect" &&
        node.expression.name.text === "set") ||
        (node.expression.expression.text === "Object" &&
          node.expression.name.text === "defineProperty"));
    if (typescript.isIdentifier(node) && node.text === "envVars") {
      envVarsSyntaxUses.push(node);
    } else if (
      typescript.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      staticStringExpressionValue(node.argumentExpression) === "envVars"
    ) {
      envVarsSyntaxUses.push(node);
    } else if (directReflectiveMutation) {
      envVarsSyntaxUses.push(node);
    }
    typescript.forEachChild(node, collectEnvVarsSyntaxUses);
  };
  collectEnvVarsSyntaxUses(sourceFile);
  assert.equal(
    envVarsSyntaxUses.length,
    1,
    "Worker Backend.envVars must not be accessed or mutated outside its canonical class field",
  );
  assertSameSyntaxNode(
    envVarsSyntaxUses[0],
    envVarsMember.name,
    "Worker Backend.envVars must not be accessed or mutated outside its canonical class field",
  );

  const backendMemberNames = backendClass.members.map((member) => {
    assert.ok(
      typescript.isPropertyDeclaration(member) &&
        typescript.isIdentifier(member.name) &&
        member.questionToken === undefined &&
        member.exclamationToken === undefined &&
        member.type === undefined &&
        (member.modifiers?.length ?? 0) === 0 &&
        member.initializer !== undefined,
      "Worker Backend class member inventory",
    );
    return member.name.text;
  });
  assert.deepEqual(
    backendMemberNames,
    ["defaultPort", "sleepAfter", "envVars"],
    "Worker Backend class member inventory",
  );
  assert.ok(
    typescript.isNumericLiteral(backendClass.members[0].initializer) &&
      backendClass.members[0].initializer.text === "8080",
    "Worker Backend.defaultPort must remain the canonical literal",
  );
  assert.ok(
    typescript.isStringLiteral(backendClass.members[1].initializer) &&
      backendClass.members[1].initializer.text === "10m",
    "Worker Backend.sleepAfter must remain the canonical literal",
  );

  const mappings = {};
  const requiredCallBindings = [];
  const environmentSourceBindings = [];
  for (const property of envVarsMember.initializer.properties) {
    if (typescript.isSpreadAssignment(property)) {
      assert.fail("Container envVars object spread is forbidden");
    }
    if (
      typescript.isPropertyAssignment(property) &&
      typescript.isComputedPropertyName(property.name)
    ) {
      assert.fail("Container envVars computed properties are forbidden");
    }
    assert.ok(
      typescript.isPropertyAssignment(property) &&
        typescript.isIdentifier(property.name),
      "Container envVars has unsupported top-level property syntax",
    );
    const key = property.name.text;
    assert.match(
      key,
      /^[A-Z][A-Z0-9_]*$/,
      "Container envVars property names must use canonical environment keys",
    );
    assert.equal(
      Object.hasOwn(mappings, key),
      false,
      "Container envVars property is duplicated: " + key,
    );

    if (typescript.isStringLiteral(property.initializer)) {
      mappings[key] = { kind: "literal", value: property.initializer.text };
      continue;
    }

    assert.ok(
      typescript.isCallExpression(property.initializer),
      "Container envVars values must be string literals or direct required() calls: " +
        key,
    );
    const requiredCall = property.initializer;
    assert.ok(
      requiredCall.questionDotToken === undefined,
      "Container envVars required() calls must not be optional: " + key,
    );
    assert.ok(
      typescript.isIdentifier(requiredCall.expression) &&
        requiredCall.expression.text === "required",
      "Container envVars values must call the direct required binding: " + key,
    );
    assert.equal(
      requiredCall.arguments.length,
      2,
      "Container envVars required() must receive exactly two arguments: " + key,
    );
    const [errorLabel, environmentSource] = requiredCall.arguments;
    assert.ok(
      typescript.isStringLiteral(errorLabel),
      "Container envVars required() label must be a string literal: " + key,
    );
    assert.equal(
      errorLabel.text,
      key,
      "Container envVars required() label must match property key: " + key,
    );
    assert.ok(
      typescript.isPropertyAccessExpression(environmentSource) &&
        environmentSource.questionDotToken === undefined &&
        typescript.isIdentifier(environmentSource.expression) &&
        environmentSource.expression.text === "env" &&
        typescript.isIdentifier(environmentSource.name),
      "Container envVars required() source must use direct env.KEY syntax: " +
        key,
    );
    requiredCallBindings.push(requiredCall.expression);
    environmentSourceBindings.push(environmentSource.expression);
    assert.equal(
      environmentSource.name.text,
      key,
      "Container envVars required() env source must match property key: " + key,
    );
    mappings[key] = {
      kind: "required",
      errorLabel: errorLabel.text,
      environmentSource: environmentSource.name.text,
    };
  }
  assertIdentifierNodeInventory(
    sourceFile,
    "required",
    [requiredFunction.name, ...requiredCallBindings],
    "Worker required binding provenance",
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "env",
    [workerEnvironmentImport.name, ...environmentSourceBindings],
    "Worker cloudflare:workers env binding provenance",
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "Backend",
    [backendClass.name],
    "Worker Backend binding must not be reused outside its canonical declaration",
  );
  return mappings;
}

function assertExactNamedImport(sourceFile, moduleName, expectedNames, label) {
  const declarations = sourceFile.statements.filter(
    (statement) =>
      typescript.isImportDeclaration(statement) &&
      typescript.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName,
  );
  assert.equal(declarations.length, 1, label);
  const declaration = declarations[0];
  const clause = declaration.importClause;
  assert.ok(
    clause !== undefined &&
      clause.isTypeOnly === false &&
      clause.name === undefined &&
      clause.namedBindings !== undefined &&
      typescript.isNamedImports(clause.namedBindings),
    label,
  );
  assert.ok(declaration.attributes === undefined, label);
  const elements = clause.namedBindings.elements;
  assert.deepEqual(
    elements.map((element) => element.name.text).sort(),
    [...expectedNames].sort(),
    label,
  );
  for (const element of elements) {
    assert.equal(element.isTypeOnly, false, label);
    assert.ok(element.propertyName === undefined, label);
    assert.ok(typescript.isIdentifier(element.name), label);
  }
  return elements;
}

function bindingIdentifierTexts(name) {
  if (typescript.isIdentifier(name)) return [name.text];
  const names = [];
  for (const element of name.elements) {
    if (typescript.isOmittedExpression(element)) continue;
    names.push(...bindingIdentifierTexts(element.name));
  }
  return names;
}

function statementBindingNames(statement) {
  if (typescript.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return [];
    const names = clause.name === undefined ? [] : [clause.name.text];
    if (clause.namedBindings === undefined) return names;
    if (typescript.isNamespaceImport(clause.namedBindings)) {
      names.push(clause.namedBindings.name.text);
    } else {
      names.push(
        ...clause.namedBindings.elements.map((element) => element.name.text),
      );
    }
    return names;
  }
  if (typescript.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingIdentifierTexts(declaration.name),
    );
  }
  if (
    typescript.isFunctionDeclaration(statement) ||
    typescript.isClassDeclaration(statement) ||
    typescript.isEnumDeclaration(statement) ||
    typescript.isModuleDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  return [];
}

function assertNoBuildConfigBindingCollisions(sourceFile, factory, label) {
  const reservedNames = new Set([
    "defineConfig",
    "loadEnv",
    "mode",
    "parseDeploymentEnvironment",
    "process",
    "searchIndexingPlugin",
  ]);
  const expectedModuleBindings = [
    "defineConfig",
    "loadEnv",
    "parseDeploymentEnvironment",
    "searchIndexingPlugin",
  ];
  assert.deepEqual(
    sourceFile.statements
      .flatMap(statementBindingNames)
      .filter((name) => reservedNames.has(name))
      .sort(),
    expectedModuleBindings.sort(),
    label,
  );

  const callbackCollisions = factory.body.statements
    .flatMap(statementBindingNames)
    .filter((name) => reservedNames.has(name));
  const collectHoistedVarBindings = (node) => {
    if (
      typescript.isVariableDeclarationList(node) &&
      (node.flags & (typescript.NodeFlags.Let | typescript.NodeFlags.Const)) ===
        0
    ) {
      callbackCollisions.push(
        ...node.declarations
          .flatMap((declaration) => bindingIdentifierTexts(declaration.name))
          .filter((name) => reservedNames.has(name)),
      );
    }
    typescript.forEachChild(node, collectHoistedVarBindings);
  };
  collectHoistedVarBindings(factory.body);
  assert.deepEqual(callbackCollisions, [], label);
}

function exactConstDeclaration(statement, name, label) {
  assert.ok(typescript.isVariableStatement(statement), label);
  assert.notEqual(
    statement.declarationList.flags & typescript.NodeFlags.Const,
    0,
    label,
  );
  assert.equal(statement.declarationList.declarations.length, 1, label);
  const declaration = statement.declarationList.declarations[0];
  assert.ok(
    typescript.isIdentifier(declaration.name) && declaration.name.text === name,
    label,
  );
  assert.ok(declaration.exclamationToken === undefined, label);
  assert.ok(declaration.type === undefined, label);
  assert.notEqual(declaration.initializer, undefined, label);
  return declaration;
}

function assertIdentifierNodeInventory(sourceFile, name, expectedNodes, label) {
  const actualNodes = [];
  const collectIdentifiers = (node) => {
    const parent = node.parent;
    const isNonValuePropertyName =
      (parent !== undefined &&
        (typescript.isPropertyAssignment(parent) ||
          typescript.isPropertyDeclaration(parent) ||
          typescript.isMethodDeclaration(parent) ||
          typescript.isGetAccessorDeclaration(parent) ||
          typescript.isSetAccessorDeclaration(parent)) &&
        parent.name === node) ||
      (parent !== undefined &&
        typescript.isPropertyAccessExpression(parent) &&
        parent.name === node);
    if (
      typescript.isIdentifier(node) &&
      node.text === name &&
      !isNonValuePropertyName
    ) {
      actualNodes.push(node);
    }
    typescript.forEachChild(node, collectIdentifiers);
  };
  collectIdentifiers(sourceFile);
  assertExactSyntaxNodeSequence(actualNodes, expectedNodes, label);
}

function assertFrontendDeploymentEnvironmentWiring(sourceFile) {
  const label = "Frontend build-config deployment environment wiring";
  const importDeclarations = sourceFile.statements.filter(
    typescript.isImportDeclaration,
  );
  assert.deepEqual(
    importDeclarations.map((declaration) => {
      assert.ok(typescript.isStringLiteral(declaration.moduleSpecifier), label);
      return declaration.moduleSpecifier.text;
    }),
    [
      "@vitejs/plugin-react",
      "vite",
      "vitest/config",
      "./vite/searchIndexing.ts",
    ],
    label,
  );
  const reactImportClause = importDeclarations[0].importClause;
  assert.ok(
    reactImportClause !== undefined &&
      reactImportClause.isTypeOnly === false &&
      typescript.isIdentifier(reactImportClause.name) &&
      reactImportClause.name.text === "react" &&
      reactImportClause.namedBindings === undefined,
    label,
  );
  assert.ok(importDeclarations[0].attributes === undefined, label);
  const [loadEnvironmentImport] = assertExactNamedImport(
    sourceFile,
    "vite",
    ["loadEnv"],
    label,
  );
  const [defineConfigImport] = assertExactNamedImport(
    sourceFile,
    "vitest/config",
    ["defineConfig"],
    label,
  );
  const searchIndexingImports = assertExactNamedImport(
    sourceFile,
    "./vite/searchIndexing.ts",
    ["parseDeploymentEnvironment", "searchIndexingPlugin"],
    label,
  );
  const parseEnvironmentImport = searchIndexingImports.find(
    (element) => element.name.text === "parseDeploymentEnvironment",
  );
  const searchIndexingPluginImport = searchIndexingImports.find(
    (element) => element.name.text === "searchIndexingPlugin",
  );

  const defaultExports = sourceFile.statements.filter(
    (statement) =>
      typescript.isExportAssignment(statement) &&
      statement.isExportEquals !== true,
  );
  assert.equal(defaultExports.length, 1, label);
  assert.equal(sourceFile.statements.length, 5, label);
  assertExactSyntaxNodeSequence(
    sourceFile.statements.slice(0, 4),
    importDeclarations,
    label,
  );
  assertSameSyntaxNode(sourceFile.statements[4], defaultExports[0], label);
  assert.ok(typescript.isCallExpression(defaultExports[0].expression), label);
  const defineConfigCall = defaultExports[0].expression;
  assert.ok(defineConfigCall.questionDotToken === undefined, label);
  assert.ok(
    typescript.isIdentifier(defineConfigCall.expression) &&
      defineConfigCall.expression.text === "defineConfig",
    label,
  );
  assert.equal(defineConfigCall.arguments.length, 1, label);
  const factory = defineConfigCall.arguments[0];
  assert.ok(typescript.isArrowFunction(factory), label);
  assert.ok(typescript.isBlock(factory.body), label);
  assert.equal(factory.modifiers?.length ?? 0, 0, label);
  assert.equal(factory.parameters.length, 1, label);
  const modeParameter = factory.parameters[0];
  assert.ok(modeParameter.dotDotDotToken === undefined, label);
  assert.ok(modeParameter.initializer === undefined, label);
  assert.ok(typescript.isObjectBindingPattern(modeParameter.name), label);
  assert.equal(modeParameter.name.elements.length, 1, label);
  const modeBinding = modeParameter.name.elements[0];
  assert.ok(modeBinding.propertyName === undefined, label);
  assert.ok(modeBinding.dotDotDotToken === undefined, label);
  assert.ok(modeBinding.initializer === undefined, label);
  assert.ok(
    typescript.isIdentifier(modeBinding.name) &&
      modeBinding.name.text === "mode",
    label,
  );
  assertNoBuildConfigBindingCollisions(sourceFile, factory, label);
  assert.equal(factory.body.statements.length, 3, label);

  const environmentDeclaration = exactConstDeclaration(
    factory.body.statements[0],
    "environment",
    label,
  );
  assert.ok(
    typescript.isCallExpression(environmentDeclaration.initializer),
    label,
  );
  const loadEnvironmentCall = environmentDeclaration.initializer;
  assert.ok(loadEnvironmentCall.questionDotToken === undefined, label);
  assert.ok(
    typescript.isIdentifier(loadEnvironmentCall.expression) &&
      loadEnvironmentCall.expression.text === "loadEnv",
    label,
  );
  assert.equal(loadEnvironmentCall.arguments.length, 3, label);
  assert.ok(
    typescript.isIdentifier(loadEnvironmentCall.arguments[0]) &&
      loadEnvironmentCall.arguments[0].text === "mode",
    label,
  );
  const workingDirectoryCall = loadEnvironmentCall.arguments[1];
  assert.ok(typescript.isCallExpression(workingDirectoryCall), label);
  assert.ok(workingDirectoryCall.questionDotToken === undefined, label);
  assert.equal(workingDirectoryCall.arguments.length, 0, label);
  assert.ok(
    typescript.isPropertyAccessExpression(workingDirectoryCall.expression) &&
      workingDirectoryCall.expression.questionDotToken === undefined &&
      typescript.isIdentifier(workingDirectoryCall.expression.expression) &&
      workingDirectoryCall.expression.expression.text === "process" &&
      typescript.isIdentifier(workingDirectoryCall.expression.name) &&
      workingDirectoryCall.expression.name.text === "cwd",
    label,
  );
  assert.ok(
    typescript.isStringLiteral(loadEnvironmentCall.arguments[2]) &&
      loadEnvironmentCall.arguments[2].text === "VITE_",
    label,
  );

  const deploymentDeclaration = exactConstDeclaration(
    factory.body.statements[1],
    "deploymentEnvironment",
    label,
  );
  assert.ok(
    typescript.isCallExpression(deploymentDeclaration.initializer),
    label,
  );
  const parseEnvironmentCall = deploymentDeclaration.initializer;
  assert.ok(parseEnvironmentCall.questionDotToken === undefined, label);
  assert.ok(
    typescript.isIdentifier(parseEnvironmentCall.expression) &&
      parseEnvironmentCall.expression.text === "parseDeploymentEnvironment",
    label,
  );
  assert.equal(parseEnvironmentCall.arguments.length, 1, label);
  const deploymentEnvironmentAccess = parseEnvironmentCall.arguments[0];
  assert.ok(
    typescript.isPropertyAccessExpression(deploymentEnvironmentAccess) &&
      deploymentEnvironmentAccess.questionDotToken === undefined &&
      typescript.isIdentifier(deploymentEnvironmentAccess.expression) &&
      deploymentEnvironmentAccess.expression.text === "environment" &&
      typescript.isIdentifier(deploymentEnvironmentAccess.name) &&
      deploymentEnvironmentAccess.name.text === "VITE_DEPLOYMENT_ENV",
    label,
  );

  const returnStatement = factory.body.statements[2];
  assert.ok(
    typescript.isReturnStatement(returnStatement) &&
      returnStatement.expression !== undefined &&
      typescript.isObjectLiteralExpression(returnStatement.expression),
    label,
  );
  const configurationProperties = returnStatement.expression.properties;
  assert.deepEqual(
    configurationProperties.map((property) => {
      assert.ok(
        typescript.isPropertyAssignment(property) &&
          typescript.isIdentifier(property.name),
        label,
      );
      return property.name.text;
    }),
    ["plugins", "server", "test"],
    label,
  );
  const pluginsProperty = configurationProperties[0];
  assert.ok(
    typescript.isArrayLiteralExpression(pluginsProperty.initializer),
    label,
  );
  assert.equal(pluginsProperty.initializer.elements.length, 2, label);
  const [reactCall, searchIndexingCall] = pluginsProperty.initializer.elements;
  assert.ok(
    typescript.isCallExpression(reactCall) &&
      reactCall.questionDotToken === undefined &&
      typescript.isIdentifier(reactCall.expression) &&
      reactCall.expression.text === "react" &&
      reactCall.arguments.length === 0,
    label,
  );
  assert.ok(typescript.isCallExpression(searchIndexingCall), label);
  assert.ok(searchIndexingCall.questionDotToken === undefined, label);
  assert.equal(searchIndexingCall.arguments.length, 1, label);
  assert.ok(
    typescript.isIdentifier(searchIndexingCall.expression) &&
      searchIndexingCall.expression.text === "searchIndexingPlugin" &&
      typescript.isIdentifier(searchIndexingCall.arguments[0]) &&
      searchIndexingCall.arguments[0].text === "deploymentEnvironment",
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "react",
    [reactImportClause.name, reactCall.expression],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "mode",
    [modeBinding.name, loadEnvironmentCall.arguments[0]],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "environment",
    [environmentDeclaration.name, deploymentEnvironmentAccess.expression],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "deploymentEnvironment",
    [deploymentDeclaration.name, searchIndexingCall.arguments[0]],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "defineConfig",
    [defineConfigImport.name, defineConfigCall.expression],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "loadEnv",
    [loadEnvironmentImport.name, loadEnvironmentCall.expression],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "parseDeploymentEnvironment",
    [parseEnvironmentImport.name, parseEnvironmentCall.expression],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "searchIndexingPlugin",
    [searchIndexingPluginImport.name, searchIndexingCall.expression],
    label,
  );
  assertIdentifierNodeInventory(
    sourceFile,
    "process",
    [workingDirectoryCall.expression.expression],
    label,
  );

  const viteAccesses = [];
  const collectViteAccesses = (node) => {
    if (
      typescript.isPropertyAccessExpression(node) &&
      typescript.isIdentifier(node.name) &&
      /^VITE_[A-Z][A-Z0-9_]*$/.test(node.name.text)
    ) {
      viteAccesses.push({ name: node.name.text, node, syntax: "direct" });
    } else if (
      typescript.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      typescript.isStringLiteral(node.argumentExpression) &&
      /^VITE_[A-Z][A-Z0-9_]*$/.test(node.argumentExpression.text)
    ) {
      viteAccesses.push({
        name: node.argumentExpression.text,
        node,
        syntax: "computed",
      });
    }
    typescript.forEachChild(node, collectViteAccesses);
  };
  collectViteAccesses(sourceFile);
  assert.deepEqual(
    viteAccesses.map(({ name, syntax }) => syntax + ":" + name),
    ["direct:VITE_DEPLOYMENT_ENV"],
    "Frontend build-config environment consumer inventory",
  );
  assertSameSyntaxNode(
    viteAccesses[0].node,
    deploymentEnvironmentAccess,
    label,
  );
}

function assertNoAdditionalFrontendBuildEnvironmentConsumers() {
  const label = "Frontend build helper environment consumer inventory";
  const helperPaths = repositoryFiles("frontend/vite", "").filter(
    (path) =>
      /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(path) &&
      !/\.(?:test|spec)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(path) &&
      !/\.d\.(?:cts|mts|ts)$/.test(path),
  );
  assert.deepEqual(helperPaths, ["frontend/vite/searchIndexing.ts"], label);
  const sourceFile = parseTypeScriptRepositoryFile(helperPaths[0], label);
  const viteImports = sourceFile.statements.filter(
    (statement) =>
      typescript.isImportDeclaration(statement) &&
      typescript.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "vite",
  );
  assert.equal(viteImports.length, 1, label);
  const clause = viteImports[0].importClause;
  assert.ok(
    clause !== undefined &&
      clause.isTypeOnly === true &&
      clause.name === undefined &&
      clause.namedBindings !== undefined &&
      typescript.isNamedImports(clause.namedBindings),
    label,
  );
  assert.ok(viteImports[0].attributes === undefined, label);
  assert.deepEqual(
    clause.namedBindings.elements.map((element) => {
      assert.equal(element.isTypeOnly, false, label);
      assert.ok(element.propertyName === undefined, label);
      return element.name.text;
    }),
    ["HtmlTagDescriptor", "Plugin"],
    label,
  );

  const forbiddenEnvironmentDiagnostics = [];
  const visit = (node) => {
    if (
      (typescript.isIdentifier(node) &&
        (node.text === "loadEnv" || node.text === "process")) ||
      isImportMeta(node) ||
      (typescript.isPropertyAccessExpression(node) &&
        typescript.isIdentifier(node.name) &&
        node.name.text === "env") ||
      (typescript.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        ["env", "loadEnv", "process"].includes(
          staticStringExpressionValue(node.argumentExpression),
        ))
    ) {
      pushSyntaxDiagnostic(
        forbiddenEnvironmentDiagnostics,
        sourceFile,
        helperPaths[0],
        node,
      );
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.deepEqual(forbiddenEnvironmentDiagnostics, [], label);
}

function frontendHtmlScriptInventory(path, source) {
  const parseErrors = [];
  const document = parseHtml(source, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error.code),
  });
  assert.deepEqual(
    parseErrors,
    [],
    `${path}: production Frontend HTML must parse canonically`,
  );
  const scripts = [];
  const visit = (node) => {
    if (node.tagName === "script") {
      scripts.push({
        path,
        attributes: Object.fromEntries(
          node.attrs.map(({ name, value }) => [name, value]),
        ),
        inlineCode: node.childNodes
          .filter((child) => child.nodeName === "#text")
          .map((child) => child.value)
          .join("")
          .trim(),
      });
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  return scripts;
}

function assertApprovedProductionFrontendEnvironmentConsumers(frontend) {
  const entries = repositoryEntries("frontend");
  const frontendEnvironmentEntries = entries.filter(({ path }) =>
    /(?:^|\/)\.env(?:\.|$)/.test(path),
  );
  assert.deepEqual(
    frontendEnvironmentEntries.map(({ path, kind }) => `${kind}:${path}`),
    ["file:frontend/.env.example"],
    "production Frontend tracked environment-file inventory",
  );
  const htmlEnvironmentReferences = [];
  const htmlScripts = [];
  for (const { path, kind } of entries.filter(({ path }) =>
    path.endsWith(".html"),
  )) {
    assert.equal(
      kind,
      "file",
      `${path}: production Frontend HTML must be a regular candidate file`,
    );
    const source = readRepositoryFile(path);
    htmlScripts.push(...frontendHtmlScriptInventory(path, source));
    for (const name of matches(source, /%(VITE_\S+?)%/g)) {
      htmlEnvironmentReferences.push(`${path}:${name}`);
    }
  }
  assert.deepEqual(
    htmlEnvironmentReferences,
    [],
    "production Frontend HTML environment interpolation inventory",
  );
  assert.deepEqual(
    htmlScripts,
    [
      {
        path: "frontend/index.html",
        attributes: { type: "module", src: "/src/main.tsx" },
        inlineCode: "",
      },
    ],
    "production Frontend HTML script inventory",
  );

  const accesses = [];
  const executableExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/;
  const sourcePaths = repositoryFiles("", "").filter(
    (path) =>
      executableExtension.test(path) && !/\.d\.(?:cts|mts|ts)$/.test(path),
  );
  for (const path of sourcePaths) {
    const source = readRepositoryFile(path);
    const sourceFile = typescript.createSourceFile(
      path,
      source,
      typescript.ScriptTarget.Latest,
      true,
      frontendScriptKind(path),
    );
    assert.deepEqual(
      sourceFile.parseDiagnostics.map((diagnostic) =>
        typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
      [],
      `${path}: candidate executable source must parse before Frontend environment analysis`,
    );

    const visit = (node) => {
      if (isImportMeta(node)) {
        const parent = node.parent;
        const directPropertyAccess =
          typescript.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.questionDotToken === undefined;
        if (
          directPropertyAccess &&
          typescript.isIdentifier(parent.name) &&
          parent.name.text === "url"
        ) {
          return;
        }

        const directEnvironmentAccess =
          directPropertyAccess &&
          typescript.isIdentifier(parent.name) &&
          parent.name.text === "env";
        assert.ok(
          directEnvironmentAccess,
          `${path}: production Frontend import.meta access must use canonical import.meta.url or direct literal import.meta.env.VITE_* syntax`,
        );
        const keyAccess = parent.parent;
        const directLiteral =
          typescript.isPropertyAccessExpression(keyAccess) &&
          keyAccess.expression === parent &&
          keyAccess.questionDotToken === undefined &&
          typescript.isIdentifier(keyAccess.name) &&
          /^VITE_[A-Z][A-Z0-9_]*$/.test(keyAccess.name.text);
        assert.ok(
          directLiteral,
          `${path}: production Frontend import.meta access must use canonical import.meta.url or direct literal import.meta.env.VITE_* syntax`,
        );
        accesses.push(`${path}:${keyAccess.name.text}`);
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assertExactSet(
    productionFrontendEnvironmentAccessAllowlist,
    accesses,
    "production Frontend environment consumer inventory",
  );
  assertExactSet(
    [...Object.keys(frontend.required), ...Object.keys(frontend.optional)],
    unique(accesses.map((access) => access.slice(access.lastIndexOf(":") + 1))),
    "Frontend contract/production consumers",
  );
}

function frontendScriptKind(path) {
  if (path.endsWith(".jsx")) return typescript.ScriptKind.JSX;
  if (path.endsWith(".tsx")) return typescript.ScriptKind.TSX;
  if (/\.(?:cjs|js|mjs)$/.test(path)) return typescript.ScriptKind.JS;
  return typescript.ScriptKind.TS;
}

function isImportMeta(node) {
  return (
    typescript.isMetaProperty(node) &&
    node.keywordToken === typescript.SyntaxKind.ImportKeyword &&
    node.name.text === "meta"
  );
}

function assertCanonicalProductionEnvironmentPackageImports() {
  for (const environmentImport of backendGoInventory().environmentImports) {
    assert.equal(
      environmentImport.name,
      "",
      `${environmentImport.path}: aliases and dot imports for OS environment packages are forbidden`,
    );
    assert.equal(
      environmentImport.literal,
      JSON.stringify(environmentImport.importPath),
      `${environmentImport.path}: OS environment package imports must use canonical string literals`,
    );
  }
}

function assertNoUnapprovedProductionBackendEnvironmentAccess() {
  const inventory = backendGoInventory();
  assertCanonicalProductionEnvironmentPackageImports();
  const accesses = inventory.environmentAccesses.map((access) => {
    if (access.kind === "call") {
      return `${access.path}:${access.identifier}:${access.key}`;
    }
    assert.equal(
      access.kind,
      "value",
      `unsupported Backend environment access kind: ${access.kind}`,
    );
    return `${access.path}:${access.identifier}:consumer=${access.consumer}`;
  });
  assertExactSet(
    productionBackendEnvironmentAccessAllowlist,
    accesses,
    "production Backend direct environment access allowlist",
  );
}

function assertApprovedProductionBackendEnvironmentConsumers() {
  const inventory = backendGoInventory();
  assertExactSet(
    [
      "backend/cmd/cleanup/main.go:os.LookupEnv:consumer=os.Exit(runCleanupCommand(ctx, os.Args[1:], os.LookupEnv, os.Stdout, dependencies))",
      "backend/cmd/configcheck/main.go:os.LookupEnv:consumer=return checkConfigurationWithLookup(os.LookupEnv)",
      "backend/cmd/kpireport/main.go:os.LookupEnv:consumer=lookupEnvironment := os.LookupEnv",
      'backend/cmd/migrate/main.go:os.Getenv:consumer=databaseURL := os.Getenv("DATABASE_URL")',
      'backend/cmd/migrate/main.go:os.Getenv:consumer=directory := os.Getenv("MIGRATIONS_DIR")',
      "backend/cmd/server/main.go:os.LookupEnv:consumer=settings, err := config.Load(os.LookupEnv)",
      "backend/internal/infrastructure/observability/runtime.go:os.Environ:consumer=for _, entry := range os.Environ()",
      "backend/internal/infrastructure/postgres/cleanup_repository.go:os.LookupEnv:consumer=poolConfig, err := cleanupPoolConfig(databaseURL, os.LookupEnv)",
      "backend/internal/infrastructure/postgres/kpi_report_repository.go:os.LookupEnv:consumer=poolConfig, err := kpiReportPoolConfig(databaseURL, os.LookupEnv)",
    ],
    inventory.environmentAccesses.map(
      (access) =>
        `${access.path}:${access.identifier}:consumer=${access.consumer}`,
    ),
    "production Backend environment consumer inventory",
  );
  assert.deepEqual(
    inventory.lookupParameters,
    [
      {
        path: "backend/cmd/cleanup/main.go",
        function: "runCleanupCommand",
        name: "lookupEnv",
        type: "func(string) (string, bool)",
        uses: [{ kind: "call", expression: 'lookupEnv("DATABASE_URL")' }],
      },
      {
        path: "backend/cmd/configcheck/main.go",
        function: "checkConfigurationWithLookup",
        name: "lookup",
        type: "config.LookupEnv",
        uses: [{ kind: "argument", expression: "config.Load(lookup)" }],
      },
      {
        path: "backend/cmd/kpireport/main.go",
        function: "runKPIReportCommand",
        name: "lookupEnv",
        type: "func(string) (string, bool)",
        uses: [{ kind: "call", expression: 'lookupEnv("KPI_DATABASE_URL")' }],
      },
      {
        path: "backend/internal/config/config.go",
        function: "Load",
        name: "lookup",
        type: "LookupEnv",
        uses: [{ kind: "value", expression: "lookup: lookup" }],
      },
      {
        path: "backend/internal/infrastructure/postgres/cleanup_repository.go",
        function: "cleanupPoolConfig",
        name: "lookupEnv",
        type: "func(string) (string, bool)",
        uses: [{ kind: "call", expression: "lookupEnv(name)" }],
      },
      {
        path: "backend/internal/infrastructure/postgres/kpi_report_repository.go",
        function: "kpiReportPoolConfig",
        name: "lookupEnv",
        type: "func(string) (string, bool)",
        uses: [
          {
            kind: "argument",
            expression: "cleanupPoolConfig(databaseURL, lookupEnv)",
          },
        ],
      },
    ],
    "production Backend environment consumer inventory",
  );

  const cleanupRepositorySource = readRepositoryFile(
    "backend/internal/infrastructure/postgres/cleanup_repository.go",
  );
  const cleanupEnvironmentNames = between(
    cleanupRepositorySource,
    "var cleanupPostgresEnvironmentVariables = []string{\n",
    "\n}",
  );
  assert.deepEqual(
    matches(cleanupEnvironmentNames, /^\t"([A-Z][A-Z0-9_]*)",$/gm),
    approvedCleanupPostgresEnvironmentVariables,
    "production Backend cleanup PG environment allowlist",
  );
}

function repositoryEntries(directory) {
  const root = join(repositoryRoot, directory);
  const result = [];
  const visit = (absoluteDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      const path = absolutePath.slice(repositoryRoot.length + 1);
      if (entry.isDirectory()) visit(absolutePath);
      else {
        result.push({
          path,
          kind: entry.isFile() ? "file" : "non-file",
        });
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function repositoryFiles(directory, suffix) {
  const root = join(repositoryRoot, directory);
  const result = [];
  const visit = (absoluteDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && entry.name.endsWith(suffix)) {
        result.push(absolutePath.slice(repositoryRoot.length + 1));
      }
    }
  };
  visit(root);
  return result.sort();
}

function environmentExampleKeys() {
  return matches(readRepositoryFile(".env.example"), /^([A-Z][A-Z0-9_]*)=/gm);
}

function parseJSONC(source) {
  return JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));
}

function documentedBackendKeys() {
  const documented = between(
    readRepositoryFile("docs/environment.md"),
    "## Backend runtime\n",
    "## Frontend build-time\n",
  );
  return matches(documented, /^\| `([A-Z][A-Z0-9_]*)` \|/gm);
}

function documentedFrontendKeys() {
  const documented = between(
    readRepositoryFile("docs/environment.md"),
    "## Frontend build-time\n",
    "## Migration / test / tooling\n",
  );
  return matches(documented, /^\| `([A-Z][A-Z0-9_]*)` \|/gm);
}

function runWorkflowValidation(overrides) {
  const environment = {
    PATH: process.env.PATH ?? "",
    APP_REFERRAL_URL: "",
    BETA_ADMISSION_COOKIE_TTL_DAYS: "",
    BETA_INVITES: "",
    BETA_ADMISSION_COOKIE_KEY: "",
  };
  for (const name of validationRequiredKeys) environment[name] = "fixture";
  Object.assign(environment, {
    PUBLIC_ORIGIN: "https://cycle.staging.fukamu.matoruru.com",
    BETA_ADMISSION_MODE: "off",
    ...overrides,
  });
  return spawnSync("bash", ["-c", validationCommand], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
  });
}

function requiredInputNames(deploymentContract) {
  return unique([
    ...deploymentContract.backend.githubVariables,
    ...deploymentContract.backend.secrets,
    deploymentContract.closedBeta.mode.name,
    ...Object.values(deploymentContract.frontend.required),
    ...deploymentContract.deploy.requiredOnly,
  ]);
}

function expressionMappings(block, context) {
  assert.equal(
    context === "vars" || context === "secrets",
    true,
    `unsupported workflow expression context: ${context}`,
  );
  const result = {};
  const seenTargets = new Set();
  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    const direct =
      /^      ([A-Z][A-Z0-9_]*): \$\{\{ (vars|secrets)\.([A-Z][A-Z0-9_]*) \}\}$/.exec(
        line,
      );
    let mapping;
    if (direct) {
      mapping = { target: direct[1], context: direct[2], source: direct[3] };
    } else {
      const resolved =
        /^      ([A-Z][A-Z0-9_]*): \$\{\{ needs\.resolve\.outputs\.([a-z][a-z0-9_]*) \}\}$/.exec(
          line,
        );
      if (resolved) {
        mapping = {
          target: resolved[1],
          context: "needs",
          source: `resolve.outputs.${resolved[2]}`,
        };
      }
    }
    if (
      mapping === undefined &&
      line ===
        "      BETA_ADMISSION_MODE: ${{ vars.BETA_ADMISSION_MODE || 'off' }}"
    ) {
      mapping = {
        target: "BETA_ADMISSION_MODE",
        context: "vars",
        source: "BETA_ADMISSION_MODE",
      };
    }
    if (mapping === undefined) {
      const retryMappings = {
        "      DEPLOY_MODE: ${{ inputs.mode }}": {
          target: "DEPLOY_MODE",
          context: "retry",
          source: "inputs.mode",
        },
      };
      mapping = retryMappings[line];
    }
    assert.ok(
      mapping,
      `deployment workflow job environment has unsupported mapping: ${line.trim()}`,
    );
    assert.equal(
      seenTargets.has(mapping.target),
      false,
      `deployment workflow job environment is duplicated: ${mapping.target}`,
    );
    seenTargets.add(mapping.target);
    if (mapping.context === context) result[mapping.target] = mapping.source;
  }
  return result;
}

function buildEnvironmentMappings(step) {
  const block = between(step, "        env:\n", "        run:");
  const result = {};
  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    const fixed = /^          ([A-Z][A-Z0-9_]*): ([a-z]+)$/.exec(line);
    const mapped =
      /^          ([A-Z][A-Z0-9_]*): \$\{\{ env\.([A-Z][A-Z0-9_]*) \}\}$/.exec(
        line,
      );
    const mapping = fixed ?? mapped;
    assert.ok(
      mapping,
      `deployment contract/frontend build input has unsupported mapping: ${line.trim()}`,
    );
    assert.equal(
      Object.hasOwn(result, mapping[1]),
      false,
      `deployment contract/frontend build input is duplicated: ${mapping[1]}`,
    );
    result[mapping[1]] = mapping[2];
  }
  return result;
}

function secretSourceMappings(names, aliases = {}) {
  const result = {};
  for (const name of names) {
    assert.equal(
      Object.hasOwn(result, name),
      false,
      `deployment secret target is duplicated: ${name}`,
    );
    result[name] = aliases[name] ?? name;
  }
  return result;
}

function secretEnvironmentMappings(sources) {
  return Object.fromEntries(
    Object.entries(sources).map(([target, source]) => [
      target,
      { kind: "secret", value: source },
    ]),
  );
}

function stepEnvironmentMappings(step) {
  const block = between(step, "        env:\n", "        run:");
  const result = {};
  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    const secret =
      /^          ([A-Z][A-Z0-9_]*): \$\{\{ secrets\.([A-Z][A-Z0-9_]*) \}\}$/.exec(
        line,
      );
    const mapped =
      /^          ([A-Z][A-Z0-9_]*): \$\{\{ env\.([A-Z][A-Z0-9_]*) \}\}$/.exec(
        line,
      );
    const literal = /^          ([A-Z][A-Z0-9_]*): (.*)$/.exec(line);
    assert.ok(
      secret ?? mapped ?? literal,
      `workflow step environment has unsupported mapping: ${line.trim()}`,
    );
    const target = (secret ?? mapped ?? literal)[1];
    assert.equal(
      Object.hasOwn(result, target),
      false,
      `workflow step environment is duplicated: ${target}`,
    );
    if (secret) {
      result[target] = { kind: "secret", value: secret[2] };
      continue;
    }
    if (mapped) {
      result[target] = { kind: "environment", value: mapped[2] };
      continue;
    }
    const rawValue = literal[2];
    result[target] = {
      kind: "literal",
      value:
        rawValue.startsWith('"') && rawValue.endsWith('"')
          ? JSON.parse(rawValue)
          : rawValue,
    };
  }
  return result;
}

function secretStepMappings(step) {
  return Object.fromEntries(
    Object.entries(stepEnvironmentMappings(step))
      .filter(([, mapping]) => mapping.kind === "secret")
      .map(([name, mapping]) => [name, mapping.value]),
  );
}

function extractStep(source, name) {
  const marker = `      - name: ${name}\n`;
  assert.equal(
    source.split(marker).length - 1,
    1,
    `workflow step must appear exactly once: ${name}`,
  );
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `workflow step not found: ${name}`);
  const contentStart = start + marker.length;
  const remainder = source.slice(contentStart);
  const relativeBoundaries = [
    remainder.indexOf("\n      - "),
    remainder.search(/\n  [A-Za-z0-9_-]+:\n/),
  ].filter((boundary) => boundary !== -1);
  const end =
    relativeBoundaries.length === 0
      ? source.length
      : contentStart + Math.min(...relativeBoundaries);
  return source.slice(start, end);
}

function extractUsesStep(source, uses) {
  const marker = `      - uses: ${uses}\n`;
  assert.equal(
    source.split(marker).length - 1,
    1,
    `workflow action step must appear exactly once: ${uses}`,
  );
  const start = source.indexOf(marker);
  const end = source.indexOf("\n      - ", start + marker.length);
  return source.slice(start, end === -1 ? source.length : end);
}

function extractRunCommand(step) {
  const match = /^        run: ([^\n]+)$/m.exec(step);
  assert.ok(match, "workflow single-line run command not found");
  return match[1];
}

function extractStepProperty(step, name) {
  const match = new RegExp(`^        ${name}: ([^\\n]+)$`, "m").exec(step);
  assert.ok(match, `workflow step property not found: ${name}`);
  return match[1];
}

function assertStepExecutionControls(step, label, expectedShell) {
  const controls = step
    .split("\n")
    .filter((line) => /^        (?:if|continue-on-error|shell):/.test(line));
  const expected =
    expectedShell === null ? [] : [`        shell: ${expectedShell}`];
  assert.deepEqual(controls, expected, `${label} execution controls`);
}

function bashParameter(name) {
  return "${" + name + "}";
}

function extractBashArray(source, name) {
  const match = new RegExp(`${name}=\\(\\n([\\s\\S]*?)\\n\\s*\\)`).exec(source);
  assert.ok(match, `Bash array not found: ${name}`);
  return match[1].trim().split(/\s+/);
}

function between(source, startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const contentStart = start + startMarker.length;
  if (endMarker === "") return source.slice(contentStart);
  const end = source.indexOf(endMarker, contentStart);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return source.slice(contentStart, end);
}

function matches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function unique(values) {
  return [...new Set(values)].sort();
}

function assertExactSet(expected, actual, label) {
  assert.equal(
    new Set(expected).size,
    expected.length,
    `${label}: expected set contains duplicates`,
  );
  assert.equal(
    new Set(actual).size,
    actual.length,
    `${label}: actual set contains duplicates`,
  );
  assert.deepEqual(unique(actual), unique(expected), label);
}
