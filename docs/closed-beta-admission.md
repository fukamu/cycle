# Closed Beta Admission（一時運用）

この文書は`cycle.fukamu.com`の初期Closed Betaだけで使用する一時runbookです。Application要件のSource of Truthである [`design.md`](design.md) へ取り込む恒久仕様ではありません。AdmissionはCloudflare Workerの公開ingressだけでAnonymous bootstrap前に強制し、User/Auth domain、Go Backend、Database schemaへ状態を持ちません。

## 境界と挙動

- `BETA_ADMISSION_MODE=closed`では、有効なAdmission Cookieを持たない`POST /api/v1/session/anonymous`をWorkerで拒否し、Containerへ転送しません。
- Session CookieもAdmission Cookieもない`GET /api/v1/session`は`BETA_ADMISSION_REQUIRED`を返し、FrontendはTurnstileより前に招待画面を表示します。
- 有効なFUKAMU Cycle Sessionを持つ利用者にはAdmissionを再要求しません。
- Invite Tokenのredeem成功時は、署名付き・期限付きの`__Host-fukamu_cycle_beta_admission` Secure HttpOnly Cookieを発行します。
- `BETA_ADMISSION_MODE=off`ではAdmission処理を論理的に無効化し、既存のAnonymous bootstrapを変更せず利用します。
- `closed`の設定が欠落・不正なら新規利用開始だけをfail-closedにし、既存SessionのAPI利用は継続させます。

Invite TokenはstatelessなBearer Tokenです。Allowlistから削除すると新しいredeemは拒否されますが、発行済みAdmission CookieやFUKAMU Cycle Sessionは個別失効しません。

## Configuration

ProductionのGitHub EnvironmentとCloudflare Workerへ次を設定します。値の分類は [`environment.md`](environment.md) を参照してください。

```text
BETA_ADMISSION_MODE=closed
BETA_ADMISSION_COOKIE_TTL_DAYS=<1..730の承認済み期間>
BETA_INVITES=<Invite entryのJSON array>
BETA_ADMISSION_COOKIE_KEY=<32 random bytesのbase64url secret>
```

未知のmodeや空AllowlistでClosed Betaを開始しません。`BETA_INVITES`は1〜1000件のJSON arrayとし、各entryは追加fieldのない`{"id":"...","digest":"..."}`にします。`id`は1〜64文字のlowercase英数字で始まるlowercase英数字・`_`・`-`だけのuniqueな非個人識別子、`digest`は64文字lowercase hexadecimalかつuniqueとします。`id`へ氏名やemailを含めません。Deploy preflightとWorker runtimeは同じparserでこの境界を検証します。

## Cookie signing keyの初期設定

共有・記録されるterminalでは実行しません。

```bash
./scripts/new-beta-admission-key.sh
```

表示された値をGitHub `production` Environment secret `BETA_ADMISSION_COOKIE_KEY`へ直接保存します。Repository、`.env`、issue、PR、runbook、release記録へ値を残しません。

## Invite Tokenの発行

1. 個人情報を含まないInvite IDを割り当てます。
2. 共有・記録されるterminalではないことを確認して生成します。

```bash
./scripts/new-beta-invite.sh --invite-id beta-001
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
https://cycle.fukamu.com/#beta-invite=<URL-encoded raw token>
```

## Invite TokenをAllowlistから外す

1. GitHub `production` Environment variable `BETA_INVITES`から対象Invite IDのentryを削除します。
2. Review済みのProduction deployで設定を反映します。
3. Admission Cookieを持たないfresh browserから削除済みTokenをredeemし、`403 BETA_INVITE_INVALID`になることを確認します。Token自体を検証logへ残しません。

この操作は今後のredeemだけを止めます。全発行済みAdmission Cookieを失効する必要があるincidentでは`BETA_ADMISSION_COOKIE_KEY`を新しい32-byte keyへrotateしてdeployします。既存の有効なFUKAMU Cycle Sessionは、繰り返しAdmissionを要求しない要件により継続します。特定参加者の即時個別失効が必要になった場合は、このstateless Admissionの範囲を超えるため、実装を推測で拡張せず判断を停止します。

## Deploy前後の確認

Deploy前:

- `BETA_ADMISSION_MODE=closed`、TTL、Allowlist、Cookie keyがProduction Environmentに存在する。
- Raw Invite TokenやCookie keyが差分、workflow log、shell historyへ入っていない。
- `PUBLIC_ORIGIN=https://cycle.fukamu.com`で、Worker/Containerへの公開入口がcustom domainだけである。

Deploy後:

