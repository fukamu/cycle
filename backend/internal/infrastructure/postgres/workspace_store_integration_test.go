package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
	"github.com/matoruru/PDCAI/backend/internal/domain/goal"
)

func TestWorkspaceStoreEnforcesConfigurableProgressingGoalBoundary(t *testing.T) {
	tests := []struct {
		name  string
		limit int
	}{
		{name: "free", limit: 2},
		{name: "paid boundary", limit: 3},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := integrationPool(t)
			resetDatabase(t, pool)
			now := integrationNow()
			const userID = "10000000-0000-7000-8000-000000000001"
			if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
				t.Fatal(err)
			}
			store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
			fixtures := progressingGoalFixtures()
			for index := 0; index < test.limit; index++ {
				startProgressingGoal(t, store, userID, fixtures[index], test.limit, now.Add(time.Duration(index)*time.Minute))
			}
			if test.limit == 2 {
				if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET status='completed',completed_at=$2,
completion_operation_id=$3,completion_request_hash='completion-hash',updated_at=$2 WHERE id=$1`,
					fixtures[0].cycleID, now.Add(30*time.Minute), "61000000-0000-7000-8000-000000000001"); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(context.Background(), `UPDATE goals SET status='goal_review',updated_at=$2 WHERE id=$1`,
					fixtures[0].goalID, now.Add(30*time.Minute)); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(context.Background(), `INSERT INTO goal_drafts
(id,user_id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,created_at,updated_at)
VALUES($1,$2,'review',$3,$4,$5,$6,$7,$7)`,
					"61000000-0000-7000-8000-000000000002", userID, fixtures[0].goalID,
					fixtures[0].versionID, fixtures[0].cycleID, fixtures[0].body, now.Add(30*time.Minute)); err != nil {
					t.Fatal(err)
				}
			}

			overflow := fixtures[test.limit]
			if _, err := store.CreateDraft(context.Background(), userID, overflow.draftID, overflow.body, now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			_, err := store.StartGoal(context.Background(), overflow.startInput(userID, now.Add(time.Hour)), test.limit)
			if !errors.Is(err, workspace.ErrGoalActiveLimit) {
				t.Fatalf("overflow start error = %v, want %v", err, workspace.ErrGoalActiveLimit)
			}

			home, err := store.Home(context.Background(), userID, test.limit)
			if err != nil {
				t.Fatal(err)
			}
			if len(home.ProgressingGoals) != test.limit || home.ProgressingGoalLimit != test.limit || home.CanStartProgressingGoal {
				t.Fatalf("home limit state = %#v", home)
			}
			if home.CreationDraft == nil || home.CreationDraft.ID != overflow.draftID || home.CreationDraft.Body != overflow.body {
				t.Fatalf("overflow draft was not preserved: %#v", home.CreationDraft)
			}
			if test.limit == 2 {
				statuses := map[goal.Status]bool{}
				for _, progressing := range home.ProgressingGoals {
					statuses[progressing.Status] = true
				}
				if !statuses[goal.StatusActiveCycle] || !statuses[goal.StatusGoalReview] {
					t.Fatalf("free limit did not count active and review goals together: %#v", statuses)
				}
			}
		})
	}
}

func TestWorkspaceStoreHomeOrdersProgressingGoalsByCreationTime(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	fixtures := progressingGoalFixtures()
	for index := 0; index < 3; index++ {
		startProgressingGoal(t, store, userID, fixtures[index], 3, now.Add(time.Duration(index)*time.Minute))
	}
	if _, err := pool.Exec(context.Background(), `UPDATE goals SET updated_at=$2 WHERE id=$1`, fixtures[0].goalID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	home, err := store.Home(context.Background(), userID, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(home.ProgressingGoals) != 3 {
		t.Fatalf("progressing goal count = %d, want 3", len(home.ProgressingGoals))
	}
	for index, fixture := range fixtures[:3] {
		if home.ProgressingGoals[index].ID != fixture.goalID {
			t.Fatalf("progressing goal at index %d = %s, want %s", index, home.ProgressingGoals[index].ID, fixture.goalID)
		}
	}
}

func TestWorkspaceStoreSerializesTerminationAndStartAtFreeLimit(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	fixtures := progressingGoalFixtures()
	first := startProgressingGoal(t, store, userID, fixtures[0], 2, now)
	startProgressingGoal(t, store, userID, fixtures[1], 2, now.Add(time.Minute))
	if _, err := store.CreateDraft(context.Background(), userID, fixtures[2].draftID, fixtures[2].body, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}

	zero := int64(0)
	startInput := fixtures[2].startInput(userID, now.Add(3*time.Minute))
	terminateInput := workspace.TerminateInput{
		UserID: userID, GoalID: first.Goal.ID, OperationID: "70000000-0000-7000-8000-000000000001",
		Outcome: goal.StatusEnded, ExpectedGoalRevision: 0, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: first.Cycle.ID, ExpectedCycleContentRevision: &zero,
		RequestHash: "terminate-request-hash", Now: now.Add(3 * time.Minute),
	}
	startBarrier := make(chan struct{})
	startResult := make(chan error, 1)
	terminateResult := make(chan error, 1)
	go func() {
		<-startBarrier
		_, err := store.StartGoal(context.Background(), startInput, 2)
		startResult <- err
	}()
	go func() {
		<-startBarrier
		_, err := store.Terminate(context.Background(), terminateInput)
		terminateResult <- err
	}()
	close(startBarrier)
	startErr := <-startResult
	terminateErr := <-terminateResult
	if terminateErr != nil {
		t.Fatalf("terminate error = %v", terminateErr)
	}
	if startErr != nil && !errors.Is(startErr, workspace.ErrGoalActiveLimit) {
		t.Fatalf("start error = %v", startErr)
	}

	home, err := store.Home(context.Background(), userID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(home.ProgressingGoals) > 2 {
		t.Fatalf("progressing goal count = %d, want at most 2", len(home.ProgressingGoals))
	}
	if startErr == nil && len(home.ProgressingGoals) != 2 {
		t.Fatalf("successful start left %d progressing goals, want 2", len(home.ProgressingGoals))
	}
	if errors.Is(startErr, workspace.ErrGoalActiveLimit) && len(home.ProgressingGoals) != 1 {
		t.Fatalf("limit-first ordering left %d progressing goals, want 1", len(home.ProgressingGoals))
	}
}

func TestWorkspaceStoreSharesAIQuotaWithoutMixingContextAcrossProgressingGoals(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{
		CursorSigningKey:      []byte("test-cursor-key"),
		Provider:              "fake",
		Model:                 "test",
		GeneratePromptVersion: "action-generate-v1",
		RollingLimit:          1,
	})
	fixtures := progressingGoalFixtures()
	startProgressingGoal(t, store, userID, fixtures[0], 2, now)
	startProgressingGoal(t, store, userID, fixtures[1], 2, now.Add(time.Minute))
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',
content_revision=3,plan_revision=1,do_revision=1,check_revision=1 WHERE id=$1`, fixtures[1].cycleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES($1,$2,$3,'action_generate','accepted','fake','test','action-generate-v1',$4,$5)`,
		"81000000-0000-7000-8000-000000000001", userID, fixtures[0].goalID, now, now.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	var selected workspace.AISnapshot
	_, err := store.BeginActionAI(context.Background(), workspace.ActionAIInput{
		UserID: userID, GoalID: fixtures[1].goalID, CycleID: fixtures[1].cycleID,
		Operation: "action_generate", ExpectedContentRevision: 3,
		IdempotencyKey: "82000000-0000-7000-8000-000000000001",
		GenerationID:   "83000000-0000-7000-8000-000000000001",
		Now:            now.Add(2 * time.Minute),
	}, func(_ context.Context, snapshot workspace.AISnapshot) (workspace.AISnapshot, error) {
		selected = snapshot
		return snapshot, nil
	})
	if !errors.Is(err, workspace.ErrAIUserLimit) {
		t.Fatalf("second-goal AI error = %v, want shared user quota error", err)
	}
	if selected.GoalID != fixtures[1].goalID || selected.CurrentCycle == nil || selected.CurrentCycle.GoalID != fixtures[1].goalID {
		t.Fatalf("AI snapshot target = %#v", selected)
	}
	for _, past := range selected.PastCycles {
		if past.GoalID != fixtures[1].goalID {
			t.Fatalf("AI snapshot mixed another goal: %#v", past)
		}
	}
}

type progressingGoalFixture struct {
	draftID     string
	goalID      string
	versionID   string
	cycleID     string
	operationID string
	body        string
}

func progressingGoalFixtures() []progressingGoalFixture {
	return []progressingGoalFixture{
		{draftID: "11000000-0000-7000-8000-000000000001", goalID: "21000000-0000-7000-8000-000000000001", versionID: "31000000-0000-7000-8000-000000000001", cycleID: "41000000-0000-7000-8000-000000000001", operationID: "51000000-0000-7000-8000-000000000001", body: "最初の目標"},
		{draftID: "11000000-0000-7000-8000-000000000002", goalID: "21000000-0000-7000-8000-000000000002", versionID: "31000000-0000-7000-8000-000000000002", cycleID: "41000000-0000-7000-8000-000000000002", operationID: "51000000-0000-7000-8000-000000000002", body: "二つ目の目標"},
		{draftID: "11000000-0000-7000-8000-000000000003", goalID: "21000000-0000-7000-8000-000000000003", versionID: "31000000-0000-7000-8000-000000000003", cycleID: "41000000-0000-7000-8000-000000000003", operationID: "51000000-0000-7000-8000-000000000003", body: "三つ目の目標"},
		{draftID: "11000000-0000-7000-8000-000000000004", goalID: "21000000-0000-7000-8000-000000000004", versionID: "31000000-0000-7000-8000-000000000004", cycleID: "41000000-0000-7000-8000-000000000004", operationID: "51000000-0000-7000-8000-000000000004", body: "四つ目の目標"},
	}
}

func (fixture progressingGoalFixture) startInput(userID string, now time.Time) workspace.StartGoalInput {
	return workspace.StartGoalInput{
		UserID: userID, DraftID: fixture.draftID, OperationID: fixture.operationID,
		ExpectedDraftRevision: 0, RequestHash: "request-" + fixture.operationID,
		GoalID: fixture.goalID, VersionID: fixture.versionID, CycleID: fixture.cycleID, Now: now,
	}
}

func startProgressingGoal(t *testing.T, store *WorkspaceStore, userID string, fixture progressingGoalFixture, limit int, now time.Time) workspace.StartGoalResult {
	t.Helper()
	if _, err := store.CreateDraft(context.Background(), userID, fixture.draftID, fixture.body, now); err != nil {
		t.Fatal(err)
	}
	result, err := store.StartGoal(context.Background(), fixture.startInput(userID, now), limit)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestWorkspaceStoreListGoalsReturnsInitialPageWithoutCursor(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-7000-8000-000000000001"
		goalID    = "20000000-0000-7000-8000-000000000001"
		versionID = "30000000-0000-7000-8000-000000000001"
		cycleID   = "40000000-0000-7000-8000-000000000001"
		operation = "50000000-0000-7000-8000-000000000001"
	)
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, []any{userID, now}},
		{`INSERT INTO goals(id,user_id,status,current_version_number,next_cycle_sequence_number,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,$3,$3)`, []any{goalID, userID, now}},
		{`INSERT INTO goal_versions(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'Initial page goal',$4,$5)`, []any{versionID, userID, goalID, operation, now}},
		{`INSERT INTO pdca_cycles(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active',$5,$6,'request-hash',$5,$5)`, []any{cycleID, userID, goalID, versionID, now, operation}},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(context.Background(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	page, err := store.ListGoals(context.Background(), userID, "all", "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != goalID {
		t.Fatalf("items = %#v", page.Items)
	}
	if page.NextCursor != nil {
		t.Fatalf("next cursor = %q, want nil", *page.NextCursor)
	}

	cycles, err := store.ListCycles(context.Background(), userID, goalID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(cycles.Items) != 1 || cycles.Items[0].ID != cycleID {
		t.Fatalf("cycles = %#v", cycles.Items)
	}
	if cycles.NextCursor != nil {
		t.Fatalf("next cycle cursor = %q, want nil", *cycles.NextCursor)
	}
}

func TestWorkspaceStoreDuplicateCreationDraftReturnsExistingIdentifier(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID      = "10000000-0000-7000-8000-000000000001"
		firstDraft  = "11000000-0000-7000-8000-000000000001"
		secondDraft = "11000000-0000-7000-8000-000000000002"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	if _, err := store.CreateDraft(context.Background(), userID, firstDraft, "", now); err != nil {
		t.Fatal(err)
	}
	_, err := store.CreateDraft(context.Background(), userID, secondDraft, "", now)
	var conflict *workspace.DraftAlreadyExistsError
	if !errors.As(err, &conflict) || conflict.DraftID != firstDraft {
		t.Fatalf("duplicate draft error = %#v", err)
	}
}

func TestWorkspaceStoreListGoalsOrdersProgressingBeforeTerminalAcrossPages(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID         = "10000000-0000-7000-8000-000000000001"
		activeGoalID   = "20000000-0000-7000-8000-000000000001"
		latestGoalID   = "20000000-0000-7000-8000-000000000002"
		oldGoalID      = "20000000-0000-7000-8000-000000000003"
		activeVersion  = "30000000-0000-7000-8000-000000000001"
		latestVersion  = "30000000-0000-7000-8000-000000000002"
		oldVersion     = "30000000-0000-7000-8000-000000000003"
		activeCycle    = "40000000-0000-7000-8000-000000000001"
		activeStart    = "50000000-0000-7000-8000-000000000001"
		latestTerminal = "50000000-0000-7000-8000-000000000002"
		oldTerminal    = "50000000-0000-7000-8000-000000000003"
	)
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, []any{userID, now}},
		{`INSERT INTO goals(id,user_id,status,current_version_number,next_cycle_sequence_number,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,$3,$3)`, []any{activeGoalID, userID, now.Add(-72 * time.Hour)}},
		{`INSERT INTO goals(id,user_id,status,current_version_number,next_cycle_sequence_number,terminal_at,terminal_operation_id,terminal_request_hash,created_at,updated_at)
VALUES($1,$2,'ended',1,2,$3,$4,'latest-hash',$5,$3)`, []any{latestGoalID, userID, now, latestTerminal, now.Add(-7 * 24 * time.Hour)}},
		{`INSERT INTO goals(id,user_id,status,current_version_number,next_cycle_sequence_number,terminal_at,terminal_operation_id,terminal_request_hash,created_at,updated_at)
VALUES($1,$2,'ended',1,2,$3,$4,'old-hash',$5,$3)`, []any{oldGoalID, userID, now.Add(-time.Hour), oldTerminal, now.Add(-7 * 24 * time.Hour)}},
		{`INSERT INTO goal_versions(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'Active goal',$4,$5)`, []any{activeVersion, userID, activeGoalID, activeStart, now.Add(-72 * time.Hour)}},
		{`INSERT INTO goal_versions(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'Latest terminal goal',$4,$5)`, []any{latestVersion, userID, latestGoalID, latestTerminal, now.Add(-7 * 24 * time.Hour)}},
		{`INSERT INTO goal_versions(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'Old terminal goal',$4,$5)`, []any{oldVersion, userID, oldGoalID, oldTerminal, now.Add(-7 * 24 * time.Hour)}},
		{`INSERT INTO pdca_cycles(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active',$5,$6,'active-hash',$5,$5)`, []any{activeCycle, userID, activeGoalID, activeVersion, now.Add(-72 * time.Hour), activeStart}},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(context.Background(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	first, err := store.ListGoals(context.Background(), userID, "all", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.Items[0].ID != activeGoalID || first.Items[1].ID != latestGoalID || first.NextCursor == nil {
		t.Fatalf("first page = %#v", first)
	}
	second, err := store.ListGoals(context.Background(), userID, "all", *first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID != oldGoalID || second.NextCursor != nil {
		t.Fatalf("second page = %#v", second)
	}
}

func TestWorkspaceCommandReplayConvergesAfterLaterStateTransition(t *testing.T) {
	// INV-CYCLE-GOAL-001 / INV-REVIEW-GATE-001: replay never creates a second Goal or skips the review gate.
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID            = "10000000-0000-7000-8000-000000000001"
		draftID           = "11000000-0000-7000-8000-000000000001"
		goalID            = "20000000-0000-7000-8000-000000000001"
		versionID         = "30000000-0000-7000-8000-000000000001"
		cycleID           = "40000000-0000-7000-8000-000000000001"
		startOperation    = "50000000-0000-7000-8000-000000000001"
		reviewDraftID     = "60000000-0000-7000-8000-000000000001"
		completeOperation = "70000000-0000-7000-8000-000000000001"
		nextVersionID     = "80000000-0000-7000-8000-000000000001"
		nextCycleID       = "90000000-0000-7000-8000-000000000001"
		continueOperation = "a0000000-0000-7000-8000-000000000001"
		generationID      = "b0000000-0000-7000-8000-000000000001"
		idempotencyKey    = "c0000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','目標本文',$3,$3)`, draftID, userID, now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	startInput := workspace.StartGoalInput{
		UserID: userID, DraftID: draftID, OperationID: startOperation, ExpectedDraftRevision: 0,
		RequestHash: "start-hash", GoalID: goalID, VersionID: versionID, CycleID: cycleID, Now: now,
	}
	if _, err := store.StartGoal(context.Background(), startInput, 1); err != nil {
		t.Fatal(err)
	}
	startReplay, err := store.StartGoal(context.Background(), startInput, 1)
	if err != nil || !startReplay.Replayed || startReplay.Goal.ID != goalID || startReplay.Cycle.ID != cycleID {
		t.Fatalf("start replay = %#v, error = %v", startReplay, err)
	}

	actionInput := workspace.ActionAIInput{
		UserID: userID, GoalID: goalID, CycleID: cycleID, Operation: "action_generate",
		ExpectedContentRevision: 0, IdempotencyKey: idempotencyKey,
	}
	if _, err = pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,goal_id,goal_version_id,cycle_id,target_revision,idempotency_key,input_hash,
output,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,attempt_count,applied_at,started_at,finished_at)
VALUES($1,$2,'action_generate','succeeded',$3,$4,$5,0,$6,$7,'次の行動','fake','test','action-generate-v1',$8,0,1,$9,$9,$9)`,
		generationID, userID, goalID, versionID, cycleID, idempotencyKey, hashActionAIRequest(actionInput), now.Format("2006-01-02"), now); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(context.Background(), `UPDATE pdca_cycles SET action='次の行動',content_revision=1,
action_revision=1,action_last_ai_applied_content_revision=1 WHERE id=$1`, cycleID); err != nil {
		t.Fatal(err)
	}
	actionReplay, err := store.BeginActionAI(context.Background(), actionInput, nil)
	if err != nil || actionReplay.ReplayedOutput == nil || *actionReplay.ReplayedOutput != "次の行動" || actionReplay.ReplayedContentRevision != 1 {
		t.Fatalf("action replay = %#v, error = %v", actionReplay, err)
	}
	differentRequest := actionInput
	differentRequest.ConfirmReplace = true
	if _, err = store.BeginActionAI(context.Background(), differentRequest, nil); !errors.Is(err, workspace.ErrIdempotencyKeyReused) {
		t.Fatalf("action replay with different request error = %v", err)
	}

	if _, err = pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',
content_revision=4,plan_revision=1,do_revision=1,check_revision=1 WHERE id=$1`, cycleID); err != nil {
		t.Fatal(err)
	}
	completeInput := workspace.CompleteCycleInput{
		UserID: userID, GoalID: goalID, CycleID: cycleID, ReviewDraftID: reviewDraftID,
		OperationID: completeOperation, ExpectedGoalRevision: 0, ExpectedContentRevision: 4,
		RequestHash: "complete-hash", Now: now.Add(time.Minute),
	}
	if _, err = store.CompleteCycle(context.Background(), completeInput); err != nil {
		t.Fatal(err)
	}
	if _, err = store.GetDraft(context.Background(), userID, reviewDraftID); !errors.Is(err, workspace.ErrDraftTypeMismatch) {
		t.Fatalf("review draft read through creation endpoint error = %v", err)
	}
	if _, err = store.ContinueReview(context.Background(), workspace.ContinueReviewInput{
		UserID: userID, GoalID: goalID, OperationID: continueOperation, ExpectedGoalRevision: 1,
		ExpectedDraftRevision: 0, RequestHash: "continue-hash", VersionID: nextVersionID,
		CycleID: nextCycleID, Now: now.Add(2 * time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	completeReplay, err := store.CompleteCycle(context.Background(), completeInput)
	if err != nil || completeReplay.Replay == nil || !completeReplay.Replay.Replayed {
		t.Fatalf("complete replay = %#v, error = %v", completeReplay, err)
	}
	if completeReplay.Replay.Operation != "complete_cycle" || completeReplay.Replay.CurrentWorkspace == nil || completeReplay.Replay.CurrentWorkspace.CycleID != nextCycleID {
		t.Fatalf("command replay response = %#v", completeReplay.Replay)
	}
}

func TestGoalRefineReplayPrecedesLaterDraftRevisionConflict(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID         = "10000000-0000-7000-8000-000000000001"
		draftID        = "11000000-0000-7000-8000-000000000001"
		generationID   = "b0000000-0000-7000-8000-000000000001"
		idempotencyKey = "c0000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','元の目標',$3,$3)`, draftID, userID, now); err != nil {
		t.Fatal(err)
	}
	refineInput := workspace.GoalRefineInput{
		UserID: userID, DraftID: draftID, ExpectedDraftRevision: 0, IdempotencyKey: idempotencyKey,
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
output,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,attempt_count,started_at,finished_at)
VALUES($1,$2,'goal_refine','succeeded',$3,0,$4,$5,'元の目標','改善した目標','fake','test','goal-refine-v1',$6,0,1,$7,$7)`,
		generationID, userID, draftID, idempotencyKey, hashGoalRefineRequest(refineInput), now.Format("2006-01-02"), now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	if _, err := store.SaveDraft(context.Background(), userID, draftID, "利用者が後から編集", 0, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	replayed, err := store.BeginGoalRefine(context.Background(), refineInput, nil)
	if err != nil || replayed.ReplayedOutput == nil || *replayed.ReplayedOutput != "改善した目標" {
		t.Fatalf("goal refine replay = %#v, error = %v", replayed, err)
	}
}

func TestAdoptGoalSuggestionReplayIsIdempotentUntilDraftChanges(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID         = "10000000-0000-7000-8000-000000000001"
		draftID        = "11000000-0000-7000-8000-000000000001"
		generationID   = "b0000000-0000-7000-8000-000000000001"
		idempotencyKey = "c0000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','元の目標',$3,$3)`, draftID, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
output,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,attempt_count,started_at,finished_at)
VALUES($1,$2,'goal_refine','succeeded',$3,0,$4,'input-hash','元の目標','改善した目標','fake','test','goal-refine-v1',$5,0,1,$6,$6)`,
		generationID, userID, draftID, idempotencyKey, now.Format("2006-01-02"), now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	adopted, err := store.AdoptGoalSuggestion(context.Background(), userID, draftID, generationID, 0, nil, now.Add(time.Minute))
	if err != nil || adopted.Revision != 1 || adopted.Replayed {
		t.Fatalf("adopted = %#v, error = %v", adopted, err)
	}
	replayed, err := store.AdoptGoalSuggestion(context.Background(), userID, draftID, generationID, 0, nil, now.Add(2*time.Minute))
	if err != nil || !replayed.Replayed || replayed.Body != "改善した目標" {
		t.Fatalf("adopt replay = %#v, error = %v", replayed, err)
	}
	if _, err = store.SaveDraft(context.Background(), userID, draftID, "利用者が編集", 1, now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	_, err = store.AdoptGoalSuggestion(context.Background(), userID, draftID, generationID, 0, nil, now.Add(4*time.Minute))
	if !errors.Is(err, workspace.ErrAIResultAlreadyAdopted) {
		t.Fatalf("adopt after edit error = %v", err)
	}
}

func TestAdoptGoalSuggestionAcceptsDraftRestoredToSourceText(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID         = "10000000-0000-7000-8000-000000000001"
		draftID        = "11000000-0000-7000-8000-000000000001"
		generationID   = "b0000000-0000-7000-8000-000000000001"
		idempotencyKey = "c0000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','元の目標',$3,$3)`, draftID, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
output,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,attempt_count,started_at,finished_at)
VALUES($1,$2,'goal_refine','succeeded',$3,0,$4,'input-hash','元の目標','改善した目標','fake','test','goal-refine-v1',$5,0,1,$6,$6)`,
		generationID, userID, draftID, idempotencyKey, now.Format("2006-01-02"), now); err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	if _, err := store.SaveDraft(context.Background(), userID, draftID, "一時的な変更", 0, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveDraft(context.Background(), userID, draftID, "元の目標", 1, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}

	adopted, err := store.AdoptGoalSuggestion(context.Background(), userID, draftID, generationID, 2, nil, now.Add(3*time.Minute))
	if err != nil || adopted.Body != "改善した目標" || adopted.Revision != 3 {
		t.Fatalf("adopted = %#v, error = %v", adopted, err)
	}
}
