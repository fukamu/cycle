# 環境変数

この文書は環境変数の運用上の一覧です。変数のvalidationと実際のdefaultは [`backend/internal/config/config.go`](../backend/internal/config/config.go)、Frontend参照箇所、Playwright設定、workflowが最終的な実装根拠です。アプリケーション仕様は [`design.md`](design.md) が上位です。

## 環境区分と秘密情報

実装が受け付ける `APP_ENV` は `development`、`test`、`production` の3つです。Preview環境は未実装であり、独立した正式環境として扱いません。将来追加する場合は仕様・認証・データ分離・デプロイ経路を先に決める必要があります。

- `.env` はBackendのローカルprocess用、`frontend/.env.local` はViteのローカルbuild用です。どちらもGit管理外です。
- `VITE_` で始まる値はbundleへ埋め込まれ、ブラウザ利用者に見えます。秘密情報を設定してはいけません。
- production秘密値はSecret ManagerからCloud Runへ渡します。GitHub secret、workflow log、文書へ値を書きません。
- exampleのlocal pepper/passwordはproductionで使用禁止です。4つのpepper/HMAC値は互いに異なる高entropy値にします。
- 値変更後は新しいCloud Run revisionが必要です。Frontend build-time値の変更はimageの再buildも必要です。

## Backend runtime

「必須」は実装上空値を許さないものです。「production必須」はproduction validationまたはproduction release gateで必須のものです。defaultを使う項目も、productionでは [`design.md`](design.md) §54の未決事項を確定してから設定してください。

| 変数 | 用途・default | 必須性 / 環境 | 公開範囲・設定場所 |
| --- | --- | --- | --- |
| `APP_ENV` | 実行環境。default `development` | productionでは`production`を明示 | server only。Cloud Run env |
| `PUBLIC_ORIGIN` | cookie/CORS等の公開origin。default `http://localhost:5173` | productionはHTTPSの実domain必須 | server only。GitHub Environment variable経由 |
| `HTTP_ADDRESS` | listen address。default `:8080` | 任意 | server only。Cloud Runではimage default |
| `STATIC_DIR` | SPA assets。default空 | local Vite時は空、containerは`/app/public` | server only。image default |
| `DATABASE_URL` | PostgreSQL接続URL | 全環境で必須 | **secret / server only**。local `.env`、production Secret Manager `PDCAI_DATABASE_URL` |
| `DB_MAX_OPEN_CONNS` | 1 instanceのpool上限。default `10` | 任意。ただしproduction値はDB容量とinstance上限に合わせて決定 | server only。Cloud Run env |
| `DB_MAX_IDLE_CONNS` | idle接続上限。default `5` | 任意、open以下 | server only。Cloud Run env |
| `DB_CONN_MAX_LIFETIME_MINUTES` | connection lifetime。default `30` | 任意、正数 | server only。Cloud Run env |
| `SESSION_TOKEN_PEPPER` | session token hash | 全環境で必須、24文字以上 | **secret / server only**。Secret Manager `PDCAI_SESSION_TOKEN_PEPPER` |
| `CSRF_TOKEN_PEPPER` | CSRF token hash | 全環境で必須、24文字以上 | **secret / server only**。Secret Manager `PDCAI_CSRF_TOKEN_PEPPER` |
| `BOOTSTRAP_ID_PEPPER` | anonymous bootstrap key hash | 全環境で必須、24文字以上 | **secret / server only**。Secret Manager `PDCAI_BOOTSTRAP_ID_PEPPER` |
| `RATE_LIMIT_HMAC_SECRET` | IP等のrate-limit識別子HMAC | 全環境で必須、24文字以上 | **secret / server only**。Secret Manager `PDCAI_RATE_LIMIT_HMAC_SECRET` |
| `SESSION_IDLE_DAYS` | session idle TTL。default `30` | 任意 | server only |
| `SESSION_ABSOLUTE_DAYS` | session absolute TTL。default `180` | 任意、idle以上 | server only |
| `SESSION_ACTIVITY_TOUCH_MINUTES` | activity更新間隔。default `15` | 任意、正数 | server only |
| `ANONYMOUS_BOOTSTRAP_TTL_MINUTES` | bootstrap idempotency TTL。default `10` | 任意、正数 | server only |

