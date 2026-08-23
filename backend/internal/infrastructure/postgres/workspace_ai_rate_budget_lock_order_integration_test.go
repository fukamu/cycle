package postgres

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

type aiRateBudgetLockCommandContextKey struct{}

type aiRateBudgetLockCommand uint8

const (
	aiRateBudgetExpiredRecovery aiRateBudgetLockCommand = iota + 1
	aiRateBudgetFreshReservation
)

type aiRateBudgetLockQueryContextKey struct{}

type aiRateBudgetLockQueryTrace struct {
	pid uint32
}

type aiRateBudgetLockBarrier struct {
	recoveryAfterBudget chan uint32
	releaseRecovery     chan struct{}
	freshBudgetAttempt  chan uint32
	traceErrors         chan error

	recoveryOnce sync.Once
	releaseOnce  sync.Once
	freshOnce    sync.Once
}

func newAIRateBudgetLockBarrier() *aiRateBudgetLockBarrier {
	return &aiRateBudgetLockBarrier{
		recoveryAfterBudget: make(chan uint32, 1),
		releaseRecovery:     make(chan struct{}),
		freshBudgetAttempt:  make(chan uint32, 1),
		traceErrors:         make(chan error, 2),
	}
}

func (barrier *aiRateBudgetLockBarrier) TraceQueryStart(
	ctx context.Context,
	connection *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	switch ctx.Value(aiRateBudgetLockCommandContextKey{}) {
	case aiRateBudgetExpiredRecovery:
		if isAIExpiredBudgetRelease(data.SQL) {
			return context.WithValue(ctx, aiRateBudgetLockQueryContextKey{}, aiRateBudgetLockQueryTrace{
				pid: connection.PgConn().PID(),
			})
		}
	case aiRateBudgetFreshReservation:
		if isAIBudgetMonthEnsure(data.SQL) {
			barrier.freshOnce.Do(func() {
				barrier.freshBudgetAttempt <- connection.PgConn().PID()
			})
		}
	}
	return ctx
}

func (barrier *aiRateBudgetLockBarrier) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryEndData,
) {
	query, ok := ctx.Value(aiRateBudgetLockQueryContextKey{}).(aiRateBudgetLockQueryTrace)
	if !ok {
		return
	}
	if data.Err != nil {
		barrier.reportTraceError(fmt.Errorf("expired recovery Budget release trace error: %w", data.Err))
	}
	if affected := data.CommandTag.RowsAffected(); affected != 1 {
		barrier.reportTraceError(fmt.Errorf("expired recovery Budget release affected %d rows, want 1", affected))
	}
	barrier.recoveryOnce.Do(func() {
		barrier.recoveryAfterBudget <- query.pid
		select {
		case <-barrier.releaseRecovery:
		case <-ctx.Done():
		}
	})
}

func (barrier *aiRateBudgetLockBarrier) reportTraceError(err error) {
	select {
	case barrier.traceErrors <- err:
	default:
	}
}

func (barrier *aiRateBudgetLockBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseRecovery) })
}

func isAIExpiredBudgetRelease(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return stringsContainsAll(normalized,
		"update ai_budget_monthly",
		"reserved_cost_usd=reserved_cost_usd-$2::numeric",
		"where month_utc=$1",
	)
}

func isAIBudgetMonthEnsure(sql string) bool {
	normalized := normalizeAIConcurrencySQL(sql)
	return stringsContainsAll(normalized,
		"insert into ai_budget_monthly",
		"on conflict(month_utc) do nothing",
	)
}

func stringsContainsAll(value string, fragments ...string) bool {
	for _, fragment := range fragments {
		if !strings.Contains(value, fragment) {
			return false
		}
	}
	return true
}

type aiRateBudgetReservationCall struct {
	err error
}

func TestAIReservationLocksBudgetBeforeSharedRateBucketAfterExpiredRecovery(t *testing.T) {
	tests := []struct {
		name      string
		contender string
	}{
		{name: "Goal Refine", contender: "goal_refine"},
		{name: "Action", contender: "action_generate"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runAIRateBudgetLockOrderTest(t, test.contender)
		})
	}
}

