-- name: FindCreationDraft :one
SELECT id, user_id, draft_type, goal_id, base_goal_version_id, review_cycle_id,
       body, revision, created_at, updated_at
FROM goal_drafts
WHERE user_id = sqlc.arg(user_id)::uuid
  AND draft_type = 'creation';

-- name: LockDraftByID :one
SELECT id, user_id, draft_type, goal_id, base_goal_version_id, review_cycle_id,
       body, revision, created_at, updated_at
FROM goal_drafts
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
FOR UPDATE;

-- name: LockReviewDraftByGoal :one
SELECT id, user_id, draft_type, goal_id, base_goal_version_id, review_cycle_id,
       body, revision, created_at, updated_at
FROM goal_drafts
WHERE goal_id = sqlc.arg(goal_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND draft_type = 'review'
FOR UPDATE;

-- name: InsertCreationDraft :execrows
INSERT INTO goal_drafts (
    id, user_id, draft_type, body, revision, created_at, updated_at
) VALUES (
    sqlc.arg(draft_id)::uuid,
    sqlc.arg(user_id)::uuid,
    'creation',
    sqlc.arg(body)::text,
    sqlc.arg(revision)::bigint,
    sqlc.arg(created_at)::timestamptz,
    sqlc.arg(updated_at)::timestamptz
);

-- name: SaveDraftCAS :execrows
UPDATE goal_drafts
SET body = sqlc.arg(body)::text,
    revision = sqlc.arg(new_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND draft_type = sqlc.arg(draft_type)::text
  AND revision = sqlc.arg(expected_revision)::bigint;

-- name: DeleteCreationDraftCAS :execrows
DELETE FROM goal_drafts
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND draft_type = 'creation'
  AND revision = sqlc.arg(expected_revision)::bigint;

-- name: InsertInitialGoal :execrows
INSERT INTO goals (
    id, user_id, status, current_version_number, next_cycle_sequence_number,
    revision, created_at, updated_at
) VALUES (
    sqlc.arg(goal_id)::uuid,
    sqlc.arg(user_id)::uuid,
    sqlc.arg(status)::text,
    sqlc.arg(current_version_number)::integer,
    sqlc.arg(next_cycle_sequence_number)::integer,
    sqlc.arg(revision)::bigint,
    sqlc.arg(created_at)::timestamptz,
    sqlc.arg(updated_at)::timestamptz
);

-- name: InsertGoalVersion :execrows
INSERT INTO goal_versions (
    id, user_id, goal_id, version_number, body, created_by_operation_id, created_at
) VALUES (
    sqlc.arg(version_id)::uuid,
    sqlc.arg(user_id)::uuid,
    sqlc.arg(goal_id)::uuid,
    sqlc.arg(version_number)::integer,
    sqlc.arg(body)::text,
    sqlc.arg(created_by_operation_id)::uuid,
    sqlc.arg(created_at)::timestamptz
);

-- name: LockGoalWithCurrentVersion :one
SELECT g.status,
       g.revision,
       gv.id AS current_version_id,
       gv.body
FROM goals g
JOIN goal_versions gv
  ON gv.user_id = g.user_id
 AND gv.goal_id = g.id
 AND gv.version_number = g.current_version_number
WHERE g.id = sqlc.arg(goal_id)::uuid
  AND g.user_id = sqlc.arg(user_id)::uuid
FOR UPDATE OF g;

-- name: AdoptDraftCAS :execrows
UPDATE goal_drafts
SET body = sqlc.arg(body)::text,
    revision = sqlc.arg(new_revision)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(draft_id)::uuid
  AND user_id = sqlc.arg(user_id)::uuid
  AND revision = sqlc.arg(expected_revision)::bigint;
