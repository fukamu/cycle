# Cloud deployment・運用

この文書はTerraform bootstrap、Staging deployment、監視、incident、rollback / restore、Production運用準備のSource of Truthです。Application仕様は [`design.md`](design.md)、正確な環境変数名・分類・validationは [`environment.md`](environment.md)、Database / Migrationは [`database.md`](database.md)、一時Closed Betaの発行・失効・撤去は [`closed-beta-admission.md`](closed-beta-admission.md) が所有します。現在実装済みのcloud targetはStaging Lightだけで、Productionは未構築です。

## Environment・ownership

| Environment | Purpose | Deployment / isolation |
|---|---|---|
| Development | local開発 | 手動起動、local PostgreSQL、Fake AI / Turnstile可 |
| Test | CI / E2E | job専用PostgreSQL、external providerはtest double |
| Staging Light | external integration検証 | main SHAの成功CI → Terraform Plan → 実infra差分時だけowner承認Apply → Plan / Apply証跡付きmigration-first Cloudflare deploy。`cycle.staging.fukamu.matoruru.com`と専用resourceだけを使用 |
| Production | 正式公開 | 未構築。公開domainは`cycle.fukamu.com`で、Stagingとは別resource / state / credentialを使用 |

Staging Lightは`APP_ENV=production`でproduction security validationを通しますが、Production相当のSLA、backup、data retentionは保証しません。破棄可能な検証dataだけを使い、StagingのDB、session、IndexedDB、credentialをProductionへ移しません。

```text
Browser
  -> Cloudflare custom domain / TLS / DDoS protection
  -> Worker
       -> frontend/dist static assets
       -> /api/*, /healthz, /readyz
          -> singleton Cloudflare Container / Go API
             -> Neon PostgreSQL pooled connection
             -> Google Identity / Turnstile / OpenAI

GitHub Actions
  -> successful main SHA CIからTerraform saved planを作成
  -> owner承認後、同じplanでCloudflare Turnstile widgetをApply
  -> Neon direct connectionでmigration
  -> WranglerでWorker + Container + assets + runtime secretsをdeploy

R2
  -> Terraform state / lock、retained pre-Apply backup / checksum、temporary restore-drill key
```

CloudflareのDDoS protectionは自動有効ですが、Application rate limit、Turnstile、authorization、OpenAI provider / application budgetを代替しません。

| Owner | Managed resources |
|---|---|
| Terraform workflows | Staging専用Turnstile widget、saved plan review、承認付きApply、pre-Apply state backup / restore drill |
| Wrangler / deploy workflow | Worker、Container image/config、static assets、custom domain、runtime secrets、application deployment |
| GitHub Actions | main / exact SHA gate、migration-first順序、smoke test、self-cleaning post-deploy critical journey |
| Manual bootstrap | Cloudflare account/zone/plan/token、R2 bucket、Neon、Google client、OpenAI limit、GitHub Environment protectionと入力 |

Worker / ContainerをTerraformとWranglerの両方で管理しません。Application releaseとDB migrationはTerraform stateへ入れません。

## Deployment input sheet

初回deploy前に次の判断とownerをpassword managerまたはaccess-controlled release recordへ記録します。Secret値そのものはissue、文書、Terraform variable、CLI argument、workflow logへ記録しません。正確なGitHub variable / secret名は [`environment.md`](environment.md) だけを参照します。

| Area | Required decision / identifier |
|---|---|
| Cloudflare | account ID、zone ID、zoneがActive、Workers Paid plan、operator |
| Domain | Staging canonical origin、同名recordの有無、domain owner |
| Container | `lite`、max instances `1`、APAC、idle sleep `10m`をStaging初期値として承認 |
| R2 state | private bucket、Plan Read Only / Apply Read & Write token owner、GitHub scope owner、snapshot保持期間、復旧方針 |
| Neon | Staging専用project / branch、region、compute / scale-to-zero、restore window、connection limit |
| DB connections | pooled runtime URL、direct migration URL、pool上限、管理 / migration接続余裕 |
| Session / CSRF | Session TTL、`CSRF_TOKEN_PEPPER` owner、CSPRNG由来256-bit相当の確認方法、stable CSRF release / drain確認者 |
| Google / Turnstile | Staging client / widget、authorized origin、hostname / action、secret owner |
| OpenAI | project / key owner、model、確認日、正式token単価、provider spend / rate limit |
| Telemetry | OTLP collector、header credential owner、sampler / export volume受入、retention、dashboard、alert、notification、on-call |
| App controls | AI budget、rolling / rate limit、tester、公開期間、紹介導線、post-deploy E2E用の非個人Invite owner |
| Operations | Terraform Apply approver、logs / traces確認者、cost確認、teardown / 継続判断日 |

Exampleやcode defaultを未決の運用承認値として使いません。特にOTLP接続先、Production retention / alert / backup、cleanup cadenceはownerが決めるまでrelease blockerです。

## Bootstrap・release

### Prerequisites

- Cloudflare zoneがActiveで、Workers Paid planが有効。
- Default branchが`main`で、対象SHAのCIがgreen。
- Bootstrap operatorがCloudflare、Neon、Google、OpenAI、GitHubへ必要最小権限でaccess可能。
- Local inspectionにTerraform 1.15.8、Node.js 24、pnpm 11.22.0、Gitを使用。
- Repository全体の事前検査 `./scripts/check.sh` が成功。

### R2 Terraform backend bootstrap

R2 bucketとS3 credentialはTerraformより先に必要なmanual bootstrapです。対象bucketだけのtokenを分離し、account管理token、Terraform Turnstile token、Wrangler deploy tokenと共有しません。

1. Private R2 bucketを作り、他用途と共有しない。
2. Plan専用のbucket-scoped `Object Read Only` credentialを作り、repository secretsへ登録する。
3. Apply専用の別のbucket-scoped `Object Read & Write` credentialを作り、`staging-terraform-apply` GitHub Environmentへ`TERRAFORM_APPLY_R2_ACCESS_KEY_ID` / `TERRAFORM_APPLY_R2_SECRET_ACCESS_KEY`として登録する。値はPlan tokenと異なるものにし、この2名をrepository secretへ登録しない。
4. [`backend.hcl.example`](../infra/terraform/staging/backend.hcl.example) をuntracked `backend.hcl`へcopyし、bucketとaccount IDだけを設定する。Credentialをfileへ書かない。
5. 障害調査でlocal remote readが必要な場合だけ、Plan用credentialを現在のBash processへ注入する。通常releaseをlocal Applyで迂回しない。

R2はTerraform S3 lockfileが使うconditional Putを提供しますが、HashiCorpのS3 backend検証対象はAmazon S3であり、R2にS3形式のobject version historyはありません。Applyの`use_lockfile = true`を維持します。PlanはRead Only credentialのため`-lock=false`を使い、repositoryのPlan / Applyを同じ`staging-terraform` concurrency groupで直列化します。並行するmanual remote state操作は禁止します。

### Terraform Plan / approved Apply

