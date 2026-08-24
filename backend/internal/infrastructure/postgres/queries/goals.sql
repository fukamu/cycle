-- name: GetOwnedGoal :one
SELECT *
FROM goals
WHERE id = $1 AND user_id = $2;

-- name: ListHomeGoalViews :many
SELECT
    g.id AS goal_id,
    g.status AS goal_status,
    g.revision AS goal_revision,
    g.next_cycle_sequence_number,
    g.created_at AS goal_created_at,
    g.terminal_at AS goal_terminal_at,
    gv.id AS current_version_id,
    gv.version_number AS current_version_number,
    gv.body AS current_version_body,
    gv.created_at AS current_version_created_at,
    (
        SELECT count(*)
        FROM pdca_cycles counted
        WHERE counted.user_id = g.user_id AND counted.goal_id = g.id
    )::integer AS cycle_count,
    active_cycle.id AS active_cycle_id,
    active_cycle.sequence_number AS active_cycle_sequence_number,
    review_draft.id AS review_draft_id,
    trigger_cycle.id AS trigger_cycle_id,
    trigger_cycle.sequence_number AS trigger_cycle_sequence_number,
    (
        CASE WHEN g.status IN ('active_cycle', 'goal_review') THEN 0 ELSE 1 END
    )::smallint AS category,
    (
        CASE
            WHEN g.status IN ('active_cycle', 'goal_review') THEN g.updated_at
            ELSE g.terminal_at
        END
    )::timestamptz AS sort_time
FROM goals g
LEFT JOIN goal_versions gv
    ON gv.user_id = g.user_id
   AND gv.goal_id = g.id
   AND gv.version_number = g.current_version_number
LEFT JOIN pdca_cycles active_cycle
    ON active_cycle.user_id = g.user_id
   AND active_cycle.goal_id = g.id
   AND active_cycle.status = 'active'
LEFT JOIN goal_drafts review_draft
    ON review_draft.user_id = g.user_id
   AND review_draft.goal_id = g.id
   AND review_draft.draft_type = 'review'
LEFT JOIN pdca_cycles trigger_cycle
    ON trigger_cycle.user_id = g.user_id
   AND trigger_cycle.goal_id = g.id
   AND trigger_cycle.id = review_draft.review_cycle_id
WHERE g.user_id = sqlc.arg(user_id)::uuid
  AND g.status IN ('active_cycle', 'goal_review')
ORDER BY g.created_at ASC, g.id ASC;

-- name: ListGoalViews :many
SELECT
    g.id AS goal_id,
    g.status AS goal_status,
    g.revision AS goal_revision,
    g.next_cycle_sequence_number,
    g.created_at AS goal_created_at,
    g.terminal_at AS goal_terminal_at,
    gv.id AS current_version_id,
    gv.version_number AS current_version_number,
    gv.body AS current_version_body,
    gv.created_at AS current_version_created_at,
    (
        SELECT count(*)
        FROM pdca_cycles counted
        WHERE counted.user_id = g.user_id AND counted.goal_id = g.id
    )::integer AS cycle_count,
    active_cycle.id AS active_cycle_id,
    active_cycle.sequence_number AS active_cycle_sequence_number,
    review_draft.id AS review_draft_id,
    trigger_cycle.id AS trigger_cycle_id,
    trigger_cycle.sequence_number AS trigger_cycle_sequence_number,
    (
        CASE WHEN g.status IN ('active_cycle', 'goal_review') THEN 0 ELSE 1 END
    )::smallint AS category,
    (
        CASE
            WHEN g.status IN ('active_cycle', 'goal_review') THEN g.updated_at
            ELSE g.terminal_at
        END
    )::timestamptz AS sort_time
FROM goals g
LEFT JOIN goal_versions gv
    ON gv.user_id = g.user_id
   AND gv.goal_id = g.id
   AND gv.version_number = g.current_version_number
LEFT JOIN pdca_cycles active_cycle
    ON active_cycle.user_id = g.user_id
   AND active_cycle.goal_id = g.id
   AND active_cycle.status = 'active'
LEFT JOIN goal_drafts review_draft
    ON review_draft.user_id = g.user_id
   AND review_draft.goal_id = g.id
   AND review_draft.draft_type = 'review'
LEFT JOIN pdca_cycles trigger_cycle
    ON trigger_cycle.user_id = g.user_id
   AND trigger_cycle.goal_id = g.id
   AND trigger_cycle.id = review_draft.review_cycle_id
