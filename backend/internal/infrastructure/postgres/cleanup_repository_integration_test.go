package postgres

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	applicationcleanup "github.com/fukamu/cycle/backend/internal/application/cleanup"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

const (
	cleanupUserID  = "90000000-0000-7000-8000-000000000001"
	cleanupDraftID = "90100000-0000-7000-8000-000000000001"
)

type cleanupGoalDeleteUsageLockKey struct{}

type cleanupGoalDeleteBarrier struct {
	usageLocked chan error
	releaseLock chan struct{}
	lockOnce    sync.Once
	releaseOnce sync.Once
}

func newCleanupGoalDeleteBarrier() *cleanupGoalDeleteBarrier {
	return &cleanupGoalDeleteBarrier{
		usageLocked: make(chan error, 1),
		releaseLock: make(chan struct{}),
	}
}

func (barrier *cleanupGoalDeleteBarrier) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if isCleanupGoalUsageLock(data.SQL) {
		return context.WithValue(ctx, cleanupGoalDeleteUsageLockKey{}, true)
	}
	return ctx
}

func (barrier *cleanupGoalDeleteBarrier) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryEndData,
) {
	locked, _ := ctx.Value(cleanupGoalDeleteUsageLockKey{}).(bool)
	if !locked {
		return
	}
	barrier.lockOnce.Do(func() {
		barrier.usageLocked <- data.Err
		if data.Err != nil {
			return
		}
		select {
		case <-barrier.releaseLock:
		case <-ctx.Done():
		}
	})
}

func (barrier *cleanupGoalDeleteBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseLock) })
}

func isCleanupGoalUsageLock(statement string) bool {
	normalized := normalizeObservedSQL(statement)
	return strings.Contains(normalized, "from ai_usage_events") &&
		strings.Contains(normalized, "where user_id=$1 and goal_id=$2") &&
		strings.Contains(normalized, "order by operation_id for update")
}

func TestCleanupDryRunAndExecuteRespectAllDeadlineAndSettlementPredicates(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(7 * 24 * time.Hour)
	insertCleanupUser(t, pool, now)
	duration := workspace.AIUsageRetentionDuration

	insertFinalizedCleanupUsage(t, pool, "91000000-0000-7000-8000-000000000001", now.Add(-duration-time.Microsecond), true)
	insertFinalizedCleanupUsage(t, pool, "91000000-0000-7000-8000-000000000002", now.Add(-duration), true)
	insertFinalizedCleanupUsage(t, pool, "91000000-0000-7000-8000-000000000003", now.Add(-duration+time.Microsecond), true)
	insertFinalizedCleanupUsage(t, pool, "91000000-0000-7000-8000-000000000004", now.Add(-duration-time.Microsecond), false)
	insertPendingCleanupUsage(t, pool, "91000000-0000-7000-8000-000000000005", "92000000-0000-7000-8000-000000000005", now.Add(-duration-time.Microsecond), true)

	insertCleanupBucket(t, pool, "test_past", []byte{1}, now.Add(-2*time.Minute), now.Add(-time.Microsecond))
	insertCleanupBucket(t, pool, "test_exact", []byte{2}, now.Add(-time.Minute), now)
	insertCleanupBucket(t, pool, "test_future", []byte{3}, now, now.Add(time.Microsecond))

	service := applicationcleanup.NewService(NewCleanupRepository(pool))
	dryResult, err := service.DryRun(t.Context(), now)
	if err != nil {
		t.Fatal(err)
	}
	if dryResult.AIUsageEvents.CandidateCount != 2 || dryResult.AbuseRateBuckets.CandidateCount != 2 {
		t.Fatalf("dry-run candidates = %+v, want 2/2", dryResult)
	}
	assertCleanupTableCounts(t, pool, 5, 3)

	executeResult, err := service.Execute(t.Context(), now, 1)
	if err != nil {
		t.Fatal(err)
	}
	if executeResult.AIUsageEvents != (applicationcleanup.ResourceResult{CandidateCount: 2, DeletedCount: 2, BatchCount: 2}) ||
		executeResult.AbuseRateBuckets != (applicationcleanup.ResourceResult{CandidateCount: 2, DeletedCount: 2, BatchCount: 2}) {
		t.Fatalf("execute result = %+v", executeResult)
	}
	assertCleanupTableCounts(t, pool, 3, 1)
	assertCleanupUsageExists(t, pool, "91000000-0000-7000-8000-000000000001", false)
	assertCleanupUsageExists(t, pool, "91000000-0000-7000-8000-000000000002", false)
	assertCleanupUsageExists(t, pool, "91000000-0000-7000-8000-000000000003", true)
	assertCleanupUsageExists(t, pool, "91000000-0000-7000-8000-000000000004", true)
	assertCleanupUsageExists(t, pool, "91000000-0000-7000-8000-000000000005", true)

	replay, err := service.Execute(t.Context(), now, 1)
	if err != nil || replay.AIUsageEvents.DeletedCount != 0 || replay.AbuseRateBuckets.DeletedCount != 0 {
		t.Fatalf("idempotent replay = %+v/%v", replay, err)
	}
}

