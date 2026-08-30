# Cloud deployment・運用

この文書はTerraform bootstrap、Staging deployment、監視、incident、rollback / restore、Production運用準備のSource of Truthです。Application仕様は [`design.md`](design.md)、正確な環境変数名・分類・validationは [`environment.md`](environment.md)、Database / Migrationは [`database.md`](database.md)、一時Closed Betaの発行・失効・撤去は [`closed-beta-admission.md`](closed-beta-admission.md) が所有します。現在実装済みのcloud targetはStaging Lightだけで、Productionは未構築です。

## Environment・ownership

| Environment | Purpose | Deployment / isolation |
|---|---|---|
| Development | local開発 | 手動起動、local PostgreSQL、Fake AI / Turnstile可 |
| Test | CI / E2E | job専用PostgreSQL、external providerはtest double |
| Staging Light | external integration検証 | main SHAの成功CI → Terraform Plan → owner承認Apply → migration-first Cloudflare deploy。`cycle.staging.fukamu.matoruru.com`と専用resourceだけを使用 |
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
| GitHub Actions | main / exact SHA gate、migration-first順序、traffic切替、`/healthz` / `/readyz` smoke test |
| Manual operations | Cloudflare account/zone/plan/token、R2 bucket、Neon、Google client、OpenAI limit、GitHub Environment protectionと入力、post-deploy critical journey / cleanup / production promotion |

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
3. Apply専用の別のbucket-scoped `Object Read & Write` credentialを作り、`staging-terraform-apply` GitHub Environmentへ同じsecret名で登録する。値はPlan tokenと異なるものにする。
4. [`backend.hcl.example`](../infra/terraform/staging/backend.hcl.example) をuntracked `backend.hcl`へcopyし、bucketとaccount IDだけを設定する。Credentialをfileへ書かない。
5. 障害調査でlocal remote readが必要な場合だけ、Plan用credentialを現在のBash processへ注入する。通常releaseをlocal Applyで迂回しない。

R2はTerraform S3 lockfileが使うconditional Putを提供しますが、HashiCorpのS3 backend検証対象はAmazon S3であり、R2にS3形式のobject version historyはありません。Applyの`use_lockfile = true`を維持します。PlanはRead Only credentialのため`-lock=false`を使い、repositoryのPlan / Applyを同じ`staging-terraform` concurrency groupで直列化します。並行するmanual remote state操作は禁止します。

### Terraform Plan / approved Apply

