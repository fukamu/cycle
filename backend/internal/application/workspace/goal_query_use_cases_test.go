package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

const (
	goalQueryTestUserID  = "10000000-0000-7000-8000-000000000001"
	goalQueryTestGoalID1 = "20000000-0000-7000-8000-000000000001"
	goalQueryTestGoalID2 = "20000000-0000-7000-8000-000000000002"
	goalQueryTestGoalID3 = "20000000-0000-7000-8000-000000000003"
	goalQueryTestCycleID = "40000000-0000-7000-8000-000000000001"
	goalQueryTestDraftID = "60000000-0000-7000-8000-000000000001"
)

var (
	goalQueryTestTime = time.Date(2026, 8, 24, 1, 2, 3, 456789000, time.UTC)
	goalQueryTestKey  = []byte("test-cursor-key")
)

type goalQueryFakeRepository struct {
	rows          []GoalQueryRow
	goal          GoalView
	rowsErr       error
	goalErr       error
	rowCalls      int
	goalCalls     int
	lastListQuery GoalListQuery
	lastUserID    string
	lastGoalID    string
}

func (repository *goalQueryFakeRepository) QueryGoalRows(_ context.Context, query GoalListQuery) ([]GoalQueryRow, error) {
	repository.rowCalls++
	repository.lastListQuery = query
	return repository.rows, repository.rowsErr
}

func (repository *goalQueryFakeRepository) QueryGoal(_ context.Context, userID, goalID string) (GoalView, error) {
	repository.goalCalls++
	repository.lastUserID = userID
	repository.lastGoalID = goalID
	return repository.goal, repository.goalErr
}

func newGoalQueryUseCases(repository GoalQueryRepository) *GoalUseCases {
	return NewGoalUseCases(repository, nil, nil, GoalUseCaseSettings{CursorSigningKey: goalQueryTestKey})
}

func activeGoalQueryView(id string) GoalView {
	return GoalView{
		ID:     id,
		Status: goal.StatusActiveCycle,
		CurrentWork: &CurrentWorkView{
			Kind:                "active_cycle",
			CycleID:             goalQueryTestCycleID,
			CycleSequenceNumber: 1,
		},
	}
}

func reviewGoalQueryView(id string) GoalView {
	return GoalView{
		ID:     id,
		Status: goal.StatusGoalReview,
		CurrentWork: &CurrentWorkView{
			Kind:                       "goal_review",
			ReviewDraftID:              goalQueryTestDraftID,
			TriggerCycleID:             goalQueryTestCycleID,
			TriggerCycleSequenceNumber: 1,
		},
	}
}

func terminalGoalQueryView(id string, status goal.Status) GoalView {
	return GoalView{ID: id, Status: status}
}

func TestGoalQueryUseCasesOwnScopeLimitAndPage(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		scope string
		want  GoalListScope
		row   GoalQueryRow
		limit int
		fetch int
	}{
		{
			name: "default all", scope: "", want: GoalListAll, limit: 0, fetch: 21,
			row: GoalQueryRow{View: activeGoalQueryView(goalQueryTestGoalID1), Category: 0, SortTime: goalQueryTestTime},
		},
		{
			name: "progressing", scope: "progressing", want: GoalListProgressing, limit: 12, fetch: 13,
			row: GoalQueryRow{View: reviewGoalQueryView(goalQueryTestGoalID1), Category: 0, SortTime: goalQueryTestTime},
		},
		{
			name: "history clamps max", scope: "history", want: GoalListHistory, limit: 99, fetch: 51,
			row: GoalQueryRow{View: terminalGoalQueryView(goalQueryTestGoalID1, goal.StatusEnded), Category: 1, SortTime: goalQueryTestTime},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := &goalQueryFakeRepository{rows: []GoalQueryRow{test.row}}
			page, err := newGoalQueryUseCases(repository).ListGoals(
				context.Background(), goalQueryTestUserID, test.scope, "", test.limit,
			)
			if err != nil {
				t.Fatal(err)
			}
			if repository.rowCalls != 1 || repository.lastListQuery.UserID != goalQueryTestUserID ||
				repository.lastListQuery.Scope != test.want || repository.lastListQuery.After != nil ||
				repository.lastListQuery.FetchLimit != test.fetch {
				t.Fatalf("query = %#v, calls = %d", repository.lastListQuery, repository.rowCalls)
			}
			if len(page.Items) != 1 || page.Items[0].ID != goalQueryTestGoalID1 || page.NextCursor != nil {
				t.Fatalf("page = %#v", page)
			}
		})
	}

	repository := &goalQueryFakeRepository{}
	_, err := newGoalQueryUseCases(repository).ListGoals(
		context.Background(), goalQueryTestUserID, "unsupported", "", 20,
	)
	if !errors.Is(err, ErrInvalidCursor) || repository.rowCalls != 0 {
		t.Fatalf("invalid scope error/calls = %v/%d", err, repository.rowCalls)
	}
}

