package workspace

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

const (
	reviewTransitionTestUserID     = "10000000-0000-7000-8000-000000000001"
	reviewTransitionTestGoalID     = "20000000-0000-7000-8000-000000000001"
	reviewTransitionTestVersion1ID = "30000000-0000-7000-8000-000000000001"
	reviewTransitionTestVersion2ID = "30000000-0000-7000-8000-000000000002"
	reviewTransitionTestDraftID    = "40000000-0000-7000-8000-000000000001"
	reviewTransitionTestCycle1ID   = "50000000-0000-7000-8000-000000000001"
	reviewTransitionTestCycle2ID   = "50000000-0000-7000-8000-000000000002"
	reviewTransitionTestOperation  = "60000000-0000-7000-8000-000000000001"
	reviewTransitionTestGen1ID     = "70000000-0000-7000-8000-000000000001"
	reviewTransitionTestGen2ID     = "70000000-0000-7000-8000-000000000002"
	reviewTransitionTestGen3ID     = "70000000-0000-7000-8000-000000000003"
)

var reviewTransitionTestNow = time.Date(2026, time.August, 24, 3, 4, 5, 0, time.UTC)

type reviewTransitionTestClock struct {
	now   time.Time
	calls int
}

func (clock *reviewTransitionTestClock) Now() time.Time {
	clock.calls++
	return clock.now
}

type reviewTransitionTestIDs struct {
	values []string
	calls  int
}

func (ids *reviewTransitionTestIDs) NewID() (string, error) {
	if ids.calls >= len(ids.values) {
		return "", errors.New("unexpected ID request")
	}
	value := ids.values[ids.calls]
	ids.calls++
	return value, nil
}

type reviewTransitionTestUOW struct {
	tx         *reviewTransitionTestTx
	calls      int
	committed  int
	rolledBack int
}

func (uow *reviewTransitionTestUOW) WithinReviewTransitionTransaction(ctx context.Context, operation func(ReviewTransitionTx) error) error {
	uow.calls++
	err := operation(uow.tx)
	if err != nil {
		uow.rolledBack++
		return err
	}
	uow.committed++
	return nil
}

type reviewTransitionTestTx struct {
	trace []string

	continueReceipts []*ContinueReviewReceipt
	continueCalls    int
	termination      *GoalTerminationReceipt
	goal             goal.Goal
	goalErr          error
	cycle            cycle.PDCACycle
	cycleErr         error
	draft            goal.Draft
	draftErr         error
	version          goal.Version
	versionErr       error
	generations      []DraftGenerationState
	usages           []DraftUsageState
	goalAIRunning    bool

	goalViewOverride  func(GoalView) GoalView
	cycleViewOverride func(CycleView) CycleView

	rows map[string]int64

	insertedVersion    *goal.Version
	claimedCycle       *cycle.PDCACycle
	continuedGoal      *goal.Goal
	canceledCycle      *cycle.PDCACycle
	terminatedGoal     *goal.Goal
	attachedGeneration []string
	attachedUsage      []string
	redactedUsage      []string
	deletedUsage       []string
	deletedAt          time.Time
	deletedGeneration  []string
	deletedDraftID     string
}

func (tx *reviewTransitionTestTx) record(value string) { tx.trace = append(tx.trace, value) }

func (tx *reviewTransitionTestTx) row(name string, fallback int64) int64 {
	if value, ok := tx.rows[name]; ok {
		return value
	}
	return fallback
}

func (tx *reviewTransitionTestTx) FindContinueReviewReceipt(context.Context, string, string) (*ContinueReviewReceipt, error) {
	tx.record("continue_receipt")
	index := tx.continueCalls
	tx.continueCalls++
	if index >= len(tx.continueReceipts) {
		return nil, nil
	}
	return tx.continueReceipts[index], nil
}

func (tx *reviewTransitionTestTx) FindGoalTerminationReceipt(context.Context, string, string) (*GoalTerminationReceipt, error) {
	tx.record("termination_receipt")
	return tx.termination, nil
}

func (tx *reviewTransitionTestTx) LockUser(context.Context, string) error {
	tx.record("lock_user")
	return nil
}

func (tx *reviewTransitionTestTx) LockGoal(context.Context, string, string) (goal.Goal, error) {
	tx.record("lock_goal")
	return tx.goal, tx.goalErr
}

func (tx *reviewTransitionTestTx) LockCycle(context.Context, string, string, string) (cycle.PDCACycle, error) {
	tx.record("lock_cycle")
	return tx.cycle, tx.cycleErr
}

func (tx *reviewTransitionTestTx) LockReviewDraft(context.Context, string, string) (goal.Draft, error) {
	tx.record("lock_draft")
	return tx.draft, tx.draftErr
}

func (tx *reviewTransitionTestTx) LoadCurrentGoalVersion(context.Context, string, string, int32) (goal.Version, error) {
	tx.record("load_version")
	return tx.version, tx.versionErr
}

