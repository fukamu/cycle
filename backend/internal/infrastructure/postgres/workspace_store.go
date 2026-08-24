package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type WorkspaceStoreSettings struct {
	Provider              string
	Model                 string
	GoalPromptVersion     string
	GeneratePromptVersion string
	RefinePromptVersion   string
	RollingLimit          int
	MonthlyBudgetUSD      float64
	ReservationUSD        float64
	LeaseDuration         time.Duration
	RateHashKey           []byte
	AIPerUserMinute       int
	AIPerSessionMinute    int
	AIPerIPMinute         int
}

type WorkspaceStore struct {
	pool     *pgxpool.Pool
	settings WorkspaceStoreSettings
}

const goalViewQuery = `SELECT g.id,g.status,g.revision,g.next_cycle_sequence_number,g.created_at,g.terminal_at,
gv.id,gv.version_number,gv.body,gv.created_at,
(SELECT count(*) FROM pdca_cycles counted WHERE counted.goal_id=g.id)::integer,
active_cycle.id,active_cycle.sequence_number,
review_draft.id,trigger_cycle.id,trigger_cycle.sequence_number,
(CASE WHEN g.status IN ('active_cycle','goal_review') THEN 0 ELSE 1 END)::smallint AS category,
CASE WHEN g.status IN ('active_cycle','goal_review') THEN g.updated_at ELSE g.terminal_at END AS sort_time
FROM goals g
LEFT JOIN goal_versions gv ON gv.goal_id=g.id AND gv.version_number=g.current_version_number
LEFT JOIN pdca_cycles active_cycle
  ON active_cycle.user_id=g.user_id AND active_cycle.goal_id=g.id AND active_cycle.status='active'
LEFT JOIN goal_drafts review_draft
  ON review_draft.user_id=g.user_id AND review_draft.goal_id=g.id AND review_draft.draft_type='review'
LEFT JOIN pdca_cycles trigger_cycle
  ON trigger_cycle.user_id=g.user_id AND trigger_cycle.goal_id=g.id AND trigger_cycle.id=review_draft.review_cycle_id`

func NewWorkspaceStore(pool *pgxpool.Pool, settings WorkspaceStoreSettings) *WorkspaceStore {
	return &WorkspaceStore{pool: pool, settings: settings}
}

