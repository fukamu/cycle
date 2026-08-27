-- name: LockAccountRunningGenerationExposures :many
SELECT id,
       budget_month_utc,
       budget_reserved_cost_usd::text AS budget_reserved_cost_usd
FROM ai_generations
WHERE user_id = sqlc.arg(user_id)::uuid
  AND status = 'running'
ORDER BY id
FOR UPDATE;

-- name: LockAccountUnfinalizedUsageExposures :many
SELECT operation_id,
       settlement_budget_month_utc,
       settlement_reservation_cost_usd::text AS settlement_reservation_cost_usd
FROM ai_usage_events
WHERE user_id = sqlc.arg(user_id)::uuid
  AND provider_usage_finalized_at IS NULL
ORDER BY operation_id
FOR UPDATE;

-- name: ListAccountMonthlyExposures :many
WITH exposures AS (
    SELECT budget_month_utc AS month_utc,
           budget_reserved_cost_usd AS reserved_to_release,
           budget_reserved_cost_usd AS unattributed_to_add
    FROM ai_generations
    WHERE user_id = sqlc.arg(user_id)::uuid
      AND status = 'running'

    UNION ALL

    SELECT usage.settlement_budget_month_utc AS month_utc,
           0::numeric AS reserved_to_release,
           usage.settlement_reservation_cost_usd AS unattributed_to_add
    FROM ai_usage_events AS usage
    WHERE usage.user_id = sqlc.arg(user_id)::uuid
      AND usage.provider_usage_finalized_at IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM ai_generations AS generation
          WHERE generation.id = usage.operation_id
            AND generation.user_id = usage.user_id
            AND generation.status = 'running'
      )
)
SELECT month_utc,
       SUM(reserved_to_release)::text AS reserved_to_release,
       SUM(unattributed_to_add)::text AS unattributed_to_add
FROM exposures
GROUP BY month_utc
ORDER BY month_utc;

-- name: ReleaseAccountGenerationReservationCAS :execrows
UPDATE ai_generations
SET budget_reserved_cost_usd = 0
WHERE user_id = sqlc.arg(user_id)::uuid
  AND id = sqlc.arg(generation_id)::uuid
  AND status = 'running'
  AND budget_month_utc = sqlc.arg(expected_budget_month_utc)::date
  AND budget_reserved_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric;

-- name: MoveAccountExposureToUnattributedCAS :execrows
UPDATE ai_budget_monthly
SET reserved_cost_usd = reserved_cost_usd - sqlc.arg(reserved_to_release)::text::numeric,
    unattributed_cost_usd = unattributed_cost_usd + sqlc.arg(unattributed_to_add)::text::numeric,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE month_utc = sqlc.arg(month_utc)::date
  AND reserved_cost_usd >= sqlc.arg(reserved_to_release)::text::numeric;

-- name: DeleteReleasedAccountUsageExposureCAS :execrows
DELETE FROM ai_usage_events AS usage
WHERE usage.user_id = sqlc.arg(user_id)::uuid
  AND usage.operation_id = sqlc.arg(operation_id)::uuid
  AND usage.provider_usage_finalized_at IS NULL
  AND usage.settlement_budget_month_utc = sqlc.arg(expected_budget_month_utc)::date
  AND usage.settlement_reservation_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric
  AND NOT EXISTS (
      SELECT 1
      FROM ai_generations AS generation
      WHERE generation.id = usage.operation_id
        AND generation.user_id = usage.user_id
        AND generation.status = 'running'
  );

-- name: DeleteAccountUserCAS :execrows
DELETE FROM users
WHERE id = sqlc.arg(user_id)::uuid;
