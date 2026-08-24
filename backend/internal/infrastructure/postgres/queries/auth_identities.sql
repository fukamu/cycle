-- name: FindGoogleIdentityBySubject :one
SELECT user_id,
       CASE
           WHEN email_verified_at_link IS TRUE THEN email_at_link
           ELSE NULL
       END AS verified_email
FROM auth_identities
WHERE provider = 'google'
  AND provider_subject = sqlc.arg(provider_subject)::text;

-- name: InsertGoogleIdentity :exec
INSERT INTO auth_identities (
    id,
    user_id,
    provider,
    provider_subject,
    email_at_link,
    email_verified_at_link,
    created_at
) VALUES (
    sqlc.arg(identity_id)::uuid,
    sqlc.arg(user_id)::uuid,
    'google',
    sqlc.arg(provider_subject)::text,
    sqlc.narg(email_at_link)::text,
    sqlc.narg(email_verified_at_link)::boolean,
    sqlc.arg(created_at)::timestamptz
);
