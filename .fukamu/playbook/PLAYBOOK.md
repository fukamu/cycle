# FUKAMU Product Engineering Playbook

Version: 0.1.0

この文書は、FUKAMUプロダクトの進行・協業・実装・検証・リリースに共通する規範Source of Truthです。プロダクト固有の仕様、技術選定、運用値、検証コマンドはconsumerリポジトリが所有します。

## 規範の読み方

`MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT`、`MAY`を規範語として使います。

- `MUST` / `MUST NOT`: 適用条件を満たす場合の必須事項。`override: approved`だけが期限付きの正式な例外を許します。
- `SHOULD` / `SHOULD NOT`: 通常従う事項。逸脱時は理由、影響、再訪条件を作業記録へ残します。
- `MAY`: 任意の選択肢です。
- `override: never`: consumerはこの規則を弱められません。
- `override: approved`: `overrides.json`にscope、理由、緩和策、owner、承認URL、期限を記録した場合だけ、`MUST` / `MUST NOT`を一時的に弱められます。

より厳しいローカル規則は自由に追加できます。非該当の規則は無理に適用せず、判断に影響する場合だけ`N/A — 理由`を記録します。

## 1. Source of Truthと変更統治

### PE-SOT-001 — 一つの責任には一つの正本を置く
`MUST` · override: `never`

一つの概念、規則、運用値には唯一のcanonical ownerを定めます。README、Issue、Project、PR、ADR、code、testは、ownerでない意味を再定義せず正本へ参照を張ります。

検証: 文書責任表または`AGENTS.md`からownerを特定でき、競合する定義がないことをreviewします。

### PE-SOT-002 — 変更影響を分類してownerから更新する
`MUST` · override: `never`

変更前に「既存仕様内」「仕様変更」「Discoveryのみ」を分類します。仕様変更では、影響するProduct、Domain、Data、API、UI、AI、Security、Privacy、Operations、Testのownerを、実装より前または同じatomic PRで更新します。

検証: Issue/PRが分類、affected owners、理由、受入条件を示し、該当する正本差分を含むことをreviewします。

### PE-SOT-003 — 正本は現在形を保つ
`MUST` · override: `approved`

canonical docsは現在有効な状態を記述します。検討経緯、過去状態、進捗、判断ログはCommit、PR、ExecPlan、必要なADRへ置き、正本をchangelogにしません。

検証: 廃止済みの複数案が現行仕様として残らず、履歴への参照だけが必要に応じて存在することをreviewします。

### PE-SOT-004 — 重大な矛盾を推測で埋めない
`MUST NOT` · override: `never`

矛盾、security/privacy/data retention/auth/permission/production上の重要な未決事項、または影響範囲不明を、実装者の推測やexample/defaultで埋めてはいけません。該当変更を停止し、関連規則、問題、影響、選択肢、必要なowner判断を報告します。無関係で安全な作業は継続できます。

検証: blocker記録に停止範囲とunblock条件があり、未承認値がproduction設定へ流入していないことをreviewします。

## 2. プロジェクト進行

### PE-PRJ-001 — 成果とguardrailで計画する
`MUST` · override: `approved`

InitiativeとPhaseはfeature数ではなく、user outcome、観測可能なsuccess signal、守るべきguardrail、exit criteriaで定義します。日付が未確定なら偽の期限を置かず、priority、effort、risk、dependency、利用可能capacityでrolling-wave計画を行います。

検証: charterまたはEpicにoutcome、signal、guardrail、exit criteriaがあることをreviewします。

### PE-PRJ-002 — Projectを制御面として使う
`MUST` · override: `approved`

GitHub Project等の管理面はStatus、Priority、Phase、Risk、Decision、WIPを所有し、正式なプロダクト仕様を所有しません。Issueは問題、価値、scope、acceptance、dependency、検証計画を所有し、正本を上書きしません。

検証: Project/Issueだけに存在する恒久仕様がないことをreviewします。

### PE-PRJ-003 — priority、risk、effortを分離し低いWIPを守る
`MUST` · override: `approved`

必要性を示すPriority、失敗影響と不確実性を示すRisk、大きさを示すEffortを別々に評価します。チームは明示した小さなIn Progress上限を守り、BlockedもWIPに数えます。High Riskはpriorityに関係なくDiscoveryやcharacterizationで早く不確実性を下げます。

検証: Project fieldとWIP policyが分離され、超過時にowner、理由、解消予定があることをreviewします。

### PE-PRJ-004 — Definition of Readyを満たしてpullする
`MUST` · override: `approved`

