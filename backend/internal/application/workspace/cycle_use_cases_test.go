package workspace

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

const (
	cycleTestUserID    = "10000000-0000-7000-8000-000000000001"
	cycleTestGoalID    = "20000000-0000-7000-8000-000000000001"
	cycleTestCycleID1  = "30000000-0000-7000-8000-000000000001"
	cycleTestCycleID2  = "30000000-0000-7000-8000-000000000002"
	cycleTestCycleID3  = "30000000-0000-7000-8000-000000000003"
	cycleTestVersionID = "40000000-0000-7000-8000-000000000001"
	cycleTestDraftID   = "50000000-0000-7000-8000-000000000001"
	cycleTestOperation = "60000000-0000-7000-8000-000000000001"
)

var cycleTestNow = time.Date(2026, time.August, 24, 12, 34, 56, 123456000, time.FixedZone("JST", 9*60*60))

type cycleTestQueries struct {
	rowPages    [][]CycleSummary
	rowErr      error
	view        CycleView
	viewErr     error
	listQueries []CycleListQuery
	getArgs     []string
}

func (queries *cycleTestQueries) QueryCycleRows(_ context.Context, query CycleListQuery) ([]CycleSummary, error) {
	queries.listQueries = append(queries.listQueries, query)
	if queries.rowErr != nil {
		return nil, queries.rowErr
	}
	index := len(queries.listQueries) - 1
	if index >= len(queries.rowPages) {
		return nil, nil
	}
	return append([]CycleSummary(nil), queries.rowPages[index]...), nil
}

func (queries *cycleTestQueries) QueryCycle(_ context.Context, userID, goalID, cycleID string) (CycleView, error) {
	queries.getArgs = []string{userID, goalID, cycleID}
	return queries.view, queries.viewErr
}

func cycleSummaryFixture(id string, sequence int32) CycleSummary {
	return CycleSummary{
		ID: id, SequenceNumber: sequence, Status: cycle.StatusActive,
		StartedAt: cycleTestNow.Add(-time.Duration(sequence) * time.Hour),
		GoalVersion: GoalVersionView{
			ID: cycleTestVersionID, VersionNumber: 1, Body: "goal",
			CreatedAt: cycleTestNow.Add(-24 * time.Hour),
		},
	}
}

func TestCycleListOwnsLimitPlusOneCursorAndStableTiePagination(t *testing.T) {
	queries := &cycleTestQueries{rowPages: [][]CycleSummary{
		{
			cycleSummaryFixture(cycleTestCycleID3, 2),
			cycleSummaryFixture(cycleTestCycleID2, 2),
			cycleSummaryFixture(cycleTestCycleID1, 2),
		},
		{cycleSummaryFixture(cycleTestCycleID1, 2)},
	}}
	useCases := NewCycleUseCases(queries, nil, nil, nil, CycleUseCaseSettings{CursorSigningKey: []byte("cycle-wire-secret")})

	first, err := useCases.ListCycles(context.Background(), cycleTestUserID, cycleTestGoalID, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.NextCursor == nil || first.Items[0].ID != cycleTestCycleID3 || first.Items[1].ID != cycleTestCycleID2 {
		t.Fatalf("first page = %#v", first)
	}
	const golden = "eyJzY29wZSI6ImN5Y2xlczoyMDAwMDAwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJzZXF1ZW5jZSI6MiwiaWQiOiIzMDAwMDAwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwMDIifZvTk7UZqyvEq6qn_mxbmA1fvwcYvyQqkJ3m_25GOx21"
	if *first.NextCursor != golden {
		t.Fatalf("Cycle cursor wire changed:\n got %s\nwant %s", *first.NextCursor, golden)
	}
	second, err := useCases.ListCycles(context.Background(), cycleTestUserID, cycleTestGoalID, *first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID != cycleTestCycleID1 || second.NextCursor != nil {
		t.Fatalf("second page = %#v", second)
	}
	if len(queries.listQueries) != 2 || queries.listQueries[0].FetchLimit != 3 || queries.listQueries[0].After != nil ||
		queries.listQueries[1].FetchLimit != 3 || queries.listQueries[1].After == nil ||
		queries.listQueries[1].After.SequenceNumber != 2 || queries.listQueries[1].After.CycleID != cycleTestCycleID2 {
		t.Fatalf("decoded queries = %#v", queries.listQueries)
	}
	if queries.listQueries[0].UserID != cycleTestUserID || queries.listQueries[0].GoalID != cycleTestGoalID {
		t.Fatalf("owner scope = %#v", queries.listQueries[0])
	}
}

func TestCycleListRejectsTamperAndWrongGoalScopeBeforeQuery(t *testing.T) {
	queries := &cycleTestQueries{}
	useCases := NewCycleUseCases(queries, nil, nil, nil, CycleUseCaseSettings{CursorSigningKey: []byte("cycle-wire-secret")})
	valid, err := useCases.encodeCycleCursor(cycleTestGoalID, CycleListKeyset{SequenceNumber: 2, CycleID: cycleTestCycleID2})
	if err != nil {
		t.Fatal(err)
	}
	tampered := valid[:len(valid)-1] + "A"
	for name, cursorValue := range map[string]string{
		"tampered":    tampered,
		"wrong scope": valid,
	} {
		t.Run(name, func(t *testing.T) {
			goalID := cycleTestGoalID
			if name == "wrong scope" {
				goalID = "20000000-0000-7000-8000-000000000002"
			}
			_, listErr := useCases.ListCycles(context.Background(), cycleTestUserID, goalID, cursorValue, 20)
			if !errors.Is(listErr, ErrInvalidCursor) {
				t.Fatalf("error = %v", listErr)
			}
		})
	}
	if len(queries.listQueries) != 0 {
		t.Fatalf("queries after invalid cursor = %d", len(queries.listQueries))
	}
}

func TestCycleQueriesPreserveResourceSpecificOwnerErrors(t *testing.T) {
	queries := &cycleTestQueries{rowErr: ErrGoalNotFound, viewErr: ErrCycleNotFound}
	useCases := NewCycleUseCases(queries, nil, nil, nil, CycleUseCaseSettings{})
	if _, err := useCases.ListCycles(context.Background(), cycleTestUserID, cycleTestGoalID, "", 20); !errors.Is(err, ErrGoalNotFound) {
		t.Fatalf("ListCycles error = %v", err)
	}
	if _, err := useCases.GetCycle(context.Background(), cycleTestUserID, cycleTestGoalID, cycleTestCycleID1); !errors.Is(err, ErrCycleNotFound) {
		t.Fatalf("GetCycle error = %v", err)
	}
	if !reflect.DeepEqual(queries.getArgs, []string{cycleTestUserID, cycleTestGoalID, cycleTestCycleID1}) {
		t.Fatalf("GetCycle owner scope = %#v", queries.getArgs)
	}
}

func TestCycleListValidatesBoundedLearningPreviews(t *testing.T) {
	completedAt := cycleTestNow
	validLearning := &CycleLearningPreview{
		Check:  CycleFramePreview{Text: "分かったこと"},
		Action: CycleFramePreview{Text: strings.Repeat("🌱", CycleSummaryPreviewMaxCodePoints), Truncated: true},
	}
	completed := cycleSummaryFixture(cycleTestCycleID1, 1)
	completed.Status = cycle.StatusCompleted
	completed.CompletedAt = &completedAt
	completed.LearningPreview = validLearning

	tests := []struct {
		name    string
		mutate  func(*CycleSummary)
		wantErr bool
	}{
		{name: "valid terminal preview"},
		{name: "active omits learning preview", mutate: func(summary *CycleSummary) {
			summary.Status = cycle.StatusActive
			summary.CompletedAt = nil
			summary.LearningPreview = nil
		}},
		{name: "terminal preview may preserve empty frames", mutate: func(summary *CycleSummary) {
			summary.LearningPreview = &CycleLearningPreview{}
		}},
		{name: "terminal preview may preserve newlines", mutate: func(summary *CycleSummary) {
			summary.LearningPreview.Check.Text = "1行目\n2行目"
		}},
		{name: "terminal preview preserves Unicode whitespace", mutate: func(summary *CycleSummary) {
			summary.LearningPreview.Check.Text = "\u2003\n"
		}},
		{name: "active learning preview", mutate: func(summary *CycleSummary) {
			summary.Status = cycle.StatusActive
			summary.CompletedAt = nil
		}, wantErr: true},
		{name: "missing terminal learning preview", mutate: func(summary *CycleSummary) {
			summary.LearningPreview = nil
		}, wantErr: true},
		{name: "oversized plan preview", mutate: func(summary *CycleSummary) {
			summary.PlanPreview = strings.Repeat("界", CycleSummaryPreviewMaxCodePoints+1)
		}, wantErr: true},
		{name: "oversized learning preview", mutate: func(summary *CycleSummary) {
			summary.LearningPreview.Check.Text = strings.Repeat("界", CycleSummaryPreviewMaxCodePoints+1)
		}, wantErr: true},
		{name: "short preview marked truncated", mutate: func(summary *CycleSummary) {
			summary.LearningPreview.Check = CycleFramePreview{Text: "短い", Truncated: true}
		}, wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := completed
			learning := *validLearning
			candidate.LearningPreview = &learning
			if test.mutate != nil {
				test.mutate(&candidate)
			}
			queries := &cycleTestQueries{rowPages: [][]CycleSummary{{candidate}}}
			useCases := NewCycleUseCases(queries, nil, nil, nil, CycleUseCaseSettings{
				CursorSigningKey: []byte("cycle-wire-secret"),
			})
			_, err := useCases.ListCycles(context.Background(), cycleTestUserID, cycleTestGoalID, "", 20)
			if test.wantErr && !errors.Is(err, ErrCyclePersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, ErrCyclePersistenceInvariant)
			}
			if !test.wantErr && err != nil {
				t.Fatal(err)
			}
		})
	}
}

