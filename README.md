# PDCAI

PDCAI MVPの実装リポジトリです。Cloudflare WorkerがReact/Vite SPAをedge配信し、同一originのAPIをCloudflare Container上のGoへrouteします。CycleはNeon PostgreSQLへ保存します。

アプリケーションの要件・仕様・設計に関する最上位のSource of Truthは [`docs/design.md`](docs/design.md) です。READMEは入口であり、仕様書ではありません。

## Documentation

| テーマ                    | Source of Truth                                      |
| ------------------------- | ---------------------------------------------------- |
| 要件・仕様・設計          | [`docs/design.md`](docs/design.md)                   |
| ローカル開発・test・clean | [`docs/development.md`](docs/development.md)         |
| 環境変数                  | [`docs/environment.md`](docs/environment.md)         |
| Database・Migration       | [`docs/database.md`](docs/database.md)               |
| Deployment                | [`docs/deployment.md`](docs/deployment.md)           |
| Staging / Production運用  | [`docs/operations.md`](docs/operations.md)           |
| Troubleshooting           | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Coding agent向け規則      | [`AGENTS.md`](AGENTS.md)                             |

## Repository

- `frontend/`: React 19、TypeScript、Vite、Vitest、Playwright
- `backend/`: Go API、PostgreSQL adapter、migration
- `scripts/`: PowerShellのlocal setup/check/clean/reset補助
- `cloudflare/`: Worker routing、Container、static assets、Wrangler config
- `infra/terraform/staging/`: Staging LightのTurnstile widget（R2 backend、secret payload/deployは対象外）
- `.github/workflows/ci.yml`: Frontend、Backend、Infrastructure、E2EのCI
- `.github/workflows/terraform-plan.yml`: main CI成功後のTerraform saved plan
- `.github/workflows/terraform-apply.yml`: 指定ownerがmanual承認するsaved plan apply
- `.github/workflows/deploy.yml`: Apply成功後のmigration-first Cloudflare deploy
- `Dockerfile`: Cloudflare Container用non-root Go Backend image

## Prerequisites

- PowerShell 7（補助scriptを使う場合）
- Node.js 24以上とnpm
- Go 1.26.6
- PostgreSQL 17
- sqlc 1.31.1（Backend check/SQL生成）
- Docker（local PostgreSQL/Container image buildに使う場合）
- Chromium（E2Eに必要）
- Terraform 1.15.8（Staging基盤と全体checkに必要）

詳細とversion根拠は [`docs/development.md`](docs/development.md) を参照してください。

## Quick start

```powershell
pwsh ./scripts/setup.ps1
docker run --name pdcai-postgres -e POSTGRES_USER=pdcai -e POSTGRES_PASSWORD=pdcai -e POSTGRES_DB=pdcai -p 5432:5432 -d postgres:17-alpine
. ./scripts/import-env.ps1
Push-Location backend
go run ./cmd/migrate
go run ./cmd/server
```

別terminalでFrontendを起動します。

```powershell
Push-Location frontend
npm run dev
```

`http://localhost:5173` を開きます。同名のPostgreSQL containerを以前作成済みなら、`docker run` の代わりに `docker start pdcai-postgres` を使います。既存 `.env` / `.env.local` はsetup scriptで上書きされません。

## Main commands

| 用途                                  | Command                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| 初回setup                             | `pwsh ./scripts/setup.ps1`                                                         |
| Backend環境変数を現在のterminalへ読込 | `. ./scripts/import-env.ps1`                                                       |
| 全品質check                           | `pwsh ./scripts/check.ps1`                                                         |
| Frontend / Backend / Infrastructureだけcheck | `pwsh ./scripts/check.ps1 -Scope frontend` / `-Scope backend` / `-Scope infrastructure` |
| E2Eを含むcheck                        | `pwsh ./scripts/check.ps1 -E2E`                                                    |
| Safe clean                            | `pwsh ./scripts/clean.ps1`                                                         |
| 依存関係を含むfull clean              | `pwsh ./scripts/clean.ps1 -All`                                                    |
| Local Docker DB reset                 | `pwsh ./scripts/reset-local-db.ps1 -DatabaseName pdcai -ConfirmDatabaseName pdcai` |

`TEST_DATABASE_URL`を使うBackend integration testとE2Eはtableを初期化します。消去してよい専用test DBだけを指定してください。

Safe/full cleanは環境file、DB、Docker resource、browser dataを削除しません。DB resetは全データを削除する別のHigh impact commandです。実行前に [`docs/database.md`](docs/database.md) の警告と `-WhatIf` を使用してください。Production DBをresetするcommandはありません。

## Environment

Backend local値はGit管理外の `.env`、Frontendの公開build-time値は `frontend/.env.local` に置きます。`VITE_` 変数はbrowserへ公開されるため秘密値を入れてはいけません。全変数、必須性、公開範囲、productionの設定場所は [`docs/environment.md`](docs/environment.md) を参照してください。

## CI/CD

Pull requestとmainへのpushで`CI`がformat、lint、typecheck、unit/integration test、build、E2Eを実行します。CIはjob専用PostgreSQLとtest doubleを使い、productionへ接続しません。

Staging Lightはmain HEADのCI成功後にTerraform Planを自動作成し、repository variableで指定したowner本人がPlan run IDを指定して承認した同一saved planだけをApplyします。Apply成功後、Neon direct connectionでmigrationが成功した場合だけWranglerがWorker、Container、static assets、runtime secretsを自動deployします。Production deploymentは正式domain `pdcai.io`と専用resourceが決まるまで未構築です。GitHub Environment、R2 backend、repository secret/variableを含む初回手順は [`docs/deployment.md`](docs/deployment.md) を参照してください。