## AI、認証、abuse prevention

| 変数 | 用途・default | 必須性 / 環境 | 公開範囲・設定場所 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI API認証 | development/testは空でFake AI、production必須 | **secret / server only**。Secret Manager `PDCAI_OPENAI_API_KEY` |
| `AI_PROVIDER` | provider。default `openai` | 任意だが`openai`以外は無効 | server only |
| `AI_MODEL` | model。default `gpt-5-mini` | production release前に利用可否・価格を確認 | server only。GitHub Environment variable |
| `AI_MAX_INPUT_TOKENS` | input上限。default `12000` | 任意、正数 | server only |
| `AI_MAX_OUTPUT_TOKENS` | output上限。default `800` | 任意、正数 | server only |
| `AI_TIMEOUT_SECONDS` | provider timeout。default `45` | 任意、正数 | server only |
| `AI_MAX_PROVIDER_ATTEMPTS` | 最大試行数。default `2` | 任意、1〜2 | server only |
| `AI_MAX_GENERATIONS_PER_USER_24H` | user 24時間上限。default `10` | production release前に決定 | server only |
| `AI_GENERATE_PROMPT_VERSION` | generate prompt識別子。default `generate-action-v1` | 任意。対応fileが必要 | server only |
| `AI_REFINE_PROMPT_VERSION` | refine prompt識別子。default `refine-action-v1` | 任意。対応fileが必要 | server only |
| `AI_TOKENIZER_ENCODING` | tokenizer。default `o200k_base` | 任意。実装対応値を使う | server only |
| `AI_MONTHLY_BUDGET_USD` | application側月次予算。default `100` | production release前にprovider上限とともに決定 | server only |
| `AI_WARNING_THRESHOLDS` | 予算警告比率。default `0.5,0.8` | 任意、0〜1の昇順 | server only |
| `AI_PRICE_MODEL` | 単価が対応するmodel。default `gpt-5-mini` | `AI_MODEL`と一致必須 | server only。GitHub Environment variableから同値を設定 |
| `AI_PRICE_INPUT_USD_PER_MILLION` | input 100万token単価。default `0` | production release前に当日の単価を設定 | server only。GitHub Environment variable |
| `AI_PRICE_OUTPUT_USD_PER_MILLION` | output 100万token単価。default `0` | production release前に当日の単価を設定 | server only。GitHub Environment variable |
| `GOOGLE_WEB_CLIENT_ID` | Google Identity token検証 | development/test任意、production必須 | server onlyだが値自体は公開可。GitHub Environment variable |
| `RECAPTCHA_ENABLED` | Enterprise検証の有効化。code default `true`、local example `false` | development/testはfalse可、productionはtrue必須 | server only |
| `RECAPTCHA_PROJECT_ID` | Google Cloud project | production必須 | server only。GitHub `GCP_PROJECT_ID`から設定 |
| `RECAPTCHA_SITE_KEY` | server検証対象site key | production必須 | server onlyだが値自体は公開可。GitHub Environment variable |
| `RECAPTCHA_SCORE_THRESHOLD` | 許可threshold。default `0.5` | production release前に決定 | server only |
| `RECAPTCHA_EXPECTED_ACTION` | expected action。default `anonymous_bootstrap` | 任意、空不可 | server only |
| `RATE_ANONYMOUS_CREATE_PER_IP_HOUR` | anonymous作成/IP/時。default `5` | production release前に決定 | server only |
| `RATE_ANONYMOUS_CREATE_PER_IP_24H` | anonymous作成/IP/24時。default `20` | production release前に決定 | server only |
| `RATE_AI_PER_USER_MINUTE` | AI/user/分。default `3` | production release前に決定 | server only |
| `RATE_AI_PER_SESSION_MINUTE` | AI/session/分。default `3` | production release前に決定 | server only |
| `RATE_AI_PER_IP_MINUTE` | AI/IP/分。default `10` | production release前に決定 | server only |

