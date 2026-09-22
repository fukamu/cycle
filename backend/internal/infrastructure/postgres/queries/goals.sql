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
    COALESCE(public.fukamu_cycle_content_read_text(
      gv.content_storage_format, gv.body, gv.body_dek_version,
      gv.body_crypto_revision, gv.body_nonce, gv.body_ciphertext
    ), '')::text AS current_version_body,
    COALESCE(public.fukamu_cycle_content_read_text(
        gv_signal.content_storage_format, gv_signal.success_signal,
        gv_signal.success_signal_dek_version, gv_signal.success_signal_crypto_revision,
        gv_signal.success_signal_nonce, gv_signal.success_signal_ciphertext
    ), '')::text AS current_version_success_signal,
    gv.created_at AS current_version_created_at,
    (
        SELECT count(*)
        FROM pdca_cycles counted
        WHERE counted.user_id = g.user_id AND counted.goal_id = g.id
    )::integer AS cycle_count,
    active_cycle.id AS active_cycle_id,
    active_cycle.sequence_number AS active_cycle_sequence_number,
    active_review_schedule.review_date AS active_cycle_review_date,
    COALESCE(active_review_schedule.review_schedule_revision, 0)::bigint AS active_cycle_review_schedule_revision,
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
LEFT JOIN goal_version_success_signals gv_signal
    ON gv_signal.goal_version_id = gv.id
LEFT JOIN pdca_cycles active_cycle
    ON active_cycle.user_id = g.user_id
   AND active_cycle.goal_id = g.id
   AND active_cycle.status = 'active'
LEFT JOIN pdca_cycle_review_schedules active_review_schedule
    ON active_review_schedule.cycle_id = active_cycle.id
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
    COALESCE(public.fukamu_cycle_content_read_text(
      gv.content_storage_format, gv.body, gv.body_dek_version,
      gv.body_crypto_revision, gv.body_nonce, gv.body_ciphertext
    ), '')::text AS current_version_body,
    COALESCE(public.fukamu_cycle_content_read_text(
        gv_signal.content_storage_format, gv_signal.success_signal,
        gv_signal.success_signal_dek_version, gv_signal.success_signal_crypto_revision,
        gv_signal.success_signal_nonce, gv_signal.success_signal_ciphertext
    ), '')::text AS current_version_success_signal,
    gv.created_at AS current_version_created_at,
    (
        SELECT count(*)
        FROM pdca_cycles counted
        WHERE counted.user_id = g.user_id AND counted.goal_id = g.id
    )::integer AS cycle_count,
    active_cycle.id AS active_cycle_id,
    active_cycle.sequence_number AS active_cycle_sequence_number,
    active_review_schedule.review_date AS active_cycle_review_date,
    COALESCE(active_review_schedule.review_schedule_revision, 0)::bigint AS active_cycle_review_schedule_revision,
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
LEFT JOIN goal_version_success_signals gv_signal
    ON gv_signal.goal_version_id = gv.id
LEFT JOIN pdca_cycles active_cycle
    ON active_cycle.user_id = g.user_id
   AND active_cycle.goal_id = g.id
   AND active_cycle.status = 'active'
LEFT JOIN pdca_cycle_review_schedules active_review_schedule
    ON active_review_schedule.cycle_id = active_cycle.id
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
    COALESCE(public.fukamu_cycle_content_read_text(
      gv.content_storage_format, gv.body, gv.body_dek_version,
      gv.body_crypto_revision, gv.body_nonce, gv.body_ciphertext
    ), '')::text AS current_version_body,
    COALESCE(public.fukamu_cycle_content_read_text(
        gv_signal.content_storage_format, gv_signal.success_signal,
        gv_signal.success_signal_dek_version, gv_signal.success_signal_crypto_revision,
        gv_signal.success_signal_nonce, gv_signal.success_signal_ciphertext
    ), '')::text AS current_version_success_signal,
    gv.created_at AS current_version_created_at,
    (
        SELECT count(*)
        FROM pdca_cycles counted
        WHERE counted.user_id = g.user_id AND counted.goal_id = g.id
    )::integer AS cycle_count,
    active_cycle.id AS active_cycle_id,
    active_cycle.sequence_number AS active_cycle_sequence_number,
    active_review_schedule.review_date AS active_cycle_review_date,
    COALESCE(active_review_schedule.review_schedule_revision, 0)::bigint AS active_cycle_review_schedule_revision,
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
LEFT JOIN goal_version_success_signals gv_signal
    ON gv_signal.goal_version_id = gv.id
