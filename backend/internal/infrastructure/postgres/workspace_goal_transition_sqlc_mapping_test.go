package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

func TestGoalVersionFromTransitionRowRequiresFiniteCreatedTimestamp(t *testing.T) {
	t.Parallel()

	versionNumber := int32(2)
	body := "body"
	now := time.Date(2026, 8, 24, 12, 34, 56, 0, time.FixedZone("test", 9*60*60))
	valid := db.LoadCurrentGoalVersionForTransitionRow{
		ID:                   mustUUID("13000000-0000-7000-8000-000000000001"),
		UserID:               mustUUID("10000000-0000-7000-8000-000000000001"),
		GoalID:               mustUUID("12000000-0000-7000-8000-000000000001"),
		VersionNumber:        &versionNumber,
		Body:                 &body,
		CreatedByOperationID: mustUUID("71000000-0000-7000-8000-000000000001"),
		CreatedAt:            pgtype.Timestamptz{Time: now, Valid: true},
	}
	version, err := goalVersionFromTransitionRow(&valid)
	if err != nil {
		t.Fatal(err)
	}
	if version.CreatedAt.Location() != time.UTC {
		t.Fatalf("Goal Version created timestamp must be UTC: %v", version.CreatedAt)
	}

	for name, value := range map[string]pgtype.Timestamptz{
		"positive infinity": {Valid: true, InfinityModifier: pgtype.Infinity},
		"negative infinity": {Valid: true, InfinityModifier: pgtype.NegativeInfinity},
	} {
		name, value := name, value
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := valid
			row.CreatedAt = value
			if _, err := goalVersionFromTransitionRow(&row); !errors.Is(err, workspace.ErrGoalVersionConflict) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrGoalVersionConflict)
			}
		})
	}
}

func TestGoalFromTransitionRowPreservesStatusTuple(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 12, 34, 56, 0, time.FixedZone("test", 9*60*60))
	base := db.Goal{
		ID:                      mustUUID("12000000-0000-7000-8000-000000000001"),
		UserID:                  mustUUID("10000000-0000-7000-8000-000000000001"),
		Status:                  string(goal.StatusActiveCycle),
		CurrentVersionNumber:    2,
		NextCycleSequenceNumber: 4,
		Revision:                3,
		CreatedAt:               pgtype.Timestamptz{Time: now, Valid: true},
		UpdatedAt:               pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true},
	}
	active, err := goalFromTransitionRow(&base)
	if err != nil {
		t.Fatal(err)
	}
	if active.Status != goal.StatusActiveCycle || active.TerminalAt != nil || active.TerminalOperationID != nil ||
		active.TerminalRequestHash != nil {
		t.Fatalf("active Goal tuple = %#v", active)
	}
	if active.CreatedAt.Location() != time.UTC || active.UpdatedAt.Location() != time.UTC {
		t.Fatalf("Goal timestamps must be UTC: created=%v updated=%v", active.CreatedAt, active.UpdatedAt)
	}

	requestHash := "termination-hash"
	terminal := base
	terminal.Status = string(goal.StatusAchieved)
	terminal.TerminalAt = pgtype.Timestamptz{Time: now.Add(2 * time.Minute), Valid: true}
	terminal.TerminalOperationID = mustUUID("72000000-0000-7000-8000-000000000001")
	terminal.TerminalRequestHash = &requestHash
	achieved, err := goalFromTransitionRow(&terminal)
	if err != nil {
		t.Fatal(err)
	}
	if achieved.Status != goal.StatusAchieved || achieved.TerminalAt == nil || achieved.TerminalOperationID == nil ||
		achieved.TerminalRequestHash == nil || *achieved.TerminalRequestHash != requestHash {
		t.Fatalf("terminal Goal tuple = %#v", achieved)
	}
}

