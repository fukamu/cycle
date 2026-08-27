-- name: LockDraftGenerations :many
SELECT id, status
FROM ai_generations
WHERE user_id = sqlc.arg(user_id)::uuid
  AND source_goal_draft_id = sqlc.arg(draft_id)::uuid
ORDER BY id
FOR UPDATE;

-- name: DeleteDraftGenerationsCAS :execrows
DELETE FROM ai_generations
WHERE user_id = sqlc.arg(user_id)::uuid
  AND source_goal_draft_id = sqlc.arg(draft_id)::uuid
  AND id = ANY(sqlc.arg(generation_ids)::text[]::uuid[])
  AND status <> 'running';

-- name: AttachDraftGenerations :execrows
UPDATE ai_generations
SET source_goal_draft_id = NULL,
    goal_id = sqlc.arg(goal_id)::uuid,
    goal_version_id = sqlc.arg(goal_version_id)::uuid
WHERE user_id = sqlc.arg(user_id)::uuid
  AND source_goal_draft_id = sqlc.arg(draft_id)::uuid
  AND id = ANY(sqlc.arg(generation_ids)::text[]::uuid[]);

-- name: LockExpiredGenerations :many
SELECT id,
       budget_month_utc,
       budget_reserved_cost_usd::text AS budget_reserved_cost_usd
FROM ai_generations
WHERE user_id = sqlc.arg(user_id)::uuid
  AND status = 'running'
  AND lease_expires_at <= sqlc.arg(now)::timestamptz
ORDER BY id
FOR UPDATE;

-- name: SumLockedReservationsByMonth :many
SELECT budget_month_utc,
       SUM(budget_reserved_cost_usd)::text AS amount_usd
FROM ai_generations
WHERE id = ANY(sqlc.arg(generation_ids)::text[]::uuid[])
  AND status = 'running'
GROUP BY budget_month_utc
HAVING SUM(budget_reserved_cost_usd) > 0
ORDER BY budget_month_utc;

-- name: ExpireGenerationCAS :execrows
UPDATE ai_generations
SET status = 'failed',
    failure_code = 'lease_expired',
    budget_reserved_cost_usd = 0,
    lease_expires_at = NULL,
    finished_at = sqlc.arg(finished_at)::timestamptz
WHERE id = sqlc.arg(generation_id)::uuid
  AND status = 'running'
  AND budget_reserved_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric;

-- name: HasRunningDraftGeneration :one
SELECT EXISTS(
    SELECT 1
    FROM ai_generations
    WHERE source_goal_draft_id = sqlc.arg(draft_id)::uuid
      AND status = 'running'
) AS running;

-- name: HasRunningCycleGeneration :one
SELECT EXISTS(
    SELECT 1
    FROM ai_generations
    WHERE user_id = sqlc.arg(user_id)::uuid
      AND goal_id = sqlc.arg(goal_id)::uuid
      AND cycle_id = sqlc.arg(cycle_id)::uuid
      AND status = 'running'
) AS running;

-- name: FindGenerationLocator :one
SELECT user_id,
       operation_type,
       status,
       source_goal_draft_id,
       goal_id,
       cycle_id
FROM ai_generations
WHERE id = sqlc.arg(generation_id)::uuid;

-- name: LockGoalRefineGeneration :one
SELECT budget_month_utc,
       budget_reserved_cost_usd::text AS budget_reserved_cost_usd,
       target_revision
