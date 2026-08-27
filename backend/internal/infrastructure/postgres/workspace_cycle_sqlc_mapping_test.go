package postgres

import (
	"errors"
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
