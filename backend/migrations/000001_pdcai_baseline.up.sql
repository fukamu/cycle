BEGIN;

CREATE TABLE users (
    id UUID PRIMARY KEY,
    last_active_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE anonymous_bootstraps (
    key_hash BYTEA PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_anonymous_bootstraps_expiry ON anonymous_bootstraps(expires_at);

CREATE TABLE auth_identities (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google')),
    provider_subject TEXT NOT NULL CHECK (char_length(provider_subject) BETWEEN 1 AND 255),
    email_at_link TEXT NULL,
    email_verified_at_link BOOLEAN NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(provider, provider_subject),
    UNIQUE(user_id, provider)
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    csrf_token_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    idle_expires_at TIMESTAMPTZ NOT NULL,
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(idle_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE goals (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('active_cycle','goal_review','achieved','ended')),
    current_version_number INTEGER NOT NULL CHECK (current_version_number >= 1),
    next_cycle_sequence_number INTEGER NOT NULL CHECK (next_cycle_sequence_number >= 2),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    terminal_at TIMESTAMPTZ NULL,
    terminal_operation_id UUID NULL,
    terminal_request_hash TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE(user_id, id),
    UNIQUE(user_id, terminal_operation_id),
    CHECK (
      (status IN ('active_cycle','goal_review')
        AND terminal_at IS NULL
        AND terminal_operation_id IS NULL
        AND terminal_request_hash IS NULL)
      OR
      (status IN ('achieved','ended')
        AND terminal_at IS NOT NULL
        AND terminal_operation_id IS NOT NULL
        AND terminal_request_hash IS NOT NULL)
    )
);
CREATE INDEX idx_goals_user_progressing
    ON goals(user_id, updated_at DESC, id DESC)
    WHERE status IN ('active_cycle','goal_review');
CREATE INDEX idx_goals_user_history
    ON goals(user_id, terminal_at DESC, id DESC)
    WHERE status IN ('achieved','ended');

CREATE TABLE goal_versions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    goal_id UUID NOT NULL,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
    created_by_operation_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(goal_id, version_number),
    UNIQUE(goal_id, id),
    UNIQUE(goal_id, created_by_operation_id),
    FOREIGN KEY(user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_goal_versions_timeline ON goal_versions(goal_id, version_number ASC);

CREATE TABLE pdca_cycles (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    goal_id UUID NOT NULL,
    goal_version_id UUID NOT NULL,
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
    status TEXT NOT NULL CHECK (status IN ('active','completed','canceled')),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NULL,
    canceled_at TIMESTAMPTZ NULL,
    cancellation_reason TEXT NULL CHECK (
      cancellation_reason IS NULL OR cancellation_reason IN ('goal_achieved','goal_ended')
    ),
    plan TEXT NOT NULL DEFAULT '',
    do_text TEXT NOT NULL DEFAULT '',
    check_text TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    content_revision BIGINT NOT NULL DEFAULT 0 CHECK (content_revision >= 0),
    plan_revision BIGINT NOT NULL DEFAULT 0 CHECK (plan_revision >= 0),
    do_revision BIGINT NOT NULL DEFAULT 0 CHECK (do_revision >= 0),
    check_revision BIGINT NOT NULL DEFAULT 0 CHECK (check_revision >= 0),
    action_revision BIGINT NOT NULL DEFAULT 0 CHECK (action_revision >= 0),
    action_last_ai_applied_content_revision BIGINT NULL,
    action_user_modified_after_ai BOOLEAN NOT NULL DEFAULT FALSE,
    start_operation_id UUID NOT NULL,
    start_request_hash TEXT NOT NULL,
    completion_operation_id UUID NULL,
    completion_request_hash TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE(goal_id, sequence_number),
    UNIQUE(goal_id, id),
    UNIQUE(user_id, start_operation_id),
    UNIQUE(user_id, completion_operation_id),
    FOREIGN KEY(user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY(goal_id, goal_version_id)
      REFERENCES goal_versions(goal_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CHECK (char_length(plan) <= 2000),
    CHECK (char_length(do_text) <= 2000),
    CHECK (char_length(check_text) <= 2000),
    CHECK (char_length(action) <= 2000),
    CHECK (
      action_last_ai_applied_content_revision IS NULL
      OR (action_last_ai_applied_content_revision >= 1
          AND action_last_ai_applied_content_revision <= content_revision)
    ),
    CHECK (
      (status = 'active'
        AND completed_at IS NULL
        AND canceled_at IS NULL
        AND cancellation_reason IS NULL
        AND completion_operation_id IS NULL
        AND completion_request_hash IS NULL)
      OR
      (status = 'completed'
        AND completed_at IS NOT NULL
        AND canceled_at IS NULL
        AND cancellation_reason IS NULL
        AND completion_operation_id IS NOT NULL
        AND completion_request_hash IS NOT NULL)
      OR
      (status = 'canceled'
        AND completed_at IS NULL
        AND canceled_at IS NOT NULL
        AND cancellation_reason IS NOT NULL
        AND completion_operation_id IS NULL
        AND completion_request_hash IS NULL)
    )
);
CREATE UNIQUE INDEX uq_pdca_cycles_one_active_per_goal
    ON pdca_cycles(goal_id) WHERE status = 'active';
CREATE INDEX idx_pdca_cycles_goal_history
    ON pdca_cycles(goal_id, sequence_number DESC, id DESC)
    WHERE status IN ('completed','canceled');

CREATE TABLE goal_drafts (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    draft_type TEXT NOT NULL CHECK (draft_type IN ('creation','review')),
    goal_id UUID NULL,
    base_goal_version_id UUID NULL,
    review_cycle_id UUID NULL,
    body TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 500),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE(user_id, id),
    FOREIGN KEY(user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY(goal_id, base_goal_version_id)
      REFERENCES goal_versions(goal_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(goal_id, review_cycle_id)
      REFERENCES pdca_cycles(goal_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (draft_type = 'creation'
        AND goal_id IS NULL
        AND base_goal_version_id IS NULL
        AND review_cycle_id IS NULL)
      OR
      (draft_type = 'review'
        AND goal_id IS NOT NULL
        AND base_goal_version_id IS NOT NULL
        AND review_cycle_id IS NOT NULL)
    )
);
CREATE UNIQUE INDEX uq_goal_drafts_one_creation_per_user
    ON goal_drafts(user_id) WHERE draft_type = 'creation';
CREATE UNIQUE INDEX uq_goal_drafts_one_review_per_goal
    ON goal_drafts(goal_id) WHERE draft_type = 'review';

CREATE TABLE ai_generations (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_type TEXT NOT NULL CHECK (
      operation_type IN ('goal_refine','action_generate','action_refine')
    ),
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
    source_goal_draft_id UUID NULL,
    goal_id UUID NULL,
    goal_version_id UUID NULL,
    cycle_id UUID NULL,
    target_revision BIGINT NOT NULL CHECK (target_revision >= 0),
    idempotency_key UUID NOT NULL,
    input_hash TEXT NOT NULL,
    source_text TEXT NULL,
    output TEXT NULL,
    context_cycle_ids UUID[] NOT NULL DEFAULT '{}',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    input_tokens BIGINT NULL,
    output_tokens BIGINT NULL,
    estimated_cost_usd NUMERIC(14,8) NULL,
    budget_month_utc DATE NOT NULL,
    budget_reserved_cost_usd NUMERIC(14,8) NOT NULL CHECK (budget_reserved_cost_usd >= 0),
    attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
    failure_code TEXT NULL,
    provider_request_id TEXT NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    context_changed BOOLEAN NOT NULL DEFAULT FALSE,
    adopted_at TIMESTAMPTZ NULL,
    adopted_draft_revision BIGINT NULL CHECK (adopted_draft_revision IS NULL OR adopted_draft_revision >= 0),
    applied_at TIMESTAMPTZ NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NULL,
    UNIQUE(user_id, operation_type, idempotency_key),
    FOREIGN KEY(user_id, source_goal_draft_id)
      REFERENCES goal_drafts(user_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY(goal_id, goal_version_id) REFERENCES goal_versions(goal_id, id) ON DELETE CASCADE,
    FOREIGN KEY(goal_id, cycle_id)
      REFERENCES pdca_cycles(goal_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CHECK (cardinality(context_cycle_ids) <= 10),
    CHECK (
      (status = 'running' AND finished_at IS NULL AND lease_expires_at IS NOT NULL)
      OR
      (status IN ('succeeded','failed') AND finished_at IS NOT NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (status = 'running' AND output IS NULL AND failure_code IS NULL)
      OR
      (status = 'succeeded' AND output IS NOT NULL AND failure_code IS NULL)
      OR
      (status = 'failed' AND output IS NULL AND failure_code IS NOT NULL)
    ),
    CHECK (status = 'running' OR budget_reserved_cost_usd = 0),
    CHECK (
      (operation_type = 'goal_refine' AND applied_at IS NULL)
      OR
      (operation_type IN ('action_generate','action_refine') AND (
        (status = 'succeeded' AND applied_at IS NOT NULL)
        OR (status <> 'succeeded' AND applied_at IS NULL)
      ))
    ),
    CHECK (
      (adopted_at IS NULL AND adopted_draft_revision IS NULL)
      OR
      (operation_type = 'goal_refine' AND status = 'succeeded'
        AND adopted_at IS NOT NULL AND adopted_draft_revision IS NOT NULL)
    ),
    CHECK (
      (operation_type IN ('action_generate','action_refine')
        AND source_goal_draft_id IS NULL
        AND goal_id IS NOT NULL
        AND goal_version_id IS NOT NULL
        AND cycle_id IS NOT NULL)
      OR
      (operation_type = 'goal_refine' AND cycle_id IS NULL AND (
        (source_goal_draft_id IS NOT NULL AND (
          (goal_id IS NULL AND goal_version_id IS NULL)
          OR (goal_id IS NOT NULL AND goal_version_id IS NOT NULL)
        ))
        OR (source_goal_draft_id IS NULL AND goal_id IS NOT NULL AND goal_version_id IS NOT NULL)
      ))
    ),
    CHECK (
      (operation_type = 'action_generate' AND source_text IS NULL)
      OR (operation_type = 'goal_refine' AND source_text IS NOT NULL AND char_length(source_text) <= 500)
      OR (operation_type = 'action_refine' AND source_text IS NOT NULL AND char_length(source_text) <= 2000)
    ),
    CHECK (
      output IS NULL
      OR (operation_type = 'goal_refine' AND char_length(output) <= 500)
      OR (operation_type IN ('action_generate','action_refine') AND char_length(output) <= 2000)
    ),
    CHECK (input_tokens IS NULL OR input_tokens >= 0),
    CHECK (output_tokens IS NULL OR output_tokens >= 0),
    CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0)
);
CREATE UNIQUE INDEX uq_ai_one_running_per_cycle
    ON ai_generations(cycle_id) WHERE status = 'running' AND cycle_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ai_one_running_per_goal_draft
    ON ai_generations(source_goal_draft_id)
    WHERE status = 'running' AND source_goal_draft_id IS NOT NULL;
CREATE INDEX idx_ai_generations_goal_time
    ON ai_generations(goal_id, started_at DESC) WHERE goal_id IS NOT NULL;
CREATE INDEX idx_ai_generations_prompt_model
    ON ai_generations(prompt_version, model, started_at DESC);

CREATE TABLE ai_usage_events (
    operation_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id UUID NULL REFERENCES goals(id) ON DELETE SET NULL,
    operation_type TEXT NOT NULL CHECK (
      operation_type IN ('goal_refine','action_generate','action_refine')
    ),
    status TEXT NOT NULL CHECK (status IN ('accepted','succeeded','failed')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL,
    input_tokens BIGINT NULL,
    output_tokens BIGINT NULL,
    estimated_cost_usd NUMERIC(14,8) NULL,
    provider_usage_finalized_at TIMESTAMPTZ NULL,
    quota_retain_until TIMESTAMPTZ NOT NULL,
    content_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CHECK (input_tokens IS NULL OR input_tokens >= 0),
    CHECK (output_tokens IS NULL OR output_tokens >= 0),
    CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
    CHECK (quota_retain_until >= accepted_at)
);
CREATE INDEX idx_ai_usage_user_rolling ON ai_usage_events(user_id, accepted_at DESC);
CREATE INDEX idx_ai_usage_goal ON ai_usage_events(goal_id, accepted_at DESC) WHERE goal_id IS NOT NULL;

CREATE TABLE ai_budget_monthly (
    month_utc DATE PRIMARY KEY,
    reserved_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
    actual_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
    unattributed_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (reserved_cost_usd >= 0),
    CHECK (actual_cost_usd >= 0),
    CHECK (unattributed_cost_usd >= 0)
);

CREATE TABLE goal_delete_receipts (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    deleted_goal_id UUID NOT NULL,
    request_hash TEXT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(user_id, idempotency_key)
);
CREATE INDEX idx_goal_delete_receipts_expiry ON goal_delete_receipts(expires_at);

CREATE TABLE abuse_rate_buckets (
    scope TEXT NOT NULL,
    key_hash BYTEA NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(scope, key_hash, window_start)
);
CREATE INDEX idx_abuse_bucket_expiry ON abuse_rate_buckets(expires_at);

COMMIT;