WHERE g.user_id = sqlc.arg(user_id)::uuid
  AND (
      sqlc.arg(scope)::text = 'all'
      OR (sqlc.arg(scope)::text = 'progressing' AND g.status IN ('active_cycle', 'goal_review'))
      OR (sqlc.arg(scope)::text = 'history' AND g.status IN ('achieved', 'ended'))
  )
  AND (
      sqlc.narg(after_category)::smallint IS NULL
      OR CASE WHEN g.status IN ('active_cycle', 'goal_review') THEN 0 ELSE 1 END
          > sqlc.narg(after_category)::smallint
      OR (
          CASE WHEN g.status IN ('active_cycle', 'goal_review') THEN 0 ELSE 1 END
              = sqlc.narg(after_category)::smallint
          AND (
              CASE
                  WHEN g.status IN ('active_cycle', 'goal_review') THEN g.updated_at
                  ELSE g.terminal_at
              END,
              g.id
          ) < (
              sqlc.narg(after_sort_time)::timestamptz,
              sqlc.narg(after_goal_id)::uuid
          )
      )
  )
ORDER BY category ASC, sort_time DESC, g.id DESC
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: GetGoalView :one
SELECT
    g.id AS goal_id,
    g.status AS goal_status,
    g.revision AS goal_revision,
    g.next_cycle_sequence_number,
    g.created_at AS goal_created_at,
    g.terminal_at AS goal_terminal_at,
    gv.id AS current_version_id,
    gv.version_number AS current_version_number,
    gv.body AS current_version_body,
    gv.created_at AS current_version_created_at,
    (
        SELECT count(*)
        FROM pdca_cycles counted
        WHERE counted.user_id = g.user_id AND counted.goal_id = g.id
    )::integer AS cycle_count,
    active_cycle.id AS active_cycle_id,
    active_cycle.sequence_number AS active_cycle_sequence_number,
    review_draft.id AS review_draft_id,
    trigger_cycle.id AS trigger_cycle_id,
    trigger_cycle.sequence_number AS trigger_cycle_sequence_number,
    (
        CASE WHEN g.status IN ('active_cycle', 'goal_review') THEN 0 ELSE 1 END
    )::smallint AS category,
    (
        CASE
            WHEN g.status IN ('active_cycle', 'goal_review') THEN g.updated_at
            ELSE g.terminal_at
        END
    )::timestamptz AS sort_time
FROM goals g
LEFT JOIN goal_versions gv
    ON gv.user_id = g.user_id
   AND gv.goal_id = g.id
   AND gv.version_number = g.current_version_number
LEFT JOIN pdca_cycles active_cycle
    ON active_cycle.user_id = g.user_id
   AND active_cycle.goal_id = g.id
   AND active_cycle.status = 'active'
LEFT JOIN goal_drafts review_draft
    ON review_draft.user_id = g.user_id
   AND review_draft.goal_id = g.id
   AND review_draft.draft_type = 'review'
LEFT JOIN pdca_cycles trigger_cycle
    ON trigger_cycle.user_id = g.user_id
   AND trigger_cycle.goal_id = g.id
   AND trigger_cycle.id = review_draft.review_cycle_id
WHERE g.id = sqlc.arg(goal_id)::uuid
  AND g.user_id = sqlc.arg(user_id)::uuid;

-- name: GetHomeCreationGoalDraft :one
SELECT id, draft_type, goal_id, base_goal_version_id, review_cycle_id, body, revision, updated_at
FROM goal_drafts
WHERE user_id = sqlc.arg(user_id)::uuid AND draft_type = 'creation';

-- name: GetGoalDraftByID :one
SELECT id, draft_type, goal_id, base_goal_version_id, review_cycle_id, body, revision, updated_at
FROM goal_drafts
WHERE id = sqlc.arg(draft_id)::uuid AND user_id = sqlc.arg(user_id)::uuid;

-- name: GetCreationGoalDraft :one
SELECT *
FROM goal_drafts
WHERE id = $1 AND user_id = $2 AND draft_type = 'creation';

-- name: GetGoalReviewDraft :one
SELECT *
FROM goal_drafts
WHERE goal_id = $1 AND user_id = $2 AND draft_type = 'review';

-- name: ListProgressingGoals :many
SELECT *
FROM goals
WHERE user_id = $1 AND status IN ('active_cycle', 'goal_review')
ORDER BY updated_at DESC, id DESC;

-- name: CountProgressingGoals :one
SELECT count(*)::integer AS count
FROM goals
WHERE user_id = $1 AND status IN ('active_cycle', 'goal_review');

-- name: GetCurrentGoalVersion :one
SELECT gv.*
FROM goal_versions gv
JOIN goals g ON g.id = gv.goal_id AND g.user_id = gv.user_id
WHERE gv.goal_id = $1 AND gv.user_id = $2
  AND gv.version_number = g.current_version_number;
