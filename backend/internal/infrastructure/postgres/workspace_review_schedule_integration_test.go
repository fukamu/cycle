package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type reviewScheduleRaceContextKey struct{}

type reviewScheduleRaceTrace struct {
	leader bool
	race   *reviewScheduleRaceBarrier
}

type reviewScheduleRaceTracer struct{}

type reviewScheduleRaceBarrier struct {
	leaderAtWrite  chan struct{}
	followerAtGoal chan struct{}
	releaseLeader  chan struct{}
}

func (*reviewScheduleRaceTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	trace, ok := ctx.Value(reviewScheduleRaceContextKey{}).(reviewScheduleRaceTrace)
	if !ok || trace.race == nil {
		return ctx
	}
	normalized := normalizeObservedSQL(data.SQL)
	if trace.leader && len(normalized) > 0 &&
		strings.Contains(normalized, "insert into pdca_cycle_review_schedules ") {
		select {
		case trace.race.leaderAtWrite <- struct{}{}:
		default:
		}
		select {
		case <-trace.race.releaseLeader:
		case <-ctx.Done():
		}
	} else if !trace.leader && isCycleSaveGoalLock(data.SQL) {
		select {
		case trace.race.followerAtGoal <- struct{}{}:
		default:
		}
	}
	return ctx
}