Turnstile EditだけにscopeしたCloudflare tokenをdeploy tokenから分離します。Repository / Environment inputのexact listとscope precedenceは [`environment.md`のGitHub Terraform inputs](environment.md#github-terraform-inputs) が正本です。

`Terraform Apply Staging`は自動起動しません。Planをreviewした`TERRAFORM_APPLY_APPROVER`本人がActions画面で成功したPlan run IDを入力します。Workflow preflightはactor、source workflow、repository、success、main、artifact、current main HEADを検査し、不一致ならApply Environment credentialへ進みません。利用中のGitHub planでRequired reviewerを使える場合は同じownerを設定し、owner本人がdispatchとreviewを行う運用では`Prevent self-review`を有効にしません。

```text
CI (main HEAD。PR検証treeを完全一致で再利用できなければ全check)
-> Terraform Plan Staging
   -> Object Read Only credentialでR2 stateをlockなしでread
   -> terraform plan -lock=false -out=staging.tfplan
   -> SHA-256 + commit SHA付きartifact（7日）
-> ownerがPlan run IDを指定してTerraform Apply Stagingをmanual dispatch
-> actor / source Plan / artifact / current main HEADを検証
-> staging-terraform-apply Environment
   -> Object Read & Write credentialへscope override
   -> saved plan再検証とlock対応backend init
   -> live state snapshot / checksum / isolated restore drill
   -> 同じsaved planをlock付きapply
-> Apply metadata artifact
-> Deploy Staging
```

Plan中にdestroy / replaceがないこと、hostnameとTurnstile modeが承認値であることを確認します。Mainが進んだ、stateが別経路で変化した、artifactがstale / expiredの場合はPlanを破棄し、新しいCI / Planからやり直します。Saved planとTerraform stateはsecret相当としてdownload・転記・長期保存しません。

#### Pre-Apply state snapshot and restore drill

Applyは最終main HEAD確認の直後に [`backup-and-drill-terraform-state.sh`](../scripts/backup-and-drill-terraform-state.sh) を実行します。

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

- `staging-terraform-apply`: Apply用R2 Read & Write credentialを保管し、deployment branchを`main`へ制限する。
- `staging`: Application runtime / migration / deploy inputsを保管し、deployment branchを`main`へ制限する。
- Exact secret / variable list、Closed Beta追加値、Frontend public mappingは [`environment.md`](environment.md) だけを更新する。
- Workflowは [`deployment-contract.json`](../config/deployment-contract.json) から入力分類を導出し、Worker parserとBackend typed config checkerをmigration前に実行する。
- Runtime pooled URLとmigration direct URLを混同せず、migration secretをWorker / Containerへ渡さない。
- OptionalなApplication紹介導線は承認済み固定root URLだけを許可し、User Dataを共有payloadへ含めない。

### First deployment

1. Terraform repository inputsと`staging-terraform-apply` Environmentを設定する。
2. `staging` Environmentを [`environment.md`](environment.md) に従って設定する。Turnstile未作成の初回はApply後にpublic site keyとsecret keyを追加する。
3. 対象変更を`main`へmergeし、同じcommitの`CI`成功を確認する。
4. `Terraform Plan Staging`をreviewし、owner本人がPlan run IDを指定して`Terraform Apply Staging`をdispatchする。
5. OptionalなEnvironment reviewer gateがある場合はpending deploymentを明示Approve / Rejectする。
6. Apply後に自動起動する`Deploy Staging`が次の順で完了することを確認する。

```text
saved plan integrity / exact main SHA check
-> owner approval
-> pre-Apply state backup / isolated restore drill
-> terraform apply
-> frontend build
-> Neon direct URLでmigration
-> ephemeral secrets file作成
-> Wrangler deploy Worker + Container + assets
-> secrets file削除 (always)
-> /healthz, /readyz smoke test
```

`Deploy Staging`はsmoke test成功で完了し、手動確認待ちのrunnerを保持しません。Actions成功後、production approval前に[Post-deploy verification](#post-deploy-verification)をOperations ownerが通常のBrowserで実施します。Migration失敗時はWrangler deployへ進みません。Input不足でDeployだけ停止した場合は承認値を修正し、同じrunのfailed jobをrerunできます。`workflow_dispatch`はcurrent main HEADのApplication復旧用であり、Terraform変更を迂回する経路ではありません。

Custom domainは [`wrangler.jsonc`](../cloudflare/wrangler.jsonc) が所有し、CloudflareがDNS recordとcertificateを管理します。同名recordがある場合は所有用途を確認し、不要と確認できたrecordだけをDashboardから除去します。`workers.dev`とpreview URLは無効のまま維持します。

### Protected response identity release

[Protected Response identity binding](design.md#201-common-conventions)を変更するreleaseではBackend HeaderとFrontend bundleを同じcandidateとして検証し、release記録へ次を残します。

- Testerへ全tabのreloadを案内し、旧tabが残っていないことを確認する。
- Fresh tabで`/api/v1`の`Cache-Control: no-store`、認証済みResponse Header、配信assetのcommitを確認する。Header値やUser IDを記録へ転記しない。
- 同一Browser Contextの二tabでidentity切替journeyを実行し、旧tabがauthoritative Userへ収束することを確認する。失敗時はreleaseを停止し、ad-hocな互換gateで迂回しない。

## Post-deploy verification

`Deploy Staging`はsmoke test成功で終了し、このchecklistの完了をActions statusでは待ちません。Operations ownerはproduction approval前に同じdeploy run / commitを対象として手動で完了し、release記録へ結果を残します。

1. Commit SHA、Deploy / Plan / Apply runとapprover、Cloudflare deployment / version、Container rollout、migration runが同一candidateを指すことをrelease記録へ残す。
2. [Health check](#health-check)が継続して成功し、5xx、latency、cold start、Neon connectionがbaseline内であることを確認する。
3. Playwrightを使わないfreshな通常Chrome / Firefox profileでcanonical Staging originを開く。VPN / proxyと不要なextensionを無効にし、Closed Beta時は非個人Invite Tokenをpassword managerからUIへ入力してURL、console、記録へ残さない。匿名bootstrapからHomeへ到達できればApplicationとの接続確認は完了とし、Cloudflare Turnstile service自体をGitHub Actionsから別途live testしない。
4. 機密でない検証dataだけを使い、Goal Draft autosave、Goal開始、P/D/C/A、Cycle完了、Goal Review、次Cycle、HistoryのGoal V1 / Cycle 1 / Cycle 2、Google upgrade、Goal Refine、Action Generate / Refineを必要最小回数確認する。Google loginはsource Anonymous Userを自動削除・mergeしないため、このmanual journeyでは実行しない。
5. 配信HTMLがStagingの`noindex, nofollow`を持ち、certificate / mixed-content / CSP errorがない。
6. Workers Logs / TracesとOTLP payloadにsecret、PDCA本文、email、raw user ID / IP、raw Turnstile tokenがない。
7. Backend span / metricが承認済みcollectorへ到達し、collector障害中も`/readyz`と代表Application requestが影響を受けない。
8. Neon、Container、OpenAI usage / cost、rate-limit拒否が承認済みlimit内である。
9. Canonical Staging hostname以外と`workers.dev`から利用できない。
10. Journeyの成功・失敗にかかわらず、[Staging critical journey cleanup](#staging-critical-journey-cleanup)で公開account-deleteを実行し、204、response identity、session再確認401を確認する。

Stagingはpublic internetから到達可能です。URLの秘匿をaccess controlとして扱わず、機密情報、Production data、失えないdataを入力しません。

## Observability

- Cloudflare Worker / Containerのconsole出力をWorkers Logsで収集する。
- Cloudflare automatic tracesは5%、logsは100% sampleを維持する。
- Go safe JSON loggerは [`design.md` §42.2](design.md#422-structured-log-fields) のfieldだけを記録し、free-form message、unknown / malformed fieldを拒否する。
- Backend traceとserver-side metricをvendor-neutralなOTLP/HTTPでexportする。Browser-only `draft_recovery_total`は送信しない。
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

対象predicate、dry-run / execute、1..1000のhard ceiling、Transaction、再実行、安全な出力、実commandは [`database.md`のRetention cleanup command](database.md#retention-cleanup-command) が所有します。Productionのbatch size、cadence、起動owner、job経路とDB / index影響を承認するまで、Productionではdry-runを含め実行・scheduleしません。

## Staging critical journey cleanup

`Deploy Staging`は検証accountを作成せず、cleanupも実行しません。手動journeyには他の同一origin tabを閉じたfreshな使い捨てBrowser profileを使い、機密情報や失えないdataを入力しません。Cleanup確認が完了するまでtabとprofileを閉じず、Browser update、OS restart、profile削除を開始しません。

Anonymous bootstrapが始まったら、journeyの成功・失敗にかかわらず、canonical Staging originを表示しているtabのDevTools Consoleで次を実行します。Session / CSRF / raw user IDはmemory内だけで扱い、Consoleへ出すのはstatusだけです。

```js
(async () => {
  const expectedOrigin = "https://cycle.staging.fukamu.matoruru.com";
  if (window.location.origin !== expectedOrigin) {
    throw new Error("Unexpected origin; cleanup was not attempted.");
  }

  const discoverSession = () =>
    fetch("/api/v1/session", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

  const sessionResponse = await discoverSession();
  if (sessionResponse.status === 401) {
    throw new Error(
      "Session was unavailable before account deletion could be verified.",
    );
  }
  if (sessionResponse.status !== 200) {
    throw new Error(`Session discovery failed with ${sessionResponse.status}.`);
  }

  const session = await sessionResponse.json();
  const userID = session?.user?.id;
  const csrfToken = session?.csrfToken;
  if (
    typeof userID !== "string" ||
    userID.length === 0 ||
    typeof csrfToken !== "string" ||
    csrfToken.length === 0
  ) {
    throw new Error("Session response was invalid.");
  }

  const deleteResponse = await fetch("/api/v1/account", {
    method: "DELETE",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "X-CSRF-Token": csrfToken,
      "X-Fukamu-Expected-User-ID": userID,
    },
    body: JSON.stringify({ confirmed: true }),
  });
  const responseIdentity = deleteResponse.headers.get(
    "X-Fukamu-Authenticated-User-ID",
  );
  if (deleteResponse.status !== 204 || responseIdentity !== userID) {
    throw new Error(`Account deletion failed with ${deleteResponse.status}.`);
  }

  const deletedSessionResponse = await discoverSession();
  if (deletedSessionResponse.status !== 401) {
    throw new Error(`Deleted session remained ${deletedSessionResponse.status}.`);
  }
  const result = { deleteStatus: 204, sessionStatus: 401 };
  console.info("Staging cleanup verified", result);
  return result;
})();
```

Expected resultは`{ deleteStatus: 204, sessionStatus: 401 }`です。確認後に使い捨てprofileを閉じます。Deleteの204とresponse identityを同じattemptで確認する前の401はcleanup成功の証拠にしません。Raw account ID、session / CSRF、Invite Token、本文、response body、screenshot、HAR、trace、videoをrelease記録へ残しません。

1. 失敗時はsessionが同じ使い捨てprofileで利用可能な場合だけsnippetを再実行する。204とresponse identityを観測できないまま401になった場合は削除済みと推定しない。
2. Workers Logsではroute template、status、固定error class / code、request / trace IDだけを確認し、raw / hashed IDから個人を追跡しない。
3. Cleanup前にsession / profileを失った場合、または再実行しても収束しない場合はprivacy incidentとしてproduction promotionと追加journeyを止める。Schema互換なら直前Wrangler deploymentへのrollback、非互換ならforward fixを選び、Migration down、SQL手動DELETE / UPDATE、Raw DB correction、別の管理削除経路を作らない。

## Cloud troubleshooting

最初にcommand / workflow、exit code / conclusion、対象environment、直前変更、固定error class / codeだけを記録します。Secret値やUser本文を貼りません。

| Symptom | Checks | Response |
|---|---|---|
| Terraform Planが開始しない | mainの同一SHA CI、workflow state | 同一SHAのCIを成功させる。PR検証treeを証明できなければmain全CIを待つ |
| Apply preflightで停止 | actor / approver、Plan run ID、artifact期限、current main | Owner本人が最新成功Planを指定する。Stale / expired planを再利用しない |
| Applyがapproval待ち | `Review deployments` | Planをreviewした指定ownerがApprove / Rejectする。期限超過時は新Plan |
| Deployが開始しない | Apply metadata、main SHA、workflow conclusion | CI → Plan → approved Applyをやり直し、manual DeployでTerraformを迂回しない |
| Input validationで停止 | Errorに出たkey名、[`environment.md`](environment.md) | 承認値を設定する。仮値を使わず、secret値は表示しない |
| Migrationで停止 | Neon branch / direct URL更新履歴 / SQL error | Wrangler前に停止済み。[`database.md`](database.md)に従いforce / resetせず修正 |
| Wrangler deployで停止 | Token scope、Workers Paid、build / config | Account / zone / plan / token権限を修正し、CI dry-runとの差を解消 |
| Custom domain作成失敗 | DNS owner、zone Active、token zone scope | 所有用途を確認し、不要と確認できたrecordだけ除去 |
| `/healthz` 200 / `/readyz` 503 | Neon compute / pooled URL / pool | DB接続を修正。OpenAI / Google / Turnstile / OTLPをreadiness原因と誤認しない |
| Static assetsだけ404 | Frontend build、Wrangler assets output | Frontend build後にdeployし、API routingと分けて確認 |
| Deploy後5xx増加 | Version別logs / traces、schema互換性 | 互換なら直前成功commit、非互換ならforward fix |
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
6. Pepper変更は既存session / tokenへの移行影響を確認してから行う。
7. OTLP credential / payload漏洩疑いではexport停止、revoke / rotate、provider-side retention / deletionを確認する。

## Rollback・recovery

### Application

新version固有の5xx / readiness / 主要操作失敗、security / data corruption疑いでは新規deployを止めます。旧codeとDB schemaがcompatibleな場合だけ直前成功commitを再deployし、非互換ならforward fixします。Post-deploy journey失敗でmigrationを自動downしません。Collector障害だけを理由にApplicationをrollbackしません。

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
- Neon restore window、追加backup、restore drill、observability owner / retention / alertsを決めるまでProduction準備完了としない。
