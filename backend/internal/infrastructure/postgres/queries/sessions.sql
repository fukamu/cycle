-- name: GetSessionByTokenHash :one
SELECT
    s.id,
    s.user_id,
    s.csrf_token_hash,
    s.last_seen_at,
    s.idle_expires_at,
    s.absolute_expires_at,
    EXISTS (
        SELECT 1
        FROM auth_identities ai
        WHERE ai.user_id = s.user_id AND ai.provider = 'google'
    ) AS google_connected,
    (
        SELECT ai.email_at_link
        FROM auth_identities ai
        WHERE ai.user_id = s.user_id
          AND ai.provider = 'google'
          AND ai.email_verified_at_link IS TRUE
    ) AS google_email
FROM sessions s
WHERE s.token_hash = $1
  AND s.revoked_at IS NULL
  AND s.idle_expires_at > $2
  AND s.absolute_expires_at > $2;

-- name: RotateSessionCSRF :execrows
UPDATE sessions
SET csrf_token_hash = $2
WHERE id = $1
  AND revoked_at IS NULL
  AND idle_expires_at > $3
  AND absolute_expires_at > $3;

-- name: TouchSession :exec
UPDATE sessions
SET last_seen_at = $2,
    idle_expires_at = LEAST($3, absolute_expires_at)
WHERE id = $1
  AND revoked_at IS NULL;


-- name: LocateAnonymousBootstrap :one
SELECT user_id, expires_at
FROM anonymous_bootstraps
WHERE key_hash = sqlc.arg(key_hash);

-- name: LockAnonymousBootstrapByUser :one
SELECT user_id, expires_at
FROM anonymous_bootstraps
WHERE key_hash = sqlc.arg(key_hash)
  AND user_id = sqlc.arg(user_id)::uuid
FOR UPDATE;

-- name: DeleteAnonymousBootstrapByKeyHash :exec
DELETE FROM anonymous_bootstraps
WHERE key_hash = sqlc.arg(key_hash);

-- name: DeleteAnonymousBootstrapsByUser :exec
DELETE FROM anonymous_bootstraps
WHERE user_id = sqlc.arg(user_id)::uuid;

-- name: InsertAnonymousUser :exec
INSERT INTO users (id, last_active_at, created_at, updated_at)
VALUES (
    sqlc.arg(user_id)::uuid,
    sqlc.arg(now)::timestamptz,
    sqlc.arg(now)::timestamptz,
    sqlc.arg(now)::timestamptz
);

-- name: InsertSession :exec
INSERT INTO sessions (
    id,
    user_id,
    token_hash,
    csrf_token_hash,
    created_at,
    last_seen_at,
    idle_expires_at,
    absolute_expires_at
) VALUES (
    sqlc.arg(session_id)::uuid,
    sqlc.arg(user_id)::uuid,
    sqlc.arg(token_hash)::bytea,
    sqlc.arg(csrf_token_hash)::bytea,
    sqlc.arg(now)::timestamptz,
    sqlc.arg(now)::timestamptz,
    sqlc.arg(idle_expires_at)::timestamptz,
    sqlc.arg(absolute_expires_at)::timestamptz
);

-- name: RevokeSession :execrows
UPDATE sessions
SET revoked_at = sqlc.arg(now)::timestamptz
WHERE id = sqlc.arg(session_id)::uuid
  AND revoked_at IS NULL;

-- name: RevokeOwnedSession :execrows
UPDATE sessions
SET revoked_at = sqlc.arg(now)::timestamptz
WHERE id = sqlc.arg(session_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND revoked_at IS NULL;

-- name: InsertAnonymousBootstrap :exec
INSERT INTO anonymous_bootstraps (key_hash, user_id, expires_at, created_at)
VALUES (
    sqlc.arg(key_hash)::bytea,
    sqlc.arg(user_id)::uuid,
    sqlc.arg(expires_at)::timestamptz,
    sqlc.arg(now)::timestamptz
);
