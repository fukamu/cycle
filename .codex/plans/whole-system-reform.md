# FUKAMU Cycle Whole-System Reform ExecPlan

- 保存先: `.codex/plans/whole-system-reform.md`
- 基準commit: `fe2c82a5705d192ceddbcb61aa217c6f9f45c29c`
- 初版作成日: 2026-08-22
- 状態: IN_PROGRESS / M13 AI/draft/account concurrency

この文書は自己完結したliving ExecPlanであり、次の担当者が再開位置、確定判断、未決gate、変更順序、検証、復旧方法をこの文書だけから判断できるよう維持する。実際のrepository変更前にはrepository governanceとして`AGENTS.md`を読み、Normative contractを変更するmilestoneでは`docs/design.md`の該当箇所と照合する。進捗、判断、検証結果、残存riskは作業ごとにこの文書へ追記する。

## 1. Mission

利用者から観測できる仕様、認証・認可、data integrity、security、reliabilityを維持しながら、Frontend、Backend、Database、CI/CD、Infrastructure、依存関係、文書体系を、最小で明示的な構造へ段階的に改革する。

## 2. Scope

- React SPA、Go API、PostgreSQL、Cloudflare Worker/Container、Terraform、GitHub Actions
- API DTO、error、autosave、idempotency、AI連携、認証・session
- Migration、sqlc、test、fixture、mock、script、設定、文書、生成物
- 各milestoneのacceptance criteria、validation、rollback、progress管理

## 3. Non-goals

- 現在の内部構造、内部型、未公開API、file配置の温存
- Microservice化、将来用拡張point、新機能の追加
- Production値、provider、予算、retentionの推測
- Security、observability、CI gateを簡素化目的で弱めること
- `000001_fukamu_cycle_baseline`の再編集
- 本計画作成と同時に改革実装を開始すること

## 4. Confirmed facts

- 監査開始時の`main` working treeはclean、tracked fileは230。計画作成branchでは本計画ファイルだけが意図した変更である。
- Frontend format/lint/typecheck、26 Vitest files・70 tests、production buildが成功。
- Backend gofmt/vet/unit・integration・API tests、sqlc compile/generate、空DB migrationが成功。
- Playwright 8 scenariosがdisposable PostgreSQL上で成功。
- Cloudflare tests、Wrangler dry-run、Container build、Terraform fmt/init/validate、Compose、shell tests、actionlintが成功。
- Host tool不足のため固定Docker環境を使用した。
- 検証container内で`go build ./cmd/server ./cmd/migrate`を実行すると、`error obtaining VCS status: exec: "git": executable file not found in $PATH`で失敗した。同じsourceを`go build -buildvcs=false ./cmd/server ./cmd/migrate`でbuildすると成功した。これはcode defectではなく検証containerのtool不足であり、改革前修正の停止条件にはしない。変更前後比較では同一の`-buildvcs=false` commandを使用し、正式なrepository gateはGitを含む規定環境で実行する。
- Production codeから到達可能な既知脆弱性は検出されなかったが、chiは修正版への更新候補。
- Frontendではaccount切替後も旧userのTanStack Query cacheが残る。
- Backendでは`CompleteCycle`と`Terminate`のlock順序が異なり、deadlock可能性がある。
- Autosave revision conflict、response-loss replay、Unicode code-point制限、Review本文比較に契約不一致がある。
- OpenTelemetry provider/exporterがproduction compositionに存在せず、多数のmetricが未接続。
- `docs/design.md`は6,720行で、規範、設計、例、運用説明が過密。
- Worker、Container、assets、custom-domain routeはWrangler所有。Terraform所有はTurnstile widgetのみ。

## 5. Assumptions

- Repository外にFrontend/Backend間APIの利用者がいる証拠はない。確認されるまでは既存wire shapeを破壊しない。
- Free/MVPの同時進行Goal上限は2件。
- Homeは既存の`GoalView`と`currentWork`を共用する。
- Goal Refine結果fieldは全境界で`suggestion`へ統一する。
- `docs/design.md`を唯一のNormative Source of Truthとして維持する。
- main CIのPR artifact再利用、tree一致検証、full-CI fallbackは維持する。
- Turnstile Terraform管理を維持し、state recoveryを強化する。
- Closed Beta admissionは現役機能であり、所定の撤去条件を満たすまで削除しない。
- 新規production dependencyは総複雑性または信頼性を明確に改善する場合だけ追加する。

## 6. Open decisions

次の項目はownerが値を決めるまで推測しない。該当gate以外の安全に独立したmilestoneは進めてよい。

| Decision | Owner / deadline | 未決時の動作 |
| --- | --- | --- |
| Repository外API consumerの有無 | Product owner、M0開始前 | 非互換wire変更を禁止し、現在のroute/shapeを維持 |
| OTLP endpointとcredential | Operations owner、M22 staging deploy前 | OTLP/HTTP実装とin-memory testまでは進めるが、staging deployを停止 |
| Telemetry retention、dashboard、alert、notification、on-call | Operations owner、Production release前 | Production releaseを停止。code側defaultを推測しない |
| Production capacity、Neon backup/restore、provider limit | Operations owner、Production release前 | Production infrastructure作成とdeployを停止 |
| AI model、価格、budget、rate limitのProduction値 | Product/Operations owner、Production release前 | Staging承認値をProductionへcopyせず、Production releaseを停止 |
| Terraform state snapshot保持期間 | Operations owner、M27 cleanup追加前 | Snapshotをprivate R2へ保存するが、自動削除しない |
| Browser Draft recovery telemetry transport | Product/Security owner、M23 instrumentation前 | Backendで観測可能なmetricは進めるが、新しいbrowser telemetry endpoint/header/exporterを推測で追加しない |
| Terraform R2 credential topology | Operations owner、M27 workflow変更前 | Snapshot helperとlocal isolated testは進めるが、secret配置、Plan/Apply権限、live R2 drillを変更・実行しない |
| React Hook Formを削除する設計変更 | Product/Architecture owner、M29 dependency削除前 | chi等の独立更新は進めるが、RHFと該当SoTは維持 |
| Goal Delete時のQuota window外AI Usageに別のRetention理由があるか | Product/Security owner、M15 Delete移行前 | 現行SoTの即時削除と実装の全件redacted保持が不一致のためM15 Deleteだけを停止し、M14とM15 read/query等の独立作業は継続 |
| Closed Beta終了日 | Product owner | `off` deploy、連続168時間、owner承認までcode/config/runbookを維持 |

## 7. Current behavior contract

### 7.1 Anonymous bootstrap

- **Actor / precondition / trigger**: 有効sessionを持たないbrowser。Closed Beta admission、exact Origin、Turnstile、rate limitを満たしてbootstrapを要求する。
- **Expected result / persisted state**: anonymous user、bootstrap record、session、CSRF material、必要なrate bucketを一度だけ作成し、Secure/HttpOnly/SameSite cookieを返す。
- **Error / permission / edge cases**: admission拒否、Turnstile失敗、provider outage、rate limit、重複・並行bootstrapはfail-closed。Secretやraw tokenをlogしない。
- **Current tests / missing tests / evidence**: `frontend/e2e/critical-paths.spec.ts`、auth/Turnstile unit tests、Backend limiter testsが部分保護。正確なbootstrap cardinality、provider failure、Worker/deploy config parityが不足。根拠は`docs/design.md`のAnonymous/Admission/Security契約、`cloudflare/src/index.ts`、Backend session/bootstrap handlers。

### 7.2 Session refresh、Google upgrade/login、account delete

- **Actor / precondition / trigger**: anonymousまたはauthenticated userがsession refresh、Google upgrade、既存Google identityへのlogin、account deleteを行う。
- **Expected result / persisted state**: 同一user upgradeはuser/Goalを維持してidentityを追加する。既存identity loginはtarget userへsessionを切り替え、user同士をmergeしない。Deleteはown accountと関連dataを削除しsessionを失効する。
- **Error / permission / edge cases**: Google collision、unverified token、concurrent session revoke、cross-user操作はstable errorまたは404。User IDが変わるloginでは旧server cacheとbrowser draftを表示・送信しない。
- **Current tests / missing tests / evidence**: Backend session/account、Settings/SessionProvider、same-tab/cross-tab Google、cache isolation、delete/revisit、Expected User、Web Lock、deletion advisory/tombstone testが保護する。DB上のsession revoke/account delete同時実行CASはM13で追加する。根拠はaccount/session handlers、repositories、`SessionProvider.tsx`、`contract-characterization.spec.ts`。

### 7.3 Homeと同時進行Goal上限

- **Actor / precondition / trigger**: 有効sessionを持つuserがHomeを開く。
- **Expected result / persisted state**: own Goalだけを`GoalView/currentWork`で返す。Free/MVPの同時進行Goal上限は2。Read-only requestはstateを変更しない。
- **Error / permission / edge cases**: third progressing Goalの開始をstable limit errorで拒否。Cross-user Goalは404。Draft、active cycle、review、terminalの表示stateを混同しない。
- **Current tests / missing tests / evidence**: `frontend/src/pages/HomePage.test.tsx`、Backend integration、E2Eの2件/3件目拒否が保護。SoT内の1件例とHome専用DTO記述が矛盾。根拠は`docs/design.md`、Home DTO schema、workspace types。

### 7.4 Goal draft、refine、start

- **Actor / precondition / trigger**: progressing Goal枠があるownerがdraftを作成・保存し、任意でGoal Refineを採用して開始する。
- **Expected result / persisted state**: Goal本文は1–80 Unicode code points。Revision付きautosave、AI generation/usage/budget settlement、idempotent startを行い、Goalと初期work stateをatomicに確立する。
- **Error / permission / edge cases**: stale revision、blank/over-limit/NUL、AI timeout/quota/budget/provider error、response loss、double-tap、cross-user accessを明示的に処理する。
- **Current tests / missing tests / evidence**: domain/application tests、`useDraftAutoSave.test.ts`、主要E2Eが部分保護。80/81 non-BMP、実409 recovery、Goal Refine adoption、response-loss replayが不足。根拠はGoal domain、workspace service/store、New Goal UI/API。

### 7.5 Cycle editing、browser recovery、Action AI

- **Actor / precondition / trigger**: active cycleのownerが各frameを編集・autosaveし、Action AIを要求する。
- **Expected result / persisted state**: frame本文は0–200 Unicode code points。Keyed latest-value coalescing、single in-flight、monotonic revision、user-scoped IndexedDB recovery、AI usage/cost settlementを維持する。
- **Error / permission / edge cases**: same/different-frame同時save、stale revision、network loss、browser/server差分、AI timeout/cancel/quota/provider failure、late responseをdata lossなく処理する。
- **Current tests / missing tests / evidence**: `GoalWorkspacePage.test.tsx`、browser cache/autosave tests、in-flight E2Eが部分保護。Server revision conflict、Action AI failure、same/different-frame DB concurrencyが不足。根拠はCycle domain、workspace AI/store、Goal Workspace UI/API。

### 7.6 Cycle completionとReview編集

- **Actor / precondition / trigger**: 必須frameが揃ったactive cycle ownerがcompleteし、ReviewでGoal本文を確認・編集・refineする。
- **Expected result / persisted state**: CompletionはGoalとCycleをatomicにreview stateへ移す。Review本文はCRLFとlone CRをLFへ正規化した後、trimせずexact compareし、変更時だけGoal versionを作成する。
- **Error / permission / edge cases**: `CYCLE_COMPLETION_INPUT_INCOMPLETE`は`missingFrames` detailsを返す。Double completion、Complete/Terminate、response replay、trailing whitespaceを正しく処理する。
- **Current tests / missing tests / evidence**: domain/integration/E2Eのcomplete-review flowが部分保護。Deterministic deadlock test、exact comparison frontend test、missingFrames contractが不足。根拠はCycle/Goal domain、workspace transitions、Review UI/API。

### 7.7 Continue Reviewとterminal遷移

- **Actor / precondition / trigger**: review stateのownerが次Cycleへ進むかGoalをterminalにする。
- **Expected result / persisted state**: いずれか一方をidempotentかつserializedに適用し、next cycleまたはterminal Goalを作る。Replay時はcurrent workspaceを返す。
- **Error / permission / edge cases**: double-tap、Continue/Terminate競合、stale/replayed command、AI operation in progress、cross-user操作を一貫したerror/404で処理する。
- **Current tests / missing tests / evidence**: terminate/start concurrencyとreview discard E2Eが部分保護。Continue/Terminate競合、replay navigation、terminal後の新Goalが不足。根拠はworkspace transitions、Review UI/API。

