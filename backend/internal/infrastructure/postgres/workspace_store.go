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

func NewWorkspaceStore(pool *pgxpool.Pool, settings WorkspaceStoreSettings) *WorkspaceStore {
	return &WorkspaceStore{pool: pool, settings: settings}
}

func (store *WorkspaceStore) Home(ctx context.Context, userID string, limit int) (workspace.HomeView, error) {
	view := workspace.HomeView{ProgressingGoals: []workspace.GoalView{}, ProgressingGoalLimit: limit}
	rows, err := store.pool.Query(ctx, `SELECT g.id FROM goals g
WHERE g.user_id=$1 AND g.status IN ('active_cycle','goal_review')
ORDER BY g.updated_at DESC,g.id DESC`, mustUUID(userID))
	if err != nil {
		return view, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return view, err
		}
		ids = append(ids, id)
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return view, rowErr
	}
	for _, id := range ids {
		item, getErr := store.GetGoal(ctx, userID, id)
		if getErr != nil {
			return view, getErr
		}
		view.ProgressingGoals = append(view.ProgressingGoals, item)
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
	rows, err := store.pool.Query(ctx, `SELECT id,
CASE WHEN status IN ('active_cycle','goal_review') THEN 0 ELSE 1 END AS category,
CASE WHEN status IN ('active_cycle','goal_review') THEN updated_at ELSE terminal_at END AS sort_time
FROM goals
WHERE user_id=$1
AND ($2='all' OR ($2='progressing' AND status IN ('active_cycle','goal_review')) OR ($2='history' AND status IN ('achieved','ended')))
AND ($3::smallint IS NULL
  OR CASE WHEN status IN ('active_cycle','goal_review') THEN 0 ELSE 1 END > $3
  OR (CASE WHEN status IN ('active_cycle','goal_review') THEN 0 ELSE 1 END = $3
    AND (CASE WHEN status IN ('active_cycle','goal_review') THEN updated_at ELSE terminal_at END,id)<($4,$5::uuid)))
ORDER BY category ASC,sort_time DESC,id DESC LIMIT $6`, mustUUID(userID), scope, cursorCategory, cursor.Time, cursorID, limit+1)
	if err != nil {
		return workspace.GoalPage{}, err
	}
	type row struct {
		id       string
		category int16
		at       time.Time
	}
	var found []row
	for rows.Next() {
		var item row
		if err = rows.Scan(&item.id, &item.category, &item.at); err != nil {
			rows.Close()
			return workspace.GoalPage{}, err
		}
		found = append(found, item)
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return workspace.GoalPage{}, rowErr
	}
	page := workspace.GoalPage{Items: []workspace.GoalView{}}
	for index, item := range found {
		if index == limit {
			last := found[index-1]
			next := store.encodeCursor(cursorPayload{Scope: scope, Category: &last.category, Time: &last.at, ID: last.id})
			page.NextCursor = &next
			break
		}
		view, getErr := store.GetGoal(ctx, userID, item.id)
		if getErr != nil {
			return page, getErr
		}
		page.Items = append(page.Items, view)
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
	if _, err := store.GetGoal(ctx, userID, goalID); err != nil {
		return workspace.CyclePage{}, err
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
	rows, err := store.pool.Query(ctx, `SELECT c.id FROM pdca_cycles c
WHERE c.user_id=$1 AND c.goal_id=$2
AND ($3::integer=0 OR (c.sequence_number,c.id)<($3,$4::uuid))
ORDER BY c.sequence_number DESC,c.id DESC LIMIT $5`, mustUUID(userID), mustUUID(goalID), sequence, cursorID, limit+1)
	if err != nil {
		return workspace.CyclePage{}, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return workspace.CyclePage{}, err
		}
		ids = append(ids, id)
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return workspace.CyclePage{}, rowErr
	}
	page := workspace.CyclePage{Items: []workspace.CycleSummary{}}
	for index, id := range ids {
		if index == limit {
			last := page.Items[len(page.Items)-1]
			next := store.encodeCursor(cursorPayload{Scope: "cycles:" + goalID, Sequence: &last.SequenceNumber, ID: last.ID})
			page.NextCursor = &next
			break
		}
		item, getErr := store.GetCycle(ctx, userID, goalID, id)
		if getErr != nil {
			return page, getErr
		}
		preview := []rune(item.Plan)
		if len(preview) > 120 {
			preview = append(preview[:120], []rune("…")...)
		}
		page.Items = append(page.Items, workspace.CycleSummary{
			ID: item.ID, SequenceNumber: item.SequenceNumber, Status: item.Status,
			StartedAt: item.StartedAt, CompletedAt: item.CompletedAt, CanceledAt: item.CanceledAt,
			GoalVersion: item.GoalVersion, PlanPreview: string(preview),
		})
	}
	return page, nil
}

func (store *WorkspaceStore) GetCycle(ctx context.Context, userID, goalID, cycleID string) (workspace.CycleView, error) {
	return getCycleView(ctx, store.pool, userID, goalID, cycleID)
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func getGoalView(ctx context.Context, query rowQuerier, userID, goalID string) (workspace.GoalView, error) {
	var view workspace.GoalView
	err := query.QueryRow(ctx, `SELECT g.id,g.status,g.revision,g.next_cycle_sequence_number,g.created_at,g.terminal_at,
gv.id,gv.version_number,gv.body,gv.created_at,
(SELECT count(*) FROM pdca_cycles c WHERE c.goal_id=g.id)::integer
FROM goals g JOIN goal_versions gv ON gv.goal_id=g.id AND gv.version_number=g.current_version_number
WHERE g.id=$1 AND g.user_id=$2`, mustUUID(goalID), mustUUID(userID)).Scan(
		&view.ID, &view.Status, &view.Revision, &view.NextCycleSequenceNumber, &view.CreatedAt, &view.TerminalAt,
		&view.CurrentVersion.ID, &view.CurrentVersion.VersionNumber, &view.CurrentVersion.Body, &view.CurrentVersion.CreatedAt,
		&view.CycleCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalView{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.GoalView{}, err
	}
	switch view.Status {
	case goal.StatusActiveCycle:
		work := workspace.CurrentWorkView{Kind: "active_cycle"}
		err = query.QueryRow(ctx, `SELECT id,sequence_number FROM pdca_cycles
WHERE user_id=$1 AND goal_id=$2 AND status='active'`, mustUUID(userID), mustUUID(goalID)).Scan(&work.CycleID, &work.CycleSequenceNumber)
		if err != nil {
			return workspace.GoalView{}, fmt.Errorf("active goal invariant: %w", err)
		}
		view.CurrentWork = &work
	case goal.StatusGoalReview:
		work := workspace.CurrentWorkView{Kind: "goal_review"}
		err = query.QueryRow(ctx, `SELECT d.id,c.id,c.sequence_number FROM goal_drafts d
JOIN pdca_cycles c ON c.id=d.review_cycle_id AND c.goal_id=d.goal_id
WHERE d.user_id=$1 AND d.goal_id=$2 AND d.draft_type='review'`, mustUUID(userID), mustUUID(goalID)).Scan(
			&work.ReviewDraftID, &work.TriggerCycleID, &work.TriggerCycleSequenceNumber)
		if err != nil {
			return workspace.GoalView{}, fmt.Errorf("review goal invariant: %w", err)
		}
		view.CurrentWork = &work
	}
	return view, nil
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
