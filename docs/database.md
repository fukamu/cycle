# Database・Migration運用

この文書はDatabaseとMigrationの運用手順の Source of Truth です。保存データ、制約、削除要件などの仕様は [`design.md`](design.md) が上位です。

## 構成

- Database: PostgreSQL 18.6（Dockerは`postgres:18.6-alpine3.24`）
- Migration runner: `backend/cmd/migrate`（`golang-migrate`）
- Migration files: `backend/migrations/<6桁連番>_<name>.up.sql` と `.down.sql`
- Query/code generation: `backend/internal/infrastructure/postgres/queries` とsqlc 1.31.1
- 現在のbaseline schema: `000001_fukamu_cycle_baseline.up.sql`。未リリース・空DB・既存環境互換不要という明示承認に基づき、初期Schemaの80/200文字制約とUUID v7制約を直接含む1 migrationへrebaseline済みです。

Migration runnerは `DATABASE_URL` と、任意の `MIGRATIONS_DIR`（default `migrations`）だけを読み、未適用のup migrationを順番に適用します。適用履歴はDBの `schema_migrations` で管理されます。

Migration runnerは、正常に適用した各fileについて`migration_version`、`migration_direction`、`migration_file`、`migration_duration_ms`をJSON logへ記録します。完了logには`migration_applied_count`と`migration_no_change`を記録し、未適用fileがなかった実行も判別できます。Database URL、SQL本文、接続credentialはlogへ記録しません。

## Schema変更手順

1. 変更が保存データ、ユーザー挙動、API制約、認証・削除仕様に影響するか確認する。影響する場合は、先に [`design.md`](design.md) との整合性と更新要否を判断する。
2. 次の未使用番号で `.up.sql` と `.down.sql` を同時に作る。例: `000002_add_example.up.sql` / `000002_add_example.down.sql`。
3. 1 migrationをtransactionで安全に適用できる場合は、既存fileと同様に `BEGIN;` / `COMMIT;` で囲む。PostgreSQLでtransaction非対応の操作が必要なら、影響と復旧手順をmigrationのcommentとPRへ明記する。
4. Query変更があれば `backend/internal/infrastructure/postgres/queries` を更新する。
5. Repository rootで`./scripts/invoke-sqlc.sh compile generate`を実行し、生成差分をcommitする。実行環境の選択は[`development.md`](development.md)を参照する。
6. 空のtest DBと、可能ならproduction相当データ量のcopyではない匿名化fixtureでupを検証する。downはローカルの破棄可能DBでのみ検証する。
7. backward incompatibleな変更は一度に行わず、expand → application切替 → contractを複数releaseに分ける。

この完了済みrebaselineを再実行・再編集してはいけません。今後はMigration番号の変更、適用済みfileの書き換え、別branchで同じ番号を使うことを禁止し、適用済みmigrationの訂正は新しいmigrationで行います。

## ローカル適用

```bash
source ./scripts/import-env.sh
(
  cd backend
  go run ./cmd/migrate
)
```

再実行しても未適用分だけが処理されます。接続先を表示・共有するとpasswordが漏れるため、`DATABASE_URL` をterminal logやissueへ貼らないでください。

## Test DB

Go integration testとE2Eは `TEST_DATABASE_URL` だけを使います。専用の `pdcai_test` databaseを用意してください。

```bash
docker exec pdcai-postgres createdb --username pdcai --owner pdcai pdcai_test
export TEST_DATABASE_URL='postgres://pdcai:pdcai@127.0.0.1:5432/pdcai_test?sslmode=disable'
./scripts/check.sh --scope backend
```

`createdb` は初回だけです。integration testはapplication tableにdown/up SQLを適用して初期化するため、保持したいデータがあるDBを絶対に指定しないでください。CIはjobごとのPostgreSQL service `pdcai_test` を使い、productionへ接続しません。

`./scripts/local-app.sh`で起動する`pdcai_local`は、`pdcai-local` Compose project内のtmpfsだけを使う手動実機確認用DBです。Host port、既存の`pdcai-postgres`、`.env`の`DATABASE_URL`を使用せず、終了時に破棄されます。保持したいデータを保存しないでください。

## Seedと開発データ

seed scriptと固定seedデータはありません。Migration後、匿名sessionの作成だけではGoal/Cycleを作りません。Goal Creation Draftを開始へ変換すると、Goal、Goal Version 1、Cycle 1が同一transactionで作成されます。Test fixtureはtest process内で作成し、productionへ投入しません。

