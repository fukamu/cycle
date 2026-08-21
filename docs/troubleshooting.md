# Troubleshooting

まず秘密値を貼らずに、実行command、exit code、対象環境、直前変更、errorの `error_class` / `error_code` を記録します。仕様判断が必要な場合は [`design.md`](design.md)、手順は [`development.md`](development.md)、productionは [`operations.md`](operations.md) を参照してください。

## Setup / dependency install

| 症状                                  | 原因候補                                  | 確認方法                                        | 解決方法                                                                             |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Required command 'go' was not found` | HostにGoがない、PATH未反映                | `command -v go`; `go env GOVERSION`             | Go 1.26.6をinstallしterminalを開き直す。標準のsetup/check/E2Eはhost Goを前提とする   |
| `setup.sh` がGo versionで停止         | CI/imageと異なるGo                        | `go env GOVERSION`                              | 1.26.6へ合わせる。実行前に停止するので既存env fileは上書きされない                  |
| `pnpm install`失敗                    | Node/pnpm不一致、lock不整合、network/cache | `node --version`; `pnpm --version`; pnpm error | Node 24以上・pnpm 11.22.0へ合わせる。lockを手編集せず、必要なら`clean.sh --all`後に再実行 |
| 同名Docker container error            | `pdcai-postgres`が既に存在                | `docker ps -a --filter name=pdcai-postgres`     | 停止中なら`docker start pdcai-postgres`。保持dataを確認せずremoveしない              |
| Bash scriptがversion不足で停止        | Bash 5.0未満またはBash以外で実行          | `bash --version`; `command -v bash`             | Bash 5.0以上で実行する。Ubuntu 20.04/24.04またはWSL2を標準環境とする                 |
| Docker実機環境がremote contextを拒否  | 現在のDocker contextがremote host         | `docker context inspect`                        | Docker Desktopのlocal contextへ明示的に戻す。安全guardを削除しない                  |

## Development server / build

| 症状                                   | 原因候補                                        | 確認方法                                                           | 解決方法                                                                     |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Backendが`invalid configuration`で終了 | `.env`未読込、必須secretが短い/空、値format不正 | error messageの変数名; `[[ -n ${APP_ENV:-} ]]`                     | Backend terminalで`source ./scripts/import-env.sh`。`.env.example`を基に値を修正 |
| Port 8080/5173が使用中                 | 以前のserverが残っている                        | `ss --tcp --listening --numeric --process`                          | 所有processを確認して停止。無関係なprocessをkillしない                       |
| FrontendからAPI 404/connection refused | Backend未起動、Vite以外のorigin、proxy不一致    | Browser Network; `curl --fail http://localhost:8080/healthz`        | Backendを起動し、開発時は`http://localhost:5173`を使う                       |
| Production相当buildで画面404           | `STATIC_DIR`不正、`dist`未build                 | `test -f frontend/dist/index.html`; Backend startup env             | `pnpm --filter pdcai-frontend run build`後にabsolute `STATIC_DIR`を設定       |
| Frontend build/typecheck失敗           | TypeScript error、stale dependency              | `./scripts/check.sh --scope frontend`                               | 最初のerrorを修正。必要なら`clean.sh --all`→`setup.sh`                       |
| format/lintだけ失敗                    | Prettier/ESLint規則違反                         | `pnpm --filter pdcai-frontend run format:check`; `pnpm --filter pdcai-frontend run lint` | `pnpm --filter pdcai-frontend run format`後に差分をreviewし、lint errorを修正 |
| Docker実機環境がreadyにならない        | Port競合、image build、Migration、DB起動の失敗  | `docker compose --file compose.local.yaml logs`                    | 最初のerrorを修正し、`./scripts/local-app.sh --down`後に再実行               |

## Database / Migration

| 症状                               | 原因候補                                           | 確認方法                                                  | 解決方法                                                                                     |
| ---------------------------------- | -------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| DB connection refused              | PostgreSQL停止、port/URL不一致                     | `docker ps`; `docker port pdcai-postgres 5432`; `/readyz` | containerをstartし、`.env`のhost/port/dbを合わせる                                           |
| password authentication failed     | user/password不一致                                | Container作成時envと`.env`のuser名を値を露出せず比較      | Local DBなら正しいcredentialへ修正。production secretをlocalへcopyしない                     |
| database does not exist            | `pdcai`/`pdcai_test`未作成                         | `docker exec pdcai-postgres psql -U pdcai -l`             | local専用DBを`createdb`。testには`pdcai_test`のみ指定                                        |
| Migration fileが見つからない       | Working directoryまたは`MIGRATIONS_DIR`不正        | `pwd`; `find backend/migrations -maxdepth 1 -type f`       | `backend`で実行するか正しいdirectoryを設定                                                   |
| Migrationがdirty/error             | SQL途中失敗、既存schema不整合                      | Migration job/log、`schema_migrations`をread-only確認     | productionでforce/down/resetしない。原因とbackupを確認し、新migrationまたは個別runbookで復旧 |
| Integration testで開発dataが消えた | `TEST_DATABASE_URL`に開発DBを指定                  | shell historyのhost/db名だけを確認                        | Test専用DBを作る。credentialをhistory/issueへ貼らない。失われたdataはbackupから復元          |
| DB reset scriptが拒否              | remote context、名前不一致、image/version/Go不一致 | 表示されたguard error; `--dry-run`                        | 安全条件を満たすlocal Dockerだけで実行。guardを削除しない                                    |

## Test / E2E

