package postgres

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

func TestCycleFromSQLCRequiresFiniteTimestampsAndPreservesUTC(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 12, 34, 56, 0, time.FixedZone("test", 9*60*60))
	valid := validCycleSQLCRow(now)
	mapped, err := cycleFromSQLC(&valid)
	if err != nil {
		t.Fatal(err)
	}
	if mapped.StartedAt.Location() != time.UTC || mapped.CreatedAt.Location() != time.UTC ||
		mapped.UpdatedAt.Location() != time.UTC || mapped.CompletedAt != nil || mapped.CanceledAt != nil {
		t.Fatalf("active Cycle timestamps = %#v", mapped)
	}

	tests := map[string]func(*db.PdcaCycle){
		"positive infinity started_at": func(row *db.PdcaCycle) {
			row.StartedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity created_at": func(row *db.PdcaCycle) {
			row.CreatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"positive infinity updated_at": func(row *db.PdcaCycle) {
			row.UpdatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"positive infinity completed_at": func(row *db.PdcaCycle) {
			requestHash := "complete-hash"
			row.Status = string(cycle.StatusCompleted)
			row.CompletedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
			row.CompletionOperationID = mustUUID("70000000-0000-7000-8000-000000000002")
			row.CompletionRequestHash = &requestHash
		},
		"negative infinity canceled_at": func(row *db.PdcaCycle) {
			reason := string(cycle.CancellationGoalEnded)
			row.Status = string(cycle.StatusCanceled)
			row.CanceledAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
			row.CancellationReason = &reason
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := valid
			mutate(&row)
			if _, err := cycleFromSQLC(&row); !errors.Is(err, workspace.ErrCyclePersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrCyclePersistenceInvariant)
			}
		})
	}
}

func TestCycleReadMappersDistinguishNullFromInfiniteTimestamps(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 12, 34, 56, 0, time.FixedZone("test", 9*60*60))
	versionNumber := int32(1)
	versionBody := "Goal"
	summary := db.ListCycleSummariesRow{
		CycleID:              mustUUID("14000000-0000-7000-8000-000000000001"),
		SequenceNumber:       1,
		Status:               string(cycle.StatusActive),
		StartedAt:            timestamptz(now),
		GoalVersionID:        mustUUID("13000000-0000-7000-8000-000000000001"),
		GoalVersionNumber:    &versionNumber,
		GoalVersionBody:      &versionBody,
		GoalVersionCreatedAt: timestamptz(now.Add(-time.Minute)),
		PlanPreview:          "plan",
	}
	mappedSummary, err := cycleSummaryFromReadRow(&summary)
	if err != nil {
		t.Fatal(err)
	}
	if mappedSummary.CompletedAt != nil || mappedSummary.CanceledAt != nil ||
		mappedSummary.StartedAt.Location() != time.UTC || mappedSummary.GoalVersion.CreatedAt.Location() != time.UTC {
		t.Fatalf("active summary timestamps = %#v", mappedSummary)
	}

	for name, mutate := range map[string]func(*db.ListCycleSummariesRow){
		"positive infinity start": func(row *db.ListCycleSummariesRow) {
			row.StartedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity Version creation": func(row *db.ListCycleSummariesRow) {
			row.GoalVersionCreatedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"positive infinity optional completion": func(row *db.ListCycleSummariesRow) {
			row.CompletedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
	} {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := summary
			mutate(&row)
			if _, err := cycleSummaryFromReadRow(&row); !errors.Is(err, workspace.ErrCyclePersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrCyclePersistenceInvariant)
			}
		})
	}

	view := db.GetCycleViewRow{
		CycleID:              summary.CycleID,
		GoalID:               mustUUID("12000000-0000-7000-8000-000000000001"),
		SequenceNumber:       summary.SequenceNumber,
		Status:               summary.Status,
		StartedAt:            summary.StartedAt,
		GoalVersionID:        summary.GoalVersionID,
		GoalVersionNumber:    summary.GoalVersionNumber,
		GoalVersionBody:      summary.GoalVersionBody,
		GoalVersionCreatedAt: summary.GoalVersionCreatedAt,
	}
	if _, err := cycleViewFromReadRow(&view); err != nil {
		t.Fatalf("active Cycle view with NULL optional timestamps: %v", err)
	}
	view.CanceledAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
	if _, err := cycleViewFromReadRow(&view); !errors.Is(err, workspace.ErrCyclePersistenceInvariant) {
		t.Fatalf("infinite optional Cycle view timestamp error = %v", err)
	}
}

