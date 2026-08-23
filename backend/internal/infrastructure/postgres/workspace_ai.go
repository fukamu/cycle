package postgres

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

func (store *WorkspaceStore) BeginActionAI(ctx context.Context, input workspace.ActionAIInput, selectContext workspace.AIContextSelector) (snapshot workspace.AISnapshot, err error) {
	if input.Operation != "action_generate" && input.Operation != "action_refine" {
		return snapshot, workspace.ErrAIInputIncomplete
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return snapshot, err
	}
	defer rollback(ctx, tx)
	if err = lockUser(ctx, tx, user.ID(input.UserID)); errors.Is(err, pgx.ErrNoRows) {
		return snapshot, workspace.ErrNotFound
	} else if err != nil {
		return snapshot, err
	}
	inputHash := hashActionAIRequest(input)
	replayed, replayErr := existingActionGeneration(ctx, tx, input, inputHash)
	if replayErr != nil {
		var inProgress *workspace.AIOperationInProgressError
		if !errors.As(replayErr, &inProgress) {
			return snapshot, replayErr
		}
		expired, expiredErr := actionGenerationLeaseExpired(ctx, tx, input.UserID, inProgress.GenerationID, input.Now)
		if expiredErr != nil {
			return snapshot, expiredErr
		}
		if !expired {
			return snapshot, replayErr
		}
		if err = lockActionAITargetForExpiredReplay(ctx, tx, input); err != nil {
			return snapshot, err
		}
		if err = store.recoverExpiredAI(ctx, tx, input.UserID, input.Now); err != nil {
			return snapshot, err
		}
		recovered, recoveredErr := existingActionGeneration(ctx, tx, input, inputHash)
		if recoveredErr == nil && recovered == nil {
			return snapshot, errors.New("expired Action AI replay disappeared after lease recovery")
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return snapshot, commitErr
		}
		if recoveredErr != nil {
			return snapshot, recoveredErr
		}
		return *recovered, nil
	}
	if replayed != nil {
		return *replayed, tx.Commit(ctx)
	}
	var goalStatus goal.Status
	var versionID, goalBody string
	err = tx.QueryRow(ctx, `SELECT g.status,gv.id,gv.body FROM goals g
JOIN goal_versions gv ON gv.goal_id=g.id AND gv.version_number=g.current_version_number
WHERE g.id=$1 AND g.user_id=$2 FOR UPDATE`, mustUUID(input.GoalID), mustUUID(input.UserID)).Scan(&goalStatus, &versionID, &goalBody)
	if errors.Is(err, pgx.ErrNoRows) {
		return snapshot, workspace.ErrNotFound
	}
	if err != nil {
		return snapshot, err
	}
	if goalStatus != goal.StatusActiveCycle {
		return snapshot, workspace.ErrGoalStateConflict
	}
	current, err := loadCycleForUpdate(ctx, tx, input.UserID, input.GoalID, input.CycleID)
	if err != nil {
		return snapshot, err
	}
	if current.GoalVersionID != versionID {
		return snapshot, workspace.ErrGoalVersionConflict
	}
	if current.Revisions.Content != input.ExpectedContentRevision {
		return snapshot, cycle.ErrRevisionConflict
	}
	if cycle.IsBlank(current.Plan) || cycle.IsBlank(current.Do) || cycle.IsBlank(current.Check) {
		return snapshot, workspace.ErrAIInputIncomplete
	}
	if input.Operation == "action_refine" && cycle.IsBlank(current.Action) {
		return snapshot, workspace.ErrAIInputIncomplete
	}
	if input.Operation == "action_generate" && !cycle.IsBlank(current.Action) && !input.ConfirmReplace {
		return snapshot, workspace.ErrAIReplacementRequired
	}
	past, err := loadAIContextCycles(ctx, tx, input.UserID, input.GoalID, input.CycleID, 10)
	if err != nil {
		return snapshot, err
	}
	currentContext := &workspace.AIContextCycle{
		ID: current.ID, GoalID: current.GoalID, SequenceNumber: current.SequenceNumber,
		Status: current.Status, GoalBody: goalBody, Plan: current.Plan, Do: current.Do, Check: current.Check, Action: current.Action,
	}
	promptVersion := store.settings.GeneratePromptVersion
	var sourceText *string
	if input.Operation == "action_refine" {
		promptVersion = store.settings.RefinePromptVersion
		sourceText = &current.Action
	}
	snapshot = workspace.AISnapshot{
		GenerationID: input.GenerationID, Operation: input.Operation, TargetRevision: current.Revisions.Content,
		GoalID: input.GoalID, GoalBody: goalBody, SourceText: pointerValue(sourceText), PastCycles: past,
		CurrentCycle: currentContext,
	}
	if selectContext == nil {
		return workspace.AISnapshot{}, workspace.ErrAIInputBudget
	}
	snapshot, err = selectContext(ctx, snapshot)
	if err != nil {
		return workspace.AISnapshot{}, err
	}
	if err = store.reserveAI(ctx, tx, input.UserID, input.GenerationID, input.Operation, input.IdempotencyKey,
		inputHash, "", &input.GoalID, &versionID, &input.CycleID, current.Revisions.Content, pointerValue(sourceText), promptVersion,
		contextCycleIDs(snapshot.PastCycles), input.SessionID, input.RemoteAddress, input.Now); err != nil {
		return snapshot, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.AISnapshot{}, err
	}
	return snapshot, nil
}

