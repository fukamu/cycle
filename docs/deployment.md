# Deployment

この文書はPDCAIのdeployment手順のSource of Truthです。Architecture上の境界は [`design.md`](design.md) §44、環境変数の正確な一覧は [`environment.md`](environment.md)、migration規則は [`database.md`](database.md)、運用確認は [`operations.md`](operations.md) を参照してください。

## Environment model

| Environment | Purpose | Deployment | Isolation |
|---|---|---|---|
| Development | local開発 | 手動起動 | local PostgreSQL、Fake AI/Turnstile可 |
| Test | CI / E2E | GitHub Actions内 | job専用PostgreSQL、external providerはtest double |
| Staging Light | external integration検証 | main HEADのCI成功後にmanual `Deploy Staging` | `pdcai.matoruru.com`、専用Cloudflare/Neon/provider設定 |
| Production | 正式公開 | 未構築 | `pdcai.io`確定後にStagingと別resource/stateで設計 |

Staging Lightは `APP_ENV=production` でproduction security validationを通しますが、Production相当のSLA、backup、data retentionは保証しません。破棄可能な検証dataだけを使い、StagingのDB、session、IndexedDB、credentialをProductionへ移しません。

## Staging architecture

```text
Browser
  -> Cloudflare custom domain / TLS / DDoS protection
  -> Worker
       -> frontend/dist static assets
       -> /api/*, /healthz, /readyz
          -> singleton Cloudflare Container (Go API)
             -> Neon PostgreSQL pooled connection
             -> Google Identity / Turnstile / OpenAI

GitHub Actions
  -> Neon direct connectionでmigration
  -> WranglerでWorker + Container + assets + runtime secretsをdeploy

Terraform
  -> Cloudflare Turnstile widget
  -> state/lockfileはprivate R2 bucket
```

CloudflareのDDoS protectionはplanを問わず自動有効です。ただし、Application rate limit、Turnstile、認可、OpenAIのprovider/application budgetは別に必要です。

## Responsibility boundary

| Owner | Managed resources |
|---|---|
| Terraform | Staging専用Turnstile widget |
| Wrangler / `deploy.yml` | Worker code、Container image/config、static assets、custom domain、runtime secret、deployment |
| GitHub Actions | migration-first順序、main/CI gate、smoke test |
| Manual bootstrap | Cloudflare account/zone/plan/token、R2 bucket/credential、Neon、Google client、OpenAI limit、GitHub Environment |

Worker/ContainerをTerraformとWranglerの両方で管理しません。Application releaseとDB migrationはTerraform stateへ入れません。

## Required input sheet

初回deploy前に以下をpassword managerまたはaccess-controlled release recordへ記録します。Secret値そのものはissue、文書、Terraform variable、CLI argument、workflow logへ記録しません。

| Area | Required decision / identifier |
|---|---|
| Cloudflare | account ID、zone ID、`matoruru.com`がActive、Workers Paid plan、operator |
| Domain | `https://pdcai.matoruru.com`、同名recordの有無、domain owner |
| Container | `lite`、max instances `1`、APAC、idle sleep `10m`をStaging初期値として承認 |
| R2 state | private bucket名、bucket-scoped credential owner、復旧方針 |
| Neon | Staging専用project/branch、region、compute/scale-to-zero、restore window、connection limit |
| DB connections | application pooled URL、migration direct URL、`DB_MAX_OPEN_CONNS`、管理/migration余裕 |
| Google | Staging専用Web Client ID、authorized origin |
| Turnstile | widget site key、secret owner、hostname/action |
| OpenAI | project/key owner、model、確認日、token単価、provider spend/rate limit |
| App controls | AI monthly budget、rolling/rate limit、tester、公開期間 |
| Operations | logs/traces確認者、cost確認、teardown/継続判断日 |

## 1. Prerequisites