func (tx *reviewTransitionTestTx) HasRunningGoalGeneration(context.Context, string, string) (bool, error) {
	tx.record("goal_ai")
	return tx.goalAIRunning, nil
}

func (tx *reviewTransitionTestTx) LockDraftGenerations(context.Context, string, string) ([]DraftGenerationState, error) {
	tx.record("lock_generations")
	return append([]DraftGenerationState(nil), tx.generations...), nil
}

func (tx *reviewTransitionTestTx) LockDraftUsages(context.Context, string, []string) ([]DraftUsageState, error) {
	tx.record("lock_usages")
	return append([]DraftUsageState(nil), tx.usages...), nil
}

func (tx *reviewTransitionTestTx) InsertGoalVersion(_ context.Context, version goal.Version) (int64, error) {
	tx.record("insert_version")
	tx.version = version
	tx.insertedVersion = &version
	return tx.row("insert_version", 1), nil
}

func (tx *reviewTransitionTestTx) TryInsertReviewCycleClaim(_ context.Context, claimed cycle.PDCACycle) (int64, error) {
	tx.record("claim_cycle")
	tx.cycle = claimed
	tx.claimedCycle = &claimed
	return tx.row("claim_cycle", 1), nil
}

func (tx *reviewTransitionTestTx) ContinueGoalCAS(_ context.Context, continued goal.Goal, _ int64) (int64, error) {
	tx.record("continue_goal")
	tx.goal = continued
	tx.continuedGoal = &continued
	return tx.row("continue_goal", 1), nil
}

func (tx *reviewTransitionTestTx) AttachDraftGenerations(_ context.Context, _, _ string, ids []string, _, _ string) (int64, error) {
	tx.record("attach_generations")
	tx.attachedGeneration = append([]string(nil), ids...)
	return tx.row("attach_generations", int64(len(ids))), nil
}

func (tx *reviewTransitionTestTx) AttachUsageToGoal(_ context.Context, _ string, ids []string, _ string) (int64, error) {
	tx.record("attach_usage")
	tx.attachedUsage = append([]string(nil), ids...)
	return tx.row("attach_usage", int64(len(ids))), nil
}

func (tx *reviewTransitionTestTx) CancelCycleCAS(_ context.Context, canceled cycle.PDCACycle, _ int64) (int64, error) {
	tx.record("cancel_cycle")
	tx.cycle = canceled
	tx.canceledCycle = &canceled
	return tx.row("cancel_cycle", 1), nil
}

func (tx *reviewTransitionTestTx) RedactDraftUsagesCAS(_ context.Context, _ string, ids []string) (int64, error) {
	tx.record("redact_usage")
	tx.redactedUsage = append([]string(nil), ids...)
	return tx.row("redact_usage", int64(len(ids))), nil
}

func (tx *reviewTransitionTestTx) DeleteExpiredFinalizedDraftUsagesCAS(_ context.Context, _ string, ids []string, now time.Time) (int64, error) {
	tx.record("delete_usage")
	tx.deletedUsage = append([]string(nil), ids...)
	tx.deletedAt = now
	return tx.row("delete_usage", int64(len(ids))), nil
}

func (tx *reviewTransitionTestTx) DeleteDraftGenerationsCAS(_ context.Context, _, _ string, ids []string) (int64, error) {
	tx.record("delete_generations")
	tx.deletedGeneration = append([]string(nil), ids...)
	return tx.row("delete_generations", int64(len(ids))), nil
}

func (tx *reviewTransitionTestTx) DeleteReviewDraftCAS(_ context.Context, _, draftID string, _ int64) (int64, error) {
	tx.record("delete_draft")
	tx.deletedDraftID = draftID
	return tx.row("delete_draft", 1), nil
}

func (tx *reviewTransitionTestTx) TerminateGoalCAS(_ context.Context, terminal goal.Goal, _ int64) (int64, error) {
	tx.record("terminate_goal")
	tx.goal = terminal
	tx.terminatedGoal = &terminal
	return tx.row("terminate_goal", 1), nil
}

func (tx *reviewTransitionTestTx) LoadGoalView(context.Context, string, string) (GoalView, error) {
	tx.record("goal_view")
	version := GoalVersionView{
		ID: tx.version.ID, VersionNumber: tx.version.VersionNumber,
		Body: tx.version.Body, CreatedAt: tx.version.CreatedAt,
	}
	view := GoalView{
		ID: tx.goal.ID, Status: tx.goal.Status, Revision: tx.goal.Revision,
		CurrentVersion: version, NextCycleSequenceNumber: tx.goal.NextCycleSequenceNumber,
		CreatedAt: tx.goal.CreatedAt, TerminalAt: tx.goal.TerminalAt,
	}
	switch tx.goal.Status {
	case goal.StatusActiveCycle:
		view.CurrentWork = &CurrentWorkView{Kind: "active_cycle", CycleID: tx.cycle.ID, CycleSequenceNumber: tx.cycle.SequenceNumber}
	case goal.StatusGoalReview:
		view.CurrentWork = &CurrentWorkView{
			Kind: "goal_review", ReviewDraftID: tx.draft.ID,
			TriggerCycleID: *tx.draft.ReviewCycleID, TriggerCycleSequenceNumber: 1,
		}
	}
	if tx.goalViewOverride != nil {
		view = tx.goalViewOverride(view)
	}
	return view, nil
}

