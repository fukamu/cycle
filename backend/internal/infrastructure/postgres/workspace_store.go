package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type WorkspaceStore struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

func NewWorkspaceStore(pool *pgxpool.Pool) *WorkspaceStore {
	return &WorkspaceStore{pool: pool, queries: db.New(pool)}
}

func (store *WorkspaceStore) Home(ctx context.Context, userID string, limit int) (workspace.HomeView, error) {
	view := workspace.HomeView{ProgressingGoals: []workspace.GoalView{}, ProgressingGoalLimit: limit}
	rows, err := store.queries.ListHomeGoalViews(ctx, mustUUID(userID))
	if err != nil {
		return view, err
	}
	for _, row := range rows {
		item, mapErr := goalViewFromHomeRow(row)
		if mapErr != nil {
			return view, mapErr
		}
		view.ProgressingGoals = append(view.ProgressingGoals, item.View)
	}
	draftRow, err := store.queries.GetHomeCreationGoalDraft(ctx, mustUUID(userID))
	if err == nil {
		draft, mapErr := draftViewFromHomeRow(draftRow)
		if mapErr != nil {
			return view, mapErr
		}
		view.CreationDraft = &draft
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return view, err
	}
	view.CanCreateGoalDraft = view.CreationDraft == nil
	view.CanStartProgressingGoal = len(view.ProgressingGoals) < limit
	return view, nil
}

