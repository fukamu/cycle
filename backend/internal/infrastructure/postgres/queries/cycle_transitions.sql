-- name: FindCompleteCycleReceipt :one
SELECT
    goal_id,
    id AS cycle_id,
    completion_request_hash AS request_hash
FROM pdca_cycles
WHERE user_id = sqlc.arg(user_id)::uuid
  AND completion_operation_id = sqlc.arg(operation_id)::uuid;

-- name: FindStartReplay :one
SELECT
    goal_id,
    id AS cycle_id,
    start_request_hash AS request_hash
FROM pdca_cycles
WHERE user_id = sqlc.arg(user_id)::uuid
  AND start_operation_id = sqlc.arg(operation_id)::uuid;

-- name: FindContinueReviewReceipt :one
SELECT
    c.goal_id,
    c.id AS cycle_id,
    c.start_request_hash AS request_hash,
    EXISTS (
        SELECT 1
        FROM goal_versions AS gv
        WHERE gv.user_id = c.user_id
          AND gv.goal_id = c.goal_id
          AND gv.created_by_operation_id = c.start_operation_id
    ) AS version_created
FROM pdca_cycles AS c
WHERE c.user_id = sqlc.arg(user_id)::uuid
  AND c.start_operation_id = sqlc.arg(operation_id)::uuid;

-- name: LockCycleForTransition :one
SELECT c.*
FROM pdca_cycles AS c
WHERE c.id = sqlc.arg(cycle_id)::uuid
  AND c.goal_id = sqlc.arg(goal_id)::uuid
  AND c.user_id = sqlc.arg(user_id)::uuid
FOR UPDATE;

-- name: HasRunningCycleGenerationForTransition :one
SELECT EXISTS (
    SELECT 1
    FROM ai_generations
    WHERE user_id = sqlc.arg(user_id)::uuid
      AND goal_id = sqlc.arg(goal_id)::uuid
      AND cycle_id = sqlc.arg(cycle_id)::uuid
      AND status = 'running'
) AS running;

-- name: HasRunningGoalGenerationForReviewTransition :one
SELECT EXISTS (
    SELECT 1
    FROM ai_generations
    WHERE user_id = sqlc.arg(user_id)::uuid
      AND goal_id = sqlc.arg(goal_id)::uuid
      AND status = 'running'
) AS running;

-- name: TryInsertCycleClaim :execrows
INSERT INTO pdca_cycles (
    id,
    user_id,
    goal_id,
    goal_version_id,
    sequence_number,
    status,
    started_at,
    start_operation_id,
    start_request_hash,
    created_at,
    updated_at
)
VALUES (
    sqlc.arg(cycle_id)::uuid,
    sqlc.arg(user_id)::uuid,
    sqlc.arg(goal_id)::uuid,
    sqlc.arg(goal_version_id)::uuid,
    sqlc.arg(sequence_number)::integer,
    sqlc.arg(status)::text,
    sqlc.arg(started_at)::timestamptz,
    sqlc.arg(start_operation_id)::uuid,
    sqlc.arg(start_request_hash)::text,
    sqlc.arg(created_at)::timestamptz,
    sqlc.arg(updated_at)::timestamptz
)
ON CONFLICT (user_id, start_operation_id) DO NOTHING;

-- name: SaveCyclePlanCAS :execrows
UPDATE pdca_cycles
SET plan = sqlc.arg(content)::text,
    plan_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND plan_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: SaveCycleDoCAS :execrows
UPDATE pdca_cycles
SET do_text = sqlc.arg(content)::text,
    do_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND do_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: SaveCycleCheckCAS :execrows
UPDATE pdca_cycles
SET check_text = sqlc.arg(content)::text,
    check_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND check_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: SaveCycleActionCAS :execrows
UPDATE pdca_cycles
SET action = sqlc.arg(content)::text,
    action_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    action_user_modified_after_ai = sqlc.arg(action_user_modified_after_ai)::boolean,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND action_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: CompleteCycleCAS :execrows
UPDATE pdca_cycles
SET status = 'completed',
    completed_at = sqlc.arg(completed_at)::timestamptz,
    completion_operation_id = sqlc.arg(completion_operation_id)::uuid,
    completion_request_hash = sqlc.arg(completion_request_hash)::text,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND content_revision = sqlc.arg(expected_content_revision)::bigint
  AND completion_operation_id IS NULL
  AND completion_request_hash IS NULL;

-- name: ApplyActionAICAS :execrows
UPDATE pdca_cycles
SET action = sqlc.arg(action)::text,
    content_revision = sqlc.arg(new_content_revision)::bigint,
    action_revision = sqlc.arg(new_action_revision)::bigint,
    action_last_ai_applied_content_revision = sqlc.arg(new_content_revision)::bigint,
    action_user_modified_after_ai = FALSE,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND goal_version_id = sqlc.arg(goal_version_id)::uuid
  AND status = 'active'
  AND content_revision = sqlc.arg(expected_content_revision)::bigint
  AND action_revision = sqlc.arg(expected_action_revision)::bigint;

-- name: CancelCycleCAS :execrows
UPDATE pdca_cycles
SET status = sqlc.arg(status)::text,
    canceled_at = sqlc.arg(canceled_at)::timestamptz,
    cancellation_reason = sqlc.arg(cancellation_reason)::text,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND content_revision = sqlc.arg(expected_content_revision)::bigint;

-- name: ListAIContextCycles :many
SELECT
    c.id AS cycle_id,
    c.goal_id,
    c.sequence_number,
    c.status,
    gv.body AS goal_body,
    c.plan,
    c.do_text,
    c.check_text,
    c.action
FROM pdca_cycles AS c
JOIN goal_versions AS gv
  ON gv.goal_id = c.goal_id
 AND gv.id = c.goal_version_id
WHERE c.user_id = sqlc.arg(user_id)::uuid
  AND c.goal_id = sqlc.arg(goal_id)::uuid
  AND c.status IN ('completed', 'canceled')
  AND (
      sqlc.narg(exclude_cycle_id)::uuid IS NULL
      OR c.id <> sqlc.narg(exclude_cycle_id)::uuid
  )
ORDER BY c.sequence_number DESC
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: LockGoalCycleIDs :many
SELECT id
FROM pdca_cycles
WHERE goal_id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
ORDER BY id
FOR UPDATE;

-- name: LockAccountCycleIDs :many
SELECT id
FROM pdca_cycles
WHERE user_id = sqlc.arg(user_id)::uuid
ORDER BY id
FOR UPDATE;
