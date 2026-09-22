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
    COALESCE(public.fukamu_cycle_content_read_text(
      gv.content_storage_format, gv.body, gv.body_dek_version,
      gv.body_crypto_revision, gv.body_nonce, gv.body_ciphertext
    ), '')::text AS body,
    COALESCE(public.fukamu_cycle_content_read_text(
        signal.content_storage_format, signal.success_signal,
        signal.success_signal_dek_version, signal.success_signal_crypto_revision,
        signal.success_signal_nonce, signal.success_signal_ciphertext
    ), '')::text AS success_signal,
    gv.created_by_operation_id,
    gv.created_at
FROM goals g
LEFT JOIN goal_versions gv
  ON gv.user_id = g.user_id
 AND gv.goal_id = g.id
 AND gv.version_number = sqlc.arg(version_number)::integer
LEFT JOIN goal_version_success_signals signal
  ON signal.goal_version_id = gv.id
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

-- name: InsertReviewDraftSuccessSignalForTransition :execrows
INSERT INTO goal_draft_success_signals (goal_draft_id, success_signal)
VALUES (sqlc.arg(goal_draft_id)::uuid, sqlc.arg(success_signal)::text);

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
    d.id,
    d.draft_type,
    d.goal_id,
    d.base_goal_version_id,
    d.review_cycle_id,
    public.fukamu_cycle_content_read_text(
      d.content_storage_format, d.body, d.body_dek_version,
      d.body_crypto_revision, d.body_nonce, d.body_ciphertext
    ) AS body,
    COALESCE(public.fukamu_cycle_content_read_text(
        signal.content_storage_format, signal.success_signal,
        signal.success_signal_dek_version, signal.success_signal_crypto_revision,
        signal.success_signal_nonce, signal.success_signal_ciphertext
    ), '')::text AS success_signal,
    d.revision,
    d.updated_at
FROM goal_drafts d
LEFT JOIN goal_draft_success_signals signal ON signal.goal_draft_id = d.id
WHERE d.user_id = sqlc.arg(user_id)::uuid
  AND d.goal_id = sqlc.arg(goal_id)::uuid
  AND d.review_cycle_id = sqlc.arg(cycle_id)::uuid
  AND d.draft_type = 'review';

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
