package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

func TestGoalDraftFromSQLCPreservesCreationAndReviewTuples(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 12, 34, 56, 0, time.FixedZone("test", 9*60*60))
	base := db.GoalDraft{
		ID:        mustUUID("11000000-0000-7000-8000-000000000001"),
		UserID:    mustUUID("10000000-0000-7000-8000-000000000001"),
		DraftType: string(goal.DraftCreation),
		Body:      "body",
		Revision:  3,
		CreatedAt: pgtype.Timestamptz{Time: now, Valid: true},
		UpdatedAt: pgtype.Timestamptz{Time: now.Add(time.Minute), Valid: true},
	}
	creation, err := goalDraftFromSQLC(&base)
	if err != nil {
		t.Fatal(err)
	}
	if creation.Type != goal.DraftCreation || creation.GoalID != nil || creation.BaseGoalVersionID != nil || creation.ReviewCycleID != nil {
		t.Fatalf("Creation Draft tuple = %#v", creation)
	}
	if creation.CreatedAt.Location() != time.UTC || creation.UpdatedAt.Location() != time.UTC {
		t.Fatalf("Draft timestamps must be UTC: created=%v updated=%v", creation.CreatedAt, creation.UpdatedAt)
	}

	reviewRow := base
	reviewRow.DraftType = string(goal.DraftReview)
	reviewRow.GoalID = mustUUID("12000000-0000-7000-8000-000000000001")
	reviewRow.BaseGoalVersionID = mustUUID("13000000-0000-7000-8000-000000000001")
	reviewRow.ReviewCycleID = mustUUID("14000000-0000-7000-8000-000000000001")
	review, err := goalDraftFromSQLC(&reviewRow)
	if err != nil {
		t.Fatal(err)
	}
	if review.Type != goal.DraftReview || review.GoalID == nil || review.BaseGoalVersionID == nil || review.ReviewCycleID == nil {
		t.Fatalf("Review Draft tuple = %#v", review)
	}
}

func TestGoalDraftFromSQLCRejectsInvalidRequiredFieldsAndTuples(t *testing.T) {
	t.Parallel()

	now := timestamptz(time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC))
	valid := db.GoalDraft{
		ID:        mustUUID("11000000-0000-7000-8000-000000000002"),
		UserID:    mustUUID("10000000-0000-7000-8000-000000000002"),
		DraftType: string(goal.DraftCreation),
		CreatedAt: now,
		UpdatedAt: now,
	}
	tests := map[string]func(*db.GoalDraft){
		"missing required UUID": func(row *db.GoalDraft) {
			row.ID = pgtype.UUID{}
		},
		"missing required timestamp": func(row *db.GoalDraft) {
			row.UpdatedAt = pgtype.Timestamptz{}
		},
		"positive infinity created timestamp": func(row *db.GoalDraft) {
			row.CreatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity updated timestamp": func(row *db.GoalDraft) {
			row.UpdatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"Creation references current work": func(row *db.GoalDraft) {
			row.GoalID = mustUUID("12000000-0000-7000-8000-000000000002")
		},
		"Review references incomplete": func(row *db.GoalDraft) {
			row.DraftType = string(goal.DraftReview)
		},
		"unknown Draft type": func(row *db.GoalDraft) {
			row.DraftType = "unknown"
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := valid
			mutate(&row)
			if _, err := goalDraftFromSQLC(&row); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
			}
		})
	}
	if _, err := goalDraftFromSQLC(nil); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("nil row error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
	}
}
