package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
	db "github.com/matoruru/PDCAI/backend/internal/infrastructure/postgres/generated"
)

const cycleColumns = `
id, user_id, sequence_number, status, started_at, completed_at,
plan, do_text, check_text, action,
content_revision, plan_revision, do_revision, check_revision, action_revision,
action_last_ai_applied_content_revision, action_user_modified_after_ai,
completion_operation_id, created_at, updated_at`

type CycleRepository struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

func NewCycleRepository(pool *pgxpool.Pool) *CycleRepository {
	return &CycleRepository{pool: pool, queries: db.New(pool)}
}

func (repository *CycleRepository) GetActive(ctx context.Context, userID user.ID) (domaincycle.PDCACycle, error) {
	row, err := repository.queries.GetActiveCycle(ctx, mustUUID(string(userID)))
	if err != nil {
		return domaincycle.PDCACycle{}, mapNotFound(err)
	}
	return cycleFromDB(row), nil
}

func (repository *CycleRepository) GetOwned(ctx context.Context, userID user.ID, cycleID domaincycle.ID) (domaincycle.PDCACycle, error) {
	row, err := repository.queries.GetOwnedCycle(ctx, db.GetOwnedCycleParams{
		ID:     mustUUID(string(cycleID)),
		UserID: mustUUID(string(userID)),
	})
	if err != nil {
		return domaincycle.PDCACycle{}, mapNotFound(err)
	}
	return cycleFromDB(row), nil
}

func (repository *CycleRepository) ListCompleted(ctx context.Context, userID user.ID, cursor *appcycle.Cursor, limit int32) ([]domaincycle.PDCACycle, error) {
	params := db.ListCompletedCyclesParams{UserID: mustUUID(string(userID)), Limit: limit}
	if cursor != nil {
		params.AfterSequenceNumber = &cursor.SequenceNumber
		params.AfterCycleID = mustUUID(cursor.CycleID)
	}
	rows, err := repository.queries.ListCompletedCycles(ctx, params)
	if err != nil {
		return nil, err
	}
	result := make([]domaincycle.PDCACycle, 0, len(rows))
	for _, row := range rows {
		result = append(result, cycleFromDB(row))
	}
	return result, nil
}

