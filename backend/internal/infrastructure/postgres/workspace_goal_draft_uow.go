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
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type workspaceGoalDraftTx struct {
	tx      pgx.Tx
	queries *db.Queries
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
	if err = callback(&workspaceGoalDraftTx{tx: tx, queries: store.queries.WithTx(tx)}); err != nil {
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
	row, err := transaction.queries.FindCreationDraft(ctx, mustUUID(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	draft, err := goalDraftFromSQLC(row)
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
	row, err := transaction.queries.LockDraftByID(ctx, db.LockDraftByIDParams{
		DraftID: mustUUID(draftID),
		UserID:  mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return goal.Draft{}, workspace.ErrNotFound
	}
	if err != nil {
		return goal.Draft{}, err
	}
	return goalDraftFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) LockReviewDraftByGoal(
	ctx context.Context,
	userID string,
	goalID string,
) (goal.Draft, error) {
	row, err := transaction.queries.LockReviewDraftByGoal(ctx, db.LockReviewDraftByGoalParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return goal.Draft{}, workspace.ErrNotFound
	}
	if err != nil {
		return goal.Draft{}, err
	}
	return goalDraftFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) InsertCreationDraft(ctx context.Context, draft goal.Draft) (int64, error) {
	rows, err := transaction.queries.InsertCreationDraft(ctx, db.InsertCreationDraftParams{
		DraftID:   mustUUID(draft.ID),
		UserID:    mustUUID(draft.UserID),
		Body:      draft.Body,
		Revision:  draft.Revision,
		CreatedAt: timestamptz(draft.CreatedAt),
		UpdatedAt: timestamptz(draft.UpdatedAt),
	})
	if isUniqueViolation(err) {
		return 0, workspace.ErrDraftAlreadyExists
	}
	if err != nil {
		return 0, err
	}
	return rows, nil
}

func (transaction *workspaceGoalDraftTx) SaveDraftCAS(
	ctx context.Context,
	draft goal.Draft,
	expectedRevision int64,
) (int64, error) {
	return transaction.queries.SaveDraftCAS(ctx, db.SaveDraftCASParams{
		Body:             draft.Body,
		NewRevision:      draft.Revision,
		UpdatedAt:        timestamptz(draft.UpdatedAt),
		DraftID:          mustUUID(draft.ID),
		UserID:           mustUUID(draft.UserID),
		DraftType:        string(draft.Type),
		ExpectedRevision: expectedRevision,
	})
}

func (transaction *workspaceGoalDraftTx) DeleteCreationDraftCAS(
	ctx context.Context,
	userID string,
	draftID string,
	expectedRevision int64,
) (int64, error) {
	return transaction.queries.DeleteCreationDraftCAS(ctx, db.DeleteCreationDraftCASParams{
		DraftID:          mustUUID(draftID),
		UserID:           mustUUID(userID),
		ExpectedRevision: expectedRevision,
	})
}

func (transaction *workspaceGoalDraftTx) LockDraftGenerations(
	ctx context.Context,
	userID string,
	draftID string,
) ([]workspace.DraftGenerationState, error) {
	rows, err := transaction.queries.LockDraftGenerations(ctx, db.LockDraftGenerationsParams{
		UserID:  mustUUID(userID),
		DraftID: mustUUID(draftID),
	})
	if err != nil {
		return nil, err
	}
	return draftGenerationsFromSQLC(rows)
}

func (transaction *workspaceGoalDraftTx) LockDraftUsages(
	ctx context.Context,
	userID string,
	operationIDs []string,
) ([]workspace.DraftUsageState, error) {
	if len(operationIDs) == 0 {
		return []workspace.DraftUsageState{}, nil
	}
	rows, err := transaction.queries.LockDraftUsages(ctx, db.LockDraftUsagesParams{
		UserID:       mustUUID(userID),
		OperationIds: operationIDs,
	})
	if err != nil {
		return nil, err
	}
	return draftUsagesFromSQLC(rows)
}

func (transaction *workspaceGoalDraftTx) RedactDraftUsagesCAS(
	ctx context.Context,
	userID string,
	operationIDs []string,
) (int64, error) {
	if len(operationIDs) == 0 {
		return 0, nil
	}
	return transaction.queries.RedactDraftUsagesCAS(ctx, db.RedactDraftUsagesCASParams{
		UserID:       mustUUID(userID),
		OperationIds: operationIDs,
	})
}

func (transaction *workspaceGoalDraftTx) DeleteExpiredFinalizedDraftUsagesCAS(
	ctx context.Context,
	userID string,
	operationIDs []string,
	now time.Time,
) (int64, error) {
	if len(operationIDs) == 0 {
		return 0, nil
	}
	return transaction.queries.DeleteExpiredFinalizedDraftUsagesCAS(
		ctx,
		db.DeleteExpiredFinalizedDraftUsagesCASParams{
			UserID:       mustUUID(userID),
			OperationIds: operationIDs,
			Now:          timestamptz(now),
		},
	)
}

func (transaction *workspaceGoalDraftTx) DeleteDraftGenerationsCAS(
	ctx context.Context,
	userID string,
	draftID string,
	generationIDs []string,
) (int64, error) {
	if len(generationIDs) == 0 {
		return 0, nil
	}
	return transaction.queries.DeleteDraftGenerationsCAS(ctx, db.DeleteDraftGenerationsCASParams{
		UserID:        mustUUID(userID),
		DraftID:       mustUUID(draftID),
		GenerationIds: generationIDs,
	})
}

func (transaction *workspaceGoalDraftTx) FindStartReplay(
	ctx context.Context,
	userID string,
	operationID string,
) (*workspace.StartReplayState, error) {
	row, err := transaction.queries.FindStartReplay(ctx, db.FindStartReplayParams{
		UserID:      mustUUID(userID),
		OperationID: mustUUID(operationID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return startReplayFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) CountProgressingGoals(ctx context.Context, userID string) (int, error) {
	count, err := transaction.queries.CountProgressingGoals(ctx, mustUUID(userID))
	return int(count), err
}

func (transaction *workspaceGoalDraftTx) InsertInitialGoal(ctx context.Context, current goal.Goal) (int64, error) {
	return transaction.queries.InsertInitialGoal(ctx, db.InsertInitialGoalParams{
		GoalID:                  mustUUID(current.ID),
		UserID:                  mustUUID(current.UserID),
		Status:                  string(current.Status),
		CurrentVersionNumber:    current.CurrentVersionNumber,
		NextCycleSequenceNumber: current.NextCycleSequenceNumber,
		Revision:                current.Revision,
		CreatedAt:               timestamptz(current.CreatedAt),
		UpdatedAt:               timestamptz(current.UpdatedAt),
	})
}

func (transaction *workspaceGoalDraftTx) InsertInitialVersion(ctx context.Context, version goal.Version) (int64, error) {
	return transaction.queries.InsertGoalVersion(ctx, db.InsertGoalVersionParams{
		VersionID:            mustUUID(version.ID),
		UserID:               mustUUID(version.UserID),
		GoalID:               mustUUID(version.GoalID),
		VersionNumber:        version.VersionNumber,
		Body:                 version.Body,
		CreatedByOperationID: mustUUID(version.CreatedByOperationID),
		CreatedAt:            timestamptz(version.CreatedAt),
	})
}

func (transaction *workspaceGoalDraftTx) TryInsertInitialCycleClaim(ctx context.Context, current cycle.PDCACycle) (int64, error) {
	return transaction.queries.TryInsertCycleClaim(ctx, db.TryInsertCycleClaimParams{
		CycleID:          mustUUID(current.ID),
		UserID:           mustUUID(current.UserID),
		GoalID:           mustUUID(current.GoalID),
		GoalVersionID:    mustUUID(current.GoalVersionID),
		SequenceNumber:   current.SequenceNumber,
		Status:           string(current.Status),
		StartedAt:        timestamptz(current.StartedAt),
		StartOperationID: mustUUID(current.StartOperationID),
		StartRequestHash: current.StartRequestHash,
		CreatedAt:        timestamptz(current.CreatedAt),
		UpdatedAt:        timestamptz(current.UpdatedAt),
	})
}

func (transaction *workspaceGoalDraftTx) AttachDraftGenerations(
	ctx context.Context,
	userID string,
	draftID string,
	generationIDs []string,
	goalID string,
	versionID string,
) (int64, error) {
	if len(generationIDs) == 0 {
		return 0, nil
	}
	return transaction.queries.AttachDraftGenerations(ctx, db.AttachDraftGenerationsParams{
		GoalID:        mustUUID(goalID),
		GoalVersionID: mustUUID(versionID),
		UserID:        mustUUID(userID),
		DraftID:       mustUUID(draftID),
		GenerationIds: generationIDs,
	})
}

func (transaction *workspaceGoalDraftTx) AttachUsageToGoal(
	ctx context.Context,
	userID string,
	generationIDs []string,
	goalID string,
) (int64, error) {
	if len(generationIDs) == 0 {
		return 0, nil
	}
	return transaction.queries.AttachUsageToGoal(ctx, db.AttachUsageToGoalParams{
		GoalID:       mustUUID(goalID),
		UserID:       mustUUID(userID),
		OperationIds: generationIDs,
	})
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
	row, err := transaction.queries.LockGoalWithCurrentVersion(ctx, db.LockGoalWithCurrentVersionParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalTargetState{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.GoalTargetState{}, err
	}
	currentVersionID := uuidString(row.CurrentVersionID)
	if currentVersionID == "" {
		return workspace.GoalTargetState{}, fmt.Errorf(
			"%w: locked Goal current Version identity is missing",
			workspace.ErrGoalPersistenceInvariant,
		)
	}
	return workspace.GoalTargetState{
		Status:           goal.Status(row.Status),
		Revision:         row.Revision,
		CurrentVersionID: currentVersionID,
		Body:             row.Body,
	}, nil
}

func (transaction *workspaceGoalDraftTx) FindGoalRefineReplay(
	ctx context.Context,
	userID string,
	idempotencyKey string,
) (*workspace.GoalRefineReplayState, error) {
	row, err := transaction.queries.FindGoalRefineReplay(ctx, db.FindGoalRefineReplayParams{
		UserID:         mustUUID(userID),
		IdempotencyKey: mustUUID(idempotencyKey),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return goalRefineReplayFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) ListAIContextCycles(
	ctx context.Context,
	userID string,
	goalID string,
	excludeCycleID string,
	limit int,
) ([]workspace.AIContextCycle, error) {
	rows, err := transaction.queries.ListAIContextCycles(ctx, db.ListAIContextCyclesParams{
		UserID:         mustUUID(userID),
		GoalID:         mustUUID(goalID),
		ExcludeCycleID: nullableCycleUUID(excludeCycleID),
		FetchLimit:     int32(limit),
	})
	if err != nil {
		return nil, err
	}
	items := make([]workspace.AIContextCycle, 0, len(rows))
	for _, row := range rows {
		item, mapErr := aiContextCycleFromSQLC(row)
		if mapErr != nil {
			return nil, mapErr
		}
		items = append(items, item)
	}
	return items, nil
}

func (transaction *workspaceGoalDraftTx) LockExpiredGenerations(
	ctx context.Context,
	userID string,
	now time.Time,
) ([]workspace.ExpiredGeneration, error) {
	rows, err := transaction.queries.LockExpiredGenerations(ctx, db.LockExpiredGenerationsParams{
		UserID: mustUUID(userID),
		Now:    timestamptz(now),
	})
	if err != nil {
		return nil, err
	}
	return expiredGenerationsFromSQLC(rows)
}

func (transaction *workspaceGoalDraftTx) SumLockedReservationsByMonth(
	ctx context.Context,
	generationIDs []string,
) ([]workspace.MonthlyReservation, error) {
	if len(generationIDs) == 0 {
		return []workspace.MonthlyReservation{}, nil
	}
	rows, err := transaction.queries.SumLockedReservationsByMonth(ctx, generationIDs)
	if err != nil {
		return nil, err
	}
	return monthlyReservationsFromSQLC(rows)
}

func (transaction *workspaceGoalDraftTx) ReleaseBudgetReservationCAS(
	ctx context.Context,
	month time.Time,
	amountUSD string,
	now time.Time,
) (int64, error) {
	return transaction.queries.ReleaseBudgetReservationCAS(ctx, db.ReleaseBudgetReservationCASParams{
		AmountUsd: amountUSD,
		UpdatedAt: timestamptz(now),
		MonthUtc:  goalDeleteDate(month),
	})
}

func (transaction *workspaceGoalDraftTx) ExpireGenerationCAS(
	ctx context.Context,
	generationID string,
	reservedCostUSD string,
	now time.Time,
) (int64, error) {
	return transaction.queries.ExpireGenerationCAS(ctx, db.ExpireGenerationCASParams{
		FinishedAt:             timestamptz(now),
		GenerationID:           mustUUID(generationID),
		ExpectedReservationUsd: reservedCostUSD,
	})
}

func (transaction *workspaceGoalDraftTx) ExpireUsageCAS(
	ctx context.Context,
	generationID string,
	budgetMonth time.Time,
	reservationCostUSD string,
) (int64, error) {
	return transaction.queries.ExpireUsageCAS(ctx, db.ExpireUsageCASParams{
		OperationID:            mustUUID(generationID),
		ExpectedBudgetMonthUtc: goalDeleteDate(budgetMonth),
		ExpectedReservationUsd: reservationCostUSD,
	})
}

func (transaction *workspaceGoalDraftTx) HasRunningDraftGeneration(ctx context.Context, draftID string) (bool, error) {
	return transaction.queries.HasRunningDraftGeneration(ctx, mustUUID(draftID))
}

func (transaction *workspaceGoalDraftTx) CountRollingUsage(
	ctx context.Context,
	userID string,
	acceptedAfter time.Time,
) (int, error) {
	count, err := transaction.queries.CountRollingUsage(ctx, db.CountRollingUsageParams{
		UserID:        mustUUID(userID),
		AcceptedAfter: timestamptz(acceptedAfter),
	})
	return int(count), err
}

func (transaction *workspaceGoalDraftTx) IncrementRateBucket(
	ctx context.Context,
	bucket workspace.AIRateBucket,
) (int, error) {
	count, err := transaction.queries.IncrementRateBucket(ctx, db.IncrementRateBucketParams{
		Scope:       bucket.Scope,
		KeyHash:     bucket.KeyHash,
		WindowStart: timestamptz(bucket.WindowStart),
		ExpiresAt:   timestamptz(bucket.ExpiresAt),
	})
	return int(count), err
}

func (transaction *workspaceGoalDraftTx) EnsureBudgetMonth(ctx context.Context, month time.Time, now time.Time) error {
	return transaction.queries.EnsureBudgetMonth(ctx, db.EnsureBudgetMonthParams{
		MonthUtc:  goalDeleteDate(month),
		UpdatedAt: timestamptz(now),
	})
}

func (transaction *workspaceGoalDraftTx) LockBudgetMonth(ctx context.Context, month time.Time) (workspace.AIBudgetState, error) {
	row, err := transaction.queries.LockBudgetMonth(ctx, goalDeleteDate(month))
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.AIBudgetState{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.AIBudgetState{}, err
	}
	return aiBudgetStateFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) ReserveBudgetCAS(
	ctx context.Context,
	month time.Time,
	amountUSD string,
	now time.Time,
) (int64, error) {
	return transaction.queries.ReserveBudgetCAS(ctx, db.ReserveBudgetCASParams{
		AmountUsd: amountUSD,
		UpdatedAt: timestamptz(now),
		MonthUtc:  goalDeleteDate(month),
	})
}

func (transaction *workspaceGoalDraftTx) InsertGoalRefineGeneration(
	ctx context.Context,
	record workspace.GoalRefineGenerationRecord,
) (int64, error) {
	rows, err := transaction.queries.InsertGoalRefineGeneration(ctx, db.InsertGoalRefineGenerationParams{
		GenerationID:               mustUUID(record.ID),
		UserID:                     mustUUID(record.UserID),
		DraftID:                    mustUUID(record.DraftID),
		GoalID:                     nullableCycleUUID(record.GoalID),
		GoalVersionID:              nullableCycleUUID(record.GoalVersionID),
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

func (transaction *workspaceGoalDraftTx) InsertAcceptedUsage(
	ctx context.Context,
	record workspace.AIUsageRecord,
) (int64, error) {
	return transaction.queries.InsertAcceptedUsage(ctx, db.InsertAcceptedUsageParams{
		OperationID:                  mustUUID(record.OperationID),
		UserID:                       mustUUID(record.UserID),
		GoalID:                       nullableCycleUUID(record.GoalID),
		OperationType:                string(record.Operation),
		Provider:                     record.Provider,
		Model:                        record.Model,
		PromptVersion:                record.PromptVersion,
		AcceptedAt:                   timestamptz(record.AcceptedAt),
		QuotaRetainUntil:             timestamptz(record.QuotaRetainUntil),
		SettlementBudgetMonthUtc:     goalDeleteDate(record.SettlementBudgetMonthUtc),
		SettlementReservationCostUsd: record.SettlementReservationCostUSD,
	})
}

func (transaction *workspaceGoalDraftTx) FindGenerationLocator(
	ctx context.Context,
	generationID string,
) (*workspace.AIGenerationLocator, error) {
	row, err := transaction.queries.FindGenerationLocator(ctx, mustUUID(generationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return aiGenerationLocatorFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) LockGoalRefineGeneration(
	ctx context.Context,
	key workspace.GoalRefineGenerationKey,
) (workspace.GoalRefineSettlementState, error) {
	row, err := transaction.queries.LockGoalRefineGeneration(ctx, db.LockGoalRefineGenerationParams{
		GenerationID: mustUUID(key.GenerationID),
		UserID:       mustUUID(key.UserID),
		DraftID:      mustUUID(key.DraftID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalRefineSettlementState{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.GoalRefineSettlementState{}, err
	}
	return goalRefineSettlementFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) TerminalizeGenerationCAS(
	ctx context.Context,
	settlement workspace.AIGenerationSettlement,
) (int64, error) {
	return transaction.queries.TerminalizeGenerationCAS(ctx, db.TerminalizeGenerationCASParams{
		Status:                 settlement.Status,
		Output:                 settlement.Output,
		InputTokens:            settlement.InputTokens,
		OutputTokens:           settlement.OutputTokens,
		EstimatedCostUsd:       settlement.EstimatedCostUSD,
		AttemptCount:           settlement.AttemptCount,
		FailureCode:            settlement.FailureCode,
		ProviderRequestID:      settlement.ProviderRequestID,
		ContextChanged:         settlement.ContextChanged,
		FinishedAt:             timestamptz(settlement.FinishedAt),
		GenerationID:           mustUUID(settlement.GenerationID),
		ExpectedReservationUsd: settlement.ExpectedReservationUSD,
	})
}

func (transaction *workspaceGoalDraftTx) SettleBudgetCAS(
	ctx context.Context,
	month time.Time,
	reservationUSD string,
	actualUSD string,
	now time.Time,
) (int64, error) {
	return transaction.queries.SettleBudgetCAS(ctx, db.SettleBudgetCASParams{
		ReservationUsd: reservationUSD,
		ActualUsd:      actualUSD,
		UpdatedAt:      timestamptz(now),
		MonthUtc:       goalDeleteDate(month),
	})
}

func (transaction *workspaceGoalDraftTx) FinalizeUsageCAS(
	ctx context.Context,
	settlement workspace.AIUsageSettlement,
) (int64, error) {
	return transaction.queries.FinalizeUsageCAS(ctx, db.FinalizeUsageCASParams{
		Status:                 settlement.Status,
		InputTokens:            settlement.InputTokens,
		OutputTokens:           settlement.OutputTokens,
		EstimatedCostUsd:       settlement.EstimatedCostUSD,
		FinalizedAt:            timestamptz(settlement.FinalizedAt),
		OperationID:            mustUUID(settlement.OperationID),
		ExpectedBudgetMonthUtc: goalDeleteDate(settlement.ExpectedBudgetMonthUtc),
		ExpectedReservationUsd: settlement.ExpectedReservationCostUSD,
	})
}

func (transaction *workspaceGoalDraftTx) FindUsageLocator(
	ctx context.Context,
	generationID string,
) (*workspace.AIUsageLocator, error) {
	row, err := transaction.queries.FindUsageLocator(ctx, mustUUID(generationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return aiUsageLocatorFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) LockUsage(
	ctx context.Context,
	generationID string,
	userID string,
) (workspace.AIUsageState, error) {
	row, err := transaction.queries.LockUsage(ctx, db.LockUsageParams{
		OperationID: mustUUID(generationID),
		UserID:      mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.AIUsageState{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.AIUsageState{}, err
	}
	return aiUsageStateFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) AddLateActualCostCAS(
	ctx context.Context,
	month time.Time,
	actualUSD string,
	now time.Time,
) (int64, error) {
	return transaction.queries.AddLateActualCostCAS(ctx, db.AddLateActualCostCASParams{
		ActualUsd: actualUSD,
		UpdatedAt: timestamptz(now),
		MonthUtc:  goalDeleteDate(month),
	})
}

func (transaction *workspaceGoalDraftTx) FinalizeLateUsageCAS(
	ctx context.Context,
	settlement workspace.AIUsageSettlement,
) (int64, error) {
	return transaction.queries.FinalizeLateUsageCAS(ctx, db.FinalizeLateUsageCASParams{
		Status:                 settlement.Status,
		InputTokens:            settlement.InputTokens,
		OutputTokens:           settlement.OutputTokens,
		EstimatedCostUsd:       settlement.EstimatedCostUSD,
		FinalizedAt:            timestamptz(settlement.FinalizedAt),
		OperationID:            mustUUID(settlement.OperationID),
		ExpectedBudgetMonthUtc: goalDeleteDate(settlement.ExpectedBudgetMonthUtc),
		ExpectedReservationUsd: settlement.ExpectedReservationCostUSD,
	})
}

func (transaction *workspaceGoalDraftTx) LockSucceededGoalRefineGeneration(
	ctx context.Context,
	userID string,
	draftID string,
	generationID string,
) (workspace.GoalSuggestionState, error) {
	row, err := transaction.queries.LockSucceededGoalRefineGeneration(
		ctx,
		db.LockSucceededGoalRefineGenerationParams{
			GenerationID: mustUUID(generationID),
			UserID:       mustUUID(userID),
			DraftID:      mustUUID(draftID),
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalSuggestionState{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.GoalSuggestionState{}, err
	}
	return goalSuggestionStateFromSQLC(row)
}

func (transaction *workspaceGoalDraftTx) AdoptDraftCAS(
	ctx context.Context,
	record workspace.AdoptDraftRecord,
) (int64, error) {
	return transaction.queries.AdoptDraftCAS(ctx, db.AdoptDraftCASParams{
		Body:             record.Body,
		NewRevision:      record.NewRevision,
		UpdatedAt:        timestamptz(record.UpdatedAt),
		DraftID:          mustUUID(record.DraftID),
		UserID:           mustUUID(record.UserID),
		ExpectedRevision: record.ExpectedRevision,
	})
}

func (transaction *workspaceGoalDraftTx) MarkSuggestionAdoptedCAS(
	ctx context.Context,
	generationID string,
	draftRevision int64,
	now time.Time,
) (int64, error) {
	return transaction.queries.MarkSuggestionAdoptedCAS(ctx, db.MarkSuggestionAdoptedCASParams{
		AdoptedAt:            timestamptz(now),
		AdoptedDraftRevision: draftRevision,
		GenerationID:         mustUUID(generationID),
	})
}

func draftGenerationsFromSQLC(
	rows []*db.LockDraftGenerationsRow,
) ([]workspace.DraftGenerationState, error) {
	items := make([]workspace.DraftGenerationState, 0, len(rows))
	for _, row := range rows {
		if row == nil {
			return nil, aiAdapterPersistenceError("locked Draft Generation row is nil")
		}
		id := uuidString(row.ID)
		if id == "" || !validAIGenerationStatus(row.Status) {
			return nil, aiAdapterPersistenceError("locked Draft Generation state is invalid")
		}
		items = append(items, workspace.DraftGenerationState{ID: id, Status: row.Status})
	}
	return items, nil
}

func draftUsagesFromSQLC(rows []*db.LockDraftUsagesRow) ([]workspace.DraftUsageState, error) {
	items := make([]workspace.DraftUsageState, 0, len(rows))
	for _, row := range rows {
		if row == nil {
			return nil, aiAdapterPersistenceError("locked Draft Usage row is nil")
		}
		operationID := uuidString(row.OperationID)
		retainUntil, retainValid := finiteGoalDeleteTimestamptz(row.QuotaRetainUntil)
		if operationID == "" || !retainValid || retainUntil.IsZero() {
			return nil, aiAdapterPersistenceError("locked Draft Usage state is invalid")
		}
		finalizedAt, err := optionalAITimestamptz(row.ProviderUsageFinalizedAt)
		if err != nil {
			return nil, err
		}
		items = append(items, workspace.DraftUsageState{
			OperationID:              operationID,
			QuotaRetainUntil:         retainUntil,
			ProviderUsageFinalizedAt: finalizedAt,
		})
	}
	return items, nil
}

func goalRefineReplayFromSQLC(row *db.FindGoalRefineReplayRow) (*workspace.GoalRefineReplayState, error) {
	if row == nil {
		return nil, aiAdapterPersistenceError("Goal Refine replay row is nil")
	}
	generationID := uuidString(row.GenerationID)
	if generationID == "" || row.IdempotencyRequestHash == "" ||
		!validAIGenerationStatus(row.Status) || row.TargetRevision < 0 {
		return nil, aiAdapterPersistenceError("Goal Refine replay state is invalid")
	}
	return &workspace.GoalRefineReplayState{
		GenerationID:           generationID,
		IdempotencyRequestHash: row.IdempotencyRequestHash,
		Status:                 row.Status,
		TargetRevision:         row.TargetRevision,
		Output:                 row.Output,
		FailureCode:            row.FailureCode,
		ContextChanged:         row.ContextChanged,
	}, nil
}

func expiredGenerationsFromSQLC(
	rows []*db.LockExpiredGenerationsRow,
) ([]workspace.ExpiredGeneration, error) {
	items := make([]workspace.ExpiredGeneration, 0, len(rows))
	for _, row := range rows {
		if row == nil {
			return nil, aiAdapterPersistenceError("expired Generation row is nil")
		}
		id := uuidString(row.ID)
		month, monthValid := finiteGoalDeleteDate(row.BudgetMonthUtc)
		if id == "" || !monthValid || month.IsZero() || row.BudgetReservedCostUsd == "" {
			return nil, aiAdapterPersistenceError("expired Generation state is invalid")
		}
		items = append(items, workspace.ExpiredGeneration{
			ID: id, BudgetMonthUtc: month, ReservedCostUSD: row.BudgetReservedCostUsd,
		})
	}
	return items, nil
}

func monthlyReservationsFromSQLC(
	rows []*db.SumLockedReservationsByMonthRow,
) ([]workspace.MonthlyReservation, error) {
	items := make([]workspace.MonthlyReservation, 0, len(rows))
	for _, row := range rows {
		if row == nil {
			return nil, aiAdapterPersistenceError("monthly AI reservation row is nil")
		}
		month, monthValid := finiteGoalDeleteDate(row.BudgetMonthUtc)
		if !monthValid || month.IsZero() || row.AmountUsd == "" {
			return nil, aiAdapterPersistenceError("monthly AI reservation state is invalid")
		}
		items = append(items, workspace.MonthlyReservation{MonthUtc: month, AmountUSD: row.AmountUsd})
	}
	return items, nil
}

func aiBudgetStateFromSQLC(row *db.LockBudgetMonthRow) (workspace.AIBudgetState, error) {
	if row == nil || row.ReservedCostUsd == "" || row.ActualCostUsd == "" || row.UnattributedCostUsd == "" {
		return workspace.AIBudgetState{}, aiAdapterPersistenceError("locked AI Budget state is invalid")
	}
	return workspace.AIBudgetState{
		ReservedCostUSD:     row.ReservedCostUsd,
		ActualCostUSD:       row.ActualCostUsd,
		UnattributedCostUSD: row.UnattributedCostUsd,
	}, nil
}

func aiGenerationLocatorFromSQLC(row *db.FindGenerationLocatorRow) (*workspace.AIGenerationLocator, error) {
	if row == nil {
		return nil, aiAdapterPersistenceError("AI Generation locator row is nil")
	}
	userID := uuidString(row.UserID)
	draftID, draftValid := optionalAIUUID(row.SourceGoalDraftID)
	goalID, goalValid := optionalAIUUID(row.GoalID)
	cycleID, cycleValid := optionalAIUUID(row.CycleID)
	operation := domainai.OperationType(row.OperationType)
	if userID == "" || !draftValid || !goalValid || !cycleValid ||
		!validAIOperation(operation) || !validAIGenerationStatus(row.Status) {
		return nil, aiAdapterPersistenceError("AI Generation locator state is invalid")
	}
	return &workspace.AIGenerationLocator{
		UserID: userID, Operation: operation, Status: row.Status,
		DraftID: draftID, GoalID: goalID, CycleID: cycleID,
	}, nil
}

func goalRefineSettlementFromSQLC(
	row *db.LockGoalRefineGenerationRow,
) (workspace.GoalRefineSettlementState, error) {
	if row == nil {
		return workspace.GoalRefineSettlementState{}, aiAdapterPersistenceError("Goal Refine settlement row is nil")
	}
	month, monthValid := finiteGoalDeleteDate(row.BudgetMonthUtc)
	if !monthValid || month.IsZero() || row.BudgetReservedCostUsd == "" || row.TargetRevision < 0 {
		return workspace.GoalRefineSettlementState{}, aiAdapterPersistenceError("Goal Refine settlement state is invalid")
	}
	return workspace.GoalRefineSettlementState{
		BudgetMonthUtc: month, ReservedCostUSD: row.BudgetReservedCostUsd, TargetRevision: row.TargetRevision,
	}, nil
}

func aiUsageLocatorFromSQLC(row *db.FindUsageLocatorRow) (*workspace.AIUsageLocator, error) {
	if row == nil {
		return nil, aiAdapterPersistenceError("AI Usage locator row is nil")
	}
	userID := uuidString(row.UserID)
	acceptedAt, acceptedValid := finiteGoalDeleteTimestamptz(row.AcceptedAt)
	finalizedAt, err := optionalAITimestamptz(row.ProviderUsageFinalizedAt)
	if err != nil {
		return nil, err
	}
	if userID == "" || !acceptedValid || acceptedAt.IsZero() {
		return nil, aiAdapterPersistenceError("AI Usage locator state is invalid")
	}
	return &workspace.AIUsageLocator{UserID: userID, AcceptedAt: acceptedAt, FinalizedAt: finalizedAt}, nil
}

func aiUsageStateFromSQLC(row *db.LockUsageRow) (workspace.AIUsageState, error) {
	if row == nil {
		return workspace.AIUsageState{}, aiAdapterPersistenceError("locked AI Usage row is nil")
	}
	acceptedAt, acceptedValid := finiteGoalDeleteTimestamptz(row.AcceptedAt)
	finalizedAt, err := optionalAITimestamptz(row.ProviderUsageFinalizedAt)
	if err != nil {
		return workspace.AIUsageState{}, err
	}
	if !acceptedValid || acceptedAt.IsZero() {
		return workspace.AIUsageState{}, aiAdapterPersistenceError("locked AI Usage acceptance timestamp is invalid")
	}
	state := workspace.AIUsageState{AcceptedAt: acceptedAt, FinalizedAt: finalizedAt}
	if finalizedAt != nil {
		if row.SettlementBudgetMonthUtc.Valid || row.SettlementReservationPresent ||
			row.SettlementReservationCostUsd != "" {
			return workspace.AIUsageState{}, aiAdapterPersistenceError(
				"finalized AI Usage retains settlement exposure",
			)
		}
		return state, nil
	}
	month, monthValid := finiteGoalDeleteDate(row.SettlementBudgetMonthUtc)
	if !monthValid || month.IsZero() || !row.SettlementReservationPresent ||
		row.SettlementReservationCostUsd == "" {
		return workspace.AIUsageState{}, aiAdapterPersistenceError("locked AI Usage settlement state is invalid")
	}
	state.SettlementBudgetMonthUtc = month
	state.SettlementReservationCostUSD = row.SettlementReservationCostUsd
	return state, nil
}

func goalSuggestionStateFromSQLC(
	row *db.LockSucceededGoalRefineGenerationRow,
) (workspace.GoalSuggestionState, error) {
	if row == nil || row.TargetRevision < 0 || row.SourceText == nil || row.Output == nil {
		return workspace.GoalSuggestionState{}, aiAdapterPersistenceError("Goal suggestion state is invalid")
	}
	adoptedAt, err := optionalAITimestamptz(row.AdoptedAt)
	if err != nil {
		return workspace.GoalSuggestionState{}, err
	}
	if (adoptedAt == nil) != (row.AdoptedDraftRevision == nil) ||
		(row.AdoptedDraftRevision != nil && *row.AdoptedDraftRevision < 0) {
		return workspace.GoalSuggestionState{}, aiAdapterPersistenceError("Goal suggestion adoption state is invalid")
	}
	return workspace.GoalSuggestionState{
		TargetRevision: row.TargetRevision, SourceText: *row.SourceText, Output: *row.Output,
		AdoptedAt: adoptedAt, AdoptedDraftRevision: row.AdoptedDraftRevision,
	}, nil
}

func optionalAITimestamptz(value pgtype.Timestamptz) (*time.Time, error) {
	if !value.Valid {
		return nil, nil
	}
	result, valid := finiteGoalDeleteTimestamptz(value)
	if !valid || result.IsZero() {
		return nil, aiAdapterPersistenceError("AI timestamp is invalid or non-finite")
	}
	return &result, nil
}

func nullableAITimestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return timestamptz(*value)
}

func optionalAIUUID(value pgtype.UUID) (string, bool) {
	if !value.Valid {
		return "", true
	}
	result := uuidString(value)
	return result, result != ""
}

func validAIOperation(operation domainai.OperationType) bool {
	return operation == domainai.OperationGoalRefine ||
		operation == domainai.OperationActionGenerate ||
		operation == domainai.OperationActionRefine
}

func validAIGenerationStatus(status string) bool {
	return status == "running" || status == "succeeded" || status == "failed"
}

func aiAdapterPersistenceError(detail string) error {
	return fmt.Errorf("%w: %s", workspace.ErrGoalPersistenceInvariant, detail)
}

func goalDraftFromSQLC(row *db.GoalDraft) (goal.Draft, error) {
	if row == nil || !row.ID.Valid || !row.UserID.Valid ||
		!isFiniteGoalTimestamptz(row.CreatedAt) || !isFiniteGoalTimestamptz(row.UpdatedAt) {
		return goal.Draft{}, goalDraftPersistenceError("required identity or timestamp is missing")
	}
	id := uuidString(row.ID)
	userID := uuidString(row.UserID)
	if id == "" || userID == "" {
		return goal.Draft{}, goalDraftPersistenceError("required identity is invalid")
	}
	goalID, goalIDValid := goalDraftNullableUUID(row.GoalID)
	baseVersionID, baseVersionIDValid := goalDraftNullableUUID(row.BaseGoalVersionID)
	reviewCycleID, reviewCycleIDValid := goalDraftNullableUUID(row.ReviewCycleID)
	if !goalIDValid || !baseVersionIDValid || !reviewCycleIDValid {
		return goal.Draft{}, goalDraftPersistenceError("reference identity is invalid")
	}
	draftType := goal.DraftType(row.DraftType)
	switch draftType {
	case goal.DraftCreation:
		if goalID != nil || baseVersionID != nil || reviewCycleID != nil {
			return goal.Draft{}, goalDraftPersistenceError("Creation Draft references current work")
		}
	case goal.DraftReview:
		if goalID == nil || baseVersionID == nil || reviewCycleID == nil {
			return goal.Draft{}, goalDraftPersistenceError("Review Draft references are incomplete")
		}
	default:
		return goal.Draft{}, goalDraftPersistenceError("Draft type is invalid")
	}
	return goal.Draft{
		ID:                id,
		UserID:            userID,
		Type:              draftType,
		GoalID:            goalID,
		BaseGoalVersionID: baseVersionID,
		ReviewCycleID:     reviewCycleID,
		Body:              row.Body,
		Revision:          row.Revision,
		CreatedAt:         row.CreatedAt.Time.UTC(),
		UpdatedAt:         row.UpdatedAt.Time.UTC(),
	}, nil
}

func goalDraftNullableUUID(value pgtype.UUID) (*string, bool) {
	if !value.Valid {
		return nil, true
	}
	result := uuidString(value)
	if result == "" {
		return nil, false
	}
	return &result, true
}

func goalDraftPersistenceError(detail string) error {
	return fmt.Errorf("%w: %s", workspace.ErrGoalPersistenceInvariant, detail)
}
