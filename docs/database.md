# Database・Migration運用

この文書はDatabaseとMigrationの運用手順の Source of Truth です。保存データ、制約、削除要件などの仕様は [`design.md`](design.md) が上位です。

## 構成

- Database: PostgreSQL 18.6（Dockerは`postgres:18.6-alpine3.24`）
- Migration runner: `backend/cmd/migrate`（`golang-migrate`）
- Migration files: `backend/migrations/<6桁連番>_<name>.up.sql` と `.down.sql`
- Query/code generation: `backend/internal/infrastructure/postgres/queries` とsqlc 1.31.1
- Baseline schema: `000001_fukamu_cycle_baseline.up.sql`。未リリース・空DB・既存環境互換不要という明示承認に基づき、初期Schemaの80/200文字制約とUUID v7制約を直接含む1 migrationへrebaseline済みであり、今後編集しません。
- 現在のschema head: `000005_retention_cleanup_index.up.sql`。期限cleanupの順序付きbatch scan用に、確定・content削除済みAI Usageのpartial indexとabuse rate bucketの複合indexを追加します。保持条件や期限は変更しません。`000004_ai_generation_hash_split.up.sql`はAI request replay identityとcanonical provider input identityを別columnへ保存し、旧`input_hash`は直前Application rollback専用aliasとして一時保持します。`000003_ai_usage_settlement_exposure.up.sql`の未確定settlement metadataと、`000002_ai_usage_retention_margin.up.sql`の24時間15分物理保持期限・24時間Quota windowは変更しません。

`000005`はplain transactional `CREATE INDEX`を使います。Data-bearing Productionへ適用する前に対象table規模でwrite lock影響と所要時間を評価し、未評価または許容不能ならdeployを停止します。適用済みmigrationは書き換えず、必要な修正は新しいforward migrationで行います。

`000004`は既存`input_hash`を`idempotency_request_hash`へexact backfillし、復元不能な`canonical_provider_input_hash`は`NULL`のまま維持します。64文字lowercase SHA-256 hexでないlegacy request hashが1件でもあればmigration全体をSQLSTATE `23514`でfail-closedにし、現在のContextやrequest hashからcanonical hashを推測しません。

Migration-first切替中、旧Application writerが`input_hash`だけを送る場合はDB triggerが`idempotency_request_hash`を同値補完し、canonical hashをlegacy `NULL`として維持します。新Application writerは新しい2 fieldを送り、旧`input_hash`を送らず、triggerがrollback aliasだけを補完します。Request hash aliasの不一致、3 hash fieldの形式違反、新writerのcanonical hash欠落、保存後のhash変更は拒否します。旧aliasは新Applicationから参照せず、rollback window終了後の別contract migrationで削除します。Productionではdownを実行せず、問題はforward migrationで修復します。

`000003`は既存のprovider-unfinalized Usageを、same-user/same-operationのreconstructableなrunning AIGenerationからexact backfillします。対応Generationがない、owner/operationが一致しない、または元の月/額を復元できないrowが1件でもあればmigration全体をSQLSTATE `23514`でfail-closedにし、default値や現在の設定値から推測しません。

Migration-first切替中、旧Application writerがmetadataを送らないINSERTはDB triggerがrunning Generationからexact補完し、旧finalizerが`provider_usage_finalized_at`だけを更新した場合は同triggerがmetadataをclearします。未確定中のpair変更、不完全なpair、Generationとの不一致は拒否します。Usageのowner Userとlogical operation IDの変更も全lifecycleで拒否します。旧Account Deleteがrunning Generationを失った未確定Usageを削除しようとする場合はUser delete guardがTransaction全体を拒否し、新Application切替後の再試行でunattributed costへ移送してから削除します。

Migration runnerは `DATABASE_URL` と、任意の `MIGRATIONS_DIR`（default `migrations`）だけを読み、未適用のup migrationを順番に適用します。接続時はURLとambient `PGOPTIONS`にかかわらず`search_path=public`を明示固定し、適用履歴は`public.schema_migrations`で管理します。URLの`search_path`/`options`はcanonical lowercase keyと固定値のexact一致だけを許可し、大小文字variantを含むcustom migrations table指定は接続前に拒否します。その他のquery設定は保持します。

Migration runnerは、正常に適用した各fileについて`migration_version`、`migration_direction`、`migration_file`、`migration_duration_ms`をJSON logへ記録します。完了logには`migration_applied_count`と`migration_no_change`を記録し、未適用fileがなかった実行も判別できます。Database URL、SQL本文、接続credentialはlogへ記録しません。

## Schema変更手順

