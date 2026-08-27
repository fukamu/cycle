package postgres

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

func TestUUIDStringReturnsEmptyForNullUUID(t *testing.T) {
	if got := uuidString(pgtype.UUID{}); got != "" {
		t.Fatalf("uuidString(null) = %q, want empty string", got)
	}
}

type aiConcurrencyCommandContextKey struct{}

type aiConcurrencyCommand uint8

const (
	aiConcurrencyReviewBegin aiConcurrencyCommand = iota + 1
	aiConcurrencyReviewSave
	aiConcurrencyExpiredRecoveryBegin
	aiConcurrencyExpiredFinish
	aiConcurrencyAbandon
	aiConcurrencyCreationBegin
	aiConcurrencyCreationReserveBegin
	aiConcurrencyBlockedAbandon
	aiConcurrencyGoalDelete
	aiConcurrencyDeletedFinish
)

type aiConcurrencyQueryContextKey struct{}

type aiConcurrencyQueryTrace struct {
	pid uint32
}

type aiConcurrencyReviewBarrier struct {
	beginAfterFirstLock chan uint32
	releaseBegin        chan struct{}
	savePID             chan uint32

	beginOnce   sync.Once
	releaseOnce sync.Once
	saveOnce    sync.Once
}

func newAIConcurrencyReviewBarrier() *aiConcurrencyReviewBarrier {
	return &aiConcurrencyReviewBarrier{
		beginAfterFirstLock: make(chan uint32, 1),
		releaseBegin:        make(chan struct{}),
		savePID:             make(chan uint32, 1),
	}
}

func (barrier *aiConcurrencyReviewBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch ctx.Value(aiConcurrencyCommandContextKey{}) {
	case aiConcurrencyReviewBegin:
		if isReviewGoalOrDraftLock(data.SQL) {
			return context.WithValue(ctx, aiConcurrencyQueryContextKey{}, aiConcurrencyQueryTrace{pid: connection.PgConn().PID()})
		}
	case aiConcurrencyReviewSave:
		if isReviewGoalLock(data.SQL) {
			barrier.saveOnce.Do(func() { barrier.savePID <- connection.PgConn().PID() })
		}
	}
	return ctx
}

func (barrier *aiConcurrencyReviewBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	query, ok := ctx.Value(aiConcurrencyQueryContextKey{}).(aiConcurrencyQueryTrace)
	if !ok {
		return
	}
	barrier.beginOnce.Do(func() {
		barrier.beginAfterFirstLock <- query.pid
		select {
		case <-barrier.releaseBegin:
		case <-ctx.Done():
		}
	})
}

func (barrier *aiConcurrencyReviewBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseBegin) })
}

type aiConcurrencyExpiredRecoveryBarrier struct {
	recoveryAfterGenerationLock chan uint32
	releaseRecovery             chan struct{}
	finishUserLock              chan uint32
	traceErrors                 chan error

	recoveryOnce sync.Once
	releaseOnce  sync.Once
	finishOnce   sync.Once
}

func newAIConcurrencyExpiredRecoveryBarrier() *aiConcurrencyExpiredRecoveryBarrier {
	return &aiConcurrencyExpiredRecoveryBarrier{
		recoveryAfterGenerationLock: make(chan uint32, 1),
		releaseRecovery:             make(chan struct{}),
		finishUserLock:              make(chan uint32, 1),
		traceErrors:                 make(chan error, 2),
	}
}

func (barrier *aiConcurrencyExpiredRecoveryBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	state, _ := ctx.Value(aiConcurrencyLateFinishContextKey{}).(*aiConcurrencyLateFinishState)
	switch ctx.Value(aiConcurrencyCommandContextKey{}) {
	case aiConcurrencyExpiredRecoveryBegin:
		if isExpiredRecoveryGenerationLock(data.SQL) {
			return context.WithValue(ctx, aiConcurrencyQueryContextKey{}, aiConcurrencyQueryTrace{pid: connection.PgConn().PID()})
		}
	case aiConcurrencyExpiredFinish:
		if state != nil && isAIGenerationByIDLookup(data.SQL) {
			state.lookupStarted.CompareAndSwap(false, true)
		}
		if state != nil && state.lookupStarted.Load() && isAIUserLock(data.SQL) {
			barrier.finishOnce.Do(func() { barrier.finishUserLock <- connection.PgConn().PID() })
		}
	}
	return ctx
}

func (barrier *aiConcurrencyExpiredRecoveryBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	query, ok := ctx.Value(aiConcurrencyQueryContextKey{}).(aiConcurrencyQueryTrace)
	if !ok {
		return
	}
	if data.Err != nil {
		barrier.reportTraceError(fmt.Errorf("expired recovery generation lock trace error: %w", data.Err))
	}
	if affected := data.CommandTag.RowsAffected(); affected != 1 {
		barrier.reportTraceError(fmt.Errorf("expired recovery generation lock affected %d rows, want 1", affected))
	}
	barrier.recoveryOnce.Do(func() {
		barrier.recoveryAfterGenerationLock <- query.pid
		select {
		case <-barrier.releaseRecovery:
		case <-ctx.Done():
		}
	})
}

func (barrier *aiConcurrencyExpiredRecoveryBarrier) reportTraceError(err error) {
	select {
	case barrier.traceErrors <- err:
	default:
	}
}

func (barrier *aiConcurrencyExpiredRecoveryBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseRecovery) })
}

type aiConcurrencyAbandonBarrier struct {
	abandonAfterRunningCheck chan uint32
	releaseAbandon           chan struct{}
	beginPID                 chan uint32

	abandonOnce sync.Once
	releaseOnce sync.Once
	beginOnce   sync.Once
}

func newAIConcurrencyAbandonBarrier() *aiConcurrencyAbandonBarrier {
	return &aiConcurrencyAbandonBarrier{
		abandonAfterRunningCheck: make(chan uint32, 1),
		releaseAbandon:           make(chan struct{}),
		beginPID:                 make(chan uint32, 1),
	}
}

func (barrier *aiConcurrencyAbandonBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch ctx.Value(aiConcurrencyCommandContextKey{}) {
	case aiConcurrencyAbandon:
		if isAbandonRunningCheck(data.SQL) {
			return context.WithValue(ctx, aiConcurrencyQueryContextKey{}, aiConcurrencyQueryTrace{pid: connection.PgConn().PID()})
		}
	case aiConcurrencyCreationBegin:
		barrier.beginOnce.Do(func() { barrier.beginPID <- connection.PgConn().PID() })
	}
	return ctx
}

func (barrier *aiConcurrencyAbandonBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	query, ok := ctx.Value(aiConcurrencyQueryContextKey{}).(aiConcurrencyQueryTrace)
	if !ok {
		return
	}
	barrier.abandonOnce.Do(func() {
		barrier.abandonAfterRunningCheck <- query.pid
		select {
		case <-barrier.releaseAbandon:
		case <-ctx.Done():
		}
	})
}

func (barrier *aiConcurrencyAbandonBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseAbandon) })
}

type aiConcurrencyBeginWinsAbandonBarrier struct {
	beginAfterUsageInsert chan uint32
	releaseBegin          chan struct{}
	abandonUserLock       chan uint32
	traceErrors           chan error

	beginOnce   sync.Once
	releaseOnce sync.Once
	abandonOnce sync.Once
}

func newAIConcurrencyBeginWinsAbandonBarrier() *aiConcurrencyBeginWinsAbandonBarrier {
	return &aiConcurrencyBeginWinsAbandonBarrier{
		beginAfterUsageInsert: make(chan uint32, 1),
		releaseBegin:          make(chan struct{}),
		abandonUserLock:       make(chan uint32, 1),
		traceErrors:           make(chan error, 2),
	}
}

func (barrier *aiConcurrencyBeginWinsAbandonBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch ctx.Value(aiConcurrencyCommandContextKey{}) {
	case aiConcurrencyCreationReserveBegin:
		if isAIUsageReservationInsert(data.SQL) {
			return context.WithValue(ctx, aiConcurrencyQueryContextKey{}, aiConcurrencyQueryTrace{pid: connection.PgConn().PID()})
		}
	case aiConcurrencyBlockedAbandon:
		if isAIUserLock(data.SQL) {
			barrier.abandonOnce.Do(func() { barrier.abandonUserLock <- connection.PgConn().PID() })
		}
	}
	return ctx
}