func TestCycleViewMapperBuildsExactPreviousCompletedActionAndFailsClosed(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 12, 34, 56, 0, time.UTC)
	valid := validCycleViewSQLCRow(now)
	view, err := cycleViewFromReadRow(&valid)
	if err != nil {
		t.Fatal(err)
	}
	want := workspace.PreviousCompletedCycleActionView{
		CycleID:             "14000000-0000-7000-8000-000000000001",
		CycleSequenceNumber: 1,
		GoalVersionNumber:   1,
		Action:              "次は通知を切る\n30分集中する",
	}
	if view.PreviousCompletedCycleAction == nil || *view.PreviousCompletedCycleAction != want {
		t.Fatalf("previous completed Action = %#v, want %#v", view.PreviousCompletedCycleAction, want)
	}
	atLimit := valid
	atLimitAction := strings.Repeat("🌱", cycle.MaxFrameCodePoints)
	atLimit.PreviousCycleAction = &atLimitAction
	if _, err = cycleViewFromReadRow(&atLimit); err != nil {
		t.Fatalf("Action at code point limit: %v", err)
	}

	tests := map[string]func(*db.GetCycleViewRow){
		"missing predecessor": func(row *db.GetCycleViewRow) {
			row.PreviousCycleID = pgtype.UUID{}
			row.PreviousCycleSequenceNumber = nil
			row.PreviousCycleStatus = nil
			row.PreviousCycleAction = nil
			row.PreviousGoalVersionNumber = nil
		},
		"same Cycle ID": func(row *db.GetCycleViewRow) { row.PreviousCycleID = row.CycleID },
		"wrong sequence": func(row *db.GetCycleViewRow) {
			value := int32(2)
			row.PreviousCycleSequenceNumber = &value
		},
		"canceled predecessor": func(row *db.GetCycleViewRow) {
			value := string(cycle.StatusCanceled)
			row.PreviousCycleStatus = &value
		},
		"active predecessor": func(row *db.GetCycleViewRow) {
			value := string(cycle.StatusActive)
			row.PreviousCycleStatus = &value
		},
		"blank Action": func(row *db.GetCycleViewRow) {
			value := " \n\t"
			row.PreviousCycleAction = &value
		},
		"oversize Action": func(row *db.GetCycleViewRow) {
			value := strings.Repeat("🌱", cycle.MaxFrameCodePoints+1)
			row.PreviousCycleAction = &value
		},
		"zero Goal Version": func(row *db.GetCycleViewRow) {
			value := int32(0)
			row.PreviousGoalVersionNumber = &value
		},
		"future Goal Version": func(row *db.GetCycleViewRow) {
			value := int32(3)
			row.PreviousGoalVersionNumber = &value
		},
		"Goal Version more than one behind": func(row *db.GetCycleViewRow) {
			value := int32(3)
			row.GoalVersionNumber = &value
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := valid
			mutate(&row)
			if _, mapErr := cycleViewFromReadRow(&row); !errors.Is(mapErr, workspace.ErrCyclePersistenceInvariant) {
				t.Fatalf("error = %v, want %v", mapErr, workspace.ErrCyclePersistenceInvariant)
			}
		})
	}
}

func TestCycleViewMapperReturnsNullPreviousActionForFirstAndTerminalCycles(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 12, 34, 56, 0, time.UTC)
	first := validCycleViewSQLCRow(now)
	first.SequenceNumber = 1
	first.PreviousCycleID = pgtype.UUID{}
	first.PreviousCycleSequenceNumber = nil
	first.PreviousCycleStatus = nil
	first.PreviousCycleAction = nil
	first.PreviousGoalVersionNumber = nil
	view, err := cycleViewFromReadRow(&first)
	if err != nil || view.PreviousCompletedCycleAction != nil {
		t.Fatalf("Cycle 1 previous Action = %#v, error = %v", view.PreviousCompletedCycleAction, err)
	}

	first.PreviousCycleID = mustUUID("14000000-0000-7000-8000-000000000009")
	if _, err = cycleViewFromReadRow(&first); !errors.Is(err, workspace.ErrCyclePersistenceInvariant) {
		t.Fatalf("Cycle 1 unexpected predecessor error = %v", err)
	}

	terminal := validCycleViewSQLCRow(now)
	terminal.Status = string(cycle.StatusCompleted)
	terminal.CompletedAt = timestamptz(now.Add(time.Hour))
	view, err = cycleViewFromReadRow(&terminal)
	if err != nil || view.PreviousCompletedCycleAction != nil {
		t.Fatalf("terminal previous Action = %#v, error = %v", view.PreviousCompletedCycleAction, err)
	}
}

func validCycleViewSQLCRow(now time.Time) db.GetCycleViewRow {
	currentVersion := int32(2)
	previousSequence := int32(1)
	previousStatus := string(cycle.StatusCompleted)
	previousAction := "次は通知を切る\n30分集中する"
	previousVersion := int32(1)
	goalBody := "Goal"
	return db.GetCycleViewRow{
		CycleID:                     mustUUID("14000000-0000-7000-8000-000000000002"),
		GoalID:                      mustUUID("12000000-0000-7000-8000-000000000001"),
		SequenceNumber:              2,
		Status:                      string(cycle.StatusActive),
		StartedAt:                   timestamptz(now),
		GoalVersionID:               mustUUID("13000000-0000-7000-8000-000000000002"),
		GoalVersionNumber:           &currentVersion,
		GoalVersionBody:             &goalBody,
		GoalVersionCreatedAt:        timestamptz(now.Add(-time.Minute)),
		PreviousCycleID:             mustUUID("14000000-0000-7000-8000-000000000001"),
		PreviousCycleSequenceNumber: &previousSequence,
		PreviousCycleStatus:         &previousStatus,
		PreviousCycleAction:         &previousAction,
		PreviousGoalVersionNumber:   &previousVersion,
	}
}

func validCycleSQLCRow(now time.Time) db.PdcaCycle {
	return db.PdcaCycle{
		ID:               mustUUID("14000000-0000-7000-8000-000000000001"),
		UserID:           mustUUID("10000000-0000-7000-8000-000000000001"),
		GoalID:           mustUUID("12000000-0000-7000-8000-000000000001"),
		GoalVersionID:    mustUUID("13000000-0000-7000-8000-000000000001"),
		SequenceNumber:   1,
		Status:           string(cycle.StatusActive),
		StartedAt:        timestamptz(now),
		StartOperationID: mustUUID("70000000-0000-7000-8000-000000000001"),
		StartRequestHash: "start-hash",
		CreatedAt:        timestamptz(now),
		UpdatedAt:        timestamptz(now.Add(time.Minute)),
	}
}