func TestCleanupTargetsPublicSchemaWhenSearchPathContainsShadowTables(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(7 * 24 * time.Hour)
	insertCleanupUser(t, pool, now)
	insertFinalizedCleanupUsage(t, pool, "90000000-0000-7000-8000-000000000011",
		now.Add(-workspace.AIUsageRetentionDuration-time.Minute), true)
	insertCleanupBucket(t, pool, "public_expired", []byte{1}, now.Add(-time.Minute), now)

	_, err := pool.Exec(t.Context(), `DROP SCHEMA IF EXISTS cleanup_shadow CASCADE;
CREATE SCHEMA cleanup_shadow;
CREATE TABLE cleanup_shadow.ai_usage_events (
    operation_id uuid PRIMARY KEY,
    content_deleted boolean NOT NULL,
    quota_retain_until timestamptz NOT NULL,
    provider_usage_finalized_at timestamptz
);
CREATE TABLE cleanup_shadow.abuse_rate_buckets (
    scope text NOT NULL,
    key_hash bytea NOT NULL,
    window_start timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (scope, key_hash, window_start)
);`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(t.Context(), `INSERT INTO cleanup_shadow.ai_usage_events
    (operation_id, content_deleted, quota_retain_until, provider_usage_finalized_at)
VALUES
    ('90000000-0000-7000-8000-000000000021', TRUE, $1, $2),
    ('90000000-0000-7000-8000-000000000022', TRUE, $1, $2)`, now.Add(-time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(t.Context(), `INSERT INTO cleanup_shadow.abuse_rate_buckets
    (scope, key_hash, window_start, expires_at)
VALUES
    ('shadow_1', '\x01', $1, $1),
    ('shadow_2', '\x02', $1, $1),
    ('shadow_3', '\x03', $1, $1)`, now.Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS cleanup_shadow CASCADE")
	})

	config, err := pgxpool.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	config.MinConns = 0
	config.ConnConfig.RuntimeParams["search_path"] = "cleanup_shadow,public"
	shadowPool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer shadowPool.Close()
	if err = shadowPool.Ping(t.Context()); err != nil {
		t.Fatal(err)
	}
	var currentSchema string
	if err = shadowPool.QueryRow(t.Context(), "SELECT current_schema()").Scan(&currentSchema); err != nil {
		t.Fatal(err)
	}
	if currentSchema != "cleanup_shadow" {
		t.Fatalf("shadow pool current_schema = %q, want cleanup_shadow", currentSchema)
	}

	service := applicationcleanup.NewService(NewCleanupRepository(shadowPool))
	dryResult, err := service.DryRun(t.Context(), now)
	if err != nil || dryResult.AIUsageEvents.CandidateCount != 1 || dryResult.AbuseRateBuckets.CandidateCount != 1 {
		t.Fatalf("public-schema dry-run = %+v/%v, want 1/1", dryResult, err)
	}
	executeResult, err := service.Execute(t.Context(), now, 10)
	if err != nil || executeResult.AIUsageEvents.DeletedCount != 1 ||
		executeResult.AbuseRateBuckets.DeletedCount != 1 {
		t.Fatalf("public-schema execute = %+v/%v, want 1/1", executeResult, err)
	}

	var publicUsage, publicBuckets, shadowUsage, shadowBuckets int
	if err = pool.QueryRow(t.Context(), `SELECT
    (SELECT count(*) FROM public.ai_usage_events),
    (SELECT count(*) FROM public.abuse_rate_buckets),
    (SELECT count(*) FROM cleanup_shadow.ai_usage_events),
    (SELECT count(*) FROM cleanup_shadow.abuse_rate_buckets)`).Scan(
		&publicUsage, &publicBuckets, &shadowUsage, &shadowBuckets,
	); err != nil {
		t.Fatal(err)
	}
	if publicUsage != 0 || publicBuckets != 0 || shadowUsage != 2 || shadowBuckets != 3 {
		t.Fatalf("schema counts = public:%d/%d shadow:%d/%d, want 0/0 and 2/3",
			publicUsage, publicBuckets, shadowUsage, shadowBuckets)
	}
}

func TestCleanupSkipsLateSettlementUntilNextRunAndDuplicateCallbackIsNoOp(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(8 * 24 * time.Hour)
	insertCleanupUser(t, pool, now)
	operationID := "93000000-0000-7000-8000-000000000001"
	insertPendingCleanupUsage(t, pool, operationID, "94000000-0000-7000-8000-000000000001",
		now.Add(-workspace.AIUsageRetentionDuration-time.Minute), true)

	service := applicationcleanup.NewService(NewCleanupRepository(pool))
	beforeSettlement, err := service.Execute(t.Context(), now, 10)
	if err != nil || beforeSettlement.AIUsageEvents.DeletedCount != 0 {
		t.Fatalf("cleanup before late settlement = %+v/%v", beforeSettlement, err)
	}
	assertCleanupUsageExists(t, pool, operationID, true)

	if rows := finalizeLateCleanupUsage(t, pool, operationID, now); rows != 1 {
		t.Fatalf("first late callback rows = %d, want 1", rows)
	}
	if rows := finalizeLateCleanupUsage(t, pool, operationID, now); rows != 0 {
		t.Fatalf("duplicate late callback rows = %d, want 0", rows)
	}
	assertCleanupUsageExists(t, pool, operationID, true)

	afterSettlement, err := service.Execute(t.Context(), now, 10)
	if err != nil || afterSettlement.AIUsageEvents.DeletedCount != 1 {
		t.Fatalf("cleanup after late settlement = %+v/%v", afterSettlement, err)
	}
	replay, err := service.Execute(t.Context(), now, 10)
	if err != nil || replay.AIUsageEvents.DeletedCount != 0 {
		t.Fatalf("cleanup replay after deletion = %+v/%v", replay, err)
	}
}

func TestCleanupSkipsRowLockedByLateSettlementThenDeletesOnNextRun(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(9 * 24 * time.Hour)
	insertCleanupUser(t, pool, now)
	operationID := "95000000-0000-7000-8000-000000000001"
	insertPendingCleanupUsage(t, pool, operationID, "96000000-0000-7000-8000-000000000001",
		now.Add(-workspace.AIUsageRetentionDuration-time.Minute), true)

	tx, err := pool.BeginTx(t.Context(), pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	tag, err := tx.Exec(t.Context(), `UPDATE ai_usage_events
SET status='failed',provider_usage_finalized_at=$2
WHERE operation_id=$1 AND provider_usage_finalized_at IS NULL`, operationID, now)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("in-flight late settlement = %d/%v", tag.RowsAffected(), err)
	}

	type batchResult struct {
		deleted int64
		err     error
	}
	finished := make(chan batchResult, 1)
	cleanupCtx, cancelCleanup := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancelCleanup()
	go func() {
		deleted, deleteErr := NewCleanupRepository(pool).DeleteAIUsageEventsBatch(cleanupCtx, now, 10)
		finished <- batchResult{deleted: deleted, err: deleteErr}
	}()
	select {
	case result := <-finished:
		if result.err != nil || result.deleted != 0 {
			t.Fatalf("cleanup while settlement row locked = %+v", result)
		}
	case <-cleanupCtx.Done():
		t.Fatalf("cleanup waited on a late-settlement row instead of SKIP LOCKED: %v", cleanupCtx.Err())
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	deleted, err := NewCleanupRepository(pool).DeleteAIUsageEventsBatch(t.Context(), now, 10)
	if err != nil || deleted != 1 {
		t.Fatalf("cleanup after late settlement commit = %d/%v", deleted, err)
	}
}

func TestConcurrentCleanupWorkersDeleteEachCandidateExactlyOnce(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(10 * 24 * time.Hour)
	insertCleanupUser(t, pool, now)
	const total = 24
	for index := 1; index <= total; index++ {
		operationID := fmt.Sprintf("97000000-0000-7000-8000-%012d", index)
		insertFinalizedCleanupUsage(t, pool, operationID,
			now.Add(-workspace.AIUsageRetentionDuration-time.Duration(index)*time.Microsecond), true)
	}

	start := make(chan struct{})
	type workerResult struct {
		result applicationcleanup.Result
		err    error
	}
	results := make(chan workerResult, 2)
	workerCtx, cancelWorkers := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancelWorkers()
	for range 2 {
		go func() {
			<-start
			result, err := applicationcleanup.NewService(NewCleanupRepository(pool)).Execute(workerCtx, now, 2)
			results <- workerResult{result: result, err: err}
		}()
	}
	close(start)
	var deleted int64
	for range 2 {
		select {
		case result := <-results:
			if result.err != nil {
				t.Fatal(result.err)
			}
			deleted += result.result.AIUsageEvents.DeletedCount
		case <-workerCtx.Done():
			t.Fatalf("parallel cleanup workers did not finish: %v", workerCtx.Err())
		}
	}
	if deleted != total {
		t.Fatalf("parallel workers deleted = %d, want %d", deleted, total)
	}
	assertCleanupTableCounts(t, pool, 0, 0)
}

func TestCleanupBatchFailureRollsBackAndRerunCompletes(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(11 * 24 * time.Hour)
	insertCleanupUser(t, pool, now)
	firstID := "98000000-0000-7000-8000-000000000001"
	secondID := "98000000-0000-7000-8000-000000000002"
	insertFinalizedCleanupUsage(t, pool, firstID, now.Add(-workspace.AIUsageRetentionDuration-time.Minute), true)
	insertFinalizedCleanupUsage(t, pool, secondID, now.Add(-workspace.AIUsageRetentionDuration-time.Minute), true)

	const triggerName = "trg_test_cleanup_batch_failure"
	const functionName = "test_cleanup_batch_failure"
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DROP TRIGGER IF EXISTS "+triggerName+" ON ai_usage_events")
		_, _ = pool.Exec(context.Background(), "DROP FUNCTION IF EXISTS "+functionName+"()")
	})
	_, err := pool.Exec(t.Context(), `CREATE FUNCTION test_cleanup_batch_failure()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation_id = '98000000-0000-7000-8000-000000000002'::uuid THEN
    RAISE EXCEPTION 'test cleanup batch failure';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER trg_test_cleanup_batch_failure
BEFORE DELETE ON ai_usage_events
FOR EACH ROW EXECUTE FUNCTION test_cleanup_batch_failure()`)
	if err != nil {
		t.Fatal(err)
	}

	service := applicationcleanup.NewService(NewCleanupRepository(pool))
	result, err := service.Execute(t.Context(), now, 1)
	if err == nil ||
		result.AIUsageEvents != (applicationcleanup.ResourceResult{CandidateCount: 1, DeletedCount: 1, BatchCount: 1}) {
		t.Fatalf("partially completed cleanup result/error = %+v/%v", result, err)
	}
	assertCleanupTableCounts(t, pool, 1, 0)
	assertCleanupUsageExists(t, pool, firstID, false)
	assertCleanupUsageExists(t, pool, secondID, true)

	if _, err = pool.Exec(t.Context(), "DROP TRIGGER "+triggerName+" ON ai_usage_events"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(t.Context(), "DROP FUNCTION "+functionName+"()"); err != nil {
		t.Fatal(err)
	}
	rerun, err := service.Execute(t.Context(), now, 1)
	if err != nil || rerun.AIUsageEvents.DeletedCount != 1 || rerun.AIUsageEvents.BatchCount != 1 {
		t.Fatalf("rerun result/error = %+v/%v", rerun, err)
	}
}

func TestCleanupSkipsUsageLockedByGoalDelete(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(12 * 24 * time.Hour)
	const (
		userID      = "9a000000-0000-7000-8000-000000000001"
		operationID = "9b000000-0000-7000-8000-000000000001"
		deleteKey   = "9c000000-0000-7000-8000-000000000001"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	seedStore := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, seedStore, userID, fixture, 2, now.Add(-48*time.Hour))
	insertFinalizedGoalDeleteUsage(t, pool, operationID, userID, fixture.goalID,
		now.Add(-workspace.AIUsageRetentionDuration), now.Add(-time.Minute))
	if _, err := pool.Exec(t.Context(), `UPDATE ai_usage_events
SET content_deleted=TRUE WHERE operation_id=$1`, operationID); err != nil {
		t.Fatal(err)
	}

	barrier := newCleanupGoalDeleteBarrier()
	defer barrier.release()
	deleteStore := newAIConcurrencyTracedStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deleteCalls := make(chan error, 1)
	go func() {
		deleteCalls <- executeGoalDeleteUseCase(
			deleteStore, ctx, userID, fixture.goalID, true, started.Goal.Revision, deleteKey, now,
		)
	}()

	select {
	case lockErr := <-barrier.usageLocked:
		if lockErr != nil {
			t.Fatalf("Goal Delete usage lock: %v", lockErr)
		}
	case deleteErr := <-deleteCalls:
		t.Fatalf("Goal Delete returned before cleanup overlap: %v", deleteErr)
	case <-ctx.Done():
		t.Fatalf("Goal Delete did not lock Usage: %v", ctx.Err())
	}

	type batchResult struct {
		deleted int64
		err     error
	}
	finished := make(chan batchResult, 1)
	go func() {
		deleted, deleteErr := NewCleanupRepository(pool).DeleteAIUsageEventsBatch(ctx, now, 1)
		finished <- batchResult{deleted: deleted, err: deleteErr}
	}()
	select {
	case result := <-finished:
		if result.err != nil || result.deleted != 0 {
			t.Fatalf("cleanup while Goal Delete holds Usage = %+v", result)
		}
	case <-ctx.Done():
		t.Fatalf("cleanup waited on Goal Delete instead of SKIP LOCKED: %v", ctx.Err())
	}

	barrier.release()
	select {
	case deleteErr := <-deleteCalls:
		if deleteErr != nil {
			t.Fatalf("Goal Delete: %v", deleteErr)
		}
	case <-ctx.Done():
		t.Fatalf("Goal Delete did not finish: %v", ctx.Err())
	}
	deleted, err := NewCleanupRepository(pool).DeleteAIUsageEventsBatch(t.Context(), now, 1)
	if err != nil || deleted != 0 {
		t.Fatalf("cleanup after Goal Delete commit = %d/%v", deleted, err)
	}
	assertCleanupUsageExists(t, pool, operationID, false)
}

func TestCleanupSkipsUsageLockedByAccountDelete(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(12 * 24 * time.Hour)
	insertCleanupUser(t, pool, now)
	operationID := "99000000-0000-7000-8000-000000000001"
	insertFinalizedCleanupUsage(t, pool, operationID, now.Add(-workspace.AIUsageRetentionDuration-time.Minute), true)

	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if tag, deleteErr := tx.Exec(t.Context(), `DELETE FROM users WHERE id=$1`, cleanupUserID); deleteErr != nil || tag.RowsAffected() != 1 {
		t.Fatalf("account delete = %d/%v", tag.RowsAffected(), deleteErr)
	}

	type batchResult struct {
		deleted int64
		err     error
	}
	finished := make(chan batchResult, 1)
	cleanupCtx, cancelCleanup := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancelCleanup()
	go func() {
		deleted, deleteErr := NewCleanupRepository(pool).DeleteAIUsageEventsBatch(cleanupCtx, now, 1)
		finished <- batchResult{deleted: deleted, err: deleteErr}
	}()
	select {
	case result := <-finished:
		if result.err != nil || result.deleted != 0 {
			t.Fatalf("cleanup while account delete holds usage = %+v", result)
		}
	case <-cleanupCtx.Done():
		t.Fatalf("cleanup waited on account-delete cascade instead of SKIP LOCKED: %v", cleanupCtx.Err())
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertCleanupTableCounts(t, pool, 0, 0)
}

func insertCleanupUser(t *testing.T, pool *pgxpool.Pool, now time.Time) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, cleanupUserID, now); err != nil {
		t.Fatal(err)
	}
}

func insertFinalizedCleanupUsage(
	t *testing.T,
	pool *pgxpool.Pool,
	operationID string,
	acceptedAt time.Time,
	contentDeleted bool,
) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,
 provider_usage_finalized_at,quota_retain_until,content_deleted)
