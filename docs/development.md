# ローカル開発

この文書はCycle固有のローカル開発・検証手順とユーザビリティ調査手順の Source of Truth です。共通の作業方法は [FUKAMU Product Engineering Playbook](../.fukamu/playbook/PLAYBOOK.md)、アプリケーション要件・仕様・設計は [`design.md`](design.md) が上位です。環境変数の全項目は [`environment.md`](environment.md)、DB固有の運用は [`database.md`](database.md) を参照してください。

## 前提環境

- Bash 5.0以上とGNU userland（Ubuntu 20.04/24.04、WSL2）
- Node.js 24以上、pnpm 11.22.0（lock fileはrootの `pnpm-lock.yaml`）
- Go 1.27.0
- PostgreSQL（version、固定Docker image、起動方法は [`database.md`](database.md#local-postgresql)）
- sqlc 1.31.1、またはDocker（Backendの品質チェックとSQL生成に必要。Go 1.27.0によるfallbackも利用可能）
- Docker EngineとDocker Buildx（PostgreSQLの簡易起動、Cloudflare Container imageのbuild、InfrastructureのDocker build context監査に必要）
- Chromium（E2Eを実行する場合）
- Terraform 1.15.8（Staging/全体checkとCloudflare Turnstile基盤変更に必要）
- Python 3と`curl`、`jq`、`openssl`、`realpath`、`sha256sum`、`base64`、`tar`、`zip`、`script`、`sed`、`awk`、`find`、`sort`、`mktemp`

CIとContainer imageはNode.js 24、pnpm 11.22.0、Go 1.27.0と [`database.md`のPostgreSQL pin](database.md#構成)を前提にします。Staging基盤はTerraform 1.15.8とCloudflare provider 5.22.0、Wrangler 4.123.0をpinしています。ローカルでも同じversionを使ってください。Frontendだけを確認する場合はGo・PostgreSQL・sqlc・Terraformは不要です。

sqlcはRepository標準のラッパーで実行します。ラッパーはsqlc 1.31.1がHostにあればそれを使い、なければ`sqlc/sqlc:1.31.1@sha256:70f53171d27b2424e9358869975455a6e955a5aa8e58a998a270a6e34e525537`を`docker run --rm`で起動します。Docker serverも利用できない場合は、Goでpin済みの一時toolを`.tmp/tools`へbuildしてfallbackします。これによりsqlcをHostへ常設する必要はありません。Docker/Goはいずれも初回だけimageまたはmoduleのdownloadが必要で、一時toolは通常のsafe clean対象です。

```bash
./scripts/invoke-sqlc.sh compile generate
```

特定の実行方法を検証する場合は`--runner host`、`--runner docker`、`--runner go`を指定できます。Docker実行では`backend/`だけを書き込み可能でmountし、containerは実行後に削除します。Host user IDを渡し、生成物がroot所有になることを防ぎます。

## Supply-chain固定値の更新

GitHub Actionsの外部Actionは完全な40文字commit SHAと同じ行のsemantic version comment、外部Container imageは可読なtagと`sha256` digestの組で固定します。`./scripts/check-supply-chain.sh`はworkflow、Dockerfile、Compose、運用tool registry、文書の全参照と同一tagのdigest一致を検証し、`./scripts/check-security.sh`もsecret scan完了後のcandidate snapshotへ同じpolicyを適用します。

`.github/dependabot.yml`はGitHub Actionsを月曜、Dockerfileを火曜、Docker Composeを水曜の05:00（Asia/Tokyo）に週次確認します。GitHub ActionsとDocker Composeはecosystemごとの全version updateを1つのPRへまとめます。Dockerfile imageはgroupingせず、dependency単位のversion update PRとして1件ずつreviewします。各ecosystemの`open-pull-requests-limit: 1`はversion updateの同時open上限であり、別枠のsecurity updateを抑止しません。PRではupstream release/tagと変更履歴を確認し、ActionのSHAとversion comment、またはimageのtagとdigestを同じ変更で更新して全gateを通します。障害時も固定自体を外さず、直前に確認済みのSHAまたはtag/digest組へreviewed commitで戻します。

`docker://`形式のActionはDependabotの更新対象外です。Actionlintのrelease確認、workflow参照、`scripts/lib/tool-images.sh`の対応値は手動で同じPRへ更新し、policy fixtureとsecurity gateでdriftを拒否します。

## Product Engineering Playbookの検証・更新

共通の作業方法は [vendored Playbook](../.fukamu/playbook/PLAYBOOK.md)、採用revision・署名者fingerprint・hashは [lock](../.fukamu/playbook/lock.json)、Cycleのowner境界と全rule traceは [config](../.fukamu/playbook/config.json)、期限付き例外は [overrides](../.fukamu/playbook/overrides.json) が所有します。`config.json`は各ruleを、local再定義を持たない`direct-adoption`、Cycle固有の手順・値へ具体化する`cycle-concretization`、Playbookより厳しい制約を加える`local-stricter`のいずれかへ分類し、後二者では実在する正確なMarkdown headingを示します。通常のlocal / CI gateは外部repositoryへ接続せず、次で同じcandidateのvendored bytes、empty overrides、trace、workflowと既存required gateへの配線を検証します。

```bash
./scripts/check-playbook-adoption.sh
```

Playbookの導入・更新時は通常checkに加え、中央repositoryをpartial/shallow optionなしで新しい一時directoryへcloneし、source-backed modeを実行します。このmodeはself-containedなGit object graph、approved origin、repository-localな署名helper設定の不在、署名付きversion tagから40桁revisionへの解決、承認済み署名者fingerprintを確認します。さらに中央commitのblobを新しい一時fileへ`trusted_git show`で取り出し、candidate validatorへ委譲せず、中央・vendored `PLAYBOOK.md` / `validate.py`・lock hashの三者一致をfail closedで確認します。既存の不明なclone、working repository内のdirectory、`--depth`、`--filter`を使いません。

```bash
git clone https://github.com/fukamu/product-engineering-playbook.git /tmp/fukamu-product-engineering-playbook-v0.1.0
./scripts/check-playbook-adoption.sh \
  --source-repository /tmp/fukamu-product-engineering-playbook-v0.1.0
```

更新PRでは、中央diffとrule IDの追加・変更・削除をreviewし、vendored bundle、validator、lock、overrides、config trace、影響するCycle consumerを同じ変更へ含めます。中央`main`、floating tag、短縮SHAをlockへ入れません。共通方法とCycle固有contractのowner境界またはrequired verificationが変わる場合は、先に[`design.md` §52](design.md#52-change-control--operational-decisions)の仕様変更手順へ戻ります。

## Dockerによるローカル実機確認

Docker Desktop、Bash 5、curlだけで、Frontend、Backend、Migration、PostgreSQLを隔離環境へbuildし、ブラウザから操作できます。Repositoryの`.env`、`frontend/.env.local`、`node_modules`、`frontend/dist`、`.tmp`、既存の`fukamu-cycle-postgres`は使用・変更しません。

```bash
./scripts/local-app.sh
```

ready確認後に`http://localhost:8080`を開きます。Enterで終了すると、`fukamu-cycle-local` Compose projectのcontainer、network、破棄可能DBだけを削除します。DBはtmpfsで永続化されず、Hostへport公開されません。Applicationは`127.0.0.1:8080`だけへ公開されます。Docker imageとBuildKit cacheは次回の高速化のため保持し、他projectを含むglobal pruneは実行しません。

別portを使う場合は`--port`を指定します。

```bash
./scripts/local-app.sh --port 8081
```

Terminalを解放したまま起動する場合は`--detached`を使い、終了時に専用の`--down`を実行します。Terminalの強制終了等で自動cleanupされなかった場合も同じ`--down`を使用します。

```bash
./scripts/local-app.sh --detached
./scripts/local-app.sh --down
```

このprofileは`APP_ENV=development`、空の`OPENAI_API_KEY`、無効なTurnstile、未設定のGoogle Client IDで起動します。Telemetryはin-memory exporterを使い、`OTEL_EXPORTER_OTLP_ENDPOINT`と`OTEL_EXPORTER_OTLP_HEADERS`を設定せず、外部collectorへ送信しません。AIは決定的なFake Adapterを使用し、Google連携以外のGoal/Cycle/Review操作を外部credentialなしで確認できます。これは手動の実機確認環境であり、format、lint、typecheck、unit/integration test、E2E、Terraform、Wranglerの品質checkを代替しません。

## 初回Cycleユーザビリティ調査

このsectionは、初回Goal作成からCycle 1完了、Goal Review、Cycle 2開始までのmoderated usability researchについて、task script、準備、個人を特定しない観察、集計の唯一の手順ownerです。Product behaviorとprivacy invariantは[`design.md`](design.md) §§2、6、9、29.10–29.11、41–42、48、調査の承認・進捗・判断は[Issue #46](https://github.com/fukamu/cycle/issues/46)が所有します。この手順や調査findingはProduct仕様を上書きしません。Findingを採用する場合は、別のDelivery変更としてcanonical ownerを先に更新します。

Issue本文やコメントに残る過去のscript、rubric、templateは判断履歴です。実行時はこのsectionだけを現行kitとして使い、Issueへ同じ定義をcopyしません。

### Current authorization boundary

現在、自律実行できる範囲は次だけです。

- Exactなlocal revisionとsynthetic scenarioだけを使うdesk-based walkthrough。
- T1–T7、moderator checklist、screener / consent文案、観察schema、aggregate templateの更新。
- Product Ownerを実参加者数へ含めないlocal synthetic moderator dry-run。
- 個人を特定しないaggregateの形式確認。

次は承認済み範囲に含まれません。

- 実参加者の募集、補償、consent取得、session実施。
- 実在するGoal / P / D / C / A、氏名、email、Application User / Session ID、IP、raw logの収集。
- Audio、video、screen recording、逐語録の収集または保存。
- Raw note、contact情報、consent recordへのCodexまたは外部AIのaccess。
- Private research storageの新設、Production / Staging telemetry、Google、外部AI、Cloudflareの使用。
- Penpot #35との比較、§42.4のProduction baseline計測、findingを根拠にした実装またはProject Priority変更。

### Human session開始前の未決事項と停止条件

次はProduct Ownerが明示的に決め、Issue #46へ承認証跡を残すまで`TBD`です。推奨案はprivacy-minimizingな開始点であり、決定値ではありません。一項目でも`TBD`、矛盾、または実行者が確認できない状態なら、募集、consent取得、実参加者sessionを開始しません。

| Decision | Privacy-minimizing recommendation | Current status / unblock evidence |
|---|---|---|
| Participant条件と人数 | 自ら同意できる成人、日本語taskを読める人に限定し、PDCA経験だけを`未経験 / ときどき / 継続`の粗いbucketで混ぜる。Issueの目安は5名程度 | `TBD` — 条件、除外条件、人数のProduct Owner承認 |
| 募集経路と補償 | 公開募集を広げず、approved ownerが一つの経路で個別連絡する。補償有無・額・支払手段は研究dataから分離する | `TBD` — 経路、文面、補償、担当者のProduct Owner承認 |
| Research roles | 一人のresearch owner、moderator、privacy reviewerを明示し、兼務を記録する | `TBD` — 各roleの氏名または責任主体のProduct Owner承認 |
| Consentと撤回窓口 | 下記文案を承認し、開始前に同意を得る。匿名集計前の撤回窓口と期限を一つだけ示す | `TBD` — consent version、取得方法、窓口、撤回期限のProduct Owner承認 |
| Private保存先とaccess | Contact mapping、consent、coded observationを別のaccess-controlled storeに分け、必要なhumanだけへ最小権限を付ける。新設は別承認とする | `TBD` — exact location、各閲覧者、backup有無のProduct Owner承認 |
| Retention / deletion | 保存期間を必要最小限にし、開始前にexact calendar date、削除owner、backupの扱い、削除確認方法を通知する | `TBD` — exact deletion date、削除owner、backupの扱い、削除確認方法のProduct Owner承認 |
| 実行environment | Localの空で破棄可能なDB、fresh browser、Fake AIを第一案とし、Production data / telemetryを使わない | `TBD` — `local / staging / production`のProduct Owner承認。Production値を推測しない |
| #35 / #45の扱い | 初回現行UIの理解確認から分離し、#35比較と#45 Production baselineをこのstudyから外す | `TBD` — de-scopeまたは別study化のProduct Owner承認 |

人対象sessionでは、参加撤回、実内容の入力、recording開始、未承認storeへの保存、閲覧者の不一致、外部request、target SHA / browser / viewport / start state不一致、Application error、データ漏えい疑いのいずれかで直ちに停止します。値を再掲せずresearch ownerへ連絡し、安全を確認できるまで再開しません。Technical failureでtaskを続けられない場合も`N`へ推測で変換せず、session全体を`stopped_technical`、全taskを`not_scored`として集計対象から外します。

### Screener proposal

Screenerは候補者を広くprofileするものではなく、承認済み条件に必要な最小項目だけにします。次の文案はProduct Owner承認前には配布しません。

1. 自ら参加に同意できる成人ですか。`yes / no`（成人限定を採用する場合だけ使用）
2. 日本語で表示されるWeb Applicationのtaskを読んで操作できますか。`yes / no`
3. 過去12か月のPDCAまたは類似する振り返りの経験に最も近いものを選んでください。`未経験 / ときどき / 継続`
4. 承認されたbrowser / deviceと時間で参加できますか。`yes / no`
5. 実生活の情報ではなく、用意された架空scenarioだけを入力することに同意できますか。`yes / no`

氏名、email等の連絡先はscreener回答sheetへ入れず、recruitment ownerだけが扱うcontact storeでsession codeへ対応付けます。年齢、生年月日、性別、住所、勤務先、健康状態、実際のGoal、自由記述の経歴は収集しません。Accessibility上の調整依頼がある場合はrecruitment連絡として扱い、research noteへ転記しません。

### Consent draft

次の`[...]`をProduct Owner承認済みの値で埋め、privacy reviewerが空欄と不整合がないことを確認するまで使用しません。

> この調査は、FUKAMU Cycleで用意された架空の目標を作り、1回のCycleと見直しを進める際の分かりやすさを確認するものです。参加は任意です。理由を示さず質問を飛ばしたり、いつでも中止したりできます。実在する仕事、健康、家庭、人生の内容は入力せず、提示された架空scenarioだけを使用してください。音声、映像、画面を録音・録画せず、逐語録も作りません。Moderatorはtaskの完遂状況、1分単位へ丸めた所要時間、選んだ操作、neutral promptの有無、個人を特定しない一文への言い換えだけを記録します。Contact情報と観察記録は別に保存し、Codexその他の外部AIへ渡しません。個人別記録を閲覧できるのは[research owner / moderator / reviewer]です。匿名集計にはtaskごとの人数とfindingの言い換えだけを使い、GitHubへ個人別の行を載せません。匿名集計前の[exact withdrawal deadline]までは[withdrawal contact]へ撤回を申し出られます。匿名集計後は個別結果を識別して除外できない場合があります。保存先は[private location]、個人別記録の削除日は[exact deletion date]、削除担当は[deletion owner]です。

Consent recordに残せるのは`consent_version`、`session_code`、`accepted / declined`、取得日だけです。氏名や署名が法的・運用上必要か、取得日より細かい時刻が必要かはProduct Ownerが別途決めます。Declineまたはwithdrawalは理由を尋ねず、観察sheetを作成または継続しません。

### Data separationとaccess boundary

| Store | Allowed data | Prohibited data / access | Lifecycle |
|---|---|---|---|
| Contact mapping | 連絡に必要な最小情報、randomな`session_code` | Task outcome、観察、GitHub、Codex、外部AI | Recruitment ownerだけ。approved deletion dateまで |
| Consent record | `consent_version`、`session_code`、accept / decline、必要なら取得日 | Goal本文、発言、操作path、Codex、外部AI | Approved human rolesだけ。retentionは開始前に確定 |
| Coded observation | 下記allowlistのsession-level codeと一文のparaphrase | Contact、氏名、email、実User Content、逐語発言、recording、exact event timestamp、Codex、外部AI | Approved private storeだけ。aggregate確認後、exact deletion dateに削除 |
| Aggregate evidence | Overall `n / N`、task outcome count、分単位のsummary、top finding | Session code、個人別row、経験bucket別のsmall subgroup、raw note、quote | Privacy review後だけGitHub / PR / Issueへ掲載可 |

Session codeは連番、email fragment、Application IDを使わず、contact storeのhuman ownerがrandomに発行します。Raw noteとは、匿名化前後を問わず個別sessionに結び付く観察を指します。Codexはraw noteを閲覧、変換、要約、移送しません。Codexへ渡せるのはprivacy reviewerが公開可能と判断したaggregateだけです。

### Preflight

Moderatorとreviewerはsessionまたはsynthetic dry-runごとに次を埋め、開始前に読み合わせます。`Target UI baseline`はこのkitを更新した時点のexact mainであり、UI変更後はtaskとbaselineを再reviewします。Runtime欄にplaceholder、短縮SHA、`latest`、browser majorだけを残したまま開始しません。

| Field | Required value for this kit / recording rule |
|---|---|
| Study / script version | `cycle-first-loop-v1` |
| Target UI baseline | `1c646b07f4c4560ac904c15ac73b88c2f7c44d4a` |
| Checked-out revision | `git rev-parse HEAD`の40文字SHA。Target UI baselineとUI差分がないことを確認 |
| Browser | `Chromium <full version>`を実行時に記録。Extensionなしのfresh context |
| Desktop viewport | `1280 × 844` CSS px、zoom `100%` |
| Mobile viewport | `390 × 844` CSS px、zoom `100%`。T7だけで使用 |
| Application | `./scripts/local-app.sh`が表示する`http://localhost:<port>`のisolated local app |
| Data | Emptyで破棄可能なlocal DB、新しいanonymous User、fresh storage。実User / Production dataなし |
| External boundaries | Google未設定、OpenAI keyなし、Fake AI、in-memory telemetry、外部requestなし |
| Start state T1 | Homeの「まだ進行中の目標はありません。」が表示され、creation draftなし |
| Start state T2–T6 | 直前Taskの成功状態。Taskをskipした状態から開始しない |
| Start state T7 | T6後のGoal v1 / Cycle 2、Pが選択済み、Frame本文は空 |
| Timing | Stopwatchは相対経過だけ。Absolute start/end timestampを記録せず、task終了時に分単位へ切り上げる |
| Stop condition | 前sectionの停止条件、browser console error、記録したApplication originとsame-originではないrequest、target差分のいずれか |

実参加者sessionでは、この表に加えて全Product Owner決定、consent acceptance、session code、moderator / reviewerを確認します。Synthetic dry-runではpersonを参加者として数えず、contact / consent storeを作りません。

### Synthetic scenario

全taskで次の同じ架空scenarioだけを使用します。参加者自身のGoalや具体的な事情へ置き換えません。

> 平日の午前に最重要作業へ集中したい。今週はメールを開く前に通知を切って30分取り組み、5日中3日は午前中に主要作業を終える。実際には5日中4日着手し、3日は30分継続して午前中に完了した。1日は15分で中断し、残る1日はメールを先に開いた。次回は通知offを継続し、中断時の再開時刻も記録する。

### T1–T7 task scriptと§42.4 mapping

Moderatorは`Prompt`だけを読み、`Success state`にあるUI名称や操作を先に教えません。`§42.4 relation`は概念上の接続であり、この調査dataをProduct KPIへ投入する指示ではありません。

| Task | Participant prompt | Success state | Primary observation | §42.4 relation |
|---|---|---|---|---|
| T1 Goal start | Homeから、架空scenarioの改善目標を設定して最初の取り組みを始めてください。AIは使わないでください | 「Goal v1 · Cycle 1」、Pが選択される | 「新しい目標を設定」の発見、80文字feedback、保存待ち、manual path、遷移後heading | ActivationのFirst Goal startに対応。ただし48時間windowを測らない |
| T2 Plan | 今回試すことと、うまくいったと判断する条件を記録して、次の記録へ進んでください | P保存後、Dが選択される | Pの意味、guideと「D — Doへ進む」の発見、tabとの選択 | Funnelの中間qualitative evidence。独立KPI stageではない |
| T3 Do | 架空scenarioで実際に起きた事実を記録して、次へ進んでください | D保存後、Cが選択される | 計画と事実の区別、任意の「今の実行を記録」、CへのCTA、保存feedback | Funnelの中間qualitative evidence。実日時をstudy dataにしない |
| T4 Check | 計画と実際を比べ、分かったことを記録して、次へ進んでください | C保存後、Aが選択される | 「今回のPとDを比べる」、縦scroll、比較からCを書く流れ、AへのCTA | Funnelの中間qualitative evidence。独立KPI stageではない |
| T5 Action / complete | 次回に続けること・変えることを書き、このCycleを確定してください。AIは使わないでください | Confirmationで全Frameを確認し、Goal Reviewへ到達 | Aの意味、disabled guidance、全Frame summaryと編集導線、完了後編集不可warningの理解、Goal Review上のread-only summary、dialog判断 | First Goal funnelのCycle 1 completedに対応。所要時間は168時間KPIではない |
| T6 Review / Cycle 2 | 直前の結果を振り返り、目標文は変えずに次の取り組みを開始してください。実行前に、続ける場合と終える場合の違いを説明してください | 「次のサイクルへ進む」から「この目標で次のサイクルへ」を実行し、「Goal v1 · Cycle 2」、Pへ到達 | 直前Cycle summary、Review goal、next / terminal sectionの区別、primary action、結果の予測 | Review decision=`next_cycle`とMeaningful loopに対応。Terminalは理解だけを観察し実行しない |
| T7 Mobile orientation | Mobile表示で現在地を説明し、入力を変えずにP / D / C / Aを一巡してPへ戻ってください。次にHome、履歴、設定の行き方を確認してください | 横scrollなく全tabpanelへ到達し、Home linkと履歴・設定linkを特定し、Drawerを閉じてCycle 2のPへ戻る | `P Plan`等のaccessible name、bottom tabs、focus、Home導線、Drawer内の履歴・設定導線、focus循環と背景無効化。Software keyboard遮蔽は対応実機だけで観察し、それ以外は`not_assessed` | KPI非該当。Mobile / accessibility guardrail evidence |

T1、T5、T6の所要時間はmoderated task timeであり、Application DBのUser作成、Goal作成、Cycle完了、Review decisionのevent間隔ではありません。`kpireport`へsession sampleを入れず、48h / 168hの達成率、Production baseline、retention、小標本のProduct傾向として表現しません。

### Moderator checklist

開始前:

- Preflightを二者確認し、target SHA、full browser version、両viewport、empty start state、localhost-onlyを固定する。
- Human sessionなら全`TBD`の承認証跡、role、consent、private store、access、exact deletion dateを確認する。Synthetic dry-runならhuman studyとして扱わない。
- Recording機能、transcription、browser sync、extensionをoffにし、実User Contentを入力しないことを伝える。
- Stopwatchはtask単位の相対時間だけを表示し、絶対時刻や画面captureを保存しない。
- Observation sheetはallowlist列だけにし、free-form transcript欄を作らない。

実施中:

- T1から順にPromptを一度だけ読み、button名、P/D/C/Aの答え、成功pathを教えない。
- 参加者が停止を宣言するか60秒操作がないときだけ、「次に何をしようと思っていますか？」を1回使う。それ以外の誘導はせず、2回目の支援が必要なら`N`とする。
- Sessionが停止せずTaskを終えた場合だけ`I / R / A / N`、切り上げた分数、prompt数、closed codeを記録する。Sessionが停止した場合は全taskを`not_scored`とし、集計のoutcome countとdurationから除外する。発言は引用せず、一文で一般化してparaphraseする。
- T5の確定前に、全Frameを確認できるか、編集へ戻った後に再び完了できるかを観察する。
- T6の実行前にnext / terminalの結果説明を聞き、terminal action自体は実行しない。T6後はCycle 2へ本文を追加しない。
- T7は`390 × 844`へ切り替え、内容を編集しない。Keyboardだけの確認ではPointer、Touch、screen reader、software keyboard遮蔽の成功を推測せず、実施していないinteraction modeを`not_assessed`とする。
- Consent撤回または停止条件に該当したら即時停止し、理由を問い詰めず、recordの扱いをapproved procedureへ渡す。

終了後:

- Session-level sheetからcontact、実本文、quote、exact timestamp、DOM selector、raw ID、uniqueな経歴がないことをhuman reviewerが確認する。
- Moderatorとreviewerだけでseverity、friction code、paraphraseを確認する。Codexへsheetを渡さない。
- Approved minimumを満たすまでindividual patternをIssueへ逐次掲載せず、overall aggregateだけを作る。
- Aggregate承認後、deletion ownerがexact dateにprivate recordを削除し、値を含まない完了記録だけを残す。

### Coded session-level observation schema

次の列だけをsession-level coded observationへ使用します。`session_code`を含む全行は匿名化済みaggregateではなくraw noteとして扱います。

停止sessionでは、停止を検知したTaskのrowだけを残して`outcome=not_scored`とし、Task固有の観察値は`not_assessed`にします。未開始・完了済みを含む他Taskのrowは作成または保持しません。Withdrawal時は停止rowも含めて全観察rowを削除します。

| Field | Type / allowed values | Rule |
|---|---|---|
| `study_version` | `cycle-first-loop-v1` | Script変更時は新version。過去rowを上書きしない |
| `target_sha` | 40文字lowercase Git SHA | Preflightのexact value |
| `browser` | family + full version | User-Agent全文は保存しない |
| `viewport` | `1280x844` / `390x844` | T1–T6 / T7 |
| `session_code` | random opaque code | Contact storeだけが対応表を持つ。公開しない |
| `experience_bucket` | `none / occasional / continuous` | Approved screener回答だけ。subgroup公開しない |
| `session_status` | `completed / stopped_technical / stopped_boundary / stopped_privacy` | `completed`以外は全taskを`not_scored`として集計から除外。Withdrawal時はrow自体を削除する |
| `task_id` | `T1`–`T7` | 1行1task |
| `outcome` | `I / R / A / N / not_scored` | `I`支援なし、`R`誤経路から自己回復、`A`1回のneutral prompt後完遂、`N`Application上で未完遂。停止sessionだけ`not_scored` |
| `duration_minutes` | 0以上の整数 / `not_assessed` | 相対時間をtask終了時に分単位へ切り上げる。時刻を保存しない |
| `prompt_count` | `0 / 1 / not_assessed` | 2回目が必要なら実施せず`N` |
| `first_path` | `expected / alternate / backtrack / none / not_assessed` | SelectorやURL履歴を保存しない |
| `comprehension` | `clear / partial / incorrect / not_assessed` | 自分の言葉で結果を説明できたか |
| `friction_code` | `F-XX / none / not_assessed` | 一つの意味に固定。新codeはreviewerと定義する |
| `severity` | `S0 / S1 / S2 / S3 / not_assessed` | `S3`完遂不能・誤った不可逆操作・入力喪失risk、`S2`支援必須・反復誤経路、`S1`自己回復できる明確な迷い、`S0`阻害なし |
| `recovery` | `self / neutral_prompt / none / not_needed / not_assessed` | 観察した経路だけ |
| `paraphrase` | 個人を特定しない一文 / `not_assessed` | Quote、実内容、固有名詞、珍しい属性を禁止 |
| `stop_reason` | `none / personal_content / recording / boundary_mismatch / technical / privacy` | 停止時も詳細を書かない。Withdrawal時はrowを残さない |

列を追加する場合は、Product question、必要性、access、retention、aggregateへの用途をprivacy reviewerが確認し、開始前にschema versionを上げます。Free-text transcript、absolute timestamp、pointer座標、full navigation log、screenshot、screen recordingは追加しません。

### Aggregate template

Human reviewerはprivate rowから次の形だけを作り、privacy review後にIssueへ貼れます。Placeholderのままなら未完了であり、Codexはprivate rowから埋めません。

```markdown
## First Cycle usability aggregate

- Study / script: cycle-first-loop-v1
- Target SHA: <40-character SHA>
- Browser: <family and full version>
- Viewports: 1280x844 / 390x844 CSS px at 100%
- Sessions included: <N>; excluded/stopped: <aggregate count only; not in task counts or duration>
- Evidence limit: moderated synthetic-scenario sample; Production behaviorへ一般化しない
- Privacy review: <human reviewer> / <completed date only>

| Task | I | R | A | N | Duration, rounded minutes |
|---|---:|---:|---:|---:|---|
| T1 | <n> | <n> | <n> | <n> | median <n> |
| T2 | <n> | <n> | <n> | <n> | median <n> |
| T3 | <n> | <n> | <n> | <n> | median <n> |
| T4 | <n> | <n> | <n> | <n> | median <n> |
| T5 | <n> | <n> | <n> | <n> | median <n> |
| T6 | <n> | <n> | <n> | <n> | median <n> |
| T7 | <n> | <n> | <n> | <n> | median <n> |

### F-XX: <short finding>

- Stage / viewport: <Tn> / <desktop|mobile>
- Observed pattern: <n / N overall; no subgroup>
- Outcome impact: <aggregate I / R / A / N>
- Severity: <S0–S3>
- Expected understanding / action: <canonical reference>
- Observed pattern: <aggregate paraphrase, no quote or session detail>
- Recovery: <aggregate self / neutral prompt / none>
- User impact: <one sentence>
- Evidence limits: <sample and environment>
- Proposed decision: <Adopt / Hold / Reject, pending Product Owner review>
- Follow-up: <separate Delivery Issue or none>
- Privacy check: no session code, contact, raw content, quote, timestamp, ID, or recording
```

Top findingはseverity、観察人数、Core Loopへの影響を別々に示し、単純な合計scoreで自動順位付けしません。経験bucket別の少人数結果、個人別duration、最小・最大値、session順序は公開しません。Adopt / Hold / RejectとProject Priority変更はProduct Owner review後だけ確定します。

### Local synthetic moderator dry-run

このdry-runは調査kitとmoderator handoffを検証するrehearsalであり、Issue #46の実参加者数、finding、baselineへ数えません。Product Ownerが操作役でもparticipantには数えず、`N=0`のままです。実参加者のふりをした推測結果を作りません。

1. `git status --short --branch`と`git rev-parse HEAD`を確認し、PreflightのTarget UI baselineからUI差分がないことをreviewする。
2. [`Dockerによるローカル実機確認`](#dockerによるローカル実機確認)に従い、空のtmpfs DB、Fake AI、in-memory telemetryでappを起動する。Google / OpenAI / OTLP credentialを設定しない。
3. Fresh browser contextを作り、NetworkでPreflightに記録したApplication originへのsame-origin requestだけであることを確認する。異なるoriginへのrequestがあれば停止する。
4. ModeratorはSynthetic scenarioとT1–T7のPromptだけを読み、内部のrehearsal operatorが成功状態まで操作する。60秒待たずneutral promptのtimer / wordingだけをsimulateし、誘導にならないか確認する。
5. `session_code=SYNTHETIC`のmemory上のsample rowで全allowlist列、outcome code、severity、stop reason、aggregate変換を確認する。File、Issue、clipboard、external AIへraw rowを保存しない。
6. T1–T6は`1280 × 844`、T7は`390 × 844`で、heading focus、next-frame CTA、P/D comparison、completion summary、Goal Reviewの二section、bottom tabs、Drawer focus containmentを確認する。Pointer / Keyboard / screen readerを実施していない場合は結果を代用しない。
7. Failureがあれば`script / environment / application / privacy`のclosed classと影響Taskだけを残し、Product findingにしない。Script修正後はversionとTarget UI baselineを再確認する。
8. Local appを専用の`--down`で終了する。Production、Cloudflare、Google、外部AI、§42.4 `kpireport`を実行しない。

Dry-run完了証跡に残せるのはstudy version、exact SHA、browser full version、viewport、実施したinteraction mode、Taskごとのkit `pass / revise`、外部request `0`、人対象session `0`だけです。制御surfaceからbrowser full versionまたはNetwork一覧を取得できない場合は、その項目を`not_assessed`、kitを`revise`とし、取得可能なbrowserでの再実行条件だけを残します。`not_assessed`のまま人対象sessionを開始しません。Synthetic operatorの個別行や架空findingは残しません。

### 準備sliceとIssue全体の完了条件

Preparation sliceは、次を同じcandidateで満たしたときだけ完了です。

- Exact mainに対してT1–T7と現行UI label / success stateが一致する。
- §42.4との概念mappingと、KPIへ研究sampleを混ぜない境界が明記される。
- Moderator、screener、consent、data separation、observation schema、aggregate、preflight、synthetic dry-runが一つのownerへ揃う。
- Synthetic dry-runが`pass`、または`revise`のblockerと再実行条件が記録される。
- Applicableなdocumentation checkとcommit前gateが同じstaged treeで成功する。

Preparation sliceの完了はIssue #46の完了ではありません。Issue全体は、全`TBD`がProduct Owner承認済みになり、承認された人数で実参加者sessionを終え、human privacy reviewerがaggregateと上位3摩擦を確認し、Product OwnerがAdopt / Hold / Reject、Project Priority、#35 / #45の扱いを決めるまでcloseしません。ここで採用した変更は別Delivery Issueで実装・検証します。

## 初回セットアップ

リポジトリルートで次を実行します。

```bash
./scripts/setup.sh
```

このスクリプトはNode/pnpm/Goのバージョンを確認し、未作成の場合だけ `.env.example` から `.env`、`frontend/.env.example` から `frontend/.env.local` を作り、rootで`pnpm install --frozen-lockfile`とBackendの`go mod download`を実行します。既存の環境ファイルを上書きしません。依存関係を入れず環境ファイルだけ準備する場合は `--skip-install` を指定できます。

`.env` のSession/bootstrap pepper、rate-limit HMAC、cursor署名secretはローカルでも24文字以上、`CSRF_TOKEN_PEPPER`は32 bytes以上が必要です。Exact contractは[`environment.md`](environment.md)に従い、example値をproductionで使ってはいけません。Frontendの `VITE_` 変数はブラウザへ公開されるため、秘密値を入れてはいけません。

Backendはdotenvを暗黙ロードしません。Backendを操作する各Bash terminalで、次のように現在のshellへ読み込みます。値は画面へ表示されません。このscriptをsubprocessとして実行しても親shellへ反映されないため、必ず`source`してください。

```bash
source ./scripts/import-env.sh
```

## PostgreSQLの準備

固定imageによる開発DB起動は [`database.md`のLocal PostgreSQL](database.md#local-postgresql)、migration適用は [`database.md`のローカル適用](database.md#ローカル適用)に従います。既存containerのdata確認、PostgreSQL 18のvolume境界、seed / 初期dataの説明もDatabase正本だけを更新します。

Survivor funnel KPI queryを開発・確認する場合は、保持不要なsynthetic dataだけを入れたlocal `*_test` DBを使用し、[`database.md`の専用手順](database.md#survivor-funnel-kpi-report)に従います。Report commandはmigrationやseedを行わず、Production / Staging、通常の開発DB、`DATABASE_URL`へ自動接続しません。境界fixtureは`TEST_DATABASE_URL`を設定したBackend integration testで検証します。

## 開発サーバー

Terminal 1でBackendを起動します。

```bash
source ./scripts/import-env.sh
cd backend
go run ./cmd/server
```

Terminal 2でFrontendを起動します。

```bash
pnpm --filter fukamu-cycle-frontend run dev
```

`http://localhost:5173` を開きます。Viteは `/api` を `http://localhost:8080` へproxyします。Frontend環境変数を変えたときはViteを再起動してください。

Go Backend単体の同一origin配信fallbackをローカルで確認する場合は、FrontendをbuildしてBackendへ静的assetsを渡します。Cloudflare StagingではWorkerがstatic assetsを配信します。

```bash
pnpm --filter fukamu-cycle-frontend run build
source ./scripts/import-env.sh
export PUBLIC_ORIGIN='http://localhost:8080'
export STATIC_DIR="$(realpath ./frontend/dist)"
cd backend
go run ./cmd/server
```

## 品質チェック

全チェックは次の1コマンドです。Frontend依存関係に加え、Backend checkにはHostのsqlc 1.31.1、Docker、Goのいずれかが必要です。Repository全体のcheckは完全なGit履歴と、scanner image・advisory database・固定Go toolを取得できるnetworkも必要です。

```bash
./scripts/check.sh
```

実行内容はFrontendのformat check、lint、typecheck、unit test、build、Backendのsqlc差分確認、gofmt、vet、test、server/migrate/cleanup/configcheck build、Bash syntax/ShellCheck 0.11.0/shfmt 3.13.1、文書・設定contract、security scan、Dockerローカル実機Composeの構文確認、Docker build context監査、Terraform 1.15.8 exactのformat/init/validate、Wrangler config/typecheck/dry-runです。Gate / CI control-planeの負例suiteは変更分類に応じて実行します。`go test ./...`は`kpireport` commandもcompileし、`TEST_DATABASE_URL`が未設定ならその実PostgreSQL integration testをskipします。Terraform validateは`.tmp/terraform-check`の専用`TF_DATA_DIR`とcredential不要の`backend=false` initializationを使い、localで初期化済みのR2 backend設定を再利用しません。

Frontend、Backend、Infrastructureだけを確認できます。

```bash
./scripts/check.sh --scope frontend
./scripts/check.sh --scope backend
./scripts/check.sh --scope infrastructure
```

改革や大規模整理の前後を同じ定義で比較する場合は、比較対象commitをそれぞれclean worktreeへcheckoutし、両方で`./scripts/setup.sh`とFrontend production buildを完了してから次を実行します。

```bash
node ./scripts/report-reform-metrics.mjs \
  --before-root /absolute/path/to/before-worktree \
  --after-root /absolute/path/to/after-worktree
```

このreportはtracked file、Frontend/Backend/SQL/Cloudflare/script/workflow/Terraform/documentのfile数とLF行数、dependency数、`go list -m all`のmodule graph、generated codeを除くproduction PostgreSQL call site、Frontend production assetのraw/gzip byteを同じ規則で比較します。入力worktreeにtracked/untracked差分がある場合、build assetがない場合、migration pairが不完全な場合はfail-closedです。`frontend/dist`、dependency directory、environment fileは計測結果へ含めず、出力にはcommit IDと集計値だけを含めます。

Docker build context監査だけを単独で実行する場合は、次を使います。

```bash
./scripts/check-docker-context.sh
```

この監査は一時directoryへ合成したbenign canaryをDocker Buildxでbuildし、環境file、依存directory、credential file、Terraform artifactがcontextへ入らないことを確認します。Repository内の実secret fileやその内容は読みません。

文書とconfiguration contractだけを確認する場合は、次を使います。

```bash
./scripts/check-docs.sh
./scripts/check-config-parity.sh
```

文書gateはRepository内のMarkdownについてfence、reference definition、実際にparseされたlink/image、local file/heading anchorを検査し、固定した`markdown-it` 15.0.0と`github-slugger` 2.0.0でCommonMark構文とGitHub heading anchorを解釈し、固定した`mermaid` 11.16.1でMermaid fenceを構文解析します。CommonMark上の未定義reference-like表記はlinkではなくliteralとして扱います。Markdown fileとlocal link pathのsymlinkは禁止し、外部URLはnetworkへ接続せず対象外にします。Configuration parity gateは[`deployment-contract.json`](../config/deployment-contract.json)を基準に、Backend typed config、canonicalなGo環境package importと直接環境参照の明示allowlist、`.env.example`、[`environment.md`](environment.md)、Worker/Container handoff、Wrangler、Frontendのproduction `import.meta.env` consumerと`VITE_DEPLOYMENT_ENV` build-config配線、deploy workflowのkeyと分類が一致することを検査します。Deployではresolve/CI確認からsecret cleanup・smoke testまでのjob/step列、migration-before-deploy、必要stepだけへのsecret公開も完全一致で検査します。

Gate / CI control-planeの負例suiteだけを現在の変更へ適用する場合は、次を使います。

```bash
./scripts/check-control-plane-fixtures.sh --working-tree
```

この分類器は`.github/`、`.fukamu/`、`scripts/`、`config/`、`infra/`、`cloudflare/`、package / lock / build / test設定など、gate、runtime infrastructure、判定方法を変え得るpathでは`full`を選び、`scripts/tests/run.sh`を実行します。既知のMarkdown、Frontend、Backendだけからなる変更は`docs`、`frontend`、`backend`、`application` unionへ分類し、この大規模な負例suiteを省略します。未知path、空の変更inventory、rename / copy / file type変更、100件超、非canonical path、SHA・Git object・ancestor関係・inventoryを確定できない場合は`full`へ倒します。Machine-readable結果だけが必要なconsumerは`--classify-only`を使用し、固定順の`change_profile` / `change_reason`以外を評価しません。

Security profileだけを実行する場合は、次を使います。

```bash
./scripts/check-security.sh --profile candidate
./scripts/check-security.sh --profile extended
./scripts/check-security.sh --profile full
```

既定の`full`は`candidate`と`extended`を順に実行します。`candidate`は全PRと全Commit candidateで、candidate tree / stage済みindexのpath・file type・secret、正規化secret view、Action / image pin、Node / Go immutable input policyを検査します。`extended`は`full` change、main release candidate、scheduled / manual auditで、全履歴inventoryと正規化secret view、Node advisory、到達可能なGo脆弱性、GoのHIGH/high-confidence静的所見、Terraform / production Dockerfile、実際にbuildしたproduction container imageを検査します。Profileを分けてもscanner errorやfindingを成功へ補正せず、main release securityはPR CI再利用時も省略しません。

Scannerはpnpm 11.22.0、Gitleaks 8.30.0、Trivy 0.73.0、Terraform 1.15.8のimageをdigestで固定し、`govulncheck` 1.7.0と`gosec` 2.29.0を固定します。Candidate snapshotはtrackedと非ignoreの通常fileだけから作成し、tracked+ignored path、symlink、special fileを拒否します。Candidate・index・全履歴はapproved ASCII path/type、UTF-8、control byte、1 objectあたり16 MiB、entry/manifest sizeの上限をfail-closedに検証し、全merge historyのblobに加えてcommit/tag本文、candidate/index/history path、ref名もpath/MIME skipを受けない正規化viewでscanします。既知の旧`backend/server.exe`はexact object/path/size、正規化viewのreview済み履歴blobはexact OID、Gitleaks例外はexact commit/path/rule/line fingerprintだけを許可し、globやrule単位の例外を拒否します。Gitleaks本体は`--max-target-megabytes=0`でfile size skipを無効化しますが、前段のapproved-text inventoryには前述の16 MiB/object境界があります。

Repositoryへ追加できるbinary assetは`frontend/src/assets/`直下以下の、stemを持つlowercase `.png`だけです。通常file・非実行mode、1 file 2 MiB以下、幅と高さが各4096以下、総pixel数16,777,216以下で、PNG signature / CRC / chunk順序 / compressed scanline、filter復元後のindexed pixelとpaletteの整合をnetworklessに検証します。1 inventoryでは検証済みunique PNG blobを512件、圧縮後合計64 MiB、展開後合計128 MiBまでに制限し、同じOIDの構造parseを繰り返しません。許可するancillary chunkは`cHRM` / `gAMA` / `sRGB` / `pHYs` / `tRNS`に限定し、サイズ・bit depthに応じたsample値・PLTE / IDATとの順序を検証します。Textual metadata、EXIF / ICC profile、APNG、未知chunk、末尾data、拡張子と内容の不一致、archive、実行file、credential-like fileは拒否します。検証済みPNG blobだけを正規化secret viewから除外し、同じOIDでない内容を拡張子だけでskipしません。新しいasset形式または配置先が必要な場合はallowlistと負例をreview付きで同時に更新します。

Repositoryを読むGit commandはambient環境とglobal/system configを除去し、pager、external diff/textconv、fsmonitor、untracked cache、hook、lazy fetch、replace/graft、alternate object store、include/worktree config、promisor/partial-cloneを無効化または拒否して、完全な自己完結object graphを検証します。Container内でGit metadataが必要な検査は、通常checkoutの`.git` directoryまたはlinked worktreeの`.git` pointer、`commondir`、backlinkを構造検証し、common Git directoryだけを固定pathへread-only mountして対象worktreeを明示します。`check.sh`がcompile確認用に生成する一時Go binaryは配布せず、linked worktreeでも未隔離のVCS commandを起動しないよう`-buildvcs=false`でbuildします。Node policyはroot `packageManager`、workspace/package/script集合、build許可、review済みのexact transitive override、lockfileのsemantic dependency graphとregistry-integrity形式をexactに照合し、lifecycle script、package patch、allowlist外または非exactなtransitive override、非registry source、非exact dependency、runtime selector、`.npmrc`、pnpm hook fileを実行前に拒否します。Goは`GOENV=off`、`GOWORK=off`、`GOTOOLCHAIN=local`、`-mod=readonly`とproduction同等の`CGO_ENABLED=0`、`GOOS=linux`で、workspace/vendor/replace/ignore/toolchain overrideを拒否します。Terraformはnetworkless lexerと固定Terraform parserで`.tf.json`、`.tfvars*`、`.terraform`、実module blockを拒否し、文字列・comment・heredoc内のdecoyは区別します。Archive展開と再帰decodeはreview済みの深度5へ固定し、archiveの深度超過・暗号化・解析error・size skipはgateを失敗させます。Decode深度6以上は検出保証外とする意図的なbounded policyで、深度変更には負例とsecurity reviewが必要です。Scanner・registry・advisory databaseの取得失敗、report schema不一致、解析不能、対象severityのfindingはいずれもgateを失敗させ、秘密値やsource snippetを含むraw reportは表示しません。一時image tagとscan用fileは終了時に削除します。

Registry packageが脆弱なtransitive dependencyをexact pinし、修正版を含む上流releaseがまだない場合だけ、`pnpm-workspace.yaml`の`overrides`でreview済みの親package・親version・対象dependencyに限定して修正版をexact pinできます。追加・変更時は対象edgeとversionをNode policyのallowlistおよびnegative fixtureへ同時に反映し、lockfile audit、依存元packageのtest / build / dry-run、全commit前gateを通します。上流が修正版を採用したらoverrideを削除し、通常のdependency graphへ戻します。

Gate内では、固定container imageがHostにない場合、そのimage refだけをcontainer registryへ問い合わせて取得することがあります。この前提runtime取得ではRepository内容を送信しません。`candidate`ではcandidate / indexのsecret scanをRepository由来のpackage/module metadataを送るcandidate commandより先に完了し、`extended`ではraw / normalizedの全履歴secret scanをadvisory lookup、scanner database/tool取得、production image buildより先に完了します。Node auditはregistryをCLIで`https://registry.npmjs.org/`へ固定してpnpm hookを無効化し、Go scannerも上記の隔離環境を使います。Git管理外でignore済みの`.env`やcredential fileは読みません。CI quality jobの依存導入は`--ignore-scripts`で行い、直後にtracked/index/untracked candidate treeが不変であることを確認してから各quality gateを実行します。`scripts/tests/check-security.sh`はsecret、asset、IaC、Node/Go vulnerability、Go static analysis、container vulnerabilityの負例を実行時に一時生成し、各scannerが期待classで失敗することとsecretが出力されないことを検証します。これらの重い負例はgate / control-plane変更または分類不能時のfull checkで実行されます。通常のapplication変更でもcandidate securityは省略しません。M25で導入したscanner/toolはここで固定します。既存GitHub Actionのcommit SHA、production base imageを含む全image digest、Dependabot更新経路の包括的な固定はM28の責務です。

Backend integration testには、消去してよい専用DBだけを指定してください。テストはschema内のapplication tableをdown/up migrationで作り直します。開発DBやproduction DBを指定してはいけません。

```bash
export TEST_DATABASE_URL='postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:5432/fukamu_cycle_test?sslmode=disable'
./scripts/check.sh --scope backend
```

E2Eも同じ専用DBを使います。安全のため、`TEST_DATABASE_URL`は`localhost`、`127.0.0.1`、`[::1]`のいずれかにある、名前が`_test`で終わるDBだけを受け付けます。初回のみChromiumを導入し、`--e2e` を付けます。Check scriptは`CI=true`を設定し、GitHub Actionsと同じPlaywright設定およびmigration/server起動経路を使い、終了時に子processを確実に停止します。

```bash
pnpm --filter fukamu-cycle-frontend exec playwright install chromium
export TEST_DATABASE_URL='postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:5432/fukamu_cycle_test?sslmode=disable'
./scripts/check.sh --e2e
```

Playwright自身の既定portは55432です。このリポジトリのDocker例は5432なので、上記のように `TEST_DATABASE_URL` を明示してください。E2EではGoogle Identity、Turnstile、OpenAIのtest doubleを使い、外部APIを呼びません。

### Staging pre-switch baseline / post-deploy critical journey

`./scripts/check-staging-critical.sh`は通常のlocal checkではありません。`Deploy Staging`は最初に`preflight`で現在配信中のStagingのhealth / readinessだけをblocking確認し、traffic切替とsmoke test後に`full`でcandidateのGoal / Cycle / Review / History journeyとcleanup proofをblocking確認します。

`baseline`は現在配信中Stagingのanonymous bootstrap、session discovery、公開account-delete、削除後401を確認するmanual / 別runのnon-blocking diagnosticです。検出した失敗はwarning annotationを出してprocessをnon-zero終了させますが、Deploy workflowへ接続しないためcandidate releaseをblockしません。Admissionは`auto`で、現在のUIが`off`ならNew Goalへ直接進み、`closed`なら招待fragmentをmemory上で消費して「利用を開始する」を選択できます。Stable CSRF初回rollout中の`Deploy Staging`では#139 harnessが同じanonymous / legacy Sessionを一度だけ所有します。同じrunner / IPでTurnstileやanonymous-create rate-limitを重複消費しないよう、generic `baseline`を自動実行しません。Manual diagnosticの失敗は候補releaseの成功証拠ではなく、#139 gateをwaiveしません。

`STAGING_BASE_URL`と`STAGING_CRITICAL_MODE`はstep scopeで渡し、`preflight`ではAdmission設定とInvite Tokenを渡しません。`baseline` / `full`だけ`STAGING_ADMISSION_MODE`を渡し、`auto` / `closed`の場合だけ`STAGING_E2E_INVITE_TOKEN`をGitHub `staging` Environmentから注入します。値を引数にはせず、`off`ではwrapperがInvite TokenをHarnessへ渡しません。HarnessはPlaywright test reporterを使わず、trace、screenshot、video、artifactを作らず、debug modeを無効化します。成功・失敗にかかわらず、検証済みsessionがあれば一時的なcleanup rediscovery失敗時にも公開account-delete APIを試行し、失敗はtarget / release mutation / cleanup stateを含むclosed-enum診断に残します。

Localから日常的に実行せず、Production originやProduction dataへ向けません。障害調査でOperations ownerが直接実行する場合も、承認済みsecret managerから環境へ注入し、shell history、process argument、terminal recordingへRaw Invite Tokenを残さず、[`operations.md`](operations.md#staging-critical-journey-cleanup)のcleanup確認まで完了させます。

### Stable CSRF initial rollout fixtures

初回rolloutのlive手順は[`operations.md`](operations.md#session-bound-stable-csrf-v1-release)を正本とし、LocalからStagingへ向けて実行しません。Cloudflare API、Browser process、fixed deploy child、safe evidence、同一runのbounded retryの境界は外部credentialを使わない次のfixtureで確認できます。Rollout / gate / control-planeに関係する変更では、上記分類器を通じて全体checkとCommit前gateにも含まれます。

```bash
node --test scripts/tests/cloudflare-drain-evidence.test.mjs
node --test scripts/tests/staging-csrf-rollout.test.mjs
node --test scripts/tests/staging-rollout-evidence.test.mjs
node --test scripts/tests/staging-deploy-retry-checkpoint.test.mjs
node --test scripts/tests/resolve-staging-deploy-retry.test.mjs
bash scripts/tests/check-staging-csrf-rollout.sh
bash scripts/tests/check-staging-candidate-deploy-and-drain.sh
```

`staging-deploy-retry-checkpoint.test.mjs`はmutation boundaryより前のcleanup state遷移、strict metadata / path / file検証と、`not_crossed`かつ`not_started|verified`の場合だけ`no_mutation_started` evidenceを生成することを確認します。`resolve-staging-deploy-retry.test.mjs`はfake GitHub responseを使い、同じrunのattempt 1が`completed` / `failure`であることと、candidate SHA / run IDへ束縛されたexact immutable Actions cache keyの解決を確認します。Workflow / rollout contract fixtureは、attempt 1が同じcheckpoint fileをaudit artifactとcacheへ保存し、attempt 2がfallbackなしのexact cache hitとstrict file検証を必須にすること、`Re-run all jobs`でresolverを再実行してcurrent main / CI / infraを再検証すること、fresh resolver outputのないpartial rerunとattempt 3、migration直前のmutation boundary以降または不明なstateをfail closedにすることを固定します。Browser fixtureはcanonical Staging originへhealth navigationしてからIndexedDBへbootstrap IDを保存する順序を固定します。これらのtestはGitHub、Cloudflare、Stagingへ接続せず、live credentialを使いません。

### Commit前の必須gate

Commitへ含める変更をすべてstageし、unstaged/untracked fileがない状態で次を実行します。この1コマンドは最初にcandidate securityを固定したstaged treeへ1回だけ実行し、treeを再確認してから同じstaged inventoryを保守的に分類します。`full`の場合だけ続けてextended securityを実行します。`docs`は文書、`frontend`は文書 + Frontend、`backend`は文書 + Backend / sqlc / 実PostgreSQL integration、`application`は両Application scope、`full`は全scope、Terraform / Wrangler、actionlint、CI resolver、Playwright E2Eを実行します。Frontend / Backendの通常local commitではPlaywright E2Eを重ねず、GitHub merge refのPR CIが所有します。CI再利用・権限model等の大規模negative fixtureはgate / control-plane変更または保守的に分類できない場合に実行します。

```bash
export TEST_DATABASE_URL='postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:5432/fukamu_cycle_test?sslmode=disable'
./scripts/check-before-commit.sh
```

`check-before-commit.sh`は開始時、candidate security直後、分類直後、必要なextended security直後、依存導入後、適用check後にindex / working tree / untracked fileを再確認し、固定したstaged treeからのdriftや誤操作をfail-closedに検出します。Security後は同じsource-only内部runnerを直接呼ぶため、profileを重複実行しません。このrunner単体は公開gateではなく、`check.sh`の公開CLIは従来どおりです。Local gateはworktreeとOS accountの分離を前提とし、同じOS userが検査の瞬間だけ悪意をもって内容を差し替える攻撃までは扱いません。このgateが成功しない限りcommitしてはいけません。成功後にindexまたはworking treeを変更した場合は、その変更をstageして全gateを再実行します。成功messageに表示されたstaged treeだけを、そのままcommitしてください。GitHub-hosted runner固有の障害はPR CIで検出し、Frontend / Backend変更のcross-stack E2Eはexact merge treeで必須とします。

### 性能変更の確認

DB-backed collection endpointは、page内のitem数に比例してSQL round tripが増えないよう、JOINまたはbatch queryで必要なsummaryを取得します。Home、Goal一覧、Cycle一覧を変更するときは、itemごとのdetail query（N+1 query）を追加してはいけません。

Frontendのroute別code splittingとasset sizeは`pnpm --filter fukamu-cycle-frontend run build`のchunk一覧で確認します。Mutation responseが遷移先と同じDTOを含む場合は、TanStack Query cacheへ反映してから遷移し、直後に同じresourceを再取得するnetwork round tripを避けます。Mutationの影響を受けるcollection/detail cacheは、引き続き明示的に更新またはinvalidateします。Auto SaveやAI提案Adoptも同じserver mutationとして扱い、成功responseをeditor local stateだけに反映しません。未保存入力はeditor/Browser Draft Cache、保存済みstateはTanStack Queryへ同期し、route往復の回帰testで古いfresh cacheが復元されないことを確認します。

### AI quality evaluation

AI qualityのcase group、rubric、release gateは [`design.md`](design.md) §49が唯一の仕様です。このsectionはRepository内の実行手順を所有します。

次のBackend checkは、中央Prompt Registryのversion解決、operation boundary、`backend/testdata/ai_eval`にある5 fixture groupとJSONLを決定的に検証します。Pathやfile名を変える場合は同じ変更でtest runnerを更新します。

```bash
./scripts/check.sh --scope backend
```

ModelまたはPrompt Versionを変更する前に、次を行います。

1. Prompt assetを新しいimmutable versionとして中央Registryへ追加し、旧versionを上書きしない。
2. 対象modelと正式単価を固定し、§49の全fixtureをStaging用credentialで実行する。Production dataや実User本文を使わない。
3. Structured Output、文字数、Action件数、禁止された捏造patternを自動確認する。
4. Human reviewerが§49のrubricで採点し、critical failureが0件であることを確認する。
5. Model、Prompt Version、実行日、latency、token、cost、採点結果をPull Requestへ添付する。Secretや不要なProvider response / User dataは添付しない。

外部credentialがないlocal / CIではProvider quality判定を行わず、Fake Adapter、schema validation、context isolation、quota / budget、error pathのdeterministic checksを実行します。

### GitHub Actionsの更新

Workflowで利用する公式Actionは、特別な互換性制約がない限り、Node.js runtimeとsecurity fixを含む最新のstable majorを使います。更新時は各Actionの公式release noteでbreaking changeとGitHub-hosted runnerの要件を確認し、`.github/workflows/ci.yml`のactionlintを通します。Stable majorを据え置く必要がある場合は、理由と解除条件を該当Workflowへcommentで記録します。

Pull request CIはGitHubのmerge refをcheckoutし、base SHAからそのexact treeまでを`docs` / `frontend` / `backend` / `application` / `full`へ分類します。成功時はPR番号、head SHA、検証commit、検証tree SHA、workflow run ID、change profile、canonical required job listの7項目だけを含むattestationを30日保持のartifactへ保存します。mainの`CI` workflowは、マージ後commitに対応するPR、同一head SHAの成功したPR CI、変更fileから独立に再分類したprofile、適用jobの`success` / 非適用jobの`skipped`、required aggregatorとattestationの成功、exact nameの未期限切れartifact 1件、検証済みtreeとmain treeの完全一致を確認できた場合だけ重いjobをskipします。PR workflow runの関連PRが非空なら対象PR番号だけのexact listを要求します。Head branch自動削除後などに関連PRが空の場合だけhead commitの関連PRを追加照会し、対象PRが唯一で、merge commit、head SHA/ref、base branchまで一致した場合に限り後続の検証へ進みます。Artifactは展開せず、archive全体を16 KiB以下、compressionをstoredまたはdeflate、entryをregular fileの`attestation.txt` 1個、payloadを4 KiB以下へ制限し、実sizeとCRCを照合します。判定job自体がmain SHAの成功CIとなるため、Terraform PlanとDeployの同一SHA gateは維持されます。

PRのquality jobは非`full` profileでcandidate securityだけを実行し、`full` profileではfull securityを実行します。Control-plane negative fixtureは、完全履歴を持つclassifierが`full`と確定した場合だけquality jobで実行し、shallow checkout上でcommit rangeを再分類しません。Main pushの`Release security` jobはPR CI再利用の成否から独立してexact main SHAのfull securityを実行します。`.github/workflows/security-audit.yml`は毎週およびmanual dispatchで同じfull profileを実行し、scheduled runが`success`以外なら固定titleのIssueを作成するか既存Issueへsafe run URLを追記します。Raw finding、secret、repository contentをIssueへ転記しません。Auditはmainから開始したattempt 1だけを受け入れ、full scan後にもaudited SHAがcurrent mainであることを再検証します。Scheduled runがfailure、cancel、timeout等の非成功で完了した後は`.github/scripts/verify-security-audit-release-gate.sh <COMMIT_SHA>`が、release対象がcurrent mainであり、そのrunより後に同じworkflow / repository / mainでscheduledまたはmanualのfull auditが成功したことをGitHub APIのlatest stateから確認するまでTerraform Plan / Apply / Deployを停止します。一度復旧した後の新しいcommitはmain `Release security`で検証し、commitごとの追加auditは要求しません。API failure、schemaの曖昧さ、Issueのclose、失敗runのRe-runは解除条件にしません。

CI全体の既定権限は`contents: read`だけです。GitHub APIで再利用可否を判定するmain push専用jobだけに`actions: read`と`pull-requests: read`を追加し、Pull requestのcodeを実行するjobへ渡しません。全checkoutはcredential永続化を無効にし、Git全履歴が必要なclassifier、`full` profileのquality、mainの`Release security`、scheduled / manualの`Security audit`だけ`fetch-depth: 0`を指定します。Classifier成功後、profileへ適用されるfunctional jobを並列開始します。`Required PR CI`は全functional jobを待ち、適用jobが`success`、非適用jobが`skipped`であるexact matrixを検証します。`Attest tested PR tree`はこのaggregator成功後だけ検証済みtreeを証明するため、個別contextをskipしてもrequired判定を欠落させません。全CI jobとDeployのdependency installはlifecycle scriptを無効化し、直後のtracked/index/untracked tree不変確認を通過してから候補commandを実行します。Fixtureはworkflow全体の表示名・全field・全step inventoryを固定せず、trigger、permission、checkout credential / source、`needs` / `if`、必須のfail-closed command、release mutation前の実行順を意味的に検証します。無害な説明stepや表示名変更は許容し、step skip、failure許容shell、`BASH_ENV`、self-hosted差替えは拒否します。この権限・依存関係は`./scripts/tests/check-ci-security-model.sh`の破壊fixtureで固定します。

Manual Terraform PlanとDeployはAPI応答のschemaと非paginationをfail-closedに確認し、同一repository・main・commitのexactな`CI` workflow path/nameを持つcompleted/success `push` runだけを受け入れます。Planはdetailed exit codeを`no_changes`または`changes_present`へ分類し、commit、run、saved Plan checksumを証跡へ束縛します。Deployはexact-current-mainの`no_changes` Plan証跡、または`changes_present` Planから生成されたApply証跡だけを受け入れ、変更ありPlanの直接Deployを拒否します。No-changeではApply Environment、Apply credential inventory、state snapshot / restore drillを実行しません。PR run、forkの`main` branch、別workflow、曖昧または101件以上の応答は成功CIまたはinfra evidenceとして扱いません。

直接push、複数・不明な関連PR、空のrun関連PRをhead commitから対象PRへ一意に補強できない場合、base更新後にPR CIを再実行せずmergeした場合、API障害・schemaや件数の曖昧さ、artifact欠落・期限切れ・重複・破損、job不一致、tree不一致では再利用せず、mainで全CIを実行します。PRの変更fileを100件以内で全件照合できない場合もfallbackします。また`.github/`、`.fukamu/playbook/`、`scripts/`、package/workspace manifestとlockfile、test・lint・build設定、secret scanやconfiguration gateのpolicy fileなどCIの信頼境界自体を変更したPRは、attestationがあっても再利用せずmainの新しい制御面で全CIを実行します。そのためresolver自身を変更したmerge直後はfull CIが正しく、再利用経路の実運用確認は後続の非control-plane PRで行います。高速化のためにこのfail-safe fallbackやtree完全一致を緩和してはいけません。

## 開発時troubleshooting

まず秘密値を貼らず、実行command、exit code、対象環境、直前変更、固定`error_class` / `error_code`を記録します。Database固有の症状は [`database.md`のtroubleshooting](database.md#database-troubleshooting)、Staging / Productionは [`operations.md`のCloud troubleshooting](operations.md#cloud-troubleshooting)へ進みます。

### Setup / dependency install

| Symptom | Check | Response |
|---|---|---|
| `go`が見つからない、またはsetupがversionで停止 | `command -v go`; `go env GOVERSION` | [前提環境](#前提環境)のGoへ合わせてterminalを開き直す。Version guardを外さない |
| `pnpm install`失敗 | Node / pnpm version、最初のpnpm error | Lockfileを手編集せず標準versionへ合わせる。必要な場合だけ`clean.sh --all`後にsetupを再実行 |
| 同名PostgreSQL container error | `docker ps -a --filter name=fukamu-cycle-postgres` | 停止中ならimageを確認してstartする。保持data確認前にremoveしない |
| Bash versionで停止 | `bash --version`; `command -v bash` | Bash 5以上のUbuntu / WSL2で実行する |
| Docker profileがremote contextを拒否 | `docker context inspect` | Local Docker contextへ戻す。Safety guardを削除しない |

### Development server / build

| Symptom | Check | Response |
|---|---|---|
| Backendが`invalid configuration`で終了 | Errorのkey名、現在terminalでenvをimportしたか | `source ./scripts/import-env.sh`後、[`environment.md`](environment.md)に従ってlocal値を修正 |
| OTLP設定で終了 | Errorのkey名だけを確認 | Local / Testではendpoint / headerを空にし、未承認`OTEL_*`をprocessから除く。Header値を表示しない |
| Port 8080 / 5173が使用中 | `ss --tcp --listening --numeric --process` | 所有processを確認して停止する。無関係なprocessをkillしない |
| FrontendからAPI 404 / connection refused | Browser Network、local `/healthz` | Backendを起動し、開発時はVite originを使う |
| Go static fallbackが404 | `frontend/dist/index.html`と`STATIC_DIR` | Frontendをbuildし、absolute `STATIC_DIR`でBackendを再起動 |
| Frontend build / typecheck失敗 | `./scripts/check.sh --scope frontend` | 最初のerrorを修正する。Stale dependencyならfull clean後にsetup |
| Format / lintだけ失敗 | Frontend format check / lint | Formatterを実行して差分をreviewし、lint errorを個別修正 |
| Docker実機profileがreadyにならない | Compose logsの最初のerror | `./scripts/local-app.sh --down`で専用resourceだけを片付けて再実行 |

### Test / E2E

| Symptom | Check | Response |
|---|---|---|
| Go integration testがskip | `TEST_DATABASE_URL`の有無 | 消去可能な`*_test` DBだけを設定する |
| E2EがDBへ接続できない | Docker published portとURL | Playwright既定portへ依存せず`TEST_DATABASE_URL`を明示する |
| E2EがGoを起動できない | `command -v go`、optional binary path | 標準Goを使うか、実在するprebuilt binaryを指定する |
| Prebuilt serverでreadiness失敗 | Test DBのmigration version | Prebuilt server指定時は破棄可能DBへmigrationを先に適用する |
| Chromiumがない | Browser executable error | `pnpm --filter fukamu-cycle-frontend exec playwright install chromium` |
| CIだけ不安定 | Job logとPlaywright artifact | Worker 1を維持して根因を修正し、retry増加だけで隠さない |

### Local authentication / AI

| Symptom | Check | Response |
|---|---|---|
| Google buttonが出ない / login失敗 | Public client ID、origin、Browser Network | Frontend / Backendのclient IDとauthorized originを合わせる。Secretは使わない |
| Login後にsessionがない | Cookie属性、origin、server error code | `PUBLIC_ORIGIN`と実originを一致させる |
| Anonymous session作成失敗 | Turnstile site / secret、hostname / action | 対応値を揃え、期限切れtokenを再利用しない。Productionで無効化しない |
| Local AIが外部APIを呼ばない | `APP_ENV`とkeyの有無だけを確認 | Keyが空のdevelopment / testは仕様どおりFake。通常testでは外部keyを設定しない |
| AI model / Prompt候補の品質確認 | [AI quality evaluation](#ai-quality-evaluation) | Deterministic gateとreviewer rubricを通し、Production dataを使わない |

## クリーンアップ

通常のsafe cleanは再生成できるbuild/test出力と `.tmp` だけを削除します。対象を事前確認するには `--dry-run` を使えます。

```bash
./scripts/clean.sh --dry-run
./scripts/clean.sh
```

依存関係も消すfull cleanです。次回は `scripts/setup.sh` または `pnpm install --frozen-lockfile` が必要です。

```bash
./scripts/clean.sh --all
```

どちらも `.env`、`frontend/.env.local`、DB、Docker container/volume、ブラウザのIndexedDB、Goのglobal cacheを削除しません。通常cleanとデータ削除は意図的に分離しています。

ローカルDocker DBの全データを捨てる場合だけ、[`database.md`](database.md) の警告を確認して専用reset scriptを使ってください。このscriptはproduction URLを受け付けず、remote Docker contextも拒否します。

```bash
./scripts/reset-local-db.sh --database-name fukamu_cycle --confirm-database-name fukamu_cycle --dry-run
./scripts/reset-local-db.sh --database-name fukamu_cycle --confirm-database-name fukamu_cycle --yes
```

## 開発終了時

各serverを `Ctrl+C` で停止します。BackendはHTTP requestをdrainした後にin-memory trace / metric providerをflushします。Docker DBも止める場合は `docker stop fukamu-cycle-postgres` を実行します。containerをstopしてもDBデータは保持されます。

解決しないlocal問題は上の切り分け結果と最初のerrorを共有し、仕様判断が必要なら [`design.md`](design.md) を確認します。Cloud resourceやProduction dataへ試行錯誤の変更を加えません。
