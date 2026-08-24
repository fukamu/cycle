package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

// loadCycleForUpdate remains for the Action AI transition until that
// orchestration is moved behind its own Application transaction boundary.
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
