BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM goal_versions WHERE char_length(body) > 80)
       OR EXISTS (SELECT 1 FROM goal_drafts WHERE char_length(body) > 80)
       OR EXISTS (
           SELECT 1 FROM pdca_cycles
           WHERE char_length(plan) > 200
              OR char_length(do_text) > 200
              OR char_length(check_text) > 200
              OR char_length(action) > 200
       )
       OR EXISTS (
           SELECT 1 FROM ai_generations
           WHERE (operation_type = 'goal_refine' AND source_text IS NOT NULL AND char_length(source_text) > 80)
              OR (operation_type = 'action_refine' AND source_text IS NOT NULL AND char_length(source_text) > 200)
              OR (operation_type = 'goal_refine' AND output IS NOT NULL AND char_length(output) > 80)
              OR (operation_type IN ('action_generate','action_refine') AND output IS NOT NULL AND char_length(output) > 200)
       ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            MESSAGE = 'content exceeds the new goal (80) or PDCA frame (200) character limit';
    END IF;
END
$$;

ALTER TABLE goal_versions
    ADD CONSTRAINT goal_versions_body_max_80 CHECK (char_length(body) BETWEEN 1 AND 80);
ALTER TABLE goal_drafts
    ADD CONSTRAINT goal_drafts_body_max_80 CHECK (char_length(body) <= 80);
ALTER TABLE pdca_cycles
    ADD CONSTRAINT pdca_cycles_plan_max_200 CHECK (char_length(plan) <= 200),
    ADD CONSTRAINT pdca_cycles_do_max_200 CHECK (char_length(do_text) <= 200),
    ADD CONSTRAINT pdca_cycles_check_max_200 CHECK (char_length(check_text) <= 200),
    ADD CONSTRAINT pdca_cycles_action_max_200 CHECK (char_length(action) <= 200);
ALTER TABLE ai_generations
    ADD CONSTRAINT ai_generations_source_text_tight_limit CHECK (
        (operation_type = 'action_generate' AND source_text IS NULL)
        OR (operation_type = 'goal_refine' AND source_text IS NOT NULL AND char_length(source_text) <= 80)
        OR (operation_type = 'action_refine' AND source_text IS NOT NULL AND char_length(source_text) <= 200)
    ),
    ADD CONSTRAINT ai_generations_output_tight_limit CHECK (
        output IS NULL
        OR (operation_type = 'goal_refine' AND char_length(output) <= 80)
        OR (operation_type IN ('action_generate','action_refine') AND char_length(output) <= 200)
    );

COMMIT;
