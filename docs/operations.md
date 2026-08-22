# Cloud運用

この文書は稼働中のStaging/将来Productionのrunbookです。仕様は [`design.md`](design.md)、releaseは [`deployment.md`](deployment.md)、DBは [`database.md`](database.md) がSource of Truthです。現在実装済みのcloud targetはStaging Lightだけで、Productionは未構築です。

## Observability

- Cloudflare Worker/Containerのconsole出力をWorkers Logsで収集
- Cloudflare automatic tracesを5% sample、logsを100% sampleで有効化
- Go `slog` JSONにrequest ID、trace ID、route template、method、status、latencyを記録
- Application metric eventをstructured logとして出力
- `/healthz` と `/readyz`

Dashboard、alert policy、notification channel、uptime monitorはまだIaC化されていません。導入済みとみなさず、初回Production前にthreshold、通知先、所有者を決定します。Cloudflare Analytics/Logs、Neon Monitoring、OpenAI usageを横断して確認します。

## Health check

```bash
curl --fail --silent --show-error 'https://cycle.staging.fukamu.matoruru.com/healthz'
curl --fail --silent --show-error 'https://cycle.staging.fukamu.matoruru.com/readyz'
```

- `/healthz`: WorkerからContainer processへ到達できる。DBや外部APIは呼ばない。
- `/readyz`: startup configはvalidation済みで、DB pingが成功する。OpenAI/Google/Turnstileは毎回呼ばない。

Healthだけで機能正常を断定せず、5xx、latency、Container cold start、Neon connections、代表操作も確認します。

## Deploy後チェック

1. commit SHA、Terraform Plan/Apply runとapprover、Cloudflare deployment/version、Container rollout、migration workflow runをrelease記録へ残す。
2. `/healthz`と`/readyz`が継続して200。
3. Workers Logs/Tracesでstartup、DB connection、5xxが増えていない。
4. 匿名session、Goal Draft autosave、Goal開始、P/D/C/A autosave、Cycle完了後に次CycleではなくGoal Reviewが開くことを検証dataで確認。
5. Reviewから目標維持/更新で次Cycleを開始でき、Goal TimelineでVersion markerとCompleted/Canceled CycleがGoal単位に表示されることを確認。
6. Google login、Turnstile、Goal Refine、Action Generate/Refineを最小回数確認し、provider error/spendも確認。
7. Neon connection/compute、latency、AI cost/budget、rate-limit拒否が決定済みthreshold内。

Production userの本文、email、token、raw user ID/IPを確認用logへ追加しません。

## Logs / error investigation

Cloudflare DashboardでWorker `fukamu-cycle-staging`、deploy時刻/version、Containerを絞り、`severity`、`error_class`、`error_code`、request/trace IDを確認します。PDCA本文、prompt/output、session/CSRF token、Google credential、email、raw user ID/IP、raw Turnstile tokenを検索・記録・転記しません。

必要な調査結果は時刻、version、route template、status、error class/code、集約eventで残します。Neon/OpenAI/Google/Turnstileのdashboardを確認するときもcredential値を表示しません。

## Incident first response

### Database

症状は`/readyz` 503、`database_startup_failed`、repository error、latency/connection増加です。

1. Neon project/branch/compute state、connection上限、storage、maintenanceを確認。
2. Runtime pooled URLとmigration direct URLの混同がないか、値を表示せずGitHub Environmentの更新履歴で確認。
3. `DB_MAX_OPEN_CONNS × active Container instances`と実接続数を比較。
4. Application起因ならschema互換性を確認して旧versionへrollbackを検討。
5. Data corruptionの疑いがあればwriteを増やす操作を止め、restore/backup判断へ移る。resetしない。

### OpenAI / AI

