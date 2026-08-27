BEGIN;

DROP INDEX public.idx_abuse_bucket_retention_cleanup;
DROP INDEX public.idx_ai_usage_retention_cleanup;

COMMIT;
