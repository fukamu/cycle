-- name: FindGoalDeleteReceipt :one
SELECT deleted_goal_id, request_hash, expires_at
FROM goal_delete_receipts
WHERE user_id = sqlc.arg(user_id)::uuid
  AND idempotency_key = sqlc.arg(idempotency_key)::uuid;

-- name: LockGoalForDelete :one
SELECT revision
FROM goals
WHERE id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
FOR UPDATE;

-- name: LockGoalDraftIDs :many
SELECT id
FROM goal_drafts
WHERE goal_id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
ORDER BY id
FOR UPDATE;

-- name: DeleteGoalCAS :execrows
DELETE FROM goals
WHERE id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND revision = sqlc.arg(expected_revision)::bigint;

-- name: InsertGoalDeleteReceipt :execrows
INSERT INTO goal_delete_receipts (
    user_id,
    idempotency_key,
    deleted_goal_id,
    request_hash,
    deleted_at,
    expires_at
) VALUES (
    sqlc.arg(user_id)::uuid,
    sqlc.arg(idempotency_key)::uuid,
    sqlc.arg(deleted_goal_id)::uuid,
    sqlc.arg(request_hash)::text,
    sqlc.arg(deleted_at)::timestamptz,
    sqlc.arg(expires_at)::timestamptz
);

-- name: LockAccountGoalIDs :many
SELECT id
FROM goals
WHERE user_id = sqlc.arg(user_id)::uuid
ORDER BY id
FOR UPDATE;

-- name: LockAccountGoalDraftIDs :many
SELECT id
FROM goal_drafts
WHERE user_id = sqlc.arg(user_id)::uuid
ORDER BY id
FOR UPDATE;