func (barrier *aiConcurrencyBeginWinsAbandonBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	query, ok := ctx.Value(aiConcurrencyQueryContextKey{}).(aiConcurrencyQueryTrace)
	if !ok {
		return
	}
	if data.Err != nil {
		barrier.reportTraceError(fmt.Errorf("Goal Refine usage reservation trace error: %w", data.Err))
	}
	if affected := data.CommandTag.RowsAffected(); affected != 1 {
		barrier.reportTraceError(fmt.Errorf("Goal Refine usage reservation affected %d rows, want 1", affected))
	}
	barrier.beginOnce.Do(func() {
		barrier.beginAfterUsageInsert <- query.pid
		select {
		case <-barrier.releaseBegin:
		case <-ctx.Done():
		}
	})
}

func (barrier *aiConcurrencyBeginWinsAbandonBarrier) reportTraceError(err error) {
	select {
	case barrier.traceErrors <- err:
	default:
	}
}

func (barrier *aiConcurrencyBeginWinsAbandonBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseBegin) })
}

type aiConcurrencyLateFinishContextKey struct{}

type aiConcurrencyLateFinishState struct {
	lookupStarted    atomic.Bool
	userLockReported atomic.Bool
}

type aiConcurrencyGoalDeleteBarrier struct {
	deleteAfterGenerationLock chan uint32
	releaseDelete             chan struct{}
	finishUserLocks           chan uint32
	traceErrors               chan error

	deleteOnce  sync.Once
	releaseOnce sync.Once
}

func newAIConcurrencyGoalDeleteBarrier() *aiConcurrencyGoalDeleteBarrier {
	return &aiConcurrencyGoalDeleteBarrier{
		deleteAfterGenerationLock: make(chan uint32, 1),
		releaseDelete:             make(chan struct{}),
		finishUserLocks:           make(chan uint32, 2),
		traceErrors:               make(chan error, 3),
	}
}

func (barrier *aiConcurrencyGoalDeleteBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	state, _ := ctx.Value(aiConcurrencyLateFinishContextKey{}).(*aiConcurrencyLateFinishState)
	switch ctx.Value(aiConcurrencyCommandContextKey{}) {
	case aiConcurrencyGoalDelete:
		if isGoalDeleteGenerationLock(data.SQL) {
			return context.WithValue(ctx, aiConcurrencyQueryContextKey{}, aiConcurrencyQueryTrace{pid: connection.PgConn().PID()})
		}
	case aiConcurrencyDeletedFinish:
		if state != nil && isAIGenerationByIDLookup(data.SQL) {
			state.lookupStarted.CompareAndSwap(false, true)
		}
		if state != nil && state.lookupStarted.Load() && isAIUserLock(data.SQL) &&
			state.userLockReported.CompareAndSwap(false, true) {
			barrier.finishUserLocks <- connection.PgConn().PID()
		}
	}
	return ctx
}

func (barrier *aiConcurrencyGoalDeleteBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	query, ok := ctx.Value(aiConcurrencyQueryContextKey{}).(aiConcurrencyQueryTrace)
	if !ok {
		return
	}
	if data.Err != nil {
		barrier.reportTraceError(fmt.Errorf("Goal Delete generation lock trace error: %w", data.Err))
	}
	if affected := data.CommandTag.RowsAffected(); affected != 1 {
		barrier.reportTraceError(fmt.Errorf("Goal Delete generation lock affected %d rows, want 1", affected))
	}
	barrier.deleteOnce.Do(func() {
		barrier.deleteAfterGenerationLock <- query.pid
		select {
		case <-barrier.releaseDelete:
		case <-ctx.Done():
		}
	})
}

func (barrier *aiConcurrencyGoalDeleteBarrier) reportTraceError(err error) {
	select {
	case barrier.traceErrors <- err:
	default:
	}
}

func (barrier *aiConcurrencyGoalDeleteBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseDelete) })
}

type aiGoalRefineCall struct {
	snapshot workspace.AISnapshot
	err      error
}

type aiDraftCall struct {
	draft workspace.DraftView
	err   error
}

type aiResponseCall struct {
	response workspace.AIResponse
	err      error
}

func aiConcurrencySettings() aiIntegrationApplicationSettings {
	rateHashKey := []byte("test-rate-key")
	return aiIntegrationApplicationSettings{
		Entitlements: workspace.Entitlements{MaxAIOperationsPer24Hours: 20},
		GoalDraft: workspace.GoalDraftUseCaseSettings{
			Provider: "fake", Model: "test", GoalPromptVersion: "goal-refine-v1",
			MonthlyBudgetUSD: 100, ReservationUSD: 0.01, LeaseDuration: time.Minute,
			RateHashKey: append([]byte(nil), rateHashKey...),
		},
		ActionAI: workspace.ActionAIUseCaseSettings{
			Provider: "fake", Model: "test",
			GeneratePromptVersion: "action-generate-v1", RefinePromptVersion: "action-refine-v1",
			MonthlyBudgetUSD: 100, ReservationUSD: 0.01, LeaseDuration: time.Minute,
			RateHashKey: append([]byte(nil), rateHashKey...),
		},
	}
}

func newAIConcurrencyTracedStore(t *testing.T, pool *pgxpool.Pool, tracer pgx.QueryTracer) *WorkspaceStore {
	t.Helper()
	config := pool.Config()
	config.ConnConfig.Tracer = tracer
	config.MinConns = 0
	config.MaxConns = 3
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tracedPool.Close)
	return NewWorkspaceStore(tracedPool)
}

func insertAIConcurrencyUser(t *testing.T, pool *pgxpool.Pool, userID string, now time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
}

