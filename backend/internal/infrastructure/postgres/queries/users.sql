-- name: LockUser :one
SELECT id
FROM users
WHERE id = sqlc.arg(user_id)::uuid
FOR UPDATE;
