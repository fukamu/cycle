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

-- name: FindReplanCycleReceipt :one
SELECT
    current_cycle.goal_id,
    current_cycle.id AS cycle_id,
    current_cycle.start_request_hash AS request_hash,
    previous_cycle.id AS replanned_cycle_id,
    previous_cycle.cancellation_reason AS replanned_cancellation_reason
FROM pdca_cycles AS current_cycle
LEFT JOIN pdca_cycles AS previous_cycle
  ON previous_cycle.user_id = current_cycle.user_id
 AND previous_cycle.goal_id = current_cycle.goal_id
 AND previous_cycle.sequence_number = current_cycle.sequence_number - 1
WHERE current_cycle.user_id = sqlc.arg(user_id)::uuid
  AND current_cycle.start_operation_id = sqlc.arg(operation_id)::uuid;

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
SELECT
    c.id,
    c.user_id,
    c.goal_id,
    c.goal_version_id,
    c.sequence_number,
    c.status,
    c.started_at,
    c.completed_at,
    c.canceled_at,
    c.cancellation_reason,
    public.fukamu_cycle_content_read_text(
      c.content_storage_format, c.plan, c.plan_dek_version,
      c.plan_crypto_revision, c.plan_nonce, c.plan_ciphertext
    ) AS plan,
    public.fukamu_cycle_content_read_text(
      c.content_storage_format, c.do_text, c.do_text_dek_version,
      c.do_text_crypto_revision, c.do_text_nonce, c.do_text_ciphertext
    ) AS do_text,
    public.fukamu_cycle_content_read_text(
      c.content_storage_format, c.check_text, c.check_text_dek_version,
      c.check_text_crypto_revision, c.check_text_nonce, c.check_text_ciphertext
    ) AS check_text,
    public.fukamu_cycle_content_read_text(
      c.content_storage_format, c.action, c.action_dek_version,
      c.action_crypto_revision, c.action_nonce, c.action_ciphertext
    ) AS action,
    c.content_revision,
    c.plan_revision,
    c.do_revision,
    c.check_revision,
    c.action_revision,
    c.action_last_ai_applied_content_revision,
    c.action_user_modified_after_ai,
    c.content_storage_format,
    c.start_operation_id,
    c.start_request_hash,
    c.completion_operation_id,
    c.completion_request_hash,
    c.created_at,
    c.updated_at
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

-- name: GetCycleReviewSchedule :one
SELECT
    review_date,
    review_schedule_revision
FROM pdca_cycle_review_schedules
WHERE cycle_id = sqlc.arg(cycle_id)::uuid;

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
    plan,
    do_text,
    check_text,
    action,
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
    sqlc.arg(plan)::text,
    sqlc.arg(do_text)::text,
    sqlc.arg(check_text)::text,
    sqlc.arg(action)::text,
    sqlc.arg(start_operation_id)::uuid,
    sqlc.arg(start_request_hash)::text,
    sqlc.arg(created_at)::timestamptz,
    sqlc.arg(updated_at)::timestamptz
)
ON CONFLICT (user_id, start_operation_id) DO NOTHING;

-- name: SaveCyclePlanCAS :execrows
UPDATE pdca_cycles
SET plan = sqlc.arg(plan)::text,
    plan_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND plan_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: MigrateLegacyCyclePlanCAS :execrows
UPDATE pdca_cycles
SET plan = sqlc.arg(plan)::text,
    do_text = sqlc.arg(do_text)::text,
    check_text = sqlc.arg(check_text)::text,
    action = sqlc.arg(action)::text,
    plan_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND content_storage_format = 'legacy'
  AND plan_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: SaveCycleReviewScheduleCAS :execrows
INSERT INTO pdca_cycle_review_schedules (
    cycle_id,
    review_date,
    review_schedule_revision
)
SELECT
    sqlc.arg(cycle_id)::uuid,
    sqlc.narg(review_date)::date,
    sqlc.arg(review_schedule_revision)::bigint
WHERE sqlc.arg(expected_review_schedule_revision)::bigint = 0
   OR EXISTS (
        SELECT 1
        FROM pdca_cycle_review_schedules AS current_schedule
        WHERE current_schedule.cycle_id = sqlc.arg(cycle_id)::uuid
          AND current_schedule.review_schedule_revision =
              sqlc.arg(expected_review_schedule_revision)::bigint
   )
