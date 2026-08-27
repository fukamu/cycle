BEGIN;

CREATE INDEX idx_ai_usage_retention_cleanup
    ON public.ai_usage_events(quota_retain_until, operation_id)
    WHERE content_deleted = TRUE
      AND provider_usage_finalized_at IS NOT NULL;

CREATE INDEX idx_abuse_bucket_retention_cleanup
    ON public.abuse_rate_buckets(expires_at, scope, key_hash, window_start);

COMMIT;
