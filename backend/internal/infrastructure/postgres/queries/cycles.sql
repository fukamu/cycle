-- name: GetActiveCycle :one
SELECT *
FROM pdca_cycles
WHERE user_id = $1 AND status = 'active';

-- name: GetOwnedCycle :one
SELECT *
FROM pdca_cycles
WHERE id = $1 AND user_id = $2;

-- name: GetCompletedCycle :one
SELECT *
FROM pdca_cycles
WHERE id = $1 AND user_id = $2 AND status = 'completed';

-- name: ListCompletedCycles :many
SELECT *
FROM pdca_cycles
WHERE user_id = $1
  AND status = 'completed'
  AND (
      sqlc.narg(after_sequence_number)::integer IS NULL
      OR (sequence_number, id) < (sqlc.narg(after_sequence_number)::integer, sqlc.narg(after_cycle_id)::uuid)
  )
ORDER BY sequence_number DESC, id DESC
LIMIT $2;
