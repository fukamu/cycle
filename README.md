# PDCAI

PDCAI MVP の実装リポジトリです。確定仕様、設計判断、制約の唯一の Source of Truth は [`docs/design.md`](docs/design.md) です。この README は仕様書ではなく、開発・検証・デプロイの手順書です。

## 構成

- `frontend/`: React 19、TypeScript、Vite、React Query、React Hook Form
- `backend/`: Go HTTP API、Application/Domain、PostgreSQL adapter
- `backend/migrations/`: PostgreSQL migration
- `.github/workflows/ci.yml`: format、lint、unit/integration、E2E、build
- `.github/workflows/deploy.yml`: migration-first の Cloud Run deploy
- `Dockerfile`: Frontend と Backend を同一 origin で配信する production image

## Prerequisites

- Go 1.26.6
- Node.js 24 と npm
- PostgreSQL 17
- sqlc 1.31.1（SQL生成結果の検証・再生成時）
- Docker（image build と PostgreSQL の簡易起動時）
- Chromium（E2E。`npx playwright install chromium` で導入可能）

## Environment setup

```powershell
Copy-Item .env.example .env
Copy-Item frontend/.env.example frontend/.env.local
```

`.env` の4つのpepper/HMAC secretは、開発用であっても24文字以上にします。Productionでは十分なentropyを持つ互いに異なる値をSecret Managerから渡してください。`OPENAI_API_KEY` が空のdevelopment/testでは決定的なFake AIを使います。`RECAPTCHA_ENABLED=false` はdevelopment/test専用です。

Backendは意図的にdotenvを暗黙ロードしません。起動shellへ環境変数をexportしてください。PowerShellで単純な `KEY=VALUE` の `.env` を読み込む例です。

```powershell
Get-Content .env | Where-Object { $_ -match '^([^#][^=]*)=(.*)$' } | ForEach-Object {
  [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2], 'Process')
}
```

Frontendの公開build-time値は `frontend/.env.local` に置きます。秘密値は `VITE_` 変数へ入れないでください。

## Database setup / migration

ローカルの例では `pdcai` database/userを作り、`.env` の `DATABASE_URL` と一致させます。Dockerを使う場合は次のように起動できます。

```powershell
docker run --name pdcai-postgres -e POSTGRES_USER=pdcai -e POSTGRES_PASSWORD=pdcai -e POSTGRES_DB=pdcai -p 5432:5432 -d postgres:17-alpine
```

Migrationはadvisory lockとmigration ledgerを使い、各 `.up.sql` をtransaction内で一度だけ適用します。

```powershell
Set-Location backend
go run ./cmd/migrate
```

## Local development

Terminal 1でAPIを起動します。

```powershell
Set-Location backend
go run ./cmd/server
```

Terminal 2でFrontendを起動します。

```powershell
Set-Location frontend
npm ci
npm run dev
```

既定では `http://localhost:5173` から `/api` がBackendへproxyされます。Session cookieは設計どおり常に `Secure` です。通常のブラウザではlocalhostをsecure contextとして扱います。

Production相当の同一origin配信は、Frontendをbuildして `STATIC_DIR` を指定します。

```powershell
Set-Location frontend
npm run build
Set-Location ../backend
$env:PUBLIC_ORIGIN='http://localhost:8080'
$env:STATIC_DIR=(Resolve-Path ../frontend/dist)
go run ./cmd/server
```

Livenessは `/healthz`、DB readinessは `/readyz` です。

## Test / lint / format

Backend unit testは外部APIを呼びません。`TEST_DATABASE_URL` を設定するとPostgreSQL integration testも実行されます。テスト専用DBを指定してください。integration testはschemaを再作成します。

```powershell
Set-Location backend
$env:TEST_DATABASE_URL='postgres://pdcai:pdcai@localhost:5432/pdcai_test?sslmode=disable'
go test -count=1 ./...
go vet ./...
gofmt -l .
sqlc compile
sqlc generate
git diff --exit-code
```

Frontendの検証です。

```powershell
Set-Location frontend
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

E2Eはbuilt Frontend、Go、空にしてよいPostgreSQL test database、Chromiumを使います。Google/reCAPTCHA/OpenAIはtest doubleです。

```powershell
Set-Location frontend
npx playwright install chromium
npm run build
$env:TEST_DATABASE_URL='postgres://pdcai:pdcai@localhost:5432/pdcai_test?sslmode=disable'
npm run test:e2e
```

## Container build

```powershell
docker build -t pdcai:local .
docker run --rm --env-file .env pdcai:local /app/migrate
docker run --rm --env-file .env -p 8080:8080 pdcai:local
```

ContainerからhostのPostgreSQLへ接続する場合は、`DATABASE_URL` のhostを環境に合わせて `host.docker.internal` 等へ変更します。Imageはdistroless/non-rootで、`/app/server`、`/app/migrate`、migration、Frontend assetsだけを含みます。

## Deployment

`main` のCI成功後、Deploy workflowが次の順で実行します。

1. Artifact Registryへimmutable SHA tagのimageをpush
2. Cloud Run migration jobをdeployして完了待ち
3. migration成功時だけCloud Run serviceをdeploy
4. `/healthz` と `/readyz` をsmoke test

事前にTokyo region (`asia-northeast1`)へArtifact Registry、Cloud SQL for PostgreSQL、Secret Manager、Cloud Run service/job、reCAPTCHA Enterprise、Google OAuth clientを用意します。Runtime service accountにはCloud SQL接続、Secret参照、reCAPTCHA利用に加え、`roles/monitoring.metricWriter` と `roles/cloudtrace.agent` を最小scopeで付与します。Serviceはsmoke testとMVP利用のためpublic invocationを別途許可してください。

GitHub Environment `production` に以下を設定します。

- Secrets: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`
- Variables: `GCP_PROJECT_ID`, `GCP_RUNTIME_SERVICE_ACCOUNT`, `CLOUD_SQL_INSTANCE`, `PUBLIC_ORIGIN`, `GOOGLE_WEB_CLIENT_ID`, `RECAPTCHA_SITE_KEY`, `AI_MODEL`, `AI_PRICE_INPUT_USD_PER_MILLION`, `AI_PRICE_OUTPUT_USD_PER_MILLION`
- Secret Manager: `PDCAI_DATABASE_URL`, `PDCAI_OPENAI_API_KEY`, `PDCAI_SESSION_TOKEN_PEPPER`, `PDCAI_CSRF_TOKEN_PEPPER`, `PDCAI_BOOTSTRAP_ID_PEPPER`, `PDCAI_RATE_LIMIT_HMAC_SECRET`

`PDCAI_DATABASE_URL` はCloud RunからCloud SQLへ接続できるsupported connector/unix socket形式にします。Application Default CredentialsでOpenTelemetry metric/traceをCloud Monitoring/Cloud Traceへ送信し、JSON logはstdoutからCloud Loggingへ収集されます。本文、prompt/output、token、email、raw User ID/IPをlogやspan attributeへ加えないでください。

Production開始前に `docs/design.md` の運用未決事項を確定します。具体的にはpublic domainと各site/client key、OpenAIモデル利用可否と当日のtoken単価、provider側spend/rate limit、Cloud SQL tier/connection数、Cloud Run最大instance数、backup retention、AI budget/rate/reCAPTCHA閾値、Monitoring alert閾値です。これらはProduct Ruleの未実装ではなく、環境ごとの運用設定です。
