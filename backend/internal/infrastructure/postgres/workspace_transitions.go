package postgres

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
	"github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/goal"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

func (store *WorkspaceStore) StartGoal(ctx context.Context, input workspace.StartGoalInput, maxProgressing int) (result workspace.StartGoalResult, err error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer rollback(ctx, tx)
	if err = lockUser(ctx, tx, user.ID(input.UserID)); err != nil {
		return result, workspace.ErrNotFound
	}
	var replayGoalID, replayCycleID, replayHash string
	err = tx.QueryRow(ctx, `SELECT goal_id,id,start_request_hash FROM pdca_cycles
WHERE user_id=$1 AND start_operation_id=$2`, mustUUID(input.UserID), mustUUID(input.OperationID)).Scan(&replayGoalID, &replayCycleID, &replayHash)
	if err == nil {
		if replayHash != input.RequestHash {
			return result, workspace.ErrIdempotencyKeyReused
		}
		result.Goal, err = getGoalView(ctx, tx, input.UserID, replayGoalID)
		if err != nil {
			return result, err
		}
		result.Cycle, err = getCycleView(ctx, tx, input.UserID, replayGoalID, replayCycleID)
		result.Replayed = true
		return result, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	draft, err := scanDraft(tx.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE id=$1 AND user_id=$2 AND draft_type='creation' FOR UPDATE`, mustUUID(input.DraftID), mustUUID(input.UserID)))
	if err != nil {
		return result, err
	}
	if draft.Revision != input.ExpectedDraftRevision {
		return result, workspace.ErrDraftRevisionConflict
	}
	if _, err = goal.NormalizeText(draft.Body, false); err != nil {
		return result, err
	}
	var running bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations
WHERE source_goal_draft_id=$1 AND status='running')`, mustUUID(input.DraftID)).Scan(&running); err != nil {
		return result, err
	}
	if running {
		return result, workspace.ErrAIInProgress
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM goals
WHERE user_id=$1 AND status IN ('active_cycle','goal_review')`, mustUUID(input.UserID)).Scan(&count); err != nil {
		return result, err
	}
	if count >= maxProgressing {
		return result, workspace.ErrGoalActiveLimit
	}
	aggregateDraft := goal.Draft{ID: draft.ID, UserID: input.UserID, Type: goal.DraftCreation, Body: draft.Body, Revision: draft.Revision}
	aggregate, err := goal.StartInitial(aggregateDraft, input.GoalID, input.VersionID, input.CycleID, input.OperationID, input.RequestHash, input.Now)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,revision,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,0,$3,$3)`, mustUUID(input.GoalID), mustUUID(input.UserID), input.Now)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,$4,$5,$6)`, mustUUID(input.VersionID), mustUUID(input.UserID), mustUUID(input.GoalID), aggregate.Version.Body, mustUUID(input.OperationID), input.Now)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active',$5,$6,$7,$5,$5)`, mustUUID(input.CycleID), mustUUID(input.UserID), mustUUID(input.GoalID), mustUUID(input.VersionID), input.Now, mustUUID(input.OperationID), input.RequestHash)
	if err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_generations SET source_goal_draft_id=NULL,goal_id=$2,goal_version_id=$3