Turnstile EditだけにscopeしたCloudflare tokenをdeploy tokenから分離します。Repository / Environment inputのexact listとscope precedenceは [`environment.md`のGitHub Terraform inputs](environment.md#github-terraform-inputs) が正本です。

`Terraform Plan Staging`は`terraform plan -detailed-exitcode`を実行し、exit 0を`no_changes`、exit 2を`changes_present`、その他をfailureとして扱います。証跡はexact commit SHA、workflow run ID、saved PlanのSHA-256を含みます。`no_changes`は通常Deployへ直接渡せるinfra evidenceであり、Apply Environment、Apply credential inventory、state snapshot / read-back / restore drillへ進みません。

`Terraform Apply Staging`は`changes_present`の場合だけ使い、自動起動しません。Planをreviewした`TERRAFORM_APPLY_APPROVER`本人が、次のvalue-free inventoryを確認してからActions画面で成功したPlan run IDとexact confirmation `CONFIRM APPLY R2 INVENTORY NO FALLBACK`を入力します。Workflowの最初のpreflight stepはconfirmationだけを検証し、不一致なら`gh api`を含む外部accessへ進みません。その後actor / triggering actorの両方、source workflow、repository、success、main、`changes_present` artifact、current main HEADを検査し、不一致ならApply Environment credentialへ進みません。Rerunもconfigured approver本人だけが実行します。同じownerによるRequired reviewer承認は重ねず、別担当者との職務分離が必要な場合だけEnvironment reviewerを追加します。

```bash
gh secret list --app actions --repo fukamu/cycle --json name,updatedAt
gh secret list --app actions --repo fukamu/cycle --env staging-terraform-apply --json name,updatedAt
gh secret list --app actions --org fukamu --json name,visibility,numSelectedRepos,selectedReposURL,updatedAt
```

Commandはsecret値を返さず、名前、scope、更新時刻、Organization access metadataだけを確認します。RepositoryにはPlan用`TERRAFORM_R2_ACCESS_KEY_ID` / `TERRAFORM_R2_SECRET_ACCESS_KEY`があり、Apply専用名がないことを確認します。`staging-terraform-apply` EnvironmentにはApply専用`TERRAFORM_APPLY_R2_ACCESS_KEY_ID` / `TERRAFORM_APPLY_R2_SECRET_ACCESS_KEY`があり、Plan用名がないことを確認します。Organizationに4名のいずれかがある場合は`visibility`とselected repositories metadataをGitHub Settingsまたは`selectedReposURL`のvalue-free API responseで調べ、`fukamu/cycle`へ供給されないことを確認できなければdispatchしません。List権限不足、inventory欠落、同名fallbackの可能性、確認後のscope変更がある場合もconfirmationを入力せず停止します。

Cloudflare DashboardのR2 API token metadataで、Plan tokenが対象state bucketだけの`Object Read Only`、Apply tokenが同じbucketだけの`Object Read & Write`であり、別token record / identityであることを確認します。Access Key ID、Secret Access Key、token値を表示、copy、log、Issue、release recordへ転記しません。GitHubは登録済みsecret値を再表示せず、workflowの`secrets` contextもsource scopeを返さないため、既存の`GITHUB_TOKEN`、R2 S3 credential、Terraform用Cloudflare tokenだけでEnvironment provenanceとCloudflare token recordの対応を自動証明する強い仕組みはありません。作成・rotation時の管理された登録と、各dispatchのmetadata inventory confirmationを境界とします。

```text
CI (main HEAD。PR検証treeを完全一致で再利用できなければ全check)
-> Terraform Plan Staging
   -> Object Read Only credentialでR2 stateをlockなしでread
   -> terraform plan -detailed-exitcode -lock=false -out=staging.tfplan
   -> no_changes / changes_present + SHA-256 + commit SHA + run ID付きartifact（7日）
-> no_changes: Apply / credential inventory / state操作をskipし、Plan evidenceをDeployへ渡す
-> changes_present: ownerがvalue-free credential inventoryを確認し、Plan run IDとexact confirmationを指定してTerraform Apply Stagingをmanual dispatch
-> inventory confirmationを外部access前に検証
-> actor / triggering actor / source Plan / artifact / current main HEADを検証
-> staging-terraform-apply Environment
   -> Environment専用名のObject Read & Write credentialを最初のApply stepで検証
   -> 解決値が空ならApply job内のGitHub API / checkout / artifact downloadより前に停止
   -> 不正credentialはbackend init / state取得、write scope不足は最初のR2 writeで停止
   -> saved plan再検証とlock対応backend init
   -> live state snapshot / checksum / isolated restore drill
   -> 同じsaved planをlock付きapply
-> Apply metadata artifact（source Plan run ID / checksum付き）
-> Apply完了。Deployは自動起動しない
-> configured approverがno-change PlanまたはApply evidence run IDを指定し、別途Deploy Stagingをmanual dispatch
```

Plan中にdestroy / replaceがないこと、hostnameとTurnstile modeが承認値であることを確認します。Mainが進んだ、stateが別経路で変化した、artifactがstale / expiredの場合はPlanを破棄し、新しいCI / Planからやり直します。Saved planとTerraform stateはsecret相当としてdownload・転記・長期保存しません。

Scheduled `Security audit`がfailure、cancel、timeout等の非成功で完了した場合、Terraform Plan、Terraform Apply、Deployは、そのrunより後にscheduledまたはmanualのfull auditが成功するまで共通preflightで停止します。固定titleのIssueを調査し、修正をmainへ反映した後、current mainから`Security audit`を新しくmanual dispatchして成功を確認し、新しいPlanからreleaseをやり直します。Auditはmainのattempt 1だけを受け入れ、full scan完了時にもaudited SHAがcurrent mainであることを確認します。一度復旧すれば、その後のmain commitは独立した`Release security`で検証されるため追加auditは不要です。既存runのRe-run、Issueのclose、workflow名やpathの異なるrunでこのgateを迂回しません。GitHub APIの取得失敗やlatest stateのschema不一致は停止として扱います。

### Manual Staging Deploy approval

`Deploy Staging`は`workflow_run`から自動起動しません。Dispatch inputとrepository variableのexact contractは[`environment.md`のGitHub Staging Deploy input](environment.md#github-staging-deploy-input)を正本とします。

- 通常releaseはTerraform evidenceとは別の明示承認とし、reviewしたexact-current-mainの成功`no_changes` PlanまたはApply run IDを指定する。Workflowはinput形式とmodeの組合せをGitHub API accessより前に拒否し、その後configured approver、Plan / Apply workflow identity、repository、main、success、head SHA、artifact inventory、Plan checksum / provenance、current main、同一SHAの成功CIを検証し、`changes_present` Planの直接Deployを拒否する。
- Application recoveryは通常releaseと別の`mode=recovery`でdispatchし、Terraform evidenceを空にする。Current main、configured approver、同一SHAの成功CI、schema compatibilityを満たすApplication復旧だけに限定し、Terraform変更を含む通常releaseや任意commitのDeployへ使わない。
- Preflight成功後も`staging` Environmentのreviewer gateを維持できる。Environmentへ入る直前にcurrent mainを再取得し、検証済みSHAから進んでいればtraffic切替前に停止する。
- Actual Apply、Deploy、secret / credential設定、権限変更、live provider smokeは、それぞれの実行時に個別承認を得る。事前のIssue / Pull Request承認をlive変更の承認として扱わない。

#### Pre-Apply state snapshot and restore drill

`changes_present` PlanのApplyは最終main HEAD確認の直後に [`backup-and-drill-terraform-state.sh`](../scripts/backup-and-drill-terraform-state.sh) を実行します。`no_changes` Plan経路ではこのscriptによるsnapshot / read-back / restore drillとstate writeを実行しません。

1. `terraform state pull`をprivate runner tempへ`umask 077`で保存し、state envelopeと16 MiB上限を検証する。
2. SHA-256を計算し、stateと`.sha256`をconditional putで新規作成する。既存objectは上書きしない。
   - `fukamu-cycle/staging/state-backups/<commit-sha>/<utc-timestamp>.tfstate`
3. 両objectを読み戻し、local snapshot、保存checksum、read-back bytesの一致を確認する。
4. 検証済みstateを`fukamu-cycle/staging/state-restore-drills/<commit-sha>/<run-id>-<attempt>/terraform.tfstate`へcopyし、別backend keyで初期化する。
5. Isolated backendから`terraform state pull`でき、sourceとstate envelope identity（version / serial / lineage）が一致することを確認する。`state pull`はcurrent Terraform形式へ再serializationするため、そのstdoutをraw objectのbyte checksumには使わない。
6. Backend経由のpull後にisolated R2 objectを再取得してsource checksumと一致することを確認し、`terraform plan -refresh=false -lock=false`を実行する。Live stateへ`state push`しない。
7. Isolated stateとそのlockだけを削除する。Upload response loss時もcleanupを試行し、cleanup失敗時もApplyを停止する。

Snapshot、checksum upload / read-back、drill、cleanupのいずれかが失敗した場合、`terraform apply`へ進みません。保持期間は未決のため、現在の契約は **automatic snapshot deletion is disabled** です。`state-backups`配下のstate / checksumをworkflowから削除しません。成功時はbackup keyだけをsummaryへ記録し、本文やcredentialを出力しません。

### Managed service bootstrap

Neon:

1. Productionと共有しないStaging専用project / branchを作る。
2. Application database / role、region、scale-to-zero、restore window、connection上限をinput sheetへ記録する。
3. Pooled URLをruntime、direct URLをmigration専用としてGitHub `staging` Environmentへ別々に登録する。
4. 両URLのTLS設定を維持し、Terraform、example、issue、workflow outputへ置かない。
5. `DB_MAX_OPEN_CONNS × Container max instances`にmigration / 管理余裕を足し、Neon上限以下にする。初回schemaはdeploy workflowが作成し、developer PCから適用しない。

Google Identity / Turnstile / OpenAI:

- Staging専用Google Web Clientを作り、canonical Staging originをauthorized originへ登録する。このflowではclient secretを使わない。
- Terraformが作成したTurnstile site keyとDashboardのsecret keyを別々のGitHub入力へ登録し、hostnameと`anonymous_bootstrap` actionを固定する。
- Staging専用OpenAI keyを使い、provider hard limitとApplication budgetを両方設定する。Model、reasoning effort、price model、正式単価を同じreviewed releaseで整合させる。Model / Prompt変更は [`development.md`のAI quality evaluation](development.md#ai-quality-evaluation) を先に通す。
- OTLP collector、credential owner、sampler / export volume受入が未決の間はStaging deployを実行しない。

Cloudflare application deploy tokenは対象account / zoneのWorker、Container、custom domainに必要な最小権限だけを持たせ、R2 / Terraform tokenと共有しません。

### GitHub Environments and deployment inputs

- `staging-terraform-apply`: Apply専用名のR2 Read & Write credentialだけを保管し、同名をrepositoryへ登録せず、deployment branchを`main`へ制限する。
- `staging`: Application runtime / migration / deploy inputsを保管し、deployment branchを`main`へ制限する。
- Exact secret / variable list、Closed Beta追加値、Frontend public mappingは [`environment.md`](environment.md) だけを更新する。
- Workflowは [`deployment-contract.json`](../config/deployment-contract.json) から入力分類を導出し、Worker parserとBackend typed config checkerをmigration前に実行する。
- Runtime pooled URLとmigration direct URLを混同せず、migration secretをWorker / Containerへ渡さない。
- OptionalなApplication紹介導線は承認済み固定root URLだけを許可し、User Dataを共有payloadへ含めない。

### First deployment

1. Terraform repository inputsと`staging-terraform-apply` Environmentを設定する。
2. `staging` Environmentを [`environment.md`](environment.md) に従って設定する。Turnstile未作成の初回はApply後にpublic site keyとsecret keyを追加する。
3. 対象変更を`main`へmergeし、同じcommitの`CI`成功を確認する。
4. `Terraform Plan Staging`をreviewする。`changes_present`の場合だけowner本人がPlan run IDを指定して`Terraform Apply Staging`をdispatchする。
5. Applyが必要でOptionalなEnvironment reviewer gateがある場合はpending Applyを明示Approve / Rejectし、Applyの成功を確認する。
6. `STAGING_DEPLOY_APPROVER`本人が`mode=normal`と成功したno-change PlanまたはApplyの`infra_evidence_run_id`を指定し、`Deploy Staging`を別途manual dispatchする。
7. `staging` Environmentのreviewer gateがある場合はpending Deployを明示Approve / Rejectする。
8. `Deploy Staging`が次の順で完了することを確認する。

```text
configured approver / dispatch input / exact main SHA / CI / no-change Plan or Apply evidence check
-> staging Environment approval
-> staging Chromium install
-> frontend build
-> 現在配信中Stagingの/healthz + /readyz blocking preflight
-> 同じBrowser processで一度だけanonymous bootstrapし、legacy Sessionを二度取得して、同一Userでtokenが変化することをmutation前に確認
-> Cloudflare Worker / Container baseline取得
-> Neon direct URLでmigration
-> ephemeral secrets file作成
-> Wrangler deploy Worker + Container + assets（candidate SHA tag）
-> secrets file削除 (child trap)
-> candidate-only old-image drainをauthoritative metadataの連続2観測で確認
-> 同じBrowser process / Contextの二tabでstable convergence、unsafe操作、拒否、Account Deleteを確認
-> drain-pending recordと、smoke成功後だけのseparate markerを保存
-> /healthz, /readyz smoke test
-> Goal / Cycle / Review / History critical journey
-> 公開account-delete APIでaccount cleanup
```

Generic pre-switch hard gateはmigration、Worker secrets file作成、Wrangler deployより前に、現在配信中のStagingへ`/healthz`と`/readyz`だけを確認します。Stable CSRF初回rolloutでは#139の同一Browser process / ContextだけがAdmission off / closedの自動判定、Turnstile anonymous bootstrap、legacy Sessionを所有します。同じDeploy runでgeneric anonymous journeyを先行させるとTurnstile / anonymous-create rate-limitを自己消費し得るため、manual `baseline` diagnosticは実行しません。#139のpre-mutation evidenceが失敗した場合はrelease mutationへ進まず、post-deploy smokeまたはaccount cleanupが失敗した場合はreleaseを成功としません。

Post-deploy `full`だけがcandidateの`BETA_ADMISSION_MODE`を使い、`off`ではInvite Tokenをharnessへ渡しません。Candidate critical journeyまたはcleanupの失敗ではreleaseを成功としません。Migration失敗時もWrangler deployへ進みません。Recovery modeはApplication authorization boundaryであり、stable初回rolloutのpartial resumeやsmoke bypassには使いません。

`Deploy Staging`のattempt 1が失敗した場合、同じworkflow runを一度だけ安全に再試行できるのは、attempt 1が`completed` / `failure`であり、自動生成されたcheckpointをhuman audit用artifactとexact immutable Actions cache key `staging-deploy-retry-<commit>-<run-id>-1`へ保存し、attempt 2が同じkeyから復元したfileについて次の全条件を満たす場合だけです。

- `result=no_mutation_started`かつ`mutationBoundary=not_crossed`である。
- 一時accountをまだ作り得ない`cleanupState=not_started`、または公開Delete 204と旧Session 401を確認した`cleanupState=verified`である。`unverified`は受理しない。
- Repository、workflow path、同じrun ID、source attempt 1、candidate SHA、deploy mode、configured operator、exact-main CI run、mode固有のno-change Plan / Apply evidenceが今回の入力と完全一致する。
- Fallback keyを使わないexact cache hitであり、復元したcheckpointが許容size内の通常fileで、strict schemaを満たす。Audit artifactは人がattempt 1を確認するための証跡であり、rerun間のruntime transportには使わない。

条件を確認できた場合だけ、Actions画面から同じrunの`Re-run all jobs`を選びます。WorkflowはrerunのUI種別そのものではなく、attempt 2のdeployが同じattemptで生成されたfresh resolve outputを受け取ったことを検証します。Deploy jobだけを対象にして成功済みresolverを再実行しない`Re-run failed jobs` / selected-job rerunは拒否されます。Resolverとdependentを対象にしたselected-job rerunがfresh resolve条件を満たし得る場合も、運用手順としては使用しません。Attempt 2はcurrent main、同一SHAの成功CI、通常modeのno-change Plan / Apply evidenceまたはrecovery modeの空のTerraform evidence、actor / triggering actorを再検証して最初から実行し、途中phaseから再開しません。Attempt 2の失敗後はattempt 3を実行せず、cache miss、checkpoint fileの欠落、cancel / timeout、schema / binding不一致も安全の証拠として補完しません。

Custom domainは [`wrangler.jsonc`](../cloudflare/wrangler.jsonc) が所有し、CloudflareがDNS recordとcertificateを管理します。同名recordがある場合は所有用途を確認し、不要と確認できたrecordだけをDashboardから除去します。`workers.dev`とpreview URLは無効のまま維持します。

### Legacy PDCAI origin retirement

旧`https://pdcai.matoruru.com`は現行Stagingとは別のlegacy Worker `pdcai-staging`が所有する。B2のprivacy / retention契約は[`design.md` §41.12](design.md#4112-legacy-pdcai-origin-retirement)、approver inputは[`environment.md`](environment.md#github-legacy-origin-retirement-input)を正本とする。専用[`retire-legacy-origin.yml`](../.github/workflows/retire-legacy-origin.yml)は自動起動せず、通常のTerraform Plan / Apply / Deployを代替しない。

Cutover前に次を満たす。

1. B2判断と、recovery / migrationを提供しないことがIssueへ記録されている。
2. Retirement artifactを含むcurrent main SHAのCIが成功している。
3. Repository variable `LEGACY_RETIREMENT_APPROVER`が実行ownerと一致し、`staging` Environmentを`main`だけに制限している。
4. Cloudflare deploy tokenが旧Workerと`pdcai.matoruru.com` custom domainを変更できる最小scopeを持つ。Token値や旧Worker secret値を確認記録へ出さない。
5. 旧originで旧interactive HTMLが配信中であることだけを本文・credentialなしで確認し、旧DB内容や件数を収集しない。

Actions画面で`Retire Legacy PDCAI Origin`を`main`からmanual dispatchし、exact confirmation `RETIRE pdcai.matoruru.com WITHOUT RECOVERY`を入力する。Workflowはactorとtriggering actor、confirmation、dispatch時のSHA、current main、成功CIをEnvironment credentialの前に検証し、同じ旧Worker名へ[`legacy-retirement/wrangler.jsonc`](../cloudflare/legacy-retirement/wrangler.jsonc)のstatic assetsだけをdeployする。Application DB migration、現行Worker、Container、Turnstile、Terraform state、Application runtime secretを変更しない。

Deployment後はworkflowのsmokeで次を確認する。Deploy直後に旧edge cacheがHTTP 200で残る伝播競合を考慮し、全条件が同時に成立するまで最大12回、5秒間隔で再評価する。

- root responseがversion `2` retirement markerとCSP / noindex headerを返す。
- `/api/session`が`404`で、旧Backend APIが公開されていない。
- Browserで旧tabを開いたまま別tabからretirement pageを開くと、成功表示ではなく旧tabを閉じてRetryする案内になる。
- 旧tabを閉じてRetryするとcleanupが完了し、reloadしてもrepeat可能である。
- 専用test profileではcurrent-user fresh / other-user freshを保持し、expired / invalidを削除し、現行Cycle IndexedDBを変更しない。実利用者のrecord本文・Raw User ID・件数をinspectionしない。

Cutover後24時間未満はvalid fresh recordを削除するための全消去へ変更しない。24時間経過後も同じpageを配信し、再訪browserでは`updatedAt`基準のcleanupにより全legacy recordを削除対象にする。再訪しないbrowserのorigin storageはremote削除不能であり、削除完了として記録しない。旧custom domain停止、旧Worker / Container削除、残存secret削除はこのworkflowに含めず、影響と復旧不要を確認した別のowner-approved teardownで扱う。

Retirement切替後に旧interactive Applicationをrollbackしてはいけない。問題時はDB version `2`以上とstatic-only / no-API境界を維持したforward fixをcurrent mainからreview・deployする。

### Protected response identity release

[Protected Response identity binding](design.md#201-common-conventions)を変更するreleaseではBackend HeaderとFrontend bundleを同じcandidateとして検証し、release記録へ次を残します。

- Testerへ全tabのreloadを案内し、旧tabが残っていないことを確認する。
- Fresh tabで`/api/v1`の`Cache-Control: no-store`、認証済みResponse Header、配信assetのcommitを確認する。Header値やUser IDを記録へ転記しない。
- 同一Browser Contextの二tabでidentity切替journeyを実行し、旧tabがauthoritative Userへ収束することを確認する。失敗時はreleaseを停止し、ad-hocな互換gateで迂回しない。

### Session-bound stable CSRF v1 release

意味とbyte-exact contractは[`design.md` §27.2](design.md#272-csrf)、key inventoryは[`environment.md`](environment.md#backend-runtime)が所有します。この節はstable v1変更をreleaseする際のgateを所有し、Production Apply / Deployそのものを承認しません。

Release前に次を満たします。

- Candidateがstable token発行、legacy / stableのdual-validation、active / expiry guard下のidempotent convergenceを同時に含み、[`design.md` §48](design.md#48-testing-strategy)のgolden vector、実DB / HTTP concurrency、multi-tab E2E、旧 / 新Application・旧 / 新key matrixを完走している。
- 通常releaseと同時に`CSRF_TOKEN_PEPPER`を変更しない。Initial single-key contractでは旧key / 新key instanceの混在とplannedな無停止rotationを許可しない。
- Productionは、Production専用`CSRF_TOKEN_PEPPER`がCSPRNG由来256-bit相当であることを、secret値を表示・log・release記録へ転記せず確認する。確認不能ならProduction deployを停止し、先に[maintenance rotation](#csrf_token_pepper-rotation)の要否を判断する。

Rolloutと確認は次の順で行います。

1. 同一candidateのCI / release gateを通す。Deploy前に同じpublic Sessionでtokenを二度取得し、同一Userのtokenが変化するlegacy baselineだけを受理する。Stable同値、identity変更、形式不正、取得失敗ではmigration / deployを開始しない。Dual-validationを含むApplicationのCloudflare deploy成功はrollout開始であり、旧image drain完了の証拠として扱わない。
2. Mixed-version中は旧Backendがlegacy random verifierを再保存し、新Backendがstable verifierへ収束させ得る。旧Backend自身はderived stable validationを知らないため、一時的な`403 CSRF_INVALID`をavailability上のdegraded behaviorとして受容するが、Origin、CSRF、Expected User、Session guardを緩和しない。
3. [`design.md` §41.5](design.md#415-csrf--session)のauthoritative drain条件を、Deploy前後のWorker deployment / version / tagとContainer application / rollout / instanceのbounded API取得で確認する。Rollout履歴は固定page上限の`limit` / `last` paginationで切り詰めを検出し、baseline後に増えた履歴全体の件数ではなく、baseline versionから観測中のcandidate version / imageへ遷移するrolloutを一意に相関する。Candidate Worker version IDから固定Wranglerが生成した同一runner上のlocal image tagをshell非経由でinspectし、Cloudflare Registryのexact repository digestをrollout、Application、全running instanceへ束縛する。連続観測ではWorker、Application、相関rollout、version / image digestと、instanceが非emptyかつ全件running candidateだけであるsemantic stateを照合し、instance ID、配列順、または一時的な件数差だけでは失敗にしない。各観測の前後でactive stateが変わらないことも照合する。旧Worker version、旧Container image digest、candidate version / digest、rollout、確認時刻、確認者だけをaccess-controlled drain-pending recordへ残し、API取得不能、local candidate imageの一意なdigest取得不能、またはtimeoutでは停止する。
4. Drain後、同一Browser Contextの二tabで同時`GET /session`が同じtokenへ収束すること、片方をreloadした後も両tabのcommand / autosaveが成功することを確認する。CSRF token、Session ID、Response bodyを記録へ残さない。
5. Live smokeではconvergence後のlegacy token、invalid token / Origin、Account Delete後の旧Session、advisory欠落時のauthoritative recoveryを確認する。Expiry / revoke race、旧 / 新Application・旧 / 新key matrix、Google fake / Session rotationはartifactに記録するexact-main CI runの証跡へ対応付け、Google live provider確認が必要な場合は非個人test identityによる別のmanual checkpointとする。Drain-pending recordとは別に、同じCI run / Deploy run ID / attempt / commitへbindingした`smoke_passed` markerをlive smoke完了後だけ作成し、両方がある場合だけ初回live smoke成功とする。想定外の拒否が続く場合は新規deployを止め、security guardを迂回せず[Application rollback](#application)またはreviewed forward fixを選ぶ。

このone-time harnessではfixed childがread-onlyのdrain baselineとcurrent-main確認を終えた後、migration commandを呼ぶ直前にcheckpointのmutation boundaryを`crossed`へ遷移します。遷移に失敗した場合はmigrationを開始しません。遷移後の失敗、cancel、timeoutは、migration commandへ到達したと確認できない場合もmutation開始済みまたは不明として扱い、workflow rerunを行いません。Checkpointが欠落・破損している場合やcleanupを証明できない場合も`no_mutation_started`と推測しません。新規Deployを停止し、safe metadata artifactを保全してauthoritative Worker / Container stateを確認します。Exact baselineへ戻せるschema-compatible rollbackは個別のlive承認後にold-version drainまで確認し、それ以外はreviewed forward fixを選びます。Migration down、pepper変更、legacy smoke waiver、自動rollbackは行いません。Drain済みでも`smoke_passed` markerがなければ初回rollout受入は未完了です。

G10は同じrunのattempt 2を証跡で認可する仕組みであり、別のmanual dispatchを過去runの状態から機械的にblockするものではありません。Child spawn以降または状態不明時は、Actions画面で新しいdispatchを開始できても、Operations ownerが新規dispatchを停止したままauthoritative recoveryを完了させます。

Workflow artifactは90日保持の一時checkpointであり、180日後のlegacy verifier削除判断の正本にはしません。Actual live rolloutでは、drain-pending recordと`smoke_passed` markerのsafe metadataを失効前に承認済みのaccess-controlledな長期release recordへ保全します。対応する長期記録がなければdrain時刻を推測せず、legacy verifier削除を解禁しません。

初回rollout成功後、このharnessはstable baselineをlegacy未確認として意図的に停止します。次のlive Deploy前に、#139の`smoke_passed` artifact / runを根拠としてsteady-state gateへ置換する別Issue / Pull Requestを完了します。Runtime inputやRecovery modeでone-time gateをskipしません。

現在のStagingは`max_instances: 1`の固定singletonでも旧imageから新版へ切り替わる一回の失効があり得ます。将来`max_instances > 1`へ変更する前に、dual-validationだけを全instanceへ先行配備してdrainを確認し、その後のstable issuanceを二段階release / issuance flagとして別Issue / Decision gateで仕様化します。単一DB列を旧版と新版が交互に上書きする状態を互換保証として扱いません。

`csrf_token_hash`とlegacy verifier pathはこのreleaseで削除しません。上記の旧image drain確認時刻から180日が経過した後に限り、別Issue / Decision gateで削除可否を判断します。既存baseline migrationを編集せず、この条件成立だけで自動削除・migration追加を行いません。

## Post-deploy verification

1. Commit SHA、Plan / Apply runとapprover、Cloudflare deployment / version、Container rollout、migration runをrelease記録へ残す。
2. [Health check](#health-check)が継続して成功し、5xx、latency、cold start、Neon connectionがbaseline内であることを確認する。
3. Self-cleaning critical journeyがGoal Draft autosave、Goal開始、P/D/C/A、Cycle完了、Goal Review、次Cycle、HistoryのGoal V1 / Cycle 1 / Cycle 2まで成功する。
4. 同journeyの公開account-delete cleanupが成功し、session再確認が401へ収束する。
5. 配信HTMLがStagingの`noindex, nofollow`を持ち、certificate / mixed-content / CSP errorがない。
6. Turnstile hostname / action、Google login / upgrade、Goal Refine、Action Generate / Refine、account deletionを検証dataで最小回数確認する。
7. Workers Logs / TracesとOTLP payloadにsecret、PDCA本文、email、raw user ID / IP、raw Turnstile tokenがない。
8. Backend span / metricが承認済みcollectorへ到達し、collector障害中も`/readyz`と代表Application requestが影響を受けない。
9. Neon、Container、OpenAI usage / cost、rate-limit拒否が承認済みlimit内であり、Anonymous createのUTC hour境界やrollout直後に想定外の許可・拒否burstがない。
10. Canonical Staging hostname以外と`workers.dev`から利用できない。

Stable CSRF v1を含むreleaseは、上記に加えて[専用のdrain / multi-tab gate](#session-bound-stable-csrf-v1-release)を完了します。

Stagingはpublic internetから到達可能です。URLの秘匿をaccess controlとして扱わず、機密情報、Production data、失えないdataを入力しません。

## Observability

- Cloudflare Worker / Containerのconsole出力をWorkers Logsで収集する。
- Cloudflare automatic tracesは5%、logsは100% sampleを維持する。
- Go safe JSON loggerは [`design.md` §42.2](design.md#422-structured-log-fields) のfieldだけを記録し、free-form message、unknown / malformed fieldを拒否する。
- Backend traceとserver-side metricをvendor-neutralなOTLP/HTTPでexportする。Browser Draft RecoveryはClosed Betaでは収集・export経路を持たない。正本は[`design.md` §42.3](design.md#423-minimum-metrics)とする。
- Cloudflare Analytics / Logs、Neon Monitoring、OpenAI usageを横断して確認する。

OTLP endpoint / header credential ownerと実値、retention、dashboard、alert、notification、uptime monitor、on-callはProduction release blockerです。Collector障害はApplication requestやreadinessを失敗させず、bounded retry後の固定diagnosticだけをWorkers Logsへ出します。Process終了時はHTTP requestをdrainしてからtrace / metric providerをflushします。

調査は`request_id` / `trace_id`から開始し、AIは`ai_generation_id` / `ai_operation_type`でDB / OpenAI spanへ追跡します。Raw path、query、remote address、panic値 / stack、provider responseを相関情報へ追加しません。Metric labelは低cardinalityのclosed valueに限定します。

### Health check

```bash
curl --fail --silent --show-error 'https://cycle.staging.fukamu.matoruru.com/healthz'
curl --fail --silent --show-error 'https://cycle.staging.fukamu.matoruru.com/readyz'
```

- `/healthz`: WorkerからContainer processへ到達できる。DBや外部APIは呼ばない。
- `/readyz`: startup config validation済みでDB pingが成功する。OpenAI / Google / Turnstile / OTLP collectorは毎回呼ばない。

Healthだけで機能正常を断定せず、5xx、latency、cold start、Neon connections、代表操作も確認します。

### Logs / error investigation

Cloudflare DashboardでWorker、deploy時刻 / version、Containerを絞り、`severity`、`error_class`、`error_code`、request / trace IDを確認します。PDCA本文、prompt / output、session / CSRF token、Google credential、email、raw user ID / IP、raw Turnstile tokenを検索・記録・転記しません。

OTLP failureでは固定error classと集約`failure_count`だけを確認し、endpoint、header、payload、provider raw responseをlogへ追加しません。調査記録は時刻、version、route template、status、error class / code、集約eventだけにします。

## Retention cleanup

対象predicate、dry-run / execute、1..1000のhard ceiling、Transaction、再実行、安全な出力、実commandは [`database.md`のRetention cleanup command](database.md#retention-cleanup-command) が所有します。AI Usage、rate bucket、Anonymous rate-limit guardは独立resourceとして件数と削除結果を確認します。Productionのbatch size、cadence、起動owner、job経路とDB / index影響を承認するまで、Productionではdry-runを含め実行・scheduleしません。

## Staging critical journey cleanup

`baseline`は現在配信中StagingのAdmission entry、Turnstile anonymous bootstrap、session discovery、公開account cleanupを別のoperator調査runで確認するnon-blocking diagnosticです。検出した失敗はwarning annotationとnon-zero exitで調査run自体へ通知しますが、Deploy workflowに接続しないためcandidate releaseをblockしません。Stable CSRF初回rolloutが存続する間はDeploy workflowから自動実行せず、日常monitorにも使いません。実行する場合は前のlive runとanonymous bootstrap TTL / rate-limitを確認し、候補releaseの合否判定や#139 gateの代替にせず、[`development.md`](development.md#staging-pre-switch-baseline--post-deploy-critical-journey)のsecret注入境界に従います。`full`はcandidate-publicのblocking post-deploy journeyです。

`baseline`と`full`はrepository / run ID / candidate commit / modeから同一runで安定する別のUUIDv7 bootstrap IDを作り、Raw IDを表示しません。各検証でBrowserを閉じてsessionを更新し、CSRF、expected-user binding、`{"confirmed":true}`を使う公開`DELETE /api/v1/account`だけでcleanupします。204とresponse identityを確認するまで1、2、4、8、16秒backoffで再試行し、最後に`GET /api/v1/session`が401であることを確認します。

失敗annotationはclosed enumの`target`、`mutation_started`、`cleanup_state`、`phase`、`reason`とGitHub run ID / attempt / candidate SHAだけを記録します。`target`は`current-public`、`candidate-public`、configuration不明時の`unknown`、`mutation_started`は`false`、`true`、configuration不明時の`unknown`です。Release mutationはmigration process、secret materialization、Application deployを指し、temporary account作成は含めません。`cleanup_state`はaccountを作らない`not_applicable`、create request前の`not_started`、create response-lossまたは削除証明前の`unverified`、公開Delete 204と旧Session 401を確認した`verified`です。`phase`は`configuration`、`browser_launch`、`health`、`readiness`、`bootstrap_seed`、`entry`、`session_discovery`、`goal_creation`、`cycle_editing`、`cycle_completion`、`review_transition`、`history_verification`、`account_delete`、`cleanup_verification`のいずれかです。`reason`は`entry_cta_timeout`、`anonymous_session_not_observed`、`anonymous_session_request_not_observed`、`anonymous_session_bad_request`、`anonymous_session_forbidden`、`anonymous_session_rate_limited`、`anonymous_session_unavailable`、`unexpected_status`、`session_discovery_failed`、`account_delete_failed`、`cleanup_unverified`のいずれかです。任意の例外message、URL query / fragment、token / cookie、account ID、email、本文、response body、screenshot、trace、video、profile、storage stateを記録しません。

1. Blocking preflightのhealth / readiness失敗ではrelease mutation前に停止する。別runのmanual `baseline`失敗はwarningとしてcleanup状況を調査するが、candidate releaseのblockerまたは成功証拠にしない。#139 child開始後またはpost-deploy `full`の失敗では新しいdispatchも開始せず、[stable CSRF release手順](#session-bound-stable-csrf-v1-release)のmutation unknown処理に従う。
2. Workers Logsではroute template、status、固定error class / code、request / trace IDだけを確認し、annotationへ相関用の識別子を追加しない。
3. TTL内でも失敗する場合は新規deployを止め、schema互換なら直前Wrangler deploymentへのrollback、非互換ならforward fixを選ぶ。Migrationをdownせず、SQL手動DELETE / UPDATE、Raw DB correction、別の管理削除経路を作らない。

## Cloud troubleshooting

最初にcommand / workflow、exit code / conclusion、対象environment、直前変更、固定error class / codeだけを記録します。Secret値やUser本文を貼りません。

| Symptom | Checks | Response |
|---|---|---|
| Terraform Planが開始しない | mainの同一SHA CI、workflow state | 同一SHAのCIを成功させる。PR検証treeを証明できなければmain全CIを待つ |
| Security audit release gateで停止 | 固定title Issue、最新scheduled non-success、それより後のscheduled / manual audit run | 原因を修正し、current mainから新しいmanual full auditを開始して成功させ、新しいPlanから再開する。既存runのRe-runやIssue closeで迂回しない |
| Apply preflightで停止 | actor / approver、Plan run ID、artifact期限、current main | Owner本人が最新成功Planを指定する。Stale / expired planを再利用しない |
| Applyがapproval待ち | `Review deployments` | Planをreviewした指定ownerがApprove / Rejectする。期限超過時は新Plan |
| Deployが開始しない | no-change Plan / Apply metadata、main SHA、workflow conclusion | CI → Plan → 必要な場合だけapproved Applyをやり直し、manual DeployでTerraformを迂回しない |
| Deploy attempt 1がmutation boundary前に失敗 | attempt 1のconclusion、safe retry artifactの`mutationBoundary` / `cleanupState` / SHA / mode / operator / CI / infra binding | Exact artifactが`no_mutation_started`を証明する場合だけ同じrunで`Re-run all jobs`を一度実行する。Fresh resolverを再実行しないdeploy-only / failed-job rerunや新しいdispatchへ置き換えない |
| Deploy rerunがStaging approval前に拒否 | run attempt、attempt 1 conclusion、artifactの一意性・期限・schema・binding、resolver output | Attempt 2の条件を補正・waiveしない。Attempt 3、partial rerun、cancel / timeout、artifact欠落・不一致は停止して原因を調査する |
| Input validationで停止 | Errorに出たkey名、[`environment.md`](environment.md) | 承認値を設定する。仮値を使わず、secret値は表示しない |
| Migrationで停止 | Neon branch / direct URL更新履歴 / SQL error、authoritative Worker / Container state | Child spawn後なのでrerun / 新規dispatchを停止する。[`database.md`](database.md)に従いforce / resetせず、schema-compatible recoveryを判断する |
| Wrangler deployで停止 | Token scope、Workers Paid、build / config、authoritative Worker / Container state | Child spawn後なのでrerun / 新規dispatchを停止する。状態確認後にschema-compatible rollbackまたはreviewed forward fixを選ぶ |
| Custom domain作成失敗 | DNS owner、zone Active、token zone scope | 所有用途を確認し、不要と確認できたrecordだけ除去 |
| `/healthz` 200 / `/readyz` 503 | Neon compute / pooled URL / pool | DB接続を修正。OpenAI / Google / Turnstile / OTLPをreadiness原因と誤認しない |
| Static assetsだけ404 | Frontend build、Wrangler assets output | Frontend build後にdeployし、API routingと分けて確認 |
| Deploy後5xx増加 | Version別logs / traces、schema互換性 | 互換なら直前成功commit、非互換ならforward fix |
| Stable CSRF release中に`CSRF_INVALID`が継続 | 旧image drain evidence、Application version、pepper変更履歴、Session recovery。token値は取得しない | Mixed-version中の一時的拒否とdrain後の不具合を分離する。Guardを緩和せず、drain / recoveryを完了するかschema-compatible rollback / reviewed forward fixを選ぶ |
| Logs / tracesが見えない | Wrangler observability、version / filter | 対象versionを修正し、secret / 本文の追加loggingで迂回しない |
| OTLP exportが届かない | 固定error class、集約failure、provider status | Request / logsを維持して切り分け、credential漏洩時はexport停止・revoke / rotate |

## Incident first response

### Database

1. Neon project / branch / compute、connection上限、storage、maintenanceを確認する。
2. Runtime pooled URLとmigration direct URLの混同を、値を表示せず更新履歴で確認する。
3. Pool上限×active Containerと実接続数を比較する。
4. Application起因ならschema互換性を確認してrollbackを判断する。
5. Data corruption疑いではwriteを増やす操作を止め、backup / restore判断へ移る。Resetしない。

### OpenAI / AI

1. AI error、latency、provider status、spend / rate limitを確認する。
2. Key、model、pricing設定の更新履歴を値なしで確認する。
3. Provider障害時にFake AIへ切り替えず、AI errorを返して非AI機能と分離する。
4. Cost急増時はApplication budget / rate limitとprovider hard limitを確認し、reviewed deployで修正する。

### Google Identity

Browser networkとserver error codeをcredential値なしで確認し、Google Client ID、Frontend build値、authorized origin、`PUBLIC_ORIGIN`の一致を確認します。Google側障害、config mismatch、既存anonymous sessionを分けて扱います。

### Turnstile

Anonymous bootstrap errorとSiteverify response classを確認し、Raw token / secretをlogへ追加しません。Frontend site key、Backend secret、Staging hostname、`anonymous_bootstrap` actionを照合します。Production profileでTurnstileを無効化せずfail-closedを維持します。

### Anonymous create rate limit

`429 RATE_LIMIT_EXCEEDED`が増えた場合は、release version、route template、UTC hour境界、集約された`rate_limit_rejected_total`、共有network利用の可能性を確認します。Raw IP、IP-HMAC、bucket / guard row、正確な解除時刻をlogやsupport記録へ転記しません。Frontendの自動Retryを有効化せず、利用者には時間を置いて手動Retryするよう案内します。Blocked attemptもcountされ、境界hourの保守的包含により待機が長時間残り得るため、繰り返しRetryや手動row削除で解消しません。

Guard migrationを含むreleaseはmigration-firstで適用し、旧Application instanceが完全にrollout対象から外れた後にだけper-IP直列化を保証済みとして扱います。Migration前またはmixed-version中の結果を新contractの検証結果へ含めません。想定外の拒否増加ではrate-limit値やDB rowをad-hocに変更せず、[`design.md` §39.2](design.md#392-default-operation-values)との整合、instance rollout、DB concurrencyを確認してreviewed forward fixまたはschema-compatible Application rollbackを選びます。

### Cloudflare Worker / Container

Deployment / version、Container rollout、Worker exception、cold-startを確認し、static-only、API-only、domain / TLS全体を切り分けます。DDoS mitigationとApplication 429 / 403を混同しません。

## Temporary Closed Beta Admission

Invite発行、新規redeem停止、Cookie key rotation、一般公開切替、7日間安定確認、物理撤去の唯一の手順は [`closed-beta-admission.md`](closed-beta-admission.md) です。このrunbookを撤去条件成立前に統合・削除しません。Raw Invite Token、digest、Admission Cookie、Cookie keyをlogへ追加せず、設定不備は既存Sessionではなく新規Anonymous bootstrapだけをfail-closedにすることを確認します。

## Environment / secret rotation

1. [`environment.md`](environment.md)でscope、secret / public、validation、影響を確認する。
2. Application値は`staging` Environmentでrotateする。Terraform Plan Read Only、Apply Read & Write、deploy tokenは別々にrotateし、各scopeを検証してから旧tokenをrevokeする。
3. 理由、時刻、owner、失効確認だけを記録し、値を記録しない。
4. `VITE_`対応値はFrontendをrebuildする。
5. Main CI → Plan → approved Apply → Deployを通し、healthと代表操作を確認する。Terraform不変のApplication復旧だけはcurrent main HEADからDeployをmanual dispatchできる。
6. `CSRF_TOKEN_PEPPER`は下記のsingle-key制約に従う。他のpepperも既存session / tokenへの移行影響を確認してから変更する。
7. OTLP credential / payload漏洩疑いではexport停止、revoke / rotate、provider-side retention / deletionを確認する。

### `CSRF_TOKEN_PEPPER` rotation

Initial single-key contractはplannedな無停止rotationをサポートしません。通常変更としてsecretだけを切り替えず、旧keyと新keyのinstanceを同時にuser trafficへ載せません。Keyring、複数keyのconstant-time検証、active epoch切替は別Issue / Decision gateで仕様化します。

緊急rotationはmaintenanceとして次の順で行います。

1. 影響、owner、maintenance開始、rollback判断者を記録し、新規releaseとunsafe trafficを承認済みのmaintenance境界で止める。切替前keyはrollbackに必要な期間だけaccess-controlled secret storeへ安全に保持し、値を記録へ出さない。
2. 旧keyを読むApplication instanceをdrainし、新旧key instanceが同時にtrafficを処理しないことを確認する。Drain evidenceがない状態でkeyを切り替えない。
3. Secret storeを新しいCSPRNG由来256-bit相当keyへ更新し、その単一active keyを読むcandidateをdeployする。旧tokenは即時無効となり、一時的な`403 CSRF_INVALID`と`GET /session`再discoveryを受容する。
4. 新imageのrollout / 旧image drainを確認してから、二tabのsession discovery、reload、unsafe command / autosave、旧token拒否、新token成功を検証する。Token値をlog、screenshot、recordへ残さない。
5. Rollbackする場合もmaintenanceを維持し、新key instanceをdrainしてから安全に保持した切替前keyとcompatibleなApplicationへ戻す。切替前keyが保持されていない場合は推測・log・artifactから復元せず、forward recoveryを判断する。

## Rollback・recovery

### Application

新version固有の5xx / readiness / 主要操作失敗、security / data corruption疑いでは新規deployを止めます。旧codeとDB schemaがcompatibleな場合だけ直前成功commitを再deployし、非互換ならforward fixします。Post-deploy journey失敗でmigrationを自動downしません。Collector障害だけを理由にApplicationをrollbackしません。

Stable CSRF releaseを同じ`CSRF_TOKEN_PEPPER`の旧Applicationへ戻す場合、保存済みstable verifierは旧版の通常比較で受理できます。ただし旧版の`GET /session`がlegacy random tokenを再発行するため、multi-tab相互失効の再発を既知のdegraded behaviorとしてrelease記録へ残します。Pepper切替を跨ぐrollbackは[`CSRF_TOKEN_PEPPER` rotation](#csrf_token_pepper-rotation)のmaintenance、instance drain、切替前key保持を必須とし、通常rollbackで新旧keyを混在させません。

### Database

Migration / destructive change / backup / restoreの判断は [`database.md`](database.md#destructive-migrationrollbackbackup) に従います。Reset、dirty versionの強制変更、既存migration編集、未reviewの手動data correctionを行いません。

### Terraform state

1. Plan / Applyとmanual remote state操作を停止し、writerがないことを確認する。
2. Apply summaryまたはprivate R2 inventoryから同じprefixの`.tfstate` / `.sha256` pairを選ぶ。本文やcredentialをissue / chatへ転記しない。
3. Access-controlled workspaceで取得し、SHA-256とstate envelopeを確認する。Source backupは変更・削除しない。
4. Live keyではない新しい`fukamu-cycle/staging/state-restore-drills/` keyへcopyし、そのkeyだけで`state pull`のenvelope identity、pull後のraw object checksum、`plan -refresh=false -lock=false`を確認する。
5. Drillではlive `fukamu-cycle/staging/terraform.tfstate`へpush / overwriteしない。Live復旧が必要ならbackup、current resources、expected diffを添えた別owner-reviewed maintenanceで決定する。
6. Drillのisolated state / lockだけを削除し、source backup / checksumは保持する。

Lock残存時は実行中Applyがないこととowner情報を確認し、安易なforce-unlockを行いません。Dashboardで手動変更したTurnstile driftはPlanで確認し、Source of TruthをTerraformへ戻します。

## Incident record

1. 発見時刻、影響、deployment / version、直前変更、request / trace ID、error / eventを記録する。
2. Incident leadを決め、通常deployを停止する。
3. Security / data lossを判定し、必要ならaccess制限、credential revoke、provider停止を権限者へescalateする。
4. 影響を止める最小変更を選び、cloud操作を記録する。
5. Healthと代表操作で復旧を確認し、監視を継続する。
6. 原因、timeline、user impact、再発防止、未検知理由をpostmortemへ残す。秘密値・個人dataは含めない。

## Teardown

Staging停止は通常deployから分離し、data / secret ownerと復旧不要を確認して次の順で行います。

1. GitHub `staging` Environmentを保護し、新規deployを止める。
2. Worker / Container custom domainを無効化する。
3. Neon dataが破棄可能と確認してproject / branchを削除する。
4. TurnstileのTerraform destroyは`prevent_destroy`を解除するreview済み変更で行う。
5. GitHub / Cloudflare / Neon / OpenAI credentialsをrevokeする。
6. R2 state bucketは監査・復旧不要を確認するまで最後に残す。

## Production readiness・data

Production専用Cloudflare Worker / Container、Neon project、Turnstile、Google client、R2 state、GitHub Environment、capacity、backup、alert値は未構築です。初回公開では [`closed-beta-admission.md`](closed-beta-admission.md) に従いAdmissionを`closed`で開始し、Stagingのhostname、secret、DB、state、provider limitを転用しません。

- Production dataへのaccessは最小権限・最短時間にし、目的と承認を記録する。
- Production dataをStaging / local / testへcopyしない。
- 手動UPDATE / DELETE、data correction、restoreは事前backup、query review、rollback plan、実行記録を必須にする。
- Account deletion / retention要件を運用都合で変更しない。
- Production専用`CSRF_TOKEN_PEPPER`のCSPRNG由来256-bit相当確認とstable CSRF releaseのold-image drainを完了するまでProduction deploy準備完了としない。
- Neon restore window、追加backup、restore drill、observability owner / retention / alertsを決めるまでProduction準備完了としない。
