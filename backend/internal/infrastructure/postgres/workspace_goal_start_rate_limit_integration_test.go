package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/jackc/pgx/v5/pgxpool"
)

type goalStartRateState struct {
	goals        int
	versions     int
	cycles       int
	drafts       int
	userCount    int
	sessionCount int
}

func goalStartRateSettings(userLimit, sessionLimit int) aiIntegrationApplicationSettings {
	settings := defaultAIIntegrationApplicationSettings()
	settings.GoalDraft.GoalStartPerUserMinute = userLimit
	settings.GoalDraft.GoalStartPerSessionMinute = sessionLimit
	return settings
}

func loadGoalStartRateState(
	t *testing.T,
	pool *pgxpool.Pool,
	userID string,
	window time.Time,
) goalStartRateState {
	t.Helper()
	var state goalStartRateState
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goals WHERE user_id=$1),
(SELECT count(*) FROM goal_versions WHERE user_id=$1),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1),
(SELECT COALESCE(sum(request_count),0)::int FROM abuse_rate_buckets
  WHERE scope='goal_start_user_minute' AND window_start=$2),
(SELECT COALESCE(sum(request_count),0)::int FROM abuse_rate_buckets
  WHERE scope='goal_start_session_minute' AND window_start=$2)`, userID, window).Scan(
		&state.goals,
		&state.versions,
		&state.cycles,
		&state.drafts,
		&state.userCount,
		&state.sessionCount,
	); err != nil {
		t.Fatal(err)
	}
	return state
}

func assertGoalStartRateBucketsHideRawIDs(
	t *testing.T,
	pool *pgxpool.Pool,
	userID string,
	sessionID string,
) {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM abuse_rate_buckets
WHERE key_hash=$1::bytea OR key_hash=$2::bytea`, []byte(userID), []byte(sessionID)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("raw user/session identifiers were stored as rate keys: %d", count)
	}
}

