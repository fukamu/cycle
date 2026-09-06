package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
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

func TestValidateGoalReviewViewRejectsCrossFieldInconsistency(t *testing.T) {
	t.Parallel()

	const otherID = "19000000-0000-7000-8000-000000000001"
	tests := map[string]struct {
		requestedGoalID string
		mutate          func(*workspace.ReviewView)
	}{
		"requested Goal differs": {
			requestedGoalID: otherID,
		},
		"Goal status differs": {
			mutate: func(view *workspace.ReviewView) { view.Goal.Status = goal.StatusActiveCycle },
		},
		"review Goal is terminal": {
			mutate: func(view *workspace.ReviewView) {
				terminalAt := view.ReviewDraft.UpdatedAt
				view.Goal.TerminalAt = &terminalAt
			},
		},
		"current work is missing": {
			mutate: func(view *workspace.ReviewView) { view.Goal.CurrentWork = nil },
		},
		"current work kind differs": {
			mutate: func(view *workspace.ReviewView) { view.Goal.CurrentWork.Kind = "active_cycle" },
		},
		"current work contains active Cycle fields": {
			mutate: func(view *workspace.ReviewView) {
				view.Goal.CurrentWork.CycleID = otherID
				view.Goal.CurrentWork.CycleSequenceNumber = 1
			},
		},
		"current work Draft differs": {
			mutate: func(view *workspace.ReviewView) { view.Goal.CurrentWork.ReviewDraftID = otherID },
		},
		"current work Trigger Cycle differs": {
			mutate: func(view *workspace.ReviewView) { view.Goal.CurrentWork.TriggerCycleID = otherID },
		},
		"current work Trigger sequence differs": {
			mutate: func(view *workspace.ReviewView) { view.Goal.CurrentWork.TriggerCycleSequenceNumber++ },
		},
		"next Cycle sequence does not follow Trigger": {
			mutate: func(view *workspace.ReviewView) { view.Goal.NextCycleSequenceNumber++ },
		},
		"Draft type differs": {
			mutate: func(view *workspace.ReviewView) { view.ReviewDraft.DraftType = string(goal.DraftCreation) },
		},
		"Draft Goal is missing": {
			mutate: func(view *workspace.ReviewView) { view.ReviewDraft.GoalID = nil },
		},
		"Draft Goal differs": {
			mutate: func(view *workspace.ReviewView) { view.ReviewDraft.GoalID = goalReviewStringPointer(otherID) },
		},
		"Draft base Version is missing": {
			mutate: func(view *workspace.ReviewView) { view.ReviewDraft.BaseGoalVersionID = nil },
		},
		"Draft base Version differs": {
			mutate: func(view *workspace.ReviewView) {
				view.ReviewDraft.BaseGoalVersionID = goalReviewStringPointer(otherID)
			},
		},
		"Draft Review Cycle is missing": {
			mutate: func(view *workspace.ReviewView) { view.ReviewDraft.ReviewCycleID = nil },
		},
		"Draft Review Cycle differs": {
			mutate: func(view *workspace.ReviewView) { view.ReviewDraft.ReviewCycleID = goalReviewStringPointer(otherID) },
		},
		"Trigger Cycle Goal differs": {
			mutate: func(view *workspace.ReviewView) { view.TriggerCycle.GoalID = otherID },
		},
		"Trigger Cycle is not completed": {
			mutate: func(view *workspace.ReviewView) { view.TriggerCycle.Status = cycle.StatusActive },
		},
		"Trigger Cycle completion is missing": {
			mutate: func(view *workspace.ReviewView) { view.TriggerCycle.CompletedAt = nil },
		},
		"Trigger Cycle has canceled timestamp": {
			mutate: func(view *workspace.ReviewView) {
				canceledAt := view.TriggerCycle.StartedAt
				view.TriggerCycle.CanceledAt = &canceledAt
			},
		},
		"Trigger Cycle has cancellation reason": {
			mutate: func(view *workspace.ReviewView) {
				reason := cycle.CancellationGoalEnded
				view.TriggerCycle.CancellationReason = &reason
			},
		},
		"Trigger Cycle Version differs": {
			mutate: func(view *workspace.ReviewView) { view.TriggerCycle.GoalVersion.ID = otherID },
		},
	}
	for name, test := range tests {
		name, test := name, test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			view := validGoalReviewView()
			if test.mutate != nil {
				test.mutate(&view)
			}
			requestedGoalID := test.requestedGoalID
			if requestedGoalID == "" {
				requestedGoalID = view.Goal.ID
			}
			if err := validateGoalReviewView(requestedGoalID, view); !errors.Is(err, workspace.ErrGoalReviewInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrGoalReviewInvariant)
			}
		})
	}
}