type cycleUseCaseTestClock struct {
	now   time.Time
	calls int
}

func (clock *cycleUseCaseTestClock) Now() time.Time {
	clock.calls++
	return clock.now
}

type cycleUseCaseTestIDs struct {
	id    string
	err   error
	calls int
}

func (ids *cycleUseCaseTestIDs) NewID() (string, error) {
	ids.calls++
	return ids.id, ids.err
}

type cycleTestUOW struct {
	tx         *cycleTestTx
	committed  int
	rolledBack int
}

func (uow *cycleTestUOW) WithinCycleTransaction(ctx context.Context, operation func(CycleTx) error) error {
	err := operation(uow.tx)
	if err != nil {
		uow.rolledBack++
		return err
	}
	uow.committed++
	return nil
}

type cycleTestTx struct {
	trace []string

	receipts          []*CompleteCycleReceipt
	receiptCall       int
	receiptErr        error
	replanReceipts    []*ReplanCycleReceipt
	replanReceiptCall int
	replanReceiptErr  error
	goal              goal.Goal
	goalErr           error
	current           cycle.PDCACycle
	cycleErr          error
	version           goal.Version
	versionErr        error
	aiRunning         bool
	aiErr             error

	saveRows     int64
	scheduleRows int64
	completeRows int64
	cancelRows   int64
	cycleRows    int64
	replanRows   int64
	draftRows    int64
	goalRows     int64
	writeErr     error

	savedFrame             cycle.Frame
	savedCycle             cycle.PDCACycle
	saveExpectedRevision   int64
	savedSchedule          cycle.PDCACycle
	scheduleExpected       int64
	completedCycle         cycle.PDCACycle
	completeExpected       int64
	canceledCycle          cycle.PDCACycle
	insertedCycle          cycle.PDCACycle
	replannedGoal          goal.Goal
	insertedDraft          goal.Draft
	reviewingGoal          goal.Goal
	goalExpectedRevision   int64
	loadedVersionNumber    int32
	goalView               GoalView
	cycleView              CycleView
	cycleViews             map[string]CycleView
	cycleViewIDs           []string
	draftView              *DraftView
	materializationLoadErr error
}

func (tx *cycleTestTx) FindCompleteCycleReceipt(context.Context, string, string) (*CompleteCycleReceipt, error) {
	tx.trace = append(tx.trace, "receipt")
	if tx.receiptErr != nil {
		return nil, tx.receiptErr
	}
	index := tx.receiptCall
	tx.receiptCall++
	if index >= len(tx.receipts) {
		return nil, nil
	}
	return tx.receipts[index], nil
}

func (tx *cycleTestTx) FindReplanCycleReceipt(context.Context, string, string) (*ReplanCycleReceipt, error) {
	tx.trace = append(tx.trace, "replan-receipt")
	if tx.replanReceiptErr != nil {
		return nil, tx.replanReceiptErr
	}
	index := tx.replanReceiptCall
	tx.replanReceiptCall++
	if index >= len(tx.replanReceipts) {
		return nil, nil
	}
	return tx.replanReceipts[index], nil
}

func (tx *cycleTestTx) LockUser(context.Context, string) error {
	tx.trace = append(tx.trace, "user")
	return nil
}

func (tx *cycleTestTx) LockGoal(context.Context, string, string) (goal.Goal, error) {
	tx.trace = append(tx.trace, "goal")
	return tx.goal, tx.goalErr
}

func (tx *cycleTestTx) LockCycle(context.Context, string, string, string) (cycle.PDCACycle, error) {
	tx.trace = append(tx.trace, "cycle")
	return tx.current, tx.cycleErr
}

func (tx *cycleTestTx) LoadCurrentGoalVersion(_ context.Context, _, _ string, versionNumber int32) (goal.Version, error) {
	tx.trace = append(tx.trace, "version")
	tx.loadedVersionNumber = versionNumber
	return tx.version, tx.versionErr
}

func (tx *cycleTestTx) HasRunningCycleGeneration(context.Context, string, string, string) (bool, error) {
	tx.trace = append(tx.trace, "ai")
	return tx.aiRunning, tx.aiErr
}

func (tx *cycleTestTx) SaveCycleFrameCAS(_ context.Context, saved cycle.PDCACycle, frame cycle.Frame, expected int64) (int64, error) {
	tx.trace = append(tx.trace, "save")
	tx.savedCycle, tx.savedFrame, tx.saveExpectedRevision = saved, frame, expected
	return tx.saveRows, tx.writeErr
}

func (tx *cycleTestTx) SaveCycleReviewScheduleCAS(
	_ context.Context,
	saved cycle.PDCACycle,
	expected int64,
) (int64, error) {
	tx.trace = append(tx.trace, "save-schedule")
	tx.savedSchedule, tx.scheduleExpected = saved, expected
	return tx.scheduleRows, tx.writeErr
}

func (tx *cycleTestTx) CompleteCycleCAS(_ context.Context, completed cycle.PDCACycle, expected int64) (int64, error) {
	tx.trace = append(tx.trace, "complete")
	tx.completedCycle, tx.completeExpected = completed, expected
	return tx.completeRows, tx.writeErr
}

func (tx *cycleTestTx) CancelCycleCAS(_ context.Context, canceled cycle.PDCACycle, expected int64) (int64, error) {
	tx.trace = append(tx.trace, "cancel")
	tx.canceledCycle, tx.completeExpected = canceled, expected
	return tx.cancelRows, tx.writeErr
}

func (tx *cycleTestTx) TryInsertCycleClaim(_ context.Context, created cycle.PDCACycle) (int64, error) {
	tx.trace = append(tx.trace, "insert-cycle")
	tx.insertedCycle = created
	return tx.cycleRows, tx.writeErr
}

func (tx *cycleTestTx) ReplanGoalCAS(_ context.Context, replanned goal.Goal, expected int64) (int64, error) {
	tx.trace = append(tx.trace, "replan-goal")
	tx.replannedGoal, tx.goalExpectedRevision = replanned, expected
	return tx.replanRows, tx.writeErr
}

func (tx *cycleTestTx) InsertReviewDraft(_ context.Context, draft goal.Draft) (int64, error) {
	tx.trace = append(tx.trace, "draft")
	tx.insertedDraft = draft
	return tx.draftRows, tx.writeErr
}

func (tx *cycleTestTx) EnterGoalReviewCAS(_ context.Context, reviewing goal.Goal, expected int64) (int64, error) {
	tx.trace = append(tx.trace, "review")
	tx.reviewingGoal, tx.goalExpectedRevision = reviewing, expected
	return tx.goalRows, tx.writeErr
}

func (tx *cycleTestTx) LoadGoalView(context.Context, string, string) (GoalView, error) {
	tx.trace = append(tx.trace, "load-goal")
	return tx.goalView, tx.materializationLoadErr
}

func (tx *cycleTestTx) LoadCycleView(_ context.Context, _, _ string, cycleID string) (CycleView, error) {
	tx.trace = append(tx.trace, "load-cycle")
	tx.cycleViewIDs = append(tx.cycleViewIDs, cycleID)
	if tx.materializationLoadErr != nil {
		return CycleView{}, tx.materializationLoadErr
	}
	if tx.cycleViews != nil {
		view, ok := tx.cycleViews[cycleID]
		if !ok {
			return CycleView{}, ErrCycleNotFound
		}
		return view, nil
	}
	return tx.cycleView, tx.materializationLoadErr
}