func (store *WorkspaceStore) Home(ctx context.Context, userID string, limit int) (workspace.HomeView, error) {
	view := workspace.HomeView{ProgressingGoals: []workspace.GoalView{}, ProgressingGoalLimit: limit}
	rows, err := store.pool.Query(ctx, goalViewQuery+`
WHERE g.user_id=$1 AND g.status IN ('active_cycle','goal_review')
ORDER BY g.created_at ASC,g.id ASC`, mustUUID(userID))
	if err != nil {
		return view, err
	}
	for rows.Next() {
		item, scanErr := scanGoalView(rows)
		if scanErr != nil {
			rows.Close()
			return view, scanErr
		}
		view.ProgressingGoals = append(view.ProgressingGoals, item.View)
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return view, rowErr
	}
	var draft workspace.DraftView
	err = store.pool.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE user_id=$1 AND draft_type='creation'`, mustUUID(userID)).Scan(
		&draft.ID, &draft.DraftType, &draft.GoalID, &draft.BaseGoalVersionID, &draft.ReviewCycleID,
		&draft.Body, &draft.Revision, &draft.UpdatedAt)
	if err == nil {
		view.CreationDraft = &draft
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return view, err
	}
	view.CanCreateGoalDraft = view.CreationDraft == nil
	view.CanStartProgressingGoal = len(view.ProgressingGoals) < limit
	return view, nil
}

func (store *WorkspaceStore) GetDraft(ctx context.Context, userID, draftID string) (workspace.DraftView, error) {
	view, err := scanDraft(store.pool.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE id=$1 AND user_id=$2`, mustUUID(draftID), mustUUID(userID)))
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
	draft, err := scanDraft(store.pool.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE user_id=$1 AND goal_id=$2 AND draft_type='review'`, mustUUID(userID), mustUUID(goalID)))
	if err != nil {
		if errors.Is(err, workspace.ErrNotFound) {
			return workspace.ReviewView{}, workspace.ErrGoalReviewInvariant
		}
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

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type rowScanner interface {
	Scan(...any) error
}

type goalViewRow struct {
	View     workspace.GoalView
	Category int16
	SortTime time.Time
}

func scanGoalView(scanner rowScanner) (goalViewRow, error) {
	var result goalViewRow
	var currentVersionID pgtype.UUID
	var currentVersionNumber pgtype.Int4
	var currentVersionBody pgtype.Text
	var currentVersionCreatedAt pgtype.Timestamptz
	var activeCycleID, reviewDraftID, triggerCycleID pgtype.UUID
	var activeCycleSequence, triggerCycleSequence pgtype.Int4
	err := scanner.Scan(
		&result.View.ID, &result.View.Status, &result.View.Revision, &result.View.NextCycleSequenceNumber,
		&result.View.CreatedAt, &result.View.TerminalAt,
		&currentVersionID, &currentVersionNumber, &currentVersionBody, &currentVersionCreatedAt, &result.View.CycleCount,
		&activeCycleID, &activeCycleSequence,
		&reviewDraftID, &triggerCycleID, &triggerCycleSequence,
		&result.Category, &result.SortTime,
	)
	if err != nil {
		return goalViewRow{}, err
	}
	if !currentVersionID.Valid || !currentVersionNumber.Valid || !currentVersionBody.Valid || !currentVersionCreatedAt.Valid {
		return goalViewRow{}, fmt.Errorf("%w: Goal current Version is missing", workspace.ErrGoalPersistenceInvariant)
	}
	result.View.CurrentVersion = workspace.GoalVersionView{
		ID:            uuidString(currentVersionID),
		VersionNumber: currentVersionNumber.Int32,
		Body:          currentVersionBody.String,
		CreatedAt:     currentVersionCreatedAt.Time,
	}
	hasActive := activeCycleID.Valid || activeCycleSequence.Valid
	activeComplete := activeCycleID.Valid && activeCycleSequence.Valid
	hasReview := reviewDraftID.Valid || triggerCycleID.Valid || triggerCycleSequence.Valid
	reviewComplete := reviewDraftID.Valid && triggerCycleID.Valid && triggerCycleSequence.Valid
	switch result.View.Status {
	case goal.StatusActiveCycle:
		if !activeComplete || hasReview {
			return goalViewRow{}, fmt.Errorf("%w: active Goal current work invalid", workspace.ErrGoalPersistenceInvariant)
		}
		result.View.CurrentWork = &workspace.CurrentWorkView{
			Kind:                "active_cycle",
			CycleID:             uuidString(activeCycleID),
			CycleSequenceNumber: activeCycleSequence.Int32,
		}
	case goal.StatusGoalReview:
		if hasActive || !reviewComplete {
			return goalViewRow{}, fmt.Errorf("%w: review Goal current work invalid", workspace.ErrGoalPersistenceInvariant)
		}
		result.View.CurrentWork = &workspace.CurrentWorkView{
			Kind:                       "goal_review",
			ReviewDraftID:              uuidString(reviewDraftID),
			TriggerCycleID:             uuidString(triggerCycleID),
			TriggerCycleSequenceNumber: triggerCycleSequence.Int32,
		}
	case goal.StatusAchieved, goal.StatusEnded:
		if hasActive || hasReview {
			return goalViewRow{}, fmt.Errorf("%w: terminal Goal current work exists", workspace.ErrGoalPersistenceInvariant)
		}
	default:
		return goalViewRow{}, fmt.Errorf("%w: invalid Goal status", workspace.ErrGoalPersistenceInvariant)
	}
	return result, nil
}

func getGoalView(ctx context.Context, query rowQuerier, userID, goalID string) (workspace.GoalView, error) {
	result, err := scanGoalView(query.QueryRow(ctx, goalViewQuery+`
WHERE g.id=$1 AND g.user_id=$2`, mustUUID(goalID), mustUUID(userID)))
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalView{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.GoalView{}, err
	}
	return result.View, nil
}

func getCycleView(ctx context.Context, query rowQuerier, userID, goalID, cycleID string) (workspace.CycleView, error) {
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