func (tx *reviewTransitionTestTx) LoadCycleView(context.Context, string, string, string) (CycleView, error) {
	tx.record("cycle_view")
	view := CycleView{
		ID: tx.cycle.ID, GoalID: tx.cycle.GoalID, SequenceNumber: tx.cycle.SequenceNumber,
		Status: tx.cycle.Status, StartedAt: tx.cycle.StartedAt,
		CompletedAt: tx.cycle.CompletedAt, CanceledAt: tx.cycle.CanceledAt,
		CancellationReason: tx.cycle.CancellationReason,
		Plan:               tx.cycle.Plan, Do: tx.cycle.Do, Check: tx.cycle.Check, Action: tx.cycle.Action,
		ContentRevision: tx.cycle.Revisions.Content,
		FrameRevisions: FrameRevisions{
			Plan: tx.cycle.Revisions.Plan, Do: tx.cycle.Revisions.Do,
			Check: tx.cycle.Revisions.Check, Action: tx.cycle.Revisions.Action,
		},
		GoalVersion: GoalVersionView{
			ID: tx.version.ID, VersionNumber: tx.version.VersionNumber,
			Body: tx.version.Body, CreatedAt: tx.version.CreatedAt,
		},
	}
	if tx.cycleViewOverride != nil {
		view = tx.cycleViewOverride(view)
	}
	return view, nil
}

func reviewTransitionFixture(status goal.Status) *reviewTransitionTestTx {
	goalID := reviewTransitionTestGoalID
	versionID := reviewTransitionTestVersion1ID
	triggerCycleID := reviewTransitionTestCycle1ID
	return &reviewTransitionTestTx{
		goal: goal.Goal{
			ID: goalID, UserID: reviewTransitionTestUserID, Status: status,
			CurrentVersionNumber: 1, NextCycleSequenceNumber: 2, Revision: 5,
			CreatedAt: reviewTransitionTestNow.Add(-time.Hour), UpdatedAt: reviewTransitionTestNow.Add(-time.Minute),
		},
		cycle: cycle.PDCACycle{
			ID: reviewTransitionTestCycle1ID, UserID: reviewTransitionTestUserID, GoalID: goalID,
			GoalVersionID: versionID, SequenceNumber: 1, Status: cycle.StatusActive,
			StartedAt: reviewTransitionTestNow.Add(-time.Hour), Revisions: cycle.Revisions{Content: 2, Plan: 1, Do: 1},
		},
		draft: goal.Draft{
			ID: reviewTransitionTestDraftID, UserID: reviewTransitionTestUserID, Type: goal.DraftReview,
			GoalID: &goalID, BaseGoalVersionID: &versionID, ReviewCycleID: &triggerCycleID,
			Body: "変更した目標", Revision: 3, CreatedAt: reviewTransitionTestNow.Add(-time.Hour),
			UpdatedAt: reviewTransitionTestNow.Add(-time.Minute),
		},
		version: goal.Version{
			ID: versionID, UserID: reviewTransitionTestUserID, GoalID: goalID,
			VersionNumber: 1, Body: "元の目標", CreatedAt: reviewTransitionTestNow.Add(-time.Hour),
		},
		rows: make(map[string]int64),
	}
}