func TestValidateGoalReviewViewAllowsEditedDraft(t *testing.T) {
	t.Parallel()

	view := validGoalReviewView()
	if view.ReviewDraft.Body == view.Goal.CurrentVersion.Body || view.ReviewDraft.Revision == 0 ||
		view.TriggerCycle.CompletedAt == nil || !view.ReviewDraft.UpdatedAt.After(*view.TriggerCycle.CompletedAt) {
		t.Fatal("test fixture must exercise an edited Review Draft")
	}
	if err := validateGoalReviewView(view.Goal.ID, view); err != nil {
		t.Fatalf("edited Review Draft validation error = %v", err)
	}
}

func TestGoalReviewMaterializationErrorPreservesPersistenceCause(t *testing.T) {
	t.Parallel()

	for _, cause := range []error{
		workspace.ErrGoalPersistenceInvariant,
		workspace.ErrCyclePersistenceInvariant,
	} {
		mapped := goalReviewMaterializationError(cause)
		if !errors.Is(mapped, workspace.ErrGoalReviewInvariant) || !errors.Is(mapped, cause) {
			t.Errorf("mapped error = %v, want Review invariant and cause %v", mapped, cause)
		}
	}
	databaseError := errors.New("database unavailable")
	if mapped := goalReviewMaterializationError(databaseError); mapped != databaseError {
		t.Fatalf("database error = %v, want original %v", mapped, databaseError)
	}
}

func validGoalReviewView() workspace.ReviewView {
	const (
		goalID    = "12000000-0000-7000-8000-000000000001"
		versionID = "13000000-0000-7000-8000-000000000001"
		cycleID   = "14000000-0000-7000-8000-000000000001"
		draftID   = "15000000-0000-7000-8000-000000000001"
	)
	startedAt := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	completedAt := startedAt.Add(time.Hour)
	updatedAt := completedAt.Add(time.Hour)
	return workspace.ReviewView{
		Goal: workspace.GoalView{
			ID: goalID, Status: goal.StatusGoalReview, Revision: 1,
			CurrentVersion: workspace.GoalVersionView{
				ID: versionID, VersionNumber: 1, Body: "current Goal", CreatedAt: startedAt,
			},
			CurrentWork: &workspace.CurrentWorkView{
				Kind: "goal_review", ReviewDraftID: draftID,
				TriggerCycleID: cycleID, TriggerCycleSequenceNumber: 1,
			},
			NextCycleSequenceNumber: 2,
			CreatedAt:               startedAt,
		},
		ReviewDraft: workspace.DraftView{
			ID: draftID, DraftType: string(goal.DraftReview), GoalID: goalReviewStringPointer(goalID),
			BaseGoalVersionID: goalReviewStringPointer(versionID), ReviewCycleID: goalReviewStringPointer(cycleID),
			Body: "edited Goal", Revision: 4, UpdatedAt: updatedAt,
		},
		TriggerCycle: workspace.CycleView{
			ID: cycleID, GoalID: goalID, SequenceNumber: 1, Status: cycle.StatusCompleted,
			GoalVersion: workspace.GoalVersionView{
				ID: versionID, VersionNumber: 1, Body: "current Goal", CreatedAt: startedAt,
			},
			StartedAt: startedAt, CompletedAt: &completedAt,
			Plan: "P", Do: "D", Check: "C", Action: "A", ContentRevision: 4,
			FrameRevisions: workspace.FrameRevisions{Plan: 1, Do: 1, Check: 1, Action: 1},
		},
	}
}

func goalReviewStringPointer(value string) *string { return &value }
