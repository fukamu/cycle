# Deployment

この文書はPDCAIのデプロイ手順の Source of Truth です。application要件・architecture・security・data仕様は [`design.md`](design.md) が上位です。DB操作の詳細は [`database.md`](database.md)、稼働後は [`operations.md`](operations.md) を参照してください。

## 現在の環境区分

| 環境        | 用途         | Deploy経路                        | Data / 外部API                                           |
| ----------- | ------------ | --------------------------------- | -------------------------------------------------------- |
| Development | developer PC | 手動起動                          | local PostgreSQL、通常はFake AI・reCAPTCHA無効           |
| Test        | CI / E2E     | GitHub Actions内のみ              | job専用PostgreSQL、Google/reCAPTCHA/OpenAIはtest double  |
| Production  | 公開service  | mainのCI成功後に`Deploy` workflow | Cloud SQL、OpenAI、Google Identity、reCAPTCHA Enterprise |

Preview環境は実装・workflow・data分離方針がなく、正式環境として存在しません。Previewをproduction設定の流用で代用してはいけません。追加には `design.md` を含む事前の仕様判断が必要です。

## 構成と固定名

- Region: `asia-northeast1`（Tokyo）
- Container: Frontend SPAとGo APIを同一image・同一originで配信
- Artifact Registry repository: `pdcai`
- Cloud Run service: `pdcai-web`
- Cloud Run migration job: `pdcai-migrate`
- Database: Cloud SQL for PostgreSQL
- Secrets: Secret Manager
- Authentication/abuse prevention: Google Identity、reCAPTCHA Enterprise
- Observability: Cloud Logging、OpenTelemetryからCloud Monitoring / Cloud Trace
- CI/CD: GitHub Actions + Workload Identity Federation

Docker imageはworkflowの実装どおり、commit SHAをimmutable tagにした `asia-northeast1-docker.pkg.dev/<project>/pdcai/pdcai-web:<commit-sha>` です。`latest` tagには依存しません。

## Production release gate（初回前に必須）

次の値は [`design.md`](design.md) §54で未決です。ここで値を推測・確定していません。owner/operatorが決定し、変更理由と確認日をrelease記録へ残すまでproduction deployを許可しないでください。

- public domain、Google web client ID、reCAPTCHA site key
- 利用可能なOpenAI modelと当日のinput/output単価
- OpenAI provider側spend/rate limit
- Cloud SQL tier、max connections、Cloud Run max instances、1 instance当たりDB pool
- Cloud SQL backup/PITRとretention policy
- AI月次budget、24時間上限、rate limit、reCAPTCHA threshold
- Monitoring alert thresholdと通知先

`deploy.yml` はrepositoryに暫定値を埋め込まず、applicationで必要な上記値をGitHub Environment variablesとして要求します。未設定ならGoogle認証・image buildより前に失敗します。Cloud SQL tier、backup、provider上限、alertはworkflow外のため、人手でのrelease gateが残ります。

## 初回インフラ準備

Infrastructure as Codeは現在ありません。権限を持つoperatorがGoogle CloudとGitHubで次を準備し、別のhosting連携による自動deployを有効にしないでください。

1. 対象Google Cloud projectでArtifact Registry、Cloud Run、Cloud SQL Admin、Secret Manager、reCAPTCHA Enterprise、Cloud Monitoring、Cloud Traceに必要なAPIを有効化する。
2. `asia-northeast1` にDocker repository `pdcai` を作る。
3. release gateで決定したtier/backup/PITR/connection設定でPostgreSQL 17のCloud SQL instanceとapplication database/userを作る。connection nameを控える。
4. [`environment.md`](environment.md) 記載の6つのSecret Manager secretを作成する。値はGitHub variablesやrepositoryへ置かない。
5. Runtime service accountを作り、対象Cloud SQLへの接続、対象secret versionの参照、reCAPTCHA評価、Monitoring metric書込み、Cloud Trace送信に必要な最小権限だけを付ける。
6. Deploy service accountとGitHub OIDC Workload Identity Federationを作り、対象repository・production environmentからのtokenだけを信頼する。Artifact Registry push、Cloud Run service/job更新、runtime service account使用に必要な最小権限だけを付ける。
7. Google Identity web clientとreCAPTCHA Enterprise site keyへ確定したHTTPS origin/domainを登録する。
8. GitHub Environment `production` を作り、[`environment.md`](environment.md) のsecrets/variablesを設定する。推奨としてrequired reviewerとmain branch protectionを設定する。
9. Cloud Run serviceのpublic invocationをMVPの公開要件に従って許可する。Migration jobはpublicにしない。
10. GitHub以外のCloud Run continuous deployment / hosting連携が無効であることをCloud Consoleで確認する。リポジトリ内に二重deploy設定はないが、外部console設定はこのリポジトリから監査できない。

`PDCAI_DATABASE_URL` はCloud RunからCloud SQL attachment経由で接続できるsupported connector/unix socket形式にします。secret値をCLI historyやworkflow outputへ表示しないでください。

## GitHub設定

必要な名前と渡し先は [`environment.md`](environment.md) を正とします。特に次を確認します。

