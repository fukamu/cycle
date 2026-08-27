-- name: ReleaseBudgetReservationCAS :execrows
UPDATE ai_budget_monthly
SET reserved_cost_usd = reserved_cost_usd - sqlc.arg(amount_usd)::text::numeric,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE month_utc = sqlc.arg(month_utc)::date
  AND reserved_cost_usd >= sqlc.arg(amount_usd)::text::numeric;

-- name: EnsureBudgetMonth :exec
INSERT INTO ai_budget_monthly (
    month_utc,
    reserved_cost_usd,
    actual_cost_usd,
    unattributed_cost_usd,
    updated_at
) VALUES (
    sqlc.arg(month_utc)::date,
    0,
    0,
    0,
    sqlc.arg(updated_at)::timestamptz
)
ON CONFLICT (month_utc) DO NOTHING;

-- name: LockBudgetMonth :one
SELECT reserved_cost_usd::text AS reserved_cost_usd,
       actual_cost_usd::text AS actual_cost_usd,
       unattributed_cost_usd::text AS unattributed_cost_usd
FROM ai_budget_monthly
WHERE month_utc = sqlc.arg(month_utc)::date
FOR UPDATE;

-- name: ReserveBudgetCAS :execrows
UPDATE ai_budget_monthly
SET reserved_cost_usd = reserved_cost_usd + sqlc.arg(amount_usd)::text::numeric,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE month_utc = sqlc.arg(month_utc)::date;

-- name: SettleBudgetCAS :execrows
UPDATE ai_budget_monthly
SET reserved_cost_usd = reserved_cost_usd - sqlc.arg(reservation_usd)::text::numeric,
    actual_cost_usd = actual_cost_usd + sqlc.arg(actual_usd)::text::numeric,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE month_utc = sqlc.arg(month_utc)::date
  AND reserved_cost_usd >= sqlc.arg(reservation_usd)::text::numeric;

-- name: AddLateActualCostCAS :execrows
UPDATE ai_budget_monthly
SET actual_cost_usd = actual_cost_usd + sqlc.arg(actual_usd)::text::numeric,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE month_utc = sqlc.arg(month_utc)::date;