WHERE user_id=$1 AND source_goal_draft_id=$4`, mustUUID(input.UserID), mustUUID(input.GoalID), mustUUID(input.VersionID), mustUUID(input.DraftID)); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_usage_events SET goal_id=$2
WHERE user_id=$1 AND operation_id IN (SELECT id FROM ai_generations WHERE goal_id=$2)`, mustUUID(input.UserID), mustUUID(input.GoalID)); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM goal_drafts WHERE id=$1`, mustUUID(input.DraftID)); err != nil {
		return result, err
	}
	result.Goal, err = getGoalView(ctx, tx, input.UserID, input.GoalID)
	if err != nil {
		return result, err
	}
	result.Cycle, err = getCycleView(ctx, tx, input.UserID, input.GoalID, input.CycleID)
	if err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}

func (store *WorkspaceStore) SaveFrame(ctx context.Context, input workspace.SaveFrameInput) (result workspace.SaveFrameResult, err error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer rollback(ctx, tx)
	var goalStatus goal.Status
	if err = tx.QueryRow(ctx, `SELECT status FROM goals WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(input.GoalID), mustUUID(input.UserID)).Scan(&goalStatus); errors.Is(err, pgx.ErrNoRows) {
		return result, workspace.ErrNotFound
	} else if err != nil {
		return result, err
	}
	if goalStatus != goal.StatusActiveCycle {
		return result, workspace.ErrGoalStateConflict
	}
	current, err := loadCycleForUpdate(ctx, tx, input.UserID, input.GoalID, input.CycleID)
	if err != nil {
		return result, err
	}
	var aiRunning bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations WHERE cycle_id=$1 AND status='running')`, mustUUID(input.CycleID)).Scan(&aiRunning); err != nil {
		return result, err
	}
	saved, err := cycle.SaveFrame(current, input.Frame, input.Content, input.ExpectedFrameRevision, aiRunning, input.Now)
	if err != nil {
		return result, err
	}
	if !saved.NoOp {
		column, revisionColumn := "", ""
		switch input.Frame {
		case cycle.FramePlan:
			column, revisionColumn = "plan", "plan_revision"
		case cycle.FrameDo:
			column, revisionColumn = "do_text", "do_revision"
		case cycle.FrameCheck:
			column, revisionColumn = "check_text", "check_revision"
		case cycle.FrameAction:
			column, revisionColumn = "action", "action_revision"
		default:
			return result, cycle.ErrInvalidFrame
		}
		query := fmt.Sprintf(`UPDATE pdca_cycles SET %s=$2,%s=%s+1,content_revision=content_revision+1,
action_user_modified_after_ai=CASE WHEN $3='action' AND action_last_ai_applied_content_revision IS NOT NULL THEN true ELSE action_user_modified_after_ai END,
updated_at=$4 WHERE id=$1`, column, revisionColumn, revisionColumn)
		if _, err = tx.Exec(ctx, query, mustUUID(input.CycleID), saved.Content, string(input.Frame), input.Now); err != nil {
			return result, err
		}
	}
	updated, err := getCycleView(ctx, tx, input.UserID, input.GoalID, input.CycleID)
	if err != nil {
		return result, err
	}
	result = workspace.SaveFrameResult{
		CycleID: updated.ID, Frame: input.Frame, Content: updatedFrame(updated, input.Frame),
		FrameRevision: updatedRevision(updated, input.Frame), ContentRevision: updated.ContentRevision, SavedAt: input.Now,
	}
	if saved.NoOp {
		result.SavedAt = current.UpdatedAt
	}
	err = tx.Commit(ctx)
	return result, err
}

func (store *WorkspaceStore) CompleteCycle(ctx context.Context, input workspace.CompleteCycleInput) (result workspace.CompleteCycleResult, err error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer rollback(ctx, tx)
	var replayGoalID, replayCycleID, replayHash string
	err = tx.QueryRow(ctx, `SELECT goal_id,id,completion_request_hash FROM pdca_cycles
WHERE user_id=$1 AND completion_operation_id=$2`, mustUUID(input.UserID), mustUUID(input.OperationID)).Scan(&replayGoalID, &replayCycleID, &replayHash)
	if err == nil {
		if replayGoalID != input.GoalID || replayCycleID != input.CycleID || replayHash != input.RequestHash {
			return result, workspace.ErrIdempotencyKeyReused
		}
		result.Goal, err = getGoalView(ctx, tx, input.UserID, replayGoalID)
		if err != nil {
			return result, err
		}
		result.CompletedCycle, err = getCycleView(ctx, tx, input.UserID, replayGoalID, replayCycleID)
		if err != nil {
			return result, err
		}
		result.ReviewDraft, err = scanDraft(tx.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE user_id=$1 AND goal_id=$2 AND review_cycle_id=$3 AND draft_type='review'`, mustUUID(input.UserID), mustUUID(replayGoalID), mustUUID(replayCycleID)))
		if err != nil {
			if errors.Is(err, workspace.ErrNotFound) {
				result.Replay = &workspace.CommandReplayResponse{
					Replayed: true, Operation: "complete_cycle",
					ResourceIDs:      workspace.CommandReplayResourceIDs{GoalID: replayGoalID, CycleID: replayCycleID},
					CurrentGoalState: result.Goal.Status, CurrentWorkspace: result.Goal.CurrentWork,
				}
				return result, tx.Commit(ctx)
			}
			return result, err
		}
		result.Replayed = true
		return result, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	goalView, err := getGoalView(ctx, tx, input.UserID, input.GoalID)
	if err != nil {
		return result, err
	}
	if goalView.Status != goal.StatusActiveCycle || goalView.Revision != input.ExpectedGoalRevision {
		return result, workspace.ErrGoalStateConflict
	}
	current, err := loadCycleForUpdate(ctx, tx, input.UserID, input.GoalID, input.CycleID)
	if err != nil {
		return result, err
	}
	if current.CompletionOperationID != nil {
		if *current.CompletionOperationID != input.OperationID || current.CompletionRequestHash == nil || *current.CompletionRequestHash != input.RequestHash {
			return result, workspace.ErrIdempotencyKeyReused
		}
	}
	var aiRunning bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations WHERE cycle_id=$1 AND status='running')`, mustUUID(input.CycleID)).Scan(&aiRunning); err != nil {
		return result, err
	}
	completed, err := cycle.Complete(current, input.OperationID, input.RequestHash, input.ExpectedContentRevision, aiRunning, input.Now)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `UPDATE pdca_cycles SET status='completed',completed_at=$2,completion_operation_id=$3,
