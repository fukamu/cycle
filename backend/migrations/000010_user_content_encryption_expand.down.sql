BEGIN;

DO $$
BEGIN
    IF (SELECT mode FROM public.content_encryption_control WHERE singleton = TRUE) <> 'legacy'
       OR EXISTS (SELECT 1 FROM public.user_content_deks)
       OR EXISTS (SELECT 1 FROM public.content_encryption_jobs)
       OR EXISTS (SELECT 1 FROM public.goal_versions WHERE content_storage_format <> 'legacy')
       OR EXISTS (SELECT 1 FROM public.goal_drafts WHERE content_storage_format <> 'legacy')
       OR EXISTS (SELECT 1 FROM public.goal_version_success_signals WHERE content_storage_format <> 'legacy')
       OR EXISTS (SELECT 1 FROM public.goal_draft_success_signals WHERE content_storage_format <> 'legacy')
       OR EXISTS (SELECT 1 FROM public.pdca_cycles WHERE content_storage_format <> 'legacy')
       OR EXISTS (SELECT 1 FROM public.ai_generations WHERE content_storage_format <> 'legacy') THEN
        RAISE EXCEPTION 'cannot remove content encryption schema after activation or encrypted writes'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

DROP TRIGGER trg_00_ai_generations_content_storage ON public.ai_generations;
DROP TRIGGER trg_00_pdca_cycles_content_storage ON public.pdca_cycles;
DROP TRIGGER trg_00_goal_draft_signals_content_storage ON public.goal_draft_success_signals;
DROP TRIGGER trg_00_goal_version_signals_content_storage ON public.goal_version_success_signals;
DROP TRIGGER trg_00_goal_drafts_content_storage ON public.goal_drafts;
DROP TRIGGER trg_00_goal_versions_content_storage ON public.goal_versions;

ALTER TABLE public.ai_generations
    DROP CONSTRAINT ai_generations_output_state_storage,
    DROP CONSTRAINT ai_generations_output_tight_limit,
    DROP CONSTRAINT ai_generations_source_text_tight_limit,
    DROP CONSTRAINT ai_generations_content_storage,
    DROP COLUMN canonical_provider_input_hash_ciphertext,
    DROP COLUMN canonical_provider_input_hash_nonce,
    DROP COLUMN canonical_provider_input_hash_crypto_revision,
    DROP COLUMN canonical_provider_input_hash_dek_version,
    DROP COLUMN output_ciphertext,
    DROP COLUMN output_nonce,
    DROP COLUMN output_crypto_revision,
    DROP COLUMN output_dek_version,
    DROP COLUMN source_text_ciphertext,
    DROP COLUMN source_text_nonce,
    DROP COLUMN source_text_crypto_revision,
    DROP COLUMN source_text_dek_version,
    DROP COLUMN content_storage_format,
    ADD CONSTRAINT ai_generations_source_text_tight_limit CHECK (
      (operation_type = 'action_generate' AND source_text IS NULL)
      OR (operation_type = 'goal_refine' AND source_text IS NOT NULL AND char_length(source_text) <= 80)
      OR (operation_type = 'action_refine' AND source_text IS NOT NULL AND char_length(source_text) <= 200)
    ),
    ADD CONSTRAINT ai_generations_output_tight_limit CHECK (
      output IS NULL
      OR (operation_type = 'goal_refine' AND char_length(output) <= 80)
      OR (operation_type IN ('action_generate','action_refine') AND char_length(output) <= 200)
    ),
    ADD CONSTRAINT ai_generations_check1 CHECK (
      (status = 'running' AND output IS NULL AND failure_code IS NULL)
      OR (status = 'succeeded' AND output IS NOT NULL AND failure_code IS NULL)
      OR (status = 'failed' AND output IS NULL AND failure_code IS NOT NULL)
    );

ALTER TABLE public.pdca_cycles
    DROP CONSTRAINT pdca_cycles_content_storage,
    DROP COLUMN action_ciphertext, DROP COLUMN action_nonce, DROP COLUMN action_crypto_revision, DROP COLUMN action_dek_version,
    DROP COLUMN check_text_ciphertext, DROP COLUMN check_text_nonce, DROP COLUMN check_text_crypto_revision, DROP COLUMN check_text_dek_version,
    DROP COLUMN do_text_ciphertext, DROP COLUMN do_text_nonce, DROP COLUMN do_text_crypto_revision, DROP COLUMN do_text_dek_version,
    DROP COLUMN plan_ciphertext, DROP COLUMN plan_nonce, DROP COLUMN plan_crypto_revision, DROP COLUMN plan_dek_version,
    DROP COLUMN content_storage_format,
    ALTER COLUMN plan SET DEFAULT '', ALTER COLUMN plan SET NOT NULL,
    ALTER COLUMN do_text SET DEFAULT '', ALTER COLUMN do_text SET NOT NULL,
    ALTER COLUMN check_text SET DEFAULT '', ALTER COLUMN check_text SET NOT NULL,
    ALTER COLUMN action SET DEFAULT '', ALTER COLUMN action SET NOT NULL;