実装を始める前に、適用可能なUser/Problem/Value、success signal、guardrail、scope、non-goal、acceptance、dependency、priority、effort、risk、仕様影響、affected owners、data/privacy/AI/retention影響、owner、validation environmentを確認します。Discoveryではproduction acceptanceの代わりに仮説、必要証拠、判断期限を定めます。

検証: Issueに各項目または`N/A — 理由`があり、未決のblockerが隠されていないことをreviewします。

### PE-PRJ-005 — blockerを観測可能にする
`MUST` · override: `approved`

Blocked作業には依存先、理由、unblock条件、owner、次回確認日を記録します。状態名だけで放置せず、別の安全な作業をpullできるか判断します。

検証: Blocked itemを第三者が再開またはescalateできる情報が揃っていることをreviewします。

### PE-PRJ-006 — gateを証拠で閉じる
`MUST` · override: `never`

Phase、milestone、IssueをDoneにする前に、acceptance、正本同期、適用されるtest/CI、security/privacy、migration、release/recovery、残存risk、Project同期を同じcandidateに対する証拠で確認します。未実行check、承認待ち、未決値、残存blockerをDoneとして扱いません。

検証: 完了記録が実行結果と未完了事項を明示し、Phase exitがP0とexit criteriaを満たすことをreviewします。

## 3. Gitと並行作業

### PE-WRK-001 — 既存作業を保護する
`MUST` · override: `never`

開始時にrepository、branch、worktree、`git status`、関連するcode/config/test/docs、既存Issue/PRを確認します。他者や別processの未commit変更を削除、上書き、混入、無断移動してはいけません。

検証: 作業記録とdiffから、開始baseと変更ownerを特定できることをreviewします。

### PE-WRK-002 — 作業ごとに専用branchと専用worktreeを使う
`MUST` · override: `never`

git repositoryのファイルを変更する作業は、最新の適切なbaseから作成した専用branchと専用git worktreeで行います。共有checkout、他processのworktree、`main`を直接変更しません。複数の実装案を並行して作る場合も、案ごとにbranch/worktreeを分離します。

検証: PR head branchと作業worktreeが専用であり、共有checkoutがcleanであることを確認します。

### PE-WRK-003 — 変更をreversibleな責任単位にする
`MUST` · override: `approved`

原則として一つのIssueを一つのbranch、worktree、atomic PRで完結させます。codeだけでなく必要なdocs、migration、generated output、test、recovery情報を同じ責任単位に含め、無関係な差分を混ぜません。

検証: PRの目的を一文で説明でき、独立してreview/revertできることを確認します。

### PE-WRK-004 — 共有履歴を書き換えない
`MUST NOT` · override: `never`

他者が参照し得るbranchをforce push、rebaseによる履歴置換、破壊的resetで書き換えてはいけません。必要な修正は追加commitまたは合意済みの安全な更新として行います。

検証: remote historyとPR eventを確認し、既存commitが無断で消えていないことをreviewします。

### PE-WRK-005 — commit候補そのものを検証する
`MUST` · override: `never`

commit前gateがあるrepositoryでは、候補差分をすべてstageし、想定外のunstaged/untrackedがない同一treeへ全gateを実行します。check、生成、依存導入、修正でtreeが変わった場合は、再stageして全gateを再実行し、成功したtreeを変えずにcommitします。

検証: gateがcandidate treeを識別し、成功後のdriftを拒否することを自動またはreviewで確認します。

### PE-WRK-006 — 生成物を手編集しない
`MUST NOT` · override: `never`

generated fileを直接編集してはいけません。生成元を変更し、生成物を同じcommitに含め、再生成によるdriftをCIで拒否します。

検証: generator実行後の差分がなく、生成元から結果を再現できることを確認します。

## 4. 品質と検証

### PE-TST-001 — riskに比例した層で検証する
`MUST` · override: `approved`

変更に応じてformat、lint/static analysis、typecheck、unit、integration/component、build、E2E、security、documentation、configuration、infrastructure dry-runから必要な層を選びます。開発中の部分checkだけでcommit/release gateを代替しません。

検証: PRが実行した層、非該当理由、結果を列挙し、riskに対して不足がないことをreviewします。

### PE-TST-002 — testを仕様のconsumerにする
`MUST` · override: `never`

testはcanonical behaviorを機械的に検証し、独自のプロダクト仕様を作りません。正本とtestが矛盾する場合は正本ownerの判断を得て、正本、実装、testを同じ変更で整合させます。