func (tx *cycleTestTx) FindReviewDraftByCycle(context.Context, string, string, string) (*DraftView, error) {
	tx.trace = append(tx.trace, "load-draft")
	return tx.draftView, tx.materializationLoadErr
}

func cycleCommandFixture() (*cycleTestTx, *cycleUseCaseTestClock, *cycleUseCaseTestIDs, CompleteCycleInput) {
	now := cycleTestNow.UTC()
	startedAt := now.Add(-time.Hour)
	goalID, versionID, cycleID := cycleTestGoalID, cycleTestVersionID, cycleTestCycleID1
	versionView := GoalVersionView{
		ID: versionID, VersionNumber: 2, Body: "goal body", CreatedAt: now.Add(-24 * time.Hour),
	}
	current := cycle.PDCACycle{
		ID: cycleID, UserID: cycleTestUserID, GoalID: goalID, GoalVersionID: versionID,
		SequenceNumber: 3, Status: cycle.StatusActive, StartedAt: startedAt,
		Plan: "P", Do: "D", Check: "C", Action: "A",
		Revisions: cycle.Revisions{Content: 4, Plan: 1, Do: 1, Check: 1, Action: 1},
		CreatedAt: startedAt, UpdatedAt: startedAt,
	}
	completedAt := now
	draftGoalID, draftVersionID, draftCycleID := goalID, versionID, cycleID
	tx := &cycleTestTx{
		goal: goal.Goal{
			ID: goalID, UserID: cycleTestUserID, Status: goal.StatusActiveCycle,
			CurrentVersionNumber: 2, NextCycleSequenceNumber: 4, Revision: 5,
			CreatedAt: now.Add(-48 * time.Hour), UpdatedAt: startedAt,
		},
		current: current,
		version: goal.Version{
			ID: versionID, UserID: cycleTestUserID, GoalID: goalID, VersionNumber: 2,
			Body: "goal body", CreatedAt: versionView.CreatedAt,
		},
		saveRows: 1, scheduleRows: 1, completeRows: 1, cancelRows: 1, cycleRows: 1, replanRows: 1,
		draftRows: 1, goalRows: 1,
		cycleView: CycleView{
			ID: cycleID, GoalID: goalID, SequenceNumber: 3, Status: cycle.StatusCompleted,
			GoalVersion: versionView, StartedAt: startedAt, CompletedAt: &completedAt,
			Plan: "P", Do: "D", Check: "C", Action: "A", ContentRevision: 4,
			FrameRevisions: FrameRevisions{Plan: 1, Do: 1, Check: 1, Action: 1},
		},
		goalView: GoalView{
			ID: goalID, Status: goal.StatusGoalReview, Revision: 6, CurrentVersion: versionView,
			CurrentWork: &CurrentWorkView{
				Kind: "goal_review", ReviewDraftID: cycleTestDraftID,
				TriggerCycleID: cycleID, TriggerCycleSequenceNumber: 3,
			},
			NextCycleSequenceNumber: 4, CreatedAt: now.Add(-48 * time.Hour),
		},
		draftView: &DraftView{
			ID: cycleTestDraftID, DraftType: string(goal.DraftReview), GoalID: &draftGoalID,
			BaseGoalVersionID: &draftVersionID, ReviewCycleID: &draftCycleID,
			Body: "goal body", Revision: 0, UpdatedAt: now,
		},
	}
	clock := &cycleUseCaseTestClock{now: cycleTestNow}
	ids := &cycleUseCaseTestIDs{id: cycleTestDraftID}
	input := CompleteCycleInput{
		UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
		OperationID: cycleTestOperation, ExpectedGoalRevision: 5, ExpectedContentRevision: 4,
	}
	return tx, clock, ids, input
}

func replanCycleFixture(t *testing.T) (*cycleTestTx, *cycleUseCaseTestClock, *cycleUseCaseTestIDs, ReplanCycleInput) {
	t.Helper()
	tx, clock, ids, _ := cycleCommandFixture()
	ids.id = cycleTestCycleID2
	reviewDate, err := cycle.ParseReviewDate("2026-09-30")
	if err != nil {
		t.Fatal(err)
	}
	tx.current.ReviewDate = &reviewDate
	tx.current.ReviewScheduleRevision = 2
	canceledAt := cycleTestNow.UTC()
	reason := cycle.CancellationReplanned
	versionView := GoalVersionView{
		ID: tx.version.ID, VersionNumber: tx.version.VersionNumber, Body: tx.version.Body, CreatedAt: tx.version.CreatedAt,
	}
	canceled := CycleView{
		ID: tx.current.ID, GoalID: tx.current.GoalID, SequenceNumber: tx.current.SequenceNumber,
		Status: cycle.StatusCanceled, GoalVersion: versionView, StartedAt: tx.current.StartedAt,
		CanceledAt: &canceledAt, CancellationReason: &reason,
		Plan: tx.current.Plan, Do: tx.current.Do, Check: tx.current.Check, Action: tx.current.Action,
		ContentRevision: tx.current.Revisions.Content,
		FrameRevisions: FrameRevisions{
			Plan: tx.current.Revisions.Plan, Do: tx.current.Revisions.Do,
			Check: tx.current.Revisions.Check, Action: tx.current.Revisions.Action,
		},
		ReviewDate: &reviewDate, ReviewScheduleRevision: 2,
	}
	next := CycleView{
		ID: cycleTestCycleID2, GoalID: tx.current.GoalID, SequenceNumber: tx.current.SequenceNumber + 1,
		Status: cycle.StatusActive, GoalVersion: versionView, StartedAt: canceledAt,
		Predecessor: &CyclePredecessorView{
			CycleID: tx.current.ID, CycleSequenceNumber: tx.current.SequenceNumber,
			Status: cycle.StatusCanceled, CancellationReason: &reason, GoalVersionNumber: tx.version.VersionNumber,
		},
	}
	tx.cycleViews = map[string]CycleView{tx.current.ID: canceled, cycleTestCycleID2: next}
	tx.goalView = GoalView{
		ID: tx.goal.ID, Status: goal.StatusActiveCycle, Revision: tx.goal.Revision + 1,
		CurrentVersion: versionView,
		CurrentWork: &CurrentWorkView{
			Kind: "active_cycle", CycleID: cycleTestCycleID2, CycleSequenceNumber: next.SequenceNumber,
			ReviewSchedule: &ReviewScheduleView{},
		},
		NextCycleSequenceNumber: next.SequenceNumber + 1,
		CreatedAt:               tx.goal.CreatedAt,
	}
	input := ReplanCycleInput{
		UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
		OperationID: cycleTestOperation, ExpectedGoalRevision: tx.goal.Revision,
		ExpectedContentRevision: tx.current.Revisions.Content, ExpectedReviewScheduleRevision: 2,
		Confirmed: true,
	}
	return tx, clock, ids, input
}

func TestSaveFrameOwnsGoalCycleOrderAndStaleSameContentNoOp(t *testing.T) {
	tx, clock, _, _ := cycleCommandFixture()
	tx.current.Plan = "same body"
	tx.current.Revisions.Plan = 8
	tx.current.Revisions.Content = 11
	tx.current.Revisions.Do = 1
	tx.current.Revisions.Check = 1
	tx.current.Revisions.Action = 1
	tx.current.UpdatedAt = cycleTestNow.Add(-time.Minute).UTC()
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, nil, CycleUseCaseSettings{})

	result, err := useCases.SaveFrame(context.Background(), SaveFrameInput{
		UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
		Frame: cycle.FramePlan, Content: "same body", ExpectedFrameRevision: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tx.trace, []string{"goal", "cycle"}) {
		t.Fatalf("SaveFrame trace = %v", tx.trace)
	}
	if result.FrameRevision != 8 || result.ContentRevision != 11 || !result.SavedAt.Equal(tx.current.UpdatedAt) ||
		result.Content != "same body" || clock.calls != 1 || uow.committed != 1 {
		t.Fatalf("no-op result = %#v, clock=%d, uow=%#v", result, clock.calls, uow)
	}
}

