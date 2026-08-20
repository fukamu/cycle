package postgres

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
	"github.com/matoruru/PDCAI/backend/internal/domain/goal"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

type WorkspaceStoreSettings struct {
	CursorSigningKey      []byte
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
JOIN goal_versions gv ON gv.goal_id=g.id AND gv.version_number=g.current_version_number
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
ORDER BY g.updated_at DESC,g.id DESC`, mustUUID(userID))
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

func (store *WorkspaceStore) CreateDraft(ctx context.Context, userID, draftID, body string, now time.Time) (workspace.DraftView, error) {
	normalized, err := goal.NormalizeText(body, true)
	if err != nil {
		return workspace.DraftView{}, err
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return workspace.DraftView{}, err
	}
	defer rollback(ctx, tx)
	if err = lockUser(ctx, tx, user.ID(userID)); err != nil {
		return workspace.DraftView{}, workspace.ErrNotFound
	}
	var existing string
	err = tx.QueryRow(ctx, `SELECT id FROM goal_drafts WHERE user_id=$1 AND draft_type='creation'`, mustUUID(userID)).Scan(&existing)
	if err == nil {
		return workspace.DraftView{}, &workspace.DraftAlreadyExistsError{DraftID: existing}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return workspace.DraftView{}, err
	}
	view := workspace.DraftView{ID: draftID, DraftType: string(goal.DraftCreation), Body: normalized, UpdatedAt: now}
	_, err = tx.Exec(ctx, `INSERT INTO goal_drafts
(id,user_id,draft_type,body,revision,created_at,updated_at)
VALUES($1,$2,'creation',$3,0,$4,$4)`, mustUUID(draftID), mustUUID(userID), normalized, now)
	if err != nil {
		if isUniqueViolation(err) {
			return workspace.DraftView{}, workspace.ErrDraftAlreadyExists
		}
		return workspace.DraftView{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.DraftView{}, err
	}
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

func (store *WorkspaceStore) SaveDraft(ctx context.Context, userID, draftID, body string, expectedRevision int64, now time.Time) (workspace.DraftView, error) {
	return store.saveDraft(ctx, userID, draftID, "creation", body, expectedRevision, now, workspace.ErrDraftRevisionConflict)
}

func (store *WorkspaceStore) SaveReview(ctx context.Context, userID, goalID, body string, expectedRevision int64, now time.Time) (workspace.DraftView, error) {
	view, err := store.GetGoal(ctx, userID, goalID)
	if err != nil {
		return workspace.DraftView{}, err
	}
	if view.Status != goal.StatusGoalReview {
		return workspace.DraftView{}, workspace.ErrGoalReviewNotActive
	}
	var draftID string
	err = store.pool.QueryRow(ctx, `SELECT id FROM goal_drafts WHERE user_id=$1 AND goal_id=$2 AND draft_type='review'`, mustUUID(userID), mustUUID(goalID)).Scan(&draftID)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.DraftView{}, workspace.ErrGoalReviewInvariant
	}
	if err != nil {
		return workspace.DraftView{}, err
	}
	return store.saveDraft(ctx, userID, draftID, "review", body, expectedRevision, now, workspace.ErrReviewRevisionConflict)
}

func (store *WorkspaceStore) saveDraft(ctx context.Context, userID, draftID, draftType, body string, expectedRevision int64, now time.Time, conflict error) (workspace.DraftView, error) {
	normalized, err := goal.NormalizeText(body, true)
	if err != nil {
		return workspace.DraftView{}, err
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return workspace.DraftView{}, err
	}
	defer rollback(ctx, tx)
	current, err := scanDraft(tx.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE id=$1 AND user_id=$2 AND draft_type=$3 FOR UPDATE`, mustUUID(draftID), mustUUID(userID), draftType))
	if err != nil {
		return workspace.DraftView{}, err
	}
	if current.Revision != expectedRevision {
		return workspace.DraftView{}, conflict
	}
	if current.Body != normalized {
		current.Body = normalized
		current.Revision++
		current.UpdatedAt = now
		_, err = tx.Exec(ctx, `UPDATE goal_drafts SET body=$2,revision=$3,updated_at=$4 WHERE id=$1`, mustUUID(draftID), normalized, current.Revision, now)
		if err != nil {
			return workspace.DraftView{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.DraftView{}, err
	}
	return current, nil
}

func (store *WorkspaceStore) AbandonDraft(ctx context.Context, userID, draftID string, now time.Time) (err error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	var running bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations
WHERE user_id=$1 AND source_goal_draft_id=$2 AND status='running')`, mustUUID(userID), mustUUID(draftID)).Scan(&running)
	if err != nil {
		return err
	}
	if running {
		return workspace.ErrAIInProgress
	}
	_, err = tx.Exec(ctx, `UPDATE ai_usage_events SET goal_id=NULL,content_deleted=true
WHERE operation_id IN (SELECT id FROM ai_generations WHERE user_id=$1 AND source_goal_draft_id=$2)`, mustUUID(userID), mustUUID(draftID))
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM ai_generations WHERE user_id=$1 AND source_goal_draft_id=$2`, mustUUID(userID), mustUUID(draftID)); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `DELETE FROM goal_drafts WHERE id=$1 AND user_id=$2 AND draft_type='creation'`, mustUUID(draftID), mustUUID(userID))
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return workspace.ErrNotFound
	}
	return tx.Commit(ctx)
}

