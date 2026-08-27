BEGIN;

ALTER TABLE ai_usage_events
    DROP CONSTRAINT ai_usage_events_retention_deadline;

DROP TRIGGER trg_ai_usage_retention_deadline ON ai_usage_events;

DROP FUNCTION fukamu_cycle_apply_ai_usage_retention_deadline();

COMMIT;