completion_request_hash=$4,updated_at=$2 WHERE id=$1`, mustUUID(input.CycleID), input.Now, mustUUID(input.OperationID), input.RequestHash)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO goal_drafts
(id,user_id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,created_at,updated_at)
VALUES($1,$2,'review',$3,$4,$5,$6,0,$7,$7)`, mustUUID(input.ReviewDraftID), mustUUID(input.UserID), mustUUID(input.GoalID), mustUUID(current.GoalVersionID), mustUUID(input.CycleID), goalView.CurrentVersion.Body, input.Now)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `UPDATE goals SET status='goal_review',revision=revision+1,updated_at=$2
WHERE id=$1`, mustUUID(input.GoalID), input.Now)
	if err != nil {
		return result, err
	}
	_ = completed
	result.CompletedCycle, err = getCycleView(ctx, tx, input.UserID, input.GoalID, input.CycleID)
	if err != nil {
		return result, err
	}
	result.Goal, err = getGoalView(ctx, tx, input.UserID, input.GoalID)
	if err != nil {
		return result, err
	}
	result.ReviewDraft, err = scanDraft(tx.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at FROM goal_drafts WHERE id=$1`, mustUUID(input.ReviewDraftID)))
	if err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}

func (store *WorkspaceStore) ContinueReview(ctx context.Context, input workspace.ContinueReviewInput) (result workspace.ContinueReviewResult, err error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer rollback(ctx, tx)
	var replayGoalID, replayCycleID, replayHash string
	err = tx.QueryRow(ctx, `SELECT goal_id,id,start_request_hash FROM pdca_cycles WHERE user_id=$1 AND start_operation_id=$2`, mustUUID(input.UserID), mustUUID(input.OperationID)).Scan(&replayGoalID, &replayCycleID, &replayHash)
	if err == nil {
		if replayHash != input.RequestHash || replayGoalID != input.GoalID {
			return result, workspace.ErrIdempotencyKeyReused
		}
		result.Goal, err = getGoalView(ctx, tx, input.UserID, input.GoalID)
		if err != nil {
			return result, err
		}
		result.Cycle, err = getCycleView(ctx, tx, input.UserID, input.GoalID, replayCycleID)
		if err != nil {
			return result, err
		}
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM goal_versions WHERE user_id=$1 AND goal_id=$2 AND created_by_operation_id=$3)`,
			mustUUID(input.UserID), mustUUID(input.GoalID), mustUUID(input.OperationID)).Scan(&result.VersionCreated)
		result.Replayed = true
		return result, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	var current goal.Goal
	err = tx.QueryRow(ctx, `SELECT id,user_id,status,current_version_number,next_cycle_sequence_number,revision,terminal_at,
terminal_operation_id,terminal_request_hash,created_at,updated_at FROM goals WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(input.GoalID), mustUUID(input.UserID)).Scan(
		&current.ID, &current.UserID, &current.Status, &current.CurrentVersionNumber, &current.NextCycleSequenceNumber, &current.Revision,
		&current.TerminalAt, &current.TerminalOperationID, &current.TerminalRequestHash, &current.CreatedAt, &current.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, workspace.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if current.Status != goal.StatusGoalReview {
		return result, workspace.ErrGoalReviewNotActive
	}
	if current.Revision != input.ExpectedGoalRevision {
		return result, workspace.ErrGoalRevisionConflict
	}
	draftView, err := scanDraft(tx.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE user_id=$1 AND goal_id=$2 AND draft_type='review' FOR UPDATE`, mustUUID(input.UserID), mustUUID(input.GoalID)))
	if err != nil {
		if errors.Is(err, workspace.ErrNotFound) {
			return result, workspace.ErrGoalReviewInvariant
		}
		return result, err
	}
	if draftView.Revision != input.ExpectedDraftRevision {
		return result, workspace.ErrReviewRevisionConflict
	}
	var running bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations WHERE source_goal_draft_id=$1 AND status='running')`, mustUUID(draftView.ID)).Scan(&running); err != nil {
		return result, err
	}
	if running {
		return result, workspace.ErrAIInProgress
	}
	var version goal.Version
	err = tx.QueryRow(ctx, `SELECT id,user_id,goal_id,version_number,body,created_by_operation_id,created_at FROM goal_versions