VALUES($1,$2,'goal_refine','succeeded','fake','test','goal-v2',$3,$3,$4,$5)`,
		operationID, cleanupUserID, acceptedAt, acceptedAt.Add(workspace.AIUsageRetentionDuration), contentDeleted); err != nil {
		t.Fatal(err)
	}
}

func insertPendingCleanupUsage(
	t *testing.T,
	pool *pgxpool.Pool,
	operationID string,
	idempotencyKey string,
	acceptedAt time.Time,
	contentDeleted bool,
) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `INSERT INTO goal_drafts
(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','cleanup pending',$3,$3)
ON CONFLICT (user_id) WHERE draft_type='creation' DO NOTHING`,
		cleanupDraftID, cleanupUserID, acceptedAt); err != nil {
		t.Fatal(err)
	}
	month := time.Date(acceptedAt.UTC().Year(), acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(t.Context(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
 provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'goal_refine','running',$3,0,$4,$5,'cleanup pending','fake','test','goal-v2',$6,0.01,$7,$8)`,
		operationID, cleanupUserID, cleanupDraftID, idempotencyKey, integrationAIRequestHash, month,
		acceptedAt.Add(time.Hour), acceptedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until,content_deleted)
VALUES($1,$2,'goal_refine','accepted','fake','test','goal-v2',$3,$4,$5)`,
		operationID, cleanupUserID, acceptedAt, acceptedAt.Add(workspace.AIUsageRetentionDuration), contentDeleted); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `DELETE FROM ai_generations WHERE id=$1`, operationID); err != nil {
		t.Fatal(err)
	}
}

func finalizeLateCleanupUsage(t *testing.T, pool *pgxpool.Pool, operationID string, finalizedAt time.Time) int64 {
	t.Helper()
	tag, err := pool.Exec(t.Context(), `UPDATE ai_usage_events