### 7.8 History、timeline、version表示

- **Actor / precondition / trigger**: Goal ownerがhistory/timelineを開きpaginationする。
- **Expected result / persisted state**: versionとcycleを規定順で返し、canceled cycleをread-only表示する。Read requestはstateを変更しない。Dateはbrowser locale/timezoneで表示する。
- **Error / permission / edge cases**: invalid cursor、empty page、timezone boundary、long text、cross-user readを処理する。
- **Current tests / missing tests / evidence**: `GoalHistoryPage.test.tsx`、`GoalTimelinePage.test.tsx`、V1–V3 E2Eが保護。Timezone matrixとterminal/canceled journeyが不足。根拠はHistory/Timeline UI、workspace query/store、pagination contract。

### 7.9 Goal delete

- **Actor / precondition / trigger**: Goal ownerが明示確認後にGoalを削除する。
- **Expected result / persisted state**: Goal、version、cycle、draft、関連AI stateを契約どおり処理し、delete receiptとbudget reservationを一度だけ更新する。
- **Error / permission / edge cases**: running AI、replay、reservation release 0 rows、concurrent delete、cross-user deleteをstable error/404で処理する。
- **Current tests / missing tests / evidence**: main E2EとBackend replay/integrationが部分保護。Cascade、RowsAffected/CAS、AI finalization競合が不足。根拠はworkspace transitions、Goal delete handler/UI。

### 7.10 Failure recoveryとsecurity boundary

- **Actor / precondition / trigger**: 全user flowでsession expiry、network loss、409、provider failure、server restart、malformed inputが発生する。
- **Expected result / persisted state**: committed server stateを正本とし、未保存browser inputを明示選択で回復する。Operation IDは成功・明示破棄まで維持し、retryで副作用を重複させない。
- **Error / permission / edge cases**: Unknown JSON、oversized body、CSRF/Origin failure、cross-owner、quota/budget、timeout/cancelをstable codeへmappingし、本文/secretをlogしない。
- **Current tests / missing tests / evidence**: API/client、session expiry/preemption、二層Error Boundary、real revision conflict、response-loss、autosave failure、cross-user testが保護する。External provider transport failureとserver restart recoveryの網羅はM19/M33で追加する。根拠はHTTP middleware/errors、API client、observability/security sections。

## 8. Current architecture

```text
Browser React SPA
  -> Cloudflare Worker + static assets
      -> singleton Cloudflare Container / Go HTTP API
          -> PostgreSQL / Neon
          -> OpenAI
          -> Google identity verification
          -> Turnstile

GitHub Actions
  -> main CI artifact reuse or full fallback
  -> Terraform Plan / approved Apply for Turnstile
  -> migration-first Wrangler deploy
```

Backendのimport方向は概ね`HTTP -> Application -> Domain`、`Infrastructure -> Application/Domain`でcycleはない。一方、transaction、lock、quota、idempotencyが巨大なPostgreSQL Storeへ集中し、Application Serviceがpass-through化している。

Frontendはroute pageがAPI orchestration、state machine、autosave、IndexedDB、UIを同時に所有している。`GoalWorkspacePage`は1,065行で、別の450行autosave hookと保存制御を重複実装している。

## 9. Documentation inventory

| 文書 | 現在の分類 | 方針 |
| --- | --- | --- |
| `docs/design.md` | Normative / Decision / Descriptive | 唯一のNormative SoTとして縮約 |
| `AGENTS.md` | Normative / Operational | repository governanceとgateだけを保持 |
| `README.md` | Descriptive / Operational | 概要、quick start、索引だけにする |
| `docs/development.md` | Operational | local開発、test、codegen、AI評価を統合 |
| `docs/environment.md` | Operational / Descriptive | runtime configの正本として維持しparity test追加 |
| `docs/database.md` | Operational / Descriptive | migration/reset/data safetyの正本として維持 |
| `docs/deployment.md` | Operational / Descriptive | `operations.md`へ統合後削除 |
| `docs/operations.md` | Operational | deploy、monitor、incident、rollback/restoreの正本 |
| `docs/troubleshooting.md` | Operational | development/operationsへ分配後削除 |
| `docs/ai-evaluation.md` | Operational | developmentへ統合後削除 |
| `docs/closed-beta-admission.md` | Operational / Temporary | Beta撤去条件まで維持 |
| Terraform README | Descriptive / Operational | operationsへ統合後削除 |
| sqlc Go files | Generated | 生成元と同じcommitで`./scripts/invoke-sqlc.sh compile generate`を実行し、手編集しない |
| `cloudflare/worker-configuration.d.ts` | Generated / ignored | `pnpm --filter fukamu-cycle-cloudflare run types`で再生成し、binding変更と同じloopでtypecheckする。手編集しない |

現行repositoryに独立ADR、Historical、Obsolete、Unknown文書はない。新しいArchitecture文書やADR directoryは作らず、長期的な規範と理由は`docs/design.md`へ一度だけ記載する。

## 10. Problems and root causes

1. **Cross-user data isolation**: sessionだけを置換し、user非依存query keyと30秒fresh cacheを残している。
2. **Transaction reliability**: global lock orderが一箇所に強制されず、各Store methodが独自にlockしている。
3. **Retry semantics**: operation IDをAPI call内部で生成し、response loss後に同じcommandとして再試行できない。
4. **Autosave duplication**: creation/reviewとcycleでsave queue、retry、recovery、状態表現を別実装している。
5. **Application責務の逆転**: orchestrationがPostgres adapterへ流出し、巨大Store/interfaceを形成している。
6. **AI境界の弱さ**: generic operation string、adapter内validation、retryabilityの過剰正規化がある。
7. **Observabilityの見かけだけの実装**: API instrumentはあるがprovider/exporterとcall siteが不足する。
8. **設定とdeployの多重管理**: 49 env keys、Closed Beta validation、security headerが複数箇所へ複製されている。
9. **CI/Infrastructure complexity**: 必要な安全経路はあるが、state recovery、post-deploy E2E、supply-chain gateが不足する。
10. **文書過密**: 規範、例、runbook、現状説明が混在し、同一値を複数箇所で更新する必要がある。

## 11. Target architecture

### Frontend

- `app/`: provider、router、session bootstrap、query client、top-level Error Boundaryだけ。
- route module: parameter解決とfeature compositionだけ。
- feature: `session-account`、`goal-creation`、`cycle-workspace`、`goal-review`、`goal-history`、temporary `beta-admission`。
- `shared/`: HTTP transport、strict DTO parsing、query/cache policy、IndexedDB primitive、UI primitive、ID/date/text validationだけ。
- 1つのautosave coordinatorをcreation/review/cycleで共用し、keyed latest-value coalescingとsingle in-flightを実装。
- Operation IDはcallerが所有し、成功または明示破棄まで再利用。
- Identity change時はquery/mutationをcancelし、server cacheをclearしてから新sessionを設定。同一user upgradeでは保持。
- DTOとstable API error codeをdiscriminated unionとして扱う。

### Backend

- Modular monolithを維持する。
- HTTP adapterはdecode/validate/auth/error mappingのみ。
- ApplicationをGoal lifecycle、Cycle/Review、AI orchestrationの小さなuse caseへ分ける。
- Applicationがtransaction、idempotency、quota、global lock orderを所有する。
- 狭いUnit-of-Work/query portを定義し、Postgres adapterはSQL、row mapping、lock primitiveに限定。
- AIはoperation-specific typed ports/resultsとし、Domain/Applicationで最終validationする。
- OpenAI adapterはstrict schema、status classification、usage/cost、timeout/cancelだけを担当。
- UUID v7、keyed hash、text normalization、entitlement policyを一箇所へ集約する。

### Public/internal interfaces

- Routeと主要な意味は維持する。
- Homeは`GoalView/currentWork`をcanonical contractとする。
- Free Goal上限は2。
- Goal Refine fieldは`suggestion`。
- `CYCLE_COMPLETION_INPUT_INCOMPLETE`に`missingFrames` detailsを追加。
- Idempotency keyのwire位置は変えず、lifetimeだけをcaller-ownedにする。
- AI、repository、Unit-of-Work interfaceはtyped internal contractへ変更する。

## 12. Proposed deletions

削除前に、参照検索、runtime/config経路、clean build、test、文書参照の全てで不要性を証明する。

- `react-hook-form`と単一textarea用wrapper
- 未使用の`getGoalDraft`、不要な`operationId` export
- 重複したautosave状態、pagination controller、inline eligibility predicate
- generic `AIProvider.Execute(operation string)`と旧output wrapper
- 現行制限と不整合なPrompt v1のproduction選択経路
- typed query移行後の未使用sqlc query/generated surface
- UUID validator、keyed hash helper、version comparisonの重複
- `docs/deployment.md`、`docs/troubleshooting.md`、`docs/ai-evaluation.md`、Terraform README
- Closed Beta sliceは承認済み撤去条件成立後のみ一括削除
- main CI reuseとTerraformはuser判断により削除しない
- Database tableは現時点で削除を正当化できないため、先に削除対象としない

## 13. Proposed dependency changes

- chiを少なくとも既知修正版へ更新し、auth/origin/routing回帰を検証する。
- React Hook Formはautosave統合後に削除する。
- `go-playground/validator`は明示的な境界validationの方が小さくなることを証明できる場合だけ削除する。
- OpenTelemetryはstandard OTLP/HTTP trace・metric exporterを採用し、vendor固有SDKを追加しない。
- Wrangler、ESLint等の更新は一dependency・一commitで行い、lockfile、build、dry-run、E2Eを実行する。
- Third-party GitHub Actionは完全なcommit SHA、Docker/base imageはcontent digestへ固定する。人が読めるversion commentを併記し、Dependabotの週次PRを一ecosystem単位で検証する。
- CI scanner/toolはapplication runtime dependencyへ混ぜない。
- chi、pgx、migrate、OpenAI SDK、tokenizer、Google verifierは現在必要であり、削除対象にしない。

## 14. Database and migration strategy

- Repository ruleを優先し、`000001_fukamu_cycle_baseline`を編集しない。
- 現行13 tablesを出発点とし、不要性がbehavior contractとquery利用から証明されたものだけ後続migrationで変更する。
- Schema変更は`000002_...up.sql/down.sql`以降の新規pairとする。
- Global lock orderを`User -> Goal -> Draft/Cycle -> AIGeneration -> Budget`として共通helperとintegration testで強制する。
- Stable SQLを段階的にsqlcへ移し、dynamic SQLだけを狭く残す。
- Generated codeは手編集せず、`./scripts/invoke-sqlc.sh compile generate`で更新する。
- Empty DBで全upを検証する。downはdisposable DBだけで検証し、data-bearing環境ではforward repair migrationを使う。
- Schema変更が不要と判明した場合はmigrationを追加しない。

## 15. Documentation consolidation strategy

目標文書を次に限定する。

- `README.md`: 概要、quick start、文書index
- `docs/design.md`: product behavior、API意味、security/reliability invariant、dependency rule、acceptance criteria
- `docs/development.md`: setup、checks、testing、codegen、AI evaluation、開発時troubleshooting
- `docs/environment.md`: config名、意味、scope、secret/public分類
- `docs/database.md`: migration、reset guard、data safety
- `docs/operations.md`: Terraform、deployment、monitoring、incident、rollback/restore、本番troubleshooting
- `docs/closed-beta-admission.md`: temporary runbook

旧設計の各規範条項を新sectionとtestへmappingしてから文章を削る。値やcommandは一つの正本へ置き、他文書からlinkする。Config、Closed Beta入力、文書link/fenceは機械的parity checkで保護する。

## 16. Test and regression-prevention strategy

- Pure domain tests: text/code-point、version comparison、eligibility、state transition。
- Component tests: New Goal、Review、revision conflict、session expiry、Error Boundary、disabled reason。
- HTTP contract tests: 全endpointのauth、CSRF、owner 404、stable error code/details、unknown JSON。
- DB integration tests: deterministic lock barrierを使うComplete/Terminate、AI/delete、abandon/refine、double command、CAS、cascade。
- AI adapter tests: `httptest`でmodel、schema、`store=false`、timeout、cancel、retryable status、usage/costを検証し、live AIへ依存しない。
- E2E追加: Goal Refine adoption、active-cycle termination、terminal後の新Goal、Google upgrade/switch、cache isolation、Action AI failure、account delete/revisit、bootstrap cardinality、response-loss replay。
- Unicode 80/81・200/201 emoji、CRLF/CR、trailing whitespaceを境界testに含める。
- Architecture testsでFrontendのpage依存、Backendのlayer import、config parityを保護する。
- CSS class、RGB、内部DTO構築など実装詳細への過剰assertionは、利用者契約のassertionへ置換する。

