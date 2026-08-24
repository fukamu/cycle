package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

type workspaceActionAITx struct {
	*workspaceGoalDraftTx
}

var (
	_ workspace.ActionAIUnitOfWork = (*WorkspaceStore)(nil)
	_ workspace.ActionAITx         = (*workspaceActionAITx)(nil)
)

func (store *WorkspaceStore) WithinActionAITransaction(
	ctx context.Context,
	callback func(workspace.ActionAITx) error,
) error {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	port := &workspaceActionAITx{workspaceGoalDraftTx: &workspaceGoalDraftTx{tx: tx}}
	if err = callback(port); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (transaction *workspaceActionAITx) LockActionCycle(
	ctx context.Context,
	userID string,
	goalID string,
	cycleID string,
) (cycle.PDCACycle, error) {
	return loadCycleForUpdate(ctx, transaction.tx, userID, goalID, cycleID)
}

func (transaction *workspaceActionAITx) FindActionAIReplay(
	ctx context.Context,
	userID string,
	operation domainai.OperationType,
	idempotencyKey string,
) (*workspace.ActionAIReplayState, error) {
	if err := requireActionOperation(operation); err != nil {
		return nil, err
	}
	var state workspace.ActionAIReplayState
	var leaseExpiresAt pgtype.Timestamptz
	err := transaction.tx.QueryRow(ctx, `SELECT id,goal_id,cycle_id,input_hash,status,target_revision,output,
COALESCE(failure_code,''),context_changed,lease_expires_at
FROM ai_generations
WHERE user_id=$1 AND operation_type=$2 AND idempotency_key=$3`,
		mustUUID(userID), operation, mustUUID(idempotencyKey)).Scan(
		&state.GenerationID,
		&state.GoalID,
		&state.CycleID,
		&state.IdempotencyRequestHash,
		&state.Status,
		&state.TargetRevision,
		&state.Output,
		&state.FailureCode,
		&state.ContextChanged,
		&leaseExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if leaseExpiresAt.Valid {
		lease := leaseExpiresAt.Time
		state.LeaseExpiresAt = &lease
	}
	return &state, nil
}

func (transaction *workspaceActionAITx) HasRunningCycleGeneration(
	ctx context.Context,
	userID string,
	goalID string,
	cycleID string,
) (bool, error) {
	var running bool
	err := transaction.tx.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM ai_generations
WHERE user_id=$1 AND goal_id=$2 AND cycle_id=$3 AND status='running'
)`, mustUUID(userID), mustUUID(goalID), mustUUID(cycleID)).Scan(&running)
	return running, err
}

func (transaction *workspaceActionAITx) InsertActionAIGeneration(
	ctx context.Context,
	record workspace.ActionAIGenerationRecord,
) (int64, error) {
	if err := requireActionOperation(record.Operation); err != nil {
		return 0, err
	}
	command, err := transaction.tx.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,goal_id,goal_version_id,cycle_id,target_revision,idempotency_key,input_hash,
source_text,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at,context_cycle_ids)
VALUES($1,$2,$3,'running',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::numeric,$16,$17,$18::text[]::uuid[])`,
		mustUUID(record.ID),
		mustUUID(record.UserID),
		record.Operation,
		mustUUID(record.GoalID),
		mustUUID(record.GoalVersionID),
		mustUUID(record.CycleID),
		record.TargetRevision,
		mustUUID(record.IdempotencyKey),
		record.IdempotencyRequestHash,
		record.SourceText,
		record.Provider,
		record.Model,
		record.PromptVersion,
		record.BudgetMonthUtc,
		record.ReservedCostUSD,
		record.LeaseExpiresAt,
		record.StartedAt,
		record.ContextCycleIDs,
	)
	if isUniqueViolation(err) {
		return 0, workspace.ErrAIInProgress
	}
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceActionAITx) LockActionAIGeneration(
	ctx context.Context,
	key workspace.ActionAIGenerationKey,
) (workspace.ActionAISettlementState, error) {
	if err := requireActionOperation(key.Operation); err != nil {
		return workspace.ActionAISettlementState{}, err
	}
	var state workspace.ActionAISettlementState
	err := transaction.tx.QueryRow(ctx, `SELECT goal_version_id,budget_month_utc,budget_reserved_cost_usd::text,target_revision
FROM ai_generations
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND cycle_id=$4 AND operation_type=$5 AND status='running'
FOR UPDATE`,
		mustUUID(key.GenerationID),
		mustUUID(key.UserID),
		mustUUID(key.GoalID),
		mustUUID(key.CycleID),
		key.Operation,
	).Scan(
		&state.GoalVersionID,
		&state.BudgetMonthUtc,
		&state.ReservedCostUSD,
		&state.TargetRevision,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.ActionAISettlementState{}, workspace.ErrNotFound
	}
	return state, err
}

func (transaction *workspaceActionAITx) ApplyActionAICAS(
	ctx context.Context,
	record workspace.ActionAIApplyRecord,
) (int64, error) {
	if record.ExpectedContentRevision < 0 || record.ExpectedActionRevision < 0 ||
		record.NewContentRevision <= record.ExpectedContentRevision ||
		record.NewContentRevision != record.ExpectedContentRevision+1 ||
		record.NewActionRevision <= record.ExpectedActionRevision ||
		record.NewActionRevision != record.ExpectedActionRevision+1 {
		return 0, fmt.Errorf("%w: invalid Action AI revision transition", workspace.ErrActionAIPersistenceInvariant)
	}
	command, err := transaction.tx.Exec(ctx, `UPDATE pdca_cycles SET
action=$5,content_revision=$6,action_revision=$7,
action_last_ai_applied_content_revision=$6,action_user_modified_after_ai=false,updated_at=$8
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND goal_version_id=$4 AND status='active'
  AND content_revision=$9 AND action_revision=$10`,
		mustUUID(record.CycleID),
		mustUUID(record.UserID),
		mustUUID(record.GoalID),
		mustUUID(record.GoalVersionID),
		record.Action,
		record.NewContentRevision,
		record.NewActionRevision,
		record.UpdatedAt,
		record.ExpectedContentRevision,
		record.ExpectedActionRevision,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceActionAITx) TerminalizeActionAIGenerationCAS(
	ctx context.Context,
	settlement workspace.ActionAIGenerationSettlement,
) (int64, error) {
	if err := requireActionOperation(settlement.Operation); err != nil {
		return 0, err
	}
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_generations SET
status=$3,output=$4,input_tokens=$5,output_tokens=$6,estimated_cost_usd=$7::numeric,
budget_reserved_cost_usd=0,attempt_count=$8,failure_code=NULLIF($9,''),provider_request_id=NULLIF($10,''),
lease_expires_at=NULL,context_changed=$11,applied_at=$12,finished_at=$13
WHERE id=$1 AND operation_type=$2 AND status='running' AND budget_reserved_cost_usd=$14::numeric`,
		mustUUID(settlement.GenerationID),
		settlement.Operation,
		settlement.Status,
		settlement.Output,
		settlement.InputTokens,
		settlement.OutputTokens,
		settlement.EstimatedCostUSD,
		settlement.AttemptCount,
		settlement.FailureCode,
		settlement.ProviderRequestID,
		settlement.ContextChanged,
		settlement.AppliedAt,
		settlement.FinishedAt,
		settlement.ExpectedReservationUSD,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func requireActionOperation(operation domainai.OperationType) error {
	if operation == domainai.OperationActionGenerate || operation == domainai.OperationActionRefine {
		return nil
	}
	return fmt.Errorf("%w: unsupported Action AI operation %q", workspace.ErrActionAIPersistenceInvariant, operation)
}