主要aggregateは `users -> goals -> goal_versions / pdca_cycles / goal_drafts / ai_generations` です。Cycle番号はUser全体ではなくGoal内で採番されます。完了したCycleから次Cycleを直接作らず、`goal_review` とReview Draftを作成します。Progressing Goal上限はUser row lock下で判定し、将来の複数Goal entitlementを妨げるUser単位unique制約は置きません。詳細な制約と削除・保持規則は [`design.md`](design.md) §12〜18を参照してください。

ローカルの `.env`、DB data、ブラウザIndexedDBはsafe cleanで保持されます。ブラウザデータだけを消す場合は対象originのsite dataを開発者ツールから削除します。これはserver DBを削除しません。

## ローカルDB reset（破壊的）

次は指定DB内の**全データを復元不能な形で削除**し、DBを再作成してup migrationを適用します。自動backupは作りません。必要な開発データは実行前に `pg_dump` 等で退避してください。

```bash
./scripts/reset-local-db.sh --database-name pdcai --confirm-database-name pdcai --dry-run
./scripts/reset-local-db.sh --database-name pdcai --confirm-database-name pdcai --yes
```

安全策は次のとおりです。

- `clean.sh` とは別commandで、明示的な実行以外から呼ばれない。
- `pdcai`、`pdcai_dev`、`pdcai_test` 以外のDB名を拒否する。
- DB名を`--confirm-database-name`へ大文字小文字も含めて再入力させる。
- remote Docker context、停止container、`postgres:18.6-alpine3.24`以外のimage、host portなしを拒否する。
- URLを引数に取らず、local Docker containerからだけ接続情報を構築する。
- `APP_ENV=production` を拒否する。
- Docker/Go/migration実行条件を削除前に検査し、実削除には`--yes`を要求する。

保持されるものは `.env`、Frontend環境・依存関係、Docker container自体、他のDB、browser dataです。Migrationに失敗した場合は空または途中状態のローカルDBが残る可能性があるため、errorを解消して `go run ./cmd/migrate` を再実行します。

## Staging / Production migration

通常のStaging/Production migrationをdeveloper PCから実行しません。Stagingは [`deploy.yml`](../.github/workflows/deploy.yml) がGitHub `staging` EnvironmentのNeon direct URLを一時的に `DATABASE_URL`へmapし、次の順序を強制します。

1. main HEADと同じSHAのCI成功を確認
2. `go run ./cmd/migrate`をNeon direct URLに対して実行
3. 成功した場合だけWranglerでWorker/Container/assetsをdeploy
4. `/healthz` と `/readyz` を確認

Application runtimeはNeon pooled URL、migrationはdirect URLを使います。Migration URLはCloudflare Worker/Containerへ渡さず、runtime URLはmigrationへ流用しません。双方をGitHub `staging` Environment secretに置き、workflowは値を出力しません。

手動再実行が必要なincidentでは通常deployを止め、対象Neon project/branch、head SHA、現在のschema version、失敗原因を確認した個別runbookを作ります。URLをlocalへ取り出したり、確認なしにworkflowを繰り返したりしません。Production pipelineは正式domain/resource決定後に別Environmentとして設計します。

## Destructive migration・rollback・backup

- column/table削除、型の縮小、既存データ変換などは、同じreleaseでapplication rollbackを不可能にし得ます。expand/contractを使い、backupと復旧確認なしに実行しません。
- Deploy失敗時にdown migrationを自動実行しません。application image/revisionのrollbackとDB schema rollbackは別判断です。
- dirty versionを強制的に書き換える操作やproductionでのreset/drop/truncateを、汎用scriptとして提供しません。
- production restore windowと追加backup設定は [`design.md`](design.md) §21・§54で正式値が未決です。初回production deploy前にNeon plan/compute、restore window、保持期間、復元演習方法を決定する必要があります。
- destructive migration前は、その決定済みpolicyに基づくbackupが成功しており、別instanceへのrestore手順が確認済みであることをrelease記録へ残します。

Productionの復元やdata correctionが必要な場合は通常deployを止め、対象・時点・影響・承認・backupを確認した個別runbookを作成してください。既存仕様と矛盾するdata変更をその場で決めてはいけません。