## 17. Security and reliability invariants

- `__Host-` Secure/HttpOnly/SameSite Cookie、exact Origin、HMAC CSRFを維持する。
- Secret、本文、email、raw user/IP/tokenをlog、fixture、artifactへ出さない。
- Cross-user resourceは一貫して404とし、cache・IndexedDBを含めuser境界を越えない。
- Command、AI reservation、usage settlementはidempotentかつCASで保護する。
- Global DB lock orderを例外なく守る。
- Provider timeout、cancel、retryability、quota、budgetを明示する。
- Standard OTLP/HTTP exporterを使う。Local/testはin-memory、staging/productionはprotected environmentからendpoint/headerを注入し、未設定ならdeployを停止する。
- `.env.local`、`node_modules`、secret fileをDocker build contextへ含めない。
- Migration-first deploy、main tree一致、full-CI fallback、approved Terraform Applyを維持する。
- Observability追加時も本文やidentity情報をattributeへ載せない。
- Terraform applyはprivate R2へのpre-apply state snapshot成功を前提とし、snapshot失敗時はapplyを開始しない。

## 18. Before metrics

- Tracked files: 230
- Frontend production TS/TSX: 42 files / 5,036 LOC
- Frontend全体: 74 files / 9,249 LOC
- Frontend tests: 2,295 LOC、E2E 595 LOC
- Largest frontend files: workspace 1,065、autosave 450、review 349 LOC
- Frontend dependencies: runtime 6、dev 20
- Frontend bundle: JS約414.4KB raw / 134.5KB gzip、CSS 18.2KB / 4.45KB gzip
- Backend: 69 Go files / 10,607 LOC、20 packages
- Backend production/test: 8,163 / 2,444 LOC
- Go dependencies: direct 13、indirect 34、module graph 251
- Handwritten PostgreSQL calls: 122
- Backend SQL: 6 files / 526 LOC、baseline migration pair 1
- Cloudflare source: 3 files / 812 LOC
- Scripts: 15 files / 1,771 LOC
- Workflows: 4 files / 957 LOC
- Terraform: 5 primary files / 74 LOC
- Documents: 12 files / 8,110 LOC、`docs/design.md` 6,720 LOC
- GitHub full CI: 約4分16秒
- Duplication、cyclomatic complexity、coverage総率は、再現可能な固定toolがなかったため断定しない。

## 19. Milestones

1. **M0 Contract convergence**: 確定した3仕様と外部consumer前提をSoTへ反映。
2. **M1 Black-box characterization**: 現在通る主要flowとauthz/error matrixを実装非依存testで固定。
3. **M2 Identity/browser isolation**: account switch時のcache/draft漏洩を修正。
4. **M3 Docker context isolation**: `.env.local`と`node_modules`をbuild contextから除外しtest化。
5. **M4 Config/admission parity**: 49 config keysとClosed Beta validationの単一契約を機械検証。
6. **M5 Command idempotency/replay**: caller-owned operation IDとreplay workspace解決を実装。
7. **M6 Revision conflict recovery**: server 409からrefetch/明示選択で復旧。
8. **M7 Text/version semantics**: Unicode code-point、CR/CRLF、whitespace比較を統一。
9. **M8 Autosave coordinator**: creation/review/cycleを一つのsave engineへ移行。
10. **M9 Frontend app shell**: Error Boundary、session boundary、typed stable errorsをapp層へ集約。
11. **M10 Goal creation/review feature boundary**: routeからGoal creation/review policyをfeatureへ移動。
12. **M11 Cycle/history feature boundary**: workspace/history/timeline policyとpaginationをfeatureへ移動。
13. **M12 Complete/Terminate locking**: Goal-before-Cycle lock orderとdeterministic concurrency testを実装。
14. **M13 AI/draft/account concurrency**: AI finalization、abandon/refine、delete reservation、session revokeのCASを修正。
15. **M14 Goal draft/start use cases**: Goal draft/refine/start transactionをApplicationへ移動。
16. **M15 Goal history/delete use cases**: query/delete orchestrationをApplicationへ移動。
17. **M16 Cycle edit/complete use cases**: Cycle autosave/completion orchestrationをApplicationへ移動。
18. **M17 Review transition use cases**: continue/terminate/version orchestrationをApplicationへ移動。
19. **M18 Typed AI ports**: GoalRefiner/ActionGenerator resultとDomain validationをcanonical化。
20. **M19 OpenAI transport contract**: strict schema、retry classification、timeout/cancel、usage/costをadapter test化。
21. **M20 sqlc session/Goal migration**: stable session/Goal SQLをtyped queryへ移行。
22. **M21 sqlc Cycle/AI/schema cleanup**: 残るstable SQLとunused generated surfaceを整理し、必要時だけ新migration追加。
23. **M22 OTel SDK/exporter composition**: OTLP/HTTP trace/metric providerとshutdownをcompositionへ追加。
24. **M23 Metrics/correlation**: 必須metric、request/trace/generation correlation、PII allowlistを接続。
25. **M24 Abuse/retention cleanup**: goal-start limiterと期限付きrecord cleanup commandを追加。
26. **M25 CI security/document gates**: vulnerability、secret/IaC/container、config、Markdown link/fence gateを追加。
27. **M26 Post-deploy staging E2E**: 公開contractだけを使うself-cleaning critical journeyをdeploy後に実行。
28. **M27 Terraform state recovery**: pre-apply private snapshotとisolated restore drillを追加。
29. **M28 Supply-chain pinning**: Action SHA、image digest、Dependabot更新経路を固定。
30. **M29 Dependency cleanup**: RHF、chi更新、その他dependencyを一件ずつ整理。
31. **M30 Old implementation removal**: dead wrapper、Prompt v1、重複helper、旧query/pathをzero-reference後に削除。
32. **M31 Normative documentation convergence**: `docs/design.md`を契約trace付きで縮約。
33. **M32 Operational documentation consolidation**: development/environment/database/operationsへ統合し旧文書を削除。
34. **M33 Final clean-environment verification**: clean checkout、empty DB、full E2E、before/after metrics、DoD確認。

各milestoneは一つの責務だけを変更し、test追加、変更、検証、修正、Decision/Progress log更新までを一回の作業loopで終える。途中状態を次milestoneへ持ち越さない。

## 20. Acceptance criteria per milestone

| Milestone | Acceptance criteria |
| --- | --- |
| M0 | Goal上限2、Home `GoalView/currentWork`、`suggestion`がSoT内で一意。外部consumer確認結果をDecision logへ記録 |
| M1 | Behavior contract全flowのblack-box/authz/error testがgreen。既知bugを正当化する既存内部testへ依存しない |
| M2 | user ID変更時に旧query/mutation/browser draftを利用せず、同一user upgradeはdataを維持 |
| M3 | `.env.local`、root/frontend `node_modules`、secret fileがDocker context/imageに存在しない |
| M4 | Backend config、`.env.example`、environment docs、Worker handoff、deploy validationのkey/shapeが一致 |
| M5 | 同一operation IDをsuccess/explicit abandonmentまで再利用し、replay responseのcurrent workspaceを描画 |
| M6 | 409後に最新server revisionを取得し、overwriteせずuser選択または再適用で復旧 |
| M7 | 80/81・200/201 non-BMP、CRLF/CR、trailing whitespaceのFrontend/Backend testが一致 |
| M8 | 全editorが一つのautosave coreを使い、single in-flight、latest coalescing、browser recoveryを維持 |
| M9 | app層が二層Error Boundary、stable error、双方向identity binding、優先度付きsession recovery、origin-wide Cookie writer、cross-tab delete/tombstoneを所有し、旧User payloadと削除済みDraftを公開・復活させない |
| M10 | Goal creation/review routeはload/compositionだけで、policyとstate machineはfeature内 |
| M11 | Cycle/history routeはcompositionだけで、pagination/autosave/cache policyの重複がない |
| M12 | Complete/Terminate競合がdeadlockせず、global lock order structural/integration testがgreen |
| M13 | AI/delete/account競合で0-row updateや二重settlementをcommitせず、CAS testがgreen |
| M14 | Goal draft/refine/start orchestrationがApplication use caseにあり、PostgresはSQL/lock primitiveのみ |
| M15 | Goal query/history/deleteも同じboundaryに従い、owner/error contractが不変 |
| M16 | Cycle save/complete use caseがtyped Unit-of-Workを使い、API/E2E contractが不変 |
| M17 | Review continue/terminate/version use caseがserialized、idempotent、typed resultを返す |
| M18 | Generic AI operation stringがなく、Fake/OpenAIとも同じtyped Domain validationを通る |
| M19 | Model/schema/store=false/status/timeout/cancel/usage/costのmock transport contractがgreen |
| M20 | Session/Goal stable SQLがsqlc経由で、generated/sourceが一致 |
| M21 | Cycle/AI stable SQLがsqlc経由。Unused query削除。Schema変更時だけ`000002+` pairがgreen |
| M22 | Local/test in-memory exporterとOTLP/HTTP exporterが実span/metricを送信し、shutdownをflush |
| M23 | Required metrics/correlationがcall siteから観測でき、本文/secret/raw identityがattributeにない |
| M24 | goal-start limiterと期限cleanupがowner/retention契約を守り、dry-runとintegration testがgreen |
| M25 | Security/config/docs gateがCIで再現可能に失敗・成功し、tool versionが固定 |
| M26 | Deploy後critical journeyがunique anonymous accountを作成し、Goal/Cycle/Review後にaccountを削除 |
| M27 | Apply前snapshot失敗時にapply停止。Live stateを書き換えずisolated keyへのrestore drillが成功 |
| M28 | Third-party ActionはSHA、imageはdigestのみ。Version commentと更新PR gateを持つ |
| M29 | 各dependency変更でmanifest/lockfile/build/E2Eが同期し、unused direct dependencyがzero |
| M30 | 削除対象のcode/config/docs/queryがzero-referenceでclean build/E2Eに影響しない |
| M31 | Normativeなbehavior/invariant/API値は`docs/design.md`内で一箇所、旧条項traceに欠落なし |
| M32 | READMEから全運用正本へ到達でき、削除文書へのlinkと内容重複がzero |
| M33 | Final DoDをclean checkoutとempty disposable DBで満たし、before/after metricsを記録 |

## 21. Validation commands per milestone

### Validation profiles

```bash
# F: Frontend
./scripts/check.sh --scope frontend

# B: Backend
./scripts/check.sh --scope backend

# A: Repository全体
./scripts/check.sh

# E: Disposable DBを使うfull E2E
TEST_DATABASE_URL='<explicit disposable *_test database>' ./scripts/check.sh --e2e

# Q: sqlc/source consistency
./scripts/invoke-sqlc.sh compile generate
git diff --exit-code -- backend/internal/infrastructure/postgres/generated

# I: Infrastructure/deploy static validation
docker compose config
terraform -chdir=infra/terraform/staging fmt -check
terraform -chdir=infra/terraform/staging init -backend=false -input=false
terraform -chdir=infra/terraform/staging validate
pnpm --filter fukamu-cycle-cloudflare run check
pnpm --filter fukamu-cycle-cloudflare run deploy:dry-run

# D: Documentation/config gate（M25で追加）
./scripts/check-docs.sh
./scripts/check-config-parity.sh

# S: Security/supply-chain gate（M25/M28で追加）
./scripts/check-security.sh

# C: Commit前必須gate。全変更をstageしてから実行
TEST_DATABASE_URL='<explicit disposable *_test database>' ./scripts/check-before-commit.sh
```

`Q`のgenerateが意図した差分を生むmilestoneでは、生成元とgeneratedを同じcommitへ含め、再実行後に追加差分がないことを確認する。`C`成功後にindexまたはworking treeを変更した場合は`C`を最初から再実行する。

