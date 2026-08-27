-- name: OwnedGoalExistsForCycleRead :one
SELECT EXISTS (
    SELECT 1
    FROM goals
    WHERE id = sqlc.arg(goal_id)::uuid
      AND user_id = sqlc.arg(user_id)::uuid
) AS goal_exists;

-- name: ListCycleSummaries :many
SELECT
    c.id AS cycle_id,
    c.sequence_number,
    c.status,
    c.started_at,
    c.completed_at,
    c.canceled_at,
    gv.id AS goal_version_id,
    gv.version_number AS goal_version_number,
    gv.body AS goal_version_body,
    gv.created_at AS goal_version_created_at,
    CASE
        WHEN char_length(c.plan) > 120 THEN left(c.plan, 120) || '…'
        ELSE c.plan
    END::text AS plan_preview
FROM pdca_cycles AS c
LEFT JOIN goal_versions AS gv
  ON gv.id = c.goal_version_id
 AND gv.goal_id = c.goal_id
WHERE c.user_id = sqlc.arg(user_id)::uuid
  AND c.goal_id = sqlc.arg(goal_id)::uuid
  AND (
      sqlc.narg(after_sequence_number)::integer IS NULL
      OR (c.sequence_number, c.id) < (
          sqlc.narg(after_sequence_number)::integer,
          sqlc.narg(after_cycle_id)::uuid
      )
  )
ORDER BY c.sequence_number DESC, c.id DESC
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: GetCycleView :one
SELECT
    c.id AS cycle_id,
    c.goal_id,
    c.sequence_number,
    c.status,
    c.started_at,
    c.completed_at,
    c.canceled_at,
    c.cancellation_reason,
    c.plan,
    c.do_text,
    c.check_text,
    c.action,
    c.content_revision,
    c.plan_revision,
    c.do_revision,
    c.check_revision,
    c.action_revision,
    gv.id AS goal_version_id,
    gv.version_number AS goal_version_number,
    gv.body AS goal_version_body,
    gv.created_at AS goal_version_created_at
FROM pdca_cycles AS c
JOIN goals AS g
  ON g.id = c.goal_id
 AND g.user_id = c.user_id
LEFT JOIN goal_versions AS gv
  ON gv.id = c.goal_version_id
 AND gv.goal_id = c.goal_id
WHERE c.id = sqlc.arg(cycle_id)::uuid
  AND c.goal_id = sqlc.arg(goal_id)::uuid
  AND c.user_id = sqlc.arg(user_id)::uuid;