検証: acceptanceからtestへのtraceがあり、fixture内だけに隠れた要件がないことをreviewします。

### PE-TST-003 — 決定的で隔離されたtestを使う
`MUST` · override: `never`

通常の必須CIでは、Clock、ID、乱数、外部API等をfake可能なboundaryにし、任意のsleepやlive provider responseに依存しないtestを作ります。DB testは明示的に破棄可能な隔離DBだけを使い、shared/production dataを拒否します。明示的なlive contract/evaluationは別の隔離jobとして扱い、この決定的なgateを代替しません。

検証: network/credentialなしで再現でき、対象environmentへのguardがfail closedすることを確認します。

### PE-TST-004 — 失敗や未実行を成功扱いしない
`MUST NOT` · override: `never`

scanner取得失敗、解析不能、曖昧なAPI response、test未実行、承認待ちを成功として扱ってはいけません。安全を判定できないgateはfail closedし、未完了として報告します。

検証: error pathとinvalid fixtureがpipelineを失敗させることをtestします。

## 5. Security、privacy、supply chain

### PE-SEC-001 — secretとprivate dataを成果物へ入れない
`MUST NOT` · override: `never`

secret、credential、private key、access token、production data、不要な個人データをcommit、Issue、PR、文書、fixture、command argument、log、telemetryへ含めてはいけません。露出を疑った場合は値を再掲せず、漏えい対応へ移ります。

検証: secret scan、fixture review、log/telemetry allowlistで確認します。

### PE-SEC-002 — 最小権限と短いcredential scopeを使う
`MUST` · override: `never`

CI、runtime、migration、operatorの権限とcredentialを責任ごとに分離し、既定をread-onlyにします。checkout credentialを不要に永続化せず、secretは必要なstepだけへ渡し、一時fileを確実にcleanupします。

検証: workflow permissions、service role、secret injection scopeをreviewします。

### PE-SEC-003 — 外部依存を再現可能な値へ固定する
`MUST` · override: `never`

toolchain、package、GitHub Action、container等の実行可能な外部依存をlockfile、digest、完全なcommit SHA等へpinします。incident対応でpinを外さず、review済みversionへ更新またはrevertし、candidate tree不変を検査します。

検証: floating referenceがなく、更新PRにrelease note確認と全gate結果があることを確認します。

### PE-SEC-004 — 観測データをallowlistと最小化で設計する
`MUST` · override: `never`

log、metric、trace、analyticsには必要な低cardinality項目だけをallowlistし、raw user content、token、provider response、安定した個人識別子を既定で収集しません。

検証: telemetry schema、sample、retention、access scopeをprivacy reviewします。

## 6. Dataとmigration

### PE-DAT-001 — environmentとdataを隔離する
`MUST` · override: `never`

development、test、staging、productionはresource、data、credentialを分離します。production dataをlower environmentへcopyせず、stagingをproductionや匿名化済みproduction dataの代用とみなしません。

検証: environment mapping、credential、data source、guardをreviewします。

### PE-DAT-002 — migration-firstとexpand-contractを使う
`MUST` · override: `never`

schema変更はtraffic切替より先に適用し、失敗したらapplication deployへ進みません。後方非互換変更はexpand、application切替、contractを互換性のある複数releaseへ分けます。既存migrationを共有後に書き換えず、forward-onlyの新規migrationを追加します。

検証: compatibility matrix、migration order、旧/新codeの動作、forward fixを確認します。

### PE-DAT-003 — 安全なcleanとdata deletionを分離する
`MUST` · override: `never`

derived outputのcleanupとDB/resource/user dataの削除を同じcommandや曖昧なoptionで扱いません。破壊操作はexact target、dry-run、backup/recovery、明示承認、実行記録を備えます。検証のためにproduction/shared dataをresetしません。

検証: destructive pathがdefaultで実行されず、対象と復旧方法を事前確認できることをtestします。

### PE-DAT-004 — retentionと法的意味を運用都合で変えない
`MUST NOT` · override: `never`

retention、deletion、consent、legal holdの意味を、backup復旧、debug、実装簡略化、incident対応の都合で変更してはいけません。法的に削除されたdataをbackupから復活させません。

検証: data lifecycle、backup policy、restore procedureの整合をprivacy/security ownerがreviewします。

## 7. Releaseとoperations

### PE-REL-001 — exact revisionを一貫して届ける
`MUST` · override: `never`