| Milestone | 必須validation |
| --- | --- |
| M0 | A、Dのうち既存link確認、E、C |
| M1 | A、E、C |
| M2 | F、account-switch component/E2E、E、C |
| M3 | A、Container build-context inspection、I、C |
| M4 | A、config/admission parity tests、I、C |
| M5 | F、Backend replay integration、response-loss E2E、E、C |
| M6 | F、409 component/API test、E、C |
| M7 | F、B、Unicode/newline boundary tests、E、C |
| M8 | F、autosave fake-timer/serialization tests、E、C |
| M9 | F、Error Boundary/stable error、Expected/Actual User matrix、recovery priority/ABA、Web Lock、同一Browser Context二tabのGoogle/account delete、tombstone transaction/privacy tests、E、C |
| M10 | F、Goal creation/refine/review E2E、E、C |
| M11 | F、Cycle/history/timeline/mobile E2E、E、C |
| M12 | B、deterministic Complete/Terminate integration、E、C |
| M13 | B、AI/delete/account concurrency integration、E、C |
| M14 | B、Goal draft/refine/start API tests、E、C |
| M15 | B、Goal history/delete authz/API tests、E、C |
| M16 | B、Cycle save/complete API/integration、E、C |
| M17 | B、Review transition/replay integration、E、C |
| M18 | B、typed Fake/OpenAI validation tests、E、C |
| M19 | B、`httptest` OpenAI transport contract、C。Live AIは使用しない |
| M20 | B、Q、E、C |
| M21 | B、Q、empty DB up、disposable DB down/up、E、C |
| M22 | B、in-memory OTLP receiver integration、A、C。Staging deploy前にendpoint secret確認 |
| M23 | B、metric/span export assertions、PII allowlist/log scan、A、C |
| M24 | B、cleanup dry-run/integration、E、C |
| M25 | A、D、S、I、negative fixture tests、C |
| M26 | A、I、`./scripts/check-staging-critical.sh`、C |
| M27 | I、isolated R2 backend key restore drill、checksum comparison、C |
| M28 | A、I、S、Dependabot fixture/config validation、E、C |
| M29 | Frozen dependency install、F/B/A/S、E、C |
| M30 | `rg` zero-reference、A、Q、I、E、C |
| M31 | D、A、E、旧条項trace review、C |
| M32 | D、A、I、README navigation review、C |
| M33 | Clean checkout setup、A、E、Q、I、D、S、smoke `/healthz`・`/readyz`、before/after metric script、C |

M26で作成する`./scripts/check-staging-critical.sh`は、`STAGING_BASE_URL`とprotected GitHub Environment secret `STAGING_E2E_INVITE_TOKEN`を受け取る。Secretをargv/log/screenshotへ出さずbrowser fragmentへ注入し、unique anonymous accountでGoal作成、Cycle完了、Review遷移、History確認を実行後、公開account-delete APIで必ずcleanupする。Cleanup失敗時はworkflowを失敗させ、account identifierを本文なしのhashed correlationとして記録し、運用runbookの同じ公開delete経路で再試行する。Raw DB correctionは行わない。

## 22. Rollback or recovery method per milestone

| Milestone | Rollback / recovery |
| --- | --- |
| M0–M1 | Docs/test-only commitをrevert。Contract判断自体を変える場合はowner判断をDecision logへ追加 |
| M2 | Identity-aware cache commitをrevertし、旧user表示riskが戻るためreleaseを停止 |
| M3 | `.dockerignore`/build test commitをrevert。Secret混入imageは使用せず破棄 |
| M4 | Parity generator/test commitをrevertし、旧validationを同時に戻す |
| M5 | Caller-owned operation IDとAPI wrapperを同一commitでrevert。Replay receipt/schemaは変更しない |
| M6 | 409 recovery UIだけをrevertし、server contractを維持。Autosave不能時はmanual copyを案内 |
| M7 | Shared normalization predicateと全callerを同一commitでrevert |
| M8 | Editorごとの旧autosave adapterをmilestone中だけ保持し、全editor移行成功後に削除。失敗時はcommit全体をrevert |
| M9 | Security guard障害ではreleaseを停止してforward fixする。IndexedDBはv2へupgrade後にv1 openerへ戻すと`VersionError`になるため、rollbackでもv2 schemaとdeletion tombstone互換を維持し、Expected/Actual User、Web Lock、deleted-draft resurrection guardを外さない |
| M10–M11 | Feature単位のcommitをrevert。Route/API wire shapeは各commitで完結させる |
| M12 | Lock-order commitをrevertすると既知deadlock riskが戻るためdeploy停止。Schema rollbackは不要 |
| M13 | CAS/concurrency commitをrevertし、費用/整合性riskのためdeploy停止 |
| M14–M18 | Use-case単位のcommitをrevert。旧adapterは当該milestone完了まで削除しない |
| M19 | OpenAI adapter commitをrevertし、旧provider classificationへ戻るためAI releaseを停止 |
| M20 | Query source/generated/application callerを同一commitでrevert |
| M21 | Migration適用前はcommitをrevert。Data-bearing環境へup適用後はproduction downやbaseline編集を行わずforward repair migrationを作成 |
| M22 | Exporter compositionをrevertしstructured logsを維持。Endpoint障害時はbounded retry後にapp requestを失敗させず、telemetry drop metric/logを出す |
| M23 | Instrumentation commitをrevert。PII混入を検出した場合はexport停止、credential rotate、provider側削除手順を実行 |
| M24 | Cleanup/limiter commitをrevert。Cleanupが一部成功しても復元せず、retention contract上安全な冪等再実行を使う |
| M25 | CI gate commitをrevertできるがsecurity gateをskipしてreleaseしない。False positiveはtool policyを修正して再実行 |
| M26 | Post-deploy test失敗では自動DB downを行わない。Logs確認後、DB互換なら直前Wrangler deploymentへrollbackし、それ以外はforward fix |
| M27 | Snapshot失敗時はapply前に停止。Restore drillはisolated backend keyだけを使いlive stateを上書きしない |
| M28 | Action/image pinning commitをrevertせず、壊れたversionだけ前の既知digest/SHAへ更新するreviewed commitを作成 |
| M29 | Dependencyごとにmanifest/lockfileを同時revert |
| M30 | 削除commitをrevert。Compatibility shimを新規追加して延命しない |
| M31–M32 | 旧section-to-new-section traceを使って該当docs commitをrevert。契約欠落だけを推測で補わない |
| M33 | 検証のみでstate変更なし。失敗した最初のmilestoneへ戻り修正し、M33を最初から再実行 |

Terraform M27ではApply直前に`terraform state pull`し、SHA-256を計算して同じprivate R2 bucketの`fukamu-cycle/staging/state-backups/<commit-sha>/<utc-timestamp>.tfstate`へ保存する。GitHub `staging-terraform-apply` Environmentだけがread/write credentialを持ち、snapshotまたはchecksum upload失敗時はapplyしない。保持期間決定までは自動削除しない。Restore drillは別backend keyへcopyして`terraform plan -refresh=false`とchecksum一致を確認し、live stateへpushしない。

## 23. Risk register

| Risk | 影響 | Mitigation |
| --- | --- | --- |
| 旧user dataの表示・送信 | Critical | M2を最優先しaccount-switch E2E |
| DB deadlock・二重遷移 | Critical | deterministic concurrency test、共通lock order |
| Same-origin Session Cookieのtab間上書き | Critical | Expected/Actual User binding、exclusive Web Lock、cross-tab E2E |
| Account Delete後のBrowser Draft復活 | Critical | atomic salted-digest tombstone、delete advisory、put/clear順序test |
| Autosave refactorによる入力消失 | High | characterization、single in-flight、browser recovery E2E |
| Idempotency破損による重複操作・AI費用 | High | caller-owned key、response-loss test |
| 6,720行SoT整理時の契約消失 | High | 条項trace、test先行、小さな文書commit |
| Migrationによるdata不整合 | High | additive migration、empty/disposable DB、forward repair |
| Telemetryへの本文・identity混入 | High | attribute allowlist、fixture/log scan |
| CI artifactの誤再利用 | High | exact tree、immutable artifact、full fallback維持 |
| Terraform state喪失 | High | restricted pre-apply snapshot、isolated復旧drill |
| Betaの早期撤去 | High | owner承認、off、168時間、atomic removal |
| Unicode・timezone・accessibility回帰 | Medium | boundary matrix、browser/component tests |

最大のデグレリスクは、autosave、transaction、仕様文書を同時に大きく置換して契約を失うこと。必ずcharacterization、単一責務milestone、全gateの順で進める。

## 24. Decision log

