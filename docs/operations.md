# Production運用

この文書は稼働中のProduction運用runbookです。仕様は [`design.md`](design.md)、releaseは [`deployment.md`](deployment.md)、DBは [`database.md`](database.md) が上位または専門のSource of Truthです。

## 現在導入済みの観測手段

- Go `slog` のJSON logをstdoutへ出し、Cloud RunからCloud Loggingへ収集
- ProductionでOpenTelemetry traceをCloud Traceへexport
- ProductionでOpenTelemetry metricsを60秒間隔でCloud Monitoringへexport
- HTTP logにrequest ID、trace ID、route template、method、status、latency
- `/healthz` と `/readyz`

Dashboard、alert policy、notification channel、uptime checkのInfrastructure as Codeはリポジトリにありません。導入済みとみなしてはいけません。thresholdと通知先は [`design.md`](design.md) §54の未決事項で、初回production前にCloud Monitoring側で構成し、所有者と確認手順を記録するTODOです。

Applicationが出す主なmetricは、HTTP request/latency、autosave件数/latency、cycle完了、account操作、anonymous作成、rate-limit拒否、error code、AI生成件数/latency/token/推定cost/context、AI budget使用率/警告です。metric名の正確な一覧は [`backend/internal/infrastructure/observability/telemetry.go`](../backend/internal/infrastructure/observability/telemetry.go) を参照してください。

## 稼働確認

```powershell
$serviceUrl = gcloud run services describe pdcai-web --region asia-northeast1 --format 'value(status.url)'
Invoke-RestMethod "$serviceUrl/healthz"
Invoke-RestMethod "$serviceUrl/readyz"
```

- `/healthz`: process liveness。DBや外部APIを呼ばず、200ならprocessが応答可能。
- `/readyz`: essential configはstartup validation済みで、requestごとにDB pingを行う。DB接続不可なら503。OpenAI/Google/reCAPTCHAを毎回呼ばない。

Healthだけで機能正常を断定せず、error rate、latency、DB connections、代表操作も確認します。

## Deploy後チェック

1. 対象commit SHA、Cloud Run revision、image digest、migration job executionをrelease記録へ残す。
2. `/healthz` と `/readyz` が継続して200。
3. 5xx、startup error、DB connection error、telemetry export errorが増えていない。
4. 匿名session、autosave、reload、cycle completeをtest用account/dataで確認。
5. Google login、reCAPTCHA、AI generate/refineを最小回数確認し、provider dashboardのerror/spendも確認。
6. DB pool、Cloud SQL connection数、latency、AI cost/budget、rate-limit拒否が決定済みthreshold内。

Production userの本文、email、token、raw user ID/IPを確認用logへ追加しません。

## Log・error調査

Cloud Loggingでまず次を絞ります。

- resource: Cloud Run Revision、service `pdcai-web`
- deploy時刻と対象revision
- `severity>=WARNING`
- `error_class` / `error_code`
- userから提供されたrequest ID、またはlog内のtrace ID

Request/trace IDで同一requestのHTTP log、error log、Cloud Traceを関連付けます。本文、prompt/output、session/CSRF token、Google credential、email、raw user ID/IPを検索・記録・転記しません。必要な調査結果は時刻、revision、route template、status、error class/code、集約metricで残します。

## 障害別の初動

### DB障害

症状は`/readyz` 503、startupの`database_startup_failed`、repository error、latency/connection増加です。

1. Cloud SQL instance state、接続上限、storage、CPU、ongoing maintenanceを確認。
2. Runtime SAのCloud SQL権限、serviceのCloud SQL attachment、`PDCAI_DATABASE_URL` secret versionを確認。
3. `DB_MAX_OPEN_CONNS × active max instances` と実接続数を比較。
4. Application deploy起因ならcompatibleな旧revisionへrollbackを検討。
5. Data corruptionの疑いがあればwriteを増やす操作を止め、backup/restore判断へ移る。productionでresetしない。

