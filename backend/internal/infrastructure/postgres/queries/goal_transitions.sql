-- name: LockGoalForTransition :one
SELECT
    id,
    user_id,
    status,
    current_version_number,
    next_cycle_sequence_number,
    revision,
    terminal_at,
    terminal_operation_id,
    terminal_request_hash,
    created_at,
    updated_at
FROM goals
WHERE id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
FOR UPDATE;

-- name: LoadCurrentGoalVersionForTransition :one
SELECT
    gv.id,
    gv.user_id,
    gv.goal_id,
    gv.version_number,
    gv.body,
    gv.created_by_operation_id,
    gv.created_at
FROM goals g
LEFT JOIN goal_versions gv
  ON gv.user_id = g.user_id
 AND gv.goal_id = g.id
 AND gv.version_number = sqlc.arg(version_number)::integer
WHERE g.id = sqlc.arg(goal_id)::uuid
  AND g.user_id = sqlc.arg(user_id)::uuid;

-- name: InsertReviewDraftForTransition :execrows
INSERT INTO goal_drafts (
    id,
    user_id,
    draft_type,
    goal_id,
    base_goal_version_id,
    review_cycle_id,
    body,
    revision,
    created_at,
    updated_at
)
VALUES (
    sqlc.arg(draft_id)::uuid,
    sqlc.arg(user_id)::uuid,
    'review',
    sqlc.arg(goal_id)::uuid,
    sqlc.arg(base_goal_version_id)::uuid,
    sqlc.arg(review_cycle_id)::uuid,
    sqlc.arg(body)::text,
    sqlc.arg(revision)::bigint,
    sqlc.arg(created_at)::timestamptz,
    sqlc.arg(updated_at)::timestamptz
);

-- name: EnterGoalReviewCAS :execrows
UPDATE goals
SET status = 'goal_review',
    revision = sqlc.arg(revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND status = 'active_cycle'
  AND revision = sqlc.arg(expected_revision)::bigint
  AND current_version_number = sqlc.arg(current_version_number)::integer
  AND next_cycle_sequence_number = sqlc.arg(next_cycle_sequence_number)::integer;

-- name: FindReviewDraftByCycle :one
SELECT
    id,
    draft_type,
    goal_id,
    base_goal_version_id,
    review_cycle_id,
    body,
    revision,
    updated_at
FROM goal_drafts
WHERE user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND review_cycle_id = sqlc.arg(cycle_id)::uuid
  AND draft_type = 'review';

-- name: FindGoalTerminationReceipt :one
SELECT
    id AS goal_id,
    terminal_request_hash AS request_hash
FROM goals
WHERE user_id = sqlc.arg(user_id)::uuid
  AND terminal_operation_id = sqlc.arg(operation_id)::uuid;

-- name: ContinueGoalCAS :execrows
UPDATE goals
SET status = sqlc.arg(status)::text,
    current_version_number = sqlc.arg(current_version_number)::integer,
    next_cycle_sequence_number = sqlc.arg(next_cycle_sequence_number)::integer,
    revision = sqlc.arg(revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND status = 'goal_review'
  AND revision = sqlc.arg(expected_revision)::bigint;

-- name: DeleteReviewDraftCAS :execrows
DELETE FROM goal_drafts
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND draft_type = 'review'
  AND revision = sqlc.arg(expected_revision)::bigint;

-- name: TerminateGoalCAS :execrows
UPDATE goals
SET status = sqlc.arg(status)::text,
    revision = sqlc.arg(revision)::bigint,
    terminal_at = sqlc.arg(terminal_at)::timestamptz,
    terminal_operation_id = sqlc.arg(terminal_operation_id)::uuid,
    terminal_request_hash = sqlc.arg(terminal_request_hash)::text,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND status IN ('active_cycle', 'goal_review')
  AND revision = sqlc.arg(expected_revision)::bigint;
