# Database・Migration運用

この文書はDatabaseとMigrationの運用手順の Source of Truth です。保存データ、制約、削除要件などの仕様は [`design.md`](design.md) が上位です。

## 構成

- Database: PostgreSQL 17
- Migration runner: `backend/cmd/migrate`（`golang-migrate`）
- Migration files: `backend/migrations/<6桁連番>_<name>.up.sql` と `.down.sql`
- Query/code generation: `backend/internal/infrastructure/postgres/queries` とsqlc 1.31.1
- 現在のschema: `000001_init.up.sql`

Migration runnerは `DATABASE_URL` と、任意の `MIGRATIONS_DIR`（default `migrations`）だけを読み、未適用のup migrationを順番に適用します。適用履歴はDBの `schema_migrations` で管理されます。

## Schema変更手順

1. 変更が保存データ、ユーザー挙動、API制約、認証・削除仕様に影響するか確認する。影響する場合は、先に [`design.md`](design.md) との整合性と更新要否を判断する。
2. 次の未使用番号で `.up.sql` と `.down.sql` を同時に作る。例: `000002_add_example.up.sql` / `000002_add_example.down.sql`。
3. 1 migrationをtransactionで安全に適用できる場合は、既存fileと同様に `BEGIN;` / `COMMIT;` で囲む。PostgreSQLでtransaction非対応の操作が必要なら、影響と復旧手順をmigrationのcommentとPRへ明記する。
4. Query変更があれば `backend/internal/infrastructure/postgres/queries` を更新する。
5. `sqlc compile`、`sqlc generate`を実行し、生成差分をcommitする。
6. 空のtest DBと、可能ならproduction相当データ量のcopyではない匿名化fixtureでupを検証する。downはローカルの破棄可能DBでのみ検証する。
7. backward incompatibleな変更は一度に行わず、expand → application切替 → contractを複数releaseに分ける。

Migration番号の変更、適用済みfileの書き換え、別branchで同じ番号を使うことは禁止です。適用済みmigrationの訂正は新しいmigrationで行います。

## ローカル適用

```powershell
. ./scripts/import-env.ps1
Push-Location backend
go run ./cmd/migrate
Pop-Location
```

再実行しても未適用分だけが処理されます。接続先を表示・共有するとpasswordが漏れるため、`DATABASE_URL` をterminal logやissueへ貼らないでください。

## Test DB

Go integration testとE2Eは `TEST_DATABASE_URL` だけを使います。専用の `pdcai_test` databaseを用意してください。

```powershell
docker exec pdcai-postgres createdb --username pdcai --owner pdcai pdcai_test
$env:TEST_DATABASE_URL = 'postgres://pdcai:pdcai@127.0.0.1:5432/pdcai_test?sslmode=disable'
pwsh ./scripts/check.ps1 -Scope backend
```

`createdb` は初回だけです。integration testはapplication tableにdown/up SQLを適用して初期化するため、保持したいデータがあるDBを絶対に指定しないでください。CIはjobごとのPostgreSQL service `pdcai_test` を使い、productionへ接続しません。

## Seedと開発データ

seed scriptと固定seedデータはありません。Migration後、画面から匿名sessionを作ると最初のcycleが作成されます。Test fixtureはtest process内で作成し、productionへ投入しません。

ローカルの `.env`、DB data、ブラウザIndexedDBはsafe cleanで保持されます。ブラウザデータだけを消す場合は対象originのsite dataを開発者ツールから削除します。これはserver DBを削除しません。

## ローカルDB reset（破壊的）

次は指定DB内の**全データを復元不能な形で削除**し、DBを再作成してup migrationを適用します。自動backupは作りません。必要な開発データは実行前に `pg_dump` 等で退避してください。

```powershell
pwsh ./scripts/reset-local-db.ps1 -DatabaseName pdcai -ConfirmDatabaseName pdcai -WhatIf
pwsh ./scripts/reset-local-db.ps1 -DatabaseName pdcai -ConfirmDatabaseName pdcai
```

安全策は次のとおりです。

- `clean.ps1` とは別commandで、明示的な実行以外から呼ばれない。
- `pdcai`、`pdcai_dev`、`pdcai_test` 以外のDB名を拒否する。
- DB名を `ConfirmDatabaseName` へ大文字小文字も含めて再入力させる。
- remote Docker context、停止container、PostgreSQL 17以外のimage、host portなしを拒否する。
- URLを引数に取らず、local Docker containerからだけ接続情報を構築する。
- `APP_ENV=production` を拒否する。
- Docker/Go/migration実行条件を削除前に検査し、PowerShellのHigh impact確認も行う。

保持されるものは `.env`、Frontend環境・依存関係、Docker container自体、他のDB、browser dataです。Migrationに失敗した場合は空または途中状態のローカルDBが残る可能性があるため、errorを解消して `go run ./cmd/migrate` を再実行します。

## Production migration

通常のproduction migrationをdeveloper PCから実行しません。[`deploy.yml`](../.github/workflows/deploy.yml) がimmutable imageからCloud Run Job `pdcai-migrate` を更新し、次の順序を強制します。

1. migration jobをdeploy
2. jobを実行し完了まで待つ
3. 成功した場合だけapplication serviceをdeploy
4. `/healthz` と `/readyz` を確認

Migration jobはruntime service accountとCloud SQL attachmentを使い、Secret Managerの `PDCAI_DATABASE_URL` を `DATABASE_URL` として受け取ります。手動再実行が必要なincidentでは、接続URLをlocalへ取り出さず、権限を持つoperatorが次を実行します。

```powershell
gcloud run jobs execute pdcai-migrate --region asia-northeast1 --wait
```

これはproduction変更です。失敗原因と適用versionを確認せず繰り返してはいけません。

## Destructive migration・rollback・backup

- column/table削除、型の縮小、既存データ変換などは、同じreleaseでapplication rollbackを不可能にし得ます。expand/contractを使い、backupと復旧確認なしに実行しません。
- Deploy失敗時にdown migrationを自動実行しません。application image/revisionのrollbackとDB schema rollbackは別判断です。
- dirty versionを強制的に書き換える操作やproductionでのreset/drop/truncateを、汎用scriptとして提供しません。
- production backup retentionとPITR設定は [`design.md`](design.md) §21・§54で正式値が未決です。初回production deploy前にCloud SQL tier、backup、PITR、保持期間、復元演習方法を決定する必要があります。
- destructive migration前は、その決定済みpolicyに基づくbackupが成功しており、別instanceへのrestore手順が確認済みであることをrelease記録へ残します。

Productionの復元やdata correctionが必要な場合は通常deployを止め、対象・時点・影響・承認・backupを確認した個別runbookを作成してください。既存仕様と矛盾するdata変更をその場で決めてはいけません。
