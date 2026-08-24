package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type cycleSaveAttemptContextKey struct{}

type cycleSaveQueryTracer struct{}

type cycleSaveAttemptTrace struct {
	barrier *cycleSaveConcurrencyBarrier
	leader  bool
	frame   cycle.Frame
}

type cycleSaveConcurrencyBarrier struct {
	leaderAtUpdate     chan uint32
	followerAtGoalLock chan uint32
	releaseLeader      chan struct{}
	leaderOnce         sync.Once
	followerOnce       sync.Once
	releaseOnce        sync.Once
}

func newCycleSaveConcurrencyBarrier() *cycleSaveConcurrencyBarrier {
	return &cycleSaveConcurrencyBarrier{
		leaderAtUpdate:     make(chan uint32, 1),
		followerAtGoalLock: make(chan uint32, 1),
		releaseLeader:      make(chan struct{}),
	}
}

func (*cycleSaveQueryTracer) TraceQueryStart(
	ctx context.Context,
	connection *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	attempt, ok := ctx.Value(cycleSaveAttemptContextKey{}).(cycleSaveAttemptTrace)
	if !ok || attempt.barrier == nil {
		return ctx
	}
	pid := connection.PgConn().PID()
	if attempt.leader && isCycleFrameSaveUpdate(data.SQL, attempt.frame) {
		attempt.barrier.leaderOnce.Do(func() { attempt.barrier.leaderAtUpdate <- pid })
		select {
		case <-attempt.barrier.releaseLeader:
		case <-ctx.Done():
		}
	} else if !attempt.leader && isCycleSaveGoalLock(data.SQL) {
		attempt.barrier.followerOnce.Do(func() { attempt.barrier.followerAtGoalLock <- pid })
	}
	return ctx
}

func (*cycleSaveQueryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
}

func (barrier *cycleSaveConcurrencyBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseLeader) })
}

func isCycleSaveGoalLock(sql string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(sql), " "))
	return strings.Contains(normalized, "select id,user_id,status,current_version_number") &&
		strings.Contains(normalized, "from goals") &&
		strings.Contains(normalized, "where id=$1 and user_id=$2") &&
		strings.Contains(normalized, "for update")
}

func isCycleFrameSaveUpdate(sql string, frame cycle.Frame) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(sql), " "))
	if !strings.HasPrefix(normalized, "update pdca_cycles set ") ||
		!strings.Contains(normalized, "where id=$1 and user_id=$2 and goal_id=$3 and status='active'") {
		return false
	}
	switch frame {
	case cycle.FramePlan:
		return strings.Contains(normalized, "set plan=$4,plan_revision=$5,content_revision=$6,updated_at=$7") &&
			strings.Contains(normalized, "and plan_revision=$8")
	case cycle.FrameDo:
		return strings.Contains(normalized, "set do_text=$4,do_revision=$5,content_revision=$6,updated_at=$7") &&
			strings.Contains(normalized, "and do_revision=$8")
	case cycle.FrameCheck:
		return strings.Contains(normalized, "set check_text=$4,check_revision=$5,content_revision=$6,updated_at=$7") &&
			strings.Contains(normalized, "and check_revision=$8")
	case cycle.FrameAction:
		return strings.Contains(normalized, "set action=$4,action_revision=$5,content_revision=$6,") &&
			strings.Contains(normalized, "and action_revision=$9")
	default:
		return false
	}
}