WHERE goal_id=$1 AND version_number=$2`, mustUUID(input.GoalID), current.CurrentVersionNumber).Scan(
		&version.ID, &version.UserID, &version.GoalID, &version.VersionNumber, &version.Body, &version.CreatedByOperationID, &version.CreatedAt)
	if err != nil {
		return result, workspace.ErrGoalVersionConflict
	}
	domainDraft := goal.Draft{ID: draftView.ID, UserID: input.UserID, Type: goal.DraftReview, GoalID: draftView.GoalID,
		BaseGoalVersionID: draftView.BaseGoalVersionID, ReviewCycleID: draftView.ReviewCycleID, Body: draftView.Body, Revision: draftView.Revision}
	continued, err := goal.ContinueReview(current, version, domainDraft, input.VersionID, input.CycleID, input.OperationID, input.RequestHash, input.Now)
	if err != nil {
		return result, err
	}
	if continued.VersionCreated {
		_, err = tx.Exec(ctx, `INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,$4,$5,$6,$7)`, mustUUID(continued.Version.ID), mustUUID(input.UserID), mustUUID(input.GoalID), continued.Version.VersionNumber, continued.Version.Body, mustUUID(input.OperationID), input.Now)
		if err != nil {
			return result, err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$6,$6)`, mustUUID(input.CycleID), mustUUID(input.UserID), mustUUID(input.GoalID), mustUUID(continued.Version.ID), continued.Cycle.SequenceNumber, input.Now, mustUUID(input.OperationID), input.RequestHash)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `UPDATE goals SET status='active_cycle',current_version_number=$2,next_cycle_sequence_number=$3,
revision=revision+1,updated_at=$4 WHERE id=$1`, mustUUID(input.GoalID), continued.Goal.CurrentVersionNumber, continued.Goal.NextCycleSequenceNumber, input.Now)
	if err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_generations SET source_goal_draft_id=NULL,goal_id=$2,goal_version_id=$3
WHERE user_id=$1 AND source_goal_draft_id=$4`, mustUUID(input.UserID), mustUUID(input.GoalID), mustUUID(continued.Version.ID), mustUUID(draftView.ID)); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM goal_drafts WHERE id=$1`, mustUUID(draftView.ID)); err != nil {
		return result, err
	}
	result.Goal, err = getGoalView(ctx, tx, input.UserID, input.GoalID)
	if err != nil {
		return result, err
	}
	result.Cycle, err = getCycleView(ctx, tx, input.UserID, input.GoalID, input.CycleID)
	result.VersionCreated = continued.VersionCreated
	if err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}

