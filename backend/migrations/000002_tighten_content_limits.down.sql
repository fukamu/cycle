BEGIN;

ALTER TABLE ai_generations
    DROP CONSTRAINT IF EXISTS ai_generations_output_tight_limit,
    DROP CONSTRAINT IF EXISTS ai_generations_source_text_tight_limit;
ALTER TABLE pdca_cycles
    DROP CONSTRAINT IF EXISTS pdca_cycles_action_max_200,
    DROP CONSTRAINT IF EXISTS pdca_cycles_check_max_200,
    DROP CONSTRAINT IF EXISTS pdca_cycles_do_max_200,
    DROP CONSTRAINT IF EXISTS pdca_cycles_plan_max_200;
ALTER TABLE goal_drafts
    DROP CONSTRAINT IF EXISTS goal_drafts_body_max_80;
ALTER TABLE goal_versions
    DROP CONSTRAINT IF EXISTS goal_versions_body_max_80;

COMMIT;