LEFT JOIN pdca_cycles active_cycle
    ON active_cycle.user_id = g.user_id
   AND active_cycle.goal_id = g.id
   AND active_cycle.status = 'active'
LEFT JOIN pdca_cycle_review_schedules active_review_schedule
    ON active_review_schedule.cycle_id = active_cycle.id
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
SELECT d.id, d.draft_type, d.goal_id, d.base_goal_version_id, d.review_cycle_id,
       public.fukamu_cycle_content_read_text(
         d.content_storage_format, d.body, d.body_dek_version,
         d.body_crypto_revision, d.body_nonce, d.body_ciphertext
       ) AS body,
       COALESCE(public.fukamu_cycle_content_read_text(
           signal.content_storage_format, signal.success_signal,
           signal.success_signal_dek_version, signal.success_signal_crypto_revision,
           signal.success_signal_nonce, signal.success_signal_ciphertext
       ), '')::text AS success_signal,
       d.revision, d.updated_at
FROM goal_drafts d
LEFT JOIN goal_draft_success_signals signal ON signal.goal_draft_id = d.id
WHERE d.user_id = sqlc.arg(user_id)::uuid AND d.draft_type = 'creation';

-- name: GetGoalDraftByID :one
SELECT d.id, d.draft_type, d.goal_id, d.base_goal_version_id, d.review_cycle_id,
       public.fukamu_cycle_content_read_text(
         d.content_storage_format, d.body, d.body_dek_version,
         d.body_crypto_revision, d.body_nonce, d.body_ciphertext
       ) AS body,
       COALESCE(public.fukamu_cycle_content_read_text(
           signal.content_storage_format, signal.success_signal,
           signal.success_signal_dek_version, signal.success_signal_crypto_revision,
           signal.success_signal_nonce, signal.success_signal_ciphertext
       ), '')::text AS success_signal,
       d.revision, d.updated_at
FROM goal_drafts d
LEFT JOIN goal_draft_success_signals signal ON signal.goal_draft_id = d.id
WHERE d.id = sqlc.arg(draft_id)::uuid AND d.user_id = sqlc.arg(user_id)::uuid;

-- name: GetGoalReviewDraft :one
SELECT d.id, d.user_id, d.draft_type, d.goal_id, d.base_goal_version_id, d.review_cycle_id,
       public.fukamu_cycle_content_read_text(
         d.content_storage_format, d.body, d.body_dek_version,
         d.body_crypto_revision, d.body_nonce, d.body_ciphertext
       ) AS body,
       COALESCE(public.fukamu_cycle_content_read_text(
           signal.content_storage_format, signal.success_signal,
           signal.success_signal_dek_version, signal.success_signal_crypto_revision,
           signal.success_signal_nonce, signal.success_signal_ciphertext
       ), '')::text AS success_signal,
       d.revision, d.created_at, d.updated_at
FROM goal_drafts d
LEFT JOIN goal_draft_success_signals signal ON signal.goal_draft_id = d.id
WHERE d.goal_id = $1 AND d.user_id = $2 AND d.draft_type = 'review';

-- name: CountProgressingGoals :one
SELECT count(*)::integer AS count
FROM goals
WHERE user_id = $1 AND status IN ('active_cycle', 'goal_review');