func seedRunningActionAI(t *testing.T, pool *pgxpool.Pool, store *WorkspaceStore, userID string, now time.Time, settings aiIntegrationApplicationSettings) (progressingGoalFixture, workspace.StartGoalResult, workspace.AISnapshot) {
	t.Helper()
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, userID, fixture, 2, now)
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',
content_revision=3,plan_revision=1,do_revision=1,check_revision=1 WHERE id=$1`, fixture.cycleID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := executeActionGenerateBeginUseCaseWithSettings(store, context.Background(), workspace.ActionGenerateInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ExpectedContentRevision: 3,
		IdempotencyKey:          "82000000-0000-7000-8000-000000000001",
		GenerationID:            "83000000-0000-7000-8000-000000000001",
		Now:                     now.Add(time.Minute),
	}, passthroughAIContext, settings)
	if err != nil {
		t.Fatal(err)
	}
	return fixture, started, snapshot
}

func TestBeginActionAISameKeyExpiredRunningCommitsLeaseRecoveryBeforeReplay(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	seedStore := NewWorkspaceStore(pool)
	fixture, _, expiredSnapshot := seedRunningActionAI(t, pool, seedStore, userID, now, settings)

	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='期限切れ待機中の追記',
content_revision=content_revision+1,plan_revision=plan_revision+1,updated_at=$2 WHERE id=$1`, fixture.cycleID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}

	retrySettings := settings
	retrySettings.ActionAI.AIPerUserMinute = 10
	retrySettings.ActionAI.AIPerSessionMinute = 10
	retrySettings.ActionAI.AIPerIPMinute = 10
	retryStore := NewWorkspaceStore(pool)
	input := workspace.ActionGenerateInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ExpectedContentRevision: 3,
		IdempotencyKey:          "82000000-0000-7000-8000-000000000001",
		SessionID:               "same-key-expired-session", RemoteAddress: "198.51.100.88",
	}

	unexpired := input
	unexpired.GenerationID = "83000000-0000-7000-8000-000000000002"
	unexpired.Now = now.Add(90 * time.Second)
	_, err := executeActionGenerateBeginUseCaseWithSettings(retryStore, context.Background(), unexpired, nil, retrySettings)
	var inProgress *workspace.AIOperationInProgressError
	if !errors.As(err, &inProgress) || inProgress.GenerationID != expiredSnapshot.GenerationID {
		t.Fatalf("unexpired same-key replay error = %v, want in-progress generation %s", err, expiredSnapshot.GenerationID)
	}

	different := input
	different.GenerationID = "83000000-0000-7000-8000-000000000003"
	different.ConfirmReplace = true
	different.Now = now.Add(3 * time.Minute)
	if _, err = executeActionGenerateBeginUseCaseWithSettings(retryStore, context.Background(), different, nil, retrySettings); !errors.Is(err, workspace.ErrIdempotencyKeyReused) {
		t.Fatalf("expired different-hash replay error = %v, want %v", err, workspace.ErrIdempotencyKeyReused)
	}

	expired := input
	expired.GenerationID = "83000000-0000-7000-8000-000000000004"
	expired.Now = now.Add(3 * time.Minute)
	if _, err = executeActionGenerateBeginUseCaseWithSettings(retryStore, context.Background(), expired, nil, retrySettings); !errors.Is(err, workspace.ErrAIProviderUnavailable) {
		t.Fatalf("expired same-key replay error = %v, want %v after committed lease recovery", err, workspace.ErrAIProviderUnavailable)
	}

	recoveredReplay := expired
	recoveredReplay.Now = now.Add(4 * time.Minute)
	if _, err = executeActionGenerateBeginUseCaseWithSettings(retryStore, context.Background(), recoveredReplay, nil, retrySettings); !errors.Is(err, workspace.ErrAIProviderUnavailable) {
		t.Fatalf("recovered terminal same-key replay error = %v, want %v", err, workspace.ErrAIProviderUnavailable)
	}

	month := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	var (
		generationStatus      string
		generationFailure     string
		generationReservation float64
		leaseCleared          bool
		finished              bool
		usageStatus           string
		usageFinalized        bool
		settlementMonth       time.Time
		settlementReservation string
		budgetReserved        float64
		rateCount             int
		generationCount       int
		usageCount            int
	)
	if err = pool.QueryRow(context.Background(), `SELECT
(SELECT status FROM ai_generations WHERE id=$1),
(SELECT failure_code FROM ai_generations WHERE id=$1),
(SELECT budget_reserved_cost_usd FROM ai_generations WHERE id=$1),
(SELECT lease_expires_at IS NULL FROM ai_generations WHERE id=$1),
(SELECT finished_at IS NOT NULL FROM ai_generations WHERE id=$1),
(SELECT status FROM ai_usage_events WHERE operation_id=$1),
(SELECT provider_usage_finalized_at IS NOT NULL FROM ai_usage_events WHERE operation_id=$1),
(SELECT settlement_budget_month_utc FROM ai_usage_events WHERE operation_id=$1),
(SELECT settlement_reservation_cost_usd::text FROM ai_usage_events WHERE operation_id=$1),
(SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$2),
(SELECT count(*) FROM abuse_rate_buckets
 WHERE scope IN ('ai_user_minute','ai_session_minute','ai_ip_minute')),
(SELECT count(*) FROM ai_generations),
(SELECT count(*) FROM ai_usage_events)`, expiredSnapshot.GenerationID, month).Scan(
		&generationStatus, &generationFailure, &generationReservation, &leaseCleared, &finished,
		&usageStatus, &usageFinalized, &settlementMonth, &settlementReservation,
		&budgetReserved, &rateCount, &generationCount, &usageCount,
	); err != nil {
		t.Fatal(err)
	}
	if generationStatus != "failed" || generationFailure != "lease_expired" ||
		!approximatelyEqual(generationReservation, 0) || !leaseCleared || !finished {
		t.Fatalf("expired generation = status %s, failure %s, reserved %.8f, leaseCleared %t, finished %t",
			generationStatus, generationFailure, generationReservation, leaseCleared, finished)
	}
	if usageStatus != "failed" || usageFinalized || !settlementMonth.Equal(month) ||
		settlementReservation != "0.01000000" || !approximatelyEqual(budgetReserved, 0) ||
		rateCount != 0 || generationCount != 1 || usageCount != 1 {
		t.Fatalf("expired replay state = usage %s/finalized=%t, Budget %.8f, rate/generation/usage counts %d/%d/%d",
			usageStatus, usageFinalized, budgetReserved, rateCount, generationCount, usageCount)
	}
}

func passthroughAIContext(_ context.Context, snapshot workspace.AISnapshot) (workspace.AISnapshot, error) {
	snapshot.CanonicalProviderInputHash = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	return snapshot, nil
}

func receiveAIConcurrencyCall[T any](t *testing.T, ctx context.Context, calls <-chan T, name string) T {
	t.Helper()
	select {
	case call := <-calls:
		return call
	case <-ctx.Done():
		t.Fatalf("%s did not finish: %v", name, ctx.Err())
		var zero T
		return zero
	}
}

func isReviewGoalOrDraftLock(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return strings.Contains(normalized, "for update") &&
		(strings.Contains(normalized, "from goal_drafts") || strings.Contains(normalized, "from goals g"))
}

func isReviewGoalLock(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return strings.Contains(normalized, "for update") &&
		(strings.Contains(normalized, "from goals where id=$1 and user_id=$2") ||
			strings.Contains(normalized, "from goals g"))
}

func isExpiredRecoveryGenerationLock(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return strings.Contains(normalized, "from ai_generations") &&
		strings.Contains(normalized, "where user_id=$1 and status='running' and lease_expires_at<=$2") &&
		strings.Contains(normalized, "for update")
}

func isGoalDeleteGenerationLock(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return strings.Contains(normalized, "from ai_generations") &&
		strings.Contains(normalized, "where user_id=$1 and goal_id=$2 and status='running'") &&
		strings.Contains(normalized, "order by id for update")
}

func isAIUserLock(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return strings.Contains(normalized, "select id from users where id=$1 for update")
}

func isAIUsageReservationInsert(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return strings.Contains(normalized, "insert into ai_usage_events") &&
		strings.Contains(normalized, "operation_id,user_id,goal_id,operation_type,status") &&
		strings.Contains(normalized, "values (") && strings.Contains(normalized, "'accepted'")
}

func isAbandonRunningCheck(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return strings.Contains(normalized, "from ai_generations") &&
		strings.Contains(normalized, "source_goal_draft_id=$2") &&
		(strings.Contains(normalized, "status='running'") || strings.Contains(normalized, "for update"))
}

func isAIGenerationByIDLookup(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return strings.Contains(normalized, "from ai_generations") && strings.Contains(normalized, "where id=$1")
}

func normalizeAIConcurrencySQL(sql string) string {
	return normalizeObservedSQL(sql)
}

func approximatelyEqual(left, right float64) bool {
	return math.Abs(left-right) < 0.000000001
}

func TestDeleteGoalRollsBackWhenBudgetReservationReleaseAffectsZeroRows(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	store := NewWorkspaceStore(pool)
	fixture, started, snapshot := seedRunningActionAI(t, pool, store, userID, now, settings)
	if _, err := pool.Exec(context.Background(), `UPDATE ai_budget_monthly SET reserved_cost_usd=0
WHERE month_utc=$1`, time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}

	err := executeGoalDeleteUseCase(
		store,
		context.Background(),
		userID,
		fixture.goalID,
		true,
		started.Goal.Revision,
		"84000000-0000-7000-8000-000000000001",
		now.Add(2*time.Minute),
	)
	if err == nil {
		t.Fatal("DeleteGoal succeeded after its budget reservation release affected zero rows")
	}

	var (
		goalCount             int
		generationStatus      string
		generationReservation float64
		usageStatus           string
		usageContentDeleted   bool
		usageGoalID           *string
		receiptCount          int
		budgetReserved        float64
		budgetActual          float64
	)
	err = pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goals WHERE id=$1 AND user_id=$2),
(SELECT status FROM ai_generations WHERE id=$3),
(SELECT budget_reserved_cost_usd FROM ai_generations WHERE id=$3),
(SELECT status FROM ai_usage_events WHERE operation_id=$3),
(SELECT content_deleted FROM ai_usage_events WHERE operation_id=$3),
(SELECT goal_id::text FROM ai_usage_events WHERE operation_id=$3),
(SELECT count(*) FROM goal_delete_receipts WHERE user_id=$2 AND idempotency_key=$4),
(SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$5),
(SELECT actual_cost_usd FROM ai_budget_monthly WHERE month_utc=$5)`,
		fixture.goalID,
		userID,
		snapshot.GenerationID,
		"84000000-0000-7000-8000-000000000001",
		time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC),
	).Scan(
		&goalCount,
		&generationStatus,
		&generationReservation,
		&usageStatus,
		&usageContentDeleted,
		&usageGoalID,
		&receiptCount,
		&budgetReserved,
		&budgetActual,
	)
	if err != nil {
		t.Fatal(err)
	}
	if goalCount != 1 || generationStatus != "running" || !approximatelyEqual(generationReservation, settings.ActionAI.ReservationUSD) {
		t.Fatalf("rollback goal/generation = count %d, status %s, reservation %.8f", goalCount, generationStatus, generationReservation)
	}
	if usageStatus != "accepted" || usageContentDeleted || usageGoalID == nil || *usageGoalID != fixture.goalID {
		t.Fatalf("rollback usage = status %s, contentDeleted %t, goal %v", usageStatus, usageContentDeleted, usageGoalID)
	}
	if receiptCount != 0 || !approximatelyEqual(budgetReserved, 0) || !approximatelyEqual(budgetActual, 0) {
		t.Fatalf("rollback receipt/budget = %d, reserved %.8f, actual %.8f", receiptCount, budgetReserved, budgetActual)
	}
}

func TestDeleteGoalReleasesThreeExactDecimalReservationsWithoutFloatAggregation(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, userID, fixture, 2, now)
	extraCycles := []struct {
		id          string
		sequence    int
		operationID string
	}{
		{id: "41000000-0000-7000-8000-000000000011", sequence: 2, operationID: "51000000-0000-7000-8000-000000000011"},
		{id: "41000000-0000-7000-8000-000000000012", sequence: 3, operationID: "51000000-0000-7000-8000-000000000012"},
	}
	for _, extra := range extraCycles {
		if _, err := pool.Exec(context.Background(), `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,canceled_at,cancellation_reason,
