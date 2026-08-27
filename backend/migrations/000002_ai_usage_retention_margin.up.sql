BEGIN;

CREATE FUNCTION fukamu_cycle_apply_ai_usage_retention_deadline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.quota_retain_until IS NOT NULL THEN
        NEW.quota_retain_until := NEW.accepted_at + INTERVAL '24 hours 15 minutes';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_usage_retention_deadline
BEFORE INSERT OR UPDATE OF accepted_at, quota_retain_until
ON ai_usage_events
FOR EACH ROW
EXECUTE FUNCTION fukamu_cycle_apply_ai_usage_retention_deadline();

UPDATE ai_usage_events
SET quota_retain_until = accepted_at + INTERVAL '24 hours 15 minutes'
WHERE quota_retain_until - accepted_at <> INTERVAL '24 hours 15 minutes';

ALTER TABLE ai_usage_events
    ADD CONSTRAINT ai_usage_events_retention_deadline
    CHECK (quota_retain_until - accepted_at = INTERVAL '24 hours 15 minutes')
    NOT VALID;

ALTER TABLE ai_usage_events
    VALIDATE CONSTRAINT ai_usage_events_retention_deadline;

COMMIT;