ON CONFLICT (cycle_id) DO UPDATE
SET review_date = EXCLUDED.review_date,
    review_schedule_revision = EXCLUDED.review_schedule_revision
WHERE pdca_cycle_review_schedules.review_schedule_revision =
      sqlc.arg(expected_review_schedule_revision)::bigint;

-- name: SaveCycleDoCAS :execrows
UPDATE pdca_cycles
SET do_text = sqlc.arg(do_text)::text,
    do_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND do_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: MigrateLegacyCycleDoCAS :execrows
UPDATE pdca_cycles
SET plan = sqlc.arg(plan)::text,
    do_text = sqlc.arg(do_text)::text,
    check_text = sqlc.arg(check_text)::text,
    action = sqlc.arg(action)::text,
    do_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND content_storage_format = 'legacy'
  AND do_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: SaveCycleCheckCAS :execrows
UPDATE pdca_cycles
SET check_text = sqlc.arg(check_text)::text,
    check_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND check_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: MigrateLegacyCycleCheckCAS :execrows
UPDATE pdca_cycles
SET plan = sqlc.arg(plan)::text,
    do_text = sqlc.arg(do_text)::text,
    check_text = sqlc.arg(check_text)::text,
    action = sqlc.arg(action)::text,
    check_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND content_storage_format = 'legacy'
  AND check_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: SaveCycleActionCAS :execrows
UPDATE pdca_cycles
SET action = sqlc.arg(action)::text,
    action_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    action_user_modified_after_ai = sqlc.arg(action_user_modified_after_ai)::boolean,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND action_revision = sqlc.arg(expected_frame_revision)::bigint;

-- name: MigrateLegacyCycleActionCAS :execrows
UPDATE pdca_cycles
SET plan = sqlc.arg(plan)::text,
    do_text = sqlc.arg(do_text)::text,
    check_text = sqlc.arg(check_text)::text,
    action = sqlc.arg(action)::text,
    action_revision = sqlc.arg(frame_revision)::bigint,
    content_revision = sqlc.arg(content_revision)::bigint,
    action_user_modified_after_ai = sqlc.arg(action_user_modified_after_ai)::boolean,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(cycle_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'active'
  AND content_storage_format = 'legacy'
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

-- name: ReplanGoalCAS :execrows
UPDATE goals
SET next_cycle_sequence_number = sqlc.arg(next_cycle_sequence_number)::integer,
    revision = sqlc.arg(revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND status = 'active_cycle'
  AND current_version_number = sqlc.arg(current_version_number)::integer
  AND next_cycle_sequence_number = sqlc.arg(expected_next_cycle_sequence_number)::integer
  AND revision = sqlc.arg(expected_revision)::bigint;

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

-- name: ApplyActionAIMigrateLegacyCAS :execrows
UPDATE pdca_cycles
SET plan = sqlc.arg(plan)::text,
    do_text = sqlc.arg(do_text)::text,
    check_text = sqlc.arg(check_text)::text,
    action = sqlc.arg(action)::text,
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
  AND content_storage_format = 'legacy'
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
    gv.id AS goal_version_id,
    public.fukamu_cycle_content_read_text(
      gv.content_storage_format, gv.body, gv.body_dek_version,
      gv.body_crypto_revision, gv.body_nonce, gv.body_ciphertext
    ) AS goal_body,
    public.fukamu_cycle_content_read_text(
      c.content_storage_format, c.plan, c.plan_dek_version,
      c.plan_crypto_revision, c.plan_nonce, c.plan_ciphertext
    ) AS plan,
    public.fukamu_cycle_content_read_text(
      c.content_storage_format, c.do_text, c.do_text_dek_version,
      c.do_text_crypto_revision, c.do_text_nonce, c.do_text_ciphertext
    ) AS do_text,
    public.fukamu_cycle_content_read_text(
      c.content_storage_format, c.check_text, c.check_text_dek_version,
      c.check_text_crypto_revision, c.check_text_nonce, c.check_text_ciphertext
    ) AS check_text,
    public.fukamu_cycle_content_read_text(
      c.content_storage_format, c.action, c.action_dek_version,
      c.action_crypto_revision, c.action_nonce, c.action_ciphertext
    ) AS action
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
