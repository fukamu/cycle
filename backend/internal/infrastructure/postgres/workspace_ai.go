package postgres

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
	"github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/goal"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

func (store *WorkspaceStore) BeginGoalRefine(ctx context.Context, input workspace.GoalRefineInput, selectContext workspace.AIContextSelector) (snapshot workspace.AISnapshot, err error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return snapshot, err
	}
	defer rollback(ctx, tx)
	if err = lockUser(ctx, tx, user.ID(input.UserID)); err != nil {
		return snapshot, workspace.ErrNotFound
	}
	draft, err := scanDraft(tx.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(input.DraftID), mustUUID(input.UserID)))
	if err != nil {
		return snapshot, err
	}
	if input.GoalID == "" && draft.DraftType != string(goal.DraftCreation) {
		return snapshot, workspace.ErrDraftTypeMismatch
	}
	inputHash := hashGoalRefineRequest(input)
	replayed, replayErr := existingGeneration(ctx, tx, input.UserID, "goal_refine", input.IdempotencyKey, inputHash)
	if replayErr != nil {
		return snapshot, replayErr
	}
	if replayed != nil {
		return *replayed, tx.Commit(ctx)
	}
	if draft.Revision != input.ExpectedDraftRevision {
		return snapshot, workspace.ErrDraftRevisionConflict
	}
	if strings.TrimSpace(draft.Body) == "" {
		return snapshot, workspace.ErrAIInputIncomplete
	}
	var goalVersionID *string
	goalBody := ""
	var sourceGoalRevision int64
	contextCycles := []workspace.AIContextCycle{}
	goalID := draft.GoalID
	if draft.DraftType == "review" {
		if goalID == nil || input.GoalID == "" || *goalID != input.GoalID || input.ExpectedGoalRevision == nil {
			return snapshot, workspace.ErrGoalStateConflict
		}
		var status goal.Status
		var revision int64
		var currentVersionID string
		if err = tx.QueryRow(ctx, `SELECT g.status,g.revision,gv.id,gv.body FROM goals g
JOIN goal_versions gv ON gv.goal_id=g.id AND gv.version_number=g.current_version_number
WHERE g.id=$1 AND g.user_id=$2 FOR UPDATE`, mustUUID(input.GoalID), mustUUID(input.UserID)).Scan(&status, &revision, &currentVersionID, &goalBody); err != nil {
			return snapshot, workspace.ErrNotFound
		}
		if status != goal.StatusGoalReview || revision != *input.ExpectedGoalRevision || draft.BaseGoalVersionID == nil || *draft.BaseGoalVersionID != currentVersionID {
			return snapshot, workspace.ErrGoalRevisionConflict
		}
		goalVersionID = draft.BaseGoalVersionID
		sourceGoalRevision = revision
		contextCycles, err = loadAIContextCycles(ctx, tx, input.UserID, input.GoalID, "", 10)
		if err != nil {
			return snapshot, err
		}
	}
	snapshot = workspace.AISnapshot{
		GenerationID: input.GenerationID, Operation: "goal_refine", TargetRevision: draft.Revision,
		SourceGoalRevision: sourceGoalRevision, GoalBody: goalBody, SourceText: draft.Body, PastCycles: contextCycles,
	}
	if goalID != nil {
		snapshot.GoalID = *goalID
	}
	if selectContext == nil {
		return workspace.AISnapshot{}, workspace.ErrAIInputBudget
	}
	snapshot, err = selectContext(ctx, snapshot)
	if err != nil {
		return workspace.AISnapshot{}, err
	}
	if err = store.reserveAI(ctx, tx, input.UserID, input.GenerationID, "goal_refine", input.IdempotencyKey,
		inputHash, draft.ID, goalID, goalVersionID, nil, draft.Revision, draft.Body, store.settings.GoalPromptVersion,
		contextCycleIDs(snapshot.PastCycles), input.SessionID, input.RemoteAddress, input.Now); err != nil {
		return snapshot, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.AISnapshot{}, err
	}
	return snapshot, nil
}

