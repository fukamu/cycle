# ローカル開発

この文書はローカル開発手順の Source of Truth です。アプリケーション要件・仕様・設計は [`design.md`](design.md) が上位です。環境変数の全項目は [`environment.md`](environment.md)、DB固有の運用は [`database.md`](database.md) を参照してください。

## 前提環境

- Bash 5.0以上とGNU userland（Ubuntu 20.04/24.04、WSL2）
- Node.js 24以上、pnpm 11.22.0（lock fileはrootの `pnpm-lock.yaml`）
- Go 1.26.6
- PostgreSQL 18.6（Dockerは`postgres:18.6-alpine3.24`）
- sqlc 1.31.1、またはDocker（Backendの品質チェックとSQL生成に必要。Go 1.26.6によるfallbackも利用可能）
- Docker（PostgreSQLの簡易起動とCloudflare Container imageのbuildに使う場合）
- Chromium（E2Eを実行する場合）
- Terraform 1.15.8（Staging/全体checkとCloudflare Turnstile基盤変更に必要）
- `curl`、`openssl`、`realpath`、`sha256sum`、`base64`、`sed`、`awk`、`find`、`sort`、`mktemp`

CIとContainer imageはNode.js 24、pnpm 11.22.0、Go 1.26.6、PostgreSQL 18.6を前提にし、Docker PostgreSQLは`postgres:18.6-alpine3.24`へ固定しています。Staging基盤はTerraform 1.15.8とCloudflare provider 5.22.0、Wrangler 4.123.0をpinしています。ローカルでも同じversionを使ってください。Frontendだけを確認する場合はGo・PostgreSQL・sqlc・Terraformは不要です。

sqlcはRepository標準のラッパーで実行します。ラッパーはsqlc 1.31.1がHostにあればそれを使い、なければ`sqlc/sqlc:1.31.1`を`docker run --rm`で起動します。Docker serverも利用できない場合は、Goでpin済みの一時toolを`.tmp/tools`へbuildしてfallbackします。これによりsqlcをHostへ常設する必要はありません。Docker/Goはいずれも初回だけimageまたはmoduleのdownloadが必要で、一時toolは通常のsafe clean対象です。

```bash
./scripts/invoke-sqlc.sh compile generate
```

特定の実行方法を検証する場合は`--runner host`、`--runner docker`、`--runner go`を指定できます。Docker実行では`backend/`だけを書き込み可能でmountし、containerは実行後に削除します。Host user IDを渡し、生成物がroot所有になることを防ぎます。

## Dockerによるローカル実機確認

Docker Desktop、Bash 5、curlだけで、Frontend、Backend、Migration、PostgreSQLを隔離環境へbuildし、ブラウザから操作できます。Repositoryの`.env`、`frontend/.env.local`、`node_modules`、`frontend/dist`、`.tmp`、既存の`pdcai-postgres`は使用・変更しません。

```bash
./scripts/local-app.sh
```

ready確認後に`http://localhost:8080`を開きます。Enterで終了すると、`pdcai-local` Compose projectのcontainer、network、破棄可能DBだけを削除します。DBはtmpfsで永続化されず、Hostへport公開されません。Applicationは`127.0.0.1:8080`だけへ公開されます。Docker imageとBuildKit cacheは次回の高速化のため保持し、他projectを含むglobal pruneは実行しません。

別portを使う場合は`--port`を指定します。

```bash
./scripts/local-app.sh --port 8081
```

Terminalを解放したまま起動する場合は`--detached`を使い、終了時に専用の`--down`を実行します。Terminalの強制終了等で自動cleanupされなかった場合も同じ`--down`を使用します。

```bash
./scripts/local-app.sh --detached
./scripts/local-app.sh --down
```

このprofileは`APP_ENV=development`、空の`OPENAI_API_KEY`、無効なTurnstile、未設定のGoogle Client IDで起動します。AIは決定的なFake Adapterを使用し、Google連携以外のGoal/Cycle/Review操作を外部credentialなしで確認できます。これは手動の実機確認環境であり、format、lint、typecheck、unit/integration test、E2E、Terraform、Wranglerの品質checkを代替しません。

## 初回セットアップ

リポジトリルートで次を実行します。

```bash
./scripts/setup.sh
```

このスクリプトはNode/pnpm/Goのバージョンを確認し、未作成の場合だけ `.env.example` から `.env`、`frontend/.env.example` から `frontend/.env.local` を作り、rootで`pnpm install --frozen-lockfile`とBackendの`go mod download`を実行します。既存の環境ファイルを上書きしません。依存関係を入れず環境ファイルだけ準備する場合は `--skip-install` を指定できます。