func runAIRateBudgetLockOrderTest(t *testing.T, contender string) {
	t.Helper()

	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	const (
		recoveryUserID       = "10000000-0000-7000-8000-000000000091"
		freshUserID          = "10000000-0000-7000-8000-000000000092"
		recoveryDraftID      = "11000000-0000-7000-8000-000000000091"
		freshDraftID         = "11000000-0000-7000-8000-000000000092"
		expiredGenerationID  = "83000000-0000-7000-8000-000000000091"
		expiredKey           = "82000000-0000-7000-8000-000000000091"
		recoveryGenerationID = "83000000-0000-7000-8000-000000000092"
		recoveryKey          = "82000000-0000-7000-8000-000000000092"
		freshGenerationID    = "83000000-0000-7000-8000-000000000093"
		freshKey             = "82000000-0000-7000-8000-000000000093"
		sharedRemoteAddress  = "198.51.100.77"
	)
	for _, userID := range []string{recoveryUserID, freshUserID} {
		insertAIConcurrencyUser(t, pool, userID, now)
	}

	settings := aiConcurrencySettings()
	settings.AIPerIPMinute = 10
	seedStore := NewWorkspaceStore(pool, settings)
	if _, err := executeGoalDraftCreateUseCase(
		seedStore, context.Background(), recoveryUserID, recoveryDraftID, "期限切れ回復後に再実行する目標", now.Add(-3*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_budget_monthly
(month_utc,reserved_cost_usd,actual_cost_usd,unattributed_cost_usd,updated_at)
VALUES($1,0.01,0,0,$2)`, month, now.Add(-2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
 provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'goal_refine','running',$3,0,$4,'expired-request','期限切れの目標',
 'fake','test','goal-refine-v1',$5,0.01,$6,$7)`,
		expiredGenerationID, recoveryUserID, recoveryDraftID, expiredKey, month,
		now.Add(-time.Minute), now.Add(-2*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES($1,$2,'goal_refine','accepted','fake','test','goal-refine-v1',$3,$4)`,
		expiredGenerationID, recoveryUserID, now.Add(-2*time.Minute), now.Add(24*time.Hour),
	); err != nil {
		t.Fatal(err)
	}

	var actionFixture progressingGoalFixture
	switch contender {
	case "goal_refine":
		if _, err := executeGoalDraftCreateUseCase(
			seedStore, context.Background(), freshUserID, freshDraftID, "通常予約する別利用者の目標", now,
		); err != nil {
			t.Fatal(err)
		}
	case "action_generate":
		actionFixture = progressingGoalFixture{
			draftID: "11000000-0000-7000-8000-000000000094", goalID: "21000000-0000-7000-8000-000000000094",
			versionID: "31000000-0000-7000-8000-000000000094", cycleID: "41000000-0000-7000-8000-000000000094",
			operationID: "51000000-0000-7000-8000-000000000094", body: "通常Action予約する別利用者の目標",
		}
		startProgressingGoal(t, seedStore, freshUserID, actionFixture, 2, now)
		if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles
SET plan='P',do_text='D',check_text='C',content_revision=3,
    plan_revision=1,do_revision=1,check_revision=1
WHERE id=$1`, mustUUID(actionFixture.cycleID)); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unknown contender %q", contender)
	}

	barrier := newAIRateBudgetLockBarrier()
	store := newAIConcurrencyTracedStore(t, pool, settings, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	recoveryCalls := make(chan aiRateBudgetReservationCall, 1)
	recoveryCtx := context.WithValue(ctx, aiRateBudgetLockCommandContextKey{}, aiRateBudgetExpiredRecovery)
	go func() {
		_, callErr := executeGoalRefineBeginUseCase(store, recoveryCtx, workspace.GoalRefineInput{
			UserID: recoveryUserID, DraftID: recoveryDraftID, ExpectedDraftRevision: 0,
			IdempotencyKey: recoveryKey, GenerationID: recoveryGenerationID,
			RemoteAddress: sharedRemoteAddress, Now: now,
		}, passthroughAIContext)
		recoveryCalls <- aiRateBudgetReservationCall{err: callErr}
	}()

	var recoveryPID uint32
	select {
	case recoveryPID = <-barrier.recoveryAfterBudget:
	case call := <-recoveryCalls:
		t.Fatalf("expired recovery returned before Budget barrier: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("expired recovery did not reach Budget barrier: %v", ctx.Err())
	}

	freshCalls := make(chan aiRateBudgetReservationCall, 1)
	freshCtx := context.WithValue(ctx, aiRateBudgetLockCommandContextKey{}, aiRateBudgetFreshReservation)
	go func() {
		var callErr error
		switch contender {
		case "goal_refine":
			_, callErr = executeGoalRefineBeginUseCase(store, freshCtx, workspace.GoalRefineInput{
				UserID: freshUserID, DraftID: freshDraftID, ExpectedDraftRevision: 0,
				IdempotencyKey: freshKey, GenerationID: freshGenerationID,
				RemoteAddress: sharedRemoteAddress, Now: now,
			}, passthroughAIContext)
		case "action_generate":
			_, callErr = store.BeginActionAI(freshCtx, workspace.ActionAIInput{
				UserID: freshUserID, GoalID: actionFixture.goalID, CycleID: actionFixture.cycleID,
				Operation: "action_generate", ExpectedContentRevision: 3,
				IdempotencyKey: freshKey, GenerationID: freshGenerationID,
				RemoteAddress: sharedRemoteAddress, Now: now,
			}, passthroughAIContext)
		}
		freshCalls <- aiRateBudgetReservationCall{err: callErr}
	}()

	var freshPID uint32
	select {
	case freshPID = <-barrier.freshBudgetAttempt:
	case call := <-freshCalls:
		t.Fatalf("fresh reservation returned before Budget attempt: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("fresh reservation did not attempt Budget lock: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, freshPID, recoveryPID); err != nil {
		t.Fatalf("fresh reservation did not wait for expired recovery Budget lock: %v", err)
	}

	barrier.release()
	recoveryCall := receiveAIConcurrencyCall(t, ctx, recoveryCalls, "expired recovery reservation")
	freshCall := receiveAIConcurrencyCall(t, ctx, freshCalls, "fresh reservation")
	select {
	case traceErr := <-barrier.traceErrors:
		t.Fatal(traceErr)
	default:
	}
	if recoveryCall.err != nil || freshCall.err != nil {
		t.Fatalf("Budget/rate lock order deadlocked recovery/fresh reservations: %v / %v", recoveryCall.err, freshCall.err)
	}

	var (
		failedGenerations  int
		runningGenerations int
		failedUsage        int
		acceptedUsage      int
		budgetReserved     float64
		rateCount          int
	)
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM ai_generations WHERE status='failed'),
(SELECT count(*) FROM ai_generations WHERE status='running'),
(SELECT count(*) FROM ai_usage_events WHERE status='failed'),
(SELECT count(*) FROM ai_usage_events WHERE status='accepted'),
(SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$1),
(SELECT request_count FROM abuse_rate_buckets WHERE scope='ai_ip_minute')`, month).Scan(
		&failedGenerations, &runningGenerations, &failedUsage, &acceptedUsage, &budgetReserved, &rateCount,
	); err != nil {
		t.Fatal(err)
	}
	if failedGenerations != 1 || runningGenerations != 2 || failedUsage != 1 || acceptedUsage != 2 ||
		!approximatelyEqual(budgetReserved, 2*settings.ReservationUSD) || rateCount != 2 {
		t.Fatalf("post-lock-order state generations failed/running=%d/%d usage failed/accepted=%d/%d Budget=%.8f rate=%d",
			failedGenerations, runningGenerations, failedUsage, acceptedUsage, budgetReserved, rateCount)
	}
}
