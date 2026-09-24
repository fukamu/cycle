-- name: GetProductionLaunchGate :one
SELECT
    config.public_access_enabled,
    EXISTS (
        SELECT 1
        FROM public.launch_allowed_users AS allowed
        WHERE allowed.user_id = sqlc.arg(user_id)::uuid
    ) AS user_allowed
FROM public.launch_config AS config
WHERE config.singleton = TRUE;
