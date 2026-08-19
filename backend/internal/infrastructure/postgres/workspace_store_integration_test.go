package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
)

func TestWorkspaceStoreListGoalsReturnsInitialPageWithoutCursor(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-0000-0000-000000000001"
		goalID    = "20000000-0000-0000-0000-000000000001"
		versionID = "30000000-0000-0000-0000-000000000001"
		cycleID   = "40000000-0000-0000-0000-000000000001"
		operation = "50000000-0000-0000-0000-000000000001"
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

func TestWorkspaceStoreListGoalsOrdersProgressingBeforeTerminalAcrossPages(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID         = "10000000-0000-0000-0000-000000000001"
		activeGoalID   = "20000000-0000-0000-0000-000000000001"
		latestGoalID   = "20000000-0000-0000-0000-000000000002"
		oldGoalID      = "20000000-0000-0000-0000-000000000003"
		activeVersion  = "30000000-0000-0000-0000-000000000001"
		latestVersion  = "30000000-0000-0000-0000-000000000002"
		oldVersion     = "30000000-0000-0000-0000-000000000003"
		activeCycle    = "40000000-0000-0000-0000-000000000001"
		activeStart    = "50000000-0000-0000-0000-000000000001"
		latestTerminal = "50000000-0000-0000-0000-000000000002"
		oldTerminal    = "50000000-0000-0000-0000-000000000003"
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
		userID            = "10000000-0000-0000-0000-000000000001"
		draftID           = "11000000-0000-0000-0000-000000000001"
		goalID            = "20000000-0000-0000-0000-000000000001"
		versionID         = "30000000-0000-0000-0000-000000000001"
		cycleID           = "40000000-0000-0000-0000-000000000001"
		startOperation    = "50000000-0000-0000-0000-000000000001"
		reviewDraftID     = "60000000-0000-0000-0000-000000000001"
		completeOperation = "70000000-0000-0000-0000-000000000001"
		nextVersionID     = "80000000-0000-0000-0000-000000000001"
		nextCycleID       = "90000000-0000-0000-0000-000000000001"
		continueOperation = "a0000000-0000-0000-0000-000000000001"
		generationID      = "b0000000-0000-0000-0000-000000000001"
		idempotencyKey    = "c0000000-0000-0000-0000-000000000001"
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
		userID         = "10000000-0000-0000-0000-000000000001"
		draftID        = "11000000-0000-0000-0000-000000000001"
		generationID   = "b0000000-0000-0000-0000-000000000001"
		idempotencyKey = "c0000000-0000-0000-0000-000000000001"
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
		userID         = "10000000-0000-0000-0000-000000000001"
		draftID        = "11000000-0000-0000-0000-000000000001"
		generationID   = "b0000000-0000-0000-0000-000000000001"
		idempotencyKey = "c0000000-0000-0000-0000-000000000001"
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