func (*reviewScheduleRaceTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestReviewScheduleApplicationCASLifecycleAndReadModels(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	const outsiderID = "10000000-0000-7000-8000-000000000002"
	insertAIConcurrencyUser(t, pool, userID, now)
	insertAIConcurrencyUser(t, pool, outsiderID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, userID, fixture, 3, now)
	useCases := newCycleApplicationTestUseCases(store, now.Add(time.Minute))

	if started.Cycle.ReviewDate != nil || started.Cycle.ReviewScheduleRevision != 0 {
		t.Fatalf("new Cycle schedule = %v/%d, want unset/0", started.Cycle.ReviewDate, started.Cycle.ReviewScheduleRevision)
	}
	homeBefore, err := store.Home(t.Context(), userID, 3)
	if err != nil || len(homeBefore.ProgressingGoals) != 1 {
		t.Fatalf("Home before set = %#v, error = %v", homeBefore, err)
	}
	currentWork := homeBefore.ProgressingGoals[0].CurrentWork
	if currentWork == nil || currentWork.ReviewSchedule == nil ||
		currentWork.ReviewSchedule.ReviewDate != nil || currentWork.ReviewSchedule.ReviewScheduleRevision != 0 {
		t.Fatalf("Home unset schedule = %#v", currentWork)
	}
	unauthorizedDate, _ := cycle.ParseReviewDate("2026-09-29")
	if _, err = useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: outsiderID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ReviewDate: &unauthorizedDate, ExpectedReviewScheduleRevision: 0,
	}); !errors.Is(err, workspace.ErrGoalNotFound) {
		t.Fatalf("cross-owner schedule mutation error = %v", err)
	}

	minimum, _ := cycle.ParseReviewDate("0001-01-01")
	set, err := useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ReviewDate: &minimum, ExpectedReviewScheduleRevision: 0,
	})
	if err != nil || set.Cycle.ReviewDate == nil || *set.Cycle.ReviewDate != minimum ||
		set.Cycle.ReviewScheduleRevision != 1 || set.Cycle.ContentRevision != 0 {
		t.Fatalf("initial set = %#v, error = %v", set, err)
	}

	replayed, err := useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ReviewDate: &minimum, ExpectedReviewScheduleRevision: 0,
	})
	if err != nil || replayed.Cycle.ReviewDate == nil || *replayed.Cycle.ReviewDate != minimum ||
		replayed.Cycle.ReviewScheduleRevision != 1 {
		t.Fatalf("response-loss set retry = %#v, error = %v", replayed, err)
	}
	different, _ := cycle.ParseReviewDate("2026-09-30")
	if _, err = useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ReviewDate: &different, ExpectedReviewScheduleRevision: 0,
	}); !errors.Is(err, cycle.ErrRevisionConflict) {
		t.Fatalf("stale different-target error = %v", err)
	}

	cleared, err := useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ExpectedReviewScheduleRevision: 1,
	})
	if err != nil || cleared.Cycle.ReviewDate != nil || cleared.Cycle.ReviewScheduleRevision != 2 ||
		cleared.Cycle.ContentRevision != 0 {
		t.Fatalf("clear = %#v, error = %v", cleared, err)
	}
	var storedDate *time.Time
	var storedRevision int64
	if err = pool.QueryRow(t.Context(), `SELECT review_date,review_schedule_revision
FROM pdca_cycle_review_schedules WHERE cycle_id=$1`, fixture.cycleID).Scan(&storedDate, &storedRevision); err != nil {
		t.Fatal(err)
	}
	if storedDate != nil || storedRevision != 2 {
		t.Fatalf("clear persistence = %v/%d, want NULL/2", storedDate, storedRevision)
	}
	replayedClear, err := useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ExpectedReviewScheduleRevision: 1,
	})
	if err != nil || replayedClear.Cycle.ReviewDate != nil || replayedClear.Cycle.ReviewScheduleRevision != 2 {
		t.Fatalf("response-loss clear retry = %#v, error = %v", replayedClear, err)
	}

	maximum, _ := cycle.ParseReviewDate("9999-12-31")
	setMaximum, err := useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ReviewDate: &maximum, ExpectedReviewScheduleRevision: 2,
	})
	if err != nil || setMaximum.Cycle.ReviewDate == nil || *setMaximum.Cycle.ReviewDate != maximum ||
		setMaximum.Cycle.ReviewScheduleRevision != 3 {
		t.Fatalf("maximum set = %#v, error = %v", setMaximum, err)
	}
	homeAfter, err := store.Home(t.Context(), userID, 3)
	if err != nil || len(homeAfter.ProgressingGoals) != 1 || homeAfter.ProgressingGoals[0].ID != fixture.goalID {
		t.Fatalf("Home after set order = %#v, error = %v", homeAfter.ProgressingGoals, err)
	}
	afterWork := homeAfter.ProgressingGoals[0].CurrentWork
	if afterWork == nil || afterWork.ReviewSchedule == nil || afterWork.ReviewSchedule.ReviewDate == nil ||
		*afterWork.ReviewSchedule.ReviewDate != maximum || afterWork.ReviewSchedule.ReviewScheduleRevision != 3 {
		t.Fatalf("Home set schedule = %#v", afterWork)
	}

	saveAllRequiredCycleFrames(t, useCases, userID, fixture)
	completed, err := executeCycleCompleteUseCase(store, t.Context(), workspace.CompleteCycleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		OperationID: "72000000-0000-7000-8000-000000000053", ExpectedGoalRevision: started.Goal.Revision,
		ExpectedContentRevision: 4,
	}, now.Add(2*time.Minute), "71000000-0000-7000-8000-000000000053")
	if err != nil || completed.CompletedCycle.ReviewDate == nil || *completed.CompletedCycle.ReviewDate != maximum ||
		completed.CompletedCycle.ReviewScheduleRevision != 3 {
		t.Fatalf("completed frozen schedule = %#v, error = %v", completed.CompletedCycle, err)
	}
	if _, err = useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ExpectedReviewScheduleRevision: 3,
	}); !errors.Is(err, workspace.ErrGoalStateConflict) {
		t.Fatalf("terminal schedule mutation error = %v", err)
	}

	nextCycleID := "41000000-0000-7000-8000-000000000053"
	continued, err := executeContinueReviewUseCase(store, t.Context(), workspace.ContinueReviewInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID: "73000000-0000-7000-8000-000000000053", ExpectedGoalRevision: completed.Goal.Revision,
		ExpectedDraftRevision: completed.ReviewDraft.Revision, RequestHash: "continue-review-schedule",
		CycleID: nextCycleID, Now: now.Add(3 * time.Minute),
	})
	if err != nil || continued.Cycle.ID != nextCycleID || continued.Cycle.ReviewDate != nil ||
		continued.Cycle.ReviewScheduleRevision != 0 {
		t.Fatalf("next Cycle schedule = %#v, error = %v", continued.Cycle, err)
	}
	oldCycle, err := useCases.GetCycle(t.Context(), userID, fixture.goalID, fixture.cycleID)
	if err != nil || oldCycle.ReviewDate == nil || *oldCycle.ReviewDate != maximum || oldCycle.ReviewScheduleRevision != 3 {
		t.Fatalf("old frozen schedule after continue = %#v, error = %v", oldCycle, err)
	}
}

