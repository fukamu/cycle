package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type workspaceGoalDraftTx struct {
	tx pgx.Tx
}

var (
	_ workspace.GoalDraftUnitOfWork = (*WorkspaceStore)(nil)
	_ workspace.GoalDraftTx         = (*workspaceGoalDraftTx)(nil)
)

func (store *WorkspaceStore) WithinGoalDraftTransaction(
	ctx context.Context,
	callback func(workspace.GoalDraftTx) error,
) error {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	if err = callback(&workspaceGoalDraftTx{tx: tx}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (transaction *workspaceGoalDraftTx) LockUser(ctx context.Context, userID string) error {
	err := lockUser(ctx, transaction.tx, user.ID(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.ErrNotFound
	}
	return err
}

func (transaction *workspaceGoalDraftTx) FindCreationDraft(ctx context.Context, userID string) (*goal.Draft, error) {
	draft, err := scanGoalDraft(transaction.tx.QueryRow(ctx, `SELECT id,user_id,draft_type,goal_id,base_goal_version_id,
review_cycle_id,body,revision,created_at,updated_at
FROM goal_drafts WHERE user_id=$1 AND draft_type='creation'`, mustUUID(userID)))
	if errors.Is(err, workspace.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &draft, nil
}

func (transaction *workspaceGoalDraftTx) LockDraftByID(
	ctx context.Context,
	userID string,
	draftID string,
) (goal.Draft, error) {
	return scanGoalDraft(transaction.tx.QueryRow(ctx, `SELECT id,user_id,draft_type,goal_id,base_goal_version_id,
review_cycle_id,body,revision,created_at,updated_at
FROM goal_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(draftID), mustUUID(userID)))
}

func (transaction *workspaceGoalDraftTx) LockReviewDraftByGoal(
	ctx context.Context,
	userID string,
	goalID string,
) (goal.Draft, error) {
	return scanGoalDraft(transaction.tx.QueryRow(ctx, `SELECT id,user_id,draft_type,goal_id,base_goal_version_id,
review_cycle_id,body,revision,created_at,updated_at
FROM goal_drafts WHERE goal_id=$1 AND user_id=$2 AND draft_type='review' FOR UPDATE`, mustUUID(goalID), mustUUID(userID)))
}

func (transaction *workspaceGoalDraftTx) InsertCreationDraft(ctx context.Context, draft goal.Draft) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `INSERT INTO goal_drafts
(id,user_id,draft_type,body,revision,created_at,updated_at)
VALUES($1,$2,'creation',$3,$4,$5,$6)`, mustUUID(draft.ID), mustUUID(draft.UserID), draft.Body, draft.Revision,
		draft.CreatedAt, draft.UpdatedAt)
	if isUniqueViolation(err) {
		return 0, workspace.ErrDraftAlreadyExists
	}
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) SaveDraftCAS(
	ctx context.Context,
	draft goal.Draft,
	expectedRevision int64,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE goal_drafts SET body=$4,revision=$5,updated_at=$6
WHERE id=$1 AND user_id=$2 AND draft_type=$3 AND revision=$7`, mustUUID(draft.ID), mustUUID(draft.UserID),
		string(draft.Type), draft.Body, draft.Revision, draft.UpdatedAt, expectedRevision)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) DeleteCreationDraftCAS(
	ctx context.Context,
	userID string,
	draftID string,
	expectedRevision int64,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `DELETE FROM goal_drafts
WHERE id=$1 AND user_id=$2 AND draft_type='creation' AND revision=$3`, mustUUID(draftID), mustUUID(userID), expectedRevision)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) LockDraftGenerations(
	ctx context.Context,
	userID string,
	draftID string,
) ([]workspace.DraftGenerationState, error) {
	rows, err := transaction.tx.Query(ctx, `SELECT id,status FROM ai_generations
WHERE user_id=$1 AND source_goal_draft_id=$2 ORDER BY id FOR UPDATE`, mustUUID(userID), mustUUID(draftID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []workspace.DraftGenerationState{}
	for rows.Next() {
		var item workspace.DraftGenerationState
		if err = rows.Scan(&item.ID, &item.Status); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (transaction *workspaceGoalDraftTx) LockDraftUsages(
	ctx context.Context,
	userID string,
	operationIDs []string,
) ([]workspace.DraftUsageState, error) {
	if len(operationIDs) == 0 {
		return []workspace.DraftUsageState{}, nil
	}
	rows, err := transaction.tx.Query(ctx, `SELECT operation_id,quota_retain_until,provider_usage_finalized_at
FROM ai_usage_events WHERE user_id=$1 AND operation_id=ANY($2::text[]::uuid[])
ORDER BY operation_id FOR UPDATE`, mustUUID(userID), operationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []workspace.DraftUsageState{}
	for rows.Next() {
		var item workspace.DraftUsageState
		if err = rows.Scan(&item.OperationID, &item.QuotaRetainUntil, &item.ProviderUsageFinalizedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (transaction *workspaceGoalDraftTx) RedactDraftUsagesCAS(
	ctx context.Context,
	userID string,
	operationIDs []string,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_usage_events SET goal_id=NULL,content_deleted=true
WHERE user_id=$1 AND operation_id=ANY($2::text[]::uuid[])`, mustUUID(userID), operationIDs)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) DeleteExpiredFinalizedDraftUsagesCAS(
	ctx context.Context,
	userID string,
	operationIDs []string,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `DELETE FROM ai_usage_events
WHERE user_id=$1 AND operation_id=ANY($2::text[]::uuid[])
  AND quota_retain_until<=$3 AND provider_usage_finalized_at IS NOT NULL`, mustUUID(userID), operationIDs, now)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) DeleteDraftGenerationsCAS(
	ctx context.Context,
	userID string,
	draftID string,
	generationIDs []string,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `DELETE FROM ai_generations
WHERE user_id=$1 AND source_goal_draft_id=$2 AND id=ANY($3::text[]::uuid[]) AND status<>'running'`,
		mustUUID(userID), mustUUID(draftID), generationIDs)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) FindStartReplay(
	ctx context.Context,
	userID string,
	operationID string,
) (*workspace.StartReplayState, error) {
	var state workspace.StartReplayState
	err := transaction.tx.QueryRow(ctx, `SELECT goal_id,id,start_request_hash FROM pdca_cycles
WHERE user_id=$1 AND start_operation_id=$2`, mustUUID(userID), mustUUID(operationID)).Scan(
		&state.GoalID, &state.CycleID, &state.RequestHash,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &state, nil
}

func (transaction *workspaceGoalDraftTx) CountProgressingGoals(ctx context.Context, userID string) (int, error) {
	var count int
	err := transaction.tx.QueryRow(ctx, `SELECT count(*) FROM goals
WHERE user_id=$1 AND status IN ('active_cycle','goal_review')`, mustUUID(userID)).Scan(&count)
	return count, err
}

func (transaction *workspaceGoalDraftTx) InsertInitialGoal(ctx context.Context, current goal.Goal) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,revision,created_at,updated_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, mustUUID(current.ID), mustUUID(current.UserID), current.Status,
		current.CurrentVersionNumber, current.NextCycleSequenceNumber, current.Revision, current.CreatedAt, current.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) InsertInitialVersion(ctx context.Context, version goal.Version) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,$4,$5,$6,$7)`, mustUUID(version.ID), mustUUID(version.UserID), mustUUID(version.GoalID),
		version.VersionNumber, version.Body, mustUUID(version.CreatedByOperationID), version.CreatedAt)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) InsertInitialCycle(ctx context.Context, current cycle.PDCACycle) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, mustUUID(current.ID), mustUUID(current.UserID), mustUUID(current.GoalID),
		mustUUID(current.GoalVersionID), current.SequenceNumber, current.Status, current.StartedAt, mustUUID(current.StartOperationID),
		current.StartRequestHash, current.CreatedAt, current.UpdatedAt)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) AttachDraftGenerations(
	ctx context.Context,
	userID string,
	draftID string,
	generationIDs []string,
	goalID string,
	versionID string,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_generations
SET source_goal_draft_id=NULL,goal_id=$4,goal_version_id=$5
WHERE user_id=$1 AND source_goal_draft_id=$2 AND id=ANY($3::text[]::uuid[])`, mustUUID(userID), mustUUID(draftID),
		generationIDs, mustUUID(goalID), mustUUID(versionID))
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) AttachUsageToGoal(
	ctx context.Context,
	userID string,
	generationIDs []string,
	goalID string,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_usage_events SET goal_id=$3
WHERE user_id=$1 AND operation_id=ANY($2::text[]::uuid[])`, mustUUID(userID), generationIDs, mustUUID(goalID))
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) LoadGoalView(ctx context.Context, userID, goalID string) (workspace.GoalView, error) {
	return getGoalView(ctx, transaction.tx, userID, goalID)
}

func (transaction *workspaceGoalDraftTx) LoadCycleView(
	ctx context.Context,
	userID string,
	goalID string,
	cycleID string,
) (workspace.CycleView, error) {
	return getCycleView(ctx, transaction.tx, userID, goalID, cycleID)
}

func (transaction *workspaceGoalDraftTx) LockGoalWithCurrentVersion(
	ctx context.Context,
	userID string,
	goalID string,
) (workspace.GoalTargetState, error) {
	var state workspace.GoalTargetState
	err := transaction.tx.QueryRow(ctx, `SELECT g.status,g.revision,gv.id,gv.body FROM goals g
JOIN goal_versions gv ON gv.goal_id=g.id AND gv.version_number=g.current_version_number
WHERE g.id=$1 AND g.user_id=$2 FOR UPDATE OF g`, mustUUID(goalID), mustUUID(userID)).Scan(
		&state.Status, &state.Revision, &state.CurrentVersionID, &state.Body,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalTargetState{}, workspace.ErrNotFound
	}
	return state, err
}

func (transaction *workspaceGoalDraftTx) FindGoalRefineReplay(
	ctx context.Context,
	userID string,
	idempotencyKey string,
) (*workspace.GoalRefineReplayState, error) {
	var state workspace.GoalRefineReplayState
	err := transaction.tx.QueryRow(ctx, `SELECT id,input_hash,status,target_revision,output,
COALESCE(failure_code,''),context_changed FROM ai_generations
WHERE user_id=$1 AND operation_type='goal_refine' AND idempotency_key=$2`,
		mustUUID(userID), mustUUID(idempotencyKey)).Scan(&state.GenerationID, &state.InputHash, &state.Status,
		&state.TargetRevision, &state.Output, &state.FailureCode, &state.ContextChanged)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &state, nil
}

func (transaction *workspaceGoalDraftTx) ListAIContextCycles(
	ctx context.Context,
	userID string,
	goalID string,
	excludeCycleID string,
	limit int,
) ([]workspace.AIContextCycle, error) {
	rows, err := transaction.tx.Query(ctx, `SELECT c.id,c.goal_id,c.sequence_number,c.status,gv.body,
c.plan,c.do_text,c.check_text,c.action FROM pdca_cycles c
JOIN goal_versions gv ON gv.goal_id=c.goal_id AND gv.id=c.goal_version_id
WHERE c.user_id=$1 AND c.goal_id=$2 AND c.status IN ('completed','canceled')
  AND ($3::uuid IS NULL OR c.id<>$3)
ORDER BY c.sequence_number DESC LIMIT $4`, mustUUID(userID), mustUUID(goalID), nullableUUID(excludeCycleID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []workspace.AIContextCycle{}
	for rows.Next() {
		var item workspace.AIContextCycle
		if err = rows.Scan(&item.ID, &item.GoalID, &item.SequenceNumber, &item.Status, &item.GoalBody,
			&item.Plan, &item.Do, &item.Check, &item.Action); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (transaction *workspaceGoalDraftTx) LockExpiredGenerations(
	ctx context.Context,
	userID string,
	now time.Time,
) ([]workspace.ExpiredGeneration, error) {
	rows, err := transaction.tx.Query(ctx, `SELECT id,budget_month_utc,budget_reserved_cost_usd::text FROM ai_generations
WHERE user_id=$1 AND status='running' AND lease_expires_at<=$2 ORDER BY id FOR UPDATE`, mustUUID(userID), now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []workspace.ExpiredGeneration{}
	for rows.Next() {
		var item workspace.ExpiredGeneration
		if err = rows.Scan(&item.ID, &item.BudgetMonthUtc, &item.ReservedCostUSD); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (transaction *workspaceGoalDraftTx) SumLockedReservationsByMonth(
	ctx context.Context,
	generationIDs []string,
) ([]workspace.MonthlyReservation, error) {
	if len(generationIDs) == 0 {
		return []workspace.MonthlyReservation{}, nil
	}
	rows, err := transaction.tx.Query(ctx, `SELECT budget_month_utc,SUM(budget_reserved_cost_usd)::text
FROM ai_generations WHERE id=ANY($1::text[]::uuid[]) AND status='running'
GROUP BY budget_month_utc HAVING SUM(budget_reserved_cost_usd)>0 ORDER BY budget_month_utc`, generationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []workspace.MonthlyReservation{}
	for rows.Next() {
		var item workspace.MonthlyReservation
		if err = rows.Scan(&item.MonthUtc, &item.AmountUSD); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (transaction *workspaceGoalDraftTx) ReleaseBudgetReservationCAS(
	ctx context.Context,
	month time.Time,
	amountUSD string,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd-$2::numeric,updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2::numeric`, month, amountUSD, now)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) ExpireGenerationCAS(
	ctx context.Context,
	generationID string,
	reservedCostUSD string,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_generations SET status='failed',failure_code='lease_expired',
budget_reserved_cost_usd=0,lease_expires_at=NULL,finished_at=$2
WHERE id=$1 AND status='running' AND budget_reserved_cost_usd=$3::numeric`, mustUUID(generationID), now, reservedCostUSD)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) ExpireUsageCAS(
	ctx context.Context,
	generationID string,
	budgetMonth time.Time,
	reservationCostUSD string,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_usage_events SET status='failed'
WHERE operation_id=$1 AND status='accepted' AND provider_usage_finalized_at IS NULL
  AND settlement_budget_month_utc=$2 AND settlement_reservation_cost_usd=$3::numeric`,
		mustUUID(generationID), budgetMonth, reservationCostUSD)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) HasRunningDraftGeneration(ctx context.Context, draftID string) (bool, error) {
	var running bool
	err := transaction.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations
WHERE source_goal_draft_id=$1 AND status='running')`, mustUUID(draftID)).Scan(&running)
	return running, err
}

func (transaction *workspaceGoalDraftTx) CountRollingUsage(
	ctx context.Context,
	userID string,
	acceptedAfter time.Time,
) (int, error) {
	var count int
	err := transaction.tx.QueryRow(ctx, `SELECT count(*) FROM ai_usage_events
WHERE user_id=$1 AND accepted_at>$2`, mustUUID(userID), acceptedAfter).Scan(&count)
	return count, err
}

func (transaction *workspaceGoalDraftTx) IncrementRateBucket(
	ctx context.Context,
	bucket workspace.AIRateBucket,
) (int, error) {
	var count int
	err := transaction.tx.QueryRow(ctx, `INSERT INTO abuse_rate_buckets(scope,key_hash,window_start,request_count,expires_at)
VALUES($1,$2,$3,1,$4)
ON CONFLICT(scope,key_hash,window_start) DO UPDATE
SET request_count=abuse_rate_buckets.request_count+1,expires_at=EXCLUDED.expires_at
RETURNING request_count`, bucket.Scope, bucket.KeyHash, bucket.WindowStart, bucket.ExpiresAt).Scan(&count)
	return count, err
}

func (transaction *workspaceGoalDraftTx) EnsureBudgetMonth(ctx context.Context, month time.Time, now time.Time) error {
	_, err := transaction.tx.Exec(ctx, `INSERT INTO ai_budget_monthly
(month_utc,reserved_cost_usd,actual_cost_usd,unattributed_cost_usd,updated_at)
VALUES($1,0,0,0,$2) ON CONFLICT(month_utc) DO NOTHING`, month, now)
	return err
}

func (transaction *workspaceGoalDraftTx) LockBudgetMonth(ctx context.Context, month time.Time) (workspace.AIBudgetState, error) {
	var state workspace.AIBudgetState
	err := transaction.tx.QueryRow(ctx, `SELECT reserved_cost_usd::text,actual_cost_usd::text,unattributed_cost_usd::text
FROM ai_budget_monthly WHERE month_utc=$1 FOR UPDATE`, month).Scan(
		&state.ReservedCostUSD, &state.ActualCostUSD, &state.UnattributedCostUSD,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.AIBudgetState{}, workspace.ErrNotFound
	}
	return state, err
}

func (transaction *workspaceGoalDraftTx) ReserveBudgetCAS(
	ctx context.Context,
	month time.Time,
	amountUSD string,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd+$2::numeric,updated_at=$3 WHERE month_utc=$1`, month, amountUSD, now)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) InsertGoalRefineGeneration(
	ctx context.Context,
	record workspace.GoalRefineGenerationRecord,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,goal_id,goal_version_id,target_revision,idempotency_key,input_hash,
source_text,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at,context_cycle_ids)
VALUES($1,$2,'goal_refine','running',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::numeric,$15,$16,$17::text[]::uuid[])`,
		mustUUID(record.ID), mustUUID(record.UserID), mustUUID(record.DraftID), nullableUUID(record.GoalID),
		nullableUUID(record.GoalVersionID), record.TargetRevision, mustUUID(record.IdempotencyKey), record.InputHash,
		record.SourceText, record.Provider, record.Model, record.PromptVersion, record.BudgetMonthUtc, record.ReservedCostUSD,
		record.LeaseExpiresAt, record.StartedAt, record.ContextCycleIDs)
	if isUniqueViolation(err) {
		return 0, workspace.ErrAIInProgress
	}
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) InsertAcceptedUsage(
	ctx context.Context,
	record workspace.AIUsageRecord,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until,
 settlement_budget_month_utc,settlement_reservation_cost_usd)
VALUES($1,$2,$3,$4,'accepted',$5,$6,$7,$8,$9,$10,$11::numeric)`, mustUUID(record.OperationID), mustUUID(record.UserID),
		nullableUUID(record.GoalID), record.Operation, record.Provider, record.Model, record.PromptVersion,
		record.AcceptedAt, record.QuotaRetainUntil, record.SettlementBudgetMonthUtc, record.SettlementReservationCostUSD)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) FindGenerationLocator(
	ctx context.Context,
	generationID string,
) (*workspace.AIGenerationLocator, error) {
	var state workspace.AIGenerationLocator
	var draftID, goalID, cycleID pgtype.UUID
	err := transaction.tx.QueryRow(ctx, `SELECT user_id,operation_type,status,source_goal_draft_id,goal_id,cycle_id
FROM ai_generations WHERE id=$1`, mustUUID(generationID)).Scan(
		&state.UserID, &state.Operation, &state.Status, &draftID, &goalID, &cycleID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	state.DraftID = uuidString(draftID)
	state.GoalID = uuidString(goalID)
	state.CycleID = uuidString(cycleID)
	return &state, nil
}

func (transaction *workspaceGoalDraftTx) LockGoalRefineGeneration(
	ctx context.Context,
	key workspace.GoalRefineGenerationKey,
) (workspace.GoalRefineSettlementState, error) {
	var state workspace.GoalRefineSettlementState
	err := transaction.tx.QueryRow(ctx, `SELECT budget_month_utc,budget_reserved_cost_usd::text,target_revision
FROM ai_generations WHERE id=$1 AND user_id=$2 AND operation_type='goal_refine'
  AND source_goal_draft_id=$3 AND status='running' FOR UPDATE`, mustUUID(key.GenerationID), mustUUID(key.UserID),
		mustUUID(key.DraftID)).Scan(&state.BudgetMonthUtc, &state.ReservedCostUSD, &state.TargetRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalRefineSettlementState{}, workspace.ErrNotFound
	}
	return state, err
}

func (transaction *workspaceGoalDraftTx) TerminalizeGenerationCAS(
	ctx context.Context,
	settlement workspace.AIGenerationSettlement,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_generations SET status=$2,output=$3,input_tokens=$4,output_tokens=$5,
estimated_cost_usd=$6::numeric,budget_reserved_cost_usd=0,attempt_count=$7,failure_code=NULLIF($8,''),
provider_request_id=NULLIF($9,''),lease_expires_at=NULL,context_changed=$10,finished_at=$11
WHERE id=$1 AND operation_type='goal_refine' AND status='running' AND budget_reserved_cost_usd=$12::numeric`,
		mustUUID(settlement.GenerationID), settlement.Status, settlement.Output, settlement.InputTokens, settlement.OutputTokens,
		settlement.EstimatedCostUSD, settlement.AttemptCount, settlement.FailureCode, settlement.ProviderRequestID,
		settlement.ContextChanged, settlement.FinishedAt, settlement.ExpectedReservationUSD)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) SettleBudgetCAS(
	ctx context.Context,
	month time.Time,
	reservationUSD string,
	actualUSD string,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd-$2::numeric,actual_cost_usd=actual_cost_usd+$3::numeric,updated_at=$4
WHERE month_utc=$1 AND reserved_cost_usd >= $2::numeric`, month, reservationUSD, actualUSD, now)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) FinalizeUsageCAS(
	ctx context.Context,
	settlement workspace.AIUsageSettlement,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_usage_events SET status=$2,input_tokens=$3,output_tokens=$4,
estimated_cost_usd=$5::numeric,provider_usage_finalized_at=$6,
settlement_budget_month_utc=NULL,settlement_reservation_cost_usd=NULL
WHERE operation_id=$1 AND status='accepted' AND provider_usage_finalized_at IS NULL
  AND settlement_budget_month_utc=$7 AND settlement_reservation_cost_usd=$8::numeric`, mustUUID(settlement.OperationID),
		settlement.Status, settlement.InputTokens, settlement.OutputTokens, settlement.EstimatedCostUSD, settlement.FinalizedAt,
		settlement.ExpectedBudgetMonthUtc, settlement.ExpectedReservationCostUSD)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) FindUsageLocator(
	ctx context.Context,
	generationID string,
) (*workspace.AIUsageLocator, error) {
	var state workspace.AIUsageLocator
	err := transaction.tx.QueryRow(ctx, `SELECT user_id,accepted_at,provider_usage_finalized_at
FROM ai_usage_events WHERE operation_id=$1`, mustUUID(generationID)).Scan(&state.UserID, &state.AcceptedAt, &state.FinalizedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &state, nil
}

func (transaction *workspaceGoalDraftTx) LockUsage(
	ctx context.Context,
	generationID string,
	userID string,
) (workspace.AIUsageState, error) {
	var state workspace.AIUsageState
	var settlementMonth pgtype.Date
	var settlementReservation pgtype.Text
	err := transaction.tx.QueryRow(ctx, `SELECT accepted_at,provider_usage_finalized_at,
settlement_budget_month_utc,settlement_reservation_cost_usd::text FROM ai_usage_events
WHERE operation_id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(generationID), mustUUID(userID)).Scan(
		&state.AcceptedAt, &state.FinalizedAt, &settlementMonth, &settlementReservation,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.AIUsageState{}, workspace.ErrNotFound
	}
	if err == nil {
		if settlementMonth.Valid {
			state.SettlementBudgetMonthUtc = settlementMonth.Time
		}
		if settlementReservation.Valid {
			state.SettlementReservationCostUSD = settlementReservation.String
		}
	}
	return state, err
}

func (transaction *workspaceGoalDraftTx) AddLateActualCostCAS(
	ctx context.Context,
	month time.Time,
	actualUSD string,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_budget_monthly
SET actual_cost_usd=actual_cost_usd+$2::numeric,updated_at=$3 WHERE month_utc=$1`, month, actualUSD, now)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) FinalizeLateUsageCAS(
	ctx context.Context,
	settlement workspace.AIUsageSettlement,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_usage_events SET status=$2,input_tokens=$3,output_tokens=$4,
estimated_cost_usd=$5::numeric,provider_usage_finalized_at=$6,
settlement_budget_month_utc=NULL,settlement_reservation_cost_usd=NULL
WHERE operation_id=$1 AND provider_usage_finalized_at IS NULL
  AND settlement_budget_month_utc=$7 AND settlement_reservation_cost_usd=$8::numeric`, mustUUID(settlement.OperationID),
		settlement.Status, settlement.InputTokens, settlement.OutputTokens, settlement.EstimatedCostUSD, settlement.FinalizedAt,
		settlement.ExpectedBudgetMonthUtc, settlement.ExpectedReservationCostUSD)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) LockSucceededGoalRefineGeneration(
	ctx context.Context,
	userID string,
	draftID string,
	generationID string,
) (workspace.GoalSuggestionState, error) {
	var state workspace.GoalSuggestionState
	err := transaction.tx.QueryRow(ctx, `SELECT target_revision,source_text,output,adopted_at,adopted_draft_revision
FROM ai_generations WHERE id=$1 AND user_id=$2 AND operation_type='goal_refine'
  AND source_goal_draft_id=$3 AND status='succeeded' FOR UPDATE`, mustUUID(generationID), mustUUID(userID),
		mustUUID(draftID)).Scan(&state.TargetRevision, &state.SourceText, &state.Output, &state.AdoptedAt,
		&state.AdoptedDraftRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalSuggestionState{}, workspace.ErrNotFound
	}
	return state, err
}

func (transaction *workspaceGoalDraftTx) AdoptDraftCAS(
	ctx context.Context,
	record workspace.AdoptDraftRecord,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE goal_drafts SET body=$3,revision=$4,updated_at=$5
WHERE id=$1 AND user_id=$2 AND revision=$6`, mustUUID(record.DraftID), mustUUID(record.UserID), record.Body,
		record.NewRevision, record.UpdatedAt, record.ExpectedRevision)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalDraftTx) MarkSuggestionAdoptedCAS(
	ctx context.Context,
	generationID string,
	draftRevision int64,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_generations SET adopted_at=$2,adopted_draft_revision=$3
WHERE id=$1 AND operation_type='goal_refine' AND status='succeeded' AND adopted_at IS NULL`,
		mustUUID(generationID), now, draftRevision)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func scanGoalDraft(row pgx.Row) (goal.Draft, error) {
	var draft goal.Draft
	err := row.Scan(&draft.ID, &draft.UserID, &draft.Type, &draft.GoalID, &draft.BaseGoalVersionID,
		&draft.ReviewCycleID, &draft.Body, &draft.Revision, &draft.CreatedAt, &draft.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return goal.Draft{}, workspace.ErrNotFound
	}
	return draft, err
}