### OpenAI / AI機能障害

1. AI routeのerror code、`ai_generation_total`のresult、latency、provider status、spend/rate limitを確認。
2. `OPENAI_API_KEY`、model availability、価格設定の更新履歴を確認する。keyをlogへ出さない。
3. Provider障害時にproductionをFake AIへ切り替えない。AI機能のerrorを利用者へ返し、P/D/C保存など非AI機能の健全性を分けて確認する。
4. Cost急増時はapplication budget/rate limitsとprovider側hard limitを確認し、必要ならAI利用を抑制する。設定変更は新revisionで行う。

### Google Identity障害

1. Browser console/networkとserverの認証error codeを、credential値を記録せず確認。
2. `GOOGLE_WEB_CLIENT_ID` と`VITE_GOOGLE_WEB_CLIENT_ID`、authorized origin、`PUBLIC_ORIGIN`の一致を確認。
3. Google側障害かconfig mismatchかを切り分ける。Anonymous既存sessionの挙動と分離する。

### reCAPTCHA障害

1. anonymous bootstrapのerror、score/action、project/site keyの対応、runtime SA権限を確認。
2. `RECAPTCHA_SITE_KEY` と`VITE_RECAPTCHA_SITE_KEY`、expected action、production domainを確認。
3. Productionで `RECAPTCHA_ENABLED=false` にして回避しない。threshold変更はabuse riskを評価して承認・記録する。

### Telemetry障害

Productionではexporter初期化失敗によりserver startupが失敗します。Runtime SAのMonitoring/Trace権限、Google API、quotaを確認します。可観測性を黙って無効化するcode変更で回避しません。

## 環境変数・Secret変更

1. [`environment.md`](environment.md) でserver/client、秘密/公開、validation、影響を確認。
2. SecretはSecret Managerへ新versionとして登録し、GitHubやterminalへ値を表示しない。
3. GitHub Environment variable変更はreviewを通し、理由・旧値の管理先・変更時刻を記録。
4. Frontend `VITE_` 対応値がある場合は必ずimageを再buildする。
5. Workflowで新revisionをdeployし、startup validation、health、代表操作を確認。
6. Pepper変更は既存session/token等へ影響し得るため、仕様と移行影響の確認なしにrotateしない。

## Rollback判断

次の場合は新規deployを止め、[`deployment.md`](deployment.md) のapplication rollbackを優先検討します。

- deploy直後に5xx/readiness failure/主要操作失敗が明確に増えた。
- Data corruptionやsecurity incidentの可能性がある。
- DB/外部provider障害ではなく、新revision固有と切り分けられた。

旧revisionとDB schemaがcompatibleでない場合、rollbackはせずroll-forwardまたは個別DB復旧を判断します。Migrationを自動downしません。

## Incident基本対応

1. 発見時刻、影響範囲、revision、直前変更、request/trace ID、error/metricを記録する。
2. Incident leadを決め、通常deployを一時停止する。
3. Security/data lossの可能性を判定し、必要ならaccess制限・credential rotation・provider停止を権限者へescalateする。
4. 影響拡大を止める最小変更（traffic rollback、AI制限等）を選び、production操作を記録する。
5. Healthと代表操作で復旧を確認し、監視を継続する。
6. 原因、timeline、user impact、再発防止、未検知理由をpostmortemへ残す。秘密値・個人データは含めない。

## Production dataの注意

- 最小権限・最短時間でアクセスし、調査目的と承認を記録する。
- Production dataをlocal/testへcopyしない。必要なら仕様に沿って匿名化した最小fixtureを別途作る。
- 手動UPDATE/DELETE、data correction、restoreは事前backup、対象query review、rollback plan、実行記録が必須。
- Account deletion/data retention要件を運用都合で変更しない。
- Backup/PITR retentionとrestore drillは未決のproduction-blocking TODO。値を決めるまで本番準備完了としない。