ALTER TABLE public.goal_draft_success_signals
    DROP CONSTRAINT goal_draft_success_signals_storage,
    DROP COLUMN success_signal_ciphertext, DROP COLUMN success_signal_nonce,
    DROP COLUMN success_signal_crypto_revision, DROP COLUMN success_signal_dek_version,
    DROP COLUMN content_storage_format,
    ALTER COLUMN success_signal SET NOT NULL;
ALTER TABLE public.goal_version_success_signals
    DROP CONSTRAINT goal_version_success_signals_storage,
    DROP COLUMN success_signal_ciphertext, DROP COLUMN success_signal_nonce,
    DROP COLUMN success_signal_crypto_revision, DROP COLUMN success_signal_dek_version,
    DROP COLUMN content_storage_format,
    ALTER COLUMN success_signal SET NOT NULL;
ALTER TABLE public.goal_drafts
    DROP CONSTRAINT goal_drafts_body_storage,
    DROP COLUMN body_ciphertext, DROP COLUMN body_nonce, DROP COLUMN body_crypto_revision, DROP COLUMN body_dek_version,
    DROP COLUMN content_storage_format,
    ALTER COLUMN body SET NOT NULL;
ALTER TABLE public.goal_versions
    DROP CONSTRAINT goal_versions_body_storage,
    DROP COLUMN body_ciphertext, DROP COLUMN body_nonce, DROP COLUMN body_crypto_revision, DROP COLUMN body_dek_version,
    DROP COLUMN content_storage_format,
    ALTER COLUMN body SET NOT NULL;

DROP TABLE public.content_encryption_jobs;
DROP TABLE public.user_content_nonce_reservations;
DROP TABLE public.user_content_deks;
DROP TABLE public.content_encryption_control;
DROP FUNCTION public.fukamu_cycle_apply_content_storage();
DROP FUNCTION public.fukamu_cycle_content_read_text(TEXT,TEXT,INTEGER,BIGINT,BYTEA,BYTEA);
DROP FUNCTION public.fukamu_cycle_encrypted_field_valid(INTEGER,BIGINT,BYTEA,BYTEA);

-- Restore the hash trigger semantics owned by migration 000004.
CREATE OR REPLACE FUNCTION public.fukamu_cycle_apply_ai_generation_hash_split()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE legacy_writer BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.input_hash IS DISTINCT FROM OLD.input_hash
           OR NEW.idempotency_request_hash IS DISTINCT FROM OLD.idempotency_request_hash
           OR NEW.canonical_provider_input_hash IS DISTINCT FROM OLD.canonical_provider_input_hash THEN
            RAISE EXCEPTION 'AI generation hashes are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    legacy_writer := NEW.idempotency_request_hash IS NULL;
    IF NEW.idempotency_request_hash IS NULL THEN NEW.idempotency_request_hash := NEW.input_hash; END IF;
    IF NEW.input_hash IS NULL THEN NEW.input_hash := NEW.idempotency_request_hash; END IF;
    IF NEW.input_hash IS NULL OR NEW.input_hash !~ '^[0-9a-f]{64}$'
       OR NEW.idempotency_request_hash IS NULL OR NEW.idempotency_request_hash !~ '^[0-9a-f]{64}$'
       OR NEW.input_hash IS DISTINCT FROM NEW.idempotency_request_hash THEN
        RAISE EXCEPTION 'AI generation request hash is invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.canonical_provider_input_hash IS NOT NULL
       AND NEW.canonical_provider_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'AI generation canonical provider input hash is invalid' USING ERRCODE = '23514';
    END IF;
    IF NOT legacy_writer AND NEW.canonical_provider_input_hash IS NULL THEN
        RAISE EXCEPTION 'new AI generation is missing canonical provider input hash' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- Restore the baseline function body owned by migration 000001.
CREATE OR REPLACE FUNCTION public.fukamu_cycle_uuid_array_is_v7(items UUID[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT COALESCE(bool_and(value IS NOT NULL AND fukamu_cycle_uuid_is_v7(value)), TRUE)
    FROM unnest(items) AS value
$$;

COMMIT;