- Cloudflareで`matoruru.com` zoneがActiveであること。
- Cloudflare Workers Paid planを有効にすること。ContainersはPaid planが必要です。
- GitHub repositoryのdefault branchが`main`で、CIがgreenであること。
- Local bootstrapにはTerraform 1.15.8、Node.js 24、npm、Gitを使うこと。
- Cloudflare、Neon、Google、OpenAI、GitHubへ必要最小権限でaccessできること。

Repository全体の事前検査:

```powershell
pwsh ./scripts/check.ps1
```

## 2. R2 Terraform backend bootstrap

R2 bucketとS3 credentialはTerraform自身より先に必要なためmanual bootstrapです。

1. Cloudflare Dashboardでprivate R2 bucket（例: `pdcai-terraform-state`）を作る。他用途と共有しない。
2. 対象bucketだけにObject Read/WriteできるR2 API tokenを作る。account全体の管理tokenやdeploy tokenと共有しない。
3. [`backend.hcl.example`](../infra/terraform/staging/backend.hcl.example) をuntrackedの `backend.hcl` へcopyし、bucketとaccount IDを設定する。
4. Access Key ID / Secret Access Keyを現在のPowerShell processだけへ設定する。値をcommand historyへ直接貼らないため、password managerから安全に取得する。

```powershell
Copy-Item ./infra/terraform/staging/backend.hcl.example ./infra/terraform/staging/backend.hcl
$env:AWS_ACCESS_KEY_ID = '<R2 access key ID>'
$env:AWS_SECRET_ACCESS_KEY = '<R2 secret access key>'
```

Backendは`use_lockfile = true`を使います。R2はstrong consistencyとconditional writesを提供しますが、S3 Object Versioningに相当するstate履歴復旧はありません。State bucketへBucket Lockを設定するとTerraformの上書きを妨げるため設定しません。State/backend credential/plan fileはsecretとして扱い、同時applyを避けます。

## 3. TerraformでTurnstileを作成

Turnstile編集だけにscopeしたCloudflare API tokenを使い、deploy tokenとは分離します。

```powershell
Copy-Item ./infra/terraform/staging/terraform.tfvars.example ./infra/terraform/staging/terraform.tfvars
$env:CLOUDFLARE_API_TOKEN = '<Turnstile Edit scoped token>'
terraform -chdir=infra/terraform/staging init -backend-config=backend.hcl
terraform -chdir=infra/terraform/staging fmt -check
terraform -chdir=infra/terraform/staging validate
terraform -chdir=infra/terraform/staging plan -out=staging.tfplan
terraform -chdir=infra/terraform/staging apply staging.tfplan
terraform -chdir=infra/terraform/staging output -raw turnstile_sitekey
```

`terraform.tfvars`にはCloudflare account IDだけを設定します。Planでhostnameが`pdcai.matoruru.com`、modeがinvisible、destroy/replaceがないことを確認してからapplyします。

Turnstile resourceが返すsecretはstateへ含まれ得ます。このためR2 stateのaccessを厳しく制限します。Site keyはGitHub variableへ、secret keyはCloudflare DashboardからGitHub secretへ登録し、terminal/logへ出しません。

`staging.tfplan`はsecret相当です。適用後にrepository外へ安全に削除し、commitしません。

## 4. Neon PostgreSQL

1. Productionと共有しないStaging専用Neon project/branchを作る。
2. Application database/roleを作り、compute region、scale-to-zero、restore window、connection上限をinput sheetへ記録する。
3. Neon Consoleから次の2 URLを取得し、混同しない。
   - pooled URL: runtimeのGitHub secret `NEON_DATABASE_URL`
   - direct URL: migrationのGitHub secret `NEON_MIGRATION_DATABASE_URL`
4. 両URLともTLS設定を維持する。URLをTerraform、`.env.example`、issue、workflow outputへ置かない。
5. `DB_MAX_OPEN_CONNS × Container max instances`にmigration/管理接続余裕を足してNeon上限以下にする。

