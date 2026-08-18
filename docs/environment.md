# 環境変数

この文書は環境変数の運用上の一覧です。Typed validationとdefaultは [`backend/internal/config/config.go`](../backend/internal/config/config.go)、Cloudflareへの受け渡しは [`cloudflare/src/index.ts`](../cloudflare/src/index.ts)、deploy入力は [`deploy.yml`](../.github/workflows/deploy.yml) が実装根拠です。上位仕様は [`design.md`](design.md) です。

## Environment / secret rules

Runtimeの `APP_ENV` は `development`、`test`、`production`です。Staging Lightは `APP_ENV=production` を使いますが、ProductionとDB、secret、provider credential、GitHub Environment、Terraform stateを共有しません。

- Local backendはuntracked `.env`、Viteはuntracked `frontend/.env.local`を使います。Backendが`.env`を暗黙loadする前提にせず、PowerShellでは `. ./scripts/import-env.ps1` を使います。
- `VITE_`値はbundleへ埋め込まれ、全利用者から見えます。Secretを設定しません。
- Staging runtime secretsはGitHub `staging` Environmentからdeploy時の一時`--secrets-file`経由でCloudflare Worker Secretsへ登録します。一時fileはworkflowの`always()` stepで削除します。
- Neon migration direct URLはGitHub Actionsだけが使い、Worker/Containerへ渡しません。Runtimeにはpooled URLだけを渡します。
- R2 backend credential、Terraform/Turnstile token、Cloudflare deploy tokenは用途別に分離します。
- Session/CSRF/bootstrap pepper、rate-limit HMAC、cursor署名secretは環境ごと・用途ごとに異なる24文字以上の高entropy値にします。

## Backend runtime

Stagingではdefaultを承認済み運用値とみなさず、[`deployment.md`](deployment.md) のinput sheetに従い全項目をGitHub Environmentへ明示します。

| Variable | Purpose / code default | Requirement | Exposure / Staging source |
|---|---|---|---|
| `APP_ENV` | profile、`development` | Stagingは`production`固定 | Container only、Worker code固定 |
| `PUBLIC_ORIGIN` | origin、`http://localhost:5173` | Production profileはHTTPS | server only、GitHub variable |
| `HTTP_ADDRESS` | listen、`:8080` | non-empty | Container only、Worker code固定 |
| `STATIC_DIR` | GoによるSPA配信、空 | Cloudflareでは不要 | Local/legacy container only |
| `DATABASE_URL` | PostgreSQL URL | 全環境必須 | **secret**、local `.env` / Staging `NEON_DATABASE_URL` pooled URL |
| `DB_MAX_OPEN_CONNS` | pool max、`10` | positive | server only、GitHub variable |
| `DB_MAX_IDLE_CONNS` | idle max、`5` | 0以上かつopen以下 | server only、GitHub variable |
| `DB_CONN_MAX_LIFETIME_MINUTES` | lifetime、`30` | positive | server only、GitHub variable |
| `SESSION_TOKEN_PEPPER` | session hash | 24文字以上 | **secret**、GitHub secret |
| `CSRF_TOKEN_PEPPER` | CSRF hash | 24文字以上 | **secret**、GitHub secret |
| `BOOTSTRAP_ID_PEPPER` | bootstrap hash | 24文字以上 | **secret**、GitHub secret |
| `RATE_LIMIT_HMAC_SECRET` | IP等のrate key HMAC | 24文字以上 | **secret**、GitHub secret |
| `CURSOR_SIGNING_SECRET` | Goal/Cycle cursor署名 | 24文字以上 | **secret**、GitHub secret |
| `SESSION_IDLE_DAYS` | idle TTL、`30` | positive | GitHub variable |
| `SESSION_ABSOLUTE_DAYS` | absolute TTL、`180` | idle以上 | GitHub variable |
| `SESSION_ACTIVITY_TOUCH_MINUTES` | activity更新間隔、`15` | positive | GitHub variable |
| `ANONYMOUS_BOOTSTRAP_TTL_MINUTES` | bootstrap idempotency TTL、`10` | positive | GitHub variable |
| `MAX_PROGRESSING_GOALS` | 同時進行Goal上限、MVP `1` | positive | GitHub variable |

## AI / authentication / abuse prevention

