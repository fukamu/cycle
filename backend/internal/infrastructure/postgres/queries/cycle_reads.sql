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
    c.cancellation_reason,
    gv.id AS goal_version_id,
    gv.version_number AS goal_version_number,
    gv.body AS goal_version_body,
    gv_signal.success_signal AS goal_version_success_signal,
    gv.created_at AS goal_version_created_at,
    CASE
        WHEN char_length(c.plan) > 120 THEN left(c.plan, 119) || '…'
        ELSE c.plan
    END::text AS plan_preview,
    CASE
        WHEN c.status IN ('completed', 'canceled') THEN left(c.check_text, 120)
        ELSE ''
    END::text AS check_preview,
    CASE
        WHEN c.status IN ('completed', 'canceled') THEN char_length(c.check_text) > 120
        ELSE false
    END::boolean AS check_preview_truncated,
    CASE
        WHEN c.status IN ('completed', 'canceled') THEN left(c.action, 120)
        ELSE ''
    END::text AS action_preview,
    CASE
        WHEN c.status IN ('completed', 'canceled') THEN char_length(c.action) > 120
        ELSE false
    END::boolean AS action_preview_truncated
FROM pdca_cycles AS c
LEFT JOIN goal_versions AS gv
  ON gv.id = c.goal_version_id
 AND gv.goal_id = c.goal_id
LEFT JOIN goal_version_success_signals AS gv_signal
  ON gv_signal.goal_version_id = gv.id
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
    review_schedule.review_date,
    COALESCE(review_schedule.review_schedule_revision, 0)::bigint AS review_schedule_revision,
    gv.id AS goal_version_id,
    gv.version_number AS goal_version_number,
    gv.body AS goal_version_body,
    gv_signal.success_signal AS goal_version_success_signal,
    gv.created_at AS goal_version_created_at,
    previous_cycle.id AS previous_cycle_id,
    previous_cycle.sequence_number AS previous_cycle_sequence_number,
    previous_cycle.status AS previous_cycle_status,
    previous_cycle.cancellation_reason AS previous_cycle_cancellation_reason,
    previous_cycle.action AS previous_cycle_action,
    previous_goal_version.version_number AS previous_goal_version_number
FROM pdca_cycles AS c
JOIN goals AS g
  ON g.id = c.goal_id
 AND g.user_id = c.user_id
LEFT JOIN goal_versions AS gv
  ON gv.id = c.goal_version_id
 AND gv.goal_id = c.goal_id
LEFT JOIN goal_version_success_signals AS gv_signal
  ON gv_signal.goal_version_id = gv.id
LEFT JOIN pdca_cycle_review_schedules AS review_schedule
  ON review_schedule.cycle_id = c.id
LEFT JOIN pdca_cycles AS previous_cycle
  ON previous_cycle.user_id = c.user_id
 AND previous_cycle.goal_id = c.goal_id
 AND previous_cycle.sequence_number = c.sequence_number - 1
LEFT JOIN goal_versions AS previous_goal_version
  ON previous_goal_version.id = previous_cycle.goal_version_id
 AND previous_goal_version.user_id = previous_cycle.user_id
 AND previous_goal_version.goal_id = previous_cycle.goal_id
WHERE c.id = sqlc.arg(cycle_id)::uuid
  AND c.goal_id = sqlc.arg(goal_id)::uuid
  AND c.user_id = sqlc.arg(user_id)::uuid;
