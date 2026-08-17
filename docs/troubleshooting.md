# Troubleshooting

まず秘密値を貼らずに、実行command、exit code、対象環境、直前変更、errorの `error_class` / `error_code` を記録します。仕様判断が必要な場合は [`design.md`](design.md)、手順は [`development.md`](development.md)、productionは [`operations.md`](operations.md) を参照してください。

## Setup / dependency install

| 症状                                  | 原因候補                              | 確認方法                                      | 解決方法                                                                           |
| ------------------------------------- | ------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Required command 'go' was not found` | HostにGoがない、PATH未反映            | `Get-Command go`; `go env GOVERSION`          | Go 1.26.6をinstallしterminalを開き直す。標準のsetup/check/E2Eはhost Goを前提とする |
| `setup.ps1` がGo versionで停止        | CI/imageと異なるGo                    | `go env GOVERSION`                            | 1.26.6へ合わせる。実行前に停止するので既存env fileは上書きされない                 |
| `npm ci`失敗                          | Node不一致、lock不整合、network/cache | `node --version`; `npm --version`; npm error  | Node 24以上へ合わせる。lockを手編集せず、必要なら`clean.ps1 -All`後に再実行        |
| 同名Docker container error            | `pdcai-postgres`が既に存在            | `docker ps -a --filter name=pdcai-postgres`   | 停止中なら`docker start pdcai-postgres`。保持dataを確認せずremoveしない            |
| PowerShell scriptを実行できない       | PowerShell 7未導入、execution policy  | `pwsh --version`; `Get-ExecutionPolicy -List` | PowerShell 7を導入し、組織policyに従う。policyを無断で緩和しない                   |

## Development server / build

| 症状                                   | 原因候補                                        | 確認方法                                                           | 解決方法                                                                     |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Backendが`invalid configuration`で終了 | `.env`未読込、必須secretが短い/空、値format不正 | error messageの変数名; `Get-ChildItem Env:APP_ENV`                 | Backend terminalで`. ./scripts/import-env.ps1`。`.env.example`を基に値を修正 |
| Port 8080/5173が使用中                 | 以前のserverが残っている                        | `Get-NetTCPConnection -LocalPort 8080,5173`                        | 所有processを確認して停止。無関係なprocessをkillしない                       |
| FrontendからAPI 404/connection refused | Backend未起動、Vite以外のorigin、proxy不一致    | Browser Network; `Invoke-RestMethod http://localhost:8080/healthz` | Backendを起動し、開発時は`http://localhost:5173`を使う                       |
| Production相当buildで画面404           | `STATIC_DIR`不正、`dist`未build                 | `Test-Path frontend/dist/index.html`; Backend startup env          | `npm run build`後にabsolute `STATIC_DIR`を設定                               |
| Frontend build/typecheck失敗           | TypeScript error、stale dependency              | `pwsh ./scripts/check.ps1 -Scope frontend`                         | 最初のerrorを修正。必要なら`clean.ps1 -All`→`setup.ps1`                      |
| format/lintだけ失敗                    | Prettier/ESLint規則違反                         | `npm run format:check`; `npm run lint`                             | `npm run format`後に差分をreviewし、lint errorを修正                         |

## Database / Migration

| 症状                               | 原因候補                                           | 確認方法                                                  | 解決方法                                                                                     |
| ---------------------------------- | -------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| DB connection refused              | PostgreSQL停止、port/URL不一致                     | `docker ps`; `docker port pdcai-postgres 5432`; `/readyz` | containerをstartし、`.env`のhost/port/dbを合わせる                                           |
| password authentication failed     | user/password不一致                                | Container作成時envと`.env`のuser名を値を露出せず比較      | Local DBなら正しいcredentialへ修正。production secretをlocalへcopyしない                     |
| database does not exist            | `pdcai`/`pdcai_test`未作成                         | `docker exec pdcai-postgres psql -U pdcai -l`             | local専用DBを`createdb`。testには`pdcai_test`のみ指定                                        |
| Migration fileが見つからない       | Working directoryまたは`MIGRATIONS_DIR`不正        | `Get-Location`; `Get-ChildItem backend/migrations`        | `backend`で実行するか正しいdirectoryを設定                                                   |
| Migrationがdirty/error             | SQL途中失敗、既存schema不整合                      | Migration job/log、`schema_migrations`をread-only確認     | productionでforce/down/resetしない。原因とbackupを確認し、新migrationまたは個別runbookで復旧 |
| Integration testで開発dataが消えた | `TEST_DATABASE_URL`に開発DBを指定                  | shell historyのhost/db名だけを確認                        | Test専用DBを作る。credentialをhistory/issueへ貼らない。失われたdataはbackupから復元          |
| DB reset scriptが拒否              | remote context、名前不一致、image/version/Go不一致 | 表示されたguard error; `-WhatIf`                          | 安全条件を満たすlocal Dockerだけで実行。guardを削除しない                                    |