- 2026-08-22: 実装開始時のHEADは基準commit `fe2c82a5705d192ceddbcb61aa217c6f9f45c29c`とtreeまで完全一致し、tracked/staged driftはなかった。未追跡の本ExecPlanだけをuser所有の入力として保持した。
- 2026-08-22: Repository全体のmanifest、SDK/OpenAPI候補、API route参照を検索したが、Frontend以外のAPI consumerを示す証拠はなかった。Repository外consumerのowner確認は未取得のため、現行route/wire shapeを維持し、非互換wire変更を禁止して進める。
- 2026-08-22: M1 acceptanceの「Behavior contract全flowがgreen」と、M2/M5/M6/M7で修正する既知contract violationを同時に満たすことはできないと判明した。M1では現在適合するblack-box behaviorとsecurity boundaryをgreenで固定し、既知defectは所有milestoneの最初に失敗するregression testを追加してから修正する。この解釈はtest削除やassertion弱体化を認めない。影響はM1とM2/M5/M6/M7のtest配置だけで、プロダクト契約は変更しない。
- 2026-08-22: M23の`draft_recovery_total`はbrowser IndexedDB内だけで発生し、現行Backendへ安全に通知するcontractがないと判明した。元計画のmetric追加をそのまま実装せず、本文・identityを送らないtransportをownerが決めるまでこのmetricの新規境界だけを停止する。影響はM23の当該metricで、他のserver-side metric/PII allowlist testは継続する。
- 2026-08-22: M27の「Apply EnvironmentだけがR2 credentialを保持」と、現行SoT/運用文書の「Plan/Applyがrepository secretを使い、Environmentはsecret storeにしない」が矛盾すると判明した。Credential topologyを推測で変更せず、owner判断まではsnapshot helper/local isolated testだけを行う。影響はworkflow secret配置とlive drillで、追加検証はPlan/Apply両方の最小権限matrixとfailure-before-apply testとする。
- 2026-08-22: M29のReact Hook Form削除は現行`docs/design.md`の明示的technology selectionと矛盾すると判明した。単一textareaでは依存削除により複雑性を減らせるという元計画の根拠は維持するが、ownerの設計変更承認まではRHFとSoTを削除しない。影響はM29のRHF sliceだけで、chi更新等は独立して進める。承認時はcontrolled editorのbehavior test、bundle、dependency zero-referenceを追加検証する。
- 2026-08-23: M15先行監査で、Goal Deleteが全`AIUsageEvent`をredacted保持する現実装と、Quota window外はProvider usage settledまたはno in-flight確認後に即時削除するSoTが不一致と判明した。Data retentionの既存仕様違反を現行挙動の移植で固定せず、別の運用Retention理由の有無をProduct/Security ownerが判断するまでM15 Delete orchestrationだけを停止する。既存SoTへ実装を合わせる判断ならwindow内retain/window外deleteをApplication use caseのRED/GREENへ含め、全件保持を恒久化する判断なら理由・期限・cleanup契約を先にSoTへ整合させる。M14とM15 read/query等は独立して継続できる。
- 2026-08-22: M2ではglobalな`["session"]`だけをidentity非依存のまま維持し、全server stateとcreate-draft mutationを`["user", userId]`配下へ移した。異User置換は直列化し、実行時のcurrent sessionを再読してold-user query cancel/remove、mutation cache clear、新session publishの順に行う。同一Userではsessionだけを更新し、query/mutation/browser draft/editor stateを維持する。IndexedDB draftは既存のUser ID分離を維持し、切替元recordを削除しない。影響はFrontend cache keyとaccount transitionだけで、API wire shapeとserver dataは不変。Component ordering、parallel replace、factory/cross-user cache、same-tab no-reload E2Eを追加検証した。
- 2026-08-22: `MutationCache.clear()`は実行中requestをabortせず、detached Cycle saveも切替と競合し得ることを再監査で確認した。M2ではcapture済みold User prefix/IndexedDB key、keyed remount、serverのsession-bound CSRF/ownershipによりnew User data contaminationを防止する。Request abort、identity lease、late navigation抑止、one-shot account transition noticeはM8/M9のautosave/app-shell責務として追加検証する。これはM2のdata-isolation acceptanceを弱めず、影響は切替後に拒否される旧requestとUX副作用の停止強化に限る。
- 2026-08-22: 新しいsame-tab Google collision E2Eはpublic client IDがないbundleではtest fakeを描画できず、`scripts/check.sh --e2e`だけの設定では直接buildするGitHub E2E jobが不一致になると判明した。Production/deploy設定は変更せず、CI E2E buildだけに同じdummy public IDを与えた。影響はtest bundleだけで、workflow syntax、target/full Playwright、full gateを追加検証した。
- 2026-08-22: M3ではDocker contextへ送らないsecret-bearing artifactを、Repositoryで使用するpath class（`.env*`、`.dev.vars*`、credential/key形式、Worker secret file、Terraform state/input、dependency/tool output）として定義した。検証は実secretを探索・読取せず、固定のbenign synthetic canaryをroot/nested pathへ作って`Dockerfile`と`Dockerfile.local`のignore precedenceをBuildKitで確認する。任意名fileや内容検査、将来のnamed/remote contextまで保証するものではなく、新context追加時は同じmilestone guardを拡張する。影響はDocker build input、Infrastructure check、CIだけで、runtime configとimage内容は不変。
- 2026-08-23: M4の`config/deployment-contract.json`はproduction値を決めるfileではなく、Backend 49 key、Worker/Wrangler/GitHub/Frontendへのsource・handoff・alias分類だけを持つdata-only contractとした。Typed default・値境界はBackend config、Closed Betaの値境界はWorkerとdeployが共有するpure parserを正本にし、architecture testでkey set、mapping、固定literalをexact比較する。`BETA_ADMISSION_COOKIE_KEY`は`closed`時だけ必要なためWranglerの静的required secretsへ加えず、deploy/runtimeで同じconditional contractをfail-closed検証する。
- 2026-08-23: M4ではBackend configへcanonical origin、PostgreSQL scheme/host/database名、finite number、int32/duration overflowの検証を追加した。Deployはmanifest由来のtrimmed presenceと共有Closed Beta parserを先に実行し、次にDB・providerへ接続しない`configcheck`でproduction config、embedded prompt、tokenizerをmigration前に検査する。失敗出力はkey/codeまたは固定messageだけで、secret/input値を出さない。これは未決の運用値を追加せず、既存runtimeが要求するshapeをdeploy前へ一致させる変更である。
- 2026-08-23: M5のlogical Commandはページ内のcommand種別ごとにcallerがcanonical scalar fieldのfingerprintとUUID v7を同期所有する。成功、request変更、またはstable API error後に利用者が再実行を選ぶまでは同じIDを保持し、response喪失、不正response、`AI_OPERATION_IN_PROGRESS`では同じID/requestを再送する。Body/Headerの既存wire位置は変えず、late responseが後続operationをclearしないcaptured-ID guardを置く。
- 2026-08-23: M5 replayはSoTのstrict `CurrentWork` unionをFrontend DTOでも共有し、Start/Continueは返却された過去Cycleでなくcanonical Goal route、Completeは`currentWorkspace`のActive Cycle/Goal Review/terminal routeへ収束する。Completeは元Cycleのbrowser draftだけを削除し、後続Cycleのrecovery dataを消さない。Backend AI replayは保存済み`context_changed`とoriginal request revisionを返し、provider、generation、usageを再実行しない。Schema migration、route、wire extensionは不要と判断した。
- 2026-08-23: M6の409 recoveryはstable codeをstatusとexact比較し、Local/old-base IndexedDBを先に保持してからpure GETを行う。取得結果はcapture済みUser・Draft/Cycle世代・refresh leaseを再確認し、Goal revisionとCycle terminal/content revisionを単調採用する。失敗snapshotとServer本文が同じなら最新revisionへ自動収束して新しいLocal編集だけを再送し、差分があればLocal再適用かServer採用を明示選択する。Workspaceが後続stateへ進んだ場合は旧PATCH/Retryを停止し、copyable read-only Localとcanonical routeを残す。Backendはstate/AI/text guard後、同一resource・同一本文のstale saveだけをno-opとする。Route、Response、stable error、schema/migrationは変更しない。
- 2026-08-23: M6監査で、Review Draftを世代ごとにrevision 0から作る一方、`PATCH /goals/{goalId}/review`がDraft IDを持たないため、Review Aのlate RequestがReview Bを上書きでき、SoTのlate overwrite禁止を現wireでは保証不能と判明した。M0の非互換wire禁止判断をこのprivate SPA contractだけ改訂し、userが明示許可した未公開Frontend/Backend contract変更としてrequired UUID v7 `expectedReviewDraftId`を追加する。Goal→exact Review Draftを同一Transactionでlockし、field欠落/invalid UUIDは400、validだがcurrentでない旧世代/foreign/不存在IDは既存409へfail-closedする。Route/Response/error codeは維持し、Frontend wire test、required-field HTTP test、cross-user 404、実DBのA→B ABA/same-body regressionを追加した。
- 2026-08-23: M7のFrontend文字semanticsは、CRLF/単独CRをLFへ正規化してから`Array.from`相当でcode point数を判定し、blankはUnicode `White_Space`、ReviewのVersion差分は改行正規化後のtrimなしexact比較とする。HTML `maxlength`はUTF-16 code unit基準でnon-BMPを早期拒否するため外し、入力全体を80/200 code pointsで受理または拒否してsubstring切断しない。Response ZodもGoal/Frame/AIを同じ上限・NUL・改行contractで検証し、旧IndexedDB recordはoversize Localを失わず改行だけcanonicalizeしてcache/restore/requestを一致させる。
- 2026-08-23: M7のBackend production Domain/StoreとPostgreSQL `char_length`は既にcode point、CRLF/CR、whitespace保持、Review exact比較へ適合していた。ValidationをService前段へ移すとM6で固定したownership/state/AI guard precedenceを変えるため行わず、既存guard位置のままDomain/Application AI/actual HTTP/Store/直接CHECK testを追加した。Schema、migration、route、wire、stable error、Backend production codeの変更は不要と判断した。
- 2026-08-23: M8ではCreation/Reviewを共通`AutoSaveCoordinator` hookへ、Cycleの4 frameを同じcoordinator instanceへ統合した。Coordinatorはkeyed latest-value coalescing、editor全体でsingle in-flight、800ms API debounce、150ms browser cache、blur/route flush、retryable network/408/generic 429/5xxの1/2/4/8/16秒+jitter・初回+5回自動retry、online/input/manual resume、revision conflict rebase、identity generation fenceを所有する。`AutoSaveScopeProvider`はscope generation、AbortSignal、browser operation直列化、quiesceを明示し、page固有の旧queue/state machineは削除した。
- 2026-08-23: M8のterminal commandはserver commit前にscopeをquiesceせず、成功応答とcurrent mounted generation/identity leaseを確認してから共通`PostCommitCleanupBoundary`へ渡す。Boundaryは全scopeをdraft保持でquiesceし、captured raw browser key/Goal prefixをFIFO削除してからcache更新/navigationを行う。Cleanup失敗時はserver commandを再送せず端末cleanupだけをretryし、account deleteも204後の旧User draft削除完了前にreloadしない。Identity切替・route移動後のlate responseはcleanup/cache/navigationを実行しない。
- 2026-08-23: Identity切替では旧Userのdirty入力をIndexedDBへbest-effort退避してから新identityを公開し、旧User内容を新identityへ引き渡したり表示をblockしたりしない。IndexedDB自体のput失敗時はin-memory入力をrecoverableに保持できず失われ得る残存riskがある。Server cookieのidentity変更後に旧User UIを維持する方がcross-user isolationを損なうため、identity隔離を優先する。安全なpre-transition storage protocolまたは失敗UXを決めるにはproduct/security判断が必要であり、M8ではDraftCacheWarningと通常時のretry可能性を維持してbest-effort境界として記録する。
- 2026-08-23: M8横断監査で、AI提案adoptのlate successがmounted/identity lease確認前にeditor/cacheへ作用し、同一Userの後続Draft世代をrollbackし得る既存の非terminal P2を確認した。Autosave/terminal cleanupのM8 acceptanceとは独立し、M8前のindex版にも存在するため、M10 feature boundaryで全command completion fenceを統一するREDとして追跡する。M8のP0/P1完了条件は弱めない。
- 2026-08-23: M9のError Boundaryは、Provider初期化失敗を扱うouter boundaryと、Session/PostCommit ownerを維持したままroute render失敗を回復するinner boundaryの二層とした。React 19 root callbackはraw Errorやcomponent stackをproduction logへ渡さず、固定event/phase/codeとvalidated UUID v7 request IDだけを記録する。Wire errorはBackendのstable code unionへ閉じ、server message/detailsを`APIError`へ保持せず、UIはcode別の固定copyだけを表示する。
- 2026-08-23: Runtime session recoveryはrequest開始時generationをcaptureするnotification-only busとApplication compositionの直列queueへ集約した。Exact `401 SESSION_MISSING` / `SESSION_EXPIRED`は先にUIをhidden / inert化してDraft保持quiesce後にsession discovery/bootstrap、exact `403 CSRF_INVALID`は同一Userならeditor/cacheを維持したrefreshとする。Initial/focus/reconnect自動refetchは無効化し、strong recovery preemption、unmount/late response fence、失敗retryでもquiesce済みscopeをfresh leaseへremountする。
- 2026-08-23: Auth/login/account terminal/post-commit operationは同じsession transition queueでdispatchからcleanup成功まで順序付ける。Google 200でCookie更新後にbody parseやnetwork responseが不確実になった場合は旧UIを同期停止してauthoritative session discoveryへ収束する。PostCommit ownerはidentity-keyed subtreeとinner Error Boundaryの外に置き、失敗retry中もqueue ownershipを保持する。Account Deleteはserver commit前にquiesceせず、`204`後だけcaptured旧User browser dataを削除してreloadする。
- 2026-08-23: Same-origin Session Cookieがtab間で共有され、旧tabのsafe GETが切替先payloadを旧User query keyへ保存できるP1を確認した。Backendは全`/api/v1`を`no-store`とし、認証成功Responseへsource Userの`X-Fukamu-Authenticated-User-ID`を付与する。Frontendは全protected APIをABA-safe authenticated request leaseへ必須化し、Header不一致をstatus/bodyより優先してpayload公開前にrecovery、欠落/malformedをreload-onlyでfail-closedにする。Cross-tab channelは早期停止用advisoryでありHeader検証を置換しない。
- 2026-08-23: Deployment bundleを識別する必須version Headerはrolling compatibilityを壊すため追加しない。一方、lease-bound `X-Fukamu-Expected-User-ID`は別のidentity preconditionとして新Frontendでは必須、Backendでは既に開かれた旧bundle互換のため欠落だけを許容する。新Backend/旧bundleではresponse検証しないriskが残るため、Closed Beta rolloutで既存tabのreloadを要求し、新bundle利用確認までrelease gateを開けない。Production deployは本作業範囲外で実行しない。
- 2026-08-23: Session recovery priorityをUNVERIFIED > DRIFT > MISSING/EXPIRED > CSRFとし、上位が下位をabortする。Cookie writerは標準Web Locksの固定exclusive lockでtab間直列化し、取得後ownershipを再確認する。新dependencyは追加せず、API欠落・例外・callback未実行時はCookie変更をdispatchしない。
- 2026-08-23: Account Deleteは`204`直後とBrowser cleanup完了後の二段階advisory、origin salt付きUser digestだけのdurable IndexedDB tombstone、put/checkとtombstone/deleteのatomic transactionでlate writeを防ぐ。Draftの24h TTLと異なりtombstoneはsite data削除まで保持するprivacy/security tradeoffを採用し、raw User ID・本文は永続privacy recordやtelemetryへ残さない。
- 2026-08-23: M9でBrowser Draft DBをv1からv2へupgradeしたため、旧v1 openerへの全面revertは`VersionError`になる。Rollbackでもv2 schema/tombstone互換とidentity/Cookie security guardを維持し、障害時はrelease停止とforward fixを行う。
- 2026-08-23: M11ではGoalWorkspace/GoalHistory/GoalTimeline routeをparameter解決と公開Feature compositionだけにし、現行API wire、UI/DOM、query key、Historyの`scope=all`順序、Cycleの`${userId}:${cycleId}` remount keyを維持する。Cycle eligibilityとTimeline groupingはFeature private modelへ移し、旧cycle-editor/page modelを削除する。History/Timelineは一つのprivate infinite-scroll ownerを共有し、同期in-flight guardと`cancelRefetch: false`で同一cursorのobserver/retryをcoalesceして既読pageを保持する。Goal detail cacheはrevision単調採用とし、同revisionではcurrentを維持する。
- 2026-08-23: Post-commit cleanup自体はroute移動後も完遂・retry可能に保つ一方、optionalなmonotonic route-generation ownershipで旧routeのcleanup成功後にcache invalidation、cache publish、navigation、terminal表示をreplacement routeへ公開しない。Route-scoped taskはCreation 2件、Review 3件、Cycle 3件の全8件を機械検証し、Account Deleteはrouteを越えて完了する既存session ownershipだけを維持する。
- 2026-08-22: Free/MVPの進行Goal上限を2件に確定。
- 2026-08-22: Homeは`GoalView/currentWork`共用に確定。
- 2026-08-22: Goal Refine fieldを`suggestion`へ統一。
- 2026-08-22: `docs/design.md`を唯一のNormative SoTとして維持。
- 2026-08-22: main CI artifact reuseとfull fallbackを維持。
- 2026-08-22: Turnstile Terraform管理を維持。
- 2026-08-22: OTLPはvendor-neutralなHTTP exporter、local/testはin-memory、staging/productionはprotected environment injectionとする。
- 2026-08-22: GitHub Actionはcommit SHA、imageはcontent digestへ固定する。
- Repository rule: baseline migrationの一回限りの再編集例外は完了済み。今後は新規migration pairのみ。