func (store *WorkspaceStore) GetDraft(ctx context.Context, userID, draftID string) (workspace.DraftView, error) {
	row, err := store.queries.GetGoalDraftByID(ctx, db.GetGoalDraftByIDParams{
		DraftID: mustUUID(draftID),
		UserID:  mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.DraftView{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.DraftView{}, err
	}
	view, err := draftViewFromIDRow(row)
	if err != nil {
		return workspace.DraftView{}, err
	}
	if view.DraftType != string(goal.DraftCreation) {
		return workspace.DraftView{}, workspace.ErrDraftTypeMismatch
	}
	return view, nil
}

func (store *WorkspaceStore) GetReview(ctx context.Context, userID, goalID string) (result workspace.ReviewView, err error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return workspace.ReviewView{}, err
	}
	defer rollback(ctx, tx)
	queries := store.queries.WithTx(tx)

	view, err := getGoalView(ctx, tx, userID, goalID)
	if err != nil {
		return workspace.ReviewView{}, goalReviewMaterializationError(err)
	}
	if view.Status != goal.StatusGoalReview {
		return workspace.ReviewView{}, workspace.ErrGoalReviewNotActive
	}
	draftRow, err := queries.GetGoalReviewDraft(ctx, db.GetGoalReviewDraftParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.ReviewView{}, goalReviewInvariantError("Review Draft is missing")
	}
	if err != nil {
		return workspace.ReviewView{}, err
	}
	draft, err := draftViewFromGoalDraft(draftRow)
	if err != nil {
		return workspace.ReviewView{}, goalReviewMaterializationError(err)
	}
	if draft.ReviewCycleID == nil {
		return workspace.ReviewView{}, goalReviewInvariantError("Review Draft has no Trigger Cycle")
	}
	trigger, err := getCycleView(ctx, tx, userID, goalID, *draft.ReviewCycleID)
	if err != nil {
		if errors.Is(err, workspace.ErrNotFound) || errors.Is(err, workspace.ErrCycleNotFound) {
			return workspace.ReviewView{}, goalReviewInvariantError("Trigger Cycle is missing")
		}
		return workspace.ReviewView{}, goalReviewMaterializationError(err)
	}
	result = workspace.ReviewView{Goal: view, ReviewDraft: draft, TriggerCycle: trigger}
	if err = validateGoalReviewView(goalID, result); err != nil {
		return workspace.ReviewView{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.ReviewView{}, err
	}
	return result, nil
}

func validateGoalReviewView(goalID string, view workspace.ReviewView) error {
	currentWork := view.Goal.CurrentWork
	if goalID == "" || view.Goal.ID != goalID || view.Goal.Status != goal.StatusGoalReview ||
		view.Goal.TerminalAt != nil {
		return goalReviewInvariantError("Goal state does not match the requested Review")
	}
	if currentWork == nil || currentWork.Kind != "goal_review" || currentWork.CycleID != "" ||
		currentWork.CycleSequenceNumber != 0 || currentWork.ReviewDraftID == "" ||
		currentWork.TriggerCycleID == "" || currentWork.TriggerCycleSequenceNumber <= 0 {
		return goalReviewInvariantError("Goal current work is not a Review")
	}
	if view.ReviewDraft.ID == "" || currentWork.ReviewDraftID != view.ReviewDraft.ID ||
		view.TriggerCycle.ID == "" || currentWork.TriggerCycleID != view.TriggerCycle.ID ||
		currentWork.TriggerCycleSequenceNumber != view.TriggerCycle.SequenceNumber {
		return goalReviewInvariantError("Goal current work does not match the Review resources")
	}
	if view.Goal.NextCycleSequenceNumber <= 1 ||
		view.TriggerCycle.SequenceNumber != view.Goal.NextCycleSequenceNumber-1 {
		return goalReviewInvariantError("Trigger Cycle sequence does not precede the next Cycle")
	}
	if view.ReviewDraft.DraftType != string(goal.DraftReview) || view.ReviewDraft.GoalID == nil ||
		*view.ReviewDraft.GoalID != view.Goal.ID || view.ReviewDraft.BaseGoalVersionID == nil ||
		*view.ReviewDraft.BaseGoalVersionID != view.Goal.CurrentVersion.ID ||
		view.ReviewDraft.ReviewCycleID == nil || *view.ReviewDraft.ReviewCycleID != view.TriggerCycle.ID {
		return goalReviewInvariantError("Review Draft references are inconsistent")
	}
	if view.Goal.CurrentVersion.ID == "" || view.TriggerCycle.GoalID != view.Goal.ID ||
		view.TriggerCycle.Status != cycle.StatusCompleted || view.TriggerCycle.CompletedAt == nil ||
		view.TriggerCycle.CanceledAt != nil || view.TriggerCycle.CancellationReason != nil ||
		view.TriggerCycle.GoalVersion.ID != view.Goal.CurrentVersion.ID {
		return goalReviewInvariantError("Trigger Cycle does not match the reviewed Goal Version")
	}
	return nil
}

func goalReviewMaterializationError(err error) error {
	if errors.Is(err, workspace.ErrGoalPersistenceInvariant) ||
		errors.Is(err, workspace.ErrCyclePersistenceInvariant) {
		return errors.Join(workspace.ErrGoalReviewInvariant, err)
	}
	return err
}

func goalReviewInvariantError(detail string) error {
	return fmt.Errorf("%w: %s", workspace.ErrGoalReviewInvariant, detail)
}

func getCycleView(ctx context.Context, query db.DBTX, userID, goalID, cycleID string) (workspace.CycleView, error) {
	return queryCycleView(ctx, query, userID, goalID, cycleID)
}

func scanDraft(row pgx.Row) (workspace.DraftView, error) {
	var view workspace.DraftView
	err := row.Scan(&view.ID, &view.DraftType, &view.GoalID, &view.BaseGoalVersionID, &view.ReviewCycleID,
		&view.Body, &view.Revision, &view.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.DraftView{}, workspace.ErrNotFound
	}
	return view, err
}

func rollback(ctx context.Context, tx pgx.Tx) { _ = tx.Rollback(ctx) }

func rollbackOnError(ctx context.Context, tx pgx.Tx, operationError *error) {
	if *operationError != nil {
		_ = tx.Rollback(ctx)
	}
}

func isUniqueViolation(err error) bool {
	var databaseError *pgconn.PgError
	return errors.As(err, &databaseError) && databaseError.Code == "23505"
}