func (store *WorkspaceStore) reserveAI(ctx context.Context, tx pgx.Tx, userID, generationID, operation, key,
	inputHash, draftID string, goalID, versionID, cycleID *string, targetRevision int64, sourceText, promptVersion string,
	contextIDs []string, sessionID, remoteAddress string, now time.Time) error {
	if err := store.recoverExpiredAI(ctx, tx, userID, now); err != nil {
		return err
	}
	var running bool
	if draftID != "" {
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations WHERE source_goal_draft_id=$1 AND status='running')`, mustUUID(draftID)).Scan(&running); err != nil {
			return err
		}
	} else if cycleID != nil {
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations WHERE cycle_id=$1 AND status='running')`, mustUUID(*cycleID)).Scan(&running); err != nil {
			return err
		}
	}
	if running {
		return workspace.ErrAIInProgress
	}
	var usageCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM ai_usage_events WHERE user_id=$1 AND accepted_at>$2`, mustUUID(userID), now.Add(-24*time.Hour)).Scan(&usageCount); err != nil {
		return err
	}
	if usageCount >= store.settings.RollingLimit {
		return workspace.ErrAIUserLimit
	}
	month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	if _, err := tx.Exec(ctx, `INSERT INTO ai_budget_monthly(month_utc,reserved_cost_usd,actual_cost_usd,unattributed_cost_usd,updated_at)
VALUES($1,0,0,0,$2) ON CONFLICT(month_utc) DO NOTHING`, month, now); err != nil {
		return err
	}
	var reserved, actual, unattributed float64
	if err := tx.QueryRow(ctx, `SELECT reserved_cost_usd,actual_cost_usd,unattributed_cost_usd
FROM ai_budget_monthly WHERE month_utc=$1 FOR UPDATE`, month).Scan(&reserved, &actual, &unattributed); err != nil {
		return err
	}
	if err := store.checkAIRateLimits(ctx, tx, userID, sessionID, remoteAddress, now); err != nil {
		return err
	}
	if reserved+actual+unattributed+store.settings.ReservationUSD > store.settings.MonthlyBudgetUSD {
		return workspace.ErrAIBudget
	}
	command, err := tx.Exec(ctx, `UPDATE ai_budget_monthly SET reserved_cost_usd=reserved_cost_usd+$2,updated_at=$3