func TestChangeReviewScheduleOwnsTaggedCASAndResponseLossConvergence(t *testing.T) {
	date, err := cycle.ParseReviewDate("2026-09-30")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("set materializes full Cycle without changing content revision", func(t *testing.T) {
		tx, clock, ids, _ := cycleCommandFixture()
		tx.current.SequenceNumber = 1
		tx.cycleView = activeReviewScheduleCycleView(tx, &date, 1)
		useCases := NewCycleUseCases(nil, &cycleTestUOW{tx: tx}, clock, ids, CycleUseCaseSettings{})

		result, changeErr := useCases.ChangeReviewSchedule(context.Background(), ChangeReviewScheduleInput{
			UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
			ReviewDate: &date, ExpectedReviewScheduleRevision: 0,
		})
		if changeErr != nil {
			t.Fatal(changeErr)
		}
		if !reflect.DeepEqual(tx.trace, []string{"goal", "cycle", "save-schedule", "load-cycle"}) {
			t.Fatalf("trace = %#v", tx.trace)
		}
		if tx.savedSchedule.ReviewDate == nil || *tx.savedSchedule.ReviewDate != date ||
			tx.savedSchedule.ReviewScheduleRevision != 1 || tx.scheduleExpected != 0 ||
			tx.savedSchedule.Revisions != tx.current.Revisions {
			t.Fatalf("saved schedule = %#v, expected = %d", tx.savedSchedule, tx.scheduleExpected)
		}
		if result.Cycle.ReviewDate == nil || *result.Cycle.ReviewDate != date ||
			result.Cycle.ReviewScheduleRevision != 1 || result.Cycle.ContentRevision != tx.current.Revisions.Content {
			t.Fatalf("result = %#v", result)
		}
		if clock.calls != 0 {
			t.Fatalf("review schedule unexpectedly used Instant clock %d times", clock.calls)
		}
	})

	t.Run("stale same target after response loss is a no-op", func(t *testing.T) {
		tx, clock, ids, _ := cycleCommandFixture()
		tx.current.SequenceNumber = 1
		tx.current.ReviewDate = &date
		tx.current.ReviewScheduleRevision = 1
		tx.cycleView = activeReviewScheduleCycleView(tx, &date, 1)
		useCases := NewCycleUseCases(nil, &cycleTestUOW{tx: tx}, clock, ids, CycleUseCaseSettings{})
		_, changeErr := useCases.ChangeReviewSchedule(context.Background(), ChangeReviewScheduleInput{
			UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
			ReviewDate: &date, ExpectedReviewScheduleRevision: 0,
		})
		if changeErr != nil || !reflect.DeepEqual(tx.trace, []string{"goal", "cycle", "load-cycle"}) {
			t.Fatalf("same-target result error = %v, trace = %#v", changeErr, tx.trace)
		}
	})

	t.Run("stale different target conflicts before persistence", func(t *testing.T) {
		tx, clock, ids, _ := cycleCommandFixture()
		tx.current.ReviewDate = &date
		tx.current.ReviewScheduleRevision = 1
		different, _ := cycle.ParseReviewDate("2026-10-01")
		uow := &cycleTestUOW{tx: tx}
		useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
		_, changeErr := useCases.ChangeReviewSchedule(context.Background(), ChangeReviewScheduleInput{
			UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
			ReviewDate: &different, ExpectedReviewScheduleRevision: 0,
		})
		if !errors.Is(changeErr, cycle.ErrRevisionConflict) || uow.rolledBack != 1 ||
			!reflect.DeepEqual(tx.trace, []string{"goal", "cycle"}) {
			t.Fatalf("different-target error = %v, rollback = %d, trace = %#v", changeErr, uow.rolledBack, tx.trace)
		}
	})

	t.Run("write failures and zero-row CAS roll back", func(t *testing.T) {
		writerErr := errors.New("schedule storage unavailable")
		materializationErr := errors.New("schedule materialization unavailable")
		tests := []struct {
			name      string
			configure func(*cycleTestTx)
			wantError error
			wantTrace []string
		}{
			{
				name: "writer error",
				configure: func(tx *cycleTestTx) {
					tx.writeErr = writerErr
				},
				wantError: writerErr,
				wantTrace: []string{"goal", "cycle", "save-schedule"},
			},
			{
				name: "zero rows",
				configure: func(tx *cycleTestTx) {
					tx.scheduleRows = 0
				},
				wantError: ErrCyclePersistenceInvariant,
				wantTrace: []string{"goal", "cycle", "save-schedule"},
			},
			{
				name: "post-write materialization",
				configure: func(tx *cycleTestTx) {
					tx.materializationLoadErr = materializationErr
				},
				wantError: materializationErr,
				wantTrace: []string{"goal", "cycle", "save-schedule", "load-cycle"},
			},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				tx, clock, ids, _ := cycleCommandFixture()
				tx.current.SequenceNumber = 1
				test.configure(tx)
				uow := &cycleTestUOW{tx: tx}
				useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
				_, changeErr := useCases.ChangeReviewSchedule(context.Background(), ChangeReviewScheduleInput{
					UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
					ReviewDate: &date, ExpectedReviewScheduleRevision: 0,
				})
				if !errors.Is(changeErr, test.wantError) {
					t.Fatalf("error = %v, want %v", changeErr, test.wantError)
				}
				if uow.rolledBack != 1 || uow.committed != 0 || !reflect.DeepEqual(tx.trace, test.wantTrace) {
					t.Fatalf("uow/trace = %#v / %#v, want rollback / %#v", uow, tx.trace, test.wantTrace)
				}
			})
		}
	})
}

func activeReviewScheduleCycleView(tx *cycleTestTx, reviewDate *cycle.ReviewDate, revision int64) CycleView {
	return CycleView{
		ID: tx.current.ID, GoalID: tx.current.GoalID, SequenceNumber: 1, Status: cycle.StatusActive,
		GoalVersion: GoalVersionView{
			ID: tx.current.GoalVersionID, VersionNumber: 1, Body: "goal body",
			CreatedAt: cycleTestNow.UTC().Add(-24 * time.Hour),
		},
		StartedAt: tx.current.StartedAt,
		Plan:      tx.current.Plan, Do: tx.current.Do, Check: tx.current.Check, Action: tx.current.Action,
		ContentRevision: tx.current.Revisions.Content,
		FrameRevisions: FrameRevisions{
			Plan: tx.current.Revisions.Plan, Do: tx.current.Revisions.Do,
			Check: tx.current.Revisions.Check, Action: tx.current.Revisions.Action,
		},
		ReviewDate: reviewDate, ReviewScheduleRevision: revision,
	}
}

func TestSaveFrameUsesActionRunningCheckAndExactFrameCAS(t *testing.T) {
	tx, clock, _, _ := cycleCommandFixture()
	tx.current.Action = "old"
	tx.current.Revisions.Action = 3
	tx.current.Revisions.Content = 6
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, nil, CycleUseCaseSettings{})

	result, err := useCases.SaveFrame(context.Background(), SaveFrameInput{
		UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
		Frame: cycle.FrameAction, Content: "new\r\naction", ExpectedFrameRevision: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tx.trace, []string{"goal", "cycle", "ai", "save"}) {
		t.Fatalf("SaveFrame trace = %v", tx.trace)
	}
	if tx.savedFrame != cycle.FrameAction || tx.saveExpectedRevision != 3 || tx.savedCycle.Action != "new\naction" ||
		tx.savedCycle.Revisions.Action != 4 || tx.savedCycle.Revisions.Content != 7 ||
		result.FrameRevision != 4 || result.ContentRevision != 7 || !result.SavedAt.Equal(cycleTestNow.UTC()) {
		t.Fatalf("saved/result = %#v / %#v", tx.savedCycle, result)
	}
	if uow.committed != 1 || uow.rolledBack != 0 {
		t.Fatalf("uow = %#v", uow)
	}
}

func TestSaveFrameRollsBackOnExactCASMismatch(t *testing.T) {
	tx, clock, _, _ := cycleCommandFixture()
	tx.current.Plan = "old"
	tx.saveRows = 0
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, nil, CycleUseCaseSettings{})
	_, err := useCases.SaveFrame(context.Background(), SaveFrameInput{
		UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID1,
		Frame: cycle.FramePlan, Content: "new", ExpectedFrameRevision: 1,
	})
	if !errors.Is(err, ErrCyclePersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 {
		t.Fatalf("error/uow = %v / %#v", err, uow)
	}
}

func TestSaveFrameResolvesCycleBeforeGoalStateConflict(t *testing.T) {
	tx, clock, _, _ := cycleCommandFixture()
	tx.goal.Status = goal.StatusGoalReview
	tx.cycleErr = ErrCycleNotFound
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, nil, CycleUseCaseSettings{})

	_, err := useCases.SaveFrame(context.Background(), SaveFrameInput{
		UserID: cycleTestUserID, GoalID: cycleTestGoalID, CycleID: cycleTestCycleID2,
		Frame: cycle.FramePlan, Content: "new", ExpectedFrameRevision: 1,
	})
	if !errors.Is(err, ErrCycleNotFound) || errors.Is(err, ErrGoalStateConflict) ||
		!reflect.DeepEqual(tx.trace, []string{"goal", "cycle"}) || uow.rolledBack != 1 {
		t.Fatalf("error/trace/uow = %v / %v / %#v", err, tx.trace, uow)
	}
}

