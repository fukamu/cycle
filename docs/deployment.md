# Deployment

この文書はFUKAMU Cycleのdeployment手順のSource of Truthです。Architecture上の境界は [`design.md`](design.md) §44、環境変数の正確な一覧は [`environment.md`](environment.md)、migration規則は [`database.md`](database.md)、運用確認は [`operations.md`](operations.md) を参照してください。

## Environment model

| Environment | Purpose | Deployment | Isolation |
|---|---|---|---|
| Development | local開発 | 手動起動 | local PostgreSQL、Fake AI/Turnstile可 |
| Test | CI / E2E | GitHub Actions内 | job専用PostgreSQL、external providerはtest double |
| Staging Light | external integration検証 | main SHAの成功CI（検証済みPR tree再利用または全check）→ Terraform Plan → owner承認Apply → migration-first Cloudflare deploy | `cycle.staging.fukamu.matoruru.com`、専用Cloudflare/Neon/provider設定 |
| Production | 正式公開 | 未構築 | `cycle.fukamu.com`。Stagingと別resource/stateで設計 |

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
  -> successful main SHA CIからTerraform saved planを作成
  -> owner承認後、同一planでCloudflare Turnstile widgetをApply
  -> Neon direct connectionでmigration
  -> WranglerでWorker + Container + assets + runtime secretsをdeploy

R2
  -> Terraform state/lockfile、retained pre-Apply backup/checksum、temporary restore-drill key
```

CloudflareのDDoS protectionはplanを問わず自動有効です。ただし、Application rate limit、Turnstile、認可、OpenAIのprovider/application budgetは別に必要です。

## Responsibility boundary

| Owner | Managed resources |
|---|---|
| Terraform / `terraform-plan.yml` / `terraform-apply.yml` | Staging専用Turnstile widget、saved plan review、承認付きApply、pre-Apply state backup / restore drill |
| Wrangler / `deploy.yml` | Worker code、Container image/config、static assets、custom domain、runtime secret、deployment |
| GitHub Actions | main/CI/exact SHA gate、migration-first順序、smoke test、self-cleaning post-deploy critical journey |
| Manual bootstrap | Cloudflare account/zone/plan/token、R2 bucket、Plan Read Only / Apply Read & Write credential、Neon、Google client、OpenAI limit、GitHub Environment protectionとinput |

Worker/ContainerをTerraformとWranglerの両方で管理しません。Application releaseとDB migrationはTerraform stateへ入れません。

## Required input sheet

初回deploy前に以下をpassword managerまたはaccess-controlled release recordへ記録します。Secret値そのものはissue、文書、Terraform variable、CLI argument、workflow logへ記録しません。

| Area | Required decision / identifier |
|---|---|
| Cloudflare | account ID、zone ID、`matoruru.com`がActive、Workers Paid plan、operator |
| Domain | `https://cycle.staging.fukamu.matoruru.com`、同名recordの有無、domain owner |
| Container | `lite`、max instances `1`、APAC、idle sleep `10m`をStaging初期値として承認 |
| R2 state | private bucket名、Plan Read Only / Apply Read & Write token owner、GitHub secret scope owner、snapshot保持期間、復旧方針 |
| Neon | Staging専用project/branch、region、compute/scale-to-zero、restore window、connection limit |
| DB connections | application pooled URL、migration direct URL、`DB_MAX_OPEN_CONNS`、管理/migration余裕 |
| Google | Staging専用Web Client ID、authorized origin |
| Turnstile | widget site key、secret owner、hostname/action |
| OpenAI | project/key owner、model、確認日、token単価、provider spend/rate limit |
| Telemetry | OTLP/HTTP collector endpoint、header credential owner、pinned SDK defaultのsampler / export volumeのStaging受入、Production retention、dashboard、alert、notification、on-call |
| App controls | AI monthly budget、rolling/rate limit、tester、公開期間、任意のApplication紹介導線をStagingで公開するか、post-deploy E2E用の非個人Invite IDとRaw Token owner |
| Operations | Terraform Apply approver、logs/traces確認者、cost確認、teardown/継続判断日 |

