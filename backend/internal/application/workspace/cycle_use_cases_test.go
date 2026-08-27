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

	receipts    []*CompleteCycleReceipt
	receiptCall int
	receiptErr  error
	goal        goal.Goal
	goalErr     error
	current     cycle.PDCACycle
	cycleErr    error
	version     goal.Version
	versionErr  error
	aiRunning   bool
	aiErr       error

	saveRows     int64
	completeRows int64
	draftRows    int64
	goalRows     int64
	writeErr     error

	savedFrame             cycle.Frame
	savedCycle             cycle.PDCACycle
	saveExpectedRevision   int64
	completedCycle         cycle.PDCACycle
	completeExpected       int64
	insertedDraft          goal.Draft
	reviewingGoal          goal.Goal
	goalExpectedRevision   int64
	loadedVersionNumber    int32
	goalView               GoalView
	cycleView              CycleView
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

func (tx *cycleTestTx) CompleteCycleCAS(_ context.Context, completed cycle.PDCACycle, expected int64) (int64, error) {
	tx.trace = append(tx.trace, "complete")
	tx.completedCycle, tx.completeExpected = completed, expected
	return tx.completeRows, tx.writeErr
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

func (tx *cycleTestTx) LoadCycleView(context.Context, string, string, string) (CycleView, error) {
	tx.trace = append(tx.trace, "load-cycle")
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
		saveRows: 1, completeRows: 1, draftRows: 1, goalRows: 1,
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