func TestCompleteCycleCanonicalHashGolden(t *testing.T) {
	_, _, _, input := cycleCommandFixture()
	const want = "8bdbae1e140b25b984d6a3704ba16b11edc7db1fe9dea11743fe298bfdf27095"
	if got := completeCycleRequestHash(input); got != want {
		t.Fatalf("CompleteCycle request hash changed: got %s want %s", got, want)
	}
	input.ExpectedContentRevision++
	if completeCycleRequestHash(input) == want {
		t.Fatal("content revision was omitted from CompleteCycle hash")
	}
}

func TestCompleteCycleOwnsDoubleReceiptLockOrderDomainWritesIDAndClock(t *testing.T) {
	tx, clock, ids, input := cycleCommandFixture()
	// The first probe is intentionally stale/mismatched. Its contents must not
	// decide the command; the second lookup after the User lock is authoritative.
	tx.receipts = []*CompleteCycleReceipt{{GoalID: "other", CycleID: "other", RequestHash: "other"}, nil}
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
	observer := &workspaceObserverRecorder{}
	service := &Service{cycles: useCases, settings: Settings{EventObserver: observer}}

	result, err := service.CompleteCycle(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if len(observer.events) != 2 || observer.events[0].Event != WorkspaceMetricCycleCompleted ||
		observer.events[1].Event != WorkspaceMetricGoalReviewOpened {
		t.Fatalf("fresh completion events = %#v", observer.events)
	}
	wantTrace := []string{
		"receipt", "user", "receipt", "goal", "cycle", "version", "ai",
		"complete", "draft", "review", "load-cycle", "load-goal", "load-draft",
	}
	if !reflect.DeepEqual(tx.trace, wantTrace) {
		t.Fatalf("CompleteCycle trace = %v, want %v", tx.trace, wantTrace)
	}
	if clock.calls != 1 || ids.calls != 1 || uow.committed != 1 || uow.rolledBack != 0 {
		t.Fatalf("clock/ids/uow = %d/%d/%#v", clock.calls, ids.calls, uow)
	}
	if tx.completeExpected != input.ExpectedContentRevision || tx.goalExpectedRevision != input.ExpectedGoalRevision ||
		tx.completedCycle.CompletionOperationID == nil || *tx.completedCycle.CompletionOperationID != input.OperationID ||
		tx.completedCycle.CompletionRequestHash == nil || *tx.completedCycle.CompletionRequestHash != completeCycleRequestHash(input) ||
		tx.completedCycle.CompletedAt == nil || !tx.completedCycle.CompletedAt.Equal(cycleTestNow.UTC()) {
		t.Fatalf("completed Cycle = %#v", tx.completedCycle)
	}
	if tx.insertedDraft.ID != cycleTestDraftID || !tx.insertedDraft.CreatedAt.Equal(cycleTestNow.UTC()) ||
		!tx.insertedDraft.UpdatedAt.Equal(cycleTestNow.UTC()) || tx.reviewingGoal.Revision != 6 ||
		!tx.reviewingGoal.UpdatedAt.Equal(cycleTestNow.UTC()) {
		t.Fatalf("Draft/Goal transition = %#v / %#v", tx.insertedDraft, tx.reviewingGoal)
	}
	if result.CompletedCycle.ID != cycleTestCycleID1 || result.Goal.Status != goal.StatusGoalReview || result.ReviewDraft.ID != cycleTestDraftID {
		t.Fatalf("result = %#v", result)
	}
}

func TestCompleteCycleReplayDoesNotDependOnIDOrClock(t *testing.T) {
	tx, _, _, input := cycleCommandFixture()
	receipt := &CompleteCycleReceipt{
		GoalID: input.GoalID, CycleID: input.CycleID, RequestHash: completeCycleRequestHash(input),
	}
	tx.receipts = []*CompleteCycleReceipt{receipt, receipt}
	tx.goal.Status = goal.StatusActiveCycle
	tx.goalView.Status = goal.StatusActiveCycle
	tx.goalView.Revision = 7
	tx.goalView.CurrentWork = &CurrentWorkView{
		Kind: "active_cycle", CycleID: cycleTestCycleID2, CycleSequenceNumber: 4,
		ReviewSchedule: &ReviewScheduleView{},
	}
	tx.draftView = nil
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})
	observer := &workspaceObserverRecorder{}
	service := &Service{cycles: useCases, settings: Settings{EventObserver: observer}}

	result, err := service.CompleteCycle(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if len(observer.events) != 0 {
		t.Fatalf("post-state replay events = %#v", observer.events)
	}
	wantTrace := []string{"receipt", "user", "receipt", "goal", "load-goal", "load-cycle", "load-draft"}
	if !reflect.DeepEqual(tx.trace, wantTrace) || uow.committed != 1 {
		t.Fatalf("replay trace/uow = %v / %#v", tx.trace, uow)
	}
	if result.Replay == nil || !result.Replay.Replayed || result.Replay.Operation != "complete_cycle" ||
		result.Replay.CurrentWorkspace == nil || result.Replay.CurrentWorkspace.CycleID != cycleTestCycleID2 || result.Replayed {
		t.Fatalf("replay result = %#v", result)
	}
}

func TestCompleteCycleNormalReplayReturnsOriginalReviewWithoutIDOrClock(t *testing.T) {
	tx, _, _, input := cycleCommandFixture()
	tx.goal.Status = goal.StatusGoalReview
	tx.cycleErr = ErrCycleNotFound
	receipt := &CompleteCycleReceipt{
		GoalID: input.GoalID, CycleID: input.CycleID, RequestHash: completeCycleRequestHash(input),
	}
	tx.receipts = []*CompleteCycleReceipt{receipt, receipt}
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})
	observer := &workspaceObserverRecorder{}
	service := &Service{cycles: useCases, settings: Settings{EventObserver: observer}}

	result, err := service.CompleteCycle(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if len(observer.events) != 0 {
		t.Fatalf("review Draft replay events = %#v", observer.events)
	}
	if !result.Replayed || result.Replay != nil || result.ReviewDraft.ID != cycleTestDraftID ||
		result.CompletedCycle.ID != cycleTestCycleID1 || result.Goal.Status != goal.StatusGoalReview {
		t.Fatalf("normal replay = %#v", result)
	}
	wantTrace := []string{"receipt", "user", "receipt", "goal", "load-goal", "load-cycle", "load-draft"}
	if !reflect.DeepEqual(tx.trace, wantTrace) || uow.committed != 1 {
		t.Fatalf("replay trace/uow = %v / %#v", tx.trace, uow)
	}
}

func TestCompleteCycleAuthoritativeSecondReceiptClassifiesKeyReuseBeforeGoalLock(t *testing.T) {
	tx, _, _, input := cycleCommandFixture()
	tx.receipts = []*CompleteCycleReceipt{nil, {
		GoalID: input.GoalID, CycleID: input.CycleID, RequestHash: "different",
	}}
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})
	_, err := useCases.CompleteCycle(context.Background(), input)
	if !errors.Is(err, ErrIdempotencyKeyReused) || !reflect.DeepEqual(tx.trace, []string{"receipt", "user", "receipt"}) ||
		uow.rolledBack != 1 {
		t.Fatalf("error/trace/uow = %v / %v / %#v", err, tx.trace, uow)
	}
}

func TestCompleteCycleReturnsOrderedTypedMissingFramesWithoutIDOrWrites(t *testing.T) {
	tx, clock, ids, input := cycleCommandFixture()
	tx.current.Plan = ""
	tx.current.Do = " \t"
	tx.current.Check = "C"
	tx.current.Action = ""
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
	_, err := useCases.CompleteCycle(context.Background(), input)
	var incomplete *CycleCompletionIncompleteError
	if !errors.As(err, &incomplete) || !errors.Is(err, cycle.ErrCycleIncomplete) {
		t.Fatalf("error = %T %v", err, err)
	}
	wantMissing := []cycle.Frame{cycle.FramePlan, cycle.FrameDo, cycle.FrameAction}
	if !reflect.DeepEqual(incomplete.MissingFrames, wantMissing) {
		t.Fatalf("missingFrames = %v, want %v", incomplete.MissingFrames, wantMissing)
	}
	if ids.calls != 0 || clock.calls != 1 || uow.rolledBack != 1 ||
		!reflect.DeepEqual(tx.trace, []string{"receipt", "user", "receipt", "goal", "cycle", "version", "ai"}) {
		t.Fatalf("ids/clock/uow/trace = %d/%d/%#v/%v", ids.calls, clock.calls, uow, tx.trace)
	}
}