func TestGoalFromTransitionRowRejectsInvalidRequiredFieldsAndStatusTuple(t *testing.T) {
	t.Parallel()

	now := timestamptz(time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC))
	valid := db.Goal{
		ID:                      mustUUID("12000000-0000-7000-8000-000000000002"),
		UserID:                  mustUUID("10000000-0000-7000-8000-000000000002"),
		Status:                  string(goal.StatusActiveCycle),
		CurrentVersionNumber:    1,
		NextCycleSequenceNumber: 2,
		CreatedAt:               now,
		UpdatedAt:               now,
	}
	tests := map[string]func(*db.Goal){
		"missing identity": func(row *db.Goal) {
			row.ID = pgtype.UUID{}
		},
		"missing timestamp": func(row *db.Goal) {
			row.UpdatedAt = pgtype.Timestamptz{}
		},
		"positive infinity created timestamp": func(row *db.Goal) {
			row.CreatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity updated timestamp": func(row *db.Goal) {
			row.UpdatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"unknown status": func(row *db.Goal) {
			row.Status = "unknown"
		},
		"progressing Goal with terminal metadata": func(row *db.Goal) {
			row.TerminalRequestHash = transitionStringPointer("unexpected")
		},
		"terminal Goal with incomplete metadata": func(row *db.Goal) {
			row.Status = string(goal.StatusEnded)
		},
		"terminal Goal with empty request hash": func(row *db.Goal) {
			row.Status = string(goal.StatusEnded)
			row.TerminalAt = now
			row.TerminalOperationID = mustUUID("72000000-0000-7000-8000-000000000002")
			row.TerminalRequestHash = transitionStringPointer("")
		},
		"terminal Goal with infinite timestamp": func(row *db.Goal) {
			row.Status = string(goal.StatusEnded)
			row.TerminalAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
			row.TerminalOperationID = mustUUID("72000000-0000-7000-8000-000000000002")
			row.TerminalRequestHash = transitionStringPointer("termination-hash")
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := valid
			mutate(&row)
			if _, err := goalFromTransitionRow(&row); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
			}
		})
	}
	if _, err := goalFromTransitionRow(nil); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("nil row error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
	}
}

func TestReviewDraftViewFromTransitionRowRequiresCompleteReviewTuple(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 12, 34, 56, 0, time.FixedZone("test", 9*60*60))
	valid := db.FindReviewDraftByCycleRow{
		ID:                mustUUID("11000000-0000-7000-8000-000000000001"),
		DraftType:         string(goal.DraftReview),
		GoalID:            mustUUID("12000000-0000-7000-8000-000000000001"),
		BaseGoalVersionID: mustUUID("13000000-0000-7000-8000-000000000001"),
		ReviewCycleID:     mustUUID("14000000-0000-7000-8000-000000000001"),
		Body:              "body",
		Revision:          4,
		UpdatedAt:         pgtype.Timestamptz{Time: now, Valid: true},
	}
	view, err := reviewDraftViewFromTransitionRow(&valid)
	if err != nil {
		t.Fatal(err)
	}
	if view.DraftType != string(goal.DraftReview) || view.GoalID == nil || view.BaseGoalVersionID == nil ||
		view.ReviewCycleID == nil || view.UpdatedAt.Location() != time.UTC {
		t.Fatalf("Review Draft view = %#v", view)
	}

	tests := map[string]func(*db.FindReviewDraftByCycleRow){
		"missing identity": func(row *db.FindReviewDraftByCycleRow) {
			row.ID = pgtype.UUID{}
		},
		"missing Goal reference": func(row *db.FindReviewDraftByCycleRow) {
			row.GoalID = pgtype.UUID{}
		},
		"missing base Version reference": func(row *db.FindReviewDraftByCycleRow) {
			row.BaseGoalVersionID = pgtype.UUID{}
		},
		"missing Review Cycle reference": func(row *db.FindReviewDraftByCycleRow) {
			row.ReviewCycleID = pgtype.UUID{}
		},
		"missing timestamp": func(row *db.FindReviewDraftByCycleRow) {
			row.UpdatedAt = pgtype.Timestamptz{}
		},
		"infinite timestamp": func(row *db.FindReviewDraftByCycleRow) {
			row.UpdatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"wrong Draft type": func(row *db.FindReviewDraftByCycleRow) {
			row.DraftType = string(goal.DraftCreation)
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := valid
			mutate(&row)
			if _, err := reviewDraftViewFromTransitionRow(&row); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
			}
		})
	}
	if _, err := reviewDraftViewFromTransitionRow(nil); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("nil row error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
	}
}