func TestCycleApplicationSerializesSameFrameAndAllowsDifferentFrames(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	_ = startProgressingGoal(t, store, userID, fixture, 2, now)
	tracedConfig := pool.Config()
	tracedConfig.ConnConfig.Tracer = &cycleSaveQueryTracer{}
	tracedConfig.MinConns = 0
	tracedConfig.MaxConns = 2
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), tracedConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer tracedPool.Close()
	useCases := newCycleApplicationTestUseCases(NewWorkspaceStore(tracedPool), now.Add(time.Minute))

	sameInputs := []workspace.SaveFrameInput{
		{UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID, Frame: cycle.FramePlan, Content: "同一Frame A", ExpectedFrameRevision: 0},
		{UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID, Frame: cycle.FramePlan, Content: "同一Frame B", ExpectedFrameRevision: 0},
	}
	sameErrors := runDeterministicConcurrentCycleSaves(t, pool, useCases, sameInputs)
	var success, conflict int
	for _, err := range sameErrors {
		switch {
		case err == nil:
			success++
		case errors.Is(err, cycle.ErrRevisionConflict):
			conflict++
		default:
			t.Fatalf("same-frame save error = %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("same-frame success/conflict = %d/%d", success, conflict)
	}
	current, err := useCases.GetCycle(context.Background(), userID, fixture.goalID, fixture.cycleID)
	if err != nil {
		t.Fatal(err)
	}

	differentInputs := []workspace.SaveFrameInput{
		{UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID, Frame: cycle.FrameDo, Content: current.Plan, ExpectedFrameRevision: 0},
		{UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID, Frame: cycle.FrameCheck, Content: current.Plan, ExpectedFrameRevision: 0},
	}
	for index, saveErr := range runDeterministicConcurrentCycleSaves(t, pool, useCases, differentInputs) {
		if saveErr != nil {
			t.Fatalf("different-frame save %d error = %v", index, saveErr)
		}
	}
	updated, err := useCases.GetCycle(context.Background(), userID, fixture.goalID, fixture.cycleID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.FrameRevisions.Plan != 1 || updated.FrameRevisions.Do != 1 || updated.FrameRevisions.Check != 1 ||
		updated.ContentRevision != 3 || updated.Do != updated.Plan || updated.Check != updated.Plan {
		t.Fatalf("different-frame Cycle = %#v", updated)
	}
}

func TestCycleApplicationCompleteReceiptAndRollbackInvariants(t *testing.T) {
	t.Run("success replay and reused operation", func(t *testing.T) {
		pool := integrationPool(t)
		resetDatabase(t, pool)
		now := integrationNow()
		const userID = "10000000-0000-7000-8000-000000000001"
		insertAIConcurrencyUser(t, pool, userID, now)
		store := NewWorkspaceStore(pool)
		fixture := progressingGoalFixtures()[0]
		started := startProgressingGoal(t, store, userID, fixture, 2, now)
		useCases := newCycleApplicationTestUseCases(store, now.Add(time.Minute),
			"71000000-0000-7000-8000-000000000001",
			"71000000-0000-7000-8000-000000000002",
			"71000000-0000-7000-8000-000000000003",
		)
		saveAllRequiredCycleFrames(t, useCases, userID, fixture)
		input := workspace.CompleteCycleInput{
			UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			OperationID:          "72000000-0000-7000-8000-000000000001",
			ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
		}
		completed, err := useCases.CompleteCycle(context.Background(), input)
		if err != nil || completed.CompletedCycle.Status != cycle.StatusCompleted ||
			completed.Goal.Status != "goal_review" || completed.ReviewDraft.ID != "71000000-0000-7000-8000-000000000001" {
			t.Fatalf("CompleteCycle result = %#v, error = %v", completed, err)
		}
		replayed, err := useCases.CompleteCycle(context.Background(), input)
		if err != nil || !replayed.Replayed || replayed.ReviewDraft.ID != completed.ReviewDraft.ID {
			t.Fatalf("CompleteCycle replay = %#v, error = %v", replayed, err)
		}
		input.ExpectedContentRevision++
		if _, err = useCases.CompleteCycle(context.Background(), input); !errors.Is(err, workspace.ErrIdempotencyKeyReused) {
			t.Fatalf("CompleteCycle reused operation error = %v", err)
		}
	})

	t.Run("review Draft insert failure rolls back Cycle and Goal", func(t *testing.T) {
		pool := integrationPool(t)
		resetDatabase(t, pool)
		now := integrationNow()
		const (
			userID      = "10000000-0000-7000-8000-000000000001"
			collidingID = "71000000-0000-7000-8000-000000000001"
		)
		insertAIConcurrencyUser(t, pool, userID, now)
		store := NewWorkspaceStore(pool)
		fixture := progressingGoalFixtures()[0]
		started := startProgressingGoal(t, store, userID, fixture, 2, now)
		useCases := newCycleApplicationTestUseCases(store, now.Add(time.Minute), collidingID)
		saveAllRequiredCycleFrames(t, useCases, userID, fixture)
		if _, err := pool.Exec(context.Background(), `INSERT INTO goal_drafts
(id,user_id,draft_type,body,revision,created_at,updated_at)
VALUES($1,$2,'creation','collision',0,$3,$3)`, collidingID, userID, now); err != nil {
			t.Fatal(err)
		}
		_, err := useCases.CompleteCycle(context.Background(), workspace.CompleteCycleInput{
			UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			OperationID:          "72000000-0000-7000-8000-000000000001",
			ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
		})
		if err == nil {
			t.Fatal("CompleteCycle succeeded after Review Draft insert collision")
		}
		assertCycleCompletionRolledBack(t, pool, userID, fixture.goalID, fixture.cycleID, collidingID)
	})

	t.Run("missing current Goal Version fails closed before writes", func(t *testing.T) {
		pool := integrationPool(t)
		resetDatabase(t, pool)
		now := integrationNow()
		const userID = "10000000-0000-7000-8000-000000000001"
		insertAIConcurrencyUser(t, pool, userID, now)
		store := NewWorkspaceStore(pool)
		fixture := progressingGoalFixtures()[0]
		started := startProgressingGoal(t, store, userID, fixture, 2, now)
		useCases := newCycleApplicationTestUseCases(store, now.Add(time.Minute), "71000000-0000-7000-8000-000000000001")
		saveAllRequiredCycleFrames(t, useCases, userID, fixture)
		if _, err := pool.Exec(context.Background(), `UPDATE goals SET current_version_number=2 WHERE id=$1 AND user_id=$2`, fixture.goalID, userID); err != nil {
			t.Fatal(err)
		}
		_, err := useCases.CompleteCycle(context.Background(), workspace.CompleteCycleInput{
			UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			OperationID:          "72000000-0000-7000-8000-000000000001",
			ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
		})
		if !errors.Is(err, workspace.ErrGoalVersionConflict) {
			t.Fatalf("missing current Version error = %v", err)
		}
		assertCycleCompletionRolledBack(t, pool, userID, fixture.goalID, fixture.cycleID, "")
	})
}

type deterministicCycleSaveCall struct {
	index int
	err   error
}

func runDeterministicConcurrentCycleSaves(
	t *testing.T,
	observerPool *pgxpool.Pool,
	useCases *workspace.CycleUseCases,
	inputs []workspace.SaveFrameInput,
) []error {
	t.Helper()
	if len(inputs) != 2 {
		t.Fatalf("deterministic Cycle save inputs = %d, want 2", len(inputs))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	barrier := newCycleSaveConcurrencyBarrier()
	defer barrier.release()
	calls := make(chan deterministicCycleSaveCall, len(inputs))
	errorsByIndex := make([]error, len(inputs))
	start := func(index int, leader bool) {
		attemptCtx := context.WithValue(ctx, cycleSaveAttemptContextKey{}, cycleSaveAttemptTrace{
			barrier: barrier,
			leader:  leader,
			frame:   inputs[index].Frame,
		})
		go func() {
			_, saveErr := useCases.SaveFrame(attemptCtx, inputs[index])
			calls <- deterministicCycleSaveCall{index: index, err: saveErr}
		}()
	}

	start(0, true)
	var leaderPID uint32
	select {
	case leaderPID = <-barrier.leaderAtUpdate:
	case call := <-calls:
		t.Fatalf("leader Cycle save returned before frame UPDATE barrier: index=%d error=%v", call.index, call.err)
	case <-ctx.Done():
		t.Fatalf("leader Cycle save did not reach frame UPDATE barrier: %v", ctx.Err())
	}

	start(1, false)
	var followerPID uint32
	select {
	case followerPID = <-barrier.followerAtGoalLock:
	case call := <-calls:
		t.Fatalf("Cycle save returned before follower Goal lock: index=%d error=%v", call.index, call.err)
	case <-ctx.Done():
		t.Fatalf("follower Cycle save did not reach Goal lock: %v", ctx.Err())
	}

	blocked := make(chan error, 1)
	go func() { blocked <- waitForBlockedBackend(ctx, observerPool, followerPID, leaderPID) }()
	select {
	case blockErr := <-blocked:
		if blockErr != nil {
			t.Fatalf("follower Cycle save did not wait for leader locks: %v", blockErr)
		}
	case call := <-calls:
		t.Fatalf("Cycle save returned before lock blocking was observed: index=%d error=%v", call.index, call.err)
	case <-ctx.Done():
		t.Fatalf("Cycle save blocking state was not observed: %v", ctx.Err())
	}

	barrier.release()
	for range inputs {
		select {
		case call := <-calls:
			errorsByIndex[call.index] = call.err
		case <-ctx.Done():
			t.Fatalf("concurrent Cycle saves did not finish: %v", ctx.Err())
		}
	}
	return errorsByIndex
}

func saveAllRequiredCycleFrames(
	t *testing.T,
	useCases *workspace.CycleUseCases,
	userID string,
	fixture progressingGoalFixture,
) {
	t.Helper()
	for _, item := range []struct {
		frame   cycle.Frame
		content string
	}{
		{cycle.FramePlan, "P"},
		{cycle.FrameDo, "D"},
		{cycle.FrameCheck, "C"},
		{cycle.FrameAction, "A"},
	} {
		if _, err := useCases.SaveFrame(context.Background(), workspace.SaveFrameInput{
			UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			Frame: item.frame, Content: item.content, ExpectedFrameRevision: 0,
		}); err != nil {
			t.Fatalf("save %s: %v", item.frame, err)
		}
	}
}

func assertCycleCompletionRolledBack(
	t *testing.T,
	pool *pgxpool.Pool,
	userID, goalID, cycleID, existingDraftID string,
) {
	t.Helper()
	var (
		goalStatus     string
		cycleStatus    string
		completionID   *string
		reviewDrafts   int
		existingDrafts int
	)
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT status FROM goals WHERE id=$1 AND user_id=$2),
(SELECT status FROM pdca_cycles WHERE id=$3 AND goal_id=$1 AND user_id=$2),
(SELECT completion_operation_id::text FROM pdca_cycles WHERE id=$3 AND goal_id=$1 AND user_id=$2),
(SELECT count(*) FROM goal_drafts WHERE user_id=$2 AND goal_id=$1 AND draft_type='review'),
(SELECT count(*) FROM goal_drafts WHERE user_id=$2 AND id=$4::uuid)`,
		goalID, userID, cycleID, nullableCycleTestUUID(existingDraftID),
	).Scan(&goalStatus, &cycleStatus, &completionID, &reviewDrafts, &existingDrafts); err != nil {
		t.Fatal(err)
	}
	expectedExisting := 0
	if existingDraftID != "" {
		expectedExisting = 1
	}
	if goalStatus != "active_cycle" || cycleStatus != "active" || completionID != nil || reviewDrafts != 0 || existingDrafts != expectedExisting {
		t.Fatalf("rollback state = goal %s cycle %s completion %v review/existing %d/%d",
			goalStatus, cycleStatus, completionID, reviewDrafts, existingDrafts)
	}
}

func nullableCycleTestUUID(value string) any {
	if value == "" {
		return nil
	}
	return value
}
