package workspace

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestGoalDraftUseCasesStartClassifiesLostInitialCycleClaim(t *testing.T) {
	requestHash := hashRequest(struct {
		DraftID  string `json:"draftId"`
		Revision int64  `json:"revision"`
	}{goalDraftTestDraftID, 4})
	tests := []struct {
		name       string
		afterClaim *StartReplayState
		want       error
	}{
		{
			name: "different receipt is key reuse",
			afterClaim: &StartReplayState{
				GoalID:      "40000000-0000-7000-8000-000000000002",
				CycleID:     "60000000-0000-7000-8000-000000000002",
				RequestHash: "competing-continue-request",
			},
			want: ErrIdempotencyKeyReused,
		},
		{
			name: "missing receipt is persistence invariant",
			want: ErrGoalDraftPersistenceInvariant,
		},
		{
			name: "matching receipt under User lock is persistence invariant",
			afterClaim: &StartReplayState{
				GoalID: goalDraftTestGoalID, CycleID: goalDraftTestCycleID, RequestHash: requestHash,
			},
			want: ErrGoalDraftPersistenceInvariant,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx := &goalDraftFakeTx{
				draft:                 creationDraft("lost initial Cycle claim", 4),
				affected:              map[string]int64{"insert_initial_cycle": 0},
				startReplayAfterClaim: test.afterClaim,
			}
			useCases, uow := newGoalDraftTestUseCases(
				tx, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID)
			_, err := useCases.StartGoal(
				context.Background(), goalDraftTestUserID, goalDraftTestDraftID,
				goalDraftTestOperationID, 4)
			if !errors.Is(err, test.want) || uow.rolledBack != 1 || uow.committed != 0 {
				t.Fatalf("error/transaction = %v / %#v, want %v/rollback", err, uow, test.want)
			}
			if test.want == ErrIdempotencyKeyReused &&
				errors.Is(err, ErrGoalDraftPersistenceInvariant) {
				t.Fatalf("different receipt leaked persistence invariant: %v", err)
			}
			wantTrace := []string{
				"lock_user", "find_start_replay", "lock_draft", "lock_draft_generations",
				"count_progressing_goals", "insert_initial_goal", "insert_initial_version",
				"insert_initial_cycle", "find_start_replay",
			}
			if !reflect.DeepEqual(tx.trace, wantTrace) {
				t.Fatalf("trace = %v, want %v", tx.trace, wantTrace)
			}
		})
	}
}
