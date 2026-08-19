-- name: GetOwnedGoal :one
SELECT *
FROM goals
WHERE id = $1 AND user_id = $2;

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