| 症状                                       | 原因候補                                  | 確認方法                                    | 解決方法                                                                            |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Go integration testがskip                  | `TEST_DATABASE_URL`未設定                 | Test output; `[[ -n ${TEST_DATABASE_URL:-} ]]` | 消去可能な`pdcai_test`を設定。開発/production DBは禁止                            |
| E2EがDBへ接続できない                      | Playwright defaultは55432、Docker例は5432 | `docker port`; Playwright error             | `TEST_DATABASE_URL`を明示する                                                       |
| E2EがGo executableを起動できない           | Host Goなし、`PDCAI_GO_BINARY`不正        | `command -v go`; env var                    | Go 1.26.6をinstall。binary指定時は実在pathを使う                                    |
| `PDCAI_SERVER_BINARY`指定時にreadiness失敗 | Playwrightがmigration commandを省略する   | `frontend/playwright.config.ts`; DB version | Test DBへmigrationを事前適用してから再実行                                          |
| Chromiumがない                             | Playwright browser未install               | Errorのbrowser executable path              | `pnpm --filter pdcai-frontend exec playwright install chromium`                     |
| CIだけflaky                                | timing、CI resource、shared state         | Playwright trace/screenshot、job log        | Testを並列化せず現状workers=1を維持し、traceから根因を修正。retry増加だけで隠さない |

## Authentication / Turnstile / AI

| 症状                       | 原因候補                                             | 確認方法                                              | 解決方法                                                                     |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Google buttonが出ない/失敗 | VITE client ID空、server IDとの不一致、origin未登録  | Browser console/network、公開IDの一致                 | `.env.local`とserver設定を同じclient IDへ。Productionはimage再build          |
| Login後もsessionがない     | cookie/origin/HTTPS、token verification error        | Network response、cookie属性、server error code       | `PUBLIC_ORIGIN`と実originを一致。ProductionはHTTPS必須                       |
| Anonymous session作成失敗  | Turnstile site/secret key、hostname/action不一致、token期限切れ/replay | Browser network、server error、Turnstile widget設定 | Site/secret keyとhostname/actionを合わせる。Tokenは再取得し、Productionで無効化しない |
| Local AIが実APIを呼ばない  | `OPENAI_API_KEY`空のdevelopment/testは仕様どおりFake | APP_ENVとkeyの有無（値は表示しない）                  | 実APIが必要な明示的検証だけlocal secretをprocessへ設定。通常testはFakeを使う |
| Production AI失敗          | Key、model、quota/spend/rate limit、provider障害     | AI error metrics/log、provider status/dashboard       | 設定とprovider制限を確認。Fakeへ切替えず、非AI機能と切り分ける               |
| AI costが0/不正            | price vars未設定/旧単価、model不一致                 | Deploy variables、`AI_MODEL`/`AI_PRICING_MODEL`、確認日 | 当日の正式単価をreviewして新revisionをdeploy。推測値を入れない               |

## CI / Cloudflare Deploy / Production

| 症状                              | 原因候補                                                              | 確認方法                                        | 解決方法                                                                           |
| --------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Terraform Planが開始しない        | main以外、同一SHAのCI未成功、workflow disabled | ActionsのCI/Plan conclusion、branch | mainの同一SHAでCIを成功させる。PR CI再利用を証明できない場合はmain全CIの完了を待つ。必要ならmainからPlanをmanual dispatchする |
| Terraform Apply preflightで停止   | actor/approver不一致、誤ったPlan run ID、artifact期限切れ、mainが進んだ | repository variable、Plan run、errorのSHA | 指定owner本人が成功Planのrun IDを入力する。stale/expiredなら最新mainでPlanを再作成し、approvalを迂回しない |
| Terraform Applyがapproval待ち     | optional Required reviewer gateが有効 | Apply runの`Review deployments` | Plan logを確認し、指定ownerがApprove/Rejectする。7日を超えたら新しいPlanを使う |
| Deployが開始しない                | Apply失敗、Apply metadataなし、mainが進んだ、workflow disabled | ActionsのApply/Deploy conclusion、errorのSHA | 最新mainのCI→Plan→Applyを成功させる。Terraform変更をmanual Deployで迂回しない |
| Variable validationで停止         | `staging` Environment input未設定/誤origin | errorに出た変数名 | [`deployment.md`](deployment.md) input sheetで値を決めて設定。仮値禁止 |
| Migration stepで停止              | Neon direct URL/branch/SQL error | workflowのmigration step、Neon state | Wrangler deploy前に停止済み。DB runbookに従い原因解消、force/resetしない |
| Wrangler deployで停止             | Cloudflare token権限、Workers Paid、config/container build error | Wrangler log、Cloudflare deployment | account/zone/plan/token scopeを確認し、CI dry-runとの差を修正 |
| Custom domainが作れない           | 同名DNS record、zone未Active、token zone権限不足 | DNS records、zone status、Wrangler error | 既存recordの所有用途を確認。不要と確認できたrecordだけ除去して再deploy |
| `/healthz` 200、`/readyz` 503     | ProcessはaliveだがNeon unavailable | Neon compute/connection、runtime pooled URL、pool | DB接続・pool・secretを修正。OpenAI/Google/Turnstileはreadiness対象外 |
| Static assetsだけ404              | `frontend/dist`未build、assets path/config不一致 | workflow build、Wrangler assets output | Frontend build後にWrangler deploy。Worker/API routingとは分けて確認 |
| Deploy後に5xx増加                 | 新deployment/config/schema incompatibility | version別Workers Logs/Traces、直前SHA | 旧versionとschema互換なら直前commitを再deploy。互換でなければroll-forward |
| Logs/tracesが見えない             | Wrangler observability設定、sampling、Dashboard filter | `wrangler.jsonc`、対象Worker/version | 対象version/filterを確認。Secret/本文を追加logして回避しない |

Production障害では秘密値やuser本文を共有せず、[`operations.md`](operations.md) のincident手順へ移行してください。