func TestContinueReviewFreshTransitionOwnsIDsClockHashAndExactWrites(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusGoalReview)
	tx.generations = []DraftGenerationState{{ID: reviewTransitionTestGen1ID, Status: "succeeded"}}
	tx.usages = []DraftUsageState{{OperationID: reviewTransitionTestGen1ID, QuotaRetainUntil: reviewTransitionTestNow.Add(time.Hour)}}
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow.Add(999 * time.Nanosecond)}
	ids := &reviewTransitionTestIDs{values: []string{reviewTransitionTestVersion2ID, reviewTransitionTestCycle2ID}}
	useCases := NewReviewTransitionUseCases(uow, clock, ids)
	input := ContinueReviewInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, ExpectedGoalRevision: 5, ExpectedDraftRevision: 3,
		RequestHash: "caller-hash", VersionID: reviewTransitionTestCycle1ID,
		CycleID: reviewTransitionTestCycle1ID, Now: reviewTransitionTestNow.Add(-24 * time.Hour),
	}

	result, err := useCases.ContinueReview(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if uow.committed != 1 || clock.calls != 1 || ids.calls != 2 || !result.VersionCreated || result.Replayed {
		t.Fatalf("transition counters/result = uow:%#v clock:%d ids:%d result:%#v", uow, clock.calls, ids.calls, result)
	}
	if tx.insertedVersion == nil || tx.insertedVersion.ID != reviewTransitionTestVersion2ID ||
		tx.claimedCycle == nil || tx.claimedCycle.ID != reviewTransitionTestCycle2ID ||
		tx.claimedCycle.StartRequestHash != continueReviewRequestHash(input) || tx.claimedCycle.StartRequestHash == input.RequestHash ||
		!tx.claimedCycle.StartedAt.Equal(reviewTransitionTestNow) {
		t.Fatalf("Application-owned transition = version:%#v cycle:%#v", tx.insertedVersion, tx.claimedCycle)
	}
	if !reflect.DeepEqual(tx.attachedGeneration, []string{reviewTransitionTestGen1ID}) ||
		!reflect.DeepEqual(tx.attachedUsage, []string{reviewTransitionTestGen1ID}) || tx.deletedDraftID != reviewTransitionTestDraftID {
		t.Fatalf("Review re-parent/delete = generations:%v usage:%v draft:%s", tx.attachedGeneration, tx.attachedUsage, tx.deletedDraftID)
	}
	wantTrace := []string{
		"continue_receipt", "lock_goal", "continue_receipt", "lock_draft", "lock_generations", "lock_usages", "load_version",
		"insert_version", "claim_cycle", "continue_goal", "attach_generations", "attach_usage", "delete_draft", "goal_view", "cycle_view",
	}
	if !reflect.DeepEqual(tx.trace, wantTrace) {
		t.Fatalf("Continue Review trace = %v, want %v", tx.trace, wantTrace)
	}
}

func TestContinueReviewRejectsCorruptFreshMaterialization(t *testing.T) {
	tests := []struct {
		name         string
		corruptGoal  func(GoalView) GoalView
		corruptCycle func(CycleView) CycleView
	}{
		{
			name: "Goal Version",
			corruptGoal: func(view GoalView) GoalView {
				view.CurrentVersion.Body = "corrupt"
				return view
			},
		},
		{
			name: "next Cycle sequence",
			corruptGoal: func(view GoalView) GoalView {
				view.NextCycleSequenceNumber++
				return view
			},
		},
		{
			name: "current work sequence",
			corruptGoal: func(view GoalView) GoalView {
				view.CurrentWork.CycleSequenceNumber++
				return view
			},
		},
		{
			name: "Cycle start time",
			corruptCycle: func(view CycleView) CycleView {
				view.StartedAt = view.StartedAt.Add(time.Second)
				return view
			},
		},
		{
			name: "fresh Cycle content",
			corruptCycle: func(view CycleView) CycleView {
				view.Plan = "unexpected"
				view.ContentRevision = 1
				view.FrameRevisions.Plan = 1
				return view
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx := reviewTransitionFixture(goal.StatusGoalReview)
			tx.goalViewOverride = test.corruptGoal
			tx.cycleViewOverride = test.corruptCycle
			uow := &reviewTransitionTestUOW{tx: tx}
			clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
			ids := &reviewTransitionTestIDs{values: []string{reviewTransitionTestVersion2ID, reviewTransitionTestCycle2ID}}

			_, err := NewReviewTransitionUseCases(uow, clock, ids).ContinueReview(context.Background(), ContinueReviewInput{
				UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
				OperationID: reviewTransitionTestOperation, ExpectedGoalRevision: 5, ExpectedDraftRevision: 3,
			})

			if !errors.Is(err, ErrReviewTransitionPersistenceInvariant) ||
				uow.rolledBack != 1 || uow.committed != 0 {
				t.Fatalf("corrupt fresh materialization = %v uow:%#v", err, uow)
			}
		})
	}
}

func TestContinueReviewReplayLocksGoalAndConsumesNoIDOrClock(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusActiveCycle)
	tx.cycle.ID = reviewTransitionTestCycle2ID
	tx.cycle.SequenceNumber = 2
	tx.goal.Revision = 6
	tx.goal.NextCycleSequenceNumber = 3
	input := ContinueReviewInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, ExpectedGoalRevision: 5, ExpectedDraftRevision: 3,
	}
	tx.continueReceipts = []*ContinueReviewReceipt{{
		GoalID: input.GoalID, CycleID: tx.cycle.ID,
		RequestHash: continueReviewRequestHash(input), VersionCreated: false,
	}}
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	ids := &reviewTransitionTestIDs{}

	result, err := NewReviewTransitionUseCases(uow, clock, ids).ContinueReview(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Replayed || clock.calls != 0 || ids.calls != 0 ||
		!reflect.DeepEqual(tx.trace, []string{"continue_receipt", "lock_goal", "goal_view", "cycle_view"}) {
		t.Fatalf("replay result/side effects = %#v clock:%d ids:%d trace:%v", result, clock.calls, ids.calls, tx.trace)
	}
}