func TestCompleteCycleSeparatesGoalRevisionAndCurrentVersionConflicts(t *testing.T) {
	t.Run("stale expected Goal revision", func(t *testing.T) {
		tx, _, _, input := cycleCommandFixture()
		input.ExpectedGoalRevision--
		uow := &cycleTestUOW{tx: tx}
		useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})
		_, err := useCases.CompleteCycle(context.Background(), input)
		if !errors.Is(err, ErrGoalRevisionConflict) || !reflect.DeepEqual(tx.trace, []string{"receipt", "user", "receipt", "goal", "cycle"}) {
			t.Fatalf("error/trace = %v / %v", err, tx.trace)
		}
	})
	t.Run("Cycle references a non-current Goal Version", func(t *testing.T) {
		tx, _, _, input := cycleCommandFixture()
		tx.current.GoalVersionID = "40000000-0000-7000-8000-000000000002"
		uow := &cycleTestUOW{tx: tx}
		useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})
		_, err := useCases.CompleteCycle(context.Background(), input)
		if !errors.Is(err, ErrGoalVersionConflict) || uow.rolledBack != 1 {
			t.Fatalf("error/uow = %v / %#v", err, uow)
		}
	})
}

func TestCompleteCycleResolvesCycleBeforeGoalConflicts(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*cycleTestTx, *CompleteCycleInput)
	}{
		{
			name: "non-active Goal and mismatched Cycle",
			mutate: func(tx *cycleTestTx, _ *CompleteCycleInput) {
				tx.goal.Status = goal.StatusGoalReview
			},
		},
		{
			name: "stale Goal revision and mismatched Cycle",
			mutate: func(_ *cycleTestTx, input *CompleteCycleInput) {
				input.ExpectedGoalRevision--
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx, _, _, input := cycleCommandFixture()
			test.mutate(tx, &input)
			tx.cycleErr = ErrCycleNotFound
			uow := &cycleTestUOW{tx: tx}
			useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})

			_, err := useCases.CompleteCycle(context.Background(), input)
			wantTrace := []string{"receipt", "user", "receipt", "goal", "cycle"}
			if !errors.Is(err, ErrCycleNotFound) || errors.Is(err, ErrGoalStateConflict) ||
				errors.Is(err, ErrGoalRevisionConflict) || !reflect.DeepEqual(tx.trace, wantTrace) ||
				uow.rolledBack != 1 {
				t.Fatalf("error/trace/uow = %v / %v / %#v", err, tx.trace, uow)
			}
		})
	}
}

func TestCompleteCycleRejectsNonCanonicalGeneratedUUIDBeforeWrites(t *testing.T) {
	tx, clock, ids, input := cycleCommandFixture()
	ids.id = "not-a-uuid"
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
	_, err := useCases.CompleteCycle(context.Background(), input)
	if !errors.Is(err, ErrCyclePersistenceInvariant) || uow.rolledBack != 1 || ids.calls != 1 || clock.calls != 1 {
		t.Fatalf("error/uow/ids/clock = %v / %#v / %d / %d", err, uow, ids.calls, clock.calls)
	}
	if !reflect.DeepEqual(tx.trace, []string{"receipt", "user", "receipt", "goal", "cycle", "version", "ai"}) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestCompleteCycleRollsBackAllWritesOnExactCASMismatch(t *testing.T) {
	tx, clock, ids, input := cycleCommandFixture()
	tx.completeRows = 0
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
	_, err := useCases.CompleteCycle(context.Background(), input)
	if !errors.Is(err, ErrCyclePersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 ||
		!reflect.DeepEqual(tx.trace, []string{"receipt", "user", "receipt", "goal", "cycle", "version", "ai", "complete"}) {
		t.Fatalf("error/uow/trace = %v / %#v / %v", err, uow, tx.trace)
	}
}

func TestCompleteCycleRequiresExactRowsForEveryWriteAndPostWriteMaterialization(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*cycleTestTx)
		wantSuffix string
	}{
		{"Draft insert", func(tx *cycleTestTx) { tx.draftRows = 0 }, "draft"},
		{"Goal review", func(tx *cycleTestTx) { tx.goalRows = 0 }, "review"},
		{"post-write Cycle", func(tx *cycleTestTx) { tx.materializationLoadErr = ErrCycleNotFound }, "load-cycle"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx, clock, ids, input := cycleCommandFixture()
			test.mutate(tx)
			uow := &cycleTestUOW{tx: tx}
			useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
			_, err := useCases.CompleteCycle(context.Background(), input)
			if !errors.Is(err, ErrCyclePersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 {
				t.Fatalf("error/uow = %v / %#v", err, uow)
			}
			if tx.trace[len(tx.trace)-1] != test.wantSuffix {
				t.Fatalf("trace = %v, want suffix %s", tx.trace, test.wantSuffix)
			}
		})
	}
}

func TestReplanCycleCanonicalHashGolden(t *testing.T) {
	_, _, _, input := replanCycleFixture(t)
	const want = "161165d507467811a24b69f7627bfb320f654b33c7b323ea0d3e3b0578373e29"
	if got := replanCycleRequestHash(input); got != want {
		t.Fatalf("Replan Cycle request hash changed: got %s want %s", got, want)
	}
	input.ExpectedReviewScheduleRevision++
	if replanCycleRequestHash(input) == want {
		t.Fatal("review schedule revision was omitted from Replan Cycle hash")
	}
}

func TestReplanCycleOwnsLocksDomainWritesMaterializationAndMetrics(t *testing.T) {
	tx, clock, ids, input := replanCycleFixture(t)
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
	observer := &workspaceObserverRecorder{}
	service := &Service{cycles: useCases, settings: Settings{EventObserver: observer}}

	result, err := service.ReplanCycle(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	wantTrace := []string{
		"user", "replan-receipt", "goal", "cycle", "version", "ai", "cancel", "insert-cycle", "replan-goal",
		"load-cycle", "load-goal", "load-cycle",
	}
	if !reflect.DeepEqual(tx.trace, wantTrace) || uow.committed != 1 || uow.rolledBack != 0 ||
		clock.calls != 1 || ids.calls != 1 {
		t.Fatalf("trace/uow/clock/ids = %#v / %#v / %d / %d", tx.trace, uow, clock.calls, ids.calls)
	}
	if tx.canceledCycle.Status != cycle.StatusCanceled || tx.canceledCycle.CancellationReason == nil ||
		*tx.canceledCycle.CancellationReason != cycle.CancellationReplanned || tx.completeExpected != input.ExpectedContentRevision ||
		tx.insertedCycle.ID != cycleTestCycleID2 || tx.insertedCycle.SequenceNumber != tx.current.SequenceNumber+1 ||
		tx.insertedCycle.GoalVersionID != tx.current.GoalVersionID || tx.insertedCycle.ReviewDate != nil ||
		tx.insertedCycle.ReviewScheduleRevision != 0 || tx.insertedCycle.Revisions != (cycle.Revisions{}) ||
		tx.replannedGoal.Status != goal.StatusActiveCycle || tx.replannedGoal.Revision != input.ExpectedGoalRevision+1 ||
		tx.replannedGoal.NextCycleSequenceNumber != tx.goal.NextCycleSequenceNumber+1 ||
		tx.goalExpectedRevision != input.ExpectedGoalRevision {
		t.Fatalf("writes = canceled %#v / inserted %#v / Goal %#v", tx.canceledCycle, tx.insertedCycle, tx.replannedGoal)
	}
	if result.Replayed || result.CanceledCycle.ID != input.CycleID || result.Cycle.ID != cycleTestCycleID2 ||
		result.Goal.CurrentWork == nil || result.Goal.CurrentWork.CycleID != cycleTestCycleID2 {
		t.Fatalf("result = %#v", result)
	}
	if len(observer.events) != 2 || observer.events[0].Event != WorkspaceMetricCycleCanceled ||
		observer.events[0].CancellationReason != cycle.CancellationReplanned ||
		observer.events[1].Event != WorkspaceMetricCycleStarted {
		t.Fatalf("events = %#v", observer.events)
	}
}

func TestReplanCycleReplayReturnsOriginalPairWithoutIDClockOrMetrics(t *testing.T) {
	tx, _, _, input := replanCycleFixture(t)
	receipt := &ReplanCycleReceipt{
		GoalID: input.GoalID, CycleID: cycleTestCycleID2, RequestHash: replanCycleRequestHash(input),
		ReplannedCycleID: input.CycleID, ReplannedCancellationReason: tx.cycleViews[input.CycleID].CancellationReason,
	}
	tx.replanReceipts = []*ReplanCycleReceipt{receipt}
	completedAt := cycleTestNow.UTC().Add(time.Hour)
	next := tx.cycleViews[cycleTestCycleID2]
	next.Status = cycle.StatusCompleted
	next.CompletedAt = &completedAt
	next.Predecessor = nil
	tx.cycleViews[cycleTestCycleID2] = next
	tx.goalView.Status = goal.StatusGoalReview
	tx.goalView.CurrentWork = &CurrentWorkView{
		Kind: "goal_review", ReviewDraftID: cycleTestDraftID,
		TriggerCycleID: cycleTestCycleID2, TriggerCycleSequenceNumber: next.SequenceNumber,
	}
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})
	observer := &workspaceObserverRecorder{}
	service := &Service{cycles: useCases, settings: Settings{EventObserver: observer}}

	result, err := service.ReplanCycle(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	wantTrace := []string{"user", "replan-receipt", "goal", "load-cycle", "load-goal", "load-cycle"}
	if !result.Replayed || result.Cycle.Status != cycle.StatusCompleted || result.CanceledCycle.ID != input.CycleID ||
		!reflect.DeepEqual(tx.trace, wantTrace) || uow.committed != 1 || len(observer.events) != 0 {
		t.Fatalf("result/trace/uow/events = %#v / %#v / %#v / %#v", result, tx.trace, uow, observer.events)
	}
}