start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,$5,'canceled',$6,$6,'goal_ended',$7,$8,$6,$6)`,
			extra.id,
			userID,
			fixture.goalID,
			fixture.versionID,
			extra.sequence,
			now,
			extra.operationID,
			"seed-"+extra.operationID,
		); err != nil {
			t.Fatal(err)
		}
	}

	month := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_budget_monthly
(month_utc,reserved_cost_usd,actual_cost_usd,unattributed_cost_usd,updated_at)
VALUES($1,0.30000000,0,0,$2)`, month, now); err != nil {
		t.Fatal(err)
	}
	generations := []struct {
		id             string
		cycleID        string
		idempotencyKey string
	}{
		{id: "85000000-0000-7000-8000-000000000001", cycleID: fixture.cycleID, idempotencyKey: "86000000-0000-7000-8000-000000000001"},
		{id: "85000000-0000-7000-8000-000000000002", cycleID: extraCycles[0].id, idempotencyKey: "86000000-0000-7000-8000-000000000002"},
		{id: "85000000-0000-7000-8000-000000000003", cycleID: extraCycles[1].id, idempotencyKey: "86000000-0000-7000-8000-000000000003"},
	}
	for _, generation := range generations {
		if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,goal_id,goal_version_id,cycle_id,target_revision,
idempotency_key,input_hash,source_text,provider,model,prompt_version,budget_month_utc,
budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'action_generate','running',NULL,$3,$4,$5,0,$6,$7,NULL,$8,$9,$10,$11,
0.10000000,$12,$13)`,
			generation.id,
			userID,
			fixture.goalID,
			fixture.versionID,
			generation.cycleID,
			generation.idempotencyKey,
			integrationAIRequestHash,
			settings.ActionAI.Provider,
			settings.ActionAI.Model,
			settings.ActionAI.GeneratePromptVersion,
			month,
			now.Add(10*time.Minute),
			now,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(context.Background(), `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES($1,$2,$3,'action_generate','accepted',$4,$5,$6,$7,$8)`,
			generation.id,
			userID,
			fixture.goalID,
			settings.ActionAI.Provider,
			settings.ActionAI.Model,
			settings.ActionAI.GeneratePromptVersion,
			now,
			now.Add(24*time.Hour),
		); err != nil {
			t.Fatal(err)
		}
	}

	deleteKey := "87000000-0000-7000-8000-000000000001"
	if err := executeGoalDeleteUseCase(
		store,
		context.Background(),
		userID,
		fixture.goalID,
		true,
		started.Goal.Revision,
		deleteKey,
		now.Add(2*time.Minute),
	); err != nil {
		t.Fatalf("DeleteGoal with three exact 0.1 reservations: %v", err)
	}

	var (
		goalCount, generationCount, usageCount int
		failedUsageCount                       int
		deletedUsageCount                      int
		detachedUsageCount                     int
		unfinalizedUsageCount                  int
		receiptCount                           int
		budgetReservedExactlyZero              bool
		budgetActualExactlyZero                bool
	)
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goals WHERE id=$1),
(SELECT count(*) FROM ai_generations WHERE id IN ($2,$3,$4)),
(SELECT count(*) FROM ai_usage_events WHERE operation_id IN ($2,$3,$4)),
(SELECT count(*) FROM ai_usage_events WHERE operation_id IN ($2,$3,$4) AND status='failed'),
(SELECT count(*) FROM ai_usage_events WHERE operation_id IN ($2,$3,$4) AND content_deleted),
(SELECT count(*) FROM ai_usage_events WHERE operation_id IN ($2,$3,$4) AND goal_id IS NULL),
(SELECT count(*) FROM ai_usage_events WHERE operation_id IN ($2,$3,$4) AND provider_usage_finalized_at IS NULL),
(SELECT count(*) FROM goal_delete_receipts WHERE user_id=$5 AND idempotency_key=$6),
(SELECT reserved_cost_usd=0::numeric FROM ai_budget_monthly WHERE month_utc=$7),
(SELECT actual_cost_usd=0::numeric FROM ai_budget_monthly WHERE month_utc=$7)`,
		fixture.goalID,
		generations[0].id,
		generations[1].id,
		generations[2].id,
		userID,
		deleteKey,
		month,
	).Scan(
		&goalCount,
		&generationCount,
		&usageCount,
		&failedUsageCount,
		&deletedUsageCount,
		&detachedUsageCount,
		&unfinalizedUsageCount,
		&receiptCount,
		&budgetReservedExactlyZero,
		&budgetActualExactlyZero,
	); err != nil {
		t.Fatal(err)
	}
	if goalCount != 0 || generationCount != 0 || usageCount != 3 ||
		failedUsageCount != 3 || deletedUsageCount != 3 || detachedUsageCount != 3 ||
		unfinalizedUsageCount != 3 || receiptCount != 1 ||
		!budgetReservedExactlyZero || !budgetActualExactlyZero {
		t.Fatalf("three-reservation delete state = goal/gen/usage %d/%d/%d, failed/deleted/detached/unfinalized %d/%d/%d/%d, receipt %d, budget zero %t/%t",
			goalCount, generationCount, usageCount, failedUsageCount, deletedUsageCount, detachedUsageCount,
			unfinalizedUsageCount, receiptCount, budgetReservedExactlyZero, budgetActualExactlyZero)
	}
}

func TestFinishActionAIRollsBackWhenUsageFinalizationAffectsZeroRows(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	store := NewWorkspaceStore(pool)
	fixture, _, snapshot := seedRunningActionAI(t, pool, store, userID, now, settings)
	if _, err := pool.Exec(context.Background(), `DELETE FROM ai_usage_events WHERE operation_id=$1`, snapshot.GenerationID); err != nil {
		t.Fatal(err)
	}

	result := workspace.AIExecutionResult{
		Output: "次に行うこと", Attempts: 1,
		Usage: workspace.AIUsage{
			InputTokens: 10, OutputTokens: 4,
			CostUSD: 0.004, ProviderRequestID: "provider-zero-row-usage",
		},
	}
	_, err := executeActionFinishUseCaseWithSettings(store, context.Background(), snapshot, result, nil, now.Add(2*time.Minute), settings)
	if err == nil {
		t.Fatal("FinishActionAI succeeded after its usage finalization affected zero rows")
	}

	var (
		action                string
		contentRevision       int64
		actionRevision        int64
		generationStatus      string
		generationOutput      *string
		generationReservation float64
		generationFinishedAt  *time.Time
		usageCount            int
		budgetReserved        float64
		budgetActual          float64
	)
	err = pool.QueryRow(context.Background(), `SELECT
(SELECT action FROM pdca_cycles WHERE id=$1),
(SELECT content_revision FROM pdca_cycles WHERE id=$1),
(SELECT action_revision FROM pdca_cycles WHERE id=$1),
(SELECT status FROM ai_generations WHERE id=$2),
(SELECT output FROM ai_generations WHERE id=$2),
(SELECT budget_reserved_cost_usd FROM ai_generations WHERE id=$2),
(SELECT finished_at FROM ai_generations WHERE id=$2),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$2),
(SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$3),
(SELECT actual_cost_usd FROM ai_budget_monthly WHERE month_utc=$3)`,
		fixture.cycleID,
		snapshot.GenerationID,
		time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC),
	).Scan(
		&action,
		&contentRevision,
		&actionRevision,
		&generationStatus,
		&generationOutput,
		&generationReservation,
		&generationFinishedAt,
		&usageCount,
		&budgetReserved,
		&budgetActual,
	)
	if err != nil {
		t.Fatal(err)
	}
	if action != "" || contentRevision != 3 || actionRevision != 0 {
		t.Fatalf("cycle partially applied AI action=%q content/action revisions=%d/%d", action, contentRevision, actionRevision)
	}
	if generationStatus != "running" || generationOutput != nil || generationFinishedAt != nil ||
		!approximatelyEqual(generationReservation, settings.ActionAI.ReservationUSD) {
		t.Fatalf("generation did not roll back: status=%s output=%v reservation=%.8f finishedAt=%v",
			generationStatus, generationOutput, generationReservation, generationFinishedAt)
	}
	if usageCount != 0 || !approximatelyEqual(budgetReserved, settings.ActionAI.ReservationUSD) || !approximatelyEqual(budgetActual, 0) {
		t.Fatalf("usage/budget after rollback = usage %d, reserved %.8f, actual %.8f", usageCount, budgetReserved, budgetActual)
	}
}

