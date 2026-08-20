# Closed Beta Admission（一時運用）

この文書は`app.pdcai.io`の初期Closed Betaだけで使用する一時runbookです。Application要件のSource of Truthである [`design.md`](design.md) へ取り込む恒久仕様ではありません。AdmissionはCloudflare Workerの公開ingressだけでAnonymous bootstrap前に強制し、User/Auth domain、Go Backend、Database schemaへ状態を持ちません。

## 境界と挙動

- `BETA_ADMISSION_MODE=closed`では、有効なAdmission Cookieを持たない`POST /api/v1/session/anonymous`をWorkerで拒否し、Containerへ転送しません。
- Session CookieもAdmission Cookieもない`GET /api/v1/session`は`BETA_ADMISSION_REQUIRED`を返し、FrontendはTurnstileより前に招待画面を表示します。
- 有効なPDCAI Sessionを持つ利用者にはAdmissionを再要求しません。
- Invite Tokenのredeem成功時は、署名付き・期限付きの`__Host-pdcai_beta_admission` Secure HttpOnly Cookieを発行します。
- `BETA_ADMISSION_MODE=off`ではAdmission処理を論理的に無効化し、既存のAnonymous bootstrapを変更せず利用します。
- `closed`の設定が欠落・不正なら新規利用開始だけをfail-closedにし、既存SessionのAPI利用は継続させます。

Invite TokenはstatelessなBearer Tokenです。Allowlistから削除すると新しいredeemは拒否されますが、発行済みAdmission CookieやPDCAI Sessionは個別失効しません。

## Configuration

ProductionのGitHub EnvironmentとCloudflare Workerへ次を設定します。値の分類は [`environment.md`](environment.md) を参照してください。

```text
BETA_ADMISSION_MODE=closed
BETA_ADMISSION_COOKIE_TTL_DAYS=<1..730の承認済み期間>
BETA_INVITES=<Invite entryのJSON array>
BETA_ADMISSION_COOKIE_KEY=<32 random bytesのbase64url secret>
```

未知のmodeや空AllowlistでClosed Betaを開始しません。`BETA_INVITES`の`id`は`beta-001`のような非個人識別子とし、氏名やemailを含めません。

## Cookie signing keyの初期設定

共有・記録されるterminalでは実行しません。

```powershell
pwsh ./scripts/new-beta-admission-key.ps1
```

表示された値をGitHub `production` Environment secret `BETA_ADMISSION_COOKIE_KEY`へ直接保存します。Repository、`.env`、issue、PR、runbook、release記録へ値を残しません。

## Invite Tokenの発行

1. 個人情報を含まないInvite IDを割り当てます。
2. 共有・記録されるterminalではないことを確認して生成します。

```powershell
pwsh ./scripts/new-beta-invite.ps1 -InviteId beta-001
```

3. 表示された生Tokenだけを招待対象者へ安全な経路で一度共有します。生Tokenを保存・commit・log出力しません。
4. 表示されたAllowlist entryを`BETA_INVITES` JSON arrayへ追加します。

```json
[
  {"id":"beta-001","digest":"<64 lowercase hexadecimal characters>"},
  {"id":"beta-002","digest":"<64 lowercase hexadecimal characters>"}
]
```

5. Review済みのProduction deployで設定を反映します。
6. 招待linkにする場合はqueryではなくfragmentを使います。Frontendは値を読んだ直後にaddress barから削除します。

```text
https://app.pdcai.io/#beta-invite=<URL-encoded raw token>
```

## Invite TokenをAllowlistから外す

1. GitHub `production` Environment variable `BETA_INVITES`から対象Invite IDのentryを削除します。
2. Review済みのProduction deployで設定を反映します。
3. Admission Cookieを持たないfresh browserから削除済みTokenをredeemし、`403 BETA_INVITE_INVALID`になることを確認します。Token自体を検証logへ残しません。

この操作は今後のredeemだけを止めます。全発行済みAdmission Cookieを失効する必要があるincidentでは`BETA_ADMISSION_COOKIE_KEY`を新しい32-byte keyへrotateしてdeployします。既存の有効なPDCAI Sessionは、繰り返しAdmissionを要求しない要件により継続します。特定参加者の即時個別失効が必要になった場合は、このstateless Admissionの範囲を超えるため、実装を推測で拡張せず判断を停止します。

## Deploy前後の確認

Deploy前:

- `BETA_ADMISSION_MODE=closed`、TTL、Allowlist、Cookie keyがProduction Environmentに存在する。
- Raw Invite TokenやCookie keyが差分、workflow log、shell historyへ入っていない。
- `PUBLIC_ORIGIN=https://app.pdcai.io`で、Worker/Containerへの公開入口がcustom domainだけである。

Deploy後:

1. `/healthz`と`/readyz`が200。
2. fresh browserの未招待アクセスで招待画面が表示され、Anonymous Userが作成されない。
3. 不正Tokenが拒否される。
4. 有効Tokenで一度redeemするとAnonymous User + Sessionだけが作成される。
5. reloadで招待確認が再表示されない。
6. Google連携後も同一Application User IDとDataを維持する。
7. Worker Logs/TracesへToken、digest、Cookie、User Contentがない。

## 一般公開と物理撤去

最初に`BETA_ADMISSION_MODE=off`へ変更してdeployし、fresh browserが招待なしで既存Anonymous bootstrapを完了できることを確認します。この論理無効化にDatabase変更はありません。

安定確認後、別のreview済み変更で次をまとめて削除します。

- `cloudflare/src/beta-admission/`
- `cloudflare/src/index.ts`のAdmission hook
- `frontend/src/features/beta-admission/`
- `SessionProvider.tsx`の`BETA_ADMISSION_REQUIRED`分岐
- `scripts/new-beta-invite.ps1`と`scripts/new-beta-admission-key.ps1`
- `BETA_*` deployment inputs、tests、このrunbookと他文書からの導線
- Cloudflare Worker/GitHub Environmentの`BETA_*` values

Database migration、User/Auth migration、既存User data correctionは不要です。