func (store *WorkspaceStore) ListGoals(ctx context.Context, userID, scope, encodedCursor string, limit int) (workspace.GoalPage, error) {
	if scope == "" {
		scope = "all"
	}
	if scope != "all" && scope != "progressing" && scope != "history" {
		return workspace.GoalPage{}, workspace.ErrInvalidCursor
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	cursor, err := store.decodeCursor(encodedCursor, scope)
	if err != nil {
		return workspace.GoalPage{}, err
	}
	var cursorCategory any
	if cursor.Category != nil {
		cursorCategory = *cursor.Category
	}
	var cursorID any
	if cursor.ID != "" {
		cursorID = cursor.ID
	}
	rows, err := store.pool.Query(ctx, goalViewQuery+`
WHERE g.user_id=$1
AND ($2='all' OR ($2='progressing' AND g.status IN ('active_cycle','goal_review')) OR ($2='history' AND g.status IN ('achieved','ended')))
AND ($3::smallint IS NULL
  OR CASE WHEN g.status IN ('active_cycle','goal_review') THEN 0 ELSE 1 END > $3
  OR (CASE WHEN g.status IN ('active_cycle','goal_review') THEN 0 ELSE 1 END = $3
    AND (CASE WHEN g.status IN ('active_cycle','goal_review') THEN g.updated_at ELSE g.terminal_at END,g.id)<($4,$5::uuid)))
ORDER BY category ASC,sort_time DESC,g.id DESC LIMIT $6`, mustUUID(userID), scope, cursorCategory, cursor.Time, cursorID, limit+1)
	if err != nil {
		return workspace.GoalPage{}, err
	}
	var found []goalViewRow
	for rows.Next() {
		item, scanErr := scanGoalView(rows)
		if scanErr != nil {
			rows.Close()
			return workspace.GoalPage{}, scanErr
		}
		found = append(found, item)
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return workspace.GoalPage{}, rowErr
	}
	page := workspace.GoalPage{Items: []workspace.GoalView{}}
	if len(found) > limit {
		last := found[limit-1]
		next := store.encodeCursor(cursorPayload{Scope: scope, Category: &last.Category, Time: &last.SortTime, ID: last.View.ID})
		page.NextCursor = &next
		found = found[:limit]
	}
	for _, item := range found {
		page.Items = append(page.Items, item.View)
	}
	return page, nil
}

func (store *WorkspaceStore) GetGoal(ctx context.Context, userID, goalID string) (workspace.GoalView, error) {
	return getGoalView(ctx, store.pool, userID, goalID)
}

func (store *WorkspaceStore) GetReview(ctx context.Context, userID, goalID string) (workspace.ReviewView, error) {
	view, err := store.GetGoal(ctx, userID, goalID)
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
		if errors.Is(err, workspace.ErrNotFound) {
			return workspace.ReviewView{}, workspace.ErrGoalReviewInvariant
		}
		return workspace.ReviewView{}, err
	}
	return workspace.ReviewView{Goal: view, ReviewDraft: draft, TriggerCycle: trigger}, nil
}