func (store *WorkspaceStore) BeginActionAI(ctx context.Context, input workspace.ActionAIInput, selectContext workspace.AIContextSelector) (snapshot workspace.AISnapshot, err error) {
	if input.Operation != "action_generate" && input.Operation != "action_refine" {
		return snapshot, workspace.ErrAIInputIncomplete
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return snapshot, err
	}
	defer rollback(ctx, tx)
	if err = lockUser(ctx, tx, user.ID(input.UserID)); err != nil {
		return snapshot, workspace.ErrNotFound
	}
	inputHash := hashActionAIRequest(input)
	replayed, replayErr := existingActionGeneration(ctx, tx, input, inputHash)
	if replayErr != nil {
		return snapshot, replayErr
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
	if err := store.checkAIRateLimits(ctx, tx, userID, sessionID, remoteAddress, now); err != nil {
		return err
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
	if reserved+actual+unattributed+store.settings.ReservationUSD > store.settings.MonthlyBudgetUSD {
		return workspace.ErrAIBudget
	}
	if _, err := tx.Exec(ctx, `UPDATE ai_budget_monthly SET reserved_cost_usd=reserved_cost_usd+$2,updated_at=$3 WHERE month_utc=$1`, month, store.settings.ReservationUSD, now); err != nil {
		return err
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
	_, err := tx.Exec(ctx, `INSERT INTO ai_generations
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

func existingGeneration(ctx context.Context, tx pgx.Tx, userID, operation, key, inputHash string) (*workspace.AISnapshot, error) {
	var generationID, storedHash, status, failureCode string
	var target int64
	var sourceGoalRevision int64
	var output *string
	err := tx.QueryRow(ctx, `SELECT generation.id,generation.input_hash,generation.status,generation.target_revision,
generation.output,COALESCE(generation.failure_code,''),COALESCE(goal.revision,0)
FROM ai_generations generation LEFT JOIN goals goal ON goal.id=generation.goal_id
WHERE generation.user_id=$1 AND generation.operation_type=$2 AND generation.idempotency_key=$3`,
		mustUUID(userID), operation, mustUUID(key)).Scan(
		&generationID, &storedHash, &status, &target, &output, &failureCode, &sourceGoalRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if storedHash != inputHash {
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
	return &workspace.AISnapshot{
		GenerationID: generationID, Operation: operation, TargetRevision: target,
		SourceGoalRevision: sourceGoalRevision, ReplayedOutput: output,
	}, nil
}

func existingActionGeneration(ctx context.Context, tx pgx.Tx, input workspace.ActionAIInput, inputHash string) (*workspace.AISnapshot, error) {
	var generationID, status, goalID, cycleID, storedHash, failureCode string
	var target int64
	var output *string
	err := tx.QueryRow(ctx, `SELECT id,status,target_revision,output,COALESCE(failure_code,''),goal_id,cycle_id,input_hash
FROM ai_generations WHERE user_id=$1 AND operation_type=$2 AND idempotency_key=$3`,
		mustUUID(input.UserID), input.Operation, mustUUID(input.IdempotencyKey)).Scan(
		&generationID, &status, &target, &output, &failureCode, &goalID, &cycleID, &storedHash)
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
		ReplayedContentRevision: contentRevision, ReplayedActionRevision: actionRevision,
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

func (store *WorkspaceStore) FinishGoalRefine(ctx context.Context, snapshot workspace.AISnapshot, result workspace.AIProviderResult, providerErr error, now time.Time) (workspace.AIResponse, error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return workspace.AIResponse{}, err
	}
	defer rollback(ctx, tx)
	var draftID, month string
	var reserved float64
	err = tx.QueryRow(ctx, `SELECT source_goal_draft_id,budget_month_utc::text,budget_reserved_cost_usd
FROM ai_generations WHERE id=$1 AND status='running' FOR UPDATE`, mustUUID(snapshot.GenerationID)).Scan(&draftID, &month, &reserved)
	if errors.Is(err, pgx.ErrNoRows) {
		if err = store.settleLateUsage(ctx, tx, snapshot.GenerationID, result, providerErr, now); err != nil {
			return workspace.AIResponse{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return workspace.AIResponse{}, err
		}
		return workspace.AIResponse{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.AIResponse{}, err
	}
	contextChanged := true
	var currentRevision int64
	if err = tx.QueryRow(ctx, `SELECT revision FROM goal_drafts WHERE id=$1`, mustUUID(draftID)).Scan(&currentRevision); err == nil {
		contextChanged = currentRevision != snapshot.TargetRevision
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return workspace.AIResponse{}, err
	}
	if err = store.finishGeneration(ctx, tx, snapshot.GenerationID, month, reserved, result, providerErr, contextChanged, false, now); err != nil {
		return workspace.AIResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.AIResponse{}, err
	}
	if providerErr != nil {
		return workspace.AIResponse{}, providerErr
	}
	return workspace.AIResponse{
		GenerationID: snapshot.GenerationID, SourceDraftRevision: snapshot.TargetRevision,
		SourceGoalRevision: snapshot.SourceGoalRevision, Suggestion: result.Output, ContextChanged: contextChanged,
	}, nil
}

func (store *WorkspaceStore) FinishActionAI(ctx context.Context, snapshot workspace.AISnapshot, result workspace.AIProviderResult, providerErr error, now time.Time) (workspace.AIResponse, error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return workspace.AIResponse{}, err
	}
	defer rollback(ctx, tx)
	var userID, goalID, cycleID, versionID, month string
	var reserved float64
	err = tx.QueryRow(ctx, `SELECT user_id,goal_id,cycle_id,goal_version_id,budget_month_utc::text,budget_reserved_cost_usd
FROM ai_generations WHERE id=$1 AND status='running' FOR UPDATE`, mustUUID(snapshot.GenerationID)).Scan(&userID, &goalID, &cycleID, &versionID, &month, &reserved)
	if errors.Is(err, pgx.ErrNoRows) {
		if err = store.settleLateUsage(ctx, tx, snapshot.GenerationID, result, providerErr, now); err != nil {
			return workspace.AIResponse{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return workspace.AIResponse{}, err
		}
		return workspace.AIResponse{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.AIResponse{}, err
	}
	current, loadErr := loadCycleForUpdate(ctx, tx, userID, goalID, cycleID)
	if loadErr != nil {
		providerErr = workspace.ErrNotFound
	}
	if loadErr == nil && current.GoalVersionID != versionID {
		providerErr = workspace.ErrGoalVersionConflict
	}
	contextChanged := loadErr == nil && current.Revisions.Content != snapshot.TargetRevision
	if providerErr == nil {
		if current.Status != cycle.StatusActive {
			providerErr = workspace.ErrGoalStateConflict
		} else {
			current.Action = result.Output
			current.Revisions.Action++
			current.Revisions.Content++
			_, err = tx.Exec(ctx, `UPDATE pdca_cycles SET action=$2,action_revision=action_revision+1,
content_revision=content_revision+1,action_last_ai_applied_content_revision=content_revision+1,
action_user_modified_after_ai=false,updated_at=$3 WHERE id=$1`, mustUUID(cycleID), result.Output, now)
			if err != nil {
				return workspace.AIResponse{}, err
			}
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

func (store *WorkspaceStore) finishGeneration(ctx context.Context, tx pgx.Tx, generationID, month string, reserved float64,
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
	_, err := tx.Exec(ctx, `UPDATE ai_generations SET status=$2,output=$3,input_tokens=$4,output_tokens=$5,
estimated_cost_usd=$6,budget_reserved_cost_usd=0,attempt_count=$7,failure_code=NULLIF($8,''),provider_request_id=NULLIF($9,''),
lease_expires_at=NULL,context_changed=$10,applied_at=$11,finished_at=$12 WHERE id=$1`, mustUUID(generationID), status,
		output, result.InputTokens, result.OutputTokens, result.CostUSD, result.Attempts, failureCode, result.ProviderRequestID,
		contextChanged, appliedAt, now)
	if err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE ai_budget_monthly SET reserved_cost_usd=reserved_cost_usd-$2,
actual_cost_usd=actual_cost_usd+$3,updated_at=$4 WHERE month_utc=$1::date AND reserved_cost_usd >= $2`, month, reserved, result.CostUSD, now)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("AI budget reservation invariant violated during settlement")
	}
	_, err = tx.Exec(ctx, `UPDATE ai_usage_events SET status=$2,input_tokens=$3,output_tokens=$4,estimated_cost_usd=$5,
provider_usage_finalized_at=$6 WHERE operation_id=$1`, mustUUID(generationID), status, result.InputTokens, result.OutputTokens, result.CostUSD, now)
	return err
}

func (store *WorkspaceStore) settleLateUsage(ctx context.Context, tx pgx.Tx, generationID string, result workspace.AIProviderResult, providerErr error, now time.Time) error {
	var acceptedAt time.Time
	var finalizedAt *time.Time
	err := tx.QueryRow(ctx, `SELECT accepted_at,provider_usage_finalized_at FROM ai_usage_events
WHERE operation_id=$1 FOR UPDATE`, mustUUID(generationID)).Scan(&acceptedAt, &finalizedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // Account Delete already moved the reservation to unattributed cost and removed user usage.
	}
	if err != nil || finalizedAt != nil {
		return err
	}
	month := time.Date(acceptedAt.UTC().Year(), acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	if _, err = tx.Exec(ctx, `INSERT INTO ai_budget_monthly(month_utc,reserved_cost_usd,actual_cost_usd,unattributed_cost_usd,updated_at)
VALUES($1,0,0,0,$2) ON CONFLICT(month_utc) DO NOTHING`, month, now); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_budget_monthly SET actual_cost_usd=actual_cost_usd+$2,updated_at=$3 WHERE month_utc=$1`, month, result.CostUSD, now); err != nil {
		return err
	}
	status := "succeeded"
	if providerErr != nil {
		status = "failed"
	}
	_, err = tx.Exec(ctx, `UPDATE ai_usage_events SET status=$2,input_tokens=$3,output_tokens=$4,estimated_cost_usd=$5,
provider_usage_finalized_at=$6 WHERE operation_id=$1 AND provider_usage_finalized_at IS NULL`, mustUUID(generationID), status,
		result.InputTokens, result.OutputTokens, result.CostUSD, now)
	return err
}

func (store *WorkspaceStore) AdoptGoalSuggestion(ctx context.Context, userID, draftID, generationID string, expectedDraftRevision int64, expectedGoalRevision *int64, now time.Time) (workspace.DraftView, error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return workspace.DraftView{}, err
	}
	defer rollback(ctx, tx)
	draft, err := scanDraft(tx.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(draftID), mustUUID(userID)))
	if err != nil {
		return workspace.DraftView{}, err
	}
	if draft.GoalID != nil {
		if expectedGoalRevision == nil {
			return workspace.DraftView{}, workspace.ErrGoalRevisionConflict
		}
		var revision int64
		var status goal.Status
		if err = tx.QueryRow(ctx, `SELECT revision,status FROM goals WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(*draft.GoalID), mustUUID(userID)).Scan(&revision, &status); err != nil {
			return workspace.DraftView{}, workspace.ErrNotFound
		}
		if revision != *expectedGoalRevision || status != goal.StatusGoalReview {
			return workspace.DraftView{}, workspace.ErrGoalRevisionConflict
		}
	}
	var targetRevision int64
	var output string
	var adoptedAt *time.Time
	var adoptedDraftRevision *int64
	err = tx.QueryRow(ctx, `SELECT target_revision,output,adopted_at,adopted_draft_revision FROM ai_generations
WHERE id=$1 AND user_id=$2 AND operation_type='goal_refine' AND source_goal_draft_id=$3 AND status='succeeded' FOR UPDATE`,
		mustUUID(generationID), mustUUID(userID), mustUUID(draftID)).Scan(&targetRevision, &output, &adoptedAt, &adoptedDraftRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.DraftView{}, workspace.ErrAISuggestionNotFound
	}
	if err != nil {
		return workspace.DraftView{}, err
	}
	if adoptedAt != nil {
		if adoptedDraftRevision != nil && draft.Revision == *adoptedDraftRevision && draft.Body == output {
			draft.Replayed = true
			return draft, tx.Commit(ctx)
		}
		return workspace.DraftView{}, workspace.ErrAIResultAlreadyAdopted
	}
	if draft.Revision != expectedDraftRevision || targetRevision != expectedDraftRevision {
		return workspace.DraftView{}, workspace.ErrAIContextStale
	}
	draft.Body = output
	draft.Revision++
	draft.UpdatedAt = now
	if _, err = tx.Exec(ctx, `UPDATE goal_drafts SET body=$2,revision=$3,updated_at=$4 WHERE id=$1`, mustUUID(draftID), output, draft.Revision, now); err != nil {
		return workspace.DraftView{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_generations SET adopted_at=$2,adopted_draft_revision=$3 WHERE id=$1`, mustUUID(generationID), now, draft.Revision); err != nil {
		return workspace.DraftView{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.DraftView{}, err
	}
	return draft, nil
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

func hashGoalRefineRequest(input workspace.GoalRefineInput) string {
	canonical, _ := json.Marshal(struct {
		Operation             string `json:"operation"`
		DraftID               string `json:"draftId"`
		GoalID                string `json:"goalId,omitempty"`
		ExpectedDraftRevision int64  `json:"expectedDraftRevision"`
		ExpectedGoalRevision  *int64 `json:"expectedGoalRevision,omitempty"`
	}{"goal_refine", input.DraftID, input.GoalID, input.ExpectedDraftRevision, input.ExpectedGoalRevision})
	return sha256Hex(canonical)
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
	rows, err := tx.Query(ctx, `SELECT id,budget_month_utc,budget_reserved_cost_usd FROM ai_generations
WHERE user_id=$1 AND status='running' AND lease_expires_at<=$2 ORDER BY budget_month_utc,id FOR UPDATE`, mustUUID(userID), now)
	if err != nil {
		return err
	}
	type expired struct {
		id       string
		month    time.Time
		reserved float64
	}
	items := []expired{}
	for rows.Next() {
		var item expired
		if err = rows.Scan(&item.id, &item.month, &item.reserved); err != nil {
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
	for _, item := range items {
		if item.reserved > 0 {
			command, updateErr := tx.Exec(ctx, `UPDATE ai_budget_monthly SET reserved_cost_usd=reserved_cost_usd-$2,updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2`, item.month, item.reserved, now)
			if updateErr != nil || command.RowsAffected() != 1 {
				return errors.New("AI budget reservation invariant violated during lease recovery")
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_generations SET status='failed',failure_code='lease_expired',
budget_reserved_cost_usd=0,lease_expires_at=NULL,finished_at=$2 WHERE id=$1 AND status='running'`, mustUUID(item.id), now); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_usage_events SET status='failed' WHERE operation_id=$1 AND status='accepted'`, mustUUID(item.id)); err != nil {
			return err
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
