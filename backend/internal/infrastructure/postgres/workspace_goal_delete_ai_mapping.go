package postgres

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

func goalDeleteAIPersistenceError(message string) error {
	return fmt.Errorf("%w: %s", workspace.ErrGoalPersistenceInvariant, message)
}

func goalDeleteGenerationsFromSQLC(
	rows []*db.LockRunningGoalGenerationsRow,
) ([]workspace.GoalDeleteGeneration, error) {
	items := make([]workspace.GoalDeleteGeneration, 0, len(rows))
	for _, row := range rows {
		if row == nil {
			return nil, goalDeleteAIPersistenceError("locked AI Generation row is nil")
		}
		generationID := uuidString(row.ID)
		if generationID == "" || row.BudgetReservedCostUsd == "" {
			return nil, goalDeleteAIPersistenceError("locked AI Generation state is incomplete")
		}
		items = append(items, workspace.GoalDeleteGeneration{
			ID:              generationID,
			ReservedCostUSD: row.BudgetReservedCostUsd,
		})
	}
	return items, nil
}

func goalDeleteMonthlyReservationsFromSQLC(
	rows []*db.SumLockedGoalReservationsByMonthRow,
) ([]workspace.MonthlyReservation, error) {
	items := make([]workspace.MonthlyReservation, 0, len(rows))
	for _, row := range rows {
		if row == nil {
			return nil, goalDeleteAIPersistenceError("Goal budget reservation row is nil")
		}
		month, valid := finiteGoalDeleteDate(row.BudgetMonthUtc)
		if !valid || month.IsZero() || row.AmountUsd == "" {
			return nil, goalDeleteAIPersistenceError("Goal budget reservation state is incomplete")
		}
		items = append(items, workspace.MonthlyReservation{
			MonthUtc:  month,
			AmountUSD: row.AmountUsd,
		})
	}
	return items, nil
}

func goalDeleteUsagesFromSQLC(
	rows []*db.LockGoalUsagesRow,
) ([]workspace.GoalDeleteUsage, error) {
	items := make([]workspace.GoalDeleteUsage, 0, len(rows))
	for _, row := range rows {
		item, err := goalDeleteUsageFromSQLC(row)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func goalDeleteUsageFromSQLC(row *db.LockGoalUsagesRow) (workspace.GoalDeleteUsage, error) {
	if row == nil {
		return workspace.GoalDeleteUsage{}, goalDeleteAIPersistenceError("locked Goal usage row is nil")
	}
	operationID := uuidString(row.OperationID)
	retainUntil, retainValid := finiteGoalDeleteTimestamptz(row.QuotaRetainUntil)
	if operationID == "" || !retainValid || retainUntil.IsZero() {
		return workspace.GoalDeleteUsage{}, goalDeleteAIPersistenceError("locked Goal usage state is incomplete")
	}
	switch row.Status {
	case "accepted", "succeeded", "failed":
	default:
		return workspace.GoalDeleteUsage{}, goalDeleteAIPersistenceError("locked Goal usage status is invalid")
	}

	var finalizedAt *time.Time
	if row.ProviderUsageFinalizedAt.Valid {
		finalized, finalizedValid := finiteGoalDeleteTimestamptz(row.ProviderUsageFinalizedAt)
		if !finalizedValid || finalized.IsZero() {
			return workspace.GoalDeleteUsage{}, goalDeleteAIPersistenceError(
				"locked Goal usage finalization timestamp is invalid",
			)
		}
		finalizedAt = &finalized
	}
	return workspace.GoalDeleteUsage{
		OperationID:              operationID,
		Status:                   row.Status,
		QuotaRetainUntil:         retainUntil,
		ProviderUsageFinalizedAt: finalizedAt,
	}, nil
}

func finiteGoalDeleteDate(value pgtype.Date) (time.Time, bool) {
	if !value.Valid || value.InfinityModifier != pgtype.Finite {
		return time.Time{}, false
	}
	return value.Time.UTC(), true
}

func finiteGoalDeleteTimestamptz(value pgtype.Timestamptz) (time.Time, bool) {
	if !value.Valid || value.InfinityModifier != pgtype.Finite {
		return time.Time{}, false
	}
	return value.Time.UTC(), true
}

func goalDeleteDate(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value.UTC(), Valid: true}
}