func (store *WorkspaceStore) Terminate(ctx context.Context, input workspace.TerminateInput) (result workspace.TerminateResult, err error) {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer rollback(ctx, tx)
	if err = lockUser(ctx, tx, user.ID(input.UserID)); err != nil {
		return result, workspace.ErrNotFound
	}
	var status goal.Status
	var revision int64
	var terminalOperation, terminalHash *string
	err = tx.QueryRow(ctx, `SELECT status,revision,terminal_operation_id,terminal_request_hash FROM goals
WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(input.GoalID), mustUUID(input.UserID)).Scan(&status, &revision, &terminalOperation, &terminalHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, workspace.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if status == goal.StatusAchieved || status == goal.StatusEnded {
		if terminalOperation != nil && *terminalOperation == input.OperationID {
			if terminalHash == nil || *terminalHash != input.RequestHash {
				return result, workspace.ErrIdempotencyKeyReused
			}
			result.Goal, err = getGoalView(ctx, tx, input.UserID, input.GoalID)
			result.Replayed = true
			return result, err
		}
		return result, workspace.ErrGoalAlreadyTerminal
	}
	if revision != input.ExpectedGoalRevision || status != input.ExpectedState {
		return result, workspace.ErrGoalStateConflict
	}
	var running bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations WHERE goal_id=$1 AND status='running')`, mustUUID(input.GoalID)).Scan(&running); err != nil {
		return result, err
	}
	if running {
		return result, workspace.ErrAIInProgress
	}
	if status == goal.StatusActiveCycle {
		if input.ExpectedCycleContentRevision == nil {
			return result, workspace.ErrGoalStateConflict
		}
		current, loadErr := loadCycleForUpdate(ctx, tx, input.UserID, input.GoalID, input.ActiveCycleID)
		if loadErr != nil {
			return result, loadErr
		}
		if current.Revisions.Content != *input.ExpectedCycleContentRevision {
			return result, cycle.ErrRevisionConflict
		}
		reason := cycle.CancellationGoalEnded
		if input.Outcome == goal.StatusAchieved {
			reason = cycle.CancellationGoalAchieved
		}
		_, err = tx.Exec(ctx, `UPDATE pdca_cycles SET status='canceled',canceled_at=$2,cancellation_reason=$3,updated_at=$2
WHERE id=$1`, mustUUID(current.ID), input.Now, reason)
		if err != nil {
			return result, err
		}
		canceled, getErr := getCycleView(ctx, tx, input.UserID, input.GoalID, current.ID)
		if getErr != nil {
			return result, getErr
		}
		result.CanceledCycle = &canceled
	} else {
		draft, getErr := scanDraft(tx.QueryRow(ctx, `SELECT id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts WHERE user_id=$1 AND goal_id=$2 AND draft_type='review' FOR UPDATE`, mustUUID(input.UserID), mustUUID(input.GoalID)))
		if getErr != nil {
			return result, getErr
		}
		var versionBody string
		if err = tx.QueryRow(ctx, `SELECT body FROM goal_versions WHERE goal_id=$1 AND id=$2`, mustUUID(input.GoalID), mustUUID(*draft.BaseGoalVersionID)).Scan(&versionBody); err != nil {
			return result, err
		}
		if normalizeNewlines(draft.Body) != normalizeNewlines(versionBody) && !input.ConfirmDiscardReviewDraft {
			return result, workspace.ErrDiscardConfirmation
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_usage_events SET goal_id=NULL,content_deleted=true WHERE operation_id IN
(SELECT id FROM ai_generations WHERE source_goal_draft_id=$1)`, mustUUID(draft.ID)); err != nil {
			return result, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM ai_generations WHERE source_goal_draft_id=$1`, mustUUID(draft.ID)); err != nil {
			return result, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM goal_drafts WHERE id=$1`, mustUUID(draft.ID)); err != nil {
			return result, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE goals SET status=$2,revision=revision+1,terminal_at=$3,terminal_operation_id=$4,
terminal_request_hash=$5,updated_at=$3 WHERE id=$1`, mustUUID(input.GoalID), input.Outcome, input.Now, mustUUID(input.OperationID), input.RequestHash)
	if err != nil {
		return result, err
	}
	result.Goal, err = getGoalView(ctx, tx, input.UserID, input.GoalID)
	if err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}

func (store *WorkspaceStore) DeleteGoal(ctx context.Context, userID, goalID string, confirmed bool, expectedRevision int64, key, requestHash string, now time.Time) (err error) {
	if !confirmed {
		return workspace.ErrDeleteConfirmation
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	if err = lockUser(ctx, tx, user.ID(userID)); err != nil {
		return workspace.ErrNotFound
	}
	var receiptGoal, receiptHash string
	err = tx.QueryRow(ctx, `SELECT deleted_goal_id,request_hash FROM goal_delete_receipts
WHERE user_id=$1 AND idempotency_key=$2 AND expires_at>$3`, mustUUID(userID), mustUUID(key), now).Scan(&receiptGoal, &receiptHash)
	if err == nil {
		if receiptGoal != goalID || receiptHash != requestHash {
			return workspace.ErrIdempotencyKeyReused
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var revision int64
	err = tx.QueryRow(ctx, `SELECT revision FROM goals WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(goalID), mustUUID(userID)).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.ErrNotFound
	}
	if err != nil {
		return err
	}
	if revision != expectedRevision {
		return workspace.ErrDeleteConflict
	}
	rows, err := tx.Query(ctx, `SELECT id,budget_month_utc,budget_reserved_cost_usd FROM ai_generations
WHERE goal_id=$1 AND status='running' ORDER BY id FOR UPDATE`, mustUUID(goalID))
	if err != nil {
		return err
	}
	type reservation struct {
		id     string
		month  time.Time
		amount float64
	}
	var reservations []reservation
	for rows.Next() {
		var item reservation
		if err = rows.Scan(&item.id, &item.month, &item.amount); err != nil {
			rows.Close()
			return err
		}
		reservations = append(reservations, item)
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return rowErr
	}
	sort.Slice(reservations, func(i, j int) bool { return reservations[i].month.Before(reservations[j].month) })
	for _, item := range reservations {
		if item.amount > 0 {
			if _, err = tx.Exec(ctx, `UPDATE ai_budget_monthly SET reserved_cost_usd=reserved_cost_usd-$2,updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2`, item.month, item.amount, now); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE ai_generations SET status='failed',failure_code='goal_deleted',
budget_reserved_cost_usd=0,lease_expires_at=NULL,finished_at=$2 WHERE id=$1`, mustUUID(item.id), now); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_usage_events SET goal_id=NULL,status=CASE WHEN status='accepted' THEN 'failed' ELSE status END,
content_deleted=true WHERE user_id=$1 AND goal_id=$2`, mustUUID(userID), mustUUID(goalID)); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `DELETE FROM goals WHERE id=$1 AND user_id=$2`, mustUUID(goalID), mustUUID(userID))
	if err != nil || command.RowsAffected() != 1 {
		return workspace.ErrNotFound
	}
	_, err = tx.Exec(ctx, `INSERT INTO goal_delete_receipts
(user_id,idempotency_key,deleted_goal_id,request_hash,deleted_at,expires_at)
VALUES($1,$2,$3,$4,$5,$6)`, mustUUID(userID), mustUUID(key), mustUUID(goalID), requestHash, now, now.Add(24*time.Hour))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func loadCycleForUpdate(ctx context.Context, tx pgx.Tx, userID, goalID, cycleID string) (cycle.PDCACycle, error) {
	var current cycle.PDCACycle
	err := tx.QueryRow(ctx, `SELECT id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,completed_at,canceled_at,
cancellation_reason,plan,do_text,check_text,action,content_revision,plan_revision,do_revision,check_revision,action_revision,
action_last_ai_applied_content_revision,action_user_modified_after_ai,start_operation_id,start_request_hash,
completion_operation_id,completion_request_hash,created_at,updated_at
FROM pdca_cycles WHERE id=$1 AND goal_id=$2 AND user_id=$3 FOR UPDATE`, mustUUID(cycleID), mustUUID(goalID), mustUUID(userID)).Scan(
		&current.ID, &current.UserID, &current.GoalID, &current.GoalVersionID, &current.SequenceNumber, &current.Status,
		&current.StartedAt, &current.CompletedAt, &current.CanceledAt, &current.CancellationReason,
		&current.Plan, &current.Do, &current.Check, &current.Action,
		&current.Revisions.Content, &current.Revisions.Plan, &current.Revisions.Do, &current.Revisions.Check, &current.Revisions.Action,
		&current.ActionLastAIRevision, &current.ActionModifiedAfterAI, &current.StartOperationID, &current.StartRequestHash,
		&current.CompletionOperationID, &current.CompletionRequestHash, &current.CreatedAt, &current.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return cycle.PDCACycle{}, workspace.ErrNotFound
	}
	return current, err
}

func updatedFrame(view workspace.CycleView, frame cycle.Frame) string {
	switch frame {
	case cycle.FramePlan:
		return view.Plan
	case cycle.FrameDo:
		return view.Do
	case cycle.FrameCheck:
		return view.Check
	case cycle.FrameAction:
		return view.Action
	default:
		return ""
	}
}

func updatedRevision(view workspace.CycleView, frame cycle.Frame) int64 {
	switch frame {
	case cycle.FramePlan:
		return view.FrameRevisions.Plan
	case cycle.FrameDo:
		return view.FrameRevisions.Do
	case cycle.FrameCheck:
		return view.FrameRevisions.Check
	case cycle.FrameAction:
		return view.FrameRevisions.Action
	default:
		return -1
	}
}

func normalizeNewlines(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.ReplaceAll(value, "\r", "\n")
}
