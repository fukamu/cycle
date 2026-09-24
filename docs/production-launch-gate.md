# Production Launch Gate

Production Launch Gateは、Productionへのdeployと一般公開を分離するためのApplication全体の認可境界です。機能単位のFeature Flagではありません。規範的なProduct / API / DB契約は [`design.md` §6.7](design.md#67-production-launch-gate) が所有し、この文書は運用手順を所有します。

## 公開モデル

Backendが認証済みSessionから取得したcanonical UUID v7のUser IDだけを使い、毎requestで次を判定します。

```text
canAccess = public_access_enabled OR user_id exists in launch_allowed_users
```

Productionでは設定・table・DB queryの失敗を`503 LAUNCH_GATE_UNAVAILABLE`としてfail closedにします。非allowlist Userは`403 LAUNCH_ACCESS_DENIED`です。Frontendの表示状態、request body、query、任意headerでUser IDや許可結果を指定できません。`GET /api/v1/launch-status`は現在Sessionの三つのbooleanだけを返し、User ID一覧や他Userの状態を返しません。

Anonymous Session作成、Session discovery、Google接続／login、Account Delete、health、readinessはgate外です。これによりBackendがUserを識別してallowlistを評価でき、未許可Userもアカウント削除できます。Home、Goal、Cycle、Review、History、AIを含む業務APIはHTTP middlewareでgateを強制するため、Frontendを書き換えた直接API requestでも回避できません。

`APP_ENV=production`だけがgateを強制します。Development / Testは同じApplication serviceを明示的にdisabledで構成し、各handlerへ環境分岐を散らしません。ProductionのLaunch Gate依存が欠落した場合も業務APIは503です。

## Migrationと初期状態

Forward migration `000011_production_launch_gate.up.sql`は次を追加し、初期値を必ずclosedにします。

- `launch_config`: singleton 1行、`public_access_enabled = FALSE`
- `launch_allowed_users`: `users.id`へのcascade FKを持つUUID allowlist

Migrationは既存User、Goal、Cycle、暗号化contentを変更しません。Production codeを起動する前に既存のmigration-first deploy経路で適用します。Request handlerからDDLやseedを実行しません。Singleton行の削除をOFF操作に使わず、欠落は障害として扱います。

## Reviewed DB operations

対象環境、DB、認証済みUser IDを確認してから既存の管理接続で実行します。以下は手順であり、本番操作の承認ではありません。User IDは本人の認証済み`GET /api/v1/session`から得たexact UUID v7を使い、Email、仮値、別serviceのIDを代用しません。

Developer / closed-beta Userを追加します。

```sql
INSERT INTO public.launch_allowed_users(user_id)
VALUES ('<exact-cycle-user-uuid-v7>');
```

Userを削除します。

```sql
DELETE FROM public.launch_allowed_users
WHERE user_id = '<exact-cycle-user-uuid-v7>';
```

一般公開を明示的に開始します。

```sql
UPDATE public.launch_config
SET public_access_enabled = TRUE, updated_at = clock_timestamp()
WHERE singleton = TRUE;
```

一般公開を閉じ、allowlist運用へ戻します。

```sql
UPDATE public.launch_config
SET public_access_enabled = FALSE, updated_at = clock_timestamp()
WHERE singleton = TRUE;
```

各write後は値と件数だけを確認し、allowlistのUUID一覧をlogやIssueへ出しません。

```sql
SELECT singleton, public_access_enabled, updated_at
FROM public.launch_config;
SELECT count(*) AS allowed_user_count
FROM public.launch_allowed_users;
```

## Promotion / smoke

1. Migrationを適用し、singleton 1行、flag false、allowlist 0件を確認する。
2. Productionへdeployする前にdeveloper本人のProduction User IDを確定し、allowlistへ追加する。
3. `public_access_enabled = FALSE`のままdeployし、`/readyz`が200、未許可Sessionのstatusが`canAccess:false`、業務APIが403であることを確認する。
4. Developer Sessionでlogin、logout相当のSession再作成、再login、reload、直接API、Goal CRUD、Cycle完了／再計画、Review、History、複数tab／端末、DB永続化、暗号化read/write、AIを確認する。Production providerの状態変更は承認された隔離test identityと範囲だけに限定する。
5. Closed Beta Userをexact IDで追加し、追加前403、追加後200、削除後403を確認する。
6. 一般公開の承認とsmoke evidenceが揃った後だけflagをtrueへ更新する。Allowlist Userと未登録Userの両方で`canAccess:true`と主要journeyを確認する。

Application rollback時もtableをdropしません。公開停止はflag falseで行い、診断用developer allowlistを残します。DB障害、singleton欠落、readiness 503、認証identity不一致、cacheされたUser別responseの兆候があればpromotionを停止します。