func TestReviewGoalRefineAndSaveUseGoalBeforeDraftLockOrder(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	seedStore := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, seedStore, userID, fixture, 2, now)
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',action='A',
content_revision=4,plan_revision=1,do_revision=1,check_revision=1,action_revision=1 WHERE id=$1`, fixture.cycleID); err != nil {
		t.Fatal(err)
	}
	completed, err := executeCycleCompleteUseCase(seedStore, context.Background(), workspace.CompleteCycleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		OperationID:             "62000000-0000-7000-8000-000000000001",
		ExpectedGoalRevision:    started.Goal.Revision,
		ExpectedContentRevision: 4,
	}, now.Add(time.Minute), "61000000-0000-7000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}

	barrier := newAIConcurrencyReviewBarrier()
	store := newAIConcurrencyTracedStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	goalRevision := completed.Goal.Revision
	beginCalls := make(chan aiGoalRefineCall, 1)
	beginCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyReviewBegin)
	go func() {
		snapshot, callErr := executeGoalRefineBeginUseCaseWithSettings(store, beginCtx, workspace.GoalRefineInput{
			UserID: userID, GoalID: fixture.goalID,
			ExpectedDraftRevision: completed.ReviewDraft.Revision,
			ExpectedGoalRevision:  &goalRevision,
			IdempotencyKey:        "63000000-0000-7000-8000-000000000001",
			GenerationID:          "64000000-0000-7000-8000-000000000001",
			Now:                   now.Add(2 * time.Minute),
		}, passthroughAIContext, settings)
		beginCalls <- aiGoalRefineCall{snapshot: snapshot, err: callErr}
	}()

	var beginPID uint32
	select {
	case beginPID = <-barrier.beginAfterFirstLock:
	case call := <-beginCalls:
		t.Fatalf("BeginGoalRefine returned before its first Review lock barrier: snapshot=%#v error=%v", call.snapshot, call.err)
	case <-ctx.Done():
		t.Fatalf("BeginGoalRefine did not reach its first Review lock barrier: %v", ctx.Err())
	}

	saveCalls := make(chan aiDraftCall, 1)
	saveCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyReviewSave)
	go func() {
		draft, callErr := executeGoalReviewSaveUseCase(store,
			saveCtx,
			userID,
			fixture.goalID,
			completed.ReviewDraft.ID,
			"利用者が保存した目標",
			completed.ReviewDraft.Revision,
			now.Add(3*time.Minute),
		)
		saveCalls <- aiDraftCall{draft: draft, err: callErr}
	}()

	var savePID uint32
	select {
	case savePID = <-barrier.savePID:
	case call := <-saveCalls:
		t.Fatalf("SaveReview returned before issuing its Goal lock: draft=%#v error=%v", call.draft, call.err)
	case <-ctx.Done():
		t.Fatalf("SaveReview did not issue its Goal lock: %v", ctx.Err())
	}
	blocked := make(chan error, 1)
	go func() { blocked <- waitForBlockedBackend(ctx, pool, savePID, beginPID) }()
	select {
	case call := <-saveCalls:
		t.Fatalf("SaveReview completed before BeginGoalRefine released its first lock: draft=%#v error=%v", call.draft, call.err)
	case blockErr := <-blocked:
		if blockErr != nil {
			t.Fatalf("SaveReview did not wait for BeginGoalRefine: %v", blockErr)
		}
	case <-ctx.Done():
		t.Fatalf("SaveReview blocking state was not observed: %v", ctx.Err())
	}

	barrier.release()
	beginCall := receiveAIConcurrencyCall(t, ctx, beginCalls, "BeginGoalRefine")
	saveCall := receiveAIConcurrencyCall(t, ctx, saveCalls, "SaveReview")
	if beginCall.err != nil {
		t.Fatalf("BeginGoalRefine error = %v", beginCall.err)
	}
	if saveCall.err != nil {
		t.Fatalf("SaveReview error = %v", saveCall.err)
	}
	if beginCall.snapshot.GenerationID != "64000000-0000-7000-8000-000000000001" ||
		saveCall.draft.Body != "利用者が保存した目標" || saveCall.draft.Revision != completed.ReviewDraft.Revision+1 {
		t.Fatalf("serialized Begin/Save results = snapshot %#v, draft %#v", beginCall.snapshot, saveCall.draft)
	}
}

func TestBeginGoalRefineReviewStaleDraftUsesReviewRevisionConflict(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, userID, fixture, 2, now)
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',action='A',
content_revision=4,plan_revision=1,do_revision=1,check_revision=1,action_revision=1 WHERE id=$1`, fixture.cycleID); err != nil {
		t.Fatal(err)
	}
	completed, err := executeCycleCompleteUseCase(store, context.Background(), workspace.CompleteCycleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		OperationID:             "62000000-0000-7000-8000-000000000001",
		ExpectedGoalRevision:    started.Goal.Revision,
		ExpectedContentRevision: 4,
	}, now.Add(time.Minute), "61000000-0000-7000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := executeGoalReviewSaveUseCase(store,
		context.Background(),
		userID,
		fixture.goalID,
		completed.ReviewDraft.ID,
		"保存後のReview目標",
		completed.ReviewDraft.Revision,
		now.Add(2*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != completed.ReviewDraft.Revision+1 {
		t.Fatalf("saved Review revision = %d, want %d", saved.Revision, completed.ReviewDraft.Revision+1)
	}

	goalRevision := completed.Goal.Revision
	_, err = executeGoalRefineBeginUseCaseWithSettings(store, context.Background(), workspace.GoalRefineInput{
		UserID: userID, GoalID: fixture.goalID,
		ExpectedDraftRevision: completed.ReviewDraft.Revision,
		ExpectedGoalRevision:  &goalRevision,
		IdempotencyKey:        "67000000-0000-7000-8000-000000000001",
		GenerationID:          "68000000-0000-7000-8000-000000000001",
		Now:                   now.Add(3 * time.Minute),
	}, passthroughAIContext, settings)
	if !errors.Is(err, workspace.ErrReviewRevisionConflict) {
		t.Fatalf("BeginGoalRefine stale Review error = %v, want %v", err, workspace.ErrReviewRevisionConflict)
	}
	if errors.Is(err, workspace.ErrDraftRevisionConflict) {
		t.Fatalf("BeginGoalRefine stale Review error = %v, must not use creation Draft conflict", err)
	}

	var generationCount, usageCount, budgetCount int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM ai_generations WHERE id=$1),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$1),