SET status='failed',input_tokens=0,output_tokens=0,estimated_cost_usd=0,provider_usage_finalized_at=$2
WHERE operation_id=$1 AND provider_usage_finalized_at IS NULL`,
		operationID, finalizedAt)
	if err != nil {
		t.Fatal(err)
	}
	return tag.RowsAffected()
}

func insertCleanupBucket(t *testing.T, pool *pgxpool.Pool, scope string, keyHash []byte, windowStart, expiresAt time.Time) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `INSERT INTO abuse_rate_buckets(scope,key_hash,window_start,request_count,expires_at)
VALUES($1,$2,$3,1,$4)`, scope, keyHash, windowStart, expiresAt); err != nil {
		t.Fatal(err)
	}
}

func assertCleanupTableCounts(t *testing.T, pool *pgxpool.Pool, wantUsage, wantBuckets int) {
	t.Helper()
	var usage, buckets int
	if err := pool.QueryRow(t.Context(), `SELECT
(SELECT count(*) FROM ai_usage_events),
(SELECT count(*) FROM abuse_rate_buckets)`).Scan(&usage, &buckets); err != nil {
		t.Fatal(err)
	}
	if usage != wantUsage || buckets != wantBuckets {
		t.Fatalf("cleanup table counts = usage:%d buckets:%d, want %d/%d", usage, buckets, wantUsage, wantBuckets)
	}
}

func assertCleanupUsageExists(t *testing.T, pool *pgxpool.Pool, operationID string, want bool) {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(t.Context(), `SELECT EXISTS(
SELECT 1 FROM ai_usage_events WHERE operation_id=$1)`, operationID).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists != want {
		t.Fatalf("usage %s exists = %t, want %t", operationID, exists, want)
	}
}