WHERE month_utc=$1`, month, store.settings.ReservationUSD, now)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("AI budget reservation row disappeared after lock")
	}
	var draftArg, goalArg, versionArg, cycleArg any
	if draftID != "" {
		draftArg = mustUUID(draftID)
	}
	if goalID != nil {
		goalArg = mustUUID(*goalID)
	}
	if versionID != nil {
		versionArg = mustUUID(*versionID)
	}
	if cycleID != nil {
		cycleArg = mustUUID(*cycleID)
	}
	var sourceArg any
	if operation != "action_generate" {
		sourceArg = sourceText
	}
	_, err = tx.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,goal_id,goal_version_id,cycle_id,target_revision,idempotency_key,input_hash,
source_text,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at,context_cycle_ids)
VALUES($1,$2,$3,'running',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::text[]::uuid[])`,
		mustUUID(generationID), mustUUID(userID), operation, draftArg, goalArg, versionArg, cycleArg, targetRevision,
		mustUUID(key), inputHash, sourceArg, store.settings.Provider, store.settings.Model, promptVersion,
		month, store.settings.ReservationUSD, now.Add(store.settings.LeaseDuration), now, contextIDs)
	if err != nil {
		if isUniqueViolation(err) {
			return workspace.ErrAIInProgress
		}
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES($1,$2,$3,$4,'accepted',$5,$6,$7,$8,$9)`, mustUUID(generationID), mustUUID(userID), goalArg,
		operation, store.settings.Provider, store.settings.Model, promptVersion, now, now.Add(24*time.Hour))
	return err
}

func actionGenerationLeaseExpired(ctx context.Context, tx pgx.Tx, userID, generationID string, now time.Time) (bool, error) {
	var expired bool
	err := tx.QueryRow(ctx, `SELECT COALESCE(lease_expires_at<=$3,false)
FROM ai_generations WHERE id=$1 AND user_id=$2 AND status='running'`,
		mustUUID(generationID), mustUUID(userID), now).Scan(&expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, errors.New("running Action AI replay disappeared while User lock was held")
	}
	return expired, err
}

func lockActionAITargetForExpiredReplay(ctx context.Context, tx pgx.Tx, input workspace.ActionAIInput) error {
	var marker int
	err := tx.QueryRow(ctx, `SELECT 1 FROM goals WHERE id=$1 AND user_id=$2 FOR UPDATE`,
		mustUUID(input.GoalID), mustUUID(input.UserID)).Scan(&marker)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.ErrNotFound
	}
	if err != nil {
		return err
	}
	_, err = loadCycleForUpdate(ctx, tx, input.UserID, input.GoalID, input.CycleID)
	return err
}

func existingActionGeneration(ctx context.Context, tx pgx.Tx, input workspace.ActionAIInput, inputHash string) (*workspace.AISnapshot, error) {
	var generationID, status, goalID, cycleID, storedHash, failureCode string
	var target int64
	var output *string
	var contextChanged bool
	err := tx.QueryRow(ctx, `SELECT id,status,target_revision,output,COALESCE(failure_code,''),goal_id,cycle_id,input_hash,context_changed
FROM ai_generations WHERE user_id=$1 AND operation_type=$2 AND idempotency_key=$3`,
		mustUUID(input.UserID), input.Operation, mustUUID(input.IdempotencyKey)).Scan(
		&generationID, &status, &target, &output, &failureCode, &goalID, &cycleID, &storedHash, &contextChanged)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if storedHash != inputHash || goalID != input.GoalID || cycleID != input.CycleID || target != input.ExpectedContentRevision {
		return nil, workspace.ErrIdempotencyKeyReused
	}
	if status == "running" {
		return nil, &workspace.AIOperationInProgressError{GenerationID: generationID}
	}
	if status == "failed" {
		return nil, aiFailureError(failureCode)
	}
	if output == nil {
		return nil, workspace.ErrAIInvalidResponse
	}
	var contentRevision, actionRevision int64
	err = tx.QueryRow(ctx, `SELECT content_revision,action_revision FROM pdca_cycles
WHERE id=$1 AND goal_id=$2 AND user_id=$3`, mustUUID(cycleID), mustUUID(input.GoalID), mustUUID(input.UserID)).Scan(
		&contentRevision, &actionRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, workspace.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &workspace.AISnapshot{
		GenerationID: generationID, Operation: input.Operation, TargetRevision: target, ReplayedOutput: output,
		ReplayedContextChanged: contextChanged, ReplayedContentRevision: contentRevision,
		ReplayedActionRevision: actionRevision,
	}, nil
}

func aiFailureError(code string) error {
	switch code {
	case "invalid_response":
		return workspace.ErrAIInvalidResponse
	case "provider_timeout":
		return workspace.ErrAIProviderTimeout
	case "target_deleted":
		return workspace.ErrNotFound
	case "goal_version_conflict":
		return workspace.ErrGoalVersionConflict
	default:
		return workspace.ErrAIProviderUnavailable
	}
}

type aiGenerationLocator struct {
	userID    string
	operation string
	status    string
	draftID   string
	goalID    string
	cycleID   string
}

func loadAIGenerationLocator(ctx context.Context, tx pgx.Tx, generationID string) (aiGenerationLocator, error) {
	var locator aiGenerationLocator
	var draftID, goalID, cycleID pgtype.UUID
	err := tx.QueryRow(ctx, `SELECT user_id,operation_type,status,source_goal_draft_id,goal_id,cycle_id
FROM ai_generations WHERE id=$1`, mustUUID(generationID)).Scan(
		&locator.userID, &locator.operation, &locator.status, &draftID, &goalID, &cycleID,
	)
	if err != nil {
		return aiGenerationLocator{}, err
	}
	locator.draftID = uuidString(draftID)
	locator.goalID = uuidString(goalID)
	locator.cycleID = uuidString(cycleID)
	return locator, nil
}

func lockAIFinalizationUser(ctx context.Context, tx pgx.Tx, userID string) error {
	err := lockUser(ctx, tx, user.ID(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.ErrNotFound
	}
	return err
}

func (store *WorkspaceStore) settleMissingAIResult(
	ctx context.Context,
	tx pgx.Tx,
	generationID string,
	result workspace.AIProviderResult,
	providerErr error,
	now time.Time,
) error {
	if err := store.settleLateUsage(ctx, tx, generationID, result, providerErr, now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return workspace.ErrNotFound
}

func (store *WorkspaceStore) FinishActionAI(ctx context.Context, snapshot workspace.AISnapshot, result workspace.AIProviderResult, providerErr error, now time.Time) (workspace.AIResponse, error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return workspace.AIResponse{}, err
	}
	defer rollback(ctx, tx)
	locator, err := loadAIGenerationLocator(ctx, tx, snapshot.GenerationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.AIResponse{}, store.settleMissingAIResult(ctx, tx, snapshot.GenerationID, result, providerErr, now)
	}
	if err != nil {
		return workspace.AIResponse{}, err
	}
	if locator.operation != "action_generate" && locator.operation != "action_refine" {
		return workspace.AIResponse{}, errors.New("AI generation operation changed during Action finalization")
	}
	if locator.status != "running" {
		return workspace.AIResponse{}, store.settleMissingAIResult(ctx, tx, snapshot.GenerationID, result, providerErr, now)
	}
	if err = lockAIFinalizationUser(ctx, tx, locator.userID); err != nil {
		return workspace.AIResponse{}, err
	}
	var goalStatus goal.Status
	err = tx.QueryRow(ctx, `SELECT status FROM goals WHERE id=$1 AND user_id=$2 FOR UPDATE`,
		mustUUID(locator.goalID), mustUUID(locator.userID)).Scan(&goalStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.AIResponse{}, store.settleMissingAIResult(ctx, tx, snapshot.GenerationID, result, providerErr, now)
	}
	if err != nil {
		return workspace.AIResponse{}, err
	}
	current, loadErr := loadCycleForUpdate(ctx, tx, locator.userID, locator.goalID, locator.cycleID)
	if errors.Is(loadErr, workspace.ErrNotFound) {
		return workspace.AIResponse{}, store.settleMissingAIResult(ctx, tx, snapshot.GenerationID, result, providerErr, now)
	}
	if loadErr != nil {
		return workspace.AIResponse{}, loadErr
	}
	var versionID string
	var month time.Time
	var reserved float64
	var targetRevision int64
	err = tx.QueryRow(ctx, `SELECT goal_version_id,budget_month_utc,budget_reserved_cost_usd,target_revision
FROM ai_generations
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND cycle_id=$4
  AND operation_type=$5 AND status='running' FOR UPDATE`,
		mustUUID(snapshot.GenerationID), mustUUID(locator.userID), mustUUID(locator.goalID), mustUUID(locator.cycleID),
		locator.operation).Scan(&versionID, &month, &reserved, &targetRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.AIResponse{}, store.settleMissingAIResult(ctx, tx, snapshot.GenerationID, result, providerErr, now)
	}
	if err != nil {
		return workspace.AIResponse{}, err
	}
	if targetRevision != snapshot.TargetRevision {
		return workspace.AIResponse{}, errors.New("AI generation target revision changed during Action finalization")
	}
	if goalStatus != goal.StatusActiveCycle || current.Status != cycle.StatusActive {
		providerErr = workspace.ErrGoalStateConflict
	}
	if current.GoalVersionID != versionID {
		providerErr = workspace.ErrGoalVersionConflict
	}
	contextChanged := current.Revisions.Content != targetRevision
	if providerErr == nil {
		current.Action = result.Output
		current.Revisions.Action++
		current.Revisions.Content++
		command, updateErr := tx.Exec(ctx, `UPDATE pdca_cycles SET action=$2,action_revision=action_revision+1,
content_revision=content_revision+1,action_last_ai_applied_content_revision=content_revision+1,
	action_user_modified_after_ai=false,updated_at=$3
WHERE id=$1 AND user_id=$4 AND goal_id=$5 AND status='active' AND goal_version_id=$6`,
			mustUUID(locator.cycleID), result.Output, now, mustUUID(locator.userID), mustUUID(locator.goalID), mustUUID(versionID))
		if updateErr != nil {
			return workspace.AIResponse{}, updateErr
		}
		if command.RowsAffected() != 1 {
			return workspace.AIResponse{}, errors.New("Action AI cycle application invariant violated")
		}
	}
	if err = store.finishGeneration(ctx, tx, snapshot.GenerationID, month, reserved, result, providerErr, contextChanged, providerErr == nil, now); err != nil {
		return workspace.AIResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.AIResponse{}, err
	}
	if providerErr != nil {
		return workspace.AIResponse{}, providerErr
	}
	return workspace.AIResponse{
		GenerationID: snapshot.GenerationID, Action: result.Output,
		ContentRevision: current.Revisions.Content, ActionRevision: current.Revisions.Action, ContextChanged: contextChanged,
	}, nil
}

func (store *WorkspaceStore) finishGeneration(ctx context.Context, tx pgx.Tx, generationID string, month time.Time, reserved float64,
	result workspace.AIProviderResult, providerErr error, contextChanged, applied bool, now time.Time) error {
	failureCode := ""
	status := "succeeded"
	var output any = result.Output
	var appliedAt any
	if applied {
		appliedAt = now
	}
	if providerErr != nil {
		status = "failed"
		output = nil
		failureCode = aiFailureCode(providerErr)
	}
	command, err := tx.Exec(ctx, `UPDATE ai_generations SET status=$2,output=$3,input_tokens=$4,output_tokens=$5,
estimated_cost_usd=$6,budget_reserved_cost_usd=0,attempt_count=$7,failure_code=NULLIF($8,''),provider_request_id=NULLIF($9,''),
lease_expires_at=NULL,context_changed=$10,applied_at=$11,finished_at=$12
WHERE id=$1 AND status='running' AND budget_reserved_cost_usd=$13`, mustUUID(generationID), status,
		output, result.InputTokens, result.OutputTokens, result.CostUSD, result.Attempts, failureCode, result.ProviderRequestID,
		contextChanged, appliedAt, now, reserved)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("AI generation terminal CAS invariant violated during settlement")
	}
	command, err = tx.Exec(ctx, `UPDATE ai_budget_monthly SET reserved_cost_usd=reserved_cost_usd-$2,
actual_cost_usd=actual_cost_usd+$3,updated_at=$4 WHERE month_utc=$1 AND reserved_cost_usd >= $2`, month, reserved, result.CostUSD, now)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("AI budget reservation invariant violated during settlement")
	}
	command, err = tx.Exec(ctx, `UPDATE ai_usage_events SET status=$2,input_tokens=$3,output_tokens=$4,estimated_cost_usd=$5,
provider_usage_finalized_at=$6
WHERE operation_id=$1 AND status='accepted' AND provider_usage_finalized_at IS NULL`,
		mustUUID(generationID), status, result.InputTokens, result.OutputTokens, result.CostUSD, now)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("AI usage finalization CAS invariant violated during settlement")
	}
	return nil
}

func (store *WorkspaceStore) settleLateUsage(ctx context.Context, tx pgx.Tx, generationID string, result workspace.AIProviderResult, providerErr error, now time.Time) error {
	var userID string
	var acceptedAt time.Time
	var finalizedAt *time.Time
	err := tx.QueryRow(ctx, `SELECT user_id,accepted_at,provider_usage_finalized_at FROM ai_usage_events
WHERE operation_id=$1`, mustUUID(generationID)).Scan(&userID, &acceptedAt, &finalizedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // Account Delete already moved the reservation to unattributed cost and removed user usage.
	}
	if err != nil || finalizedAt != nil {
		return err
	}
	err = lockUser(ctx, tx, user.ID(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // Account Delete won after the locator read.
	}
	if err != nil {
		return err
	}
	err = tx.QueryRow(ctx, `SELECT accepted_at,provider_usage_finalized_at FROM ai_usage_events
WHERE operation_id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(generationID), mustUUID(userID)).Scan(&acceptedAt, &finalizedAt)
	if errors.Is(err, pgx.ErrNoRows) || finalizedAt != nil {
		return nil
	}
	if err != nil {
		return err
	}
	month := time.Date(acceptedAt.UTC().Year(), acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	if _, err = tx.Exec(ctx, `INSERT INTO ai_budget_monthly(month_utc,reserved_cost_usd,actual_cost_usd,unattributed_cost_usd,updated_at)
VALUES($1,0,0,0,$2) ON CONFLICT(month_utc) DO NOTHING`, month, now); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE ai_budget_monthly SET actual_cost_usd=actual_cost_usd+$2,updated_at=$3 WHERE month_utc=$1`,
		month, result.CostUSD, now)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("AI late usage budget invariant violated")
	}
	status := "succeeded"
	if providerErr != nil {
		status = "failed"
	}
	command, err = tx.Exec(ctx, `UPDATE ai_usage_events SET status=$2,input_tokens=$3,output_tokens=$4,estimated_cost_usd=$5,
provider_usage_finalized_at=$6 WHERE operation_id=$1 AND provider_usage_finalized_at IS NULL`, mustUUID(generationID), status,
		result.InputTokens, result.OutputTokens, result.CostUSD, now)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("AI late usage finalization CAS invariant violated")
	}
	return nil
}

func loadAIContextCycles(ctx context.Context, tx pgx.Tx, userID, goalID, excludeCycleID string, limit int) ([]workspace.AIContextCycle, error) {
	rows, err := tx.Query(ctx, `SELECT c.id,c.goal_id,c.sequence_number,c.status,gv.body,c.plan,c.do_text,c.check_text,c.action
FROM pdca_cycles c
JOIN goal_versions gv ON gv.goal_id=c.goal_id AND gv.id=c.goal_version_id
WHERE c.user_id=$1 AND c.goal_id=$2 AND c.status IN ('completed','canceled') AND ($3::uuid IS NULL OR c.id<>$3)
ORDER BY c.sequence_number DESC LIMIT $4`, mustUUID(userID), mustUUID(goalID), nullableUUID(excludeCycleID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []workspace.AIContextCycle{}
	for rows.Next() {
		var item workspace.AIContextCycle
		if err = rows.Scan(&item.ID, &item.GoalID, &item.SequenceNumber, &item.Status, &item.GoalBody, &item.Plan, &item.Do, &item.Check, &item.Action); err != nil {
			return nil, err
		}
		if item.GoalID != goalID {
			return nil, workspace.ErrGoalStateConflict
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func aiFailureCode(err error) string {
	switch {
	case errors.Is(err, workspace.ErrAIInvalidResponse):
		return "invalid_response"
	case errors.Is(err, workspace.ErrAIProviderTimeout):
		return "provider_timeout"
	case errors.Is(err, workspace.ErrNotFound):
		return "target_deleted"
	case errors.Is(err, workspace.ErrGoalVersionConflict):
		return "goal_version_conflict"
	default:
		return "provider_unavailable"
	}
}

func hashActionAIRequest(input workspace.ActionAIInput) string {
	canonical, _ := json.Marshal(struct {
		Operation               string `json:"operation"`
		GoalID                  string `json:"goalId"`
		CycleID                 string `json:"cycleId"`
		ExpectedContentRevision int64  `json:"expectedContentRevision"`
		ConfirmReplace          bool   `json:"confirmReplace,omitempty"`
	}{input.Operation, input.GoalID, input.CycleID, input.ExpectedContentRevision, input.ConfirmReplace})
	return sha256Hex(canonical)
}

func sha256Hex(canonical []byte) string {
	digest := sha256.Sum256(canonical)
	return fmt.Sprintf("%x", digest[:])
}

func contextCycleIDs(cycles []workspace.AIContextCycle) []string {
	ids := make([]string, len(cycles))
	for index := range cycles {
		ids[index] = cycles[index].ID
	}
	return ids
}

func (store *WorkspaceStore) checkAIRateLimits(ctx context.Context, tx pgx.Tx, userID, sessionID, remoteAddress string, now time.Time) error {
	checks := []struct {
		scope string
		value string
		limit int
	}{
		{"ai_user_minute", userID, store.settings.AIPerUserMinute},
		{"ai_session_minute", sessionID, store.settings.AIPerSessionMinute},
		{"ai_ip_minute", remoteAddress, store.settings.AIPerIPMinute},
	}
	window := now.UTC().Truncate(time.Minute)
	for _, check := range checks {
		if check.value == "" || check.limit <= 0 {
			continue
		}
		mac := hmac.New(sha256.New, store.settings.RateHashKey)
		_, _ = mac.Write([]byte(check.scope))
		_, _ = mac.Write([]byte{0})
		_, _ = mac.Write([]byte(check.value))
		var count int
		err := tx.QueryRow(ctx, `INSERT INTO abuse_rate_buckets(scope,key_hash,window_start,request_count,expires_at)
VALUES($1,$2,$3,1,$4)
ON CONFLICT(scope,key_hash,window_start) DO UPDATE
SET request_count=abuse_rate_buckets.request_count+1,expires_at=EXCLUDED.expires_at
RETURNING request_count`, check.scope, mac.Sum(nil), window, window.Add(2*time.Minute)).Scan(&count)
		if err != nil {
			return err
		}
		if count > check.limit {
			return workspace.ErrAIRateLimit
		}
	}
	return nil
}

func (store *WorkspaceStore) recoverExpiredAI(ctx context.Context, tx pgx.Tx, userID string, now time.Time) error {
	rows, err := tx.Query(ctx, `SELECT id,budget_reserved_cost_usd::text FROM ai_generations
WHERE user_id=$1 AND status='running' AND lease_expires_at<=$2 ORDER BY id FOR UPDATE`, mustUUID(userID), now)
	if err != nil {
		return err
	}
	type expired struct {
		id       string
		reserved string
	}
	items := []expired{}
	for rows.Next() {
		var item expired
		if err = rows.Scan(&item.id, &item.reserved); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	itemIDs := make([]string, len(items))
	for index, item := range items {
		itemIDs[index] = item.id
	}
	type monthlyReservation struct {
		month  time.Time
		amount string
	}
	monthlyReservations := make([]monthlyReservation, 0)
	if len(itemIDs) > 0 {
		rows, err = tx.Query(ctx, `SELECT budget_month_utc,SUM(budget_reserved_cost_usd)::text
FROM ai_generations
WHERE id=ANY($1::text[]::uuid[]) AND status='running'
GROUP BY budget_month_utc
HAVING SUM(budget_reserved_cost_usd)>0
ORDER BY budget_month_utc`, itemIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var item monthlyReservation
			if err = rows.Scan(&item.month, &item.amount); err != nil {
				rows.Close()
				return err
			}
			monthlyReservations = append(monthlyReservations, item)
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}
	for _, monthly := range monthlyReservations {
		command, updateErr := tx.Exec(ctx, `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd-$2::numeric,updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2::numeric`, monthly.month, monthly.amount, now)
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("AI budget reservation invariant violated during lease recovery")
		}
	}
	for _, item := range items {
		command, updateErr := tx.Exec(ctx, `UPDATE ai_generations SET status='failed',failure_code='lease_expired',
budget_reserved_cost_usd=0,lease_expires_at=NULL,finished_at=$2
WHERE id=$1 AND status='running' AND budget_reserved_cost_usd=$3::numeric`, mustUUID(item.id), now, item.reserved)
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("AI generation lease recovery CAS invariant violated")
		}
		command, updateErr = tx.Exec(ctx, `UPDATE ai_usage_events SET status='failed'
WHERE operation_id=$1 AND status='accepted' AND provider_usage_finalized_at IS NULL`, mustUUID(item.id))
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("AI usage lease recovery CAS invariant violated")
		}
	}
	return nil
}

func pointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableUUID(value string) any {
	if value == "" {
		return nil
	}
	return mustUUID(value)
}
