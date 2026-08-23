# FUKAMU Cycle Whole-System Reform ExecPlan

- 保存先: `.codex/plans/whole-system-reform.md`
- 基準commit: `fe2c82a5705d192ceddbcb61aa217c6f9f45c29c`
- 初版作成日: 2026-08-22
- 状態: IN_PROGRESS / M4 Config/admission parity

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
- **Current tests / missing tests / evidence**: `backend/internal/application/session/service_test.go`、`backend/internal/application/account/service_test.go`、`frontend/src/pages/SettingsPage.test.tsx`が部分保護。Google upgrade/switch E2E、cache isolation、session CAS、delete/revisitが不足。根拠はaccount/session handlers、repositories、`SessionProvider.tsx`。

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
- **Current tests / missing tests / evidence**: API/client tests、autosave failure E2E、cross-user API E2Eが部分保護。Session expiry、top-level Error Boundary、real revision conflict、response-loss journeyが不足。根拠はHTTP middleware/errors、API client、observability/security sections。

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
| M9 | top-level Error Boundary、identity-aware session transition、stable error presentationをapp層が所有 |
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
| M9 | F、session expiry/Error Boundary/account-switch tests、E、C |
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
| M9–M11 | Feature/app-shell単位のcommitをrevert。Route/API wire shapeは各commitで完結させる |
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
- 2026-08-22: M2ではglobalな`["session"]`だけをidentity非依存のまま維持し、全server stateとcreate-draft mutationを`["user", userId]`配下へ移した。異User置換は直列化し、実行時のcurrent sessionを再読してold-user query cancel/remove、mutation cache clear、新session publishの順に行う。同一Userではsessionだけを更新し、query/mutation/browser draft/editor stateを維持する。IndexedDB draftは既存のUser ID分離を維持し、切替元recordを削除しない。影響はFrontend cache keyとaccount transitionだけで、API wire shapeとserver dataは不変。Component ordering、parallel replace、factory/cross-user cache、same-tab no-reload E2Eを追加検証した。
- 2026-08-22: `MutationCache.clear()`は実行中requestをabortせず、detached Cycle saveも切替と競合し得ることを再監査で確認した。M2ではcapture済みold User prefix/IndexedDB key、keyed remount、serverのsession-bound CSRF/ownershipによりnew User data contaminationを防止する。Request abort、identity lease、late navigation抑止、one-shot account transition noticeはM8/M9のautosave/app-shell責務として追加検証する。これはM2のdata-isolation acceptanceを弱めず、影響は切替後に拒否される旧requestとUX副作用の停止強化に限る。
- 2026-08-22: 新しいsame-tab Google collision E2Eはpublic client IDがないbundleではtest fakeを描画できず、`scripts/check.sh --e2e`だけの設定では直接buildするGitHub E2E jobが不一致になると判明した。Production/deploy設定は変更せず、CI E2E buildだけに同じdummy public IDを与えた。影響はtest bundleだけで、workflow syntax、target/full Playwright、full gateを追加検証した。
- 2026-08-22: M3ではDocker contextへ送らないsecret-bearing artifactを、Repositoryで使用するpath class（`.env*`、`.dev.vars*`、credential/key形式、Worker secret file、Terraform state/input、dependency/tool output）として定義した。検証は実secretを探索・読取せず、固定のbenign synthetic canaryをroot/nested pathへ作って`Dockerfile`と`Dockerfile.local`のignore precedenceをBuildKitで確認する。任意名fileや内容検査、将来のnamed/remote contextまで保証するものではなく、新context追加時は同じmilestone guardを拡張する。影響はDocker build input、Infrastructure check、CIだけで、runtime configとimage内容は不変。
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
- 現在の再開位置: M4。Backend config、`.env.example`、environment文書、Worker handoff、deploy validationとClosed Beta admission入力を機械的parity testで固定してから、重複validationを単一契約へ収束する。

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
