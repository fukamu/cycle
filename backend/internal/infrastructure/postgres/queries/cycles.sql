-- name: GetGoalCycle :one
SELECT c.*
FROM pdca_cycles c
JOIN goals g ON g.id = c.goal_id AND g.user_id = c.user_id
WHERE c.id = $1 AND c.goal_id = $2 AND c.user_id = $3;

-- name: GetActiveGoalCycle :one
SELECT c.*
FROM pdca_cycles c
JOIN goals g ON g.id = c.goal_id AND g.user_id = c.user_id
WHERE c.goal_id = $1 AND c.user_id = $2
  AND c.status = 'active' AND g.status = 'active_cycle';

-- name: ListGoalCycles :many
SELECT c.*
FROM pdca_cycles c
JOIN goals g ON g.id = c.goal_id AND g.user_id = c.user_id
WHERE c.goal_id = $1 AND c.user_id = $2
  AND (
      sqlc.narg(after_sequence_number)::integer IS NULL
      OR (c.sequence_number, c.id) < (sqlc.narg(after_sequence_number)::integer, sqlc.narg(after_cycle_id)::uuid)
  )
ORDER BY c.sequence_number DESC, c.id DESC
LIMIT $3;