func TestContinueReviewAttachesOnlyUsageRowsThatStillExist(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusGoalReview)
	tx.generations = []DraftGenerationState{
		{ID: reviewTransitionTestGen1ID, Status: "succeeded"},
		{ID: reviewTransitionTestGen2ID, Status: "failed"},
	}
	// The first Generation's finalized Usage may already have been removed by
	// retention cleanup. Continue still re-parents both content records and only
	// the surviving Usage row.
	tx.usages = []DraftUsageState{{
		OperationID:      reviewTransitionTestGen2ID,
		QuotaRetainUntil: reviewTransitionTestNow.Add(time.Hour),
	}}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	ids := &reviewTransitionTestIDs{values: []string{reviewTransitionTestVersion2ID, reviewTransitionTestCycle2ID}}
	_, err := NewReviewTransitionUseCases(&reviewTransitionTestUOW{tx: tx}, clock, ids).ContinueReview(
		context.Background(),
		ContinueReviewInput{
			UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
			OperationID: reviewTransitionTestOperation, ExpectedGoalRevision: 5, ExpectedDraftRevision: 3,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tx.attachedGeneration, []string{reviewTransitionTestGen1ID, reviewTransitionTestGen2ID}) ||
		!reflect.DeepEqual(tx.attachedUsage, []string{reviewTransitionTestGen2ID}) {
		t.Fatalf("attached generations/usages = %v / %v", tx.attachedGeneration, tx.attachedUsage)
	}
}

func TestContinueReviewRechecksReceiptAfterGoalLock(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusActiveCycle)
	tx.cycle.ID = reviewTransitionTestCycle2ID
	tx.cycle.SequenceNumber = 2
	tx.goal.Revision = 6
	tx.goal.NextCycleSequenceNumber = 3
	input := ContinueReviewInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, ExpectedGoalRevision: 5, ExpectedDraftRevision: 3,
	}
	tx.continueReceipts = []*ContinueReviewReceipt{nil, {
		GoalID: input.GoalID, CycleID: tx.cycle.ID, RequestHash: continueReviewRequestHash(input),
	}}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	ids := &reviewTransitionTestIDs{}
	result, err := NewReviewTransitionUseCases(&reviewTransitionTestUOW{tx: tx}, clock, ids).ContinueReview(context.Background(), input)
	if err != nil || !result.Replayed || clock.calls != 0 || ids.calls != 0 {
		t.Fatalf("post-lock receipt replay = %#v, %v, clock:%d ids:%d", result, err, clock.calls, ids.calls)
	}
}

func TestContinueReviewRunningAIPrecedesIDsAndClock(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusGoalReview)
	tx.generations = []DraftGenerationState{{ID: reviewTransitionTestGen1ID, Status: "running"}}
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	ids := &reviewTransitionTestIDs{values: []string{reviewTransitionTestVersion2ID, reviewTransitionTestCycle2ID}}
	_, err := NewReviewTransitionUseCases(uow, clock, ids).ContinueReview(context.Background(), ContinueReviewInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, ExpectedGoalRevision: 5, ExpectedDraftRevision: 3,
	})
	if !errors.Is(err, ErrAIInProgress) || uow.rolledBack != 1 || clock.calls != 0 || ids.calls != 0 {
		t.Fatalf("AI precedence = %v uow:%#v clock:%d ids:%d", err, uow, clock.calls, ids.calls)
	}
}

func TestTerminationDiscriminatedUnionAndHashCoverBranchFields(t *testing.T) {
	activeRevision := int64(2)
	active := TerminateInput{
		Outcome: goal.StatusEnded, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: reviewTransitionTestCycle1ID, ExpectedCycleContentRevision: &activeRevision,
	}
	tests := []TerminateInput{
		{Outcome: goal.StatusActiveCycle, ExpectedState: goal.StatusGoalReview},
		{Outcome: goal.StatusEnded, ExpectedState: goal.StatusActiveCycle},
		{Outcome: goal.StatusEnded, ExpectedState: goal.StatusActiveCycle, ActiveCycleID: reviewTransitionTestCycle1ID},
		{Outcome: goal.StatusEnded, ExpectedState: goal.StatusActiveCycle, ActiveCycleID: reviewTransitionTestCycle1ID, ExpectedCycleContentRevision: &activeRevision, ConfirmDiscardReviewDraft: true},
		{Outcome: goal.StatusEnded, ExpectedState: goal.StatusGoalReview, ActiveCycleID: reviewTransitionTestCycle1ID},
		{Outcome: goal.StatusEnded, ExpectedState: goal.StatusGoalReview, ExpectedCycleContentRevision: &activeRevision},
	}
	for _, input := range tests {
		uow := &reviewTransitionTestUOW{}
		_, err := NewReviewTransitionUseCases(uow, nil, nil).Terminate(context.Background(), input)
		if err == nil || uow.calls != 0 {
			t.Fatalf("invalid union entered transaction: %#v, %v", input, err)
		}
	}
	changedCycle := active
	changedCycle.ActiveCycleID = reviewTransitionTestCycle2ID
	changedConfirmation := TerminateInput{Outcome: goal.StatusEnded, ExpectedState: goal.StatusGoalReview}
	confirmed := changedConfirmation
	confirmed.ConfirmDiscardReviewDraft = true
	if terminateRequestHash(active) == terminateRequestHash(changedCycle) ||
		terminateRequestHash(changedConfirmation) == terminateRequestHash(confirmed) {
		t.Fatal("termination hash omitted a discriminated-union field")
	}
}

