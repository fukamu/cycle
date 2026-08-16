package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

type AIRepository struct {
	pool *pgxpool.Pool
}

func NewAIRepository(pool *pgxpool.Pool) *AIRepository {
	return &AIRepository{pool: pool}
}

func (repository *AIRepository) LoadSnapshot(ctx context.Context, userID user.ID, cycleID domaincycle.ID) (appai.Snapshot, error) {
	current, err := scanCycle(repository.pool.QueryRow(ctx, `SELECT `+cycleColumns+`
FROM pdca_cycles WHERE id = $1 AND user_id = $2 AND status = 'active'`, mustUUID(string(cycleID)), mustUUID(string(userID))))
	if err != nil {
		return appai.Snapshot{}, mapNotFound(err)
	}
	rows, err := repository.pool.Query(ctx, `SELECT `+cycleColumns+`
FROM pdca_cycles
WHERE user_id = $1 AND status = 'completed'
ORDER BY sequence_number DESC, id DESC
LIMIT 10`, mustUUID(string(userID)))
	if err != nil {
		return appai.Snapshot{}, err
	}
	defer rows.Close()
	past := make([]domaincycle.PDCACycle, 0, 10)
	for rows.Next() {
		item, scanErr := scanCycle(rows)
		if scanErr != nil {
			return appai.Snapshot{}, scanErr
		}
		past = append(past, item)
	}
	if err = rows.Err(); err != nil {
		return appai.Snapshot{}, err
	}
	return appai.Snapshot{Current: current, Past: past}, nil
}

func (repository *AIRepository) Start(ctx context.Context, input appai.StartInput) (result appai.StartResult, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)

	current, err := selectCycleForUpdate(ctx, tx, input.UserID, input.CycleID)
	if err != nil {
		return result, err
	}
	if err = recoverExpiredGenerations(ctx, tx, input.CycleID, input.Now); err != nil {
		return result, err
	}
	existing, found, err := findGenerationByIdempotency(ctx, tx, input)
	if err != nil {
		return result, err
	}
	if found {
		result.Existing = &existing
		err = tx.Commit(ctx)
		return result, err
	}

	if current.Status != domaincycle.StatusActive {
		return result, domaincycle.ErrCycleNotActive
	}
	if input.ExpectedContentRevision < 0 || current.ContentRevision != input.ExpectedContentRevision {
		return result, appai.ErrRevisionConflict
	}
	missing := missingAIFrames(current, input.GenerationType == appai.GenerationRefine)
	if len(missing) > 0 {
		return result, &appai.IncompleteError{MissingFrames: missing, Refine: input.GenerationType == appai.GenerationRefine}
	}
	if input.GenerationType == appai.GenerationGenerate && !domaincycle.IsBlank(current.Action) && !input.ConfirmReplace {
		return result, appai.ErrReplacementRequired
	}
	if running, checkErr := hasRunningAI(ctx, tx, input.CycleID); checkErr != nil {
		return result, checkErr
	} else if running {
		return result, appai.ErrOperationInProgress
	}

	var rollingCount int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM ai_usage_events
WHERE user_id = $1 AND accepted_at > $2`, mustUUID(string(input.UserID)), input.Now.Add(-24*time.Hour)).Scan(&rollingCount)
	if err != nil {
		return result, err
	}
	if rollingCount >= input.RollingLimit {
		return result, appai.ErrUserRollingLimit
	}
	for _, rate := range []struct {
		scope string
		key   []byte
		limit int
	}{
		{scope: "ai_user_minute", key: input.UserRateKey, limit: input.RatePerUserMinute},
		{scope: "ai_session_minute", key: input.SessionRateKey, limit: input.RatePerSessionMinute},
		{scope: "ai_ip_minute", key: input.IPRateKey, limit: input.RatePerIPMinute},
	} {
		if len(rate.key) == 0 {
			continue
		}
		allowed, rateErr := incrementRateBucket(ctx, tx, rate.scope, rate.key, rate.limit, input.Now)
		if rateErr != nil {
			return result, rateErr
		}
		if !allowed {
			return result, appai.ErrRateLimit
		}
	}

	_, err = tx.Exec(ctx, `INSERT INTO ai_budget_monthly(month_utc, reserved_cost_usd, actual_cost_usd, updated_at)