func TestReviewScheduleCanceledFreezeAndAggregateCascade(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixtures := progressingGoalFixtures()
	first := startProgressingGoal(t, store, userID, fixtures[0], 3, now)
	second := startProgressingGoal(t, store, userID, fixtures[1], 3, now.Add(time.Minute))
	useCases := newCycleApplicationTestUseCases(store, now.Add(2*time.Minute))
	date, _ := cycle.ParseReviewDate("2026-09-30")
	for _, started := range []workspace.StartGoalResult{first, second} {
		if _, err := useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
			UserID: userID, GoalID: started.Goal.ID, CycleID: started.Cycle.ID,
			ReviewDate: &date, ExpectedReviewScheduleRevision: 0,
		}); err != nil {
			t.Fatal(err)
		}
	}
	zero := int64(0)
	terminated, err := executeTerminateGoalUseCase(store, t.Context(), workspace.TerminateInput{
		UserID: userID, GoalID: first.Goal.ID, OperationID: "74000000-0000-7000-8000-000000000053",
		Outcome: goal.StatusEnded, ExpectedGoalRevision: first.Goal.Revision, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: first.Cycle.ID, ExpectedCycleContentRevision: &zero,
		RequestHash: "terminate-review-schedule", Now: now.Add(3 * time.Minute),
	})
	if err != nil || terminated.CanceledCycle == nil || terminated.CanceledCycle.ReviewDate == nil ||
		*terminated.CanceledCycle.ReviewDate != date || terminated.CanceledCycle.ReviewScheduleRevision != 1 {
		t.Fatalf("canceled frozen schedule = %#v, error = %v", terminated.CanceledCycle, err)
	}
	if _, err = useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: first.Goal.ID, CycleID: first.Cycle.ID,
		ExpectedReviewScheduleRevision: 1,
	}); !errors.Is(err, workspace.ErrGoalStateConflict) {
		t.Fatalf("canceled schedule mutation error = %v", err)
	}

	if _, err = pool.Exec(t.Context(), `DELETE FROM goals WHERE id=$1 AND user_id=$2`, first.Goal.ID, userID); err != nil {
		t.Fatal(err)
	}
	var firstScheduleCount int
	if err = pool.QueryRow(t.Context(), `SELECT count(*) FROM pdca_cycle_review_schedules WHERE cycle_id=$1`, first.Cycle.ID).Scan(&firstScheduleCount); err != nil {
		t.Fatal(err)
	}
	if firstScheduleCount != 0 {
		t.Fatalf("Goal delete retained %d schedule rows", firstScheduleCount)
	}
	if _, err = pool.Exec(t.Context(), `DELETE FROM users WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	var secondScheduleCount int
	if err = pool.QueryRow(t.Context(), `SELECT count(*) FROM pdca_cycle_review_schedules WHERE cycle_id=$1`, second.Cycle.ID).Scan(&secondScheduleCount); err != nil {
		t.Fatal(err)
	}
	if secondScheduleCount != 0 {
		t.Fatalf("Account delete retained %d schedule rows", secondScheduleCount)
	}
}

func TestReviewScheduleSetSerializesBeforeCycleCompletion(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	fixture := progressingGoalFixtures()[0]
	baseStore := NewWorkspaceStore(pool)
	started := startProgressingGoal(t, baseStore, userID, fixture, 2, now)
	baseUseCases := newCycleApplicationTestUseCases(baseStore, now.Add(time.Minute))
	saveAllRequiredCycleFrames(t, baseUseCases, userID, fixture)

	config := pool.Config()
	config.ConnConfig.Tracer = &reviewScheduleRaceTracer{}
	config.MinConns = 0
	config.MaxConns = 2
	tracedPool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer tracedPool.Close()
	store := NewWorkspaceStore(tracedPool)
	barrier := &reviewScheduleRaceBarrier{
		leaderAtWrite: make(chan struct{}, 1), followerAtGoal: make(chan struct{}, 1), releaseLeader: make(chan struct{}),
	}
	date, _ := cycle.ParseReviewDate("2026-09-30")
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	setResult := make(chan struct {
		result workspace.ChangeReviewScheduleResult
		err    error
	}, 1)
	go func() {
		result, callErr := newCycleApplicationTestUseCases(store, now.Add(time.Minute)).ChangeReviewSchedule(
			context.WithValue(ctx, reviewScheduleRaceContextKey{}, reviewScheduleRaceTrace{leader: true, race: barrier}),
			workspace.ChangeReviewScheduleInput{
				UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
				ReviewDate: &date, ExpectedReviewScheduleRevision: 0,
			},
		)
		setResult <- struct {
			result workspace.ChangeReviewScheduleResult
			err    error
		}{result: result, err: callErr}
	}()
	select {
	case <-barrier.leaderAtWrite:
	case <-ctx.Done():
		t.Fatalf("schedule write did not reach barrier: %v", ctx.Err())
	}

	completeResult := make(chan struct {
		result workspace.CompleteCycleResult
		err    error
	}, 1)
	go func() {
		result, callErr := executeCycleCompleteUseCase(
			store,
			context.WithValue(ctx, reviewScheduleRaceContextKey{}, reviewScheduleRaceTrace{race: barrier}),
			workspace.CompleteCycleInput{
				UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
				OperationID:          "75000000-0000-7000-8000-000000000053",
				ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
			},
			now.Add(2*time.Minute),
			"76000000-0000-7000-8000-000000000053",
		)
		completeResult <- struct {
			result workspace.CompleteCycleResult
			err    error
		}{result: result, err: callErr}
	}()
	select {
	case <-barrier.followerAtGoal:
	case <-ctx.Done():
		close(barrier.releaseLeader)
		t.Fatalf("completion did not reach the shared Goal lock: %v", ctx.Err())
	}
	select {
	case early := <-completeResult:
		close(barrier.releaseLeader)
		t.Fatalf("completion bypassed schedule's Goal/Cycle locks: %#v", early)
	default:
	}
	close(barrier.releaseLeader)

	setCall := <-setResult
	if setCall.err != nil || setCall.result.Cycle.ReviewDate == nil || *setCall.result.Cycle.ReviewDate != date {
		t.Fatalf("serialized set = %#v, error = %v", setCall.result, setCall.err)
	}
	completedCall := <-completeResult
	if completedCall.err != nil || completedCall.result.CompletedCycle.ReviewDate == nil ||
		*completedCall.result.CompletedCycle.ReviewDate != date ||
		completedCall.result.CompletedCycle.ReviewScheduleRevision != 1 {
		t.Fatalf("serialized completion = %#v, error = %v", completedCall.result, completedCall.err)
	}
	if _, err = newCycleApplicationTestUseCases(store, now.Add(3*time.Minute)).ChangeReviewSchedule(
		t.Context(),
		workspace.ChangeReviewScheduleInput{
			UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			ExpectedReviewScheduleRevision: 1,
		},
	); !errors.Is(err, workspace.ErrGoalStateConflict) {
		t.Fatalf("post-completion clear error = %v", err)
	}
}

func TestReviewScheduleSetSerializesBeforeActiveCycleCancellation(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	fixture := progressingGoalFixtures()[0]
	baseStore := NewWorkspaceStore(pool)
	started := startProgressingGoal(t, baseStore, userID, fixture, 2, now)

	config := pool.Config()
	config.ConnConfig.Tracer = &reviewScheduleRaceTracer{}
	config.MinConns = 0
	config.MaxConns = 2
	tracedPool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer tracedPool.Close()
	store := NewWorkspaceStore(tracedPool)
	barrier := &reviewScheduleRaceBarrier{
		leaderAtWrite: make(chan struct{}, 1), followerAtGoal: make(chan struct{}, 1), releaseLeader: make(chan struct{}),
	}
	date, _ := cycle.ParseReviewDate("2026-10-01")
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	setResult := make(chan struct {
		result workspace.ChangeReviewScheduleResult
		err    error
	}, 1)
	go func() {
		result, callErr := newCycleApplicationTestUseCases(store, now.Add(time.Minute)).ChangeReviewSchedule(
			context.WithValue(ctx, reviewScheduleRaceContextKey{}, reviewScheduleRaceTrace{leader: true, race: barrier}),
			workspace.ChangeReviewScheduleInput{
				UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
				ReviewDate: &date, ExpectedReviewScheduleRevision: 0,
			},
		)
		setResult <- struct {
			result workspace.ChangeReviewScheduleResult
			err    error
		}{result: result, err: callErr}
	}()
	select {
	case <-barrier.leaderAtWrite:
	case <-ctx.Done():
		t.Fatalf("schedule write did not reach barrier: %v", ctx.Err())
	}

	zero := int64(0)
	terminateResult := make(chan struct {
		result workspace.TerminateResult
		err    error
	}, 1)
	go func() {
		result, callErr := executeTerminateGoalUseCase(
			store,
			context.WithValue(ctx, reviewScheduleRaceContextKey{}, reviewScheduleRaceTrace{race: barrier}),
			workspace.TerminateInput{
				UserID: userID, GoalID: fixture.goalID,
				OperationID: "77000000-0000-7000-8000-000000000053", Outcome: goal.StatusEnded,
				ExpectedGoalRevision: started.Goal.Revision, ExpectedState: goal.StatusActiveCycle,
				ActiveCycleID: fixture.cycleID, ExpectedCycleContentRevision: &zero,
				RequestHash: "terminate-after-review-schedule", Now: now.Add(2 * time.Minute),
			},
		)
		terminateResult <- struct {
			result workspace.TerminateResult
			err    error
		}{result: result, err: callErr}
	}()
	select {
	case <-barrier.followerAtGoal:
	case <-ctx.Done():
		close(barrier.releaseLeader)
		t.Fatalf("termination did not reach the shared Goal lock: %v", ctx.Err())
	}
	select {
	case early := <-terminateResult:
		close(barrier.releaseLeader)
		t.Fatalf("termination bypassed schedule's Goal/Cycle locks: %#v", early)
	default:
	}
	close(barrier.releaseLeader)

	setCall := <-setResult
	if setCall.err != nil || setCall.result.Cycle.ReviewDate == nil || *setCall.result.Cycle.ReviewDate != date {
		t.Fatalf("serialized set = %#v, error = %v", setCall.result, setCall.err)
	}
	terminatedCall := <-terminateResult
	if terminatedCall.err != nil || terminatedCall.result.CanceledCycle == nil ||
		terminatedCall.result.CanceledCycle.ReviewDate == nil ||
		*terminatedCall.result.CanceledCycle.ReviewDate != date ||
		terminatedCall.result.CanceledCycle.ReviewScheduleRevision != 1 {
		t.Fatalf("serialized termination = %#v, error = %v", terminatedCall.result, terminatedCall.err)
	}
	if _, err = newCycleApplicationTestUseCases(store, now.Add(3*time.Minute)).ChangeReviewSchedule(
		t.Context(),
		workspace.ChangeReviewScheduleInput{
			UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			ExpectedReviewScheduleRevision: 1,
		},
	); !errors.Is(err, workspace.ErrGoalStateConflict) {
		t.Fatalf("post-cancellation clear error = %v", err)
	}
}