## 25. Progress log

- 2026-08-23: M13完了。Fresh disposable PostgreSQL 18.6でcommit前必須gateを最初から実行し、staged candidate tree `a4686a6125d4bc79a2c5c77a6edc8ab836acccb2`、Actionlint、CI reuse resolver、全scope、Frontend 51 files / 436 tests、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18、migration version 1・dirty=false、開始・終了tree一致まで成功した。Commitしていない。本entryとM14再開位置でindexを変更するため、再stage後に別のfresh DBでplan-inclusive final treeのCを最初から再実行してからM14へ進む。
- 2026-08-23: M13独立監査で、同月の複数AI reservationをGo `float64`で合算すると正当なDB `NUMERIC`（例: `0.1 × 3 = 0.30000000`）より大きいparameterとなりAccount Deleteを恒久rollbackさせるP1と、Account DeleteがUser lockを先に取得した場合にlate Anonymous resumeが同じbootstrapからcandidate Userを再作成するP1を検出した。さらにexpired recoveryとGoal Delete callbackの最初の競合testが意図した経路へ到達しないfalse-greenを検出した。先行のtarget GREEN / B結果はsupersededとし、DB側exact NUMERIC月集約、既存bootstrap世代のnon-resurrection、真のinterleaving、Account Delete late callbackをRED/GREEN化してから全gateを再実行する。Schema/baseline migration/sqlc/API wireは変更しない。
- 2026-08-23: M13監査修正後の独立targetはnullable UUID regressionを含む新規17 testsが1回と20回反復（最終31.178秒）、PostgreSQL package全体、Backend Bが成功した。Account/Goal Deleteは同月reservationをDB `SUM(NUMERIC)`でexact合算し、Anonymous resumeは既存bootstrap locator後にUser lockと同じUserの再検証を行ってDelete-wins時にcandidateを再作成しない。Expired recovery、Abandon両winner、Goal/Account Delete中のlate callbackを実blocking関係で固定し、Generation/Budget/Usage/Session/Delete receiptのexact affected-row不成立を全Transaction rollbackとした。独立production/SoT/test監査でM13 acceptanceに残るP0/P1はない。
- 2026-08-23: M13の最初のfull EはFrontend 51 files / 436 tests、Backend全package、Cloudflare 60 testsまで成功後、Playwright critical journeyのCreation Goal Refineで`pgtype.UUID{Valid:false}`をJSON `null`から`"ul"`へ誤変換し`mustUUID`がpanicするP1を検出して17/18で停止した。このEは失敗として採用した。Nullable UUID最小testを追加して`uuidString(null) = "ul"`のREDを確認し、Valid guard後にGREEN、M13新規17 testsの20回反復、Backend B、fresh DBのcritical journey 1/1を再成功させた。他callerとAI operation shapeを監査し残るP0/P1がないことを確認した。
- 2026-08-23: Nullable UUID修正後のfull Eを別のfresh disposable PostgreSQL 18.6で最初から再実行し、Frontend format/lint/typecheck、51 files / 436 tests、production build 229 modules、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18、migration version 1・dirty=falseまで成功した。失敗E/target用DBは停止・削除済み。Schema/baseline migration/sqlc生成物/API wireは不変である。
- 2026-08-23: M15先行監査でGoal DeleteのQuota window外`AIUsageEvent`がSoTどおり削除されず全件redacted保持されるData-retention違反を検出し、Open Decisionへ記録した。Owner判断までM15 Deleteだけを停止し、M13完了とM14 Goal draft/refine/start Application移行は継続する。
- 2026-08-23: M13の最初のGREENでは、AI finalizationをnon-locking locator後のUser→Goal→Draft/Cycle→AIGeneration→Budgetへ統一し、late settlementをUsage locator→User→Usage→Budget、AbandonをUser→Draft→Generation、Goal / Account DeleteをUser→全子row→Generation→Budgetへ統一した。Generation / Budget / Usage / target state / delete receiptの期待更新数をexact CASで検査し、0-rowをTransaction全体のrollbackとした。集中concurrency test反復、PostgreSQL package全体、Backend Bは一度成功したが、上記監査修正により最終証跡としては採用しない。
- 2026-08-23: M13変更前REDでは、Goal Deleteのbudget release 0-row、Action finalizationのUsage 0-row、Review RefineのGoal/Draft逆順、Action finalization対lease recovery、Abandon対Refine、Login source Session delete、Anonymous resume対Account Delete、Account Delete child lock / Generation CASの競合を決定的に再現した。Goal Delete後のparallel late callbackだけは既存実装のexactly-once characterizationが先に成功し、Delete本体との真のinterleavingへ監査後に強化する。
- 2026-08-23: M12完了。Fresh disposable PostgreSQL 18.6でcommit前必須gateを最初から実行し、staged candidate tree `6a6ff46a0e6f96415fd08d1419256785e22199fe`、Actionlint、CI reuse resolver、全scope、Frontend 51 files / 436 tests、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18、migration version 1・dirty=false、開始・終了tree一致まで成功した。M12の検証DB 3個は停止・削除済みでcommitしていない。本entryとM13再開位置でtreeを変更するため、plan-inclusive final treeを再stageし、別のfresh DBでCを最初から再実行する。
- 2026-08-23: M12 productionとtarget validationを完了した。Complete/Terminateは明示`READ COMMITTED`とUser→Goal→Cycle/Draftのglobal lock orderを共有し、User配下operation receiptをlock待機後に再確認する。Complete replayはreceipt分類とpayload構築を分離し、target Goal `FOR UPDATE`後にGoal/Cycle/Draftをmaterializeするため、Review Continue/Terminateが複数statementの途中へ介在しない。Schema/baseline migration/sqlc生成物/API wireは不変である。
- 2026-08-23: M12変更前REDではComplete対Terminateのdeadlock、同一User並行Completeの`GOAL_STATE_CONFLICT`、別Goal operation reuseのraw unique violation、Terminate別Goal reuseのraw unique violationを再現した。さらにComplete replayをGoal view読取後で停止するとContinueが先にcommitするnon-linearizable replayを決定的に再現した。User lock、post-lock receipt lookup、Goal-before-Cycle、Goal lock下replay構築へ収束後、構造・競合・replay contract 5 testがGREEN、20回反復も成功した。
- 2026-08-23: M12 Bはsqlc compile/generate drift zero、gofmt、vet、全Backend package/PostgreSQL integration、3 binary buildまで成功した。Disposable PostgreSQL 18.6によるfull EはFrontend 51 files / 436 tests、production build 229 modules、Backend全package、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18、migration version 1・dirty=falseまで成功した。独立production/SoT/test監査にP0/P1はなく、次に全treeをstageしてfresh DBでCを実行する。
- 2026-08-23: M12横断監査で、Review AI/BeginGoalRefine(review)のDraft→GoalとGoal→Draft commandの逆順をM13、Continue Reviewの同一User・別Goal `start_operation_id` reuseがraw unique violationになり得る既存riskをM17のREDとして追跡する。M12 acceptanceを弱めず各所有milestoneで解消する。
- 2026-08-23: M11完了記録を含むplan-inclusive final treeのcommit前必須gateを別のfresh disposable PostgreSQL 18.6で最初から再実行し、staged tree `094176ec007988580d9bd2c68e5e7f65ccf7b190`、Frontend 51 files / 436 tests、全scope、Playwright 18/18、migration version 1・dirty=false、開始・終了tree一致まで成功した。検証DBは停止・削除済みで、indexを変更せずcommitしていない。M12はこの検証済みtreeから開始した。
- 2026-08-23: M11完了。Fresh disposable PostgreSQL 18.6でcommit前必須gateを最初から実行し、staged candidate tree `43871d7746d98deaa1cdc315d3ee0151e4f35d50`、Actionlint、CI reuse resolver、全scope、Frontend 51 files / 436 tests、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18、migration version 1・dirty=false、開始・終了tree一致まで成功した。検証DBは停止・削除済みでcommitしていない。本entryとM12再開位置でtreeを変更するため、再stage後に別のfresh DBでplan-inclusive final treeのCを最初から再実行する。
- 2026-08-23: M10完了記録を含むplan-inclusive final treeのcommit前必須gateを別のfresh disposable PostgreSQL 18.6で最初から再実行し、staged tree `9a67fabc9b576ff5b57fd5fc4a4ac55363a9fddc`、Frontend 50 files / 413 tests、全scope、Playwright 18/18、開始・終了tree一致まで成功した。Migrationはversion 1・dirty=false、検証DBは停止・削除済みで、indexを変更せずcommitしていない。M11はこの検証済みtreeから開始した。
- 2026-08-23: M11変更前REDではroute composition/public index/unique policy owner、重複intersection/retry、late Goal collectionによる新しいdetail cacheのrollback、Timeline retryの不要な再取得、Complete cleanup後のreplacement route publication、Cycle eligibilityとGoal preferenceの重複を再現した。GREENではCycleWorkspace/GoalHistory/GoalTimeline Feature、共有pagination owner、revision-monotonic Goal cache、private eligibility/timeline model、route-generation publication fenceへ収束した。
- 2026-08-23: M11完了前の独立監査で、route-generation fenceがCycleだけに適用され、Creation/Reviewの5 taskが同一Userのreplacement routeへ旧cache/navigationを公開できるP1を検出した。Creation Start、Review Continue、全route-scoped taskの構造gateは修正前3 failures / 60 passesを再現し、8/8 taskへtokenを横展開後3 files / 63 tests、最終focused 10 files / 141 testsが成功した。再監査ではroute composition、pagination/cache/eligibility、DOM/API/query/order互換に残るP0/P1はなかった。
- 2026-08-23: M11 final FはPrettier、ESLint、strict typecheck、Frontend 51 files / 436 tests、production build 229 modulesまで成功した。Fresh PostgreSQL 18.6で事前listしたCycle/history/timeline/autosave/mobile/termination対象Playwright 6/6、別のfresh PostgreSQL 18.6によるfull EでBackend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18、migration version 1・dirty=falseまで成功した。両DBは停止・削除済みで、API wire、History順序、baseline migration、sqlc生成物は不変だった。
- 2026-08-23: M11 validation中、既存生成物`cloudflare/.wrangler`と`frontend/test-results`のroot所有権、固定image内Chromiumの非root cache path、誤って選んだPostgreSQL 17 imageでcode assertion前またはgate途中に停止した。生成物だけの所有権を限定修復し、Chromiumをworkspace外からread-only mountした。PostgreSQL 17の成功結果は採用せず、対象E2E/full Eをそれぞれfresh PostgreSQL 18.6で最初から再実行した。誤った`pnpm run`引数境界による対象list 0件も直接Playwright invocationへ修正し、assertionやproduct codeを弱めていない。
- 2026-08-23: M10完了。Fresh disposable PostgreSQL 18.6でcommit前必須gateを最初から実行し、staged candidate tree `7d74637d0593d71bcb3ec47cd471812d8dd88b8f`、Actionlint、CI reuse resolver、全scope、Frontend 50 files / 413 tests、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18、開始・終了tree一致まで成功した。検証DBは停止・削除済みでcommitしていない。本entryとM11再開位置でtreeを変更するため、plan-inclusive final treeを再stageし、別のfresh DBでCを最初から再実行する。
- 2026-08-23: M10 final FはPrettier、ESLint、strict typecheck、Frontend 50 files / 413 tests、production buildまで成功した。Fresh disposable PostgreSQL 18.6の対象E2EはCreation入力・Refine明示採用・Start・Review Refine/失敗時旧提案保持・ContinueとReview terminalの2/2、別のfresh DBによるfull EはBackend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18まで成功した。検証DBは停止・削除済みで、API wire、route、DOM copy/order、baseline migration、sqlc生成物は不変。次に全treeをstageしてCを実行する。
- 2026-08-23: M10変更前REDはCreation/Review双方でidentity quiescence後のlate Refine resolve/reject、別Draft世代へのlate Adopt、route内product policyとdeep Feature importを再現し、behavior 6/38、architecture 6/6が失敗した。Goal Creation/ReviewのDraft作成、autosave、refine/adopt、start/continue/terminal/delete、recovery、UIを公開Featureへ移し、routeをquery/load/error/Feature compositionだけへ縮小した。Public query contractとFeature index、再帰AST architecture gate、Refine request generation/scope fence、Adoptのmounted/active scope/current Draft/response Draft bindingを実装した。
- 2026-08-23: M10 focused GREENは共通Refine hook、Creation、Review、architectureの4 files / 51 testsから、監査修正後にCreation 18・Review 27 testsへ拡張した。Reviewの通常Refine/明示Adopt、失敗後retry error消去、別Draft response拒否、Creation/Review双方のquiesced Adopt resolve/rejectを固定した。独立した境界・fence・E2E互換監査で検出したarchitecture gate bypass、Review response ID非対称、retry後の旧error残留、Adopt quiescence test gapを解消し、再監査でP0/P1/P2なしを確認した。
- 2026-08-23: M10対象Playwrightの最初の2試行はtestDirを二重指定したfile filterと、project/fileを含むfull titleへのanchored grepによりtest 0件で停止した。Server/migration以外は走らず、test dataがないことを保ったまま、listで対象2件だけを事前確認した正しいfile filter/unanchored grepへ修正し、実journey 2/2を成功させた。Product assertionや実装は変更していない。
- 2026-08-23: M9完了記録を含む最終commit前必須gateを別のfresh disposable PostgreSQL 18.6で最初から再実行し、staged tree `e7eff41bc5b4e797ba02f93a2521500cc640d1ce`、Actionlint、全scope、Frontend 49/391、Playwright 18/18、開始・終了tree一致まで成功した。検証DBは停止・削除済みで、indexを変更せず、commitしていない。M10はこの検証済みtreeから開始する。
- 2026-08-23: M9完了。最初のcommit前必須gateはfresh disposable PostgreSQL 18.6とstaged candidate tree `98cdfbbe74e9d44fba82632378d1c9c9f30cb4ba`で成功した。Actionlint、CI reuse resolver、Frontend 49 files / 391 tests、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 18/18、開始・終了tree一致を確認した。検証DBは停止・削除済みでcommitしていない。本entryとM10再開位置でtreeを変更するため、再stage後に別のfresh DBでCを最初から再実行する。
- 2026-08-23: M9の最終GREENでは、二層Error Boundary、固定copy/validated request IDだけのerror presentation、Expected/Actual User双方向binding、`UNVERIFIED > DRIFT > missing/expired > CSRF`のrecovery priority、identity lease/世代fence、origin-wide exclusive Web Lock、二段階Account Delete advisory、salted digestだけのIndexedDB tombstoneを統合した。Web Lock callback未実行、initial discovery abort、delete確認通知とcleanup失敗の競合もREDから修正し、独立security/E2E監査はいずれもP0/P1/P2なしだった。
- 2026-08-23: 最初のM9 full Eは15/18 Playwright成功後、409本文をrecovery後に読むPlaywright resource race、test helperの追加`GET /session`によるSPA保持CSRFの失効、既存E2EのIndexedDB v1固定openerの3 test defectで停止した。409本文を`route.fetch()`中にcaptureし、二tab delete testを実際の「新匿名user・Draftなし」状態へ合わせ、現行DB versionを開くよう修正した。実装assertionは弱めず、専用DBを分けたtarget journey 3/3でGREENを確認してからfull Eを最初から再実行した。
- 2026-08-23: M9 final FはPrettier、ESLint、strict typecheck、Frontend 49 files / 391 tests、production buildが成功した。Fresh empty PostgreSQL 18.6によるfull EもBackend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、同一Browser Context二tabのidentity/account deleteを含むPlaywright 18/18まで成功した。検証DBはすべて停止・削除済みで、baseline migration/sqlc生成物は不変。次に完全treeをstageしてCを実行する。
- 2026-08-23: M9 app-shell/session sliceの変更前REDではtop-level render例外、React root raw error、stable error redaction、並行401/403 recovery、identity transition、account notice、post-commit ownership、uncertain Google response、quiesce後retryの不足を再現した。二層Error Boundary、typed presentation、generation bus、single transition queue、stable PostCommit ownerへ収束後、focused 9 files / 137 testsが成功した。独立read-only監査では進行中cross-tab slice以外にproduction P0/P1はなかった。
- 2026-08-23: Cross-tab identity bindingのBackend REDは認証成功6経路のHeader欠落と`/api/v1` 2経路の`no-store`欠落を再現した。Middleware/router実装後、`backend/internal/httpapi` focused contractとpackage全testがGo 1.26.6固定containerで成功し、auth失敗/anonymous/healthのnegative contract、Google login source A/body target B、account delete `204`まで固定した。
- 2026-08-23: Frontend transport/API wrapperの変更前REDは4 filesで43 tests失敗・27成功となり、protected transport export、identity mismatch/missing/malformed/ABA、`no-store`、全workspace/account wrapperのlease必須化が未実装であることを確認した。現在はtransport、SessionProvider lease、cross-tab advisory、6 route caller/signal forwardingを並行実装中で、統合後にfocused F、full F/E/Cを実行する。
- 2026-08-23: M9 Error/app shellの先行GREENはAPI/root/session eventを含む7 files / 32 tests、Session/PostCommit/Settings/App compositionを含むfocused 9 files / 137 testsで成功した。PostCommit test fixtureのReact ref lintをeffectへ移して対象lintと7 testsを再度成功させた。Global typecheckは並行transport signature移行中のため未確定であり、milestone GREENとしてはまだ扱わない。
- 2026-08-23: Scope-moved修正後のM8 commit前必須gateはfresh disposable PostgreSQL 18.6とstaged candidate tree `827290d0871bf58399aebc3f883529da56eda24a`で成功した。Frontend 34 files / 234 tests、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 15/15、migration version 1・dirty=false、開始・終了tree一致を確認した。検証DBは停止・削除済みでcommitしていない。本entryとM9再開位置でindexを変更するため、plan-inclusive final treeのCをfresh DBで最初から再実行してからM9実装へ進む。
- 2026-08-23: M8変更前REDでは、editor間のsingle in-flight/latest coalescing、5回backoffとonline/input/manual再開、identity/route late response fence、terminal後cleanup retry、same-revision browser recoveryを既存のpage別queueでは満たせないことをfake-timer/component regressionで再現した。実装後のtargetは13 files / 182 testsで成功し、Creation/Review/Cycleが一つのcore contractを共有すること、Cycle 4 frameの直列化、24時間TTL cleanup、conflict/moved recovery、terminal/account cleanup、quiesce中の入力保全を固定した。
- 2026-08-23: 最初のM8 Cはstaged candidate tree `dd1652a7cb1a8fe1dbaf41a2178755f738941823`、Frontend 34/234、Playwright 15/15、migration `1|f`、開始・終了tree一致で成功した。しかし完了確定前の独立監査で、scope-moved時にdirty queueを解除して150ms後の条件付きIndexedDB削除を起動するP1を検出したため、このtreeとC結果をsupersededとした。Direct moved/conflict movedの両既存testへ削除不実行assertionを追加して2/22 REDを確認し、scopeをpaused+blocked dirtyとして保持する修正後に22/22、M8 target 13/182をGREENへ戻した。
- 2026-08-23: Scope-moved修正後のM8 final Fはformat、eslint、strict typecheck、Frontend 34 files / 234 tests、production buildで成功した。Fresh empty PostgreSQL 18.6によるfull EもBackend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 15/15、migration version 1・dirty=falseまで成功した。検証DBは停止・削除済みで、baseline migration/sqlc生成物は不変。独立再監査で他の新規P0/P1はなく、既知のIndexedDB preservation failure残存riskだけをDecision logへ記録した。
- 2026-08-23: M7の最終commit前必須gateはfresh disposable PostgreSQL 18.6とstaged candidate tree `2d7b735d64068007a4943448ed5a6f9416a49f4f`で成功した。Frontend 31 files / 138 tests、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 15/15、migration version 1・dirty=false、開始・終了tree一致を確認した。検証DBは停止・削除済みで、baseline migration/sqlc生成物は不変。Commit権限がないためcommitしていない。
- 2026-08-23: M7 fresh full E gateはempty PostgreSQL 18.6で成功した。Frontend 31 files / 138 tests、production build、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、更新したnon-BMP実入力journeyを含むPlaywright 15/15、migration version 1・dirty=falseを確認した。検証DBは停止・削除済み。次に全変更をstageしてcandidate treeを固定し、最終Cを実行する。
- 2026-08-23: M7変更前REDでは、Frontend 4 files / 39 testsに追加した境界のうちnative `maxlength`によるGoal/Frame non-BMP早期拒否、Reviewの単独CRとtrailing whitespace誤比較、U+0085/FEFF blank差の5件が失敗し、Review単独でも9 tests中3件が失敗した。Backend/DBは新しいcharacterization testが既存実装の適合を確認した。
- 2026-08-23: M7 GREENではshared text semantics、3 editor caller、IndexedDB recovery、Response Zod、actual browser journeyを統一した。Target Frontend 8 files / 76 tests、Backend Domain/Application AI、実Service/router/PostgreSQLのGoal Draft/Review 80/81・Frame 200/201、CRLF/CR response/persistence、Review Version transition、AI source/output直接CHECKが成功した。独立監査でP0と仕様矛盾はなく、baseline migration/sqlc生成物は不変だった。
- 2026-08-23: M7 full F/B gateは固定tool環境とdisposable PostgreSQL 18.6で成功した。Frontend format/lint/typecheck、31 files / 138 tests、production build、Backend全package/PostgreSQL integration、sqlc drift zero、migration version 1・dirty=falseを確認した。検証DBは停止・削除済み。次にfresh empty DBでfull Eを実行する。
- 2026-08-23: M6の最終commit前必須gateはfresh disposable PostgreSQL 18.6とstaged candidate tree `99697c29a06871aca801105f4a01ff4c8f384ed5`で成功した。Frontend 29 files / 125 tests、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 15/15、migration version 1・dirty=false、開始・終了tree一致を確認した。検証用local DBは停止・削除済み。Commit権限がないためcommitしていない。
- 2026-08-23: M6 full E gateはfresh empty PostgreSQL 18.6で成功した。Frontend 29 files / 125 tests、production build、Backend全package/PostgreSQL integration、sqlc drift zero、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 15/15、migration version 1・dirty=falseを確認した。検証用local DBは停止・削除済み。次に最終treeをstageしてCを実行する。
- 2026-08-23: M6 target検証はFrontend 5 files / 60 tests、typecheck/lint、全Frontend F 29/125、Backend domain/application/HTTPと実PostgreSQL全packageで成功した。Creation/Review/Cycleのactual HTTP exact 409、永続body/revision/timestamp不変、Review A→Bの旧ID same/different-body拒否、cross-user 404、Cycleのlate cache・workspace移動・unmount保全・command失敗後GET-only復旧を固定した。
- 2026-08-23: M6変更前REDでは、Creation/Review/Cycleの同一本文stale saveがすべてrevision conflictとなり、Frontendは対象409後も最新Server revisionを取得せずgeneric保存失敗から復旧できなかった。GREENでは共通Goal autosave recoveryとCycleのper-frame recoveryを実装し、同値自動収束、差分時の明示選択、Local/IndexedDB保持、latest revision再送、exact code以外の409非介入を固定した。独立監査でReview Draft browser key混同、Review世代ABA、late cache rollback、terminal自己link、moved unmount削除、command failure後stuckを検出し、identity leaseとdeterministic component/DB regressionで解消した。
- 2026-08-23: M6検証の最初のFrontend targetは新API contract fixtureの`draftType`欠落だけで59/60となり、最初のBackend full targetはM1 cross-user matrixの旧Review PATCH fixtureがrequired Draft IDを持たず400となった。実装assertionを変更せずfixtureを実contractへ更新し、Frontend target/F、Backend全package、fresh full Eをすべて最初から再実行して成功した。
- 2026-08-23: M4の最終commit前必須gateはfresh disposable DBとstaged candidate tree `8395716fad9042861e8234b5df1b90916586ade6`で成功した。全scope、Frontend 28 files / 81 tests、Backend PostgreSQL integration、Cloudflare 60 tests、Playwright 14/14、migration version 1・dirty=false、開始・終了tree一致を確認。Commit権限がないためcommitしていない。
- 2026-08-23: M5の最終commit前必須gateはfresh disposable PostgreSQL 18.6とstaged candidate tree `e69c42d261e69cdfa92ce07fc67462ee4dc24702`で成功した。Frontend 29 files / 102 tests、Backend PostgreSQL integration、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 15/15、migration version 1・dirty=false、開始・終了tree一致を確認。Commit権限がないためcommitしていない。
- 2026-08-23: M5の変更前REDでは全9 idempotent APIがattemptごとにoperation IDを内部生成し、post-commit response loss後のretryが別IDになった。Complete replayは後続workspaceを無視して過去Reviewへ遷移し、Goal全browser draftを削除した。Backend Goal/Action replayは保存済み`context_changed=true`をfalseで返し、Goal source revisionを後続stateから取得した。GREENではcaller-owned operation lifecycle、strict replay DTO/canonical navigation、元Cycle限定cleanup、保存済みAI metadataを実装し、same-key/different-hash、provider追加call 0、generation/usage各1を固定した。
- 2026-08-23: M5 target検証はFrontend 29 files / 102 tests、Backend全package/sqlc/build、実PostgreSQL replay integration、真の`route.fetch()`後browser response-loss E2E 1/1で成功した。Response-loss journeyは同じoperation/bodyでfirst commit `200`、後続Continue `200`、stale replay `200`となり、Cycle 1 completed、Cycle 2 active、Review Draft 0へ収束した。最初のGREEN試行はtest自身の`GET /session`がCSRFをrotateしてretryだけ`403`になったため、UIのfirst request tokenをout-of-band Continueへ再利用してtest setupを修正し、assertionは変更していない。
- 2026-08-23: M5 full E gateはfresh empty PostgreSQL 18.6で成功した。Frontend 29 files / 102 tests、Backend PostgreSQL integration、Docker context/scripts/Compose/Terraform、Cloudflare 60 tests、Wrangler dry-run/Container build、Playwright 15/15、migration version 1・dirty=false、sqlc drift zeroを確認。次に全変更をstageしてcommit前必須gateを実行する。
- 2026-08-23: M4の最初のcommit前必須gateはstaged candidate tree `6eba758c80ea25b8361c8bc4e364f71b96020717`で成功した。全scope、Frontend 28 files / 81 tests、Backend PostgreSQL integration、Cloudflare 60 tests、Playwright 14/14、migration version 1・dirty=false、開始・終了tree一致を確認。M4完了記録とM5再開位置でindexを変更するため、fresh disposable DBで最終treeのgateを最初から再実行する。Commit権限はなくcommitしない。
- 2026-08-23: 最初のC実行環境はDocker dynamic published portがnested tool containerのloopbackから到達できずBackend test開始時に停止し、bridge hostnameはRepositoryのlocalhost/`*_test` DB guardがtest前に拒否した。Host networkの未使用port 55434でlocalhost到達を事前検証してから同じcandidate treeのCを最初から再実行し成功した。いずれもproduction/runtime DBへ接続せず、失敗したassertionだけの再実行やguard緩和はしていない。
- 2026-08-23: M4の変更前REDでは、deploy preflightがwhitespace-only必須値とruntime-invalidな`BETA_INVITES=[{}]`を受理し、Backend configが非canonical origin、不正DB URL、`NaN`/`Inf`、int32/time.Duration overflowを受理することを再現した。GREENでは49 keyのexact source/handoff、Worker/configcheck固定値、derived/secret/Frontend mapping、全必須値の空白拒否、Closed Beta schemaを機械検証し、target config/admission 60 tests、Backend config tests、typecheck、actionlintが成功した。
- 2026-08-23: M4のAは固定tool環境で約197秒、Iは約28秒で成功した。AではFrontend 28 files / 81 tests、production build、Backend全package、sqlc差分なし、configcheck build、Docker context、script、Terraform、Cloudflare 60 tests、Wrangler dry-run/Container buildを確認。IではCompose、Terraform init/validate、Cloudflare check/dry-runを独立再実行した。次に全変更をstageし、commit前必須gateを実行する。
- 2026-08-22: M3のExecPlan追記後にcommit前必須gateを最初から再実行し、最終staged tree `c32037fbb2b6de497198a2bc873061f2b084a76a`の開始・終了一致、全scope、Playwright 14/14、migration version 1・dirty=falseを確認した。M3完了後のindex内容変更はなく、commit権限がないためcommitしていない。
- 2026-08-22: M3完了。Aは固定tool環境で約153秒、standalone context inspectionとIは約21秒で成功した。最初のcommit前必須gateは約298秒で全scope、Playwright 14/14、migration version 1・dirty=false、candidate tree `bb8ff3b1d0d208a4334f6c921f50689cde85f876`の開始・終了一致を確認した。本entryと再開位置更新でtreeを変更したため、完全stage後にgateを最初から再実行する。Commit権限はないためcommitしない。
- 2026-08-22: M3の変更前REDでは、synthetic `COPY .` imageからroot/cloudflare `node_modules`、`.env.local`、`.dev.vars`、credential/key、Worker secret、Wrangler output、Terraform state/input等をpathだけで検出した。Recursive `.dockerignore` ruleへ収束後、両Dockerfile contextで全canaryが不在かつallowed markerが存在するGREENを確認。実`Dockerfile`/`Dockerfile.local`もbuildし、最終filesystemとimage historyに禁止Repository artifact名がないことを確認した。検証専用containerとimage tagは削除済み。Infrastructure scopeとCIへguardを接続し、Buildx前提と単独実行方法をdevelopment正本へ追記した。
- 2026-08-22: M2のExecPlan追記後にcommit前必須gateを約204秒で再実行し、最終staged tree `2ec4b599d2a5edbb10aa2d0019907dcf398fd207`の開始・終了一致、全scope、Playwright 14/14を確認した。M2完了後のindex内容変更はなく、commit権限がないためcommitしていない。
- 2026-08-22: M2完了。変更前REDは異User置換後もquery/mutationが各1件残りeditor入力も旧Userのまま、same-tab/no-reload Google login後もfresh Home cacheが切替元Goalを表示することを再現した。GREENではidentity transitionを直列化し、全query/cache helper/page caller/invalidationをcaptured User IDへscopeし、User ID変更時だけapp subtreeをremountした。同一User upgradeはcache objectと入力を保持し、切替元browser draftはUser ID分離したまま保存する。Productionの旧unscoped query keyはzero。Target Vitestは9 files / 36 tests、same-tab test 1/1、contract characterization 6/6が成功した。
- 2026-08-22: M2 Frontend gateは固定tool環境で約64秒、28 files / 81 tests、format、lint、strict typecheck、production buildが成功。Fresh disposable PostgreSQL 18.6上のfull E2E gateは約227秒でFrontend 28/81、Backend/sqlc、shell/Compose/Terraform、Cloudflare 8 tests、Wrangler dry-run/Container build、Playwright 14/14が成功し、migration version 1・dirty=false、generated drift zeroを確認した。
- 2026-08-22: M2の最初のcommit前必須gateは約181秒で成功。Actionlint、全scope、Playwright 14/14、candidate tree `10a9b8ce8d0871af8ec5dc808a2c73b7c1548ae8`の開始・終了一致を確認した。本entry追加でtreeを変更したため、完全stage後にgateを最初から再実行する。
- 2026-08-22: M2検証環境では、最初のFrontend起動がpnpmのnon-TTY store確認、full E2Eの最初の2回がnested Dockerのpath aliasとGit safe-directory guardで停止した。いずれもtest/migration開始前の固定container構成問題で、`CI=true`、host/container同一absolute path、process-local Git configにより解消し、該当gateを最初から再実行した。Root-owned tool containerが作成したGit object/index ownershipもrepository metadataだけを通常Userへ戻し、source/index内容が不変であることを確認した。Code assertionの再実行だけで失敗を隠していない。
- 2026-08-22: M1完了。Protected/unsafe全routeのauthn・exact Origin・CSRF、cookie/body limit/error code/redactionをHTTP contract testで固定。実PostgreSQLで同一bootstrapの4並行requestが1 User/1 record/4 Sessionへ収束し、20件のcross-user操作がresource-specific 404かつowner state不変であることを確認。Goal Refine明示採用、Google collision/login非merge、account delete/revisit、active termination/canceled read-only、Action AI failure等を追加し、Vitest 28 files / 73 tests、Playwright 13/13が成功。Aは261.85秒、空DBからのEは276.67秒、migration version 1、sqlc drift zero。
- 2026-08-22: M1 commit前必須gateは270.26秒で成功。staged candidate tree `87c96e30b3eafda1cd92611a5392a0aeb4267333`、Vitest 28/73、Playwright 13/13、全scope、empty DB migration、sqlc drift zeroを確認。commit権限は明示されていないためcommitせずM2へ進んだ。
- 2026-08-22: M0完了。Goal上限2、Home `GoalView/currentWork`、Goal Refine `suggestion`を`docs/design.md`内で収束。Aは153秒、空のPostgreSQL 18.6を使うEは224秒で成功し、Playwright 8/8とmigration version 1を確認。既存Markdown 13 filesのlocal link/reference/fence checkも成功した。
- 2026-08-22: 実装開始baselineを固定Docker環境（Node 24.19.0 / pnpm 11.22.0 / Go 1.26.6 / Terraform 1.15.8 / PostgreSQL 18.6）で再実行。Frontend 26 files / 70 tests、Backend unit/integration/build、sqlc差分なし、shell/Compose/Terraform、Cloudflare 8 tests、Wrangler dry-run/Container buildが成功。空のdisposable `fukamu_cycle_test` DBへmigrationを適用し、Playwright 8/8 scenariosが成功。baseline commit/treeからのdriftなし。
- 2026-08-22: M0 commit前必須gateはfresh disposable PostgreSQL 18.6上で228秒で成功。staged candidate tree `b10e66b9d20e4eea82ad371c66effea2fcfb8d35`、Playwright 8/8、sqlc drift zeroを確認。commit権限は明示されていないためcommitせずM1へ進んだ。
- 2026-08-22: Repository全体、文書、依存、DB、CI/CD、IaC、security、observabilityを監査。
- 2026-08-22: Frontend、Backend、Cloudflare、Terraform、E2E、空DB baselineを固定環境で検証。
- 2026-08-22: 仕様矛盾3件とarchitecture/CI/Terraform方針をuser判断で確定。
- 2026-08-22: ExecPlanを`.codex/plans/whole-system-reform.md`として作成。改革実装は未開始。
- 現在の再開位置: M13完了記録を含むplan-inclusive final treeを再stageし、別のfresh disposable PostgreSQL 18.6でCを最初から再実行する。成功後はindexを変更せず、M14 Goal draft/refine/start Application移行のREDへ進む。M15 Deleteのretention判断はOpen Decisionとして局所停止し、Commitしない。

## 26. Final definition of done

- 主要user flowがacceptance/component/API/E2E testで保護される。
- 認証、認可、CSRF、ownership、入力境界、revision、idempotency、主要異常系が検証される。
- Formatter、lint、typecheck、static analysis、test、build、security gateが成功する。
- Clean checkoutからsetup、build、起動、testが再現できる。
- Empty disposable DBへ全migrationを適用し、API/E2Eを完走できる。
- Global lock order、AI quota/budget、cache isolationが機械的に保護される。
- 旧実装、compatibility layer、dead code、unused dependency、旧構造参照が残らない。
- Generated codeと生成元が一致する。
- READMEから全正本へ到達でき、link/fenceが有効。
- Normativeな仕様、command、config値に重複がない。
- Code、test、config、文書が一致する。
- Security、reliability、observabilityが変更前より弱くない。
- 変更前後のfiles、LOC、dependency、bundle、build/test時間、主要flow coverageを比較する。
- Terraform、main CI reuse、Closed Betaなど削除しない複雑性は、判断理由と撤去条件を説明する。
- Production未決値と残存riskを明記し、未決のままProduction deployしない。
- M0–M33のacceptance、validation、rollback、Decision log、Progress logが完了している。