| Variable | Purpose / code default | Requirement | Exposure / Staging source |
|---|---|---|---|
| `OPENAI_API_KEY` | OpenAI auth | Production profile必須 | **secret**、GitHub secret |
| `AI_PROVIDER` | `openai` | `openai`のみ | Container code固定 |
| `AI_MODEL` | model、`gpt-5.6-luna` | quality gate通過済み、price modelと一致 | GitHub variable |
| `AI_MAX_INPUT_TOKENS` | input max、`12000` | positive | GitHub variable |
| `AI_GOAL_REFINE_MAX_OUTPUT_TOKENS` | Goal Refine output max、`400` | positive | GitHub variable |
| `AI_ACTION_MAX_OUTPUT_TOKENS` | Action AI output max、`800` | positive | GitHub variable |
| `AI_MAX_CONTEXT_CYCLES` | 同一Goalの過去Cycle候補上限、`10` | 1〜10 | GitHub variable |
| `AI_TIMEOUT_SECONDS` | timeout、`45` | positive | GitHub variable |
| `AI_MAX_PROVIDER_ATTEMPTS` | attempts、`2` | 1〜2 | GitHub variable |
| `AI_MAX_RETRY_BACKOFF_SECONDS` | logical operation内retry待機上限、`5` | 0以上 | GitHub variable |
| `AI_FINALIZATION_GRACE_SECONDS` | DB finalization余裕、`15` | positive | GitHub variable |
| `AI_LEASE_SECONDS` | running generation lease、`120` | timeout×attempts+backoff+graceより大 | GitHub variable |
| `AI_MAX_GENERATIONS_PER_USER_24H` | rolling limit、`10` | positive | GitHub variable |
| `AI_GOAL_REFINE_PROMPT_VERSION` | `goal-refine-v1` | matching prompt file必須 | GitHub variable |
| `AI_GENERATE_PROMPT_VERSION` | `action-generate-v1` | matching prompt file必須 | GitHub variable |
| `AI_REFINE_PROMPT_VERSION` | `action-refine-v1` | matching prompt file必須 | GitHub variable |
| `AI_TOKENIZER_ENCODING` | `o200k_base` | implementation対応値 | GitHub variable |
| `AI_MONTHLY_BUDGET_USD` | app budget、`100` | positive | GitHub variable |
| `AI_WARNING_THRESHOLDS` | `0.5,0.8` | 0〜1の昇順 | GitHub variable |
| `AI_PRICE_MODEL` | pricing対象model | `AI_MODEL`と一致 | Workerが`AI_MODEL`から設定 |
| `AI_PRICE_INPUT_USD_PER_MILLION` | input単価、`0` | deploy日の公式値を設定 | GitHub variable |
| `AI_PRICE_OUTPUT_USD_PER_MILLION` | output単価、`0` | deploy日の公式値を設定 | GitHub variable |
| `GOOGLE_WEB_CLIENT_ID` | GIS audience | Production profile必須 | 公開可、GitHub variable |
| `TURNSTILE_ENABLED` | Siteverify有効、`true` | Production profileはtrue | Container code固定 |
| `TURNSTILE_SECRET_KEY` | Siteverify secret | Production profile必須 | **secret**、GitHub secret |
| `TURNSTILE_EXPECTED_ACTION` | `anonymous_bootstrap` | non-empty | Container code固定 |
| `RATE_ANONYMOUS_CREATE_PER_IP_HOUR` | anon/IP/hour、`5` | positive | GitHub variable |
| `RATE_ANONYMOUS_CREATE_PER_IP_24H` | anon/IP/24h、`20` | positive | GitHub variable |
| `RATE_AI_PER_USER_MINUTE` | AI/user/min、`3` | positive | GitHub variable |
| `RATE_AI_PER_SESSION_MINUTE` | AI/session/min、`3` | positive | GitHub variable |
| `RATE_AI_PER_IP_MINUTE` | AI/IP/min、`10` | positive | GitHub variable |

## Frontend build-time

| Variable | Purpose | Exposure / source |
|---|---|---|
| `VITE_GOOGLE_WEB_CLIENT_ID` | Google Identity JS client | **public**、local `.env.local` / Staging `GOOGLE_WEB_CLIENT_ID` |
| `VITE_TURNSTILE_SITE_KEY` | Turnstile widget | **public**、local `.env.local` / Staging `TURNSTILE_SITE_KEY` |

Frontend public valueとBackendの対応値は同じGitHub Environment入力からbuild/deployします。

## Migration / test / tooling