初回schema作成をdeveloper PCから実行しません。最初の`Deploy Staging`がmigrationを適用します。

## 5. Google Identity / Turnstile / OpenAI

Google Identity:

1. Staging専用Web application clientを作る。
2. Authorized JavaScript originsへ正確に `https://pdcai.matoruru.com` を登録する。
3. Web Client IDはGitHub variable `GOOGLE_WEB_CLIENT_ID`へ登録する。Client secretはこのGIS ID-token flowでは使用しない。

Turnstile:

- Terraform outputのsite keyをGitHub variable `TURNSTILE_SITE_KEY`へ登録する。
- Secret keyをGitHub secret `TURNSTILE_SECRET_KEY`へ登録する。
- 許可hostnameは`pdcai.matoruru.com`、expected actionは`anonymous_bootstrap`で固定する。

OpenAI:

- Staging専用keyをGitHub secret `OPENAI_API_KEY`へ登録する。
- Provider側spend/rate limitとApplication budgetを両方設定する。
- `AI_MODEL`と`AI_PRICE_MODEL`はworkflowが同じ値に揃える。Deploy日の公式token単価を確認してGitHub variablesへ設定する。

## 6. Cloudflare deploy token

GitHub Actions用tokenは対象account/zoneのWorker/Container/custom-domain deployに必要な最小権限だけを付けます。R2 state credentialやTerraform Turnstile tokenと共有しません。

GitHub `staging` Environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `NEON_DATABASE_URL`
- `NEON_MIGRATION_DATABASE_URL`
- `OPENAI_API_KEY`
- `SESSION_TOKEN_PEPPER`
- `CSRF_TOKEN_PEPPER`
- `BOOTSTRAP_ID_PEPPER`
- `RATE_LIMIT_HMAC_SECRET`
- `TURNSTILE_SECRET_KEY`

Pepper/HMACはそれぞれ別の暗号学的random値を生成し、24文字以上にします。GitHub repository-level secretではなく`staging` Environmentへ置きます。

## 7. GitHub Environment variables

GitHub Environment `staging`を作り、deployment branchを`main`だけに制限し、必要ならreviewerを設定します。次のvariablesを [`environment.md`](environment.md) とinput sheetに基づいて明示します。

```text
PUBLIC_ORIGIN=https://pdcai.matoruru.com
GOOGLE_WEB_CLIENT_ID
TURNSTILE_SITE_KEY
DB_MAX_OPEN_CONNS
DB_MAX_IDLE_CONNS
DB_CONN_MAX_LIFETIME_MINUTES
SESSION_IDLE_DAYS
SESSION_ABSOLUTE_DAYS
SESSION_ACTIVITY_TOUCH_MINUTES
ANONYMOUS_BOOTSTRAP_TTL_MINUTES
AI_MODEL
AI_MAX_INPUT_TOKENS
AI_MAX_OUTPUT_TOKENS
AI_TIMEOUT_SECONDS
AI_MAX_PROVIDER_ATTEMPTS
AI_MAX_GENERATIONS_PER_USER_24H
AI_GENERATE_PROMPT_VERSION
AI_REFINE_PROMPT_VERSION
AI_TOKENIZER_ENCODING
AI_MONTHLY_BUDGET_USD
AI_WARNING_THRESHOLDS
AI_PRICE_INPUT_USD_PER_MILLION
AI_PRICE_OUTPUT_USD_PER_MILLION
RATE_ANONYMOUS_CREATE_PER_IP_HOUR
RATE_ANONYMOUS_CREATE_PER_IP_24H
RATE_AI_PER_USER_MINUTE
RATE_AI_PER_SESSION_MINUTE
RATE_AI_PER_IP_MINUTE
```

Workflowは空値と誤った`PUBLIC_ORIGIN`をdeploy前に拒否します。Example/defaultは運用承認値ではありません。

## 8. First deployment