(SELECT count(*) FROM ai_budget_monthly)`,
		"68000000-0000-7000-8000-000000000001",
	).Scan(&generationCount, &usageCount, &budgetCount); err != nil {
		t.Fatal(err)
	}
	if generationCount != 0 || usageCount != 0 || budgetCount != 0 {
		t.Fatalf("stale Review side effects = generation/usage/budget %d/%d/%d",
			generationCount, usageCount, budgetCount)
	}
}

func TestExpiredRecoveryWinsBeforeLateActionFinalizationWithoutApplyingOldResult(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	seedStore := NewWorkspaceStore(pool)
	expiredFixture, _, expiredSnapshot := seedRunningActionAI(t, pool, seedStore, userID, now, settings)
	recoveryFixture := progressingGoalFixtures()[1]
	startProgressingGoal(t, seedStore, userID, recoveryFixture, 2, now)
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P2',do_text='D2',check_text='C2',
content_revision=3,plan_revision=1,do_revision=1,check_revision=1 WHERE id=$1`, recoveryFixture.cycleID); err != nil {
		t.Fatal(err)
	}

	barrier := newAIConcurrencyExpiredRecoveryBarrier()
	store := newAIConcurrencyTracedStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	beginCalls := make(chan aiGoalRefineCall, 1)
	beginCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyExpiredRecoveryBegin)
	go func() {
		nextSnapshot, callErr := executeActionGenerateBeginUseCaseWithSettings(store, beginCtx, workspace.ActionGenerateInput{
			UserID: userID, GoalID: recoveryFixture.goalID, CycleID: recoveryFixture.cycleID,
			ExpectedContentRevision: 3,
			IdempotencyKey:          "82000000-0000-7000-8000-000000000002",
			GenerationID:            "83000000-0000-7000-8000-000000000002",
			Now:                     now.Add(3 * time.Minute),
		}, passthroughAIContext, settings)
		beginCalls <- aiGoalRefineCall{snapshot: nextSnapshot, err: callErr}
	}()

	var recoveryPID uint32
	select {
	case recoveryPID = <-barrier.recoveryAfterGenerationLock:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("expired recovery barrier: %v", traceErr)
	case call := <-beginCalls:
		t.Fatalf("BeginActionAI returned before locking the expired Generation: snapshot=%#v error=%v", call.snapshot, call.err)
	case <-ctx.Done():
		t.Fatalf("BeginActionAI did not lock the expired Generation: %v", ctx.Err())
	}

	result := workspace.AIExecutionResult{
		Output: "期限切れ後には適用しない行動", Attempts: 1,
		Usage: workspace.AIUsage{
			InputTokens: 12, OutputTokens: 5,
			CostUSD: 0.004, ProviderRequestID: "provider-after-expired-recovery",
		},
	}
	finishCalls := make(chan aiResponseCall, 1)
	finishState := &aiConcurrencyLateFinishState{}
	finishCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyExpiredFinish)
	finishCtx = context.WithValue(finishCtx, aiConcurrencyLateFinishContextKey{}, finishState)
	go func() {
		response, callErr := executeActionFinishUseCaseWithSettings(store, finishCtx, expiredSnapshot, result, nil, now.Add(4*time.Minute), settings)
		finishCalls <- aiResponseCall{response: response, err: callErr}
	}()

	var finishPID uint32
	select {
	case finishPID = <-barrier.finishUserLock:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("expired recovery barrier: %v", traceErr)
	case call := <-finishCalls:
		t.Fatalf("FinishActionAI returned before waiting for the recovery User lock: response=%#v error=%v", call.response, call.err)
	case <-ctx.Done():
		t.Fatalf("FinishActionAI did not issue its User lock after the stale Generation locator: %v", ctx.Err())
	}
	blocked := make(chan error, 1)
	go func() { blocked <- waitForBlockedBackend(ctx, pool, finishPID, recoveryPID) }()
	select {
	case call := <-finishCalls:
		t.Fatalf("FinishActionAI completed before expired recovery released the User lock: response=%#v error=%v", call.response, call.err)
	case blockErr := <-blocked:
		if blockErr != nil {
			t.Fatalf("FinishActionAI did not wait for expired recovery: %v", blockErr)
		}
	case <-ctx.Done():
		t.Fatalf("FinishActionAI blocking state was not observed: %v", ctx.Err())
	}

	barrier.release()
	beginCall := receiveAIConcurrencyCall(t, ctx, beginCalls, "expired-recovery BeginActionAI")
	finishCall := receiveAIConcurrencyCall(t, ctx, finishCalls, "late FinishActionAI")
	if beginCall.err != nil {
		t.Fatalf("expired-recovery BeginActionAI error = %v", beginCall.err)
	}
	if beginCall.snapshot.GenerationID != "83000000-0000-7000-8000-000000000002" {
		t.Fatalf("recovery winner snapshot = %#v", beginCall.snapshot)
	}
	if !errors.Is(finishCall.err, workspace.ErrNotFound) {
		t.Fatalf("late FinishActionAI error = %v, want %v", finishCall.err, workspace.ErrNotFound)
	}
	select {
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("expired recovery barrier: %v", traceErr)
	default:
	}

	var (
		expiredAction                string
		expiredContentRevision       int64
		expiredGenerationStatus      string
		expiredGenerationFailure     string
		expiredGenerationReservation float64
		expiredUsageStatus           string
		expiredInputTokens           int64
		expiredOutputTokens          int64
		expiredUsageCost             float64
		expiredUsageFinalized        bool
		recoveryGenerationStatus     string
		recoveryGenerationReserved   float64
		recoveryUsageStatus          string
		budgetReserved               float64
		budgetActual                 float64
	)
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT action FROM pdca_cycles WHERE id=$1),
(SELECT content_revision FROM pdca_cycles WHERE id=$1),
(SELECT status FROM ai_generations WHERE id=$2),
(SELECT failure_code FROM ai_generations WHERE id=$2),
(SELECT budget_reserved_cost_usd FROM ai_generations WHERE id=$2),
(SELECT status FROM ai_usage_events WHERE operation_id=$2),
(SELECT input_tokens FROM ai_usage_events WHERE operation_id=$2),
(SELECT output_tokens FROM ai_usage_events WHERE operation_id=$2),
(SELECT estimated_cost_usd FROM ai_usage_events WHERE operation_id=$2),
(SELECT provider_usage_finalized_at IS NOT NULL FROM ai_usage_events WHERE operation_id=$2),
(SELECT status FROM ai_generations WHERE id=$3),
(SELECT budget_reserved_cost_usd FROM ai_generations WHERE id=$3),
(SELECT status FROM ai_usage_events WHERE operation_id=$3),
(SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$4),
(SELECT actual_cost_usd FROM ai_budget_monthly WHERE month_utc=$4)`,
		expiredFixture.cycleID,
		expiredSnapshot.GenerationID,
		"83000000-0000-7000-8000-000000000002",
		time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC),
	).Scan(
		&expiredAction,
		&expiredContentRevision,
		&expiredGenerationStatus,
		&expiredGenerationFailure,
		&expiredGenerationReservation,
		&expiredUsageStatus,
		&expiredInputTokens,
		&expiredOutputTokens,
		&expiredUsageCost,
		&expiredUsageFinalized,
		&recoveryGenerationStatus,
		&recoveryGenerationReserved,
		&recoveryUsageStatus,
		&budgetReserved,
		&budgetActual,
	); err != nil {
		t.Fatal(err)
	}
	if expiredAction != "" || expiredContentRevision != 3 ||
		expiredGenerationStatus != "failed" || expiredGenerationFailure != "lease_expired" ||
		!approximatelyEqual(expiredGenerationReservation, 0) {
		t.Fatalf("expired target/generation = action %q, revision %d, status %s, failure %s, reserved %.8f",
			expiredAction, expiredContentRevision, expiredGenerationStatus, expiredGenerationFailure, expiredGenerationReservation)
	}
	if expiredUsageStatus != "succeeded" || expiredInputTokens != result.Usage.InputTokens ||
		expiredOutputTokens != result.Usage.OutputTokens || !approximatelyEqual(expiredUsageCost, result.Usage.CostUSD) ||
		!expiredUsageFinalized {
		t.Fatalf("expired late usage = status %s, tokens %d/%d, cost %.8f, finalized %t",
			expiredUsageStatus, expiredInputTokens, expiredOutputTokens, expiredUsageCost, expiredUsageFinalized)
	}
	if recoveryGenerationStatus != "running" || !approximatelyEqual(recoveryGenerationReserved, settings.ActionAI.ReservationUSD) ||
		recoveryUsageStatus != "accepted" || !approximatelyEqual(budgetReserved, settings.ActionAI.ReservationUSD) ||
		!approximatelyEqual(budgetActual, result.Usage.CostUSD) {
		t.Fatalf("recovery winner/budget = status %s, generation reserved %.8f, usage %s, budget %.8f/%.8f",
			recoveryGenerationStatus, recoveryGenerationReserved, recoveryUsageStatus, budgetReserved, budgetActual)
	}
}

func TestAbandonDraftSerializesWithConcurrentGoalRefine(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID  = "10000000-0000-7000-8000-000000000001"
		draftID = "11000000-0000-7000-8000-000000000001"
	)
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	seedStore := NewWorkspaceStore(pool)
	if _, err := executeGoalDraftCreateUseCase(seedStore, context.Background(), userID, draftID, "並行破棄を検証する目標", now); err != nil {
		t.Fatal(err)
	}

	barrier := newAIConcurrencyAbandonBarrier()
	store := newAIConcurrencyTracedStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	abandonCalls := make(chan error, 1)
	abandonCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyAbandon)
	go func() {
		abandonCalls <- executeGoalDraftAbandonUseCase(store, abandonCtx, userID, draftID, now.Add(2*time.Minute))
	}()

	var abandonPID uint32
	select {
	case abandonPID = <-barrier.abandonAfterRunningCheck:
	case callErr := <-abandonCalls:
		t.Fatalf("AbandonDraft returned before its running check barrier: %v", callErr)
	case <-ctx.Done():
		t.Fatalf("AbandonDraft did not reach its running check barrier: %v", ctx.Err())
	}

	beginCalls := make(chan aiGoalRefineCall, 1)
	beginCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyCreationBegin)
	go func() {
		snapshot, callErr := executeGoalRefineBeginUseCaseWithSettings(store, beginCtx, workspace.GoalRefineInput{
			UserID:                userID,
			DraftID:               draftID,
			ExpectedDraftRevision: 0,
			IdempotencyKey:        "65000000-0000-7000-8000-000000000001",
			GenerationID:          "66000000-0000-7000-8000-000000000001",
			Now:                   now.Add(time.Minute),
		}, passthroughAIContext, settings)
		beginCalls <- aiGoalRefineCall{snapshot: snapshot, err: callErr}
	}()

	var beginPID uint32
	select {
	case beginPID = <-barrier.beginPID:
	case call := <-beginCalls:
		t.Fatalf("BeginGoalRefine returned before issuing a query: snapshot=%#v error=%v", call.snapshot, call.err)
	case <-ctx.Done():
		t.Fatalf("BeginGoalRefine did not issue a query: %v", ctx.Err())
	}

	blockCtx, cancelBlock := context.WithCancel(ctx)
	blocked := make(chan error, 1)
	go func() { blocked <- waitForBlockedBackend(blockCtx, pool, beginPID, abandonPID) }()
	var (
		beginCall            aiGoalRefineCall
		beginCompletedBefore bool
	)
	select {
	case beginCall = <-beginCalls:
		beginCompletedBefore = true
	case blockErr := <-blocked:
		if blockErr != nil {
			t.Fatalf("BeginGoalRefine did not wait for AbandonDraft: %v", blockErr)
		}
	case callErr := <-abandonCalls:
		t.Fatalf("AbandonDraft returned while its barrier was closed: %v", callErr)
	case <-ctx.Done():
		t.Fatalf("Begin/Abandon serialization was not observed: %v", ctx.Err())
	}
	cancelBlock()

	barrier.release()
	abandonErr := receiveAIConcurrencyCall(t, ctx, abandonCalls, "AbandonDraft")
	if !beginCompletedBefore {
		beginCall = receiveAIConcurrencyCall(t, ctx, beginCalls, "BeginGoalRefine")
	}
	if abandonErr != nil {
		t.Fatalf("AbandonDraft error = %v", abandonErr)
	}
	if beginCompletedBefore {
		t.Fatalf("BeginGoalRefine completed before the earlier AbandonDraft released its Draft scope: snapshot=%#v error=%v", beginCall.snapshot, beginCall.err)
	}
	if !errors.Is(beginCall.err, workspace.ErrNotFound) {
		t.Fatalf("BeginGoalRefine error = %v, want %v after AbandonDraft wins", beginCall.err, workspace.ErrNotFound)
	}

	var draftCount, generationCount, usageCount int
	var budgetReserved float64
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goal_drafts WHERE id=$1 AND user_id=$2),
(SELECT count(*) FROM ai_generations WHERE id=$3),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$3),
COALESCE((SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$4),0)`,
		draftID, userID, "66000000-0000-7000-8000-000000000001", time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC),
	).Scan(&draftCount, &generationCount, &usageCount, &budgetReserved); err != nil {
		t.Fatal(err)
	}
	if draftCount != 0 || generationCount != 0 || usageCount != 0 || !approximatelyEqual(budgetReserved, 0) {
		t.Fatalf("post-race draft/generation/usage/reserved = %d/%d/%d/%.8f", draftCount, generationCount, usageCount, budgetReserved)
	}
}