VALUES ($1, 0, 0, $2) ON CONFLICT (month_utc) DO NOTHING`, input.BudgetMonthUTC, input.Now)
	if err != nil {
		return result, err
	}
	var reserved, actual float64
	err = tx.QueryRow(ctx, `SELECT reserved_cost_usd, actual_cost_usd FROM ai_budget_monthly
WHERE month_utc = $1 FOR UPDATE`, input.BudgetMonthUTC).Scan(&reserved, &actual)
	if err != nil {
		return result, err
	}
	if actual+reserved+input.BudgetReservationUSD > input.MonthlyBudgetUSD {
		return result, appai.ErrServiceBudget
	}
	_, err = tx.Exec(ctx, `UPDATE ai_budget_monthly
SET reserved_cost_usd = reserved_cost_usd + $2, updated_at = $3 WHERE month_utc = $1`,
		input.BudgetMonthUTC, input.BudgetReservationUSD, input.Now)
	if err != nil {
		return result, err
	}

	contextIDs := make([]pgtype.UUID, 0, len(input.ContextCycleIDs))
	for _, id := range input.ContextCycleIDs {
		contextIDs = append(contextIDs, mustUUID(string(id)))
	}
	_, err = tx.Exec(ctx, `INSERT INTO ai_generations (
    id, user_id, cycle_id, generation_type, status, provider, model, prompt_version,
    current_content_revision, idempotency_key, input_hash, refine_source_action,
    context_cycle_ids, budget_month_utc, budget_reserved_cost_usd, attempt_count,
    lease_expires_at, started_at
) VALUES ($1,$2,$3,$4,'running',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16)`,
		mustUUID(input.GenerationID), mustUUID(string(input.UserID)), mustUUID(string(input.CycleID)), string(input.GenerationType),
		input.Provider, input.Model, input.PromptVersion, input.ExpectedContentRevision, mustUUID(input.IdempotencyKey),
		input.InputHash, input.RefineSourceAction, contextIDs, input.BudgetMonthUTC, input.BudgetReservationUSD,
		input.LeaseExpiresAt, input.Now)
	if err != nil {
		if isUniqueViolation(err) {
			return result, appai.ErrOperationInProgress
		}
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO ai_usage_events (
    id, user_id, generation_id, generation_type, accepted_at, status
) VALUES ($1,$2,$3,$4,$5,'accepted')`,
		mustUUID(input.UsageEventID), mustUUID(string(input.UserID)), mustUUID(input.GenerationID), string(input.GenerationType), input.Now)
	if err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}

