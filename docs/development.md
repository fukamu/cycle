# ローカル開発

この文書はローカル開発手順の Source of Truth です。アプリケーション要件・仕様・設計は [`design.md`](design.md) が上位です。環境変数の全項目は [`environment.md`](environment.md)、DB固有の運用は [`database.md`](database.md) を参照してください。

## 前提環境

- PowerShell 7（このリポジトリの補助スクリプトを使う場合）
- Node.js 24以上、npm（lock fileは `frontend/package-lock.json`）
- Go 1.26.6
- PostgreSQL 17
- sqlc 1.31.1（Backendの品質チェックとSQL生成に必要）
- Docker（PostgreSQLの簡易起動とproduction imageのbuildに使う場合）
- Chromium（E2Eを実行する場合）

CIとproduction imageはNode.js 24、Go 1.26.6、PostgreSQL 17を前提にしています。ローカルでも同じ系列を使ってください。Frontendだけを確認する場合はGo・PostgreSQL・sqlcは不要です。

## 初回セットアップ

リポジトリルートで次を実行します。

```powershell
pwsh ./scripts/setup.ps1
```

このスクリプトはNode/Goのバージョンを確認し、未作成の場合だけ `.env.example` から `.env`、`frontend/.env.example` から `frontend/.env.local` を作り、`npm ci` を実行します。既存の環境ファイルを上書きしません。依存関係を入れず環境ファイルだけ準備する場合は `-SkipInstall` を指定できます。

`.env` の4つのpepper/HMAC値は、ローカルでも24文字以上が必要です。example値をproductionで使ってはいけません。Frontendの `VITE_` 変数はブラウザへ公開されるため、秘密値を入れてはいけません。

Backendはdotenvを暗黙ロードしません。Backendを操作する各PowerShellターミナルで、次のように現在のprocessへ読み込みます。値は画面へ表示されません。

```powershell
. ./scripts/import-env.ps1
```

## PostgreSQLの準備

ローカルにPostgreSQL 17がなければ、Dockerで開発DBを起動できます。

```powershell
docker run --name pdcai-postgres -e POSTGRES_USER=pdcai -e POSTGRES_PASSWORD=pdcai -e POSTGRES_DB=pdcai -p 5432:5432 -d postgres:17-alpine
```

同名containerを以前作成して停止している場合は、再作成せず `docker start pdcai-postgres` を使います。`docker rm` やvolume削除は通常の開発手順には含めません。

Migrationを適用します。

```powershell
. ./scripts/import-env.ps1
Push-Location backend
go run ./cmd/migrate
Pop-Location
```

Migrationは再実行可能で、未適用分だけを適用します。seed処理はありません。初期データは不要で、画面から匿名sessionを作るとcycleが作成されます。

## 開発サーバー

Terminal 1でBackendを起動します。

```powershell
. ./scripts/import-env.ps1
Push-Location backend
go run ./cmd/server
```

Terminal 2でFrontendを起動します。

```powershell
Push-Location frontend
npm run dev
```

`http://localhost:5173` を開きます。Viteは `/api` を `http://localhost:8080` へproxyします。Frontend環境変数を変えたときはViteを再起動してください。

Production相当の同一origin配信をローカルで確認する場合は、FrontendをbuildしてBackendへ静的assetsを渡します。

```powershell
Push-Location frontend
npm run build
Pop-Location
. ./scripts/import-env.ps1
$env:PUBLIC_ORIGIN = 'http://localhost:8080'
$env:STATIC_DIR = (Resolve-Path ./frontend/dist)
Push-Location backend
go run ./cmd/server
```

## 品質チェック

全チェックは次の1コマンドです。Frontend依存関係とsqlc 1.31.1が事前に必要です。

```powershell
pwsh ./scripts/check.ps1
```

実行内容はFrontendのformat check、lint、typecheck、unit test、buildと、Backendのsqlc差分確認、gofmt、vet、test、server/migrate buildです。`TEST_DATABASE_URL` が未設定ならBackend integration testはskipされます。

FrontendまたはBackendだけを確認できます。

```powershell
pwsh ./scripts/check.ps1 -Scope frontend
pwsh ./scripts/check.ps1 -Scope backend
```

Backend integration testには、消去してよい専用DBだけを指定してください。テストはschema内のapplication tableをdown/up migrationで作り直します。開発DBやproduction DBを指定してはいけません。

```powershell
$env:TEST_DATABASE_URL = 'postgres://pdcai:pdcai@127.0.0.1:5432/pdcai_test?sslmode=disable'
pwsh ./scripts/check.ps1 -Scope backend
```

E2Eも同じ専用DBを使います。初回のみChromiumを導入し、`-E2E` を付けます。

```powershell
Push-Location frontend
npx playwright install chromium
Pop-Location
$env:TEST_DATABASE_URL = 'postgres://pdcai:pdcai@127.0.0.1:5432/pdcai_test?sslmode=disable'
pwsh ./scripts/check.ps1 -E2E
```

Playwright自身の既定portは55432です。このリポジトリのDocker例は5432なので、上記のように `TEST_DATABASE_URL` を明示してください。E2EではGoogle Identity、reCAPTCHA、OpenAIのtest doubleを使い、外部APIを呼びません。

CIと同じ個別コマンドが必要な場合は [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) を参照してください。

## クリーンアップ

通常のsafe cleanは再生成できるbuild/test出力と `.tmp` だけを削除します。対象を事前確認するには `-WhatIf` を使えます。

```powershell
pwsh ./scripts/clean.ps1 -WhatIf
pwsh ./scripts/clean.ps1
```

依存関係も消すfull cleanです。次回は `scripts/setup.ps1` または `npm ci` が必要です。

```powershell
pwsh ./scripts/clean.ps1 -All
```

どちらも `.env`、`frontend/.env.local`、DB、Docker container/volume、ブラウザのIndexedDB、Goのglobal cacheを削除しません。通常cleanとデータ削除は意図的に分離しています。

ローカルDocker DBの全データを捨てる場合だけ、[`database.md`](database.md) の警告を確認して専用reset scriptを使ってください。このscriptはproduction URLを受け付けず、remote Docker contextも拒否します。

```powershell
pwsh ./scripts/reset-local-db.ps1 -DatabaseName pdcai -ConfirmDatabaseName pdcai -WhatIf
pwsh ./scripts/reset-local-db.ps1 -DatabaseName pdcai -ConfirmDatabaseName pdcai
```

## 開発終了時

各serverを `Ctrl+C` で停止します。Docker DBも止める場合は `docker stop pdcai-postgres` を実行します。containerをstopしてもDBデータは保持されます。

問題が解決しない場合は [`troubleshooting.md`](troubleshooting.md) を参照してください。
