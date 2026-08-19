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