func TestTerminateActiveCycleUsesOneTimestampAndReturnsCanceledCycle(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusActiveCycle)
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow.Add(999 * time.Nanosecond)}
	revision := tx.cycle.Revisions.Content
	input := TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusAchieved,
		ExpectedGoalRevision: 5, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: tx.cycle.ID, ExpectedCycleContentRevision: &revision,
		RequestHash: "caller-hash", Now: reviewTransitionTestNow.Add(-time.Hour),
	}
	result, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if uow.committed != 1 || clock.calls != 1 || result.CanceledCycle == nil ||
		tx.canceledCycle == nil || tx.terminatedGoal == nil ||
		!tx.canceledCycle.CanceledAt.Equal(*tx.terminatedGoal.TerminalAt) ||
		!tx.terminatedGoal.TerminalAt.Equal(reviewTransitionTestNow) ||
		*tx.canceledCycle.CancellationReason != cycle.CancellationGoalAchieved ||
		tx.terminatedGoal.TerminalRequestHash != nil && *tx.terminatedGoal.TerminalRequestHash == input.RequestHash {
		t.Fatalf("active termination result/state = %#v canceled:%#v terminal:%#v", result, tx.canceledCycle, tx.terminatedGoal)
	}
	wantPrefix := []string{"lock_user", "termination_receipt", "lock_goal", "lock_cycle", "goal_ai", "cancel_cycle", "terminate_goal"}
	if !reflect.DeepEqual(tx.trace[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("active termination trace = %v", tx.trace)
	}
}

func TestTerminateActiveCycleRejectsHistoricalCycleBeforeRevisionAndClock(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusActiveCycle)
	tx.cycle.Status = cycle.StatusCompleted
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	staleRevision := tx.cycle.Revisions.Content - 1

	_, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: tx.goal.Revision, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: tx.cycle.ID, ExpectedCycleContentRevision: &staleRevision,
	})

	if !errors.Is(err, ErrGoalStateConflict) || errors.Is(err, cycle.ErrRevisionConflict) ||
		uow.rolledBack != 1 || uow.committed != 0 || clock.calls != 0 ||
		tx.canceledCycle != nil || tx.terminatedGoal != nil {
		t.Fatalf("historical active termination = %v uow:%#v clock:%d canceled:%#v terminal:%#v", err, uow, clock.calls, tx.canceledCycle, tx.terminatedGoal)
	}
	if !reflect.DeepEqual(tx.trace, []string{"lock_user", "termination_receipt", "lock_goal", "lock_cycle"}) {
		t.Fatalf("historical active termination trace = %v", tx.trace)
	}
}

func TestTerminateActiveCycleRunningAIPrecedesClockAndWrites(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusActiveCycle)
	tx.goalAIRunning = true
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	revision := tx.cycle.Revisions.Content

	_, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: tx.goal.Revision, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: tx.cycle.ID, ExpectedCycleContentRevision: &revision,
	})

	if !errors.Is(err, ErrAIInProgress) || uow.rolledBack != 1 || uow.committed != 0 ||
		clock.calls != 0 || tx.canceledCycle != nil || tx.terminatedGoal != nil {
		t.Fatalf("active AI precedence = %v uow:%#v clock:%d canceled:%#v terminal:%#v", err, uow, clock.calls, tx.canceledCycle, tx.terminatedGoal)
	}
	if !reflect.DeepEqual(tx.trace, []string{"lock_user", "termination_receipt", "lock_goal", "lock_cycle", "goal_ai"}) {
		t.Fatalf("active AI precedence trace = %v", tx.trace)
	}
}

func TestTerminateActiveRejectsGoalCycleVersionMismatchMaterialization(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusActiveCycle)
	tx.goalViewOverride = func(view GoalView) GoalView {
		view.CurrentVersion.ID = reviewTransitionTestVersion2ID
		return view
	}
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	revision := tx.cycle.Revisions.Content

	_, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: tx.goal.Revision, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: tx.cycle.ID, ExpectedCycleContentRevision: &revision,
	})

	if !errors.Is(err, ErrReviewTransitionPersistenceInvariant) ||
		uow.rolledBack != 1 || uow.committed != 0 {
		t.Fatalf("Goal/Cycle Version mismatch = %v uow:%#v", err, uow)
	}
}

