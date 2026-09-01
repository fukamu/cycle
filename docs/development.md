# ローカル開発

この文書はローカル開発手順の Source of Truth です。アプリケーション要件・仕様・設計は [`design.md`](design.md) が上位です。環境変数の全項目は [`environment.md`](environment.md)、DB固有の運用は [`database.md`](database.md) を参照してください。

## 前提環境

- Bash 5.0以上とGNU userland（Ubuntu 20.04/24.04、WSL2）
- Node.js 24以上、pnpm 11.22.0（lock fileはrootの `pnpm-lock.yaml`）
- Go 1.26.6
- PostgreSQL（version、固定Docker image、起動方法は [`database.md`](database.md#local-postgresql)）
- sqlc 1.31.1、またはDocker（Backendの品質チェックとSQL生成に必要。Go 1.26.6によるfallbackも利用可能）
- Docker EngineとDocker Buildx（PostgreSQLの簡易起動、Cloudflare Container imageのbuild、InfrastructureのDocker build context監査に必要）
- Chromium（E2Eを実行する場合）
- Terraform 1.15.8（Staging/全体checkとCloudflare Turnstile基盤変更に必要）
- Python 3と`curl`、`jq`、`openssl`、`realpath`、`sha256sum`、`base64`、`tar`、`zip`、`script`、`sed`、`awk`、`find`、`sort`、`mktemp`

CIとContainer imageはNode.js 24、pnpm 11.22.0、Go 1.26.6と [`database.md`のPostgreSQL pin](database.md#構成)を前提にします。Staging基盤はTerraform 1.15.8とCloudflare provider 5.22.0、Wrangler 4.123.0をpinしています。ローカルでも同じversionを使ってください。Frontendだけを確認する場合はGo・PostgreSQL・sqlc・Terraformは不要です。

sqlcはRepository標準のラッパーで実行します。ラッパーはsqlc 1.31.1がHostにあればそれを使い、なければ`sqlc/sqlc:1.31.1@sha256:70f53171d27b2424e9358869975455a6e955a5aa8e58a998a270a6e34e525537`を`docker run --rm`で起動します。Docker serverも利用できない場合は、Goでpin済みの一時toolを`.tmp/tools`へbuildしてfallbackします。これによりsqlcをHostへ常設する必要はありません。Docker/Goはいずれも初回だけimageまたはmoduleのdownloadが必要で、一時toolは通常のsafe clean対象です。

```bash
./scripts/invoke-sqlc.sh compile generate
```

特定の実行方法を検証する場合は`--runner host`、`--runner docker`、`--runner go`を指定できます。Docker実行では`backend/`だけを書き込み可能でmountし、containerは実行後に削除します。Host user IDを渡し、生成物がroot所有になることを防ぎます。

## Supply-chain固定値の更新

GitHub Actionsの外部Actionは完全な40文字commit SHAと同じ行のsemantic version comment、外部Container imageは可読なtagと`sha256` digestの組で固定します。`./scripts/check-supply-chain.sh`はworkflow、Dockerfile、Compose、運用tool registry、文書の全参照と同一tagのdigest一致を検証し、`./scripts/check-security.sh`もsecret scan完了後のcandidate snapshotへ同じpolicyを適用します。

`.github/dependabot.yml`はGitHub Actionsを月曜、Dockerfileを火曜、Docker Composeを水曜の05:00（Asia/Tokyo）に週次確認します。GitHub ActionsとDocker Composeはecosystemごとの全version updateを1つのPRへまとめます。Dockerfile imageはgroupingせず、dependency単位のversion update PRとして1件ずつreviewします。各ecosystemの`open-pull-requests-limit: 1`はversion updateの同時open上限であり、別枠のsecurity updateを抑止しません。PRではupstream release/tagと変更履歴を確認し、ActionのSHAとversion comment、またはimageのtagとdigestを同じ変更で更新して全gateを通します。障害時も固定自体を外さず、直前に確認済みのSHAまたはtag/digest組へreviewed commitで戻します。

`docker://`形式のActionはDependabotの更新対象外です。Actionlintのrelease確認、workflow参照、`scripts/lib/tool-images.sh`の対応値は手動で同じPRへ更新し、policy fixtureとsecurity gateでdriftを拒否します。

## Dockerによるローカル実機確認

Docker Desktop、Bash 5、curlだけで、Frontend、Backend、Migration、PostgreSQLを隔離環境へbuildし、ブラウザから操作できます。Repositoryの`.env`、`frontend/.env.local`、`node_modules`、`frontend/dist`、`.tmp`、既存の`fukamu-cycle-postgres`は使用・変更しません。

```bash
./scripts/local-app.sh
```

ready確認後に`http://localhost:8080`を開きます。Enterで終了すると、`fukamu-cycle-local` Compose projectのcontainer、network、破棄可能DBだけを削除します。DBはtmpfsで永続化されず、Hostへport公開されません。Applicationは`127.0.0.1:8080`だけへ公開されます。Docker imageとBuildKit cacheは次回の高速化のため保持し、他projectを含むglobal pruneは実行しません。

別portを使う場合は`--port`を指定します。

```bash
./scripts/local-app.sh --port 8081
```

Terminalを解放したまま起動する場合は`--detached`を使い、終了時に専用の`--down`を実行します。Terminalの強制終了等で自動cleanupされなかった場合も同じ`--down`を使用します。

```bash
./scripts/local-app.sh --detached
./scripts/local-app.sh --down
```

このprofileは`APP_ENV=development`、空の`OPENAI_API_KEY`、無効なTurnstile、未設定のGoogle Client IDで起動します。Telemetryはin-memory exporterを使い、`OTEL_EXPORTER_OTLP_ENDPOINT`と`OTEL_EXPORTER_OTLP_HEADERS`を設定せず、外部collectorへ送信しません。AIは決定的なFake Adapterを使用し、Google連携以外のGoal/Cycle/Review操作を外部credentialなしで確認できます。これは手動の実機確認環境であり、format、lint、typecheck、unit/integration test、E2E、Terraform、Wranglerの品質checkを代替しません。

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

固定imageによる開発DB起動は [`database.md`のLocal PostgreSQL](database.md#local-postgresql)、migration適用は [`database.md`のローカル適用](database.md#ローカル適用)に従います。既存containerのdata確認、PostgreSQL 18のvolume境界、seed / 初期dataの説明もDatabase正本だけを更新します。

## 開発サーバー

Terminal 1でBackendを起動します。

```bash
source ./scripts/import-env.sh
cd backend
go run ./cmd/server
```

Terminal 2でFrontendを起動します。

```bash
pnpm --filter fukamu-cycle-frontend run dev
```

`http://localhost:5173` を開きます。Viteは `/api` を `http://localhost:8080` へproxyします。Frontend環境変数を変えたときはViteを再起動してください。

Go Backend単体の同一origin配信fallbackをローカルで確認する場合は、FrontendをbuildしてBackendへ静的assetsを渡します。Cloudflare StagingではWorkerがstatic assetsを配信します。

```bash
pnpm --filter fukamu-cycle-frontend run build
source ./scripts/import-env.sh
export PUBLIC_ORIGIN='http://localhost:8080'
export STATIC_DIR="$(realpath ./frontend/dist)"
cd backend
go run ./cmd/server
```

## 品質チェック

全チェックは次の1コマンドです。Frontend依存関係に加え、Backend checkにはHostのsqlc 1.31.1、Docker、Goのいずれかが必要です。Repository全体のcheckは完全なGit履歴と、scanner image・advisory database・固定Go toolを取得できるnetworkも必要です。

```bash
./scripts/check.sh
```

実行内容はFrontendのformat check、lint、typecheck、unit test、build、Backendのsqlc差分確認、gofmt、vet、test、server/migrate/cleanup/configcheck build、Bash syntax/ShellCheck 0.11.0/shfmt 3.13.1/script test、文書・設定contract、security scan、Dockerローカル実機Composeの構文確認、Docker build context監査、Terraform 1.15.8 exactのformat/init/validate、Wrangler config/typecheck/dry-runです。`TEST_DATABASE_URL` が未設定ならBackend integration testはskipされます。Terraform validateは`.tmp/terraform-check`の専用`TF_DATA_DIR`とcredential不要の`backend=false` initializationを使い、localで初期化済みのR2 backend設定を再利用しません。

Frontend、Backend、Infrastructureだけを確認できます。

```bash
./scripts/check.sh --scope frontend
./scripts/check.sh --scope backend
./scripts/check.sh --scope infrastructure
```

改革や大規模整理の前後を同じ定義で比較する場合は、比較対象commitをそれぞれclean worktreeへcheckoutし、両方で`./scripts/setup.sh`とFrontend production buildを完了してから次を実行します。

```bash
node ./scripts/report-reform-metrics.mjs \
  --before-root /absolute/path/to/before-worktree \
  --after-root /absolute/path/to/after-worktree
```

このreportはtracked file、Frontend/Backend/SQL/Cloudflare/script/workflow/Terraform/documentのfile数とLF行数、dependency数、`go list -m all`のmodule graph、generated codeを除くproduction PostgreSQL call site、Frontend production assetのraw/gzip byteを同じ規則で比較します。入力worktreeにtracked/untracked差分がある場合、build assetがない場合、migration pairが不完全な場合はfail-closedです。`frontend/dist`、dependency directory、environment fileは計測結果へ含めず、出力にはcommit IDと集計値だけを含めます。

Docker build context監査だけを単独で実行する場合は、次を使います。

```bash
./scripts/check-docker-context.sh
```

この監査は一時directoryへ合成したbenign canaryをDocker Buildxでbuildし、環境file、依存directory、credential file、Terraform artifactがcontextへ入らないことを確認します。Repository内の実secret fileやその内容は読みません。

文書とconfiguration contractだけを確認する場合は、次を使います。

```bash
./scripts/check-docs.sh
./scripts/check-config-parity.sh
```

文書gateはRepository内のMarkdownについてfence、reference definition、実際にparseされたlink/image、local file/heading anchorを検査し、固定した`markdown-it` 15.0.0と`github-slugger` 2.0.0でCommonMark構文とGitHub heading anchorを解釈し、固定した`mermaid` 11.16.1でMermaid fenceを構文解析します。CommonMark上の未定義reference-like表記はlinkではなくliteralとして扱います。Markdown fileとlocal link pathのsymlinkは禁止し、外部URLはnetworkへ接続せず対象外にします。Configuration parity gateは[`deployment-contract.json`](../config/deployment-contract.json)を基準に、Backend typed config、canonicalなGo環境package importと直接環境参照の明示allowlist、`.env.example`、[`environment.md`](environment.md)、Worker/Container handoff、Wrangler、Frontendのproduction `import.meta.env` consumerと`VITE_DEPLOYMENT_ENV` build-config配線、deploy workflowのkeyと分類が一致することを検査します。Deployではresolve/CI確認からsecret cleanup・smoke testまでのjob/step列、migration-before-deploy、必要stepだけへのsecret公開も完全一致で検査します。

Security profileだけを実行する場合は、次を使います。

```bash
./scripts/check-security.sh
```

このprofileはpnpm 11.22.0、Gitleaks 8.30.0、Trivy 0.73.0、Terraform 1.15.8のscanner/parser imageをdigestで固定し、`govulncheck` 1.7.0と`gosec` 2.22.11を固定して実行します。Node lockfile、到達可能なGo脆弱性、GoのHIGH/high-confidence静的所見、Git全履歴・stage済みindex・trackedとGit非ignoreのcandidate treeにあるsecret、Terraformとproduction Dockerfile、実際にbuildしたproduction container imageが対象です。Candidate snapshotはtrackedと非ignoreの通常fileだけから作成し、tracked+ignored path、symlink、special fileを拒否します。Candidate・index・全履歴はapproved ASCII path/type、UTF-8、control byte、1 objectあたり16 MiB、entry/manifest sizeの上限をfail-closedに検証し、全merge historyのblobに加えてcommit/tag本文、candidate/index/history path、ref名もpath/MIME skipを受けない正規化viewでscanします。既知の旧`backend/server.exe`はexact object/path/size、正規化viewのreview済み履歴blobはexact OID、Gitleaks例外はexact commit/path/rule/line fingerprintだけを許可し、globやrule単位の例外を拒否します。Gitleaks本体は`--max-target-megabytes=0`でfile size skipを無効化しますが、前段のapproved-text inventoryには前述の16 MiB/object境界があります。

Repositoryを読むGit commandはambient環境とglobal/system configを除去し、pager、external diff/textconv、fsmonitor、untracked cache、hook、lazy fetch、replace/graft、alternate object store、include/worktree config、promisor/partial-cloneを無効化または拒否して、完全な自己完結object graphを検証します。Container内でGit metadataが必要な検査は、通常checkoutの`.git` directoryまたはlinked worktreeの`.git` pointer、`commondir`、backlinkを構造検証し、common Git directoryだけを固定pathへread-only mountして対象worktreeを明示します。`check.sh`がcompile確認用に生成する一時Go binaryは配布せず、linked worktreeでも未隔離のVCS commandを起動しないよう`-buildvcs=false`でbuildします。Node policyはroot `packageManager`、workspace/package/script集合、build許可、lockfileのsemantic dependency graphとregistry-integrity形式をexactに照合し、lifecycle script、package patch/source override、非exact dependency、runtime selector、`.npmrc`、pnpm hook fileを実行前に拒否します。Goは`GOENV=off`、`GOWORK=off`、`GOTOOLCHAIN=local`、`-mod=readonly`とproduction同等の`CGO_ENABLED=0`、`GOOS=linux`で、workspace/vendor/replace/ignore/toolchain overrideを拒否します。Terraformはnetworkless lexerと固定Terraform parserで`.tf.json`、`.tfvars*`、`.terraform`、実module blockを拒否し、文字列・comment・heredoc内のdecoyは区別します。Archive展開と再帰decodeはreview済みの深度5へ固定し、archiveの深度超過・暗号化・解析error・size skipはgateを失敗させます。Decode深度6以上は検出保証外とする意図的なbounded policyで、深度変更には負例とsecurity reviewが必要です。Scanner・registry・advisory databaseの取得失敗、report schema不一致、解析不能、対象severityのfindingはいずれもgateを失敗させ、秘密値やsource snippetを含むraw reportは表示しません。一時image tagとscan用fileは終了時に削除します。

Gate内では、固定container imageがHostにない場合、そのimage refだけをcontainer registryへ問い合わせて取得することがあります。この前提runtime取得ではRepository内容を送信しません。その後、すべてのfull-history/staged/current-tree secret viewを、Repository由来のpackage/module metadataを送るdependency install、advisory lookup、scanner database/tool取得、candidate command、production image buildより先に完了します。Node auditはregistryをCLIで`https://registry.npmjs.org/`へ固定してpnpm hookを無効化し、Go scannerも上記の隔離環境を使います。Git管理外でignore済みの`.env`やcredential fileは読みません。CI quality jobの依存導入は`--ignore-scripts`で行い、直後にtracked/index/untracked candidate treeが不変であることを確認してから各quality gateを実行します。`scripts/tests/check-security.sh`はsecret、IaC、Node/Go vulnerability、Go static analysis、container vulnerabilityの負例を実行時に一時生成し、各scannerが期待classで失敗することとsecretが出力されないことを検証します。これらの負例は標準のBash script test、全体check、Commit前gate、CI quality jobから実行されます。M25で導入したscanner/toolはここで固定します。既存GitHub Actionのcommit SHA、production base imageを含む全image digest、Dependabot更新経路の包括的な固定はM28の責務です。

Backend integration testには、消去してよい専用DBだけを指定してください。テストはschema内のapplication tableをdown/up migrationで作り直します。開発DBやproduction DBを指定してはいけません。

```bash
export TEST_DATABASE_URL='postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:5432/fukamu_cycle_test?sslmode=disable'
./scripts/check.sh --scope backend
```

E2Eも同じ専用DBを使います。安全のため、`TEST_DATABASE_URL`は`localhost`、`127.0.0.1`、`[::1]`のいずれかにある、名前が`_test`で終わるDBだけを受け付けます。初回のみChromiumを導入し、`--e2e` を付けます。Check scriptは`CI=true`を設定し、GitHub Actionsと同じPlaywright設定およびmigration/server起動経路を使い、終了時に子processを確実に停止します。

```bash
pnpm --filter fukamu-cycle-frontend exec playwright install chromium
export TEST_DATABASE_URL='postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:5432/fukamu_cycle_test?sslmode=disable'
./scripts/check.sh --e2e
```

Playwright自身の既定portは55432です。このリポジトリのDocker例は5432なので、上記のように `TEST_DATABASE_URL` を明示してください。E2EではGoogle Identity、Turnstile、OpenAIのtest doubleを使い、外部APIを呼びません。

### Staging post-deploy critical journey

`./scripts/check-staging-critical.sh`は通常のlocal checkではなく、`Deploy Staging`が実際のStaging traffic切替とsmoke testの後にだけ実行します。`STAGING_BASE_URL`と`STAGING_E2E_INVITE_TOKEN`はGitHub `staging` Environmentからstep scopeで渡し、引数にはしません。HarnessはPlaywright test reporterを使わず、trace、screenshot、video、artifactを作らず、debug modeを無効化します。成功・失敗にかかわらず公開account-delete APIで検証accountを削除します。

Localから日常的に実行せず、Production originやProduction dataへ向けません。障害調査でOperations ownerが直接実行する場合も、承認済みsecret managerから環境へ注入し、shell history、process argument、terminal recordingへRaw Invite Tokenを残さず、[`operations.md`](operations.md#staging-critical-journey-cleanup)のcleanup確認まで完了させます。

### Commit前の必須gate

Commitへ含める変更をすべてstageし、unstaged/untracked fileがない状態で次を実行します。この1コマンドはNode/pnpm/Go/Terraformの標準version、frozen lockfile install、CI再利用・権限modelのnegative fixture、actionlint 1.7.12、文書・設定・securityを含む全scopeの品質check、CI設定のPlaywright E2Eを検証します。sqlc生成物は、検証開始時点から`sqlc generate`後に差分が増えないことも確認します。

```bash
export TEST_DATABASE_URL='postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:5432/fukamu_cycle_test?sslmode=disable'
./scripts/check-before-commit.sh
```

このgateが成功しない限りcommitしてはいけません。成功後にindexまたはworking treeを変更した場合は、その変更をstageして全gateを再実行します。成功messageに表示されたstaged treeだけを、そのままcommitしてください。GitHub-hosted runner固有の障害はローカルから排除できませんが、repository内容に対するCIの検証commandとE2E suiteはこのgateで先に実行されます。

### 性能変更の確認

DB-backed collection endpointは、page内のitem数に比例してSQL round tripが増えないよう、JOINまたはbatch queryで必要なsummaryを取得します。Home、Goal一覧、Cycle一覧を変更するときは、itemごとのdetail query（N+1 query）を追加してはいけません。

Frontendのroute別code splittingとasset sizeは`pnpm --filter fukamu-cycle-frontend run build`のchunk一覧で確認します。Mutation responseが遷移先と同じDTOを含む場合は、TanStack Query cacheへ反映してから遷移し、直後に同じresourceを再取得するnetwork round tripを避けます。Mutationの影響を受けるcollection/detail cacheは、引き続き明示的に更新またはinvalidateします。Auto SaveやAI提案Adoptも同じserver mutationとして扱い、成功responseをeditor local stateだけに反映しません。未保存入力はeditor/Browser Draft Cache、保存済みstateはTanStack Queryへ同期し、route往復の回帰testで古いfresh cacheが復元されないことを確認します。

### AI quality evaluation

AI qualityのcase group、rubric、release gateは [`design.md`](design.md) §49が唯一の仕様です。このsectionはRepository内の実行手順を所有します。

次のBackend checkは、中央Prompt Registryのversion解決、operation boundary、`backend/testdata/ai_eval`にある5 fixture groupとJSONLを決定的に検証します。Pathやfile名を変える場合は同じ変更でtest runnerを更新します。

```bash
./scripts/check.sh --scope backend
```

ModelまたはPrompt Versionを変更する前に、次を行います。

1. Prompt assetを新しいimmutable versionとして中央Registryへ追加し、旧versionを上書きしない。
2. 対象modelと正式単価を固定し、§49の全fixtureをStaging用credentialで実行する。Production dataや実User本文を使わない。
3. Structured Output、文字数、Action件数、禁止された捏造patternを自動確認する。
4. Human reviewerが§49のrubricで採点し、critical failureが0件であることを確認する。
5. Model、Prompt Version、実行日、latency、token、cost、採点結果をPull Requestへ添付する。Secretや不要なProvider response / User dataは添付しない。

外部credentialがないlocal / CIではProvider quality判定を行わず、Fake Adapter、schema validation、context isolation、quota / budget、error pathのdeterministic checksを実行します。

### GitHub Actionsの更新

Workflowで利用する公式Actionは、特別な互換性制約がない限り、Node.js runtimeとsecurity fixを含む最新のstable majorを使います。更新時は各Actionの公式release noteでbreaking changeとGitHub-hosted runnerの要件を確認し、`.github/workflows/ci.yml`のactionlintを通します。Stable majorを据え置く必要がある場合は、理由と解除条件を該当Workflowへcommentで記録します。

Pull request CIはGitHubのmerge refをcheckoutして全checkを実行し、成功時にPR番号、head SHA、検証commit、検証tree SHA、workflow run IDの5項目だけを含むattestationを30日保持のartifactへ保存します。mainの`CI` workflowは、マージ後commitに対応するPR、同一head SHAの成功したPR CI、canonical job一式の期待結果（attestation成功とreuse jobのskipを含む）、artifact APIがexact nameの未期限切れartifactを正確に1件だけ返すこと、検証済みtreeとmain treeの完全一致を確認できた場合だけ重いjobをskipします。Artifactは展開せず、archive全体を16 KiB以下、compressionをstoredまたはdeflate、entryをregular fileの`attestation.txt` 1個、payloadを4 KiB以下へ制限し、実sizeとCRCを照合します。そのうえで5行payloadがPR、head、tree、runと一致し、検証commitが40文字のlowercase SHAであることまで確認します。判定job自体がmain SHAの成功CIとなるため、Terraform PlanとDeployの同一SHA gateは維持されます。

CI全体の既定権限は`contents: read`だけです。GitHub APIで再利用可否を判定するmain push専用jobだけに`actions: read`と`pull-requests: read`を追加し、Pull requestのcodeを実行するjobへ渡しません。全checkoutはcredential永続化を無効にし、Git全履歴が必要なquality jobだけ`fetch-depth: 0`を指定します。Quality jobが失敗またはskipされたtreeではE2Eの成功証明を作りません。全CI jobとDeployのdependency installはlifecycle scriptを無効化し、直後のtracked/index/untracked tree不変確認を通過してから候補commandを実行します。Functional jobのrunner、PostgreSQL service、job環境、必須step/command列も完全一致とし、step skip、failure許容shell、`BASH_ENV`、self-hosted差替えを拒否します。この権限・依存関係は`./scripts/tests/check-ci-security-model.sh`の破壊fixtureで固定します。

Manual Terraform PlanとDeployはAPI応答のschemaと非paginationをfail-closedに確認し、同一repository・main・commitのexactな`CI` workflow path/nameを持つcompleted/success `push` runだけを受け入れます。PR run、forkの`main` branch、別workflow、曖昧または101件以上の応答は成功CIとして扱いません。

直接push、複数・不明な関連PR、base更新後にPR CIを再実行せずmergeした場合、API障害・schemaや件数の曖昧さ、artifact欠落・期限切れ・重複・破損、job不一致、tree不一致では再利用せず、mainで全CIを実行します。PRの変更fileを100件以内で全件照合できない場合もfallbackします。また`.github/`、`scripts/`、package/workspace manifestとlockfile、test・lint・build設定、secret scanやconfiguration gateのpolicy fileなどCIの信頼境界自体を変更したPRは、attestationがあっても再利用せずmainの新しい制御面で全CIを実行します。高速化のためにこのfail-safe fallbackやtree完全一致を緩和してはいけません。

## 開発時troubleshooting

まず秘密値を貼らず、実行command、exit code、対象環境、直前変更、固定`error_class` / `error_code`を記録します。Database固有の症状は [`database.md`のtroubleshooting](database.md#database-troubleshooting)、Staging / Productionは [`operations.md`のCloud troubleshooting](operations.md#cloud-troubleshooting)へ進みます。

### Setup / dependency install

| Symptom | Check | Response |
|---|---|---|
| `go`が見つからない、またはsetupがversionで停止 | `command -v go`; `go env GOVERSION` | [前提環境](#前提環境)のGoへ合わせてterminalを開き直す。Version guardを外さない |
| `pnpm install`失敗 | Node / pnpm version、最初のpnpm error | Lockfileを手編集せず標準versionへ合わせる。必要な場合だけ`clean.sh --all`後にsetupを再実行 |
| 同名PostgreSQL container error | `docker ps -a --filter name=fukamu-cycle-postgres` | 停止中ならimageを確認してstartする。保持data確認前にremoveしない |
| Bash versionで停止 | `bash --version`; `command -v bash` | Bash 5以上のUbuntu / WSL2で実行する |
| Docker profileがremote contextを拒否 | `docker context inspect` | Local Docker contextへ戻す。Safety guardを削除しない |

### Development server / build

| Symptom | Check | Response |
|---|---|---|
| Backendが`invalid configuration`で終了 | Errorのkey名、現在terminalでenvをimportしたか | `source ./scripts/import-env.sh`後、[`environment.md`](environment.md)に従ってlocal値を修正 |
| OTLP設定で終了 | Errorのkey名だけを確認 | Local / Testではendpoint / headerを空にし、未承認`OTEL_*`をprocessから除く。Header値を表示しない |
| Port 8080 / 5173が使用中 | `ss --tcp --listening --numeric --process` | 所有processを確認して停止する。無関係なprocessをkillしない |
| FrontendからAPI 404 / connection refused | Browser Network、local `/healthz` | Backendを起動し、開発時はVite originを使う |
| Go static fallbackが404 | `frontend/dist/index.html`と`STATIC_DIR` | Frontendをbuildし、absolute `STATIC_DIR`でBackendを再起動 |
| Frontend build / typecheck失敗 | `./scripts/check.sh --scope frontend` | 最初のerrorを修正する。Stale dependencyならfull clean後にsetup |
| Format / lintだけ失敗 | Frontend format check / lint | Formatterを実行して差分をreviewし、lint errorを個別修正 |
| Docker実機profileがreadyにならない | Compose logsの最初のerror | `./scripts/local-app.sh --down`で専用resourceだけを片付けて再実行 |

### Test / E2E

| Symptom | Check | Response |
|---|---|---|
| Go integration testがskip | `TEST_DATABASE_URL`の有無 | 消去可能な`*_test` DBだけを設定する |
| E2EがDBへ接続できない | Docker published portとURL | Playwright既定portへ依存せず`TEST_DATABASE_URL`を明示する |
| E2EがGoを起動できない | `command -v go`、optional binary path | 標準Goを使うか、実在するprebuilt binaryを指定する |
| Prebuilt serverでreadiness失敗 | Test DBのmigration version | Prebuilt server指定時は破棄可能DBへmigrationを先に適用する |
| Chromiumがない | Browser executable error | `pnpm --filter fukamu-cycle-frontend exec playwright install chromium` |
| CIだけ不安定 | Job logとPlaywright artifact | Worker 1を維持して根因を修正し、retry増加だけで隠さない |

### Local authentication / AI

| Symptom | Check | Response |
|---|---|---|
| Google buttonが出ない / login失敗 | Public client ID、origin、Browser Network | Frontend / Backendのclient IDとauthorized originを合わせる。Secretは使わない |
| Login後にsessionがない | Cookie属性、origin、server error code | `PUBLIC_ORIGIN`と実originを一致させる |
| Anonymous session作成失敗 | Turnstile site / secret、hostname / action | 対応値を揃え、期限切れtokenを再利用しない。Productionで無効化しない |
| Local AIが外部APIを呼ばない | `APP_ENV`とkeyの有無だけを確認 | Keyが空のdevelopment / testは仕様どおりFake。通常testでは外部keyを設定しない |
| AI model / Prompt候補の品質確認 | [AI quality evaluation](#ai-quality-evaluation) | Deterministic gateとreviewer rubricを通し、Production dataを使わない |

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
./scripts/reset-local-db.sh --database-name fukamu_cycle --confirm-database-name fukamu_cycle --dry-run
./scripts/reset-local-db.sh --database-name fukamu_cycle --confirm-database-name fukamu_cycle --yes
```

## 開発終了時

各serverを `Ctrl+C` で停止します。BackendはHTTP requestをdrainした後にin-memory trace / metric providerをflushします。Docker DBも止める場合は `docker stop fukamu-cycle-postgres` を実行します。containerをstopしてもDBデータは保持されます。

解決しないlocal問題は上の切り分け結果と最初のerrorを共有し、仕様判断が必要なら [`design.md`](design.md) を確認します。Cloud resourceやProduction dataへ試行錯誤の変更を加えません。
