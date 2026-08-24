package postgres

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type lockedGoalState struct {
	status   goal.Status
	revision int64
}

func loadGoalForUpdate(ctx context.Context, tx pgx.Tx, userID, goalID string) (lockedGoalState, error) {
	var current lockedGoalState
	err := tx.QueryRow(ctx, `SELECT status,revision FROM goals
WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(goalID), mustUUID(userID)).Scan(
		&current.status,
		&current.revision,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedGoalState{}, workspace.ErrNotFound
	}
	if err != nil {
		return lockedGoalState{}, err
	}
	return current, nil
}

func loadTerminateReplay(ctx context.Context, tx pgx.Tx, input workspace.TerminateInput) (result workspace.TerminateResult, found bool, err error) {
	var replayGoalID, replayHash string
	err = tx.QueryRow(ctx, `SELECT id,terminal_request_hash FROM goals
WHERE user_id=$1 AND terminal_operation_id=$2`, mustUUID(input.UserID), mustUUID(input.OperationID)).Scan(&replayGoalID, &replayHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, false, nil
	}
	if err != nil {
		return result, false, err
	}
	if replayGoalID != input.GoalID || replayHash != input.RequestHash {
		return result, true, workspace.ErrIdempotencyKeyReused
	}
	result.Goal, err = getGoalView(ctx, tx, input.UserID, replayGoalID)
	if err != nil {
		return result, true, err
	}
	result.Replayed = true
	return result, true, nil
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
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return result, err
	}
	defer rollback(ctx, tx)
	if err = lockUser(ctx, tx, user.ID(input.UserID)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return result, workspace.ErrNotFound
		}
		return result, err
	}
	result, replayed, err := loadTerminateReplay(ctx, tx, input)
	if err != nil {
		return result, err
	}
	if replayed {
		return result, tx.Commit(ctx)
	}
	lockedGoal, err := loadGoalForUpdate(ctx, tx, input.UserID, input.GoalID)
	if err != nil {
		return result, err
	}
	if lockedGoal.status == goal.StatusAchieved || lockedGoal.status == goal.StatusEnded {
		return result, workspace.ErrGoalAlreadyTerminal
	}
	if lockedGoal.revision != input.ExpectedGoalRevision || lockedGoal.status != input.ExpectedState {
		return result, workspace.ErrGoalStateConflict
	}
	var running bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ai_generations WHERE goal_id=$1 AND status='running')`, mustUUID(input.GoalID)).Scan(&running); err != nil {
		return result, err
	}
	if running {
		return result, workspace.ErrAIInProgress
	}
	if lockedGoal.status == goal.StatusActiveCycle {
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

func normalizeNewlines(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.ReplaceAll(value, "\r", "\n")
}
