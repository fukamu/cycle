# PDCAI repository instructions

このfileはrepository全体に適用します。

## Source of Truth

アプリケーション要件・仕様・設計の最上位Source of Truthは [`docs/design.md`](docs/design.md) です。実装都合で仕様を変更してはいけません。

| テーマ                             | 参照先                                               |
| ---------------------------------- | ---------------------------------------------------- |
| Repository入口                     | [`README.md`](README.md)                             |
| Local development / checks / clean | [`docs/development.md`](docs/development.md)         |
| Environment variables              | [`docs/environment.md`](docs/environment.md)         |
| Database / Migration               | [`docs/database.md`](docs/database.md)               |
| Deployment                         | [`docs/deployment.md`](docs/deployment.md)           |
| Production operations              | [`docs/operations.md`](docs/operations.md)           |
| Troubleshooting                    | [`docs/troubleshooting.md`](docs/troubleshooting.md) |

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
- `docs/design.md` を変更できるのは、既存仕様の意味を変えず、他sectionと矛盾せず、影響範囲を確認できる場合だけ。
- 実装に合わせるため、矛盾を隠すため、または不明確な仕様を推測で確定するために `docs/design.md` を変更しない。
- 既存仕様同士の矛盾、既存仕様への違反、security/data retention/auth/permission/production上の重要な判断不能、影響範囲不明を発見したら、該当する実装・script・config・文書変更を停止する。
- 停止時は `docs/design.md` も変更せず、関連仕様、問題、影響、停止した変更、user判断が必要な選択肢を具体的に報告する。
- 安全に独立して進められる無関係な作業まで停止する必要はない。

## 作業規則

- 作業開始時に`git status`と関連code/config/test/docsを確認し、userの未commit変更を削除・上書き・混入しない。
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
- Safe cleanの対象確認: `./scripts/clean.sh --dry-run`
- DB reset guardのdry-run: `./scripts/reset-local-db.sh --database-name pdcai --confirm-database-name pdcai --dry-run`

Host tool不足で一部checkを実行できない場合は、実行できたcheck、未実行のcheck、理由を明記してください。Data消失やproduction変更を伴う操作をvalidationのために実行してはいけません。

Commit前に`git diff --check`、対象scopeのcheck、generated code差分、Secret/旧仕様の混入を確認します。意味のある単位でcommitし、force pushや既存履歴の書き換えを行いません。