`.env` のSession/CSRF/bootstrap pepper、rate-limit HMAC、cursor署名secretは、ローカルでも24文字以上が必要です。example値をproductionで使ってはいけません。Frontendの `VITE_` 変数はブラウザへ公開されるため、秘密値を入れてはいけません。

Backendはdotenvを暗黙ロードしません。Backendを操作する各Bash terminalで、次のように現在のshellへ読み込みます。値は画面へ表示されません。このscriptをsubprocessとして実行しても親shellへ反映されないため、必ず`source`してください。

```bash
source ./scripts/import-env.sh
```

## PostgreSQLの準備

ローカルにPostgreSQL 18.6がなければ、Dockerで開発DBを起動できます。

```bash
docker run --name pdcai-postgres -e POSTGRES_USER=pdcai -e POSTGRES_PASSWORD=pdcai -e POSTGRES_DB=pdcai -p 5432:5432 -d postgres:18.6-alpine3.24
```

同名containerを以前作成して停止している場合は、`docker inspect --format '{{.Config.Image}}' pdcai-postgres`でimageが正確に`postgres:18.6-alpine3.24`であることを確認してから`docker start pdcai-postgres`を使います。異なるimageのcontainerは再利用せず、保持dataの要否を確認してから別途処分してください。`docker rm`やvolume削除は通常の開発手順には含めません。

PostgreSQL 18以降の公式Docker imageは`PGDATA=/var/lib/postgresql/18/docker`を使い、volume mount先が`/var/lib/postgresql`へ変わりました。`compose.local.yaml`の破棄可能DBも親directoryへtmpfsをmountします。17以前の`/var/lib/postgresql/data`を新規設定へ流用しません。

Migrationを適用します。

```bash
source ./scripts/import-env.sh
cd backend
go run ./cmd/migrate
```

Migrationは再実行可能で、未適用分だけを適用します。seed処理はありません。画面を開くと匿名sessionだけが作成され、HomeからGoal Creation Draftを作って開始した時点でGoal v1とCycle 1が同一transactionで作成されます。

## 開発サーバー

Terminal 1でBackendを起動します。

```bash
source ./scripts/import-env.sh
cd backend
go run ./cmd/server
```

Terminal 2でFrontendを起動します。

```bash
pnpm --filter pdcai-frontend run dev
```

`http://localhost:5173` を開きます。Viteは `/api` を `http://localhost:8080` へproxyします。Frontend環境変数を変えたときはViteを再起動してください。

Go Backend単体の同一origin配信fallbackをローカルで確認する場合は、FrontendをbuildしてBackendへ静的assetsを渡します。Cloudflare StagingではWorkerがstatic assetsを配信します。

```bash
pnpm --filter pdcai-frontend run build
source ./scripts/import-env.sh
export PUBLIC_ORIGIN='http://localhost:8080'
export STATIC_DIR="$(realpath ./frontend/dist)"
cd backend
go run ./cmd/server
```

## 品質チェック

全チェックは次の1コマンドです。Frontend依存関係に加え、Backend checkにはHostのsqlc 1.31.1、Docker、Goのいずれかが必要です。

```bash
./scripts/check.sh
```

実行内容はFrontendのformat check、lint、typecheck、unit test、build、Backendのsqlc差分確認、gofmt、vet、test、server/migrate build、Bash syntax/ShellCheck 0.11.0/shfmt 3.13.1/script test、Dockerローカル実機Composeの構文確認、Terraformのformat/init/validate、Wrangler config/typecheck/dry-runです。`TEST_DATABASE_URL` が未設定ならBackend integration testはskipされます。Terraform validateは`.tmp/terraform-check`の専用`TF_DATA_DIR`とcredential不要の`backend=false` initializationを使い、localで初期化済みのR2 backend設定を再利用しません。

Frontend、Backend、Infrastructureだけを確認できます。

```bash
./scripts/check.sh --scope frontend
./scripts/check.sh --scope backend
./scripts/check.sh --scope infrastructure
```

Backend integration testには、消去してよい専用DBだけを指定してください。テストはschema内のapplication tableをdown/up migrationで作り直します。開発DBやproduction DBを指定してはいけません。

```bash
export TEST_DATABASE_URL='postgres://pdcai:pdcai@127.0.0.1:5432/pdcai_test?sslmode=disable'
./scripts/check.sh --scope backend
```