func (repository *AIRepository) Succeed(ctx context.Context, input appai.SuccessInput) (result appai.Result, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)

	current, err := selectCycleForUpdate(ctx, tx, input.UserID, input.CycleID)
	if errors.Is(err, appcycle.ErrCycleNotFound) {
		return result, appai.ErrTargetGone
	}
	if err != nil {
		return result, err
	}
	var status string
	var generationRevision int64
	var budgetMonth time.Time
	var reservation float64
	err = tx.QueryRow(ctx, `SELECT status, current_content_revision, budget_month_utc, budget_reserved_cost_usd
FROM ai_generations WHERE id = $1 AND user_id = $2 AND cycle_id = $3 FOR UPDATE`,
		mustUUID(input.GenerationID), mustUUID(string(input.UserID)), mustUUID(string(input.CycleID))).Scan(
		&status, &generationRevision, &budgetMonth, &reservation)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, appai.ErrTargetGone
	}
	if err != nil {
		return result, err
	}
	if status != "running" {
		return result, appai.ErrOperationInProgress
	}
	if generationRevision != input.GenerationRevision {
		return result, appai.ErrRevisionConflict
	}
	applied, err := domaincycle.ApplyAIAction(current, input.Action, generationRevision, input.Now)
	if err != nil {
		return result, err
	}
	command, err := tx.Exec(ctx, `UPDATE pdca_cycles SET
action = $4, action_revision = action_revision + 1, content_revision = content_revision + 1,
action_last_ai_applied_content_revision = content_revision + 1,
action_user_modified_after_ai = false, updated_at = $5
WHERE id = $1 AND user_id = $2 AND status = 'active' AND action_revision = $3`,
		mustUUID(string(input.CycleID)), mustUUID(string(input.UserID)), current.ActionRevision, applied.Cycle.Action, input.Now)
	if err != nil {
		return result, err
	}
	if command.RowsAffected() != 1 {
		return result, appai.ErrTargetGone
	}
	_, err = tx.Exec(ctx, `UPDATE ai_generations SET status='succeeded', output=$2,
input_tokens=$3, output_tokens=$4, estimated_cost_usd=$5, budget_reserved_cost_usd=0,
attempt_count=$6, provider_request_id=$7, lease_expires_at=NULL, finished_at=$8
WHERE id=$1 AND status='running'`, mustUUID(input.GenerationID), applied.Cycle.Action,
		input.Usage.InputTokens, input.Usage.OutputTokens, input.EstimatedCostUSD, input.AttemptCount,
		nullIfEmpty(input.Usage.ProviderRequestID), input.Now)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `UPDATE ai_usage_events SET status='succeeded', input_tokens=$2,
output_tokens=$3, estimated_cost_usd=$4 WHERE generation_id=$1`, mustUUID(input.GenerationID),
		input.Usage.InputTokens, input.Usage.OutputTokens, input.EstimatedCostUSD)
	if err != nil {
		return result, err
	}
	if err = settleBudget(ctx, tx, budgetMonth, reservation, input.EstimatedCostUSD, input.Now); err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return appai.Result{
		GenerationID: input.GenerationID, Action: applied.Cycle.Action,
		ContentRevision: applied.Cycle.ContentRevision, ActionRevision: applied.Cycle.ActionRevision,
		ContextChanged: applied.ContextChanged,
	}, nil
}