func TestGoalStartRateLimitRollsBackSessionRejectionAndResetsAtMinuteBoundary(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow().Add(30 * time.Second)
	window := now.Truncate(time.Minute)
	const (
		userID    = "10000000-0000-7000-8000-000000000001"
		sessionID = "90000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool)
	settings := goalStartRateSettings(10, 5)
	fixtures := progressingGoalFixtures()

	for index, fixture := range fixtures[:5] {
		if _, err := executeGoalDraftCreateUseCase(
			store, context.Background(), userID, fixture.draftID, fixture.body, now,
		); err != nil {
			t.Fatalf("create Draft %d: %v", index+1, err)
		}
		input := fixture.startInput(userID, now)
		input.SessionID = sessionID
		result, err := executeGoalStartUseCaseWithSettings(store, context.Background(), input, 10, settings)
		if err != nil || result.Replayed {
			t.Fatalf("start %d = %#v, %v", index+1, result, err)
		}
	}

	replayInput := fixtures[4].startInput(userID, now)
	replayInput.SessionID = sessionID
	replay, err := executeGoalStartUseCaseWithSettings(store, context.Background(), replayInput, 10, settings)
	if err != nil || !replay.Replayed {
		t.Fatalf("fifth replay = %#v, %v", replay, err)
	}
	if state := loadGoalStartRateState(t, pool, userID, window); state.userCount != 5 || state.sessionCount != 5 {
		t.Fatalf("replay consumed rate capacity: %#v", state)
	}

	sixth := fixtures[5]
	if _, err = executeGoalDraftCreateUseCase(
		store, context.Background(), userID, sixth.draftID, sixth.body, now,
	); err != nil {
		t.Fatal(err)
	}
	sixthInput := sixth.startInput(userID, now)
	sixthInput.SessionID = sessionID
	beforeRejection := loadGoalStartRateState(t, pool, userID, window)
	if _, err = executeGoalStartUseCaseWithSettings(
		store, context.Background(), sixthInput, 10, settings,
	); !errors.Is(err, ports.ErrRateLimitExceeded) {
		t.Fatalf("sixth start error = %v, want %v", err, ports.ErrRateLimitExceeded)
	}
	afterRejection := loadGoalStartRateState(t, pool, userID, window)
	if afterRejection != beforeRejection || afterRejection != (goalStartRateState{
		goals: 5, versions: 5, cycles: 5, drafts: 1, userCount: 5, sessionCount: 5,
	}) {
		t.Fatalf("session rejection changed state: before=%#v after=%#v", beforeRejection, afterRejection)
	}
	if draft, draftErr := store.GetDraft(context.Background(), userID, sixth.draftID); draftErr != nil || draft.Body != sixth.body {
		t.Fatalf("rejected Draft = %#v, %v", draft, draftErr)
	}

	nextWindow := window.Add(time.Minute)
	sixthInput.Now = nextWindow
	fresh, err := executeGoalStartUseCaseWithSettings(store, context.Background(), sixthInput, 10, settings)
	if err != nil || fresh.Replayed {
		t.Fatalf("next-window retry = %#v, %v", fresh, err)
	}
	replay, err = executeGoalStartUseCaseWithSettings(store, context.Background(), sixthInput, 10, settings)
	if err != nil || !replay.Replayed {
		t.Fatalf("next-window replay = %#v, %v", replay, err)
	}
	if state := loadGoalStartRateState(t, pool, userID, nextWindow); state != (goalStartRateState{
		goals: 6, versions: 6, cycles: 6, userCount: 1, sessionCount: 1,
	}) {
		t.Fatalf("next-window state = %#v", state)
	}

	rows, err := pool.Query(context.Background(), `SELECT scope,window_start,request_count,expires_at
FROM abuse_rate_buckets WHERE scope IN ('goal_start_user_minute','goal_start_session_minute')
ORDER BY window_start,scope`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	rowCount := 0
	for rows.Next() {
		var scope string
		var rowWindow, expiresAt time.Time
		var count int
		if err = rows.Scan(&scope, &rowWindow, &count, &expiresAt); err != nil {
			t.Fatal(err)
		}
		wantCount := 5
		if rowWindow.Equal(nextWindow) {
			wantCount = 1
		}
		if (scope != "goal_start_user_minute" && scope != "goal_start_session_minute") ||
			count != wantCount || !expiresAt.Equal(rowWindow.Add(2*time.Minute)) {
			t.Fatalf("rate bucket = %s/%s/%d/%s", scope, rowWindow, count, expiresAt)
		}
		rowCount++
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if rowCount != 4 {
		t.Fatalf("rate bucket rows = %d, want 4", rowCount)
	}
	assertGoalStartRateBucketsHideRawIDs(t, pool, userID, sessionID)
}

func TestGoalStartRateLimitRollsBackUserRejectionAtConfiguredBoundary(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	window := now.Truncate(time.Minute)
	const (
		userID    = "10000000-0000-7000-8000-000000000001"
		sessionID = "90000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool)
	settings := goalStartRateSettings(5, 10)
	fixtures := progressingGoalFixtures()
	for _, fixture := range fixtures[:5] {
		if _, err := executeGoalDraftCreateUseCase(
			store, context.Background(), userID, fixture.draftID, fixture.body, now,
		); err != nil {
			t.Fatal(err)
		}
		input := fixture.startInput(userID, now)
		input.SessionID = sessionID
		if _, err := executeGoalStartUseCaseWithSettings(store, context.Background(), input, 10, settings); err != nil {
			t.Fatal(err)
		}
	}
	sixth := fixtures[5]
	if _, err := executeGoalDraftCreateUseCase(
		store, context.Background(), userID, sixth.draftID, sixth.body, now,
	); err != nil {
		t.Fatal(err)
	}
	input := sixth.startInput(userID, now)
	input.SessionID = sessionID
	before := loadGoalStartRateState(t, pool, userID, window)
	if _, err := executeGoalStartUseCaseWithSettings(
		store, context.Background(), input, 10, settings,
	); !errors.Is(err, ports.ErrRateLimitExceeded) {
		t.Fatalf("sixth user-limited start error = %v, want %v", err, ports.ErrRateLimitExceeded)
	}
	after := loadGoalStartRateState(t, pool, userID, window)
	if before != after || after != (goalStartRateState{
		goals: 5, versions: 5, cycles: 5, drafts: 1, userCount: 5, sessionCount: 5,
	}) {
		t.Fatalf("user rejection changed state: before=%#v after=%#v", before, after)
	}
	assertGoalStartRateBucketsHideRawIDs(t, pool, userID, sessionID)
}

func TestGoalStartRateLimitRollsBackBothBucketsWhenGoalInsertFailsAndFreshRetrySucceeds(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := integrationNow()
	window := now.Truncate(time.Minute)
	const (
		userID       = "10000000-0000-7000-8000-000000000001"
		sessionID    = "90000000-0000-7000-8000-000000000001"
		triggerName  = "trg_test_goal_start_insert_failure"
		functionName = "test_goal_start_insert_failure"
	)
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	if _, err := executeGoalDraftCreateUseCase(
		store, ctx, userID, fixture.draftID, fixture.body, now,
	); err != nil {
		t.Fatal(err)
	}
	input := fixture.startInput(userID, now)
	input.SessionID = sessionID
	settings := goalStartRateSettings(5, 5)

	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DROP TRIGGER IF EXISTS "+triggerName+" ON goals")
		_, _ = pool.Exec(context.Background(), "DROP FUNCTION IF EXISTS "+functionName+"()")
	})
	if _, err := pool.Exec(ctx, `CREATE FUNCTION test_goal_start_insert_failure()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'goal start insert failure canary';
END;
$$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER trg_test_goal_start_insert_failure
BEFORE INSERT ON goals
FOR EACH ROW EXECUTE FUNCTION test_goal_start_insert_failure()`); err != nil {
		t.Fatal(err)
	}

	if _, err := executeGoalStartUseCaseWithSettings(store, ctx, input, 10, settings); err == nil {
		t.Fatal("Goal Start unexpectedly succeeded while its Goal insert trigger failed")
	} else if errors.Is(err, ports.ErrRateLimitExceeded) {
		t.Fatalf("Goal insert failure was misclassified as rate rejection: %v", err)
	}
	if err := ctx.Err(); err != nil {
		t.Fatalf("Goal insert failure exhausted the fixed test context: %v", err)
	}
	if state := loadGoalStartRateState(t, pool, userID, window); state != (goalStartRateState{
		drafts: 1,
	}) {
		t.Fatalf("failed Goal insert changed aggregate or rate state: %#v", state)
	}
	if draft, err := store.GetDraft(ctx, userID, fixture.draftID); err != nil || draft.Body != fixture.body {
		t.Fatalf("failed Goal insert Draft = %#v, %v", draft, err)
	}

	if _, err := pool.Exec(ctx, "DROP TRIGGER "+triggerName+" ON goals"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DROP FUNCTION "+functionName+"()"); err != nil {
		t.Fatal(err)
	}

	fresh, err := executeGoalStartUseCaseWithSettings(store, ctx, input, 10, settings)
	if err != nil || fresh.Replayed {
		t.Fatalf("fresh retry after Goal insert failure = %#v, %v", fresh, err)
	}
	replay, err := executeGoalStartUseCaseWithSettings(store, ctx, input, 10, settings)
	if err != nil || !replay.Replayed {
		t.Fatalf("successful retry replay = %#v, %v", replay, err)
	}
	if state := loadGoalStartRateState(t, pool, userID, window); state != (goalStartRateState{
		goals: 1, versions: 1, cycles: 1, userCount: 1, sessionCount: 1,
	}) {
		t.Fatalf("fresh retry state = %#v", state)
	}
	assertGoalStartRateBucketsHideRawIDs(t, pool, userID, sessionID)
}

func TestGoalStartRateLimitSerializesConcurrentFreshRequestsUnderUserLock(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	window := now.Truncate(time.Minute)
	const (
		userID    = "10000000-0000-7000-8000-000000000001"
		sessionID = "90000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	if _, err := executeGoalDraftCreateUseCase(
		store, context.Background(), userID, fixture.draftID, fixture.body, now,
	); err != nil {
		t.Fatal(err)
	}
	settings := goalStartRateSettings(1, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := make(chan struct{})
	type call struct {
		result workspace.StartGoalResult
		err    error
	}
	results := make(chan call, 2)
	input := fixture.startInput(userID, now)
	input.SessionID = sessionID
	for range 2 {
		go func() {
			<-start
			result, callErr := executeGoalStartUseCaseWithSettings(store, ctx, input, 10, settings)
			results <- call{result: result, err: callErr}
		}()
	}
	close(start)
	fresh, replayed := 0, 0
	for range 2 {
		select {
		case current := <-results:
			if current.err != nil {
				t.Fatalf("concurrent start error = %v", current.err)
			}
			if current.result.Replayed {
				replayed++
			} else {
				fresh++
			}
		case <-ctx.Done():
			t.Fatalf("concurrent starts did not finish: %v", ctx.Err())
		}
	}
	if fresh != 1 || replayed != 1 {
		t.Fatalf("concurrent outcomes fresh/replayed = %d/%d", fresh, replayed)
	}
	if state := loadGoalStartRateState(t, pool, userID, window); state != (goalStartRateState{
		goals: 1, versions: 1, cycles: 1, userCount: 1, sessionCount: 1,
	}) {
		t.Fatalf("concurrent state = %#v", state)
	}
	assertGoalStartRateBucketsHideRawIDs(t, pool, userID, sessionID)
}

func TestGoalStartSessionRateLimitIsAtomicAcrossConcurrentUsers(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	window := now.Truncate(time.Minute)
	const (
		firstUserID  = "10000000-0000-7000-8000-000000000001"
		secondUserID = "10000000-0000-7000-8000-000000000002"
		sessionID    = "90000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$3,$3,$3),($2,$3,$3,$3)`, firstUserID, secondUserID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool)
	fixtures := progressingGoalFixtures()[:2]
	userIDs := []string{firstUserID, secondUserID}
	inputs := make([]workspace.StartGoalInput, 2)
	for index, fixture := range fixtures {
		if _, err := executeGoalDraftCreateUseCase(
			store, context.Background(), userIDs[index], fixture.draftID, fixture.body, now,
		); err != nil {
			t.Fatal(err)
		}
		inputs[index] = fixture.startInput(userIDs[index], now)
		inputs[index].SessionID = sessionID
	}

	settings := goalStartRateSettings(10, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, input := range inputs {
		go func(input workspace.StartGoalInput) {
			<-start
			_, callErr := executeGoalStartUseCaseWithSettings(store, ctx, input, 10, settings)
			results <- callErr
		}(input)
	}
	close(start)
	successes, rejected := 0, 0
	for range 2 {
		select {
		case err := <-results:
			switch {
			case err == nil:
				successes++
			case errors.Is(err, ports.ErrRateLimitExceeded):
				rejected++
			default:
				t.Fatalf("cross-user concurrent start error = %v", err)
			}
		case <-ctx.Done():
			t.Fatalf("cross-user concurrent starts did not finish: %v", ctx.Err())
		}
	}
	if successes != 1 || rejected != 1 {
		t.Fatalf("cross-user outcomes success/rejected = %d/%d", successes, rejected)
	}

	var goals, versions, cycles, drafts, userRequests, sessionRequests, userBuckets, sessionBuckets int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goals),
(SELECT count(*) FROM goal_versions),
(SELECT count(*) FROM pdca_cycles),
(SELECT count(*) FROM goal_drafts),
(SELECT COALESCE(sum(request_count),0)::int FROM abuse_rate_buckets
  WHERE scope='goal_start_user_minute' AND window_start=$1),
(SELECT COALESCE(sum(request_count),0)::int FROM abuse_rate_buckets
  WHERE scope='goal_start_session_minute' AND window_start=$1),
(SELECT count(*) FROM abuse_rate_buckets WHERE scope='goal_start_user_minute' AND window_start=$1),
(SELECT count(*) FROM abuse_rate_buckets WHERE scope='goal_start_session_minute' AND window_start=$1)`, window).Scan(
		&goals, &versions, &cycles, &drafts,
		&userRequests, &sessionRequests, &userBuckets, &sessionBuckets,
	); err != nil {
		t.Fatal(err)
	}
	if goals != 1 || versions != 1 || cycles != 1 || drafts != 1 ||
		userRequests != 1 || sessionRequests != 1 || userBuckets != 1 || sessionBuckets != 1 {
		t.Fatalf("cross-user persisted state = goals:%d versions:%d cycles:%d drafts:%d user requests/buckets:%d/%d session requests/buckets:%d/%d",
			goals, versions, cycles, drafts, userRequests, userBuckets, sessionRequests, sessionBuckets)
	}
	assertGoalStartRateBucketsHideRawIDs(t, pool, firstUserID, sessionID)
	assertGoalStartRateBucketsHideRawIDs(t, pool, secondUserID, sessionID)
}