func TestGoalRefineCommitWinsBeforeAbandonAndPreservesRunningReservation(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID  = "10000000-0000-7000-8000-000000000001"
		draftID = "11000000-0000-7000-8000-000000000001"
	)
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	seedStore := NewWorkspaceStore(pool)
	if _, err := executeGoalDraftCreateUseCase(seedStore, context.Background(), userID, draftID, "先にRefine予約を確定する目標", now); err != nil {
		t.Fatal(err)
	}

	barrier := newAIConcurrencyBeginWinsAbandonBarrier()
	store := newAIConcurrencyTracedStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	const generationID = "69000000-0000-7000-8000-000000000001"
	beginCalls := make(chan aiGoalRefineCall, 1)
	beginCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyCreationReserveBegin)
	go func() {
		snapshot, callErr := executeGoalRefineBeginUseCaseWithSettings(store, beginCtx, workspace.GoalRefineInput{
			UserID:                userID,
			DraftID:               draftID,
			ExpectedDraftRevision: 0,
			IdempotencyKey:        "6a000000-0000-7000-8000-000000000001",
			GenerationID:          generationID,
			Now:                   now.Add(time.Minute),
		}, passthroughAIContext, settings)
		beginCalls <- aiGoalRefineCall{snapshot: snapshot, err: callErr}
	}()

	var beginPID uint32
	select {
	case beginPID = <-barrier.beginAfterUsageInsert:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Begin-first Abandon barrier: %v", traceErr)
	case call := <-beginCalls:
		t.Fatalf("BeginGoalRefine returned before pausing after its usage reservation: snapshot=%#v error=%v", call.snapshot, call.err)
	case <-ctx.Done():
		t.Fatalf("BeginGoalRefine did not reserve its usage: %v", ctx.Err())
	}

	abandonCalls := make(chan error, 1)
	abandonCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyBlockedAbandon)
	go func() {
		abandonCalls <- executeGoalDraftAbandonUseCase(store, abandonCtx, userID, draftID, now.Add(2*time.Minute))
	}()

	var abandonPID uint32
	select {
	case abandonPID = <-barrier.abandonUserLock:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Begin-first Abandon barrier: %v", traceErr)
	case callErr := <-abandonCalls:
		t.Fatalf("AbandonDraft returned before waiting for BeginGoalRefine: %v", callErr)
	case <-ctx.Done():
		t.Fatalf("AbandonDraft did not issue its User lock: %v", ctx.Err())
	}
	blocked := make(chan error, 1)
	go func() { blocked <- waitForBlockedBackend(ctx, pool, abandonPID, beginPID) }()
	select {
	case blockErr := <-blocked:
		if blockErr != nil {
			t.Fatalf("AbandonDraft did not wait for BeginGoalRefine: %v", blockErr)
		}
	case callErr := <-abandonCalls:
		t.Fatalf("AbandonDraft completed before BeginGoalRefine committed: %v", callErr)
	case <-ctx.Done():
		t.Fatalf("AbandonDraft blocking state was not observed: %v", ctx.Err())
	}

	barrier.release()
	beginCall := receiveAIConcurrencyCall(t, ctx, beginCalls, "BeginGoalRefine")
	if beginCall.err != nil || beginCall.snapshot.GenerationID != generationID {
		t.Fatalf("BeginGoalRefine result = snapshot %#v, error %v", beginCall.snapshot, beginCall.err)
	}
	abandonErr := receiveAIConcurrencyCall(t, ctx, abandonCalls, "AbandonDraft")
	if !errors.Is(abandonErr, workspace.ErrAIInProgress) {
		t.Fatalf("AbandonDraft error = %v, want %v", abandonErr, workspace.ErrAIInProgress)
	}
	select {
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Begin-first Abandon barrier: %v", traceErr)
	default:
	}

	var (
		draftCount            int
		draftRevision         int64
		draftBody             string
		generationStatus      string
		generationReservation float64
		usageStatus           string
		usageContentDeleted   bool
		budgetReserved        float64
		budgetActual          float64
	)
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goal_drafts WHERE id=$1 AND user_id=$2),
(SELECT revision FROM goal_drafts WHERE id=$1 AND user_id=$2),
(SELECT body FROM goal_drafts WHERE id=$1 AND user_id=$2),
(SELECT status FROM ai_generations WHERE id=$3),
(SELECT budget_reserved_cost_usd FROM ai_generations WHERE id=$3),
(SELECT status FROM ai_usage_events WHERE operation_id=$3),
(SELECT content_deleted FROM ai_usage_events WHERE operation_id=$3),
(SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$4),
(SELECT actual_cost_usd FROM ai_budget_monthly WHERE month_utc=$4)`,
		draftID,
		userID,
		generationID,
		time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC),
	).Scan(
		&draftCount,
		&draftRevision,
		&draftBody,
		&generationStatus,
		&generationReservation,
		&usageStatus,
		&usageContentDeleted,
		&budgetReserved,
		&budgetActual,
	); err != nil {
		t.Fatal(err)
	}
	if draftCount != 1 || draftRevision != 0 || draftBody != "先にRefine予約を確定する目標" ||
		generationStatus != "running" || !approximatelyEqual(generationReservation, settings.GoalDraft.ReservationUSD) ||
		usageStatus != "accepted" || usageContentDeleted ||
		!approximatelyEqual(budgetReserved, settings.GoalDraft.ReservationUSD) || !approximatelyEqual(budgetActual, 0) {
		t.Fatalf("Begin-first retained state = draft %d/%d/%q, generation %s/%.8f, usage %s/deleted=%t, budget %.8f/%.8f",
			draftCount, draftRevision, draftBody, generationStatus, generationReservation,
			usageStatus, usageContentDeleted, budgetReserved, budgetActual)
	}
}

func TestGoalDeleteLateProviderCallbacksSettleUsageExactlyOnce(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)

	settings := aiConcurrencySettings()
	seedStore := NewWorkspaceStore(pool)
	fixture, started, snapshot := seedRunningActionAI(t, pool, seedStore, userID, now, settings)
	deleteKey := "84000000-0000-7000-8000-000000000001"
	barrier := newAIConcurrencyGoalDeleteBarrier()
	store := newAIConcurrencyTracedStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	deleteCalls := make(chan error, 1)
	deleteCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyGoalDelete)
	go func() {
		deleteCalls <- executeGoalDeleteUseCase(
			store,
			deleteCtx,
			userID,
			fixture.goalID,
			true,
			started.Goal.Revision,
			deleteKey,
			now.Add(2*time.Minute),
		)
	}()

	var deletePID uint32
	select {
	case deletePID = <-barrier.deleteAfterGenerationLock:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Goal Delete overlap barrier: %v", traceErr)
	case callErr := <-deleteCalls:
		t.Fatalf("DeleteGoal returned before pausing after its running Generation lock: %v", callErr)
	case <-ctx.Done():
		t.Fatalf("DeleteGoal did not lock its running Generation: %v", ctx.Err())
	}

	result := workspace.AIExecutionResult{
		Output: "削除後には適用しない行動", Attempts: 1,
		Usage: workspace.AIUsage{
			InputTokens: 12, OutputTokens: 5,
			CostUSD: 0.004, ProviderRequestID: "provider-parallel-late-result",
		},
	}
	calls := make(chan aiResponseCall, 2)
	startCallback := func() {
		state := &aiConcurrencyLateFinishState{}
		finishCtx := context.WithValue(ctx, aiConcurrencyCommandContextKey{}, aiConcurrencyDeletedFinish)
		finishCtx = context.WithValue(finishCtx, aiConcurrencyLateFinishContextKey{}, state)
		go func() {
			response, callErr := executeActionFinishUseCaseWithSettings(store, finishCtx, snapshot, result, nil, now.Add(3*time.Minute), settings)
			calls <- aiResponseCall{response: response, err: callErr}
		}()
	}
	startCallback()

	var firstFinishPID uint32
	select {
	case firstFinishPID = <-barrier.finishUserLocks:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Goal Delete overlap barrier: %v", traceErr)
	case call := <-calls:
		t.Fatalf("first late callback returned before waiting on DeleteGoal after its stale locator: response=%#v error=%v", call.response, call.err)
	case <-ctx.Done():
		t.Fatalf("first late callback did not issue its User lock after its stale locator: %v", ctx.Err())
	}
	blocked := make(chan error, 1)
	go func() { blocked <- waitForBlockedBackend(ctx, pool, firstFinishPID, deletePID) }()
	select {
	case blockErr := <-blocked:
		if blockErr != nil {
			t.Fatalf("first late callback did not wait directly for DeleteGoal: %v", blockErr)
		}
	case call := <-calls:
		t.Fatalf("first late callback completed before DeleteGoal released its User lock: response=%#v error=%v", call.response, call.err)
	case <-ctx.Done():
		t.Fatalf("first late callback blocking state was not observed: %v", ctx.Err())
	}

	// Queue the duplicate callback only after the first callback is known to be
	// directly blocked by DeleteGoal. This preserves the real stale-locator race
	// without relying on PostgreSQL's soft-blocker ordering between two waiters.
	startCallback()
	select {
	case <-barrier.finishUserLocks:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Goal Delete overlap barrier: %v", traceErr)
	case call := <-calls:
		t.Fatalf("late callback returned before DeleteGoal committed: response=%#v error=%v", call.response, call.err)
	case <-ctx.Done():
		t.Fatalf("duplicate late callback did not issue its User lock after its stale locator: %v", ctx.Err())
	}

	barrier.release()
	if deleteErr := receiveAIConcurrencyCall(t, ctx, deleteCalls, "DeleteGoal"); deleteErr != nil {
		t.Fatalf("DeleteGoal error = %v", deleteErr)
	}
	for attempt := 0; attempt < 2; attempt++ {
		call := receiveAIConcurrencyCall(t, ctx, calls, fmt.Sprintf("late FinishActionAI %d", attempt+1))
		if !errors.Is(call.err, workspace.ErrNotFound) {
			t.Fatalf("late FinishActionAI %d error = %v, want %v", attempt+1, call.err, workspace.ErrNotFound)
		}
	}
	select {
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Goal Delete overlap barrier: %v", traceErr)
	default:
	}

	var (
		goalCount       int
		generationCount int
		usageStatus     string
		inputTokens     int64
		outputTokens    int64
		usageCost       float64
		usageFinalized  bool
		exposureCleared bool
		contentDeleted  bool
		goalDetached    bool
		receiptCount    int
		budgetReserved  float64
		budgetActual    float64
		unattributed    float64
	)
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goals WHERE id=$1),
(SELECT count(*) FROM ai_generations WHERE id=$2),
(SELECT status FROM ai_usage_events WHERE operation_id=$2),
(SELECT input_tokens FROM ai_usage_events WHERE operation_id=$2),
(SELECT output_tokens FROM ai_usage_events WHERE operation_id=$2),
(SELECT estimated_cost_usd FROM ai_usage_events WHERE operation_id=$2),
(SELECT provider_usage_finalized_at IS NOT NULL FROM ai_usage_events WHERE operation_id=$2),
(SELECT settlement_budget_month_utc IS NULL AND settlement_reservation_cost_usd IS NULL
 FROM ai_usage_events WHERE operation_id=$2),
(SELECT content_deleted FROM ai_usage_events WHERE operation_id=$2),
(SELECT goal_id IS NULL FROM ai_usage_events WHERE operation_id=$2),
(SELECT count(*) FROM goal_delete_receipts WHERE user_id=$3 AND idempotency_key=$4),
(SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$5),
(SELECT actual_cost_usd FROM ai_budget_monthly WHERE month_utc=$5),
(SELECT unattributed_cost_usd FROM ai_budget_monthly WHERE month_utc=$5)`,
		fixture.goalID, snapshot.GenerationID, userID, deleteKey, time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC),
	).Scan(
		&goalCount, &generationCount, &usageStatus, &inputTokens, &outputTokens, &usageCost,
		&usageFinalized, &exposureCleared, &contentDeleted, &goalDetached, &receiptCount,
		&budgetReserved, &budgetActual, &unattributed,
	); err != nil {
		t.Fatal(err)
	}
	if goalCount != 0 || generationCount != 0 || usageStatus != "succeeded" ||
		inputTokens != result.Usage.InputTokens || outputTokens != result.Usage.OutputTokens ||
		!approximatelyEqual(usageCost, result.Usage.CostUSD) || !usageFinalized || !exposureCleared || !contentDeleted || !goalDetached {
		t.Fatalf("late usage state = goal/gen %d/%d, status %s, tokens %d/%d, cost %.8f, finalized/deleted/detached %t/%t/%t",
			goalCount, generationCount, usageStatus, inputTokens, outputTokens, usageCost, usageFinalized, contentDeleted, goalDetached)
	}
	if receiptCount != 1 || !approximatelyEqual(budgetReserved, 0) ||
		!approximatelyEqual(budgetActual, result.Usage.CostUSD) || !approximatelyEqual(unattributed, 0) {
		t.Fatalf("late settlement receipt/reserved/actual/unattributed = %d/%.8f/%.8f/%.8f",
			receiptCount, budgetReserved, budgetActual, unattributed)
	}
}