func (repository *AIRepository) Fail(ctx context.Context, input appai.FailureInput) (err error) {
	var cycleID pgtype.UUID
	err = repository.pool.QueryRow(ctx, `SELECT cycle_id FROM ai_generations WHERE id=$1`, mustUUID(input.GenerationID)).Scan(&cycleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollbackOnError(ctx, tx, &err)
	if _, err = tx.Exec(ctx, `SELECT 1 FROM pdca_cycles WHERE id=$1 FOR UPDATE`, cycleID); err != nil {
		return err
	}
	var status string
	var budgetMonth time.Time
	var reservation float64
	err = tx.QueryRow(ctx, `SELECT status, budget_month_utc, budget_reserved_cost_usd
FROM ai_generations WHERE id=$1 FOR UPDATE`, mustUUID(input.GenerationID)).Scan(&status, &budgetMonth, &reservation)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if status != "running" {
		err = tx.Commit(ctx)
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE ai_generations SET status='failed', failure_code=$2,
input_tokens=$3, output_tokens=$4, estimated_cost_usd=$5, budget_reserved_cost_usd=0,
attempt_count=$6, provider_request_id=$7, lease_expires_at=NULL, finished_at=$8
WHERE id=$1 AND status='running'`, mustUUID(input.GenerationID), input.FailureCode,
		input.Usage.InputTokens, input.Usage.OutputTokens, input.EstimatedCostUSD, max(input.AttemptCount, 1),
		nullIfEmpty(input.Usage.ProviderRequestID), input.Now)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE ai_usage_events SET status='failed', input_tokens=$2,
output_tokens=$3, estimated_cost_usd=$4 WHERE generation_id=$1`, mustUUID(input.GenerationID),
		input.Usage.InputTokens, input.Usage.OutputTokens, input.EstimatedCostUSD)
	if err != nil {
		return err
	}
	if err = settleBudget(ctx, tx, budgetMonth, reservation, input.EstimatedCostUSD, input.Now); err != nil {
		return err
	}
	err = tx.Commit(ctx)
	return err
}

func findGenerationByIdempotency(ctx context.Context, tx pgx.Tx, input appai.StartInput) (appai.ExistingGeneration, bool, error) {
	var generation appai.ExistingGeneration
	var generationID pgtype.UUID
	var cycleID pgtype.UUID
	var output, failureCode *string
	err := tx.QueryRow(ctx, `SELECT id, status, output, failure_code, cycle_id
FROM ai_generations WHERE user_id=$1 AND generation_type=$2 AND idempotency_key=$3`,
		mustUUID(string(input.UserID)), string(input.GenerationType), mustUUID(input.IdempotencyKey)).Scan(
		&generationID, &generation.Status, &output, &failureCode, &cycleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return generation, false, nil
	}
	if err != nil {
		return generation, false, err
	}
	generation.GenerationID = uuidString(generationID)
	if uuidString(cycleID) != string(input.CycleID) {
		return generation, false, appai.ErrRevisionConflict
	}
	if output != nil {
		generation.Output = *output
	}
	if failureCode != nil {
		generation.FailureCode = *failureCode
	}
	cycle, cycleErr := scanCycle(tx.QueryRow(ctx, `SELECT `+cycleColumns+`
FROM pdca_cycles WHERE id=$1 AND user_id=$2`, cycleID, mustUUID(string(input.UserID))))
	if cycleErr == nil {
		generation.Cycle = cycle
	} else if !errors.Is(cycleErr, pgx.ErrNoRows) {
		return generation, false, cycleErr
	}
	return generation, true, nil
}

func recoverExpiredGenerations(ctx context.Context, tx pgx.Tx, cycleID domaincycle.ID, now time.Time) error {
	rows, err := tx.Query(ctx, `SELECT id, budget_month_utc, budget_reserved_cost_usd
FROM ai_generations WHERE cycle_id=$1 AND status='running' AND lease_expires_at < $2 FOR UPDATE`,
		mustUUID(string(cycleID)), now)
	if err != nil {
		return err
	}
	type expired struct {
		id          pgtype.UUID
		budgetMonth time.Time
		reservation float64
	}
	items := make([]expired, 0)
	for rows.Next() {
		var item expired
		if err = rows.Scan(&item.id, &item.budgetMonth, &item.reservation); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, item := range items {
		if _, err = tx.Exec(ctx, `UPDATE ai_budget_monthly SET
reserved_cost_usd = reserved_cost_usd - $2, updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2`, item.budgetMonth, item.reservation, now); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_generations SET status='failed', failure_code='timeout_recovered',
budget_reserved_cost_usd=0, lease_expires_at=NULL, finished_at=$2 WHERE id=$1`, item.id, now); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_usage_events SET status='failed' WHERE generation_id=$1`, item.id); err != nil {
			return err
		}
	}
	return nil
}

func incrementRateBucket(ctx context.Context, tx pgx.Tx, scope string, key []byte, limit int, now time.Time) (bool, error) {
	window := now.UTC().Truncate(time.Minute)
	var count int
	err := tx.QueryRow(ctx, `INSERT INTO abuse_rate_buckets(scope,key_hash,window_start,request_count,expires_at)
VALUES($1,$2,$3,1,$4)
ON CONFLICT(scope,key_hash,window_start) DO UPDATE
SET request_count=abuse_rate_buckets.request_count+1, expires_at=EXCLUDED.expires_at
RETURNING request_count`, scope, key, window, window.Add(2*time.Minute)).Scan(&count)
	return count <= limit, err
}

func settleBudget(ctx context.Context, tx pgx.Tx, month time.Time, reservation, actual float64, now time.Time) error {
	command, err := tx.Exec(ctx, `UPDATE ai_budget_monthly SET
reserved_cost_usd = reserved_cost_usd - $2,
actual_cost_usd = actual_cost_usd + $3,
updated_at = $4
WHERE month_utc=$1 AND reserved_cost_usd >= $2`, month, reservation, actual, now)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("AI budget reservation settlement invariant failed")
	}
	return nil
}

func missingAIFrames(current domaincycle.PDCACycle, refine bool) []domaincycle.Frame {
	missing := make([]domaincycle.Frame, 0, 4)
	for _, frame := range []domaincycle.Frame{domaincycle.FramePlan, domaincycle.FrameDo, domaincycle.FrameCheck} {
		if domaincycle.IsBlank(current.FrameContent(frame)) {
			missing = append(missing, frame)
		}
	}
	if refine && domaincycle.IsBlank(current.Action) {
		missing = append(missing, domaincycle.FrameAction)
	}
	return missing
}

func isUniqueViolation(err error) bool {
	var databaseError *pgconn.PgError
	return errors.As(err, &databaseError) && databaseError.Code == "23505"
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