func (store *WorkspaceStore) ListCycles(ctx context.Context, userID, goalID, encodedCursor string, limit int) (workspace.CyclePage, error) {
	var goalExists bool
	if err := store.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM goals WHERE id=$1 AND user_id=$2)`, mustUUID(goalID), mustUUID(userID)).Scan(&goalExists); err != nil {
		return workspace.CyclePage{}, err
	}
	if !goalExists {
		return workspace.CyclePage{}, workspace.ErrNotFound
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	cursor, err := store.decodeCursor(encodedCursor, "cycles:"+goalID)
	if err != nil {
		return workspace.CyclePage{}, err
	}
	sequence := int32(0)
	if cursor.Sequence != nil {
		sequence = *cursor.Sequence
	}
	var cursorID any
	if cursor.ID != "" {
		cursorID = cursor.ID
	}
	rows, err := store.pool.Query(ctx, `SELECT c.id,c.sequence_number,c.status,c.started_at,c.completed_at,c.canceled_at,
gv.id,gv.version_number,gv.body,gv.created_at,
CASE WHEN char_length(c.plan)>120 THEN left(c.plan,120)||'…' ELSE c.plan END
FROM pdca_cycles c
JOIN goal_versions gv ON gv.id=c.goal_version_id AND gv.goal_id=c.goal_id
WHERE c.user_id=$1 AND c.goal_id=$2
AND ($3::integer=0 OR (c.sequence_number,c.id)<($3,$4::uuid))
ORDER BY c.sequence_number DESC,c.id DESC LIMIT $5`, mustUUID(userID), mustUUID(goalID), sequence, cursorID, limit+1)
	if err != nil {
		return workspace.CyclePage{}, err
	}
	var found []workspace.CycleSummary
	for rows.Next() {
		var item workspace.CycleSummary
		if err = rows.Scan(
			&item.ID, &item.SequenceNumber, &item.Status, &item.StartedAt, &item.CompletedAt, &item.CanceledAt,
			&item.GoalVersion.ID, &item.GoalVersion.VersionNumber, &item.GoalVersion.Body, &item.GoalVersion.CreatedAt,
			&item.PlanPreview,
		); err != nil {
			rows.Close()
			return workspace.CyclePage{}, err
		}
		found = append(found, item)
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return workspace.CyclePage{}, rowErr
	}
	page := workspace.CyclePage{Items: []workspace.CycleSummary{}}
	if len(found) > limit {
		last := found[limit-1]
		next := store.encodeCursor(cursorPayload{Scope: "cycles:" + goalID, Sequence: &last.SequenceNumber, ID: last.ID})
		page.NextCursor = &next
		found = found[:limit]
	}
	page.Items = append(page.Items, found...)
	return page, nil
}

func (store *WorkspaceStore) GetCycle(ctx context.Context, userID, goalID, cycleID string) (workspace.CycleView, error) {
	return getCycleView(ctx, store.pool, userID, goalID, cycleID)
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
	var activeCycleID, reviewDraftID, triggerCycleID pgtype.UUID
	var activeCycleSequence, triggerCycleSequence pgtype.Int4
	err := scanner.Scan(
		&result.View.ID, &result.View.Status, &result.View.Revision, &result.View.NextCycleSequenceNumber,
		&result.View.CreatedAt, &result.View.TerminalAt,
		&result.View.CurrentVersion.ID, &result.View.CurrentVersion.VersionNumber, &result.View.CurrentVersion.Body,
		&result.View.CurrentVersion.CreatedAt, &result.View.CycleCount,
		&activeCycleID, &activeCycleSequence,
		&reviewDraftID, &triggerCycleID, &triggerCycleSequence,
		&result.Category, &result.SortTime,
	)
	if err != nil {
		return goalViewRow{}, err
	}
	switch result.View.Status {
	case goal.StatusActiveCycle:
		if !activeCycleID.Valid || !activeCycleSequence.Valid {
			return goalViewRow{}, fmt.Errorf("active goal invariant: current cycle missing")
		}
		result.View.CurrentWork = &workspace.CurrentWorkView{
			Kind:                "active_cycle",
			CycleID:             uuidString(activeCycleID),
			CycleSequenceNumber: activeCycleSequence.Int32,
		}
	case goal.StatusGoalReview:
		if !reviewDraftID.Valid || !triggerCycleID.Valid || !triggerCycleSequence.Valid {
			return goalViewRow{}, fmt.Errorf("review goal invariant: current review missing")
		}
		result.View.CurrentWork = &workspace.CurrentWorkView{
			Kind:                       "goal_review",
			ReviewDraftID:              uuidString(reviewDraftID),
			TriggerCycleID:             uuidString(triggerCycleID),
			TriggerCycleSequenceNumber: triggerCycleSequence.Int32,
		}
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
	var view workspace.CycleView
	err := query.QueryRow(ctx, `SELECT c.id,c.goal_id,c.sequence_number,c.status,c.started_at,c.completed_at,c.canceled_at,c.cancellation_reason,