func TestGoalTerminationReceiptFromTransitionRowFailsClosed(t *testing.T) {
	t.Parallel()

	valid := db.FindGoalTerminationReceiptRow{
		GoalID:      mustUUID("12000000-0000-7000-8000-000000000003"),
		RequestHash: transitionStringPointer("termination-hash"),
	}
	receipt, err := goalTerminationReceiptFromTransitionRow(&valid)
	if err != nil || receipt.GoalID == "" || receipt.RequestHash != "termination-hash" {
		t.Fatalf("receipt = %#v, error = %v", receipt, err)
	}
	for name, row := range map[string]*db.FindGoalTerminationReceiptRow{
		"nil row":    nil,
		"missing ID": {RequestHash: transitionStringPointer("termination-hash")},
		"nil hash":   {GoalID: valid.GoalID},
		"empty hash": {GoalID: valid.GoalID, RequestHash: transitionStringPointer("")},
	} {
		name, row := name, row
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := goalTerminationReceiptFromTransitionRow(row); !errors.Is(err, workspace.ErrReviewTransitionPersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrReviewTransitionPersistenceInvariant)
			}
		})
	}
}

func TestTerminateGoalCASRejectsIncompleteTerminalTupleBeforeQuery(t *testing.T) {
	t.Parallel()

	transaction := &workspaceReviewTransitionTx{workspaceCycleTx: &workspaceCycleTx{}}
	if _, err := transaction.TerminateGoalCAS(context.Background(), goal.Goal{}, 0); !errors.Is(
		err,
		workspace.ErrReviewTransitionPersistenceInvariant,
	) {
		t.Fatalf("error = %v, want %v", err, workspace.ErrReviewTransitionPersistenceInvariant)
	}
}

func TestGoalTransitionLoadCurrentVersionSeparatesOwnerAndVersionAbsence(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		ownerID    = "10000000-0000-7000-8000-000000000001"
		outsiderID = "10000000-0000-7000-8000-000000000002"
	)
	insertAIConcurrencyUser(t, pool, ownerID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, ownerID, fixture, 2, now)

	if err := store.WithinCycleTransaction(context.Background(), func(tx workspace.CycleTx) error {
		if _, loadErr := tx.LoadCurrentGoalVersion(context.Background(), outsiderID, fixture.goalID, 1); !errors.Is(
			loadErr,
			workspace.ErrNotFound,
		) {
			t.Fatalf("missing owner Goal error = %v, want %v", loadErr, workspace.ErrNotFound)
		}
		if _, loadErr := tx.LoadCurrentGoalVersion(context.Background(), ownerID, fixture.goalID, 2); !errors.Is(
			loadErr,
			workspace.ErrGoalVersionConflict,
		) {
			t.Fatalf("missing Goal Version error = %v, want %v", loadErr, workspace.ErrGoalVersionConflict)
		}
		version, loadErr := tx.LoadCurrentGoalVersion(context.Background(), ownerID, fixture.goalID, 1)
		if loadErr != nil {
			return loadErr
		}
		if version.ID != started.Goal.CurrentVersion.ID || version.UserID != ownerID || version.GoalID != fixture.goalID {
			t.Fatalf("current Goal Version = %#v", version)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func transitionStringPointer(value string) *string { return &value }
