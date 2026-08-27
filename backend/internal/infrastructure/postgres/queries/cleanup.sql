-- name: CountCleanupAIUsageEvents :one
SELECT count(*)
FROM public.ai_usage_events
WHERE content_deleted = TRUE
  AND quota_retain_until <= sqlc.arg(captured_now)::timestamptz
  AND provider_usage_finalized_at IS NOT NULL;

-- name: CountCleanupAbuseRateBuckets :one
SELECT count(*)
FROM public.abuse_rate_buckets
WHERE expires_at <= sqlc.arg(captured_now)::timestamptz;

-- name: DeleteCleanupAIUsageEventsBatch :execrows
WITH candidates AS (
    SELECT operation_id
    FROM public.ai_usage_events
    WHERE content_deleted = TRUE
      AND quota_retain_until <= sqlc.arg(captured_now)::timestamptz
      AND provider_usage_finalized_at IS NOT NULL
    ORDER BY quota_retain_until, operation_id
    LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE SKIP LOCKED
)
DELETE FROM public.ai_usage_events AS target
USING candidates
WHERE target.operation_id = candidates.operation_id
  AND target.content_deleted = TRUE
  AND target.quota_retain_until <= sqlc.arg(captured_now)::timestamptz
  AND target.provider_usage_finalized_at IS NOT NULL;

-- name: DeleteCleanupAbuseRateBucketsBatch :execrows
WITH candidates AS (
    SELECT scope, key_hash, window_start
    FROM public.abuse_rate_buckets
    WHERE expires_at <= sqlc.arg(captured_now)::timestamptz
    ORDER BY expires_at, scope, key_hash, window_start
    LIMIT sqlc.arg(batch_size)::integer
    FOR UPDATE SKIP LOCKED
)
DELETE FROM public.abuse_rate_buckets AS target
USING candidates
WHERE target.scope = candidates.scope
  AND target.key_hash = candidates.key_hash
  AND target.window_start = candidates.window_start
  AND target.expires_at <= sqlc.arg(captured_now)::timestamptz;