1. 変更が保存データ、ユーザー挙動、API制約、認証・削除仕様に影響するか確認する。影響する場合は、先に [`design.md`](design.md) との整合性と更新要否を判断する。
2. 次の未使用番号で `.up.sql` と `.down.sql` を同時に作る。例: `000002_add_example.up.sql` / `000002_add_example.down.sql`。
3. 1 migrationをtransactionで安全に適用できる場合は、既存fileと同様に `BEGIN;` / `COMMIT;` で囲む。PostgreSQLでtransaction非対応の操作が必要なら、影響と復旧手順をmigrationのcommentとPRへ明記する。
4. Query変更があれば `backend/internal/infrastructure/postgres/queries` を更新する。
5. Repository rootで`./scripts/invoke-sqlc.sh compile generate`を実行し、生成差分をcommitする。実行環境の選択は[`development.md`](development.md)を参照する。
6. 空のtest DBと、可能ならproduction相当データ量のcopyではない匿名化fixtureでupを検証する。downはローカルの破棄可能DBでのみ検証する。
7. backward incompatibleな変更は一度に行わず、expand → application切替 → contractを複数releaseに分ける。

AI Usage settlement migration testは、exact backfill、復元不能rowの全体rollback、旧writer補完、旧finalizer clear、CHECK/immutability違反、旧Account Delete guard、新Account Delete後のUser削除を検証します。AI Generation hash split migration testは、legacy backfill、復元不能canonical hashの`NULL`維持、旧・新writerのrolling互換、hash不変性、形式不正なlegacy/new hashでのatomic failure、破棄可能DBだけでのdown/re-upを検証します。Retention cleanup migration testは、2つのscan indexのpredicate・column順と破棄可能DBだけでのdown/re-upを検証します。

この完了済みrebaselineを再実行・再編集してはいけません。今後はMigration番号の変更、適用済みfileの書き換え、別branchで同じ番号を使うことを禁止し、適用済みmigrationの訂正は新しいmigrationで行います。

## Retention cleanup command