releaseはexact main commitの成功CI、review済みartifact/plan、承認、同じrevisionのdeployを追跡可能なchainにします。検証したtreeとdeployするtreeの同一性を証明できない場合は、deploy対象で全gateを再実行します。

検証: release recordからcommit、CI、artifact/plan、approver、deployment、migrationを追跡できることを確認します。

### PE-REL-002 — planとapplyを分離して直列化する
`MUST` · override: `never`

infrastructure変更はreview済みsaved planをそのままapplyし、head、state、入力が変わった場合は再planします。plan/applyを対象environmentごとに直列化し、apply前に必要なbackupと隔離restore drillを成功させます。

検証: stale planと異なるrevisionのapplyが拒否されることをtestします。

### PE-REL-003 — healthだけでrelease成功としない
`MUST NOT` · override: `never`

process health/readinessだけでrelease成功としてはいけません。代表的なcritical user journey、cleanup、privacy-safe logs/metrics、resource limit/costを検証し、失敗時の判断を記録します。

検証: post-deploy checklistがプロダクト固有journeyと結果を含むことをreviewします。

### PE-REL-004 — schema互換性に基づいてrollbackする
`MUST` · override: `never`

旧codeと現schemaに互換性がある場合だけ直前の成功versionへrollbackします。互換性を証明できない場合はforward fixを選び、deploy失敗だけを理由にmigrationを自動downしません。

検証: rollback matrixとrecovery rehearsalでcode/schema組合せを確認します。

### PE-OPS-001 — 未承認のproduction値をblockerにする
`MUST` · override: `never`

capacity、backup、retention、alert、owner、public endpoint等のproduction値が未決なら、example/defaultから推測せずrelease blockerとしてowner判断を求めます。live値はaccess-controlledな正本が所有します。

検証: release readinessが未決値を列挙し、sample値の流用を拒否することを確認します。

### PE-OPS-002 — incidentでは影響停止と証拠保全を優先する
`MUST` · override: `never`

incidentでは新規deployを止め、incident leadを定め、security/data lossを評価し、最小の影響停止策を適用して検証します。時系列、判断、回復、follow-upを機密情報なしでpostmortemへ残します。

検証: runbookとincident記録がowner、impact、mitigation、verification、follow-upを含むことをreviewします。

## 8. AI-assisted features

### PE-AIF-001 — AIの役割を明示しuser authorityを守る
`MUST` · override: `never`

AIが生成、変更、判断支援する範囲をプロダクトの正本で明示します。重要な変更を無断で確定せず、userまたは責任を持つhuman reviewerが出力を識別、検査、拒否、修正、取り消しできる境界を持たせます。AIが補助機能ならAIなしのcritical journeyを保ち、AI-nativeならunavailable/degraded時の安全で誤解を招かない挙動を定義します。

検証: プロダクトでのAIの役割に応じ、non-AI journeyまたはdegraded behaviorと、accept/reject/recoveryをE2Eで確認します。

### PE-AIF-002 — model、prompt、評価条件をversion化する
`MUST` · override: `never`

AI behaviorへ影響するmodel、prompt、tool contract、fixture、rubricをimmutable versionとして追跡します。通常testだけで品質を保証せず、定量check、人間review、critical failure、latency、token/costをrelease evidenceに含めます。

検証: evaluation recordからversion、日付、fixture、rubric、結果、reviewerを再現できることを確認します。

### PE-AIF-003 — AI testへ実dataとlive dependencyを持ち込まない
`MUST NOT` · override: `never`

production/user dataをAI fixtureへ入れず、通常の必須CIをlive model credentialや非決定的responseへ依存させません。構造、権限、fallbackはdeterministic fakeで検証し、live evaluationは別の明示的な隔離jobとして実行します。

検証: credentialなしのCIと、synthetic/de-identified fixture reviewで確認します。

### PE-AIF-004 — provider failureをcoreから分離する
`MUST` · override: `never`

provider outage、timeout、quota、unsafe/invalid outputが既存dataや無関係な機能を破壊しないようにします。timeout、budget、validation、明示的なfailure/degraded state、必要に応じたfallbackやcircuit breakerを設けます。

検証: provider failure matrixでdata integrity、影響範囲、degraded behavior、user feedbackを確認します。

## 変更手続き

規則の追加・変更・削除では、理由、consumer影響、移行方法、検証結果をPRへ記録し、`VERSION`と`CHANGELOG.md`を同じPRで更新します。既存IDの意味を変えて既存consumerの解釈を黙って変えてはいけません。consumerは新revisionをreviewし、vendored bundleとlockを更新するまで旧revisionに従います。
