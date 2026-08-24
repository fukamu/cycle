package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
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
	port := &workspaceActionAITx{workspaceGoalDraftTx: &workspaceGoalDraftTx{
		tx:      tx,
		queries: store.queries.WithTx(tx),
	}}
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
	row, err := transaction.queries.FindActionAIReplay(ctx, db.FindActionAIReplayParams{
		UserID:         mustUUID(userID),
		OperationType:  string(operation),
		IdempotencyKey: mustUUID(idempotencyKey),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return actionAIReplayFromSQLC(row)
}

func (transaction *workspaceActionAITx) HasRunningCycleGeneration(
	ctx context.Context,
	userID string,
	goalID string,
	cycleID string,
) (bool, error) {
	return transaction.queries.HasRunningCycleGeneration(ctx, db.HasRunningCycleGenerationParams{
		UserID:  mustUUID(userID),
		GoalID:  mustUUID(goalID),
		CycleID: mustUUID(cycleID),
	})
}

func (transaction *workspaceActionAITx) InsertActionAIGeneration(
	ctx context.Context,
	record workspace.ActionAIGenerationRecord,
) (int64, error) {
	if err := requireActionOperation(record.Operation); err != nil {
		return 0, err
	}
	rows, err := transaction.queries.InsertActionAIGeneration(ctx, db.InsertActionAIGenerationParams{
		GenerationID:               mustUUID(record.ID),
		UserID:                     mustUUID(record.UserID),
		OperationType:              string(record.Operation),
		GoalID:                     mustUUID(record.GoalID),
		GoalVersionID:              mustUUID(record.GoalVersionID),
		CycleID:                    mustUUID(record.CycleID),
		TargetRevision:             record.TargetRevision,
		IdempotencyKey:             mustUUID(record.IdempotencyKey),
		IdempotencyRequestHash:     record.IdempotencyRequestHash,
		CanonicalProviderInputHash: record.CanonicalProviderInputHash,
		SourceText:                 record.SourceText,
		Provider:                   record.Provider,
		Model:                      record.Model,
		PromptVersion:              record.PromptVersion,
		BudgetMonthUtc:             goalDeleteDate(record.BudgetMonthUtc),
		ReservedCostUsd:            record.ReservedCostUSD,
		LeaseExpiresAt:             timestamptz(record.LeaseExpiresAt),
		StartedAt:                  timestamptz(record.StartedAt),
		ContextCycleIds:            record.ContextCycleIDs,
	})
	if isUniqueViolation(err) {
		return 0, workspace.ErrAIInProgress
	}
	if err != nil {
		return 0, err
	}
	return rows, nil
}

func (transaction *workspaceActionAITx) LockActionAIGeneration(
	ctx context.Context,
	key workspace.ActionAIGenerationKey,
) (workspace.ActionAISettlementState, error) {
	if err := requireActionOperation(key.Operation); err != nil {
		return workspace.ActionAISettlementState{}, err
	}
	row, err := transaction.queries.LockActionAIGeneration(ctx, db.LockActionAIGenerationParams{
		GenerationID:  mustUUID(key.GenerationID),
		UserID:        mustUUID(key.UserID),
		GoalID:        mustUUID(key.GoalID),
		CycleID:       mustUUID(key.CycleID),
		OperationType: string(key.Operation),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.ActionAISettlementState{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.ActionAISettlementState{}, err
	}
	return actionAISettlementFromSQLC(row)
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
	return transaction.queries.ApplyActionAICAS(ctx, db.ApplyActionAICASParams{
		Action:                  record.Action,
		NewContentRevision:      record.NewContentRevision,
		NewActionRevision:       record.NewActionRevision,
		UpdatedAt:               timestamptz(record.UpdatedAt),
		CycleID:                 mustUUID(record.CycleID),
		UserID:                  mustUUID(record.UserID),
		GoalID:                  mustUUID(record.GoalID),
		GoalVersionID:           mustUUID(record.GoalVersionID),
		ExpectedContentRevision: record.ExpectedContentRevision,
		ExpectedActionRevision:  record.ExpectedActionRevision,
	})
}

func (transaction *workspaceActionAITx) TerminalizeActionAIGenerationCAS(
	ctx context.Context,
	settlement workspace.ActionAIGenerationSettlement,
) (int64, error) {
	if err := requireActionOperation(settlement.Operation); err != nil {
		return 0, err
	}
	return transaction.queries.TerminalizeActionAIGenerationCAS(
		ctx,
		db.TerminalizeActionAIGenerationCASParams{
			Status:                 settlement.Status,
			Output:                 settlement.Output,
			InputTokens:            settlement.InputTokens,
			OutputTokens:           settlement.OutputTokens,
			EstimatedCostUsd:       settlement.EstimatedCostUSD,
			AttemptCount:           settlement.AttemptCount,
			FailureCode:            settlement.FailureCode,
			ProviderRequestID:      settlement.ProviderRequestID,
			ContextChanged:         settlement.ContextChanged,
			AppliedAt:              nullableAITimestamptz(settlement.AppliedAt),
			FinishedAt:             timestamptz(settlement.FinishedAt),
			GenerationID:           mustUUID(settlement.GenerationID),
			OperationType:          string(settlement.Operation),
			ExpectedReservationUsd: settlement.ExpectedReservationUSD,
		},
	)
}

func actionAIReplayFromSQLC(row *db.FindActionAIReplayRow) (*workspace.ActionAIReplayState, error) {
	if row == nil {
		return nil, actionAIAdapterPersistenceError("Action AI replay row is nil")
	}
	generationID := uuidString(row.GenerationID)
	goalID := uuidString(row.GoalID)
	cycleID := uuidString(row.CycleID)
	if generationID == "" || goalID == "" || cycleID == "" || row.IdempotencyRequestHash == "" ||
		!validAIGenerationStatus(row.Status) || row.TargetRevision < 0 {
		return nil, actionAIAdapterPersistenceError("Action AI replay state is invalid")
	}
	leaseExpiresAt, err := actionAIOptionalTimestamptz(row.LeaseExpiresAt)
	if err != nil {
		return nil, err
	}
	return &workspace.ActionAIReplayState{
		GenerationID:           generationID,
		GoalID:                 goalID,
		CycleID:                cycleID,
		IdempotencyRequestHash: row.IdempotencyRequestHash,
		Status:                 row.Status,
		TargetRevision:         row.TargetRevision,
		Output:                 row.Output,
		FailureCode:            row.FailureCode,
		ContextChanged:         row.ContextChanged,
		LeaseExpiresAt:         leaseExpiresAt,
	}, nil
}

func actionAISettlementFromSQLC(
	row *db.LockActionAIGenerationRow,
) (workspace.ActionAISettlementState, error) {
	if row == nil {
		return workspace.ActionAISettlementState{}, actionAIAdapterPersistenceError("Action AI settlement row is nil")
	}
	goalVersionID := uuidString(row.GoalVersionID)
	month, monthValid := finiteGoalDeleteDate(row.BudgetMonthUtc)
	if goalVersionID == "" || !monthValid || month.IsZero() ||
		row.BudgetReservedCostUsd == "" || row.TargetRevision < 0 {
		return workspace.ActionAISettlementState{}, actionAIAdapterPersistenceError("Action AI settlement state is invalid")
	}
	return workspace.ActionAISettlementState{
		GoalVersionID: goalVersionID, BudgetMonthUtc: month,
		ReservedCostUSD: row.BudgetReservedCostUsd, TargetRevision: row.TargetRevision,
	}, nil
}

func actionAIOptionalTimestamptz(value pgtype.Timestamptz) (*time.Time, error) {
	if !value.Valid {
		return nil, nil
	}
	result, valid := finiteGoalDeleteTimestamptz(value)
	if !valid || result.IsZero() {
		return nil, actionAIAdapterPersistenceError("Action AI timestamp is invalid or non-finite")
	}
	return &result, nil
}

func actionAIAdapterPersistenceError(detail string) error {
	return fmt.Errorf("%w: %s", workspace.ErrActionAIPersistenceInvariant, detail)
}

func requireActionOperation(operation domainai.OperationType) error {
	if operation == domainai.OperationActionGenerate || operation == domainai.OperationActionRefine {
		return nil
	}
	return fmt.Errorf("%w: unsupported Action AI operation %q", workspace.ErrActionAIPersistenceInvariant, operation)
}
