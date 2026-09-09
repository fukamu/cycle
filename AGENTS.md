# FUKAMU Cycle repository instructions

このfileはrepository全体に適用します。

## FUKAMU Product Engineering Playbook

Repositoryを変更する前に、このfileを入口として次の順に確認します。

1. [vendored Product Engineering Playbook](.fukamu/playbook/PLAYBOOK.md)
2. [local override一覧](.fukamu/playbook/overrides.json)
3. [adoption lock](.fukamu/playbook/lock.json)と[local trace config](.fukamu/playbook/config.json)
4. 下記のCycle固有Source of Truth

採用version、40桁revision、署名者fingerprint、vendored bytesのSHA-256は[lock](.fukamu/playbook/lock.json)、全rule IDからCycleの既存consumerへのrelation・正確なsection traceとowner境界は[config](.fukamu/playbook/config.json)に固定します。Playbookはプロダクトを問わない進行・協業・品質・安全・releaseの方法を所有し、`docs/design.md`はCycle固有のProduct / Application contract、専門文書はCycle固有のprocedureとEnvironment値を所有します。`overrides.json`は空であり、Cycleはv0.1.0を例外なく採用します。

Vendored `PLAYBOOK.md`と`validate.py`を手編集しません。更新時は同じ中央source revisionから両方を置換し、lock、overrides、config trace、影響するlocal consumerを同じPull Requestで整合し、[`docs/development.md`](docs/development.md#product-engineering-playbookの検証更新)のsource-backed検証を完走します。

Playbookの`PE-WRK-002`に従い、git repositoryのfileを変更する作業は、最新の適切なbaseから作成した作業専用branchと作業専用git worktreeで行います。共有checkout、`main`、他processのworktreeを直接変更しません。

複数作業の変更範囲、仕様owner、依存関係が十分に独立している場合は、各作業を開始する時点の最新`main`からそれぞれ専用branch / worktreeを作成し、先行Pull Requestのmergeを待たずに並行してよいものとします。後から`main`が進んだ場合は、各Pull Requestのmerge前に最新`main`との差分と意味上の競合を確認し、必要な統合・競合解消後に適用されるgateを再実行します。変更範囲または仕様判断が重なる作業や、先行作業の結果へ依存する作業は並行着手せず、先行作業を統合した最新`main`から開始します。共有済み履歴のrebase / force pushは`PE-WRK-004`に従い行いません。

## Source of Truth

Cycle固有のアプリケーション要件・仕様・設計の最上位Source of Truthは [`docs/design.md`](docs/design.md) です。実装都合で仕様を変更してはいけません。共通の作業方法は上記Playbookを正とし、Cycle固有contractと責任範囲を重ねません。

| テーマ                                              | 参照先                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Repository入口                                      | [`README.md`](README.md)                                     |
| Local development / checks / research / clean        | [`docs/development.md`](docs/development.md)                 |
| Environment variables                               | [`docs/environment.md`](docs/environment.md)                 |
| Database / Migration                                 | [`docs/database.md`](docs/database.md)                       |
| Cloud deployment / operations / troubleshooting     | [`docs/operations.md`](docs/operations.md)                   |
| Temporary Closed Beta admission                     | [`docs/closed-beta-admission.md`](docs/closed-beta-admission.md) |

同じruleを複数文書へcopyせず、専門のSource of Truthへlinkしてください。

## Directory responsibilities

- `frontend/`: React SPA、browser state、API DTO validation、Vitest / Playwright。
- `backend/`: GoのDomain / Application / HTTP / Infrastructure、SQL query、Migration。
- `cloudflare/`: Static Assets配信、Container routing、Wrangler bindings。
- `infra/terraform/`: Terraformが所有するCloudflare基盤resource。Wrangler所有resourceと二重管理しない。
- `scripts/`: Local setup、check、safe clean、明示確認付きlocal DB reset。
- `.github/workflows/`: CI、saved Terraform plan/apply、migration-first deploy。

## 仕様変更と停止条件

- 仕様へ影響する変更では、実装前に `docs/design.md` の関連sectionと全体整合性を確認し、恒久的な仕様変更なら更新要否を判断する。
- 既存仕様の意味を変える恒久的な仕様変更は、Product Ownerが理由・影響・選択肢を明示して承認した場合に限り、`docs/design.md`のcanonical ownerをcodeより前または同一Pull Requestで更新できる。承認前は該当変更を停止する。
- 既存仕様の意味を変えない整合修正は、他sectionと矛盾せず、影響範囲を確認できる場合だけ`docs/design.md`を更新できる。
- 実装に合わせるため、矛盾を隠すため、または不明確な仕様を推測で確定するために `docs/design.md` を変更しない。

## 作業規則

- すべてのrepository変更で`PE-WRK-002`の専用branch / worktree境界を維持する。
- Secret、credential、private key、production dataをcommit・log・文書・test fixtureへ入れない。Clientへ出せるのは明示された`VITE_`公開値だけ。
- `.env`をBackendが暗黙loadする前提にしない。Local Bashでは `source ./scripts/import-env.sh` を使う。
- 通常cleanとdata削除を分離する。`scripts/clean.sh`へDB、Docker volume、environment file、browser dataの削除を追加しない。
- Production DB reset/down/drop、production deploy、secret変更、data correctionを検証目的で実行しない。
- 未リリース・空DB・既存環境互換不要というuserの明示承認に基づく`000001_fukamu_cycle_baseline`へのrebaselineは完了済みの一回限りの例外である。この例外を根拠にbaselineを再編集しない。
- 今後のSchema変更は既存migrationを編集せず、新しいup/down pairを追加する。保存dataや挙動に影響する場合は先に仕様整合性を確認する。
- Production deployはmigration-firstを維持し、migration成功前にapplication trafficを新versionへ移さない。
- main CIの重いjobを省略できるのは、成功したPR CIの検証tree artifactとmain treeが完全一致する場合だけとする。直接push、artifact/API問題、tree不一致では全CIへfallbackし、main SHAの成功CI、Terraform Plan、承認付きApply、Deployの連鎖を維持する。
- 未決のproduction capacity、backup、provider、budget/rate/security/alert値をexample/defaultから推測しない。
- 実装・command・environment variable・workflowを変更したら、対応する専門文書とREADMEの導線が正しいか確認する。
- `backend/internal/infrastructure/postgres/generated/`は手編集しない。Query/schema変更後に`./scripts/invoke-sqlc.sh compile generate`で検証・更新し、生成元と同じcommitへ含める。実行方法の詳細は[`docs/development.md`](docs/development.md)を参照する。

## Verification

- Frontendだけ: `./scripts/check.sh --scope frontend`
- Backendだけ: `./scripts/check.sh --scope backend`
- 全体: `./scripts/check.sh`
- E2E込み: 消去可能な`TEST_DATABASE_URL`を設定して `./scripts/check.sh --e2e`
- Commit前の必須gate: 全変更をstageし、消去可能なlocal `*_test` DBを`TEST_DATABASE_URL`へ設定して `./scripts/check-before-commit.sh`
- Safe cleanの対象確認: `./scripts/clean.sh --dry-run`
- DB reset guardのdry-run: `./scripts/reset-local-db.sh --database-name fukamu_cycle --confirm-database-name fukamu_cycle --dry-run`

Host tool不足で一部checkを実行できない場合は、実行できたcheck、未実行のcheck、理由を明記してください。ただし、Commit前の必須gateを完走できない場合はcommitしてはいけません。Data消失やproduction変更を伴う操作をvalidationのために実行してはいけません。

Commit前に`./scripts/check-before-commit.sh`を完走し、成功後はindexとworking treeを変えずにcommitします。変更した場合は全gateを再実行します。加えてSecret/旧仕様の混入を確認し、意味のある単位でcommitします。詳細は[`docs/development.md`](docs/development.md)を参照します。
