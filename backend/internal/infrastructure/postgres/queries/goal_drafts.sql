-- name: FindCreationDraft :one
SELECT d.id, d.user_id, d.draft_type, d.goal_id, d.base_goal_version_id, d.review_cycle_id,
       public.fukamu_cycle_content_read_text(
         d.content_storage_format, d.body, d.body_dek_version,
         d.body_crypto_revision, d.body_nonce, d.body_ciphertext
       ) AS body,
       COALESCE(public.fukamu_cycle_content_read_text(
           signal.content_storage_format, signal.success_signal,
           signal.success_signal_dek_version, signal.success_signal_crypto_revision,
           signal.success_signal_nonce, signal.success_signal_ciphertext
       ), '')::text AS success_signal,
       d.revision, d.created_at, d.updated_at
FROM goal_drafts d
LEFT JOIN goal_draft_success_signals signal ON signal.goal_draft_id = d.id
WHERE user_id = sqlc.arg(user_id)::uuid
  AND draft_type = 'creation';

-- name: LockDraftByID :one
SELECT d.id, d.user_id, d.draft_type, d.goal_id, d.base_goal_version_id, d.review_cycle_id,
       public.fukamu_cycle_content_read_text(
         d.content_storage_format, d.body, d.body_dek_version,
         d.body_crypto_revision, d.body_nonce, d.body_ciphertext
       ) AS body,
       COALESCE(public.fukamu_cycle_content_read_text(
           signal.content_storage_format, signal.success_signal,
           signal.success_signal_dek_version, signal.success_signal_crypto_revision,
           signal.success_signal_nonce, signal.success_signal_ciphertext
       ), '')::text AS success_signal,
       d.revision, d.created_at, d.updated_at
FROM goal_drafts d
LEFT JOIN goal_draft_success_signals signal ON signal.goal_draft_id = d.id
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
FOR UPDATE OF d;

-- name: LockReviewDraftByGoal :one
SELECT d.id, d.user_id, d.draft_type, d.goal_id, d.base_goal_version_id, d.review_cycle_id,
       public.fukamu_cycle_content_read_text(
         d.content_storage_format, d.body, d.body_dek_version,
         d.body_crypto_revision, d.body_nonce, d.body_ciphertext
       ) AS body,
       COALESCE(public.fukamu_cycle_content_read_text(
           signal.content_storage_format, signal.success_signal,
           signal.success_signal_dek_version, signal.success_signal_crypto_revision,
           signal.success_signal_nonce, signal.success_signal_ciphertext
       ), '')::text AS success_signal,
       d.revision, d.created_at, d.updated_at
FROM goal_drafts d
LEFT JOIN goal_draft_success_signals signal ON signal.goal_draft_id = d.id
WHERE goal_id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND draft_type = 'review'
FOR UPDATE OF d;

-- name: InsertCreationDraft :execrows
INSERT INTO goal_drafts (
    id, user_id, draft_type, body, revision, created_at, updated_at
) VALUES (
    sqlc.arg(draft_id)::uuid,
    sqlc.arg(user_id)::uuid,
    'creation',
    sqlc.arg(body)::text,
    sqlc.arg(revision)::bigint,
    sqlc.arg(created_at)::timestamptz,
    sqlc.arg(updated_at)::timestamptz
);

-- name: SaveDraftCAS :execrows
UPDATE goal_drafts
SET body = sqlc.arg(body)::text,
    revision = sqlc.arg(new_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND draft_type = sqlc.arg(draft_type)::text
  AND revision = sqlc.arg(expected_revision)::bigint;

-- name: UpsertGoalDraftSuccessSignal :execrows
INSERT INTO goal_draft_success_signals (goal_draft_id, success_signal)
VALUES (sqlc.arg(goal_draft_id)::uuid, sqlc.arg(success_signal)::text)
ON CONFLICT (goal_draft_id)
DO UPDATE SET success_signal = EXCLUDED.success_signal;

-- name: DeleteGoalDraftSuccessSignal :execrows
DELETE FROM goal_draft_success_signals
WHERE goal_draft_id = sqlc.arg(goal_draft_id)::uuid;

-- name: DeleteCreationDraftCAS :execrows
DELETE FROM goal_drafts
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND draft_type = 'creation'
  AND revision = sqlc.arg(expected_revision)::bigint;

-- name: InsertInitialGoal :execrows
INSERT INTO goals (
    id, user_id, status, current_version_number, next_cycle_sequence_number,
    revision, created_at, updated_at
) VALUES (
    sqlc.arg(goal_id)::uuid,
    sqlc.arg(user_id)::uuid,
    sqlc.arg(status)::text,
    sqlc.arg(current_version_number)::integer,
    sqlc.arg(next_cycle_sequence_number)::integer,
    sqlc.arg(revision)::bigint,
    sqlc.arg(created_at)::timestamptz,
    sqlc.arg(updated_at)::timestamptz
);

-- name: InsertGoalVersion :execrows
INSERT INTO goal_versions (
    id, user_id, goal_id, version_number, body, created_by_operation_id, created_at
) VALUES (
    sqlc.arg(version_id)::uuid,
    sqlc.arg(user_id)::uuid,
    sqlc.arg(goal_id)::uuid,
    sqlc.arg(version_number)::integer,
    sqlc.arg(body)::text,
    sqlc.arg(created_by_operation_id)::uuid,
    sqlc.arg(created_at)::timestamptz
);

-- name: InsertGoalVersionSuccessSignal :execrows
INSERT INTO goal_version_success_signals (goal_version_id, success_signal)
VALUES (sqlc.arg(goal_version_id)::uuid, sqlc.arg(success_signal)::text);

-- name: LockGoalWithCurrentVersion :one
SELECT g.status,
       g.revision,
       gv.id AS current_version_id,
       public.fukamu_cycle_content_read_text(
         gv.content_storage_format, gv.body, gv.body_dek_version,
         gv.body_crypto_revision, gv.body_nonce, gv.body_ciphertext
       ) AS body
FROM goals g
JOIN goal_versions gv
  ON gv.user_id = g.user_id
 AND gv.goal_id = g.id
 AND gv.version_number = g.current_version_number
WHERE g.id = sqlc.arg(goal_id)::uuid
  AND g.user_id = sqlc.arg(user_id)::uuid
FOR UPDATE OF g;

-- name: AdoptDraftCAS :execrows
UPDATE goal_drafts
SET body = sqlc.arg(body)::text,
    revision = sqlc.arg(new_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND revision = sqlc.arg(expected_revision)::bigint;