func TestGoalQueryUseCasesPreserveCursorWireAndPageBoundary(t *testing.T) {
	t.Parallel()

	rows := []GoalQueryRow{
		{View: activeGoalQueryView(goalQueryTestGoalID3), Category: 0, SortTime: goalQueryTestTime},
		{View: activeGoalQueryView(goalQueryTestGoalID2), Category: 0, SortTime: goalQueryTestTime},
		{View: activeGoalQueryView(goalQueryTestGoalID1), Category: 0, SortTime: goalQueryTestTime},
	}
	repository := &goalQueryFakeRepository{rows: rows}
	page, err := newGoalQueryUseCases(repository).ListGoals(
		context.Background(), goalQueryTestUserID, "all", "", 2,
	)
	if err != nil {
		t.Fatal(err)
	}
	const golden = "eyJzY29wZSI6ImFsbCIsImNhdGVnb3J5IjowLCJ0aW1lIjoiMjAyNi0wOC0yNFQwMTowMjowMy40NTY3ODlaIiwiaWQiOiIyMDAwMDAwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwMDIifZFBJ8QAfBOCM1t7gMILq4--tsbGut4ZyQkYbPcnYwFn"
	if page.NextCursor == nil || *page.NextCursor != golden {
		t.Fatalf("next cursor = %v, want legacy golden %q", page.NextCursor, golden)
	}
	if len(page.Items) != 2 || page.Items[0].ID != goalQueryTestGoalID3 || page.Items[1].ID != goalQueryTestGoalID2 {
		t.Fatalf("first page = %#v", page.Items)
	}

	decodeRepository := &goalQueryFakeRepository{}
	decoded, err := newGoalQueryUseCases(decodeRepository).ListGoals(
		context.Background(), goalQueryTestUserID, "all", golden, 2,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded.Items) != 0 || decodeRepository.lastListQuery.After == nil {
		t.Fatalf("decoded page/query = %#v / %#v", decoded, decodeRepository.lastListQuery)
	}
	after := decodeRepository.lastListQuery.After
	if after.Category != 0 || !after.SortTime.Equal(goalQueryTestTime) || after.GoalID != goalQueryTestGoalID2 ||
		decodeRepository.lastListQuery.FetchLimit != 3 {
		t.Fatalf("decoded keyset = %#v", after)
	}
}

func TestGoalQueryUseCasesRejectTamperedOrWrongScopeCursor(t *testing.T) {
	t.Parallel()

	const golden = "eyJzY29wZSI6ImFsbCIsImNhdGVnb3J5IjowLCJ0aW1lIjoiMjAyNi0wOC0yNFQwMTowMjowMy40NTY3ODlaIiwiaWQiOiIyMDAwMDAwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwMDIifZFBJ8QAfBOCM1t7gMILq4--tsbGut4ZyQkYbPcnYwFn"
	tampered := golden[:len(golden)-1] + "A"
	tests := []struct {
		name   string
		scope  string
		cursor string
	}{
		{name: "tampered signature", scope: "all", cursor: tampered},
		{name: "wrong scope", scope: "history", cursor: golden},
		{name: "malformed", scope: "all", cursor: "not-base64!"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := &goalQueryFakeRepository{}
			_, err := newGoalQueryUseCases(repository).ListGoals(
				context.Background(), goalQueryTestUserID, test.scope, test.cursor, 20,
			)
			if !errors.Is(err, ErrInvalidCursor) || repository.rowCalls != 0 {
				t.Fatalf("error/calls = %v/%d", err, repository.rowCalls)
			}
		})
	}
}

