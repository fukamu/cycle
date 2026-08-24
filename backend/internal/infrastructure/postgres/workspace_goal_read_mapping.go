package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type goalViewRow struct {
	View     workspace.GoalView
	Category int16
	SortTime time.Time
}

type goalViewColumns struct {
	goalID                     pgtype.UUID
	goalStatus                 string
	goalRevision               int64
	nextCycleSequenceNumber    int32
	goalCreatedAt              pgtype.Timestamptz
	goalTerminalAt             pgtype.Timestamptz
	currentVersionID           pgtype.UUID
	currentVersionNumber       *int32
	currentVersionBody         *string
	currentVersionCreatedAt    pgtype.Timestamptz
	cycleCount                 int32
	activeCycleID              pgtype.UUID
	activeCycleSequenceNumber  *int32
	reviewDraftID              pgtype.UUID
	triggerCycleID             pgtype.UUID
	triggerCycleSequenceNumber *int32
	category                   int16
	sortTime                   pgtype.Timestamptz
}

func getGoalView(ctx context.Context, query db.DBTX, userID, goalID string) (workspace.GoalView, error) {
	row, err := db.New(query).GetGoalView(ctx, db.GetGoalViewParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalView{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.GoalView{}, err
	}
	result, err := goalViewFromGetRow(row)
	if err != nil {
		return workspace.GoalView{}, err
	}
	return result.View, nil
}

func goalViewFromGetRow(row *db.GetGoalViewRow) (goalViewRow, error) {
	return mapGoalView(goalViewColumns{
		goalID: row.GoalID, goalStatus: row.GoalStatus, goalRevision: row.GoalRevision,
		nextCycleSequenceNumber: row.NextCycleSequenceNumber, goalCreatedAt: row.GoalCreatedAt,
		goalTerminalAt: row.GoalTerminalAt, currentVersionID: row.CurrentVersionID,
		currentVersionNumber: row.CurrentVersionNumber, currentVersionBody: row.CurrentVersionBody,
		currentVersionCreatedAt: row.CurrentVersionCreatedAt, cycleCount: row.CycleCount,
		activeCycleID: row.ActiveCycleID, activeCycleSequenceNumber: row.ActiveCycleSequenceNumber,
		reviewDraftID: row.ReviewDraftID, triggerCycleID: row.TriggerCycleID,
		triggerCycleSequenceNumber: row.TriggerCycleSequenceNumber, category: row.Category, sortTime: row.SortTime,
	})
}

func goalViewFromHomeRow(row *db.ListHomeGoalViewsRow) (goalViewRow, error) {
	return mapGoalView(goalViewColumns{
		goalID: row.GoalID, goalStatus: row.GoalStatus, goalRevision: row.GoalRevision,
		nextCycleSequenceNumber: row.NextCycleSequenceNumber, goalCreatedAt: row.GoalCreatedAt,
		goalTerminalAt: row.GoalTerminalAt, currentVersionID: row.CurrentVersionID,
		currentVersionNumber: row.CurrentVersionNumber, currentVersionBody: row.CurrentVersionBody,
		currentVersionCreatedAt: row.CurrentVersionCreatedAt, cycleCount: row.CycleCount,
		activeCycleID: row.ActiveCycleID, activeCycleSequenceNumber: row.ActiveCycleSequenceNumber,
		reviewDraftID: row.ReviewDraftID, triggerCycleID: row.TriggerCycleID,
		triggerCycleSequenceNumber: row.TriggerCycleSequenceNumber, category: row.Category, sortTime: row.SortTime,
	})
}

func goalViewFromListRow(row *db.ListGoalViewsRow) (goalViewRow, error) {
	return mapGoalView(goalViewColumns{
		goalID: row.GoalID, goalStatus: row.GoalStatus, goalRevision: row.GoalRevision,
		nextCycleSequenceNumber: row.NextCycleSequenceNumber, goalCreatedAt: row.GoalCreatedAt,
		goalTerminalAt: row.GoalTerminalAt, currentVersionID: row.CurrentVersionID,
		currentVersionNumber: row.CurrentVersionNumber, currentVersionBody: row.CurrentVersionBody,
		currentVersionCreatedAt: row.CurrentVersionCreatedAt, cycleCount: row.CycleCount,
		activeCycleID: row.ActiveCycleID, activeCycleSequenceNumber: row.ActiveCycleSequenceNumber,
		reviewDraftID: row.ReviewDraftID, triggerCycleID: row.TriggerCycleID,
		triggerCycleSequenceNumber: row.TriggerCycleSequenceNumber, category: row.Category, sortTime: row.SortTime,
	})
}

func mapGoalView(columns goalViewColumns) (goalViewRow, error) {
	goalID := uuidString(columns.goalID)
	if goalID == "" || !isFiniteGoalTimestamptz(columns.goalCreatedAt) || !isFiniteGoalTimestamptz(columns.sortTime) {
		return goalViewRow{}, fmt.Errorf("%w: Goal identity or timestamps are missing", workspace.ErrGoalPersistenceInvariant)
	}
	if !columns.currentVersionID.Valid || columns.currentVersionNumber == nil ||
		columns.currentVersionBody == nil || !isFiniteGoalTimestamptz(columns.currentVersionCreatedAt) {
		return goalViewRow{}, fmt.Errorf("%w: Goal current Version is missing", workspace.ErrGoalPersistenceInvariant)
	}
	currentVersionID := uuidString(columns.currentVersionID)
	if currentVersionID == "" {
		return goalViewRow{}, fmt.Errorf("%w: Goal current Version identity is invalid", workspace.ErrGoalPersistenceInvariant)
	}
	terminalAt, terminalAtValid := nullableGoalTimestamptz(columns.goalTerminalAt)
	if !terminalAtValid {
		return goalViewRow{}, fmt.Errorf("%w: Goal terminal timestamp is not finite", workspace.ErrGoalPersistenceInvariant)
	}
	result := goalViewRow{
		View: workspace.GoalView{
			ID:                      goalID,
			Status:                  goal.Status(columns.goalStatus),
			Revision:                columns.goalRevision,
			NextCycleSequenceNumber: columns.nextCycleSequenceNumber,
			CycleCount:              columns.cycleCount,
			CreatedAt:               columns.goalCreatedAt.Time,
			TerminalAt:              terminalAt,
			CurrentVersion: workspace.GoalVersionView{
				ID:            currentVersionID,
				VersionNumber: *columns.currentVersionNumber,
				Body:          *columns.currentVersionBody,
				CreatedAt:     columns.currentVersionCreatedAt.Time,
			},
		},
		Category: columns.category,
		SortTime: columns.sortTime.Time,
	}

	hasActive := columns.activeCycleID.Valid || columns.activeCycleSequenceNumber != nil
	activeComplete := columns.activeCycleID.Valid && columns.activeCycleSequenceNumber != nil
	hasReview := columns.reviewDraftID.Valid || columns.triggerCycleID.Valid || columns.triggerCycleSequenceNumber != nil
	reviewComplete := columns.reviewDraftID.Valid && columns.triggerCycleID.Valid && columns.triggerCycleSequenceNumber != nil
	switch result.View.Status {
	case goal.StatusActiveCycle:
		if result.View.TerminalAt != nil || !activeComplete || hasReview {
			return goalViewRow{}, fmt.Errorf("%w: active Goal current work invalid", workspace.ErrGoalPersistenceInvariant)
		}
		cycleID := uuidString(columns.activeCycleID)
		if cycleID == "" {
			return goalViewRow{}, fmt.Errorf("%w: active Goal Cycle identity invalid", workspace.ErrGoalPersistenceInvariant)
		}
		result.View.CurrentWork = &workspace.CurrentWorkView{
			Kind:                "active_cycle",
			CycleID:             cycleID,
			CycleSequenceNumber: *columns.activeCycleSequenceNumber,
		}
	case goal.StatusGoalReview:
		if result.View.TerminalAt != nil || hasActive || !reviewComplete {
			return goalViewRow{}, fmt.Errorf("%w: review Goal current work invalid", workspace.ErrGoalPersistenceInvariant)
		}
		reviewDraftID := uuidString(columns.reviewDraftID)
		triggerCycleID := uuidString(columns.triggerCycleID)
		if reviewDraftID == "" || triggerCycleID == "" {
			return goalViewRow{}, fmt.Errorf("%w: review Goal current work identity invalid", workspace.ErrGoalPersistenceInvariant)
		}
		result.View.CurrentWork = &workspace.CurrentWorkView{
			Kind:                       "goal_review",
			ReviewDraftID:              reviewDraftID,
			TriggerCycleID:             triggerCycleID,
			TriggerCycleSequenceNumber: *columns.triggerCycleSequenceNumber,
		}
	case goal.StatusAchieved, goal.StatusEnded:
		if result.View.TerminalAt == nil || hasActive || hasReview {
			return goalViewRow{}, fmt.Errorf("%w: terminal Goal state is invalid", workspace.ErrGoalPersistenceInvariant)
		}
	default:
		return goalViewRow{}, fmt.Errorf("%w: invalid Goal status", workspace.ErrGoalPersistenceInvariant)
	}
	return result, nil
}

type draftViewColumns struct {
	id                pgtype.UUID
	draftType         string
	goalID            pgtype.UUID
	baseGoalVersionID pgtype.UUID
	reviewCycleID     pgtype.UUID
	body              string
	revision          int64
	updatedAt         pgtype.Timestamptz
}

func draftViewFromHomeRow(row *db.GetHomeCreationGoalDraftRow) (workspace.DraftView, error) {
	return mapDraftView(draftViewColumns{
		id: row.ID, draftType: row.DraftType, goalID: row.GoalID,
		baseGoalVersionID: row.BaseGoalVersionID, reviewCycleID: row.ReviewCycleID,
		body: row.Body, revision: row.Revision, updatedAt: row.UpdatedAt,
	})
}

func draftViewFromIDRow(row *db.GetGoalDraftByIDRow) (workspace.DraftView, error) {
	return mapDraftView(draftViewColumns{
		id: row.ID, draftType: row.DraftType, goalID: row.GoalID,
		baseGoalVersionID: row.BaseGoalVersionID, reviewCycleID: row.ReviewCycleID,
		body: row.Body, revision: row.Revision, updatedAt: row.UpdatedAt,
	})
}

func draftViewFromGoalDraft(row *db.GoalDraft) (workspace.DraftView, error) {
	return mapDraftView(draftViewColumns{
		id: row.ID, draftType: row.DraftType, goalID: row.GoalID,
		baseGoalVersionID: row.BaseGoalVersionID, reviewCycleID: row.ReviewCycleID,
		body: row.Body, revision: row.Revision, updatedAt: row.UpdatedAt,
	})
}

func mapDraftView(columns draftViewColumns) (workspace.DraftView, error) {
	id := uuidString(columns.id)
	if id == "" || !isFiniteGoalTimestamptz(columns.updatedAt) {
		return workspace.DraftView{}, fmt.Errorf("%w: Draft identity or timestamp is missing", workspace.ErrGoalPersistenceInvariant)
	}
	goalID := nullableUUIDString(columns.goalID)
	baseGoalVersionID := nullableUUIDString(columns.baseGoalVersionID)
	reviewCycleID := nullableUUIDString(columns.reviewCycleID)
	switch goal.DraftType(columns.draftType) {
	case goal.DraftCreation:
		if goalID != nil || baseGoalVersionID != nil || reviewCycleID != nil {
			return workspace.DraftView{}, fmt.Errorf("%w: Creation Draft references Goal work", workspace.ErrGoalPersistenceInvariant)
		}
	case goal.DraftReview:
		if goalID == nil || baseGoalVersionID == nil || reviewCycleID == nil {
			return workspace.DraftView{}, fmt.Errorf("%w: Review Draft references are incomplete", workspace.ErrGoalPersistenceInvariant)
		}
	default:
		return workspace.DraftView{}, fmt.Errorf("%w: invalid Draft type", workspace.ErrGoalPersistenceInvariant)
	}
	return workspace.DraftView{
		ID:                id,
		DraftType:         columns.draftType,
		GoalID:            goalID,
		BaseGoalVersionID: baseGoalVersionID,
		ReviewCycleID:     reviewCycleID,
		Body:              columns.body,
		Revision:          columns.revision,
		UpdatedAt:         columns.updatedAt.Time,
	}, nil
}

func nullableUUIDString(value pgtype.UUID) *string {
	if !value.Valid {
		return nil
	}
	result := uuidString(value)
	if result == "" {
		return nil
	}
	return &result
}

func isFiniteGoalTimestamptz(value pgtype.Timestamptz) bool {
	return value.Valid && value.InfinityModifier == pgtype.Finite
}

func nullableGoalTimestamptz(value pgtype.Timestamptz) (*time.Time, bool) {
	if !value.Valid {
		return nil, true
	}
	if value.InfinityModifier != pgtype.Finite {
		return nil, false
	}
	result := value.Time
	return &result, true
}