c.plan,c.do_text,c.check_text,c.action,c.content_revision,c.plan_revision,c.do_revision,c.check_revision,c.action_revision,
gv.id,gv.version_number,gv.body,gv.created_at
FROM pdca_cycles c
JOIN goals g ON g.id=c.goal_id AND g.user_id=c.user_id
JOIN goal_versions gv ON gv.id=c.goal_version_id AND gv.goal_id=c.goal_id
WHERE c.id=$1 AND c.goal_id=$2 AND c.user_id=$3`, mustUUID(cycleID), mustUUID(goalID), mustUUID(userID)).Scan(
		&view.ID, &view.GoalID, &view.SequenceNumber, &view.Status, &view.StartedAt, &view.CompletedAt, &view.CanceledAt, &view.CancellationReason,
		&view.Plan, &view.Do, &view.Check, &view.Action, &view.ContentRevision,
		&view.FrameRevisions.Plan, &view.FrameRevisions.Do, &view.FrameRevisions.Check, &view.FrameRevisions.Action,
		&view.GoalVersion.ID, &view.GoalVersion.VersionNumber, &view.GoalVersion.Body, &view.GoalVersion.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.CycleView{}, workspace.ErrNotFound
	}
	return view, err
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

type cursorPayload struct {
	Scope    string     `json:"scope"`
	Category *int16     `json:"category,omitempty"`
	Time     *time.Time `json:"time,omitempty"`
	Sequence *int32     `json:"sequence,omitempty"`
	ID       string     `json:"id,omitempty"`
}

func (store *WorkspaceStore) encodeCursor(payload cursorPayload) string {
	body, _ := json.Marshal(payload)
	mac := hmac.New(sha256.New, store.settings.CursorSigningKey)
	_, _ = mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(append(body, mac.Sum(nil)...))
}

func (store *WorkspaceStore) decodeCursor(encoded, scope string) (cursorPayload, error) {
	if strings.TrimSpace(encoded) == "" {
		return cursorPayload{Scope: scope}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) <= sha256.Size {
		return cursorPayload{}, workspace.ErrInvalidCursor
	}
	body, signature := raw[:len(raw)-sha256.Size], raw[len(raw)-sha256.Size:]
	mac := hmac.New(sha256.New, store.settings.CursorSigningKey)
	_, _ = mac.Write(body)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return cursorPayload{}, workspace.ErrInvalidCursor
	}
	var payload cursorPayload
	if json.Unmarshal(body, &payload) != nil || payload.Scope != scope {
		return cursorPayload{}, workspace.ErrInvalidCursor
	}
	return payload, nil
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