## 1. Prerequisites

- Cloudflareで`matoruru.com` zoneがActiveであること。
- Cloudflare Workers Paid planを有効にすること。ContainersはPaid planが必要です。
- GitHub repositoryのdefault branchが`main`で、CIがgreenであること。
- Local bootstrapにはTerraform 1.15.8、Node.js 24、pnpm 11.22.0、Gitを使うこと。
- Cloudflare、Neon、Google、OpenAI、GitHubへ必要最小権限でaccessできること。

Repository全体の事前検査:

```bash
./scripts/check.sh
```

## 2. R2 Terraform backend bootstrap

R2 bucketとS3 credentialはTerraform自身より先に必要なためmanual bootstrapです。[Cloudflare R2のObject permission](https://developers.cloudflare.com/r2/api/tokens/)を使い、管理tokenではなく対象bucketだけのtokenを分離します。

1. Cloudflare Dashboardでprivate R2 bucket（例: `fukamu-cycle-terraform-state`）を作る。他用途と共有しない。
2. 対象bucketだけにscopeしたPlan用の `Object Read Only` R2 API tokenを作る。
3. 同じbucketだけにscopeしたApply用の別の `Object Read & Write` R2 API tokenを作る。Plan token、account管理token、Wrangler deploy tokenと共有しない。
4. Plan credentialをrepository secret、Apply credentialを `staging-terraform-apply` Environment secretへ、§3の同じsecret名で登録する。値をCLI argument、issue、workflow logへ出さない。
5. [`backend.hcl.example`](../infra/terraform/staging/backend.hcl.example) をuntrackedの `backend.hcl` へcopyし、bucketとaccount IDを設定する。
6. 障害調査でlocal remote readが必要な場合だけ、password managerからPlan用Read Only credentialを現在のBash processへ読み込む。通常releaseをlocal Applyで迂回しない。

`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` は値をcommand historyへ直接貼らず、現在processだけへ設定します。

`use_lockfile = true` はbackendの既定として維持します。ApplyはRead/Write credentialでlockを取得します。PlanだけはRead Only credentialを使うため `terraform init -lock=false` と `terraform plan -lock=false` を実行します。HashiCorpは並行操作があり得る環境でlock無効化を推奨していないため、`staging-terraform` concurrency group以外からremote Plan/Apply/state操作を同時実行しません。R2 state bucketへBucket Lockを設定するとTerraformの通常更新を妨げるため設定しません。

## 3. Terraform Plan / Apply CI/CD

Turnstile編集だけにscopeしたCloudflare API tokenを使い、deploy tokenとは分離します。R2 credentialは同じsecret名をscope別に設定し、値は必ず異なるtokenにします。正確な分類は [`environment.md`](environment.md) を参照してください。

Repository secrets:

```text
TERRAFORM_CLOUDFLARE_API_TOKEN
TERRAFORM_R2_ACCESS_KEY_ID
TERRAFORM_R2_SECRET_ACCESS_KEY
```

- `TERRAFORM_CLOUDFLARE_API_TOKEN`: 対象accountのTurnstile Editだけにscopeする。
- RepositoryのR2 2 secrets: 対象state bucketだけの `Object Read Only` credential。`Terraform Plan Staging`だけが使う。

`staging-terraform-apply` Environment secrets:

```text
TERRAFORM_R2_ACCESS_KEY_ID
TERRAFORM_R2_SECRET_ACCESS_KEY
```

- EnvironmentのR2 2 secrets: 同じstate bucketだけの別の `Object Read & Write` credential。Snapshot、isolated drill、lock、Apply state更新だけに使う。
- [GitHubのsecret precedence](https://docs.github.com/en/actions/reference/security/secrets#naming-your-secrets)により、Environmentを参照するApply jobでは同名Environment secretがrepository secretより優先される。Plan jobはEnvironmentを参照しないためRead Onlyのままです。

Repository variables:

```text
TERRAFORM_CLOUDFLARE_ACCOUNT_ID
TERRAFORM_R2_STATE_BUCKET
TERRAFORM_APPLY_APPROVER=<your GitHub login>
```

`staging-terraform-apply` Environmentは必須です。Deployment branchesを `main`へ制限し、上記Read/Write secretsを登録します。利用中のGitHub planでRequired reviewersを使える場合は `TERRAFORM_APPLY_APPROVER`と同じuserを指定します。本人がmanual dispatchとreviewの両方を行う場合は `Prevent self-review`を有効にしません。Environment protectionを利用できない場合も、owner限定manual dispatch gateは維持します。

`Terraform Apply Staging`は自動起動しません。Planをreviewした `TERRAFORM_APPLY_APPROVER`本人がActions画面からmanual dispatchし、対象の `Terraform Plan Staging` run IDを入力します。Workflow preflightはactor、Plan workflow、repository、成功状態、main、artifact、current main HEADを検査し、不一致ならEnvironment credentialを使うApply jobへ進みません。

通常のsequence:

```text
CI (main HEAD。完全一致するPR検証treeを再利用、証明不能なら全check)
-> Terraform Plan Staging
   -> repository Object Read Only credentialでR2 live stateをlockなしでread
   -> terraform plan -lock=false -out=staging.tfplan
   -> SHA-256 + commit SHA付きartifact（7日）
-> ownerがPlan run IDを指定してTerraform Apply Stagingをmanual dispatch
-> Terraform Apply Staging preflight
   -> actor、source Plan、artifact、current main HEADを検証
-> staging-terraform-apply Environment（設定時はreviewer approval）
   -> Environment Object Read & Write credentialへscope override
   -> saved planを再検証しTerraform backendをlock対応で初期化
   -> current main HEADを最終再検証
   -> live state snapshot + SHA-256をprivate R2へ保存してread-back検証
   -> isolated backend keyでchecksum比較とterraform plan -refresh=false
   -> isolated state/lockを削除
   -> 同じsaved planをlock付きでterraform apply
-> Apply metadata artifact
-> Deploy Staging
```

Planの `-lock=false` はRead Only credentialを成立させるための限定例外です。RepositoryのPlanとApplyは同じ `staging-terraform` concurrency groupで直列化します。Manual remote state操作を並行させず、stateが別経路で変化した場合はsaved planをstaleとして破棄し、新しいPlanからやり直します。

### Pre-Apply state snapshot and restore drill

Applyは最終main HEAD確認の直後、Terraform wrapperを無効化したCLIで [`backup-and-drill-terraform-state.sh`](../scripts/backup-and-drill-terraform-state.sh) を実行します。Wrapperやworkflow outputへstate stdoutを保存しません。

1. `terraform state pull`の結果をprivate runner tempへ `umask 077`で保存し、state envelopeと16 MiB上限を検証する。
2. SHA-256を計算し、次のstate objectと `.sha256` objectをconditional putで新規作成する。既存objectは上書きしない。
   - `fukamu-cycle/staging/state-backups/<commit-sha>/<utc-timestamp>.tfstate`
3. 両objectを読み戻し、local snapshot、保存checksum、read-back bytesが一致することを確認する。
4. 検証済みbytesを `fukamu-cycle/staging/state-restore-drills/<commit-sha>/<run-id>-<attempt>/terraform.tfstate` へconditional putし、別backend keyとして初期化する。
5. Isolated stateのchecksumを再比較し、`terraform plan -refresh=false -lock=false` を成功させる。Live stateへ `state push`しない。
6. Isolated stateとその `.tflock`だけを削除する。Uploadのresponse lossでもcleanupを試行し、cleanup失敗時もApplyを停止する。

Snapshot、checksum upload/read-back、drill、cleanupのどれかが失敗した場合、後続の `terraform apply` は実行されません。保持期間はOperations owner未決のため、運用契約は **automatic snapshot deletion is disabled** です。`state-backups`配下のstate/checksumをworkflowから削除しません。成功時は両backup keyだけをApply summaryへ記録し、state本文やcredentialを出力しません。

`Terraform Plan Staging`のlogでhostnameが `cycle.staging.fukamu.matoruru.com`、modeがinvisible、destroy/replaceがないことを確認してから、そのPlan run IDで `Terraform Apply Staging`を実行します。Environment Required reviewerも設定した場合は、続けて `Review deployments`から承認します。Review中にmainが進んだ場合はstale planとして停止し、新しいCI/Planを待ちます。Plan artifactはApply成功後に削除を試み、削除できなくても7日でexpireします。

Saved planはstateとresource値を含み得るsecret相当です。Artifactをdownload、転記、長期保存しません。Turnstile resourceが返すsecretもR2 stateへ含まれ得るため、R2 credentialとGitHub Actions accessを最小化します。Site keyはGitHub variableへ、secret keyはCloudflare DashboardからGitHub secretへ登録し、terminal/logへ出しません。

Localではcredential不要のfmt/validateを通常検査に使います。CI/CD障害調査でremote planが必要な場合だけ、[`backend.hcl.example`](../infra/terraform/staging/backend.hcl.example) と [`terraform.tfvars.example`](../infra/terraform/staging/terraform.tfvars.example) からGit管理外fileを作り、Plan用Read Only credentialを現在processへ設定して `-lock=false`で実行します。通常releaseをlocal `terraform apply`で迂回しません。

```bash
./scripts/check.sh --scope infrastructure
```

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
2. Authorized JavaScript originsへ正確に `https://cycle.staging.fukamu.matoruru.com` を登録する。
3. Web Client IDはGitHub variable `GOOGLE_WEB_CLIENT_ID`へ登録する。Client secretはこのGIS ID-token flowでは使用しない。

Turnstile:

- Terraform outputのsite keyをGitHub variable `TURNSTILE_SITE_KEY`へ登録する。
- Secret keyをGitHub secret `TURNSTILE_SECRET_KEY`へ登録する。
- 許可hostnameは`cycle.staging.fukamu.matoruru.com`、expected actionは`anonymous_bootstrap`で固定する。

OpenAI:

- Staging専用keyをGitHub secret `OPENAI_API_KEY`へ登録する。
- Provider側spend/rate limitとApplication budgetを両方設定する。
- `AI_MODEL`と`AI_PRICING_MODEL`はworkflowが同じ値に揃える。Deploy日の公式token単価を確認してGitHub variablesへ設定する。
- `AI_REASONING_EFFORT`の初期値は`medium`とし、GPT-5.6の`none` / `low` / `medium` / `high` / `xhigh` / `max`だけを許可する。変更時は§49の評価を通し、ProductionではGitHub variableへ明示してからdeployする。

## 6. Cloudflare application deploy token

GitHub Actions用tokenは対象account/zoneのWorker/Container/custom-domain deployに必要な最小権限だけを付けます。R2 state credentialやTerraform Turnstile tokenと共有しません。

GitHub `staging` Environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `NEON_DATABASE_URL`
- `NEON_MIGRATION_DATABASE_URL`
- `OPENAI_API_KEY`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `SESSION_TOKEN_PEPPER`
- `CSRF_TOKEN_PEPPER`
- `BOOTSTRAP_ID_PEPPER`
- `RATE_LIMIT_HMAC_SECRET`
- `CURSOR_SIGNING_SECRET`
- `TURNSTILE_SECRET_KEY`
- `STAGING_E2E_INVITE_TOKEN`

`STAGING_E2E_INVITE_TOKEN`は`./scripts/check-staging-critical.sh`だけへstep scopeで渡すRaw Closed Beta Invite Tokenです。非個人Invite IDとして発行し、`closed`時は対応digestを`BETA_INVITES`へ登録します。Worker/Container secret、CLI argument、workflow log、trace、screenshot、artifactへ渡しません。

Pepper/HMAC/cursor署名secretはそれぞれ別の暗号学的random値を生成し、24文字以上にします。Application runtime/migration/deploy secretはGitHub repository-level secretではなく`staging` Environmentへ置きます。Terraform Plan/Apply用の独立credentialだけは§3のrepository secretへ置き、applicationへ渡しません。

## 7. GitHub Environment variables

GitHub Environment `staging`を作り、deployment branchを`main`だけに制限します。Application deployにも別の承認を要求したい場合だけreviewerを設定します。Terraform Applyの必須owner承認はmanual `Terraform Apply Staging`が所有し、対応planでは別Environment `staging-terraform-apply`のreviewerも追加できます。次のvariablesを [`environment.md`](environment.md) とinput sheetに基づいて明示します。

```text
PUBLIC_ORIGIN=https://cycle.staging.fukamu.matoruru.com
OTEL_EXPORTER_OTLP_ENDPOINT
BETA_ADMISSION_MODE=off
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
AI_REASONING_EFFORT
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
RATE_GOAL_START_PER_USER_MINUTE
RATE_GOAL_START_PER_SESSION_MINUTE
RATE_AI_PER_USER_MINUTE
RATE_AI_PER_SESSION_MINUTE
RATE_AI_PER_IP_MINUTE
```

Workflowは [`deployment-contract.json`](../config/deployment-contract.json) から導出した必須入力、固定Staging origin、任意紹介URLを検証し、Closed BetaはWorker runtimeと同じparserで検証します。続けてBackendのtyped config、telemetry endpoint/header、prompt version、tokenizerをDB・外部APIへ接続せず検査し、いずれかが不正ならmigration前に停止します。Example/defaultは運用承認値ではありません。Stagingで一時Admissionを検証するときだけ [`closed-beta-admission.md`](closed-beta-admission.md) に従い、`BETA_ADMISSION_MODE=closed`、TTL、Allowlist、Cookie keyを同じdeployへ設定します。

OTLP endpoint / credential ownerと実値は未決です。Operations ownerがpinned SDK defaultのsampler / export volumeをStagingで受入れ、`OTEL_EXPORTER_OTLP_ENDPOINT`をvariable、`OTEL_EXPORTER_OTLP_HEADERS`をsecretへ登録するまでStaging deployを実行しません。Endpointへcredentialを埋め込まず、header値をissue、CLI argument、workflow logへ出しません。Retention、dashboard、alert、notification、on-callの未決事項はProduction release前に別途解消します。

Application紹介導線は任意です。Stagingで意図して公開する場合だけ`APP_REFERRAL_URL=https://cycle.fukamu.com/`を追加します。未設定ならFrontend Componentは表示されません。Workflowは空値またはこの固定Production root URLだけを許可し、共有payloadにはUser Dataを含めません。

## 8. First CI/CD deployment

1. §3のTerraform repository secrets/variablesを設定する。GitHub planが対応する場合は`staging-terraform-apply` Required reviewerも設定する。
2. §6–7の`staging` Environment secrets/variablesと、post-deploy E2E専用`STAGING_E2E_INVITE_TOKEN`を設定する。Turnstile widgetがまだ存在しない初回だけ、`TURNSTILE_SITE_KEY`と`TURNSTILE_SECRET_KEY`はApply後に設定する。
3. この変更を`main`へmergeし、対象commitの`CI` workflowが成功したことを確認する。
4. `Terraform Plan Staging`の`Create saved Terraform plan` logを確認する。
5. Plan summaryに表示されたrun IDを入力し、`TERRAFORM_APPLY_APPROVER`本人が`Terraform Apply Staging`をRun workflowする。Environment reviewerも設定した場合はpending deploymentを開き`Review deployments`から承認する。
6. Applyと`Deploy Staging`が次の順で自動完了することを確認する。初回Turnstile作成時はApply summaryのpublic site keyとCloudflare Dashboardのsecret keyを`staging`へ登録し、入力不足で停止したDeploy jobをrerunする。

```text
saved plan integrity / exact main SHA check
-> owner approval
-> terraform apply
-> staging Chromium install
-> frontend build
-> Neon direct URLでmigration
-> ephemeral secrets file作成
-> Wrangler deploy Worker + Container + assets
-> secrets file削除 (always)
-> /healthz, /readyz smoke test
-> unique anonymous accountのGoal / Cycle / Review / History critical journey
-> 公開account-delete APIでaccount cleanup
```

Migrationに失敗した場合、Wrangler deployへ進みません。Wrangler deploy後のsmoke testまたはcritical journey失敗では新deploymentが存在するため、Cloudflare Workers Builds/Deployments、Logs、Container statusをすぐ確認します。Critical journeyはtrace、screenshot、videoを保存せず、account cleanup失敗もworkflow失敗として扱います。Application入力の初回設定漏れなどでDeployだけ失敗した場合は、値を修正して同じ`Deploy Staging` runのfailed jobをrerunします。`workflow_dispatch`はmain HEADのApplication再deploy/復旧用に残しますが、Terraform変更を迂回する用途には使いません。

Custom domainは [`cloudflare/wrangler.jsonc`](../cloudflare/wrangler.jsonc) の`custom_domain` routeから作られ、CloudflareがDNS recordとcertificateを管理します。同名DNS recordが既にある場合は内容・利用者を確認し、不要と確認できたrecordだけをDashboardから除去して再deployします。`workers.dev`とpreview URLは無効です。

[Protected Response identity binding](./design.md#201-common-conventions)を変更するreleaseでは、Backend Headerと検証するFrontend bundleを同じrelease candidateとして検証します。既に開かれているtabは新しいhashed assetへ自動移行せず、additive Response Headerを旧bundleが無視し得るため、次をrelease記録へ残します。

- Closed Beta testerへ全tabのreloadを案内し、旧tabが残っていないことを確認してからaccount-switch検証を開始する。
- Fresh tabのNetwork記録で`/api/v1`の`Cache-Control: no-store`、認証済みResponseの`X-Fukamu-Authenticated-User-ID`、配信assetの対象commitを確認する。Header値やUser ID自体をrelease記録へ転記しない。
- 同一Browser Contextの二tabでidentity切替journeyを実行し、旧tabがreloadなしでauthoritative Userへ収束することを確認する。失敗時はreleaseを停止し、required request Header等の非互換なad-hoc gateで迂回しない。

## 9. Post-deploy verification

- Deploy workflowのsmoke stepで`https://cycle.staging.fukamu.matoruru.com/healthz`と`/readyz`が200。
- 続くcritical journeyがunique anonymous accountでGoal作成、P/D/C/A保存、Cycle完了、Review遷移、次Cycle開始、HistoryのGoal V1/Cycle 1/Cycle 2確認を行い、公開`DELETE /api/v1/account`でaccountを削除して成功する。
- 配信されたHTMLに`<meta name="robots" content="noindex, nofollow">`があり、Stagingが検索engineへindex/follow拒否を指示している。
- Browserでcertificate/mixed-content/CSP errorがない。
- Anonymous bootstrapがTurnstile hostname/action検証を通る。
- Google login/upgrade、save、AI generate/refine、account deletionを検証dataで最小回数確認する。
- Workers Logs/TracesとOTLP payloadにsecret、PDCA本文、email、raw user ID/IP、raw Turnstile tokenがない。
- Backendの実span / metricが承認済みcollectorへ到達し、固定`service.name`を持つ。Collector障害中も`/readyz`と代表Application requestが影響を受けない。
- Neon connections/latency、Container cold start、5xx、AI usage/costが承認済みlimit内。
- `cycle.staging.fukamu.matoruru.com`以外のhostnameと`workers.dev`から利用できない。

Stagingはpublic internetから到達可能です。URLの秘匿はaccess controlではありません。機密情報、Production data、失えないdataを入力しません。限定公開が必要ならCloudflare Accessを別途設計し、Google GIS/Turnstile/APIへの影響を検証してから導入します。

## 10. Rollback / recovery

Application rollback:

1. Cloudflare Dashboardで対象deployment、Container rollout、logsを確認する。
2. Schemaが旧codeと互換な場合だけ、直前の成功した`Deploy Staging` workflow runを再実行する。Manual dispatchはcurrent main HEADだけを対象とする。
3. Schemaに関係する場合は[`database.md`](database.md)のmigration-first/expand-contract規則に従う。DB resetや既存migration編集で復旧しない。

Post-deploy critical journey失敗ではmigrationを自動downしません。Account cleanup失敗は[`operations.md`](operations.md#staging-critical-journey-cleanup)の公開delete再試行だけで処理し、raw DB correctionを行いません。Schema互換なら直前Wrangler deploymentへのrollbackを検討し、非互換ならforward fixします。

OTLP collector障害だけを理由にApplicationをrollbackせず、bounded retry後の固定diagnosticとWorkers Logsを使って切り分けます。Exporter composition自体に新version固有の障害がある場合はstructured logsを維持できる直前versionへ戻します。Header credential漏洩が疑われる場合はexportを止め、provider側credentialをrotate / revokeし、必要なprovider-side telemetry削除手順を実行します。

Terraform recovery:

1. Terraform Plan/Apply workflowとmanual remote state操作を停止し、実行中のwriterがないことを確認する。
2. 成功したApply summaryまたはprivate R2 inventoryから同じprefixの `.tfstate` / `.tfstate.sha256` pairを選ぶ。State本文、checksum、credentialをissueやchatへ転記しない。
3. Access-controlledな一時workspaceで両objectを取得し、SHA-256とstate envelopeを確認する。Source backup objectは変更・削除しない。
4. Live keyではない新しい `fukamu-cycle/staging/state-restore-drills/` keyへcopyし、そのkeyだけでbackendを初期化する。`terraform state pull`のchecksum一致と `terraform plan -refresh=false -lock=false`を確認する。
5. Drillではlive `fukamu-cycle/staging/terraform.tfstate`へ `state push`、copy、overwriteを行わない。Live state復旧が本当に必要な場合は、確認済みbackup、現在resource、expected diffを添えた別のowner-reviewed maintenanceとして復旧方法を決める。
6. Drillのisolated state/lockだけを削除し、source backup/checksumは保持する。保持期間が決まるまで自動cleanupを追加しない。

Lockが残った場合は実行中のApplyがないことを確認し、lock所有情報を調査してから対応します。安易なforce-unlockをしません。TurnstileをDashboardで手動変更した場合はdriftをPlanで確認し、Source of TruthをTerraformへ戻します。

## 11. Teardown

Staging停止は通常deployとは分離します。次の順でdata/secret所有者と復旧不要を確認してから実行します。

1. GitHub `staging` Environmentを保護し、新規deployを止める。
2. Worker/Container custom domainを無効化する。
3. Neon dataが破棄可能と確認してproject/branchを削除する。
4. Turnstile widgetのTerraform destroyは`prevent_destroy`を解除するreview済み変更として行う。
5. GitHub/Cloudflare/Neon/OpenAI credentialsをrevokeする。
6. R2 state bucketは監査・復旧不要を確認するまで最後に残す。

## Production

Production infrastructureと自動deployはまだありません。公開domainは`cycle.fukamu.com`とし、Production専用のCloudflare Worker/Container config、Neon project、Turnstile widget、Google client、R2 state、GitHub Environment、capacity/backup/alert値を設計します。初回公開時は [`closed-beta-admission.md`](closed-beta-admission.md) のAdmission inputsを`closed`で設定し、未招待Anonymous bootstrapをfail-closedにします。Stagingのhostname、secret、DB、state、provider limitをcopyしてProduction扱いにしません。