func TestTerminateActiveRejectsCorruptCanceledCycleMaterialization(t *testing.T) {
	tests := []struct {
		name    string
		corrupt func(CycleView) CycleView
	}{
		{
			name: "sequence",
			corrupt: func(view CycleView) CycleView {
				view.SequenceNumber++
				return view
			},
		},
		{
			name: "start time",
			corrupt: func(view CycleView) CycleView {
				view.StartedAt = view.StartedAt.Add(time.Second)
				return view
			},
		},
		{
			name: "content and revisions",
			corrupt: func(view CycleView) CycleView {
				view.Plan = "corrupt"
				view.ContentRevision++
				view.FrameRevisions.Plan++
				return view
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx := reviewTransitionFixture(goal.StatusActiveCycle)
			tx.cycleViewOverride = test.corrupt
			uow := &reviewTransitionTestUOW{tx: tx}
			clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
			revision := tx.cycle.Revisions.Content

			_, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), TerminateInput{
				UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
				OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
				ExpectedGoalRevision: tx.goal.Revision, ExpectedState: goal.StatusActiveCycle,
				ActiveCycleID: tx.cycle.ID, ExpectedCycleContentRevision: &revision,
			})

			if !errors.Is(err, ErrReviewTransitionPersistenceInvariant) ||
				uow.rolledBack != 1 || uow.committed != 0 {
				t.Fatalf("corrupt canceled Cycle materialization = %v uow:%#v", err, uow)
			}
		})
	}
}

func TestTerminateReplayRestoresCanceledCycleWithoutClock(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusActiveCycle)
	revision := tx.cycle.Revisions.Content
	input := TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: 5, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: tx.cycle.ID, ExpectedCycleContentRevision: &revision,
	}
	now := reviewTransitionTestNow
	reason := cycle.CancellationGoalEnded
	tx.goal.Status, tx.goal.Revision, tx.goal.TerminalAt = goal.StatusEnded, 6, &now
	tx.cycle.Status, tx.cycle.CanceledAt, tx.cycle.CancellationReason = cycle.StatusCanceled, &now, &reason
	tx.termination = &GoalTerminationReceipt{GoalID: input.GoalID, RequestHash: terminateRequestHash(input)}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow.Add(time.Hour)}
	result, err := NewReviewTransitionUseCases(&reviewTransitionTestUOW{tx: tx}, clock, nil).Terminate(context.Background(), input)
	if err != nil || !result.Replayed || result.CanceledCycle == nil || clock.calls != 0 {
		t.Fatalf("termination replay = %#v, %v, clock:%d", result, err, clock.calls)
	}
	if !reflect.DeepEqual(tx.trace, []string{"lock_user", "termination_receipt", "lock_goal", "goal_view", "cycle_view"}) {
		t.Fatalf("termination replay trace = %v", tx.trace)
	}
}

func TestTerminateReviewPartitionsUsageAtExactRetentionBoundary(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusGoalReview)
	tx.generations = []DraftGenerationState{
		{ID: reviewTransitionTestGen1ID, Status: "succeeded"},
		{ID: reviewTransitionTestGen2ID, Status: "failed"},
		{ID: reviewTransitionTestGen3ID, Status: "failed"},
	}
	finalized := reviewTransitionTestNow.Add(-time.Minute)
	tx.usages = []DraftUsageState{
		{OperationID: reviewTransitionTestGen1ID, QuotaRetainUntil: reviewTransitionTestNow.Add(time.Microsecond), ProviderUsageFinalizedAt: &finalized},
		{OperationID: reviewTransitionTestGen2ID, QuotaRetainUntil: reviewTransitionTestNow, ProviderUsageFinalizedAt: &finalized},
		{OperationID: reviewTransitionTestGen3ID, QuotaRetainUntil: reviewTransitionTestNow.Add(-time.Hour)},
	}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow.Add(999 * time.Nanosecond)}
	input := TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: 5, ExpectedState: goal.StatusGoalReview, ConfirmDiscardReviewDraft: true,
	}
	result, err := NewReviewTransitionUseCases(&reviewTransitionTestUOW{tx: tx}, clock, nil).Terminate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result.CanceledCycle != nil || result.Goal.Status != goal.StatusEnded || clock.calls != 1 ||
		!reflect.DeepEqual(tx.redactedUsage, []string{reviewTransitionTestGen1ID, reviewTransitionTestGen3ID}) ||
		!reflect.DeepEqual(tx.deletedUsage, []string{reviewTransitionTestGen2ID}) ||
		!tx.deletedAt.Equal(reviewTransitionTestNow) ||
		!reflect.DeepEqual(tx.deletedGeneration, []string{reviewTransitionTestGen1ID, reviewTransitionTestGen2ID, reviewTransitionTestGen3ID}) {
		t.Fatalf("Review retention/result = %#v retained:%v deleted:%v generations:%v", result, tx.redactedUsage, tx.deletedUsage, tx.deletedGeneration)
	}
	want := []string{
		"lock_user", "termination_receipt", "lock_goal", "lock_draft", "lock_generations", "lock_usages", "load_version",
		"redact_usage", "delete_usage", "delete_generations", "delete_draft", "terminate_goal", "goal_view",
	}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("Review termination trace = %v, want %v", tx.trace, want)
	}
}