func TestReplanCycleReplayAllowsEditedAndScheduledActiveSuccessor(t *testing.T) {
	tx, _, _, input := replanCycleFixture(t)
	receipt := &ReplanCycleReceipt{
		GoalID: input.GoalID, CycleID: cycleTestCycleID2, RequestHash: replanCycleRequestHash(input),
		ReplannedCycleID: input.CycleID, ReplannedCancellationReason: tx.cycleViews[input.CycleID].CancellationReason,
	}
	tx.replanReceipts = []*ReplanCycleReceipt{receipt}
	reviewDate, err := cycle.ParseReviewDate("2026-10-01")
	if err != nil {
		t.Fatal(err)
	}
	next := tx.cycleViews[cycleTestCycleID2]
	next.Plan = "response loss後に保存したPlan"
	next.ContentRevision = 1
	next.FrameRevisions.Plan = 1
	next.ReviewDate = &reviewDate
	next.ReviewScheduleRevision = 1
	tx.cycleViews[cycleTestCycleID2] = next
	tx.goalView.CurrentWork.ReviewSchedule = &ReviewScheduleView{
		ReviewDate: &reviewDate, ReviewScheduleRevision: 1,
	}
	uow := &cycleTestUOW{tx: tx}
	useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})

	result, err := useCases.ReplanCycle(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Replayed || result.Cycle.Plan != next.Plan || result.Cycle.ContentRevision != 1 ||
		result.Cycle.ReviewDate == nil || *result.Cycle.ReviewDate != reviewDate ||
		result.Cycle.ReviewScheduleRevision != 1 || uow.committed != 1 {
		t.Fatalf("edited active replay = %#v, uow = %#v", result, uow)
	}
}

func TestReplanCycleRequiresConfirmationAndClassifiesReceiptReuse(t *testing.T) {
	t.Run("confirmation", func(t *testing.T) {
		_, _, _, input := replanCycleFixture(t)
		input.Confirmed = false
		useCases := NewCycleUseCases(nil, nil, nil, nil, CycleUseCaseSettings{})
		if _, err := useCases.ReplanCycle(context.Background(), input); !errors.Is(err, ErrReplanConfirmation) {
			t.Fatalf("error = %v, want %v", err, ErrReplanConfirmation)
		}
	})

	t.Run("same key different request", func(t *testing.T) {
		tx, _, _, input := replanCycleFixture(t)
		tx.replanReceipts = []*ReplanCycleReceipt{{
			GoalID: input.GoalID, CycleID: cycleTestCycleID2, RequestHash: "different",
			ReplannedCycleID: input.CycleID, ReplannedCancellationReason: tx.cycleViews[input.CycleID].CancellationReason,
		}}
		uow := &cycleTestUOW{tx: tx}
		useCases := NewCycleUseCases(nil, uow, nil, nil, CycleUseCaseSettings{})
		if _, err := useCases.ReplanCycle(context.Background(), input); !errors.Is(err, ErrIdempotencyKeyReused) ||
			!reflect.DeepEqual(tx.trace, []string{"user", "replan-receipt"}) || uow.rolledBack != 1 {
			t.Fatalf("error/trace/uow = %v / %#v / %#v", err, tx.trace, uow)
		}
	})
}

func TestReplanCycleResolvesTargetBeforeGoalConflictsAndRejectsStaleCycleOrAI(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*cycleTestTx, *ReplanCycleInput)
		want      error
		wantTrace []string
	}{
		{
			name: "missing Cycle wins over Goal state",
			configure: func(tx *cycleTestTx, _ *ReplanCycleInput) {
				tx.goal.Status = goal.StatusGoalReview
				tx.cycleErr = ErrCycleNotFound
			},
			want: ErrCycleNotFound, wantTrace: []string{"user", "replan-receipt", "goal", "cycle"},
		},
		{
			name: "stale Goal revision",
			configure: func(_ *cycleTestTx, input *ReplanCycleInput) {
				input.ExpectedGoalRevision--
			},
			want: ErrGoalRevisionConflict, wantTrace: []string{"user", "replan-receipt", "goal", "cycle"},
		},
		{
			name: "stale content revision",
			configure: func(_ *cycleTestTx, input *ReplanCycleInput) {
				input.ExpectedContentRevision--
			},
			want: cycle.ErrRevisionConflict, wantTrace: []string{"user", "replan-receipt", "goal", "cycle"},
		},
		{
			name: "Goal sequence invariant",
			configure: func(tx *cycleTestTx, _ *ReplanCycleInput) {
				tx.goal.NextCycleSequenceNumber++
			},
			want: ErrCyclePersistenceInvariant, wantTrace: []string{"user", "replan-receipt", "goal", "cycle"},
		},
		{
			name: "stale review schedule revision",
			configure: func(_ *cycleTestTx, input *ReplanCycleInput) {
				input.ExpectedReviewScheduleRevision--
			},
			want: cycle.ErrRevisionConflict, wantTrace: []string{"user", "replan-receipt", "goal", "cycle"},
		},
		{
			name: "AI running",
			configure: func(tx *cycleTestTx, _ *ReplanCycleInput) {
				tx.aiRunning = true
			},
			want:      ErrAIInProgress,
			wantTrace: []string{"user", "replan-receipt", "goal", "cycle", "version", "ai"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx, clock, ids, input := replanCycleFixture(t)
			test.configure(tx, &input)
			uow := &cycleTestUOW{tx: tx}
			useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
			_, err := useCases.ReplanCycle(context.Background(), input)
			if !errors.Is(err, test.want) || !reflect.DeepEqual(tx.trace, test.wantTrace) ||
				uow.rolledBack != 1 || ids.calls != 0 || clock.calls != 0 {
				t.Fatalf("error/trace/uow/ids/clock = %v / %#v / %#v / %d / %d", err, tx.trace, uow, ids.calls, clock.calls)
			}
		})
	}
}

func TestReplanCycleRollsBackOnEveryWriteAndMaterializationFailure(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*cycleTestTx)
		want      error
		lastTrace string
	}{
		{"cancel CAS", func(tx *cycleTestTx) { tx.cancelRows = 0 }, ErrCyclePersistenceInvariant, "cancel"},
		{"successor insert", func(tx *cycleTestTx) { tx.cycleRows = 2 }, ErrCyclePersistenceInvariant, "insert-cycle"},
		{"Goal CAS", func(tx *cycleTestTx) { tx.replanRows = 0 }, ErrCyclePersistenceInvariant, "replan-goal"},
		{"materialization", func(tx *cycleTestTx) { tx.materializationLoadErr = ErrCycleNotFound }, ErrCyclePersistenceInvariant, "load-cycle"},
		{"wrong successor identity", func(tx *cycleTestTx) {
			next := tx.cycleViews[cycleTestCycleID2]
			next.ID = cycleTestCycleID3
			tx.cycleViews[cycleTestCycleID2] = next
			tx.goalView.CurrentWork.CycleID = cycleTestCycleID3
		}, ErrCyclePersistenceInvariant, "load-cycle"},
		{"terminal fresh successor", func(tx *cycleTestTx) {
			next := tx.cycleViews[cycleTestCycleID2]
			completedAt := cycleTestNow.UTC().Add(time.Minute)
			next.Status = cycle.StatusCompleted
			next.CompletedAt = &completedAt
			next.Predecessor = nil
			tx.cycleViews[cycleTestCycleID2] = next
			tx.goalView.Status = goal.StatusGoalReview
			tx.goalView.CurrentWork = &CurrentWorkView{
				Kind: "goal_review", ReviewDraftID: cycleTestDraftID,
				TriggerCycleID: cycleTestCycleID2, TriggerCycleSequenceNumber: next.SequenceNumber,
			}
		}, ErrCyclePersistenceInvariant, "load-cycle"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx, clock, ids, input := replanCycleFixture(t)
			test.configure(tx)
			uow := &cycleTestUOW{tx: tx}
			useCases := NewCycleUseCases(nil, uow, clock, ids, CycleUseCaseSettings{})
			_, err := useCases.ReplanCycle(context.Background(), input)
			if !errors.Is(err, test.want) || uow.rolledBack != 1 || uow.committed != 0 ||
				tx.trace[len(tx.trace)-1] != test.lastTrace {
				t.Fatalf("error/uow/trace = %v / %#v / %#v", err, uow, tx.trace)
			}
		})
	}
}