1. `/healthz`と`/readyz`が200。
2. fresh browserの未招待アクセスで招待画面が表示され、Anonymous Userが作成されない。
3. 不正Tokenが拒否される。
4. 有効Tokenで一度redeemするとAnonymous User + Sessionだけが作成される。
5. reloadで招待確認が再表示されない。
6. Google連携後も同一Application User IDとDataを維持する。
7. Worker Logs/TracesへToken、digest、Cookie、User Contentがない。

## 一般公開と物理撤去

一般公開と物理撤去の最終判定者はProject Ownerです。論理無効化のdeployと物理撤去は別の変更として個別に明示承認し、同時に行いません。

### 1. 論理無効化

1. Review済みの変更で`BETA_ADMISSION_MODE=off`だけをdeployします。観測期間中はrollbackに備えてclosed用のGitHub Environment値とWorker secretを保持し、値自体をlogや記録へ出しません。
2. 次を確認し、deploy対象revision、確認開始日時、結果をSecretを含まない運用記録へ残します。
   - fresh browserがInvite Tokenなしで既存のTurnstile付きAnonymous bootstrapを完了し、UserとSessionを1組だけ作成できる。
   - 既存SessionがAdmission画面を再表示せず、同じApplication UserとDataを継続する。
   - Google連携、Goal作成、P/D/C/A、Cycle完了の主要flowがAdmissionとは独立して動く。
   - `/healthz`、`/readyz`、error rate、Worker/Container logに一般公開切替を原因とする未解決の異常がない。
3. この切替にDatabase migration、User/Auth migration、既存Data correctionを追加しません。

### 2. 7日間の安定確認

- 論理無効化後、Project Ownerが連続7日間（168時間）の安定確認を行います。
- 毎日、fresh anonymous bootstrap、既存Session継続、主要flow、health/ready、認証・bootstrap error、利用者報告を確認します。未決の数値thresholdは推測で追加せず、承認済みの通常運用基準と切替前baselineを使います。
- `closed`へのrollback、Admission起因か判断できない認証・bootstrap障害、主要flowの未解決regressionがあれば期間をresetし、修正後の`off` deployから7日間を数え直します。
- 7日間の完了だけでは撤去を開始しません。確認結果をProject Ownerが承認し、物理撤去を別途明示承認した場合だけ次へ進みます。

### 3. 単一変更での物理撤去

物理撤去は互換layerやdead codeを残さず、次を1つのreview可能な変更でまとめて行います。

| Area | 同じ変更で削除・更新する対象 |
|---|---|
| Worker ingress | `cloudflare/src/beta-admission/`、`cloudflare/src/index.ts`のimportとAdmission hook、`cloudflare/wrangler.jsonc`の`BETA_*` vars |
| Generated Cloudflare types | `cloudflare/worker-configuration.d.ts`を`pnpm --filter fukamu-cycle-cloudflare run types`で再生成し、`BETA_*` bindingを除去。手編集しない |
| Frontend | `frontend/src/features/beta-admission/`、`SessionProvider.tsx`のimport・`BETA_ADMISSION_REQUIRED`分岐・専用retry判定、対応するFrontend test |
| Bash helpers | `scripts/new-beta-invite.sh`、`scripts/new-beta-admission-key.sh`、`scripts/tests/run.sh`のAdmission helper test |
| Deploy workflow | `.github/workflows/deploy.yml`の`BETA_*` Environment/secret入力、validation、ephemeral secrets file追加、Wrangler `--var`組立 |
| Documents | `docs/environment.md`、`docs/operations.md`のAdmission記述と導線、および役目を終えたこのrunbook |
| External settings | 新codeのdeployとrollback可否確認後、別途承認された外部操作としてGitHub EnvironmentとCloudflare Workerから`BETA_*` variable/secretを削除 |

現在のAdmission固有依存は上表のWorker ingress、Frontend feature、helper、workflow、generated type、文書に限定されます。Go Backend、Domain、Database schema/migration、`infra/terraform/`にはAdmission固有状態も依存もないため、物理撤去でschema/data migrationを作成しません。

撤去変更では次のzero-match監査と通常の全検証を行います。

```bash
rg --hidden -n 'BETA_|beta-admission|BetaAdmission|fukamu_cycle_beta|Closed Beta Admission' \
  --glob '!node_modules/**' --glob '!frontend/dist/**' --glob '!.git/**' .
./scripts/check.sh
```

最初のcommandはexit code 1（matchなし）を成功条件とします。加えてCloudflare test/dry-run、Frontend test/build、Bash test、消去可能なDBだけを使うE2Eで、InviteなしAnonymous bootstrapと既存Sessionを再確認します。外部値を削除した後に旧Admission codeへrollbackする場合は必要なsecretを安全に復元する別承認が必要になるため、rollback期間の終了をProject Ownerが確認するまでは外部値を削除しません。
