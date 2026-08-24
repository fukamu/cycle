package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestMapGoalViewRejectsInfiniteTimestamps(t *testing.T) {
	t.Parallel()

	versionNumber := int32(1)
	versionBody := "body"
	now := timestamptz(time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC))
	valid := goalViewColumns{
		goalID:                  mustUUID("12000000-0000-7000-8000-000000000001"),
		goalStatus:              string(goal.StatusEnded),
		goalCreatedAt:           now,
		goalTerminalAt:          now,
		currentVersionID:        mustUUID("13000000-0000-7000-8000-000000000001"),
		currentVersionNumber:    &versionNumber,
		currentVersionBody:      &versionBody,
		currentVersionCreatedAt: now,
		sortTime:                now,
	}
	view, err := mapGoalView(valid)
	if err != nil {
		t.Fatal(err)
	}
	if view.View.TerminalAt == nil {
		t.Fatal("terminal timestamp = nil, want finite timestamp")
	}

	tests := map[string]func(*goalViewColumns){
		"positive infinity Goal created timestamp": func(columns *goalViewColumns) {
			columns.goalCreatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity current Version created timestamp": func(columns *goalViewColumns) {
			columns.currentVersionCreatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"positive infinity sort timestamp": func(columns *goalViewColumns) {
			columns.sortTime = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity terminal timestamp": func(columns *goalViewColumns) {
			columns.goalTerminalAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"terminal Goal missing terminal timestamp": func(columns *goalViewColumns) {
			columns.goalTerminalAt = pgtype.Timestamptz{}
		},
		"progressing Goal with terminal timestamp": func(columns *goalViewColumns) {
			sequence := int32(1)
			columns.goalStatus = string(goal.StatusActiveCycle)
			columns.activeCycleID = mustUUID("14000000-0000-7000-8000-000000000001")
			columns.activeCycleSequenceNumber = &sequence
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			columns := valid
			mutate(&columns)
			if _, err := mapGoalView(columns); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
			}
		})
	}
}

func TestMapDraftViewRejectsInfiniteUpdatedTimestamp(t *testing.T) {
	t.Parallel()

	valid := draftViewColumns{
		id:        mustUUID("11000000-0000-7000-8000-000000000001"),
		draftType: string(goal.DraftCreation),
		updatedAt: timestamptz(time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)),
	}
	if _, err := mapDraftView(valid); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]pgtype.Timestamptz{
		"positive infinity": {Valid: true, InfinityModifier: pgtype.Infinity},
		"negative infinity": {Valid: true, InfinityModifier: pgtype.NegativeInfinity},
	} {
		name, value := name, value
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			columns := valid
			columns.updatedAt = value
			if _, err := mapDraftView(columns); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
			}
		})
	}
	unknown := valid
	unknown.draftType = "unknown"
	if _, err := mapDraftView(unknown); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("unknown Draft type error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
	}

}