func TestGetCycleRejectsCanceledDetailWithoutCancellationReason(t *testing.T) {
	tx, _, _, _ := cycleCommandFixture()
	view := tx.cycleView
	view.Status = cycle.StatusCanceled
	view.CompletedAt = nil
	canceledAt := cycleTestNow.UTC()
	view.CanceledAt = &canceledAt
	view.CancellationReason = nil
	queries := &cycleTestQueries{view: view}
	useCases := NewCycleUseCases(queries, nil, nil, nil, CycleUseCaseSettings{})
	_, err := useCases.GetCycle(context.Background(), cycleTestUserID, cycleTestGoalID, cycleTestCycleID1)
	if !errors.Is(err, ErrCyclePersistenceInvariant) {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateCycleViewPreviousCompletedActionContract(t *testing.T) {
	now := cycleTestNow.UTC()
	view := CycleView{
		ID: cycleTestCycleID3, GoalID: cycleTestGoalID, SequenceNumber: 3, Status: cycle.StatusActive,
		GoalVersion: GoalVersionView{
			ID: cycleTestVersionID, VersionNumber: 2, Body: "goal", CreatedAt: now.Add(-time.Hour),
		},
		PreviousCompletedCycleAction: &PreviousCompletedCycleActionView{
			CycleID: cycleTestCycleID2, CycleSequenceNumber: 2, GoalVersionNumber: 1, Action: "前回A",
		},
		Predecessor: &CyclePredecessorView{
			CycleID: cycleTestCycleID2, CycleSequenceNumber: 2, GoalVersionNumber: 1, Status: cycle.StatusCompleted,
		},
		StartedAt: now,
	}
	if err := validateCycleView(view, cycleTestGoalID, cycleTestCycleID3); err != nil {
		t.Fatalf("valid active Cycle previous Action: %v", err)
	}
	atLimit := view
	atLimitPrevious := *view.PreviousCompletedCycleAction
	atLimitPrevious.Action = strings.Repeat("🌱", cycle.MaxFrameCodePoints)
	atLimit.PreviousCompletedCycleAction = &atLimitPrevious
	if err := validateCycleView(atLimit, cycleTestGoalID, cycleTestCycleID3); err != nil {
		t.Fatalf("Action at code point limit: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*CycleView)
	}{
		{"missing", func(candidate *CycleView) { candidate.PreviousCompletedCycleAction = nil }},
		{"same Cycle", func(candidate *CycleView) { candidate.PreviousCompletedCycleAction.CycleID = candidate.ID }},
		{"invalid UUID", func(candidate *CycleView) { candidate.PreviousCompletedCycleAction.CycleID = "not-a-uuid" }},
		{"wrong sequence", func(candidate *CycleView) { candidate.PreviousCompletedCycleAction.CycleSequenceNumber-- }},
		{"zero Goal Version", func(candidate *CycleView) { candidate.PreviousCompletedCycleAction.GoalVersionNumber = 0 }},
		{"future Goal Version", func(candidate *CycleView) { candidate.PreviousCompletedCycleAction.GoalVersionNumber = 3 }},
		{"Goal Version more than one behind", func(candidate *CycleView) { candidate.GoalVersion.VersionNumber = 3 }},
		{"blank Action", func(candidate *CycleView) { candidate.PreviousCompletedCycleAction.Action = " \n\t" }},
		{"oversize Action", func(candidate *CycleView) {
			candidate.PreviousCompletedCycleAction.Action = strings.Repeat("🌱", cycle.MaxFrameCodePoints+1)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := view
			previous := *view.PreviousCompletedCycleAction
			candidate.PreviousCompletedCycleAction = &previous
			test.mutate(&candidate)
			if err := validateCycleView(candidate, cycleTestGoalID, cycleTestCycleID3); !errors.Is(err, ErrCyclePersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, ErrCyclePersistenceInvariant)
			}
		})
	}
}

func TestValidateCycleViewPreviousCompletedActionIsNullForCycleOneAndTerminal(t *testing.T) {
	now := cycleTestNow.UTC()
	base := CycleView{
		ID: cycleTestCycleID1, GoalID: cycleTestGoalID, SequenceNumber: 1, Status: cycle.StatusActive,
		GoalVersion: GoalVersionView{
			ID: cycleTestVersionID, VersionNumber: 1, Body: "goal", CreatedAt: now.Add(-time.Hour),
		},
		StartedAt: now,
	}
	if err := validateCycleView(base, cycleTestGoalID, cycleTestCycleID1); err != nil {
		t.Fatalf("Cycle 1 null previous Action: %v", err)
	}
	base.PreviousCompletedCycleAction = &PreviousCompletedCycleActionView{
		CycleID: cycleTestCycleID2, CycleSequenceNumber: 0, GoalVersionNumber: 1, Action: "A",
	}
	if err := validateCycleView(base, cycleTestGoalID, cycleTestCycleID1); !errors.Is(err, ErrCyclePersistenceInvariant) {
		t.Fatalf("Cycle 1 populated previous Action error = %v", err)
	}

	completedAt := now.Add(time.Hour)
	base.SequenceNumber = 2
	base.Status = cycle.StatusCompleted
	base.CompletedAt = &completedAt
	base.PreviousCompletedCycleAction = nil
	if err := validateCycleView(base, cycleTestGoalID, cycleTestCycleID1); err != nil {
		t.Fatalf("terminal null previous Action: %v", err)
	}
	base.PreviousCompletedCycleAction = &PreviousCompletedCycleActionView{
		CycleID: cycleTestCycleID2, CycleSequenceNumber: 1, GoalVersionNumber: 1, Action: "A",
	}
	if err := validateCycleView(base, cycleTestGoalID, cycleTestCycleID1); !errors.Is(err, ErrCyclePersistenceInvariant) {
		t.Fatalf("terminal populated previous Action error = %v", err)
	}
}

func TestValidateCycleViewAcceptsOnlyExactReplannedPredecessorForActiveNullAction(t *testing.T) {
	now := cycleTestNow.UTC()
	reason := cycle.CancellationReplanned
	view := CycleView{
		ID: cycleTestCycleID3, GoalID: cycleTestGoalID, SequenceNumber: 3, Status: cycle.StatusActive,
		GoalVersion: GoalVersionView{
			ID: cycleTestVersionID, VersionNumber: 2, Body: "goal", CreatedAt: now.Add(-time.Hour),
		},
		Predecessor: &CyclePredecessorView{
			CycleID: cycleTestCycleID2, CycleSequenceNumber: 2, GoalVersionNumber: 2,
			Status: cycle.StatusCanceled, CancellationReason: &reason,
		},
		StartedAt: now,
	}
	if err := validateCycleView(view, cycleTestGoalID, cycleTestCycleID3); err != nil {
		t.Fatalf("valid replanned predecessor: %v", err)
	}

	goalEnded := cycle.CancellationGoalEnded
	tests := []struct {
		name   string
		mutate func(*CycleView)
	}{
		{"missing provenance", func(candidate *CycleView) { candidate.Predecessor = nil }},
		{"terminal cancellation", func(candidate *CycleView) { candidate.Predecessor.CancellationReason = &goalEnded }},
		{"missing reason", func(candidate *CycleView) { candidate.Predecessor.CancellationReason = nil }},
		{"different Goal Version", func(candidate *CycleView) { candidate.Predecessor.GoalVersionNumber-- }},
		{"skipped sequence", func(candidate *CycleView) { candidate.Predecessor.CycleSequenceNumber-- }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := view
			predecessor := *view.Predecessor
			candidate.Predecessor = &predecessor
			test.mutate(&candidate)
			if err := validateCycleView(candidate, cycleTestGoalID, cycleTestCycleID3); !errors.Is(err, ErrCyclePersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, ErrCyclePersistenceInvariant)
			}
		})
	}
}