1. この変更を`main`へmergeし、対象commitの`CI` workflowが成功したことを確認する。
2. GitHub Actionsから`Deploy Staging`をmanual dispatchする。Workflowは`main`以外では実行しない。
3. Environment approval後、workflowは次の順で進む。

```text
successful CI / exact SHA check
-> frontend build
-> Neon direct URLでmigration
-> ephemeral secrets file作成
-> Wrangler deploy Worker + Container + assets
-> secrets file削除 (always)
-> /healthz, /readyz smoke test
```

Migrationに失敗した場合、Wrangler deployへ進みません。Wrangler deploy後のsmoke test失敗では新deploymentが存在するため、Cloudflare Workers Builds/Deployments、Logs、Container statusをすぐ確認します。

Custom domainは [`cloudflare/wrangler.jsonc`](../cloudflare/wrangler.jsonc) の`custom_domain` routeから作られ、CloudflareがDNS recordとcertificateを管理します。同名DNS recordが既にある場合は内容・利用者を確認し、不要と確認できたrecordだけをDashboardから除去して再deployします。`workers.dev`とpreview URLは無効です。

## 9. Post-deploy verification

- `https://pdcai.matoruru.com/healthz` が200。
- `https://pdcai.matoruru.com/readyz` が200。
- Browserでcertificate/mixed-content/CSP errorがない。
- Anonymous bootstrapがTurnstile hostname/action検証を通る。
- Google login/upgrade、save、AI generate/refine、account deletionを検証dataで最小回数確認する。
- Workers Logs/Tracesにsecret、PDCA本文、email、raw user ID/IP、raw Turnstile tokenがない。
- Neon connections/latency、Container cold start、5xx、AI usage/costが承認済みlimit内。
- `pdcai.matoruru.com`以外のhostnameと`workers.dev`から利用できない。

Stagingはpublic internetから到達可能です。URLの秘匿はaccess controlではありません。機密情報、Production data、失えないdataを入力しません。限定公開が必要ならCloudflare Accessを別途設計し、Google GIS/Turnstile/APIへの影響を検証してから導入します。

## 10. Rollback / recovery

Application rollback:

1. Cloudflare Dashboardで対象deployment、Container rollout、logsを確認する。
2. Schemaが旧codeと互換な場合だけ、直前の成功commitから`Deploy Staging`を再実行する。
3. Schemaに関係する場合は[`database.md`](database.md)のmigration-first/expand-contract規則に従う。DB resetや既存migration編集で復旧しない。

Terraform recovery:

- R2にはS3 Object Versioningによるstate履歴がありません。`terraform state`操作、import、backend移行は通常deployとして扱わず、対象とbackupを確認したmaintenanceとして行います。
- Lockが残った場合は実行中のapplyがないことを確認し、lock所有情報を調査してから対応します。安易なforce-unlockをしません。
- TurnstileをDashboardで手動変更した場合はdriftをplanで確認し、Source of TruthをTerraformへ戻します。

## 11. Teardown

Staging停止は通常deployとは分離します。次の順でdata/secret所有者と復旧不要を確認してから実行します。

1. GitHub `staging` Environmentを保護し、新規deployを止める。
2. Worker/Container custom domainを無効化する。
3. Neon dataが破棄可能と確認してproject/branchを削除する。
4. Turnstile widgetのTerraform destroyは`prevent_destroy`を解除するreview済み変更として行う。
5. GitHub/Cloudflare/Neon/OpenAI credentialsをrevokeする。
6. R2 state bucketは監査・復旧不要を確認するまで最後に残す。

## Production

Production infrastructureと自動deployはまだありません。`pdcai.io`確定後に、Production専用のCloudflare Worker/Container config、Neon project、Turnstile widget、Google client、R2 state、GitHub Environment、capacity/backup/alert値を設計します。Stagingのhostname、secret、DB、state、provider limitをcopyしてProduction扱いにしません。