func TestTerminateReviewRunningAIPrecedesClockAndWrites(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusGoalReview)
	tx.generations = []DraftGenerationState{{ID: reviewTransitionTestGen1ID, Status: "running"}}
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}

	_, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: tx.goal.Revision, ExpectedState: goal.StatusGoalReview,
	})

	if !errors.Is(err, ErrAIInProgress) || uow.rolledBack != 1 || uow.committed != 0 ||
		clock.calls != 0 || tx.terminatedGoal != nil {
		t.Fatalf("Review AI precedence = %v uow:%#v clock:%d terminal:%#v", err, uow, clock.calls, tx.terminatedGoal)
	}
	if !reflect.DeepEqual(tx.trace, []string{"lock_user", "termination_receipt", "lock_goal", "lock_draft", "lock_generations"}) {
		t.Fatalf("Review AI precedence trace = %v", tx.trace)
	}
}

func TestTerminateReviewRejectsCorruptFreshMaterialization(t *testing.T) {
	tests := []struct {
		name    string
		corrupt func(GoalView) GoalView
	}{
		{
			name: "current Version",
			corrupt: func(view GoalView) GoalView {
				view.CurrentVersion.Body = "corrupt"
				return view
			},
		},
		{
			name: "terminal time",
			corrupt: func(view GoalView) GoalView {
				wrong := (*view.TerminalAt).Add(time.Second)
				view.TerminalAt = &wrong
				return view
			},
		},
		{
			name: "next Cycle sequence",
			corrupt: func(view GoalView) GoalView {
				view.NextCycleSequenceNumber++
				return view
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx := reviewTransitionFixture(goal.StatusGoalReview)
			tx.goalViewOverride = test.corrupt
			uow := &reviewTransitionTestUOW{tx: tx}
			clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}

			_, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), TerminateInput{
				UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
				OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
				ExpectedGoalRevision: tx.goal.Revision, ExpectedState: goal.StatusGoalReview,
				ConfirmDiscardReviewDraft: true,
			})

			if !errors.Is(err, ErrReviewTransitionPersistenceInvariant) ||
				uow.rolledBack != 1 || uow.committed != 0 {
				t.Fatalf("corrupt fresh materialization = %v uow:%#v", err, uow)
			}
		})
	}
}

func TestTerminateReviewFailsClosedOnCurrentVersionInvariant(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusGoalReview)
	tx.versionErr = ErrGoalVersionConflict
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	_, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: 5, ExpectedState: goal.StatusGoalReview,
	})
	if !errors.Is(err, ErrReviewTransitionPersistenceInvariant) || errors.Is(err, ErrGoalVersionConflict) ||
		uow.rolledBack != 1 || clock.calls != 0 {
		t.Fatalf("Version invariant = %v uow:%#v clock:%d", err, uow, clock.calls)
	}
}

func TestTerminateReviewRequiresDiscardConfirmationBeforeClockAndWrites(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusGoalReview)
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	_, err := NewReviewTransitionUseCases(uow, clock, nil).Terminate(context.Background(), TerminateInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: 5, ExpectedState: goal.StatusGoalReview,
	})
	if !errors.Is(err, ErrDiscardConfirmation) || uow.rolledBack != 1 || clock.calls != 0 || tx.terminatedGoal != nil {
		t.Fatalf("discard confirmation = %v uow:%#v clock:%d terminal:%#v", err, uow, clock.calls, tx.terminatedGoal)
	}
}

func TestReviewTransitionAffectedRowsRollback(t *testing.T) {
	tx := reviewTransitionFixture(goal.StatusGoalReview)
	tx.rows["claim_cycle"] = 2
	uow := &reviewTransitionTestUOW{tx: tx}
	clock := &reviewTransitionTestClock{now: reviewTransitionTestNow}
	ids := &reviewTransitionTestIDs{values: []string{reviewTransitionTestVersion2ID, reviewTransitionTestCycle2ID}}
	_, err := NewReviewTransitionUseCases(uow, clock, ids).ContinueReview(context.Background(), ContinueReviewInput{
		UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
		OperationID: reviewTransitionTestOperation, ExpectedGoalRevision: 5, ExpectedDraftRevision: 3,
	})
	if !errors.Is(err, ErrReviewTransitionPersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 {
		t.Fatalf("affected rows = %v uow:%#v", err, uow)
	}
}
