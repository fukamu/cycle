BEGIN;

CREATE TABLE public.anonymous_rate_limit_guards (
    scope TEXT NOT NULL,
    key_hash BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(scope, key_hash)
);

CREATE INDEX idx_anonymous_rate_limit_guard_expiry
    ON public.anonymous_rate_limit_guards(expires_at, scope, key_hash);

COMMIT;
