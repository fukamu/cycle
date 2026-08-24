package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
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

func (store *WorkspaceStore) GetReview(ctx context.Context, userID, goalID string) (workspace.ReviewView, error) {
	view, err := getGoalView(ctx, store.pool, userID, goalID)
	if err != nil {
		return workspace.ReviewView{}, err
	}
	if view.Status != goal.StatusGoalReview {
		return workspace.ReviewView{}, workspace.ErrGoalReviewNotActive
	}
	draftRow, err := store.queries.GetGoalReviewDraft(ctx, db.GetGoalReviewDraftParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.ReviewView{}, workspace.ErrGoalReviewInvariant
	}
	if err != nil {
		return workspace.ReviewView{}, err
	}
	draft, err := draftViewFromGoalDraft(draftRow)
	if err != nil {
		return workspace.ReviewView{}, err
	}
	if draft.ReviewCycleID == nil {
		return workspace.ReviewView{}, workspace.ErrGoalReviewInvariant
	}
	trigger, err := getCycleView(ctx, store.pool, userID, goalID, *draft.ReviewCycleID)
	if err != nil {
		if errors.Is(err, workspace.ErrNotFound) || errors.Is(err, workspace.ErrCycleNotFound) {
			return workspace.ReviewView{}, workspace.ErrGoalReviewInvariant
		}
		return workspace.ReviewView{}, err
	}
	return workspace.ReviewView{Goal: view, ReviewDraft: draft, TriggerCycle: trigger}, nil
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