func TestGoalQueryUseCasesRejectUnstableRows(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		rows []GoalQueryRow
	}{
		{
			name: "tie is not id descending",
			rows: []GoalQueryRow{
				{View: activeGoalQueryView(goalQueryTestGoalID1), Category: 0, SortTime: goalQueryTestTime},
				{View: activeGoalQueryView(goalQueryTestGoalID2), Category: 0, SortTime: goalQueryTestTime},
			},
		},
		{
			name: "status category mismatch",
			rows: []GoalQueryRow{
				{View: activeGoalQueryView(goalQueryTestGoalID1), Category: 1, SortTime: goalQueryTestTime},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := &goalQueryFakeRepository{rows: test.rows}
			_, err := newGoalQueryUseCases(repository).ListGoals(
				context.Background(), goalQueryTestUserID, "all", "", 20,
			)
			if !errors.Is(err, ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestGoalQueryUseCasesEnforceCurrentWorkUnion(t *testing.T) {
	t.Parallel()

	valid := []GoalView{
		activeGoalQueryView(goalQueryTestGoalID1),
		reviewGoalQueryView(goalQueryTestGoalID1),
		terminalGoalQueryView(goalQueryTestGoalID1, goal.StatusAchieved),
		terminalGoalQueryView(goalQueryTestGoalID1, goal.StatusEnded),
	}
	for _, view := range valid {
		repository := &goalQueryFakeRepository{goal: view}
		got, err := newGoalQueryUseCases(repository).GetGoal(
			context.Background(), goalQueryTestUserID, goalQueryTestGoalID1,
		)
		if err != nil || got.ID != goalQueryTestGoalID1 || repository.lastUserID != goalQueryTestUserID ||
			repository.lastGoalID != goalQueryTestGoalID1 {
			t.Fatalf("valid %s Goal = %#v, error = %v, args = %s/%s", view.Status, got, err, repository.lastUserID, repository.lastGoalID)
		}
	}

	invalid := []GoalView{
		{ID: goalQueryTestGoalID1, Status: goal.StatusActiveCycle},
		{
			ID: goalQueryTestGoalID1, Status: goal.StatusActiveCycle,
			CurrentWork: &CurrentWorkView{
				Kind: "active_cycle", CycleID: goalQueryTestCycleID, CycleSequenceNumber: 1,
				ReviewDraftID: goalQueryTestDraftID,
			},
		},
		{
			ID: goalQueryTestGoalID1, Status: goal.StatusGoalReview,
			CurrentWork: &CurrentWorkView{
				Kind: "goal_review", ReviewDraftID: goalQueryTestDraftID,
				TriggerCycleID: goalQueryTestCycleID, TriggerCycleSequenceNumber: 1,
				CycleID: goalQueryTestCycleID,
			},
		},
		{
			ID: goalQueryTestGoalID1, Status: goal.StatusEnded,
			CurrentWork: &CurrentWorkView{Kind: "active_cycle", CycleID: goalQueryTestCycleID, CycleSequenceNumber: 1},
		},
		{ID: goalQueryTestGoalID1, Status: goal.Status("unknown")},
	}
	for index, view := range invalid {
		repository := &goalQueryFakeRepository{goal: view}
		_, err := newGoalQueryUseCases(repository).GetGoal(
			context.Background(), goalQueryTestUserID, goalQueryTestGoalID1,
		)
		if !errors.Is(err, ErrGoalPersistenceInvariant) {
			t.Fatalf("invalid currentWork %d error = %v", index, err)
		}
	}
}

func TestGoalQueryUseCasesPropagateRepositoryErrors(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("query failed")
	listRepository := &goalQueryFakeRepository{rowsErr: sentinel}
	if _, err := newGoalQueryUseCases(listRepository).ListGoals(
		context.Background(), goalQueryTestUserID, "all", "", 20,
	); !errors.Is(err, sentinel) {
		t.Fatalf("ListGoals error = %v", err)
	}
	goalRepository := &goalQueryFakeRepository{goalErr: sentinel}
	if _, err := newGoalQueryUseCases(goalRepository).GetGoal(
		context.Background(), goalQueryTestUserID, goalQueryTestGoalID1,
	); !errors.Is(err, sentinel) {
		t.Fatalf("GetGoal error = %v", err)
	}
}