1. AI error event、latency、provider status、spend/rate limitを確認。
2. Key、model availability、価格設定の更新履歴を値を表示せず確認。
3. Provider障害時にFake AIへ切り替えず、AI errorを返して非AI機能と分離する。
4. Cost急増時はapplication budget/rate limitとprovider hard limitを確認し、変更をreviewして再deployする。

### Google Identity

1. Browser networkとserver error codeをcredential値なしで確認。
2. `GOOGLE_WEB_CLIENT_ID`、Frontend build値、authorized origin、`PUBLIC_ORIGIN`の一致を確認。
3. Google側障害とconfig mismatch、anonymous既存sessionを切り分ける。

### Turnstile

1. Anonymous bootstrap errorとSiteverify response classを確認する。Raw token/secretをlogに追加しない。
2. Frontend site key、Backend secret、hostname `cycle.staging.fukamu.matoruru.com`、action `anonymous_bootstrap`を確認。
3. Production profileで`TURNSTILE_ENABLED=false`にしない。Fail-closedを維持し、rate limitとprovider statusを切り分ける。

### Cloudflare Worker / Container

1. Deployment/version、Container rollout/status、Worker exception、cold-start latencyを確認。
2. Static assetsだけかAPIだけか、custom domain/TLSを含む全体かを切り分ける。
3. DDoS event/mitigationとApplication 429/403を混同しない。
4. Wrangler deploy後の失敗はschema互換性を確認し、直前の成功commitから再deployする。

### Temporary Closed Beta Admission

初期ProductionのInvite発行・新規redeem停止・Cookie key rotation・一般公開切替は [`closed-beta-admission.md`](closed-beta-admission.md) を参照します。Raw Invite Token、Allowlist digest、Admission Cookie、Cookie keyをlogへ追加しません。`closed`の設定不備は既存Sessionではなく新規Anonymous bootstrapだけをfail-closedにすることを確認します。

## Environment / secret rotation

1. [`environment.md`](environment.md)でserver/client、secret/public、validation、影響を確認。
2. Application値はGitHub `staging` Environment、Terraform/R2 credentialはrepository secretsで用途別にrotateする。Apply approver変更はrepository variableとEnvironment Required reviewerを同時に更新する。
3. 変更理由、時刻、所有者、失効確認を記録する。値自体は記録しない。
4. `VITE_`対応値がある場合はFrontendを必ずrebuildする。
5. main CIからPlan/承認付きApply/`Deploy Staging`を通し、healthと代表操作を確認する。Application値だけの変更で再buildが必要な場合はmain HEADから`Deploy Staging`をmanual dispatchする。
6. Pepper変更は既存session/tokenへ影響するため、移行影響の確認なしにrotateしない。

## Rollback decision

Deploy直後に5xx/readiness/主要操作の失敗が増えた、新version固有と判定できた、またはsecurity/data corruptionが疑われる場合は新規deployを止めます。旧versionとDB schemaがcompatibleな場合だけ直前成功commitを再deployします。Migrationを自動downせず、互換でなければroll-forwardまたは個別DB復旧を判断します。

## Incident record

1. 発見時刻、影響、deployment/version、直前変更、request/trace ID、error/eventを記録。
2. Incident leadを決め通常deployを停止。
3. Security/data lossを判定し、必要ならaccess制限・credential revoke・provider停止を権限者へescalate。
4. 影響を止める最小変更を選び、cloud操作を記録。
5. Healthと代表操作で復旧を確認し監視を継続。
6. 原因、timeline、user impact、再発防止、未検知理由をpostmortemへ残す。秘密値・個人dataは含めない。

## Production data

- 最小権限・最短時間でaccessし、目的と承認を記録する。
- Production dataをStaging/local/testへcopyしない。
- 手動UPDATE/DELETE、data correction、restoreは事前backup、query review、rollback plan、実行記録が必須。
- Account deletion/data retention要件を運用都合で変更しない。
- Neon restore window、追加backup、restore drillはProduction-blocking TODO。値を決めるまでProduction準備完了としない。