`backend/cmd/cleanup`は、[設計のAI Usage最小化契約](design.md#382-usage-data-minimization)と[retention cleanup契約](design.md#395-retention-cleanup)に従うmaintenance commandです。接続情報は引数に取らず`DATABASE_URL`だけを読みます。起動時のUTC時刻を一度だけ固定し、AI Usageは`content_deleted=true`、物理保持期限到達済み、Provider usage確定済みの3条件をすべて満たすrecordだけ、rate bucketは期限到達済みrecordだけを対象にします。

Cleanup専用の`DATABASE_URL`は`postgres`または`postgresql` scheme、明示した非空user、単一host、単一database pathを必須とします。PasswordはURLに存在する場合だけその値を使用し、passwordless、明示TLS client certificate、Kerberosなどの認証はURLの明示設定とDB側の認証policyに従います。Port省略時はambient値を使わず`5432`へ固定し、`sslmode`省略時はpgxの`prefer`へ固定します。URL queryで許可するのは`channel_binding`、`connect_timeout`、`default_query_exec_mode`、`description_cache_capacity`、`krbspn`、`krbsrvname`、`max_protocol_version`、`min_protocol_version`、`require_auth`、`sslcert`、`sslkey`、`sslmode`、`sslnegotiation`、`sslpassword`、`sslrootcert`、`sslsni`、`statement_cache_capacity`、`target_session_attrs`だけです。Host・port・database・userの上書き、multiple host、`service`/`servicefile`、`passfile`、pool設定、任意runtime parameterは拒否します。

pgx v5.10.0が認識する`PG*`接続環境変数は、完全なURLと併存する場合も含め、1つでも非空なら固定のconfiguration errorで接続前に停止します。URLにpasswordがない場合も`~/.pgpass`を読まず、TLS fileを明示しない場合もhome directoryのdefault certificate/root certificateを読みません。TLS certificate/key/root certificateをURLで明示した場合はその指定を維持します。接続後の`search_path`は`pg_catalog,public`へ固定し、cleanup SQLとindex migrationも対象table/indexを`public`へschema-qualifiedします。これによりcleanupの物理削除先は`DATABASE_URL`の`public` schemaだけで決定し、raw URL、secret、file path、parser errorをlogへ出しません。

```bash
source ./scripts/import-env.sh
(
  cd backend
  go run ./cmd/cleanup --dry-run
)
```

`--execute`は対象recordを物理削除します。接続先と承認済みbatch sizeを確認したうえで、dry-runとは別の実行として起動します。

```bash
source ./scripts/import-env.sh
(
  cd backend
  go run ./cmd/cleanup --execute --batch-size=APPROVED_INTEGER_1_TO_1000
)
```

`--dry-run`と`--execute`はexactly oneを指定します。Dry-runに`--batch-size`は指定できず、読み取り専用REPEATABLE READ snapshotで候補件数を返してDBを変更しません。Executeは1〜1000の明示batch sizeが必須で、単一接続pool上のresource別の短いTransactionを使います。各batchは期限順に`FOR UPDATE SKIP LOCKED`で候補をlockし、DELETE外側でも全predicateを再検証します。中断後は同じcommandを再実行でき、未確定AI Usageは期限を過ぎても削除しません。実行周期やbatch sizeの運用値はこのcommandでは推測・default化しません。

出力はresource別のmode、候補・削除・batch件数だけをsafe JSON logへ記録します。Deadline、row ID、Database URL、SQL、raw errorは出力しません。Productionでの実行経路・周期を確定するまではdeployやserver起動へ自動接続しません。

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

Go integration testとE2Eは `TEST_DATABASE_URL` だけを使います。専用の `fukamu_cycle_test` databaseを用意してください。

```bash
docker exec fukamu-cycle-postgres createdb --username fukamu_cycle --owner fukamu_cycle fukamu_cycle_test
export TEST_DATABASE_URL='postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:5432/fukamu_cycle_test?sslmode=disable'
./scripts/check.sh --scope backend
```

`createdb` は初回だけです。integration testはapplication tableにdown/up SQLを適用して初期化するため、保持したいデータがあるDBを絶対に指定しないでください。CIはjobごとのPostgreSQL service `fukamu_cycle_test` を使い、productionへ接続しません。

`./scripts/local-app.sh`で起動する`fukamu_cycle_local`は、`fukamu-cycle-local` Compose project内のtmpfsだけを使う手動実機確認用DBです。Host port、既存の`fukamu-cycle-postgres`、`.env`の`DATABASE_URL`を使用せず、終了時に破棄されます。保持したいデータを保存しないでください。

## Seedと開発データ

seed scriptと固定seedデータはありません。Migration後、匿名sessionの作成だけではGoal/Cycleを作りません。Goal Creation Draftを開始へ変換すると、Goal、Goal Version 1、Cycle 1が同一transactionで作成されます。Test fixtureはtest process内で作成し、productionへ投入しません。

主要aggregateは `users -> goals -> goal_versions / pdca_cycles / goal_drafts / ai_generations` です。Cycle番号はUser全体ではなくGoal内で採番されます。完了したCycleから次Cycleを直接作らず、`goal_review` とReview Draftを作成します。Progressing Goal上限はUser row lock下で判定し、将来の複数Goal entitlementを妨げるUser単位unique制約は置きません。詳細な制約と削除・保持規則は [`design.md`](design.md) §12〜18を参照してください。

ローカルの `.env`、DB data、ブラウザIndexedDBはsafe cleanで保持されます。ブラウザデータだけを消す場合は対象originのsite dataを開発者ツールから削除します。これはserver DBを削除しません。

## ローカルDB reset（破壊的）

次は指定DB内の**全データを復元不能な形で削除**し、DBを再作成してup migrationを適用します。自動backupは作りません。必要な開発データは実行前に `pg_dump` 等で退避してください。

```bash
./scripts/reset-local-db.sh --database-name fukamu_cycle --confirm-database-name fukamu_cycle --dry-run
./scripts/reset-local-db.sh --database-name fukamu_cycle --confirm-database-name fukamu_cycle --yes
```

安全策は次のとおりです。

- `clean.sh` とは別commandで、明示的な実行以外から呼ばれない。
- `fukamu_cycle`、`fukamu_cycle_dev`、`fukamu_cycle_test` 以外のDB名を拒否する。
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

手動再実行が必要なincidentでは通常deployを止め、対象Neon project/branch、head SHA、現在のschema version、失敗原因を確認した個別runbookを作ります。URLをlocalへ取り出したり、確認なしにworkflowを繰り返したりしません。Production pipelineは確定済みの`cycle.fukamu.com`向けに、Production専用resourceと運用値が確定した後で別Environmentとして設計します。

## Destructive migration・rollback・backup

- column/table削除、型の縮小、既存データ変換などは、同じreleaseでapplication rollbackを不可能にし得ます。expand/contractを使い、backupと復旧確認なしに実行しません。
- Deploy失敗時にdown migrationを自動実行しません。application image/revisionのrollbackとDB schema rollbackは別判断です。
- dirty versionを強制的に書き換える操作やproductionでのreset/drop/truncateを、汎用scriptとして提供しません。
- production restore windowと追加backup設定は [`design.md`](design.md) §21・§54で正式値が未決です。初回production deploy前にNeon plan/compute、restore window、保持期間、復元演習方法を決定する必要があります。
- destructive migration前は、その決定済みpolicyに基づくbackupが成功しており、別instanceへのrestore手順が確認済みであることをrelease記録へ残します。

Productionの復元やdata correctionが必要な場合は通常deployを止め、対象・時点・影響・承認・backupを確認した個別runbookを作成してください。既存仕様と矛盾するdata変更をその場で決めてはいけません。