| Variable | Purpose | Notes |
|---|---|---|
| `MIGRATIONS_DIR` | migration directory、`migrations` | GitHub Actionsで明示 |
| `NEON_MIGRATION_DATABASE_URL` | Staging direct URL | **GitHub secret**、workflowが`DATABASE_URL`へ一時mapping |
| `TEST_DATABASE_URL` | disposable integration/E2E DB | runtime/Production DBを指定禁止 |
| `PDCAI_GO_BINARY` | Playwright用Go executable | optional |
| `PDCAI_SERVER_BINARY` | prebuilt E2E server | optional、指定時は事前migration必要 |
| `CI` | Playwright behavior | CIが自動設定 |
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler account | GitHub secret（値自体はcredentialではない） |
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy auth | **GitHub secret**、deploy最小権限 |
| `AWS_ACCESS_KEY_ID` | R2 S3 backend access ID | **secret**、local operator environment / workflowが`TERRAFORM_R2_ACCESS_KEY_ID`から一時mapping |
| `AWS_SECRET_ACCESS_KEY` | R2 S3 backend secret | **secret**、local operator environment / workflowが`TERRAFORM_R2_SECRET_ACCESS_KEY`から一時mapping |

## GitHub Terraform repository inputs

Terraform PlanとApplyだけが使います。Application `staging` EnvironmentやWorker/Containerへ渡しません。

Repository secrets:

```text
TERRAFORM_CLOUDFLARE_API_TOKEN
TERRAFORM_R2_ACCESS_KEY_ID
TERRAFORM_R2_SECRET_ACCESS_KEY
```

- `TERRAFORM_CLOUDFLARE_API_TOKEN`: 対象accountのTurnstile Editだけにscopeする。
- `TERRAFORM_R2_ACCESS_KEY_ID` / `TERRAFORM_R2_SECRET_ACCESS_KEY`: state bucketだけのObject Read/Write credential。PlanのlockfileとApplyのstate更新に必要。

Repository variables:

```text
TERRAFORM_CLOUDFLARE_ACCOUNT_ID
TERRAFORM_R2_STATE_BUCKET
TERRAFORM_APPLY_APPROVER
```

- `TERRAFORM_CLOUDFLARE_ACCOUNT_ID`: 32文字lowercase hexadecimal account ID。credentialではない。
- `TERRAFORM_R2_STATE_BUCKET`: manual bootstrap済みの専用private bucket名。credentialではない。
- `TERRAFORM_APPLY_APPROVER`: Plan review後に`Terraform Apply Staging`をmanual dispatchできる唯一のGitHub user login。大文字小文字を無視してworkflow actorと照合する。

GitHub Environment `staging-terraform-apply`はsecret/variableの保管場所ではありません。全planでowner限定manual dispatchを必須gateとし、Required reviewersを利用できるplanでは同じuserによる追加approval gateとしてEnvironmentを設定します。Workflow preflightはactorと`TERRAFORM_APPLY_APPROVER`を照合し、不一致・未設定ではApplyしません。

## GitHub `staging` Environment

Exact required listは [`deploy.yml`](../.github/workflows/deploy.yml) の`Validate required deployment inputs`がenforceします。

Secrets:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
NEON_DATABASE_URL
NEON_MIGRATION_DATABASE_URL
OPENAI_API_KEY
SESSION_TOKEN_PEPPER
CSRF_TOKEN_PEPPER
BOOTSTRAP_ID_PEPPER
RATE_LIMIT_HMAC_SECRET
CURSOR_SIGNING_SECRET
TURNSTILE_SECRET_KEY
```

Variables:

```text
PUBLIC_ORIGIN
GOOGLE_WEB_CLIENT_ID
TURNSTILE_SITE_KEY
DB_MAX_OPEN_CONNS
DB_MAX_IDLE_CONNS
DB_CONN_MAX_LIFETIME_MINUTES
SESSION_IDLE_DAYS
SESSION_ABSOLUTE_DAYS
SESSION_ACTIVITY_TOUCH_MINUTES
ANONYMOUS_BOOTSTRAP_TTL_MINUTES
MAX_PROGRESSING_GOALS
AI_MODEL
AI_MAX_INPUT_TOKENS
AI_GOAL_REFINE_MAX_OUTPUT_TOKENS
AI_ACTION_MAX_OUTPUT_TOKENS
AI_MAX_CONTEXT_CYCLES
AI_TIMEOUT_SECONDS
AI_MAX_PROVIDER_ATTEMPTS
AI_MAX_RETRY_BACKOFF_SECONDS
AI_FINALIZATION_GRACE_SECONDS
AI_LEASE_SECONDS
AI_MAX_GENERATIONS_PER_USER_24H
AI_GOAL_REFINE_PROMPT_VERSION
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

Production Environmentは未構築です。正式domain決定後に別値・別resourceとして追加します。
