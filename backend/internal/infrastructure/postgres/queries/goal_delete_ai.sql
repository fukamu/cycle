-- name: LockRunningGoalGenerations :many
SELECT id,
       budget_reserved_cost_usd::text AS budget_reserved_cost_usd
FROM ai_generations
WHERE user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'running'
ORDER BY id
FOR UPDATE;

-- name: SumLockedGoalReservationsByMonth :many
SELECT budget_month_utc,
       SUM(budget_reserved_cost_usd)::text AS amount_usd
FROM ai_generations
WHERE user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND id = ANY(sqlc.arg(generation_ids)::text[]::uuid[])
  AND status = 'running'
GROUP BY budget_month_utc
HAVING SUM(budget_reserved_cost_usd) > 0
ORDER BY budget_month_utc;

-- name: TerminalizeGoalGenerationCAS :execrows
UPDATE ai_generations
SET status = 'failed',
    failure_code = 'goal_deleted',
    budget_reserved_cost_usd = 0,
    lease_expires_at = NULL,
    finished_at = sqlc.arg(finished_at)::timestamptz
WHERE id = sqlc.arg(generation_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'running'
  AND budget_reserved_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric;

-- name: FailRunningGoalUsageCAS :execrows
UPDATE ai_usage_events
SET goal_id = NULL,
    status = 'failed',
    content_deleted = TRUE
WHERE operation_id = sqlc.arg(operation_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND status = 'accepted'
  AND provider_usage_finalized_at IS NULL;

-- name: LockGoalUsages :many
SELECT operation_id,
       status,
       quota_retain_until,
       provider_usage_finalized_at
FROM ai_usage_events
WHERE user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
ORDER BY operation_id
FOR UPDATE;

-- name: RedactGoalUsagesCAS :execrows
UPDATE ai_usage_events
SET goal_id = NULL,
    status = CASE
        WHEN status = 'accepted' THEN 'failed'
        ELSE status
    END,
    content_deleted = TRUE
WHERE user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND operation_id = ANY(sqlc.arg(operation_ids)::text[]::uuid[]);

-- name: DeleteExpiredFinalizedGoalUsagesCAS :execrows
DELETE FROM ai_usage_events
WHERE user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND operation_id = ANY(sqlc.arg(operation_ids)::text[]::uuid[])
  AND quota_retain_until <= sqlc.arg(now)::timestamptz
  AND provider_usage_finalized_at IS NOT NULL;