- `GCP_WORKLOAD_IDENTITY_PROVIDER` と `GCP_DEPLOY_SERVICE_ACCOUNT` はGitHub **secrets**。
- public ID、resource name、決定済みlimitはGitHub **Environment variables**。
- DB URL、OpenAI key、4つのpepper/HMACはSecret Manager。
- `PUBLIC_ORIGIN` はHTTPSで、Google/reCAPTCHA/Frontend build/runtimeの値が同じproduction domainを指す。
- `DB_MAX_OPEN_CONNS × CLOUD_RUN_MAX_INSTANCES` に、migration/管理接続の余裕を足してCloud SQL上限を超えない。

## CI/CDとbranch

[`ci.yml`](../.github/workflows/ci.yml) はpull requestとmainへのpushで実行します。

- Frontend: install、format、lint、typecheck、unit test、build
- Backend: PostgreSQL test service、sqlc生成差分、gofmt、vet、unit/integration test、server/migrate build
- E2E: PostgreSQL test service、production build、Chromium、test double

CIはproduction secretやproduction DBを参照しません。

[`deploy.yml`](../.github/workflows/deploy.yml) は`CI`の`workflow_run`がmainで成功した場合だけ起動し、CI対象のexact commit SHAをcheckoutします。feature branchやpull requestからはdeployしません。GitHub Environment protectionがある場合は、そのapprovalも必要です。

## 通常deploy

1. Pull requestでCIを成功させ、review後にmainへmergeする。
2. mainの`CI` workflowが全job成功したことを確認する。
3. `Deploy` workflowが同じSHAに対して次を行う。
   1. production変数の未設定検査
   2. Workload Identity Federation認証
   3. VITE公開値をbuild argとしてproduction imageをbuild
   4. SHA tagでArtifact Registryへpush
   5. `pdcai-migrate` jobを同じimageへ更新
   6. migration jobを実行して成功を待つ
   7. 成功後だけ`pdcai-web`の新revisionをdeploy
   8. deployment URLの `/healthz` と `/readyz` をsmoke test
4. [`operations.md`](operations.md) のdeploy後確認を行う。

Migration失敗時はservice deployへ進みません。Service deploy後にsmoke testが失敗した場合は、新revisionが既に作られているため、Cloud Run logsとtrafficを直ちに確認してください。

## 手動build（ローカル検証のみ）

```powershell
docker build -t pdcai:local .
```

Imageはdistroless/non-rootで、`/app/server`、`/app/migrate`、migration、Frontend assetsだけを含みます。production push/deployはworkflowに任せ、developer PCからSHA tagを上書きしません。

## Deploy後確認

- GitHub Actionsでmigration、service deploy、smokeの全stepがgreen。
- `GET /healthz` が200 `{"status":"ok"}`。
- `GET /readyz` が200 `{"status":"ok"}`。
- Cloud Runのactive revision/image digestが対象SHAに対応。
- 匿名session作成、P/D/C autosave、reload、cycle complete、Google login、AI generate/refineの代表操作。実user dataをtest fixtureに使わない。
- Cloud Loggingにstartup/runtime errorがなく、Cloud Monitoring/Traceへのexport errorがない。
- DB connection、5xx、latency、AI error/cost/rate-limit metricsに異常がない。

## Rollback

Application rollbackは、forward-compatibleなDB schemaで動く直前の正常revisionへtrafficを戻します。対象revisionを確認してから、権限を持つincident operatorだけが実行します。

```powershell
gcloud run revisions list --service pdcai-web --region asia-northeast1
gcloud run services update-traffic pdcai-web --region asia-northeast1 --to-revisions <LAST_GOOD_REVISION>=100
```

これはproduction変更です。revision名、実行者、時刻、理由をincident記録へ残します。Secret/config変更やDB migrationは戻りません。旧applicationが現在schemaと互換でない場合はtrafficを戻さず、roll-forwardを選びます。DB down migrationやrestoreは自動rollbackに含めず、[`database.md`](database.md) に従って個別判断します。

Rollback後も `/healthz`、`/readyz`、代表操作、error rateを確認します。安定後に原因修正を新しいcommitとしてmainへmergeし、履歴を書き換えません。

## Deploy失敗時

| 失敗段階             | 最初に確認するもの                                      | 対応                                                 |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Variable validation  | errorに出た変数名、production Environment選択           | 値をrelease gateで決定して設定。仮値で通さない       |
| Google auth          | WIF provider、subject条件、deploy SA                    | secret値を表示せずtrust/権限を修正                   |
| Build/push           | Docker build log、repository名、Artifact Registry権限   | 同じSHAで原因修正後にworkflowを再実行                |
| Migration job deploy | runtime SA、Cloud SQL attachment、secret access         | serviceは未変更。job logを確認                       |
| Migration execute    | `schema_migrations`、SQL error、DB容量/lock             | force/downを即実行せずDB runbookで判断               |
| Service deploy       | config validation、port、startup、telemetry credentials | 新revision logを確認。旧revisionのtrafficを維持/復元 |
| Smoke                | `/healthz`か`/readyz`か、DB接続、URL/invoker            | trafficと5xxを確認し、必要ならrollback               |

## Productionで禁止する操作

- `scripts/reset-local-db.ps1`、integration test、down migration、drop/truncateをproductionへ向けること。
- Production secretやDB URLを`.env`、GitHub variable、CLI引数、issue、logへコピーすること。
- Migration jobを迂回してapplicationだけ先にdeployすること。
- 適用済みmigrationを編集すること、dirty versionを根拠なくforceすること。
- SHA tagの上書き、force push、Git履歴書き換え。
- Backup/restore確認なしのdestructive migration。
- 未決のcapacity/budget/security値をexample/defaultのまま正式値として扱うこと。