FROM ai_generations
WHERE id = sqlc.arg(generation_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND operation_type = 'goal_refine'
  AND source_goal_draft_id = sqlc.arg(draft_id)::uuid
  AND status = 'running'
FOR UPDATE;

-- name: TerminalizeGenerationCAS :execrows
UPDATE ai_generations
SET status = sqlc.arg(status)::text,
    output = sqlc.narg(output)::text,
    input_tokens = sqlc.arg(input_tokens)::bigint,
    output_tokens = sqlc.arg(output_tokens)::bigint,
    estimated_cost_usd = sqlc.arg(estimated_cost_usd)::text::numeric,
    budget_reserved_cost_usd = 0,
    attempt_count = sqlc.arg(attempt_count)::smallint,
    failure_code = NULLIF(sqlc.arg(failure_code)::text, ''),
    provider_request_id = NULLIF(sqlc.arg(provider_request_id)::text, ''),
    lease_expires_at = NULL,
    context_changed = sqlc.arg(context_changed)::boolean,
    finished_at = sqlc.arg(finished_at)::timestamptz
WHERE id = sqlc.arg(generation_id)::uuid
  AND operation_type = 'goal_refine'
  AND status = 'running'
  AND budget_reserved_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric;

-- name: LockActionAIGeneration :one
SELECT goal_version_id,
       budget_month_utc,
       budget_reserved_cost_usd::text AS budget_reserved_cost_usd,
       target_revision
FROM ai_generations
WHERE id = sqlc.arg(generation_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND goal_id = sqlc.arg(goal_id)::uuid
  AND cycle_id = sqlc.arg(cycle_id)::uuid
  AND operation_type = sqlc.arg(operation_type)::text
  AND status = 'running'
FOR UPDATE;

-- name: TerminalizeActionAIGenerationCAS :execrows
UPDATE ai_generations
SET status = sqlc.arg(status)::text,
    output = sqlc.narg(output)::text,
    input_tokens = sqlc.arg(input_tokens)::bigint,
    output_tokens = sqlc.arg(output_tokens)::bigint,
    estimated_cost_usd = sqlc.arg(estimated_cost_usd)::text::numeric,
    budget_reserved_cost_usd = 0,
    attempt_count = sqlc.arg(attempt_count)::smallint,
    failure_code = NULLIF(sqlc.arg(failure_code)::text, ''),
    provider_request_id = NULLIF(sqlc.arg(provider_request_id)::text, ''),
    lease_expires_at = NULL,
    context_changed = sqlc.arg(context_changed)::boolean,
    applied_at = sqlc.narg(applied_at)::timestamptz,
    finished_at = sqlc.arg(finished_at)::timestamptz
WHERE id = sqlc.arg(generation_id)::uuid
  AND operation_type = sqlc.arg(operation_type)::text
  AND status = 'running'
  AND budget_reserved_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric;

-- name: LockSucceededGoalRefineGeneration :one
SELECT target_revision,
       source_text,
       output,
       adopted_at,
       adopted_draft_revision
FROM ai_generations
WHERE id = sqlc.arg(generation_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND operation_type = 'goal_refine'
  AND source_goal_draft_id = sqlc.arg(draft_id)::uuid
  AND status = 'succeeded'
FOR UPDATE;

-- name: MarkSuggestionAdoptedCAS :execrows
UPDATE ai_generations
SET adopted_at = sqlc.arg(adopted_at)::timestamptz,
    adopted_draft_revision = sqlc.arg(adopted_draft_revision)::bigint
WHERE id = sqlc.arg(generation_id)::uuid
  AND operation_type = 'goal_refine'
  AND status = 'succeeded'
  AND adopted_at IS NULL;

-- name: FindGoalRefineReplay :one
SELECT id AS generation_id,
       idempotency_request_hash,
       status,
       target_revision,
       output,
       COALESCE(failure_code, '')::text AS failure_code,
       context_changed
FROM ai_generations
WHERE user_id = sqlc.arg(user_id)::uuid
  AND operation_type = 'goal_refine'
  AND idempotency_key = sqlc.arg(idempotency_key)::uuid;

-- name: InsertGoalRefineGeneration :execrows
INSERT INTO ai_generations (
    id,
    user_id,
    operation_type,
    status,
    source_goal_draft_id,
    goal_id,
    goal_version_id,
    target_revision,
    idempotency_key,
    idempotency_request_hash,
    canonical_provider_input_hash,
    source_text,
    provider,
    model,
    prompt_version,
    budget_month_utc,
    budget_reserved_cost_usd,
    lease_expires_at,
    started_at,
    context_cycle_ids
) VALUES (
    sqlc.arg(generation_id)::uuid,
    sqlc.arg(user_id)::uuid,
    'goal_refine',
    'running',
    sqlc.arg(draft_id)::uuid,
    sqlc.narg(goal_id)::uuid,
    sqlc.narg(goal_version_id)::uuid,
    sqlc.arg(target_revision)::bigint,
    sqlc.arg(idempotency_key)::uuid,
    sqlc.arg(idempotency_request_hash)::text,
    sqlc.arg(canonical_provider_input_hash)::text,
    sqlc.arg(source_text)::text,
    sqlc.arg(provider)::text,
    sqlc.arg(model)::text,
    sqlc.arg(prompt_version)::text,
    sqlc.arg(budget_month_utc)::date,
    sqlc.arg(reserved_cost_usd)::text::numeric,
    sqlc.arg(lease_expires_at)::timestamptz,
    sqlc.arg(started_at)::timestamptz,
    sqlc.arg(context_cycle_ids)::text[]::uuid[]
);

-- name: FindActionAIReplay :one
SELECT id AS generation_id,
       goal_id,
       cycle_id,
       idempotency_request_hash,
       status,
       target_revision,
       output,
       COALESCE(failure_code, '')::text AS failure_code,
       context_changed,
       lease_expires_at
FROM ai_generations
WHERE user_id = sqlc.arg(user_id)::uuid
  AND operation_type = sqlc.arg(operation_type)::text
  AND idempotency_key = sqlc.arg(idempotency_key)::uuid;

-- name: InsertActionAIGeneration :execrows
INSERT INTO ai_generations (
    id,
    user_id,
    operation_type,
    status,
    goal_id,
    goal_version_id,
    cycle_id,
    target_revision,
    idempotency_key,
    idempotency_request_hash,
    canonical_provider_input_hash,
    source_text,
    provider,
    model,
    prompt_version,
    budget_month_utc,
    budget_reserved_cost_usd,
    lease_expires_at,
    started_at,
    context_cycle_ids
) VALUES (
    sqlc.arg(generation_id)::uuid,
    sqlc.arg(user_id)::uuid,
    sqlc.arg(operation_type)::text,
    'running',
    sqlc.arg(goal_id)::uuid,
    sqlc.arg(goal_version_id)::uuid,
    sqlc.arg(cycle_id)::uuid,
    sqlc.arg(target_revision)::bigint,
    sqlc.arg(idempotency_key)::uuid,
    sqlc.arg(idempotency_request_hash)::text,
    sqlc.arg(canonical_provider_input_hash)::text,
    sqlc.narg(source_text)::text,
    sqlc.arg(provider)::text,
    sqlc.arg(model)::text,
    sqlc.arg(prompt_version)::text,
    sqlc.arg(budget_month_utc)::date,
    sqlc.arg(reserved_cost_usd)::text::numeric,
    sqlc.arg(lease_expires_at)::timestamptz,
    sqlc.arg(started_at)::timestamptz,
    sqlc.arg(context_cycle_ids)::text[]::uuid[]
);
