package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/infrastructure/contentcrypto"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type ContentEncryptionOperator struct {
	pool       *pgxpool.Pool
	queries    *db.Queries
	repository *ContentKeyRepository
	content    contentBoundary
}

type ContentBackfillResult struct {
	Processed int64
	Conflicts int64
}

type ContentStorageInventory struct {
	Resource string `json:"resource"`
	Format   string `json:"format"`
	Rows     int64  `json:"rows"`
}

type ContentDEKInventory struct {
	Version  int32 `json:"version"`
	WriteKey bool  `json:"writeKey"`
	Keys     int64 `json:"keys"`
}

type ContentJobInventory struct {
	Operation string `json:"operation"`
	Status    string `json:"status"`
	Phase     string `json:"phase"`
	Processed int64  `json:"processed"`
	Conflicts int64  `json:"conflicts"`
	Failures  int64  `json:"failures"`
}

func (operator *ContentEncryptionOperator) Inventory(
	ctx context.Context,
) ([]ContentStorageInventory, []ContentDEKInventory, []ContentJobInventory, error) {
	storageRows, err := operator.queries.ListContentStorageInventory(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	storage := make([]ContentStorageInventory, 0, len(storageRows))
	for _, row := range storageRows {
		storage = append(storage, ContentStorageInventory{
			Resource: row.Resource, Format: row.ContentStorageFormat, Rows: row.RowCount,
		})
	}
	keyRows, err := operator.queries.ListContentDEKInventory(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	keys := make([]ContentDEKInventory, 0, len(keyRows))
	for _, row := range keyRows {
		keys = append(keys, ContentDEKInventory{
			Version: row.DekVersion, WriteKey: row.IsWriteKey, Keys: row.KeyCount,
		})
	}
	jobRows, err := operator.queries.ListRecentContentEncryptionJobs(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	jobs := make([]ContentJobInventory, 0, len(jobRows))
	for _, row := range jobRows {
		jobs = append(jobs, ContentJobInventory{
			Operation: row.Operation, Status: row.Status, Phase: row.Phase,
			Processed: row.ProcessedCount, Conflicts: row.ConflictCount, Failures: row.FailureCount,
		})
	}
	return storage, keys, jobs, nil
}

func (operator *ContentEncryptionOperator) StartJob(
	ctx context.Context,
	id, operation, phase string,
	now time.Time,
) error {
	rows, err := operator.queries.CreateContentEncryptionJob(ctx, db.CreateContentEncryptionJobParams{
		ID: mustUUID(id), Operation: operation, Phase: phase, StartedAt: timestamptz(now),
	})
	if err != nil {
		return err
	}
	if rows != 1 {
		return contentcrypto.ErrKeyringInvariant
	}
	return nil
}

func (operator *ContentEncryptionOperator) RecordJobProgress(
	ctx context.Context,
	id, phase string,
	processed, conflicts, failures int64,
	now time.Time,
) error {
	if processed < 0 || conflicts < 0 || failures < 0 {
		return contentcrypto.ErrKeyringInvariant
	}
	rows, err := operator.queries.UpdateContentEncryptionJobProgress(ctx, db.UpdateContentEncryptionJobProgressParams{
		ID: mustUUID(id), Phase: phase, ProcessedDelta: processed,
		ConflictDelta: conflicts, FailureDelta: failures, UpdatedAt: timestamptz(now),
	})
	if err != nil {
		return err
	}
	if rows != 1 {
		return contentcrypto.ErrKeyringInvariant
	}
	return nil
}

func (operator *ContentEncryptionOperator) FinishJob(
	ctx context.Context,
	id, status, phase string,
	now time.Time,
) error {
	rows, err := operator.queries.FinishContentEncryptionJob(ctx, db.FinishContentEncryptionJobParams{
		ID: mustUUID(id), Status: status, Phase: phase, CompletedAt: timestamptz(now),
	})
	if err != nil {
		return err
	}
	if rows != 1 {
		return contentcrypto.ErrKeyringInvariant
	}
	return nil
}

func NewContentEncryptionOperator(
	pool *pgxpool.Pool,
	service *contentcrypto.Service,
) *ContentEncryptionOperator {
	return &ContentEncryptionOperator{
		pool: pool, queries: db.New(pool), repository: NewContentKeyRepository(pool),
		content: contentBoundary{service: service, encryptWrites: true},
	}
}

func (operator *ContentEncryptionOperator) State(ctx context.Context) (ContentEncryptionState, error) {
	return operator.repository.State(ctx)
}

func (operator *ContentEncryptionOperator) ActivateWrites(ctx context.Context, now time.Time) error {
	return operator.repository.SetMode(ctx, contentModeEncrypting, now)
}

func (operator *ContentEncryptionOperator) EnableStrict(ctx context.Context, now time.Time) error {
	return operator.repository.SetMode(ctx, contentModeStrict, now)
}

func (operator *ContentEncryptionOperator) BackfillBatch(
	ctx context.Context,
	batchSize int,
) (ContentBackfillResult, error) {
	if batchSize < 1 || batchSize > 1000 {
		return ContentBackfillResult{}, fmt.Errorf("%w: batch size must be 1..1000", contentcrypto.ErrKeyringInvariant)
	}
	state, err := operator.State(ctx)
	if err != nil {
		return ContentBackfillResult{}, err
	}
	if state.Mode != contentModeEncrypting {
		return ContentBackfillResult{}, fmt.Errorf("%w: backfill requires encrypting mode", contentcrypto.ErrKeyringInvariant)
	}
	result := ContentBackfillResult{}
	remaining := batchSize
	apply := func(write func(*db.Queries) (int64, error)) error {
		rows, applyErr := operator.applyEncryptedWrite(ctx, write)
		if applyErr != nil {
			return applyErr
		}
		if rows == 1 {
			result.Processed++
		} else {
			result.Conflicts++
		}
		remaining--
		return nil
	}

	versions, err := operator.queries.ListLegacyGoalVersionsForEncryption(ctx, int32(remaining))
	if err != nil {
		return result, err
	}
	for _, row := range versions {
		if row.Body == nil {
			return result, contentcrypto.ErrIntegrity
		}
		userID, objectID := uuidString(row.UserID), uuidString(row.ID)
		body, encodeErr := operator.content.encode(ctx, userID, "goal_versions", objectID, "body", 1, *row.Body)
		if encodeErr != nil {
			return result, encodeErr
		}
		if err = apply(func(queries *db.Queries) (int64, error) {
			return queries.BackfillGoalVersionEncryptionCAS(ctx, db.BackfillGoalVersionEncryptionCASParams{
				Body: body, ID: row.ID, UserID: row.UserID,
			})
		}); err != nil {
			return result, err
		}
	}
	if remaining == 0 {
		return result, nil
	}

	versionSignals, err := operator.queries.ListLegacyGoalVersionSignalsForEncryption(ctx, int32(remaining))
	if err != nil {
		return result, err
	}
	for _, row := range versionSignals {
		if row.SuccessSignal == nil {
			return result, contentcrypto.ErrIntegrity
		}
		userID, objectID := uuidString(row.UserID), uuidString(row.GoalVersionID)
		signal, encodeErr := operator.content.encode(
			ctx, userID, "goal_version_success_signals", objectID, "success_signal", 1, *row.SuccessSignal,
		)
		if encodeErr != nil {
			return result, encodeErr
		}
		if err = apply(func(queries *db.Queries) (int64, error) {
			return queries.BackfillGoalVersionSignalEncryptionCAS(ctx, db.BackfillGoalVersionSignalEncryptionCASParams{
				SuccessSignal: signal, GoalVersionID: row.GoalVersionID,
			})
		}); err != nil {
			return result, err
		}
	}
	if remaining == 0 {
		return result, nil
	}

	drafts, err := operator.queries.ListLegacyGoalDraftsForEncryption(ctx, int32(remaining))
	if err != nil {
		return result, err
	}
	for _, row := range drafts {
		if row.Body == nil {
			return result, contentcrypto.ErrIntegrity
		}
		userID, objectID := uuidString(row.UserID), uuidString(row.ID)
		body, encodeErr := operator.content.encode(ctx, userID, "goal_drafts", objectID, "body", row.Revision+1, *row.Body)
		if encodeErr != nil {
			return result, encodeErr
		}
		if err = apply(func(queries *db.Queries) (int64, error) {
			return queries.BackfillGoalDraftEncryptionCAS(ctx, db.BackfillGoalDraftEncryptionCASParams{
				Body: body, ID: row.ID, UserID: row.UserID,
			})
		}); err != nil {
			return result, err
		}
	}
	if remaining == 0 {
		return result, nil
	}

	draftSignals, err := operator.queries.ListLegacyGoalDraftSignalsForEncryption(ctx, int32(remaining))
	if err != nil {
		return result, err
	}
	for _, row := range draftSignals {
		if row.SuccessSignal == nil {
			return result, contentcrypto.ErrIntegrity
		}
		userID, objectID := uuidString(row.UserID), uuidString(row.GoalDraftID)
		signal, encodeErr := operator.content.encode(
			ctx, userID, "goal_draft_success_signals", objectID, "success_signal", row.Revision+1, *row.SuccessSignal,
		)
		if encodeErr != nil {
			return result, encodeErr
		}
		if err = apply(func(queries *db.Queries) (int64, error) {
			return queries.BackfillGoalDraftSignalEncryptionCAS(ctx, db.BackfillGoalDraftSignalEncryptionCASParams{
				SuccessSignal: signal, GoalDraftID: row.GoalDraftID,
			})
		}); err != nil {
			return result, err
		}
	}
	if remaining == 0 {
		return result, nil
	}

	cycles, err := operator.queries.ListLegacyCyclesForEncryption(ctx, int32(remaining))
	if err != nil {
		return result, err
	}
	for _, row := range cycles {
		if row.Plan == nil || row.DoText == nil || row.CheckText == nil || row.Action == nil {
			return result, contentcrypto.ErrIntegrity
		}
		fields, encodeErr := operator.content.encodeCycleFields(ctx, cycleContent{
			userID: uuidString(row.UserID), cycleID: uuidString(row.ID),
			plan: *row.Plan, doText: *row.DoText, checkText: *row.CheckText, action: *row.Action,
			planRevision: row.PlanRevision, doRevision: row.DoRevision,
			checkRevision: row.CheckRevision, actionRevision: row.ActionRevision,
		})
		if encodeErr != nil {
			return result, encodeErr
		}
		if err = apply(func(queries *db.Queries) (int64, error) {
			return queries.BackfillCycleEncryptionCAS(ctx, db.BackfillCycleEncryptionCASParams{
				Plan: fields.plan, DoText: fields.doText, CheckText: fields.checkText, Action: fields.action,
				ID: row.ID, UserID: row.UserID,
			})
		}); err != nil {
			return result, err
		}
	}
	if remaining == 0 {
		return result, nil
	}

	generations, err := operator.queries.ListLegacyAIGenerationsForEncryption(ctx, int32(remaining))
	if err != nil {
		return result, err
	}
	for _, row := range generations {
		userID, objectID := uuidString(row.UserID), uuidString(row.ID)
		source, encodeErr := operator.content.encodeOptional(ctx, userID, "ai_generations", objectID, "source_text", 1, row.SourceText)
		if encodeErr != nil {
			return result, encodeErr
		}
		output, encodeErr := operator.content.encodeOptional(ctx, userID, "ai_generations", objectID, "output", 1, row.Output)
		if encodeErr != nil {
			return result, encodeErr
		}
		hash, encodeErr := operator.content.encodeOptional(
			ctx, userID, "ai_generations", objectID, "canonical_provider_input_hash", 1, row.CanonicalProviderInputHash,
		)
		if encodeErr != nil {
			return result, encodeErr
		}
		if err = apply(func(queries *db.Queries) (int64, error) {
			return queries.BackfillAIGenerationEncryptionCAS(ctx, db.BackfillAIGenerationEncryptionCASParams{
				SourceText: source, Output: output, CanonicalProviderInputHash: hash,
				ID: row.ID, UserID: row.UserID,
			})
		}); err != nil {
			return result, err
		}
	}
	return result, nil
}

func (operator *ContentEncryptionOperator) Verify(ctx context.Context, batchSize int) (int64, error) {
	if batchSize < 1 || batchSize > 1000 {
		return 0, fmt.Errorf("%w: batch size must be 1..1000", contentcrypto.ErrKeyringInvariant)
	}
	params := db.ListEncryptedContentForVerificationParams{FetchLimit: int32(batchSize)}
	var verified int64
	for {
		rows, err := operator.queries.ListEncryptedContentForVerification(ctx, params)
		if err != nil {
			return verified, err
		}
		if len(rows) == 0 {
			return verified, nil
		}
		for _, row := range rows {
			if _, err = operator.content.decode(
				ctx, uuidString(row.UserID), row.ObjectType, uuidString(row.ObjectID), row.Field, row.Stored,
			); err != nil {
				return verified, err
			}
			verified++
		}
		last := rows[len(rows)-1]
		params.AfterUserID = uuidString(last.UserID)
		params.AfterObjectType = last.ObjectType
		params.AfterObjectID = uuidString(last.ObjectID)
		params.AfterField = last.Field
	}
}

func (operator *ContentEncryptionOperator) applyEncryptedWrite(
	ctx context.Context,
	write func(*db.Queries) (int64, error),
) (int64, error) {
	tx, err := operator.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, err
	}
	defer rollback(ctx, tx)
	queries := operator.queries.WithTx(tx)
	if _, err = queries.SetEncryptedContentWriter(ctx); err != nil {
		return 0, err
	}
	rows, err := write(queries)
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return rows, nil
}