## Frontend build-time

これらは [`frontend/.env.example`](../frontend/.env.example) にだけ定義します。Backend用 `.env` へ重複させません。

| 変数 | 用途 | 必須性 / 環境 | 公開範囲・設定場所 |
| --- | --- | --- | --- |
| `VITE_GOOGLE_WEB_CLIENT_ID` | Google Identity JS client | Google loginを使うbuildで必要 | **client公開可**。local `.env.local`、production image build argはGitHub `GOOGLE_WEB_CLIENT_ID` |
| `VITE_RECAPTCHA_SITE_KEY` | reCAPTCHA Enterprise client | production buildで必要 | **client公開可**。local `.env.local`、production image build argはGitHub `RECAPTCHA_SITE_KEY` |

Productionでは、各VITE値と対応するserver値を同じsourceからbuild/deployし、不一致を避けます。

## Migration、test、tooling

| 変数 | 用途 | 注意 |
| --- | --- | --- |
| `MIGRATIONS_DIR` | `cmd/migrate` のmigration directory。default `migrations` | container imageは`/app/migrations`を設定 |
| `TEST_DATABASE_URL` | Go integration testとPlaywrightの破棄可能DB | application runtimeには使わない。開発/production DBを指定しない |
| `PDCAI_GO_BINARY` | Playwrightが使うGo executable | 任意。hostにGoがない特殊なE2E実行用 |
| `PDCAI_SERVER_BINARY` | Playwrightが起動する既build server | 任意。指定時はPlaywrightがmigrationを実行しないため事前適用が必要 |
| `CI` | Playwrightのretry/reporterとserver再利用を制御 | CIが自動設定。手動でproduction接続に使わない |

## GitHub Actions / Google Cloud設定

GitHub Environment `production` に次を登録します。値自体はリポジトリへ保存しません。

| 種別 | 名前 | 渡し先 |
| --- | --- | --- |
| GitHub secret | `GCP_WORKLOAD_IDENTITY_PROVIDER` | Google auth action |
| GitHub secret | `GCP_DEPLOY_SERVICE_ACCOUNT` | Google auth action |
| GitHub variable | `GCP_PROJECT_ID` | auth、reCAPTCHA、image path |
| GitHub variable | `GCP_RUNTIME_SERVICE_ACCOUNT` | Cloud Run service/job |
| GitHub variable | `CLOUD_SQL_INSTANCE` | Cloud SQL attachment |
| GitHub variable | `PUBLIC_ORIGIN` | Cloud Run runtime |
| GitHub variable | `GOOGLE_WEB_CLIENT_ID` | Frontend buildとCloud Run runtime |
| GitHub variable | `RECAPTCHA_SITE_KEY` | Frontend buildとCloud Run runtime |
| GitHub variable | `AI_MODEL` | Cloud Run runtime |
| GitHub variable | `AI_PRICE_INPUT_USD_PER_MILLION` | Cloud Run runtime |
| GitHub variable | `AI_PRICE_OUTPUT_USD_PER_MILLION` | Cloud Run runtime |

Secret Managerには `PDCAI_DATABASE_URL`、`PDCAI_OPENAI_API_KEY`、`PDCAI_SESSION_TOKEN_PEPPER`、`PDCAI_CSRF_TOKEN_PEPPER`、`PDCAI_BOOTSTRAP_ID_PEPPER`、`PDCAI_RATE_LIMIT_HMAC_SECRET` を作成し、runtime service accountへ必要なsecretだけのaccessを付けます。

上表以外のruntime設定は現在code defaultを使います。productionへ進む前に、[`deployment.md`](deployment.md) のrelease gateで未決値を確認してください。値が未決のため、この文書では新しいproduction値を確定していません。
