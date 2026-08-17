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

CREATE TABLE pdca_cycles (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NULL,
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
    completion_operation_id UUID NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE(user_id, sequence_number),
    CHECK (
      (status = 'active' AND completed_at IS NULL)
      OR
      (status = 'completed' AND completed_at IS NOT NULL)
    ),
    CHECK (char_length(plan) <= 2000),
    CHECK (char_length(do_text) <= 2000),
    CHECK (char_length(check_text) <= 2000),
    CHECK (char_length(action) <= 2000)
);
CREATE UNIQUE INDEX uq_pdca_cycles_one_active_per_user
    ON pdca_cycles(user_id)
    WHERE status = 'active';
CREATE INDEX idx_pdca_cycles_completed_list
    ON pdca_cycles(user_id, sequence_number DESC, id DESC)
    WHERE status = 'completed';

CREATE TABLE ai_generations (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cycle_id UUID NOT NULL REFERENCES pdca_cycles(id) ON DELETE CASCADE,
    generation_type TEXT NOT NULL CHECK (generation_type IN ('generate', 'refine')),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    current_content_revision BIGINT NOT NULL,
    idempotency_key UUID NOT NULL,
    input_hash TEXT NOT NULL,
    refine_source_action TEXT NULL CHECK (refine_source_action IS NULL OR char_length(refine_source_action) <= 2000),
    output TEXT NULL CHECK (output IS NULL OR char_length(output) <= 2000),
    context_cycle_ids UUID[] NOT NULL DEFAULT '{}',
    input_tokens BIGINT NULL,
    output_tokens BIGINT NULL,
    estimated_cost_usd NUMERIC(14,8) NULL,
    budget_month_utc DATE NOT NULL,
    budget_reserved_cost_usd NUMERIC(14,8) NOT NULL CHECK (budget_reserved_cost_usd >= 0),
    attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 2),
    failure_code TEXT NULL,
    provider_request_id TEXT NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NULL,
    UNIQUE(user_id, generation_type, idempotency_key),
    CHECK (cardinality(context_cycle_ids) <= 10),
    CHECK (
      (status = 'running' AND finished_at IS NULL AND lease_expires_at IS NOT NULL)
      OR
      (status IN ('succeeded','failed') AND finished_at IS NOT NULL)
    )
);
CREATE UNIQUE INDEX uq_ai_one_running_per_cycle
    ON ai_generations(cycle_id)
    WHERE status = 'running';
CREATE INDEX idx_ai_generations_user_time
    ON ai_generations(user_id, started_at DESC);
CREATE INDEX idx_ai_generations_prompt_model
    ON ai_generations(prompt_version, model, started_at DESC);

CREATE TABLE ai_usage_events (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    generation_id UUID NOT NULL UNIQUE REFERENCES ai_generations(id) ON DELETE CASCADE,
    generation_type TEXT NOT NULL CHECK (generation_type IN ('generate','refine')),
    accepted_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted','succeeded','failed')),
    input_tokens BIGINT NULL,
    output_tokens BIGINT NULL,
    estimated_cost_usd NUMERIC(14,8) NULL
);
CREATE INDEX idx_ai_usage_user_rolling
    ON ai_usage_events(user_id, accepted_at DESC);

CREATE TABLE ai_budget_monthly (
    month_utc DATE PRIMARY KEY,
    reserved_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
    actual_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL
);

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