E2Eも同じ専用DBを使います。初回のみChromiumを導入し、`--e2e` を付けます。Check scriptはbuild済みのmigration/server binaryを使って事前migrationとPlaywright server起動を行い、終了時に子processを確実に停止します。

```bash
pnpm --filter pdcai-frontend exec playwright install chromium
export TEST_DATABASE_URL='postgres://pdcai:pdcai@127.0.0.1:5432/pdcai_test?sslmode=disable'
./scripts/check.sh --e2e
```

Playwright自身の既定portは55432です。このリポジトリのDocker例は5432なので、上記のように `TEST_DATABASE_URL` を明示してください。E2EではGoogle Identity、Turnstile、OpenAIのtest doubleを使い、外部APIを呼びません。

CIと同じ個別コマンドが必要な場合は [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) を参照してください。

### 性能変更の確認

DB-backed collection endpointは、page内のitem数に比例してSQL round tripが増えないよう、JOINまたはbatch queryで必要なsummaryを取得します。Home、Goal一覧、Cycle一覧を変更するときは、itemごとのdetail query（N+1 query）を追加してはいけません。

Frontendのroute別code splittingとasset sizeは`pnpm --filter pdcai-frontend run build`のchunk一覧で確認します。Mutation responseが遷移先と同じDTOを含む場合は、TanStack Query cacheへ反映してから遷移し、直後に同じresourceを再取得するnetwork round tripを避けます。Mutationの影響を受けるcollection/detail cacheは、引き続き明示的に更新またはinvalidateします。Auto SaveやAI提案Adoptも同じserver mutationとして扱い、成功responseをeditor local stateだけに反映しません。未保存入力はeditor/Browser Draft Cache、保存済みstateはTanStack Queryへ同期し、route往復の回帰testで古いfresh cacheが復元されないことを確認します。

### GitHub Actionsの更新

Workflowで利用する公式Actionは、特別な互換性制約がない限り、Node.js runtimeとsecurity fixを含む最新のstable majorを使います。更新時は各Actionの公式release noteでbreaking changeとGitHub-hosted runnerの要件を確認し、`.github/workflows/ci.yml`のactionlintを通します。Stable majorを据え置く必要がある場合は、理由と解除条件を該当Workflowへcommentで記録します。

Pull request CIはGitHubのmerge refをcheckoutして全checkを実行し、成功時に検証済みtree SHA、PR番号、head SHAを30日保持のartifact名へ記録します。mainの`CI` workflowは、マージ後commitに対応するPR、成功した同一head SHAのPR CI、未期限切れartifact、検証済みtreeとmain treeの完全一致をGitHub APIで確認できた場合だけ重いjobをskipします。判定job自体がmain SHAの成功CIとなるため、Terraform PlanとDeployの同一SHA gateは維持されます。

直接push、複数・不明な関連PR、base更新後にPR CIを再実行せずmergeした場合、API障害、artifact欠落・期限切れ、tree不一致では再利用せず、mainで全CIを実行します。高速化のためにこのfail-safe fallbackやtree完全一致を緩和してはいけません。

## クリーンアップ

通常のsafe cleanは再生成できるbuild/test出力と `.tmp` だけを削除します。対象を事前確認するには `--dry-run` を使えます。

```bash
./scripts/clean.sh --dry-run
./scripts/clean.sh
```

依存関係も消すfull cleanです。次回は `scripts/setup.sh` または `pnpm install --frozen-lockfile` が必要です。

```bash
./scripts/clean.sh --all
```

どちらも `.env`、`frontend/.env.local`、DB、Docker container/volume、ブラウザのIndexedDB、Goのglobal cacheを削除しません。通常cleanとデータ削除は意図的に分離しています。

ローカルDocker DBの全データを捨てる場合だけ、[`database.md`](database.md) の警告を確認して専用reset scriptを使ってください。このscriptはproduction URLを受け付けず、remote Docker contextも拒否します。

```bash
./scripts/reset-local-db.sh --database-name pdcai --confirm-database-name pdcai --dry-run
./scripts/reset-local-db.sh --database-name pdcai --confirm-database-name pdcai --yes
```

## 開発終了時

各serverを `Ctrl+C` で停止します。Docker DBも止める場合は `docker stop pdcai-postgres` を実行します。containerをstopしてもDBデータは保持されます。

問題が解決しない場合は [`troubleshooting.md`](troubleshooting.md) を参照してください。
