-- name: AggregateSurvivorFunnelKPI :one
WITH report_input AS (
    SELECT
        sqlc.arg(cohort_start)::timestamptz AS cohort_start,
        sqlc.arg(cohort_end)::timestamptz AS cohort_end,
        sqlc.arg(as_of)::timestamptz AS as_of
),
first_surviving_goals AS MATERIALIZED (
    SELECT DISTINCT ON (goal.user_id)
        goal.user_id,
        goal.id AS goal_id,
        goal.created_at AS goal_started_at,
        goal.terminal_at
    FROM public.goals AS goal
    ORDER BY goal.user_id, goal.created_at, goal.id
),
activation_cohort AS (
    SELECT
        app_user.created_at AS user_created_at,
        first_goal.goal_started_at,
        first_goal.goal_started_at IS NOT NULL
            AND first_goal.goal_started_at >= app_user.created_at
            AND first_goal.goal_started_at <= app_user.created_at + INTERVAL '48 hours'
            AS activated
    FROM public.users AS app_user
    CROSS JOIN report_input AS input
    LEFT JOIN first_surviving_goals AS first_goal ON first_goal.user_id = app_user.id
    WHERE app_user.created_at >= input.cohort_start
      AND app_user.created_at < input.cohort_end
      AND app_user.created_at + INTERVAL '48 hours' <= input.as_of
),
activation_aggregate AS (
    SELECT
        count(*)::bigint AS denominator,
        count(*) FILTER (WHERE activated)::bigint AS numerator,
        count(*) FILTER (WHERE activated)::bigint AS duration_count,
        coalesce((
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM (goal_started_at - user_created_at))
            ) FILTER (WHERE activated)
        )::double precision, 0::double precision)::double precision AS duration_p50_seconds,
        coalesce((
            percentile_cont(0.9) WITHIN GROUP (
                ORDER BY extract(epoch FROM (goal_started_at - user_created_at))
            ) FILTER (WHERE activated)
        )::double precision, 0::double precision)::double precision AS duration_p90_seconds
    FROM activation_cohort
),
first_goal_cohort AS (
    SELECT
        first_goal.goal_id,
        first_goal.goal_started_at,
        first_goal.terminal_at
    FROM first_surviving_goals AS first_goal
    CROSS JOIN report_input AS input
    WHERE first_goal.goal_started_at >= input.cohort_start
      AND first_goal.goal_started_at < input.cohort_end
      AND first_goal.goal_started_at + INTERVAL '168 hours' <= input.as_of
),
funnel_base AS (
    SELECT
        first_goal.goal_started_at,
        first_goal.terminal_at,
        cycle_one.completed_at AS cycle_one_completed_at,
        cycle_two.id AS cycle_two_id,
        cycle_two.started_at AS cycle_two_started_at,
        cycle_three.started_at AS cycle_three_started_at
    FROM first_goal_cohort AS first_goal
    LEFT JOIN public.pdca_cycles AS cycle_one
      ON cycle_one.goal_id = first_goal.goal_id
     AND cycle_one.sequence_number = 1
    LEFT JOIN public.pdca_cycles AS cycle_two
      ON cycle_two.goal_id = first_goal.goal_id
     AND cycle_two.sequence_number = 2
    LEFT JOIN public.pdca_cycles AS cycle_three
      ON cycle_three.goal_id = first_goal.goal_id
     AND cycle_three.sequence_number = 3
),
funnel_events AS (
    SELECT
        funnel_base.*,
        cycle_one_completed_at IS NOT NULL
            AND cycle_one_completed_at >= goal_started_at
            AND cycle_one_completed_at <= goal_started_at + INTERVAL '168 hours'
            AS cycle_one_succeeded,
        CASE
            WHEN cycle_one_completed_at IS NULL THEN NULL
            WHEN cycle_two_started_at IS NOT NULL
             AND cycle_two_started_at >= cycle_one_completed_at
                THEN cycle_two_started_at
            WHEN cycle_two_id IS NULL
             AND terminal_at IS NOT NULL
             AND terminal_at >= cycle_one_completed_at
                THEN terminal_at
            ELSE NULL
        END AS review_decision_at,
        CASE
            WHEN cycle_one_completed_at IS NULL THEN NULL
            WHEN cycle_two_started_at IS NOT NULL
             AND cycle_two_started_at >= cycle_one_completed_at
                THEN 'next_cycle'
            WHEN cycle_two_id IS NULL
             AND terminal_at IS NOT NULL
             AND terminal_at >= cycle_one_completed_at
                THEN 'terminal_review'
            ELSE NULL
        END AS review_decision_kind
    FROM funnel_base
),
funnel_outcomes AS (
    SELECT
        funnel_events.*,
        cycle_one_succeeded
            AND review_decision_at IS NOT NULL
            AND review_decision_at >= cycle_one_completed_at
            AND review_decision_at <= goal_started_at + INTERVAL '168 hours'
            AS review_decision_succeeded
    FROM funnel_events
),
funnel_aggregate AS (
    SELECT
        count(*)::bigint AS denominator,
        count(*) FILTER (WHERE cycle_one_succeeded)::bigint AS cycle_one_completed,
        count(*) FILTER (WHERE review_decision_succeeded)::bigint AS review_decision,
        count(*) FILTER (
            WHERE review_decision_succeeded AND review_decision_kind = 'next_cycle'
        )::bigint AS next_cycle_decision,
        count(*) FILTER (
            WHERE review_decision_succeeded AND review_decision_kind = 'terminal_review'
        )::bigint AS terminal_review_decision,
        count(*) FILTER (
            WHERE review_decision_succeeded AND review_decision_kind = 'next_cycle'
        )::bigint AS cycle_two_started,
        count(*) FILTER (
            WHERE review_decision_succeeded
              AND review_decision_kind = 'next_cycle'
              AND cycle_three_started_at IS NOT NULL
              AND cycle_three_started_at >= cycle_two_started_at
              AND cycle_three_started_at <= goal_started_at + INTERVAL '168 hours'
        )::bigint AS cycle_three_started,
        count(*) FILTER (WHERE cycle_one_succeeded)::bigint AS cycle_one_duration_count,
        coalesce((
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM (cycle_one_completed_at - goal_started_at))
            ) FILTER (WHERE cycle_one_succeeded)
        )::double precision, 0::double precision)::double precision AS cycle_one_duration_p50_seconds,
        coalesce((
            percentile_cont(0.9) WITHIN GROUP (
                ORDER BY extract(epoch FROM (cycle_one_completed_at - goal_started_at))
            ) FILTER (WHERE cycle_one_succeeded)
        )::double precision, 0::double precision)::double precision AS cycle_one_duration_p90_seconds,
        count(*) FILTER (WHERE review_decision_succeeded)::bigint AS decision_duration_count,
        coalesce((
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM (review_decision_at - cycle_one_completed_at))
            ) FILTER (WHERE review_decision_succeeded)
        )::double precision, 0::double precision)::double precision AS decision_duration_p50_seconds,
        coalesce((
            percentile_cont(0.9) WITHIN GROUP (
                ORDER BY extract(epoch FROM (review_decision_at - cycle_one_completed_at))
            ) FILTER (WHERE review_decision_succeeded)
        )::double precision, 0::double precision)::double precision AS decision_duration_p90_seconds
    FROM funnel_outcomes
)
SELECT
    current_setting('transaction_isolation') = 'repeatable read' AS repeatable_read,
    current_setting('transaction_read_only') = 'on' AS read_only,
    activation.denominator AS activation_denominator,
    activation.numerator AS activation_numerator,
    activation.duration_count AS activation_duration_count,
    activation.duration_p50_seconds AS activation_duration_p50_seconds,
    activation.duration_p90_seconds AS activation_duration_p90_seconds,
    funnel.denominator AS first_goal_denominator,
    funnel.cycle_one_completed,
    funnel.review_decision,
    funnel.next_cycle_decision,
    funnel.terminal_review_decision,
    funnel.cycle_two_started,
    funnel.cycle_three_started,
    funnel.cycle_one_duration_count,
    funnel.cycle_one_duration_p50_seconds,
    funnel.cycle_one_duration_p90_seconds,
    funnel.decision_duration_count,
    funnel.decision_duration_p50_seconds,
    funnel.decision_duration_p90_seconds
FROM activation_aggregate AS activation
CROSS JOIN funnel_aggregate AS funnel;