func (repository *CycleRepository) SaveFrame(ctx context.Context, input appcycle.SaveFrameInput) (result domaincycle.SaveFrameResult, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)

	current, err := selectCycleForUpdate(ctx, tx, input.UserID, input.CycleID)
	if err != nil {
		return result, err
	}
	aiRunning, err := hasRunningAI(ctx, tx, input.CycleID)
	if err != nil {
		return result, err
	}
	result, err = domaincycle.SaveFrame(current, input.Frame, input.Content, input.ExpectedFrameRevision, aiRunning, input.Now)
	if err != nil {
		return result, err
	}
	if result.NoOp {
		err = tx.Commit(ctx)
		return result, err
	}

	query, args := saveFrameStatement(input, result.Cycle)
	commandTag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return result, err
	}
	if commandTag.RowsAffected() != 1 {
		return result, domaincycle.ErrRevisionConflict
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func (repository *CycleRepository) Complete(ctx context.Context, input appcycle.CompleteInput) (result domaincycle.CompleteResult, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)

	if existing, found, findErr := findCompletionByOperation(ctx, tx, input.UserID, input.OperationID); findErr != nil {
		return result, findErr
	} else if found {
		next, nextErr := selectCycleBySequence(ctx, tx, input.UserID, existing.SequenceNumber+1)
		if nextErr != nil {
			return result, nextErr
		}
		if err = tx.Commit(ctx); err != nil {
			return result, err
		}
		return domaincycle.CompleteResult{Completed: existing, Next: next}, nil
	}

	current, err := selectCycleForUpdate(ctx, tx, input.UserID, input.CycleID)
	if err != nil {
		return result, err
	}
	if current.Status == domaincycle.StatusCompleted && current.CompletionOperationID != nil && *current.CompletionOperationID == input.OperationID {
		next, nextErr := selectCycleBySequence(ctx, tx, input.UserID, current.SequenceNumber+1)
		if nextErr != nil {
			return result, nextErr
		}
		if err = tx.Commit(ctx); err != nil {
			return result, err
		}
		return domaincycle.CompleteResult{Completed: current, Next: next}, nil
	}
	aiRunning, err := hasRunningAI(ctx, tx, input.CycleID)
	if err != nil {
		return result, err
	}
	result, err = domaincycle.Complete(current, input.Now, input.NextCycleID, input.OperationID, input.ExpectedContentRevision, aiRunning)
	if err != nil {
		return result, err
	}
	commandTag, err := tx.Exec(ctx, `
UPDATE pdca_cycles
SET status = 'completed', completed_at = $4, completion_operation_id = $5, updated_at = $4
WHERE id = $1 AND user_id = $2 AND status = 'active' AND content_revision = $3`,
		mustUUID(string(input.CycleID)), mustUUID(string(input.UserID)), input.ExpectedContentRevision,
		input.Now.UTC(), mustUUID(string(input.OperationID)))
	if err != nil {
		return result, err
	}
	if commandTag.RowsAffected() != 1 {
		return result, domaincycle.ErrRevisionConflict
	}
	if err = insertNextCycle(ctx, tx, result.Next); err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func selectCycleForUpdate(ctx context.Context, tx pgx.Tx, userID user.ID, cycleID domaincycle.ID) (domaincycle.PDCACycle, error) {
	row := tx.QueryRow(ctx, `SELECT `+cycleColumns+`
FROM pdca_cycles WHERE id = $1 AND user_id = $2 FOR UPDATE`, mustUUID(string(cycleID)), mustUUID(string(userID)))
	result, err := scanCycle(row)
	if err != nil {
		return domaincycle.PDCACycle{}, mapNotFound(err)
	}
	return result, nil
}

func hasRunningAI(ctx context.Context, tx pgx.Tx, cycleID domaincycle.ID) (bool, error) {
	var result bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM ai_generations WHERE cycle_id = $1 AND status = 'running'
)`, mustUUID(string(cycleID))).Scan(&result)
	return result, err
}

func saveFrameStatement(input appcycle.SaveFrameInput, updated domaincycle.PDCACycle) (string, []any) {
	baseArguments := []any{mustUUID(string(input.CycleID)), mustUUID(string(input.UserID)), input.ExpectedFrameRevision, input.Now.UTC()}
	switch input.Frame {
	case domaincycle.FramePlan:
		return `UPDATE pdca_cycles SET plan = $5, plan_revision = plan_revision + 1, content_revision = content_revision + 1, updated_at = $4
WHERE id = $1 AND user_id = $2 AND status = 'active' AND plan_revision = $3`, append(baseArguments, updated.Plan)
	case domaincycle.FrameDo:
		return `UPDATE pdca_cycles SET do_text = $5, do_revision = do_revision + 1, content_revision = content_revision + 1, updated_at = $4
WHERE id = $1 AND user_id = $2 AND status = 'active' AND do_revision = $3`, append(baseArguments, updated.Do)
	case domaincycle.FrameCheck:
		return `UPDATE pdca_cycles SET check_text = $5, check_revision = check_revision + 1, content_revision = content_revision + 1, updated_at = $4
WHERE id = $1 AND user_id = $2 AND status = 'active' AND check_revision = $3`, append(baseArguments, updated.Check)
	case domaincycle.FrameAction:
		return `UPDATE pdca_cycles SET action = $5, action_revision = action_revision + 1, content_revision = content_revision + 1,
action_user_modified_after_ai = $6, updated_at = $4
WHERE id = $1 AND user_id = $2 AND status = 'active' AND action_revision = $3
AND NOT EXISTS (SELECT 1 FROM ai_generations WHERE cycle_id = $1 AND status = 'running')`, append(baseArguments, updated.Action, updated.ActionUserModifiedAfterAI)
	default:
		panic("invalid frame reached PostgreSQL adapter")
	}
}

func findCompletionByOperation(ctx context.Context, tx pgx.Tx, userID user.ID, operationID domaincycle.OperationID) (domaincycle.PDCACycle, bool, error) {
	row := tx.QueryRow(ctx, `SELECT `+cycleColumns+`
FROM pdca_cycles WHERE user_id = $1 AND completion_operation_id = $2`, mustUUID(string(userID)), mustUUID(string(operationID)))
	result, err := scanCycle(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domaincycle.PDCACycle{}, false, nil
	}
	return result, err == nil, err
}

func selectCycleBySequence(ctx context.Context, tx pgx.Tx, userID user.ID, sequence int32) (domaincycle.PDCACycle, error) {
	row := tx.QueryRow(ctx, `SELECT `+cycleColumns+`
FROM pdca_cycles WHERE user_id = $1 AND sequence_number = $2`, mustUUID(string(userID)), sequence)
	return scanCycle(row)
}

func insertNextCycle(ctx context.Context, tx pgx.Tx, next domaincycle.PDCACycle) error {
	_, err := tx.Exec(ctx, `
INSERT INTO pdca_cycles (
    id, user_id, sequence_number, status, started_at,
    plan, do_text, check_text, action,
    content_revision, plan_revision, do_revision, check_revision, action_revision,
    action_user_modified_after_ai, created_at, updated_at
) VALUES ($1, $2, $3, 'active', $4, '', '', '', '', 0, 0, 0, 0, 0, false, $4, $4)`,
		mustUUID(string(next.ID)), mustUUID(string(next.UserID)), next.SequenceNumber, next.StartedAt)
	return err
}

type rowScanner interface {
	Scan(...any) error
}

func scanCycle(row rowScanner) (domaincycle.PDCACycle, error) {
	var raw db.PdcaCycle
	err := row.Scan(
		&raw.ID, &raw.UserID, &raw.SequenceNumber, &raw.Status, &raw.StartedAt, &raw.CompletedAt,
		&raw.Plan, &raw.DoText, &raw.CheckText, &raw.Action,
		&raw.ContentRevision, &raw.PlanRevision, &raw.DoRevision, &raw.CheckRevision, &raw.ActionRevision,
		&raw.ActionLastAiAppliedContentRevision, &raw.ActionUserModifiedAfterAi,
		&raw.CompletionOperationID, &raw.CreatedAt, &raw.UpdatedAt,
	)
	if err != nil {
		return domaincycle.PDCACycle{}, err
	}
	return cycleFromDB(&raw), nil
}

func cycleFromDB(raw *db.PdcaCycle) domaincycle.PDCACycle {
	result := domaincycle.PDCACycle{
		ID:                                 domaincycle.ID(uuidString(raw.ID)),
		UserID:                             user.ID(uuidString(raw.UserID)),
		SequenceNumber:                     raw.SequenceNumber,
		Status:                             domaincycle.Status(raw.Status),
		StartedAt:                          raw.StartedAt.Time,
		Plan:                               raw.Plan,
		Do:                                 raw.DoText,
		Check:                              raw.CheckText,
		Action:                             raw.Action,
		ContentRevision:                    raw.ContentRevision,
		PlanRevision:                       raw.PlanRevision,
		DoRevision:                         raw.DoRevision,
		CheckRevision:                      raw.CheckRevision,
		ActionRevision:                     raw.ActionRevision,
		ActionLastAIAppliedContentRevision: raw.ActionLastAiAppliedContentRevision,
		ActionUserModifiedAfterAI:          raw.ActionUserModifiedAfterAi,
		CreatedAt:                          raw.CreatedAt.Time,
		UpdatedAt:                          raw.UpdatedAt.Time,
	}
	if raw.CompletedAt.Valid {
		completedAt := raw.CompletedAt.Time
		result.CompletedAt = &completedAt
	}
	if raw.CompletionOperationID.Valid {
		operationID := domaincycle.OperationID(uuidString(raw.CompletionOperationID))
		result.CompletionOperationID = &operationID
	}
	return result
}

func mapNotFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return appcycle.ErrCycleNotFound
	}
	return err
}

func rollbackOnError(ctx context.Context, tx pgx.Tx, err *error) {
	if *err != nil {
		_ = tx.Rollback(ctx)
	}
}