## Test / E2E

| 症状                                       | 原因候補                                  | 確認方法                                    | 解決方法                                                                            |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Go integration testがskip                  | `TEST_DATABASE_URL`未設定                 | Test output; `$env:TEST_DATABASE_URL`       | 消去可能な`pdcai_test`を設定。開発/production DBは禁止                              |
| E2EがDBへ接続できない                      | Playwright defaultは55432、Docker例は5432 | `docker port`; Playwright error             | `TEST_DATABASE_URL`を明示する                                                       |
| E2EがGo executableを起動できない           | Host Goなし、`PDCAI_GO_BINARY`不正        | `Get-Command go`; env var                   | Go 1.26.6をinstall。binary指定時は実在pathを使う                                    |
| `PDCAI_SERVER_BINARY`指定時にreadiness失敗 | Playwrightがmigration commandを省略する   | `frontend/playwright.config.ts`; DB version | Test DBへmigrationを事前適用してから再実行                                          |
| Chromiumがない                             | Playwright browser未install               | Errorのbrowser executable path              | `Push-Location frontend; npx playwright install chromium; Pop-Location`             |
| CIだけflaky                                | timing、CI resource、shared state         | Playwright trace/screenshot、job log        | Testを並列化せず現状workers=1を維持し、traceから根因を修正。retry増加だけで隠さない |

## Authentication / reCAPTCHA / AI

| 症状                       | 原因候補                                             | 確認方法                                              | 解決方法                                                                     |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Google buttonが出ない/失敗 | VITE client ID空、server IDとの不一致、origin未登録  | Browser console/network、公開IDの一致                 | `.env.local`とserver設定を同じclient IDへ。Productionはimage再build          |
| Login後もsessionがない     | cookie/origin/HTTPS、token verification error        | Network response、cookie属性、server error code       | `PUBLIC_ORIGIN`と実originを一致。ProductionはHTTPS必須                       |
| Anonymous session作成失敗  | reCAPTCHA key/project/action/権限不一致              | Browser network、server error、Cloud reCAPTCHA設定    | client/server site keyとdomain/actionを合わせる。Productionで無効化しない    |
| Local AIが実APIを呼ばない  | `OPENAI_API_KEY`空のdevelopment/testは仕様どおりFake | APP_ENVとkeyの有無（値は表示しない）                  | 実APIが必要な明示的検証だけlocal secretをprocessへ設定。通常testはFakeを使う |
| Production AI失敗          | Key、model、quota/spend/rate limit、provider障害     | AI error metrics/log、provider status/dashboard       | 設定とprovider制限を確認。Fakeへ切替えず、非AI機能と切り分ける               |
| AI costが0/不正            | price vars未設定/旧単価、model不一致                 | Deploy variables、`AI_MODEL`/`AI_PRICE_MODEL`、確認日 | 当日の正式単価をreviewして新revisionをdeploy。推測値を入れない               |

## CI / Deploy / Production

| 症状                              | 原因候補                                                              | 確認方法                                        | 解決方法                                                                           |
| --------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Deployが開始しない                | main以外、CI未成功、workflow disabled                                 | ActionsのCI conclusion、branch、Deploy workflow | mainの同一SHAでCIを成功させる。PRから手動production deployしない                   |
| Variable validationで停止         | Production Environment variable未設定                                 | errorに出た変数名                               | [`deployment.md`](deployment.md) release gateで値を決めて設定。仮値禁止            |
| Migration stepで停止              | Cloud SQL/secret/SA/SQL error                                         | `pdcai-migrate` execution log                   | Serviceは未deploy。DB runbookに従い原因解消、force/resetしない                     |
| `/healthz` 200、`/readyz` 503     | ProcessはaliveだがDB unavailable                                      | Cloud SQL state、connection、service attachment | DB接続・pool・secretを修正。OpenAI/Google疎通はreadiness対象外                     |
| Previewでは動くがProductionで失敗 | 正式Previewは存在しない。local/testとの差、HTTPS/real provider/config | APP_ENV、revision env、build args、provider設定 | Production release gateと環境表を照合。Previewという未定義環境を追加して回避しない |
| Deploy後に5xx増加                 | 新revision/config/schema incompatibility                              | revision別log/metrics、直前SHA                  | 旧revisionとschema互換ならtraffic rollback。互換でなければroll-forward             |
| Telemetry startup error           | Runtime SA権限/API/quota                                              | `telemetry_startup_failed`、Cloud API           | Monitoring/Traceの最小権限/APIを修正。無断で観測を無効化しない                     |

Production障害では秘密値やuser本文を共有せず、[`operations.md`](operations.md) のincident手順へ移行してください。
