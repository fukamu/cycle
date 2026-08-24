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
    expires_at = EXCLUDED.expires_at
RETURNING request_count;

-- name: CountAnonymousIPRollingUsage :one
SELECT COALESCE(sum(request_count), 0) AS rolling_count
FROM abuse_rate_buckets
WHERE scope = 'anonymous_ip_hour'
  AND key_hash = sqlc.arg(key_hash)::bytea
  AND window_start > sqlc.arg(accepted_after)::timestamptz;
