-- name: LockDraftUsages :many
SELECT operation_id,
       quota_retain_until,
       provider_usage_finalized_at
FROM ai_usage_events
WHERE user_id = sqlc.arg(user_id)::uuid
  AND operation_id = ANY(sqlc.arg(operation_ids)::text[]::uuid[])
ORDER BY operation_id
FOR UPDATE;

-- name: RedactDraftUsagesCAS :execrows
UPDATE ai_usage_events
SET goal_id = NULL,
    content_deleted = TRUE
WHERE user_id = sqlc.arg(user_id)::uuid
  AND operation_id = ANY(sqlc.arg(operation_ids)::text[]::uuid[]);

-- name: DeleteExpiredFinalizedDraftUsagesCAS :execrows
DELETE FROM ai_usage_events
WHERE user_id = sqlc.arg(user_id)::uuid
  AND operation_id = ANY(sqlc.arg(operation_ids)::text[]::uuid[])
  AND quota_retain_until <= sqlc.arg(now)::timestamptz
  AND provider_usage_finalized_at IS NOT NULL;

-- name: AttachUsageToGoal :execrows
UPDATE ai_usage_events
SET goal_id = sqlc.arg(goal_id)::uuid
WHERE user_id = sqlc.arg(user_id)::uuid
  AND operation_id = ANY(sqlc.arg(operation_ids)::text[]::uuid[]);

-- name: ExpireUsageCAS :execrows
UPDATE ai_usage_events
SET status = 'failed'
WHERE operation_id = sqlc.arg(operation_id)::uuid
  AND status = 'accepted'
  AND provider_usage_finalized_at IS NULL
  AND settlement_budget_month_utc = sqlc.arg(expected_budget_month_utc)::date
  AND settlement_reservation_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric;

-- name: CountRollingUsage :one
SELECT count(*) AS usage_count
FROM ai_usage_events
WHERE user_id = sqlc.arg(user_id)::uuid
  AND accepted_at > sqlc.arg(accepted_after)::timestamptz;

-- name: InsertAcceptedUsage :execrows
INSERT INTO ai_usage_events (
    operation_id,
    user_id,
    goal_id,
    operation_type,
    status,
    provider,
    model,
    prompt_version,
    accepted_at,
    quota_retain_until,
    settlement_budget_month_utc,
    settlement_reservation_cost_usd
) VALUES (
    sqlc.arg(operation_id)::uuid,
    sqlc.arg(user_id)::uuid,
    sqlc.narg(goal_id)::uuid,
    sqlc.arg(operation_type)::text,
    'accepted',
    sqlc.arg(provider)::text,
    sqlc.arg(model)::text,
    sqlc.arg(prompt_version)::text,
    sqlc.arg(accepted_at)::timestamptz,
    sqlc.arg(quota_retain_until)::timestamptz,
    sqlc.arg(settlement_budget_month_utc)::date,
    sqlc.arg(settlement_reservation_cost_usd)::text::numeric
);

-- name: FinalizeUsageCAS :execrows
UPDATE ai_usage_events
SET status = sqlc.arg(status)::text,
    input_tokens = sqlc.arg(input_tokens)::bigint,
    output_tokens = sqlc.arg(output_tokens)::bigint,
    estimated_cost_usd = sqlc.arg(estimated_cost_usd)::text::numeric,
    provider_usage_finalized_at = sqlc.arg(finalized_at)::timestamptz,
    settlement_budget_month_utc = NULL,
    settlement_reservation_cost_usd = NULL
WHERE operation_id = sqlc.arg(operation_id)::uuid
  AND status = 'accepted'
  AND provider_usage_finalized_at IS NULL
  AND settlement_budget_month_utc = sqlc.arg(expected_budget_month_utc)::date
  AND settlement_reservation_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric;

-- name: FindUsageLocator :one
SELECT user_id,
       accepted_at,
       provider_usage_finalized_at
FROM ai_usage_events
WHERE operation_id = sqlc.arg(operation_id)::uuid;

-- name: LockUsage :one
SELECT accepted_at,
       provider_usage_finalized_at,
       settlement_budget_month_utc,
       (settlement_reservation_cost_usd IS NOT NULL)::boolean AS settlement_reservation_present,
       COALESCE(settlement_reservation_cost_usd::text, '')::text AS settlement_reservation_cost_usd
FROM ai_usage_events
WHERE operation_id = sqlc.arg(operation_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
FOR UPDATE;

-- name: FinalizeLateUsageCAS :execrows
UPDATE ai_usage_events
SET status = sqlc.arg(status)::text,
    input_tokens = sqlc.arg(input_tokens)::bigint,
    output_tokens = sqlc.arg(output_tokens)::bigint,
    estimated_cost_usd = sqlc.arg(estimated_cost_usd)::text::numeric,
    provider_usage_finalized_at = sqlc.arg(finalized_at)::timestamptz,
    settlement_budget_month_utc = NULL,
    settlement_reservation_cost_usd = NULL
WHERE operation_id = sqlc.arg(operation_id)::uuid
  AND provider_usage_finalized_at IS NULL
  AND settlement_budget_month_utc = sqlc.arg(expected_budget_month_utc)::date
  AND settlement_reservation_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric;
