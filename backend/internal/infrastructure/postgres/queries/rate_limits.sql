-- name: IncrementRateBucket :one
INSERT INTO abuse_rate_buckets (
    scope,
    key_hash,
    window_start,
    request_count,
    expires_at
) VALUES (
    sqlc.arg(scope)::text,
    sqlc.arg(key_hash)::bytea,
    sqlc.arg(window_start)::timestamptz,
    1,
    sqlc.arg(expires_at)::timestamptz
)
ON CONFLICT (scope, key_hash, window_start) DO UPDATE
SET request_count = abuse_rate_buckets.request_count + 1,
    expires_at = EXCLUDED.expires_at
RETURNING request_count;

-- name: IncrementAnonymousIPHourBucket :one
INSERT INTO abuse_rate_buckets (
    scope,
    key_hash,
    window_start,
    request_count,
    expires_at
) VALUES (
    'anonymous_ip_hour',
    sqlc.arg(key_hash)::bytea,
    sqlc.arg(window_start)::timestamptz,
    1,
    sqlc.arg(expires_at)::timestamptz
)
ON CONFLICT (scope, key_hash, window_start) DO UPDATE
SET request_count = abuse_rate_buckets.request_count + 1,
    expires_at = GREATEST(abuse_rate_buckets.expires_at, EXCLUDED.expires_at)
RETURNING request_count;

-- name: AcquireAnonymousIPRateLimitGuard :exec
INSERT INTO public.anonymous_rate_limit_guards AS guard (
    scope,
    key_hash,
    expires_at
) VALUES (
    'anonymous_ip',
    sqlc.arg(key_hash)::bytea,
    '-infinity'::timestamptz
)
ON CONFLICT (scope, key_hash) DO UPDATE
SET expires_at = guard.expires_at;

-- name: AdvanceAnonymousIPRateLimitGuard :one
UPDATE public.anonymous_rate_limit_guards
SET expires_at = GREATEST(
    expires_at,
    clock_timestamp() + INTERVAL '25 hours'
)
WHERE scope = 'anonymous_ip'
  AND key_hash = sqlc.arg(key_hash)::bytea
RETURNING (expires_at - INTERVAL '25 hours')::timestamptz AS canonical_time;

-- name: CountAnonymousIPRollingUsage :one
SELECT COALESCE(sum(request_count), 0)::bigint AS rolling_count
FROM abuse_rate_buckets
WHERE scope = 'anonymous_ip_hour'
  AND key_hash = sqlc.arg(key_hash)::bytea
  AND window_start BETWEEN sqlc.arg(included_from)::timestamptz
                       AND sqlc.arg(included_through)::timestamptz;
