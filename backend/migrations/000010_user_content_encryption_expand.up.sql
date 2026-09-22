BEGIN;

-- pg_dump restores with an empty search_path. Qualify the nested UUID helper so
-- ai_generations COPY remains valid during an isolated restore.
CREATE OR REPLACE FUNCTION public.fukamu_cycle_uuid_array_is_v7(items UUID[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT COALESCE(bool_and(value IS NOT NULL AND public.fukamu_cycle_uuid_is_v7(value)), TRUE)
    FROM unnest(items) AS value
$$;

CREATE TABLE public.content_encryption_control (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    mode TEXT NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy','encrypting','strict')),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO public.content_encryption_control(singleton, mode) VALUES (TRUE, 'legacy');

CREATE TABLE public.user_content_deks (
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    dek_version INTEGER NOT NULL CHECK (dek_version >= 1),
    kek_key_version TEXT NOT NULL CHECK (char_length(kek_key_version) BETWEEN 1 AND 512),
    wrapped_dek BYTEA NOT NULL CHECK (octet_length(wrapped_dek) BETWEEN 1 AND 65536),
    is_write_key BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(user_id, dek_version)
);

CREATE UNIQUE INDEX uq_user_content_deks_write_key
    ON public.user_content_deks(user_id) WHERE is_write_key;

CREATE TABLE public.user_content_nonce_reservations (
    user_id UUID NOT NULL,
    dek_version INTEGER NOT NULL,
    nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(user_id, dek_version, nonce),
    FOREIGN KEY(user_id, dek_version)
      REFERENCES public.user_content_deks(user_id, dek_version) ON DELETE CASCADE
);

CREATE TABLE public.content_encryption_jobs (
    id UUID PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('backfill','verify','dek_rotation','restore_drill')),
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    phase TEXT NOT NULL,
    processed_count BIGINT NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
    conflict_count BIGINT NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
    failure_count BIGINT NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    started_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NULL,
    CONSTRAINT content_encryption_jobs_id_uuid_v7 CHECK (public.fukamu_cycle_uuid_is_v7(id)),
    CHECK (
      (status = 'running' AND completed_at IS NULL)
      OR (status IN ('completed','failed') AND completed_at IS NOT NULL)
    )
);

CREATE OR REPLACE FUNCTION public.fukamu_cycle_encrypted_field_valid(
    dek_version INTEGER,
    crypto_revision BIGINT,
    nonce BYTEA,
    ciphertext BYTEA
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT dek_version >= 1
       AND crypto_revision >= 1
       AND octet_length(nonce) = 12
       AND octet_length(ciphertext) >= 16
$$;

CREATE OR REPLACE FUNCTION public.fukamu_cycle_content_read_text(
    storage_format TEXT,
    plaintext TEXT,
    dek_version INTEGER,
    crypto_revision BIGINT,
    nonce BYTEA,
    ciphertext BYTEA
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    current_mode TEXT;
BEGIN
	IF storage_format IS NULL THEN
		RETURN NULL;
	END IF;
    IF storage_format = 'legacy' THEN
        SELECT mode INTO STRICT current_mode
        FROM public.content_encryption_control
        WHERE singleton = TRUE;
        IF current_mode = 'strict' THEN
            RAISE EXCEPTION 'legacy user content is forbidden in strict mode'
                USING ERRCODE = '23514';
        END IF;
        IF plaintext IS NULL THEN
            RETURN NULL;
        END IF;
        IF plaintext LIKE '~fukamu-cycle-content-%' THEN
            RETURN '~fukamu-cycle-content-legacy~' ||
                jsonb_build_object('plaintext', plaintext)::text;
        END IF;
        RETURN plaintext;
    END IF;
    IF storage_format <> 'encrypted-v1'
       OR NOT public.fukamu_cycle_encrypted_field_valid(
           dek_version, crypto_revision, nonce, ciphertext
       ) THEN
        RAISE EXCEPTION 'invalid encrypted user content storage shape'
            USING ERRCODE = '23514';
    END IF;
    RETURN '~fukamu-cycle-content-encrypted-v1~' || jsonb_build_object(
        'algorithm', 'A256GCM',
        'cryptoRevision', crypto_revision,
        'dekVersion', dek_version,
        'format', 'fukamu-cycle-field-aes-256-gcm/v1',
        'nonce', encode(nonce, 'base64'),
        'sealedPayload', encode(ciphertext, 'base64')
    )::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.fukamu_cycle_apply_content_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_mode TEXT;
    writer_mode TEXT;
    field_name TEXT;
    dek_column TEXT;
    revision_column TEXT;
    nonce_column TEXT;
    ciphertext_column TEXT;
    new_record JSONB;
    old_record JSONB;
    patch JSONB := '{}'::jsonb;
    marker JSONB;
    plaintext TEXT;
    content_changed BOOLEAN := FALSE;
    direct_metadata_changed BOOLEAN := FALSE;
    index_value INTEGER;
BEGIN
    SELECT mode INTO STRICT current_mode
    FROM public.content_encryption_control
    WHERE singleton = TRUE
    FOR SHARE;
    writer_mode := current_setting('fukamu_cycle.content_writer', TRUE);
    new_record := to_jsonb(NEW);
    IF TG_OP = 'UPDATE' THEN
        old_record := to_jsonb(OLD);
    ELSE
        old_record := '{}'::jsonb;
        content_changed := TRUE;
    END IF;

    FOR index_value IN 0..TG_NARGS - 1 LOOP
        field_name := TG_ARGV[index_value];
        dek_column := field_name || '_dek_version';
        revision_column := field_name || '_crypto_revision';
        nonce_column := field_name || '_nonce';
        ciphertext_column := field_name || '_ciphertext';
        IF TG_OP = 'UPDATE' THEN
            content_changed := content_changed
                OR (new_record -> field_name) IS DISTINCT FROM (old_record -> field_name);
            direct_metadata_changed := direct_metadata_changed
                OR (new_record -> dek_column) IS DISTINCT FROM (old_record -> dek_column)
                OR (new_record -> revision_column) IS DISTINCT FROM (old_record -> revision_column)
                OR (new_record -> nonce_column) IS DISTINCT FROM (old_record -> nonce_column)
                OR (new_record -> ciphertext_column) IS DISTINCT FROM (old_record -> ciphertext_column)
                OR NEW.content_storage_format IS DISTINCT FROM OLD.content_storage_format;
        END IF;
    END LOOP;

    IF direct_metadata_changed THEN
        RAISE EXCEPTION 'encrypted content metadata is not directly writable'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND NOT content_changed THEN
        IF current_mode = 'strict' AND OLD.content_storage_format <> 'encrypted-v1' THEN
            RAISE EXCEPTION 'legacy user content is forbidden in strict mode'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF current_mode = 'legacy' THEN
        IF writer_mode = 'encrypted-v1' THEN
            RAISE EXCEPTION 'encrypted writer is not enabled'
                USING ERRCODE = '23514';
        END IF;
        NEW.content_storage_format := 'legacy';
        RETURN NEW;
    END IF;
    IF writer_mode <> 'encrypted-v1' THEN
        RAISE EXCEPTION 'plaintext content writer is disabled'
            USING ERRCODE = '23514';
    END IF;

    FOR index_value IN 0..TG_NARGS - 1 LOOP
        field_name := TG_ARGV[index_value];
        dek_column := field_name || '_dek_version';
        revision_column := field_name || '_crypto_revision';
        nonce_column := field_name || '_nonce';
        ciphertext_column := field_name || '_ciphertext';
        plaintext := new_record ->> field_name;

        IF TG_OP = 'UPDATE'
           AND (new_record -> field_name) IS NOT DISTINCT FROM (old_record -> field_name) THEN
            IF OLD.content_storage_format = 'legacy' AND plaintext IS NOT NULL THEN
                RAISE EXCEPTION 'legacy row content update must migrate every populated field'
                    USING ERRCODE = '23514';
            END IF;
            CONTINUE;
        END IF;

        IF plaintext IS NULL THEN
            patch := patch || jsonb_build_object(
                dek_column, NULL,
                revision_column, NULL,
                nonce_column, NULL,
                ciphertext_column, NULL
            );
            CONTINUE;
        END IF;
        IF plaintext NOT LIKE '~fukamu-cycle-content-write-v1~%' THEN
            RAISE EXCEPTION 'encrypted content marker is missing'
                USING ERRCODE = '23514';
        END IF;
        BEGIN
            marker := substring(plaintext FROM 32)::jsonb;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'encrypted content marker is invalid'
                USING ERRCODE = '23514';
        END;
        IF marker ->> 'format' <> 'fukamu-cycle-field-aes-256-gcm/v1'
           OR marker ->> 'algorithm' <> 'A256GCM'
           OR (marker ->> 'dekVersion') !~ '^[1-9][0-9]*$'
           OR (marker ->> 'cryptoRevision') !~ '^[1-9][0-9]*$'
           OR marker ->> 'nonce' IS NULL
           OR marker ->> 'sealedPayload' IS NULL THEN
            RAISE EXCEPTION 'encrypted content marker fields are invalid'
                USING ERRCODE = '23514';
        END IF;
        BEGIN
            patch := patch || jsonb_build_object(
                field_name, NULL,
                dek_column, (marker ->> 'dekVersion')::INTEGER,
                revision_column, (marker ->> 'cryptoRevision')::BIGINT,
                nonce_column, decode(marker ->> 'nonce', 'base64'),
                ciphertext_column, decode(marker ->> 'sealedPayload', 'base64')
            );
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'encrypted content marker encoding is invalid'
                USING ERRCODE = '23514';
        END;
    END LOOP;
    patch := patch || jsonb_build_object('content_storage_format', 'encrypted-v1');
    NEW := jsonb_populate_record(NEW, patch);
    RETURN NEW;
END;
$$;

ALTER TABLE public.goal_versions
    ALTER COLUMN body DROP NOT NULL,
    ADD COLUMN content_storage_format TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN body_dek_version INTEGER NULL,
    ADD COLUMN body_crypto_revision BIGINT NULL,
    ADD COLUMN body_nonce BYTEA NULL,
    ADD COLUMN body_ciphertext BYTEA NULL,
    ADD CONSTRAINT goal_versions_body_storage CHECK (
      (content_storage_format = 'legacy'
       AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 80
       AND body_dek_version IS NULL AND body_crypto_revision IS NULL
       AND body_nonce IS NULL AND body_ciphertext IS NULL)
      OR
      (content_storage_format = 'encrypted-v1' AND body IS NULL
       AND public.fukamu_cycle_encrypted_field_valid(
         body_dek_version, body_crypto_revision, body_nonce, body_ciphertext))
    );

ALTER TABLE public.goal_drafts
    ALTER COLUMN body DROP NOT NULL,
    ADD COLUMN content_storage_format TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN body_dek_version INTEGER NULL,
    ADD COLUMN body_crypto_revision BIGINT NULL,
    ADD COLUMN body_nonce BYTEA NULL,
    ADD COLUMN body_ciphertext BYTEA NULL,
    ADD CONSTRAINT goal_drafts_body_storage CHECK (
      (content_storage_format = 'legacy'
       AND body IS NOT NULL AND char_length(body) <= 80
       AND body_dek_version IS NULL AND body_crypto_revision IS NULL
       AND body_nonce IS NULL AND body_ciphertext IS NULL)
      OR
      (content_storage_format = 'encrypted-v1' AND body IS NULL
       AND public.fukamu_cycle_encrypted_field_valid(
         body_dek_version, body_crypto_revision, body_nonce, body_ciphertext))
    );

ALTER TABLE public.goal_version_success_signals
    ALTER COLUMN success_signal DROP NOT NULL,
    ADD COLUMN content_storage_format TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN success_signal_dek_version INTEGER NULL,
    ADD COLUMN success_signal_crypto_revision BIGINT NULL,
    ADD COLUMN success_signal_nonce BYTEA NULL,
    ADD COLUMN success_signal_ciphertext BYTEA NULL,
    ADD CONSTRAINT goal_version_success_signals_storage CHECK (
      (content_storage_format = 'legacy'
       AND success_signal IS NOT NULL AND char_length(success_signal) BETWEEN 1 AND 120
       AND success_signal_dek_version IS NULL AND success_signal_crypto_revision IS NULL
       AND success_signal_nonce IS NULL AND success_signal_ciphertext IS NULL)
      OR
      (content_storage_format = 'encrypted-v1' AND success_signal IS NULL
       AND public.fukamu_cycle_encrypted_field_valid(
         success_signal_dek_version, success_signal_crypto_revision,
         success_signal_nonce, success_signal_ciphertext))
    );

ALTER TABLE public.goal_draft_success_signals
    ALTER COLUMN success_signal DROP NOT NULL,
    ADD COLUMN content_storage_format TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN success_signal_dek_version INTEGER NULL,
    ADD COLUMN success_signal_crypto_revision BIGINT NULL,
    ADD COLUMN success_signal_nonce BYTEA NULL,
    ADD COLUMN success_signal_ciphertext BYTEA NULL,
    ADD CONSTRAINT goal_draft_success_signals_storage CHECK (
      (content_storage_format = 'legacy'
       AND success_signal IS NOT NULL AND char_length(success_signal) BETWEEN 1 AND 120
       AND success_signal_dek_version IS NULL AND success_signal_crypto_revision IS NULL
       AND success_signal_nonce IS NULL AND success_signal_ciphertext IS NULL)
      OR
      (content_storage_format = 'encrypted-v1' AND success_signal IS NULL
       AND public.fukamu_cycle_encrypted_field_valid(
         success_signal_dek_version, success_signal_crypto_revision,
         success_signal_nonce, success_signal_ciphertext))
    );

ALTER TABLE public.pdca_cycles
    ALTER COLUMN plan DROP NOT NULL,
    ALTER COLUMN do_text DROP NOT NULL,
    ALTER COLUMN check_text DROP NOT NULL,
    ALTER COLUMN action DROP NOT NULL,
    ADD COLUMN content_storage_format TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN plan_dek_version INTEGER NULL,
    ADD COLUMN plan_crypto_revision BIGINT NULL,
    ADD COLUMN plan_nonce BYTEA NULL,
    ADD COLUMN plan_ciphertext BYTEA NULL,
    ADD COLUMN do_text_dek_version INTEGER NULL,
    ADD COLUMN do_text_crypto_revision BIGINT NULL,
    ADD COLUMN do_text_nonce BYTEA NULL,
    ADD COLUMN do_text_ciphertext BYTEA NULL,
    ADD COLUMN check_text_dek_version INTEGER NULL,
    ADD COLUMN check_text_crypto_revision BIGINT NULL,
    ADD COLUMN check_text_nonce BYTEA NULL,
    ADD COLUMN check_text_ciphertext BYTEA NULL,
    ADD COLUMN action_dek_version INTEGER NULL,
    ADD COLUMN action_crypto_revision BIGINT NULL,
    ADD COLUMN action_nonce BYTEA NULL,
    ADD COLUMN action_ciphertext BYTEA NULL,
    ADD CONSTRAINT pdca_cycles_content_storage CHECK (
      (content_storage_format = 'legacy'
       AND plan IS NOT NULL
       AND do_text IS NOT NULL
       AND check_text IS NOT NULL
       AND action IS NOT NULL
       AND plan_dek_version IS NULL AND plan_crypto_revision IS NULL AND plan_nonce IS NULL AND plan_ciphertext IS NULL
       AND do_text_dek_version IS NULL AND do_text_crypto_revision IS NULL AND do_text_nonce IS NULL AND do_text_ciphertext IS NULL
       AND check_text_dek_version IS NULL AND check_text_crypto_revision IS NULL AND check_text_nonce IS NULL AND check_text_ciphertext IS NULL
       AND action_dek_version IS NULL AND action_crypto_revision IS NULL AND action_nonce IS NULL AND action_ciphertext IS NULL)
      OR
      (content_storage_format = 'encrypted-v1'
       AND plan IS NULL AND do_text IS NULL AND check_text IS NULL AND action IS NULL
       AND public.fukamu_cycle_encrypted_field_valid(plan_dek_version, plan_crypto_revision, plan_nonce, plan_ciphertext)
       AND public.fukamu_cycle_encrypted_field_valid(do_text_dek_version, do_text_crypto_revision, do_text_nonce, do_text_ciphertext)
       AND public.fukamu_cycle_encrypted_field_valid(check_text_dek_version, check_text_crypto_revision, check_text_nonce, check_text_ciphertext)
       AND public.fukamu_cycle_encrypted_field_valid(action_dek_version, action_crypto_revision, action_nonce, action_ciphertext))
    );

ALTER TABLE public.ai_generations
    DROP CONSTRAINT ai_generations_check1,
    DROP CONSTRAINT ai_generations_source_text_tight_limit,
    DROP CONSTRAINT ai_generations_output_tight_limit,
    ADD COLUMN content_storage_format TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN source_text_dek_version INTEGER NULL,
    ADD COLUMN source_text_crypto_revision BIGINT NULL,
    ADD COLUMN source_text_nonce BYTEA NULL,
    ADD COLUMN source_text_ciphertext BYTEA NULL,
    ADD COLUMN output_dek_version INTEGER NULL,
    ADD COLUMN output_crypto_revision BIGINT NULL,
    ADD COLUMN output_nonce BYTEA NULL,
    ADD COLUMN output_ciphertext BYTEA NULL,
    ADD COLUMN canonical_provider_input_hash_dek_version INTEGER NULL,
    ADD COLUMN canonical_provider_input_hash_crypto_revision BIGINT NULL,
    ADD COLUMN canonical_provider_input_hash_nonce BYTEA NULL,
    ADD COLUMN canonical_provider_input_hash_ciphertext BYTEA NULL,
    ADD CONSTRAINT ai_generations_content_storage CHECK (
      (content_storage_format = 'legacy'
       AND source_text_dek_version IS NULL AND source_text_crypto_revision IS NULL AND source_text_nonce IS NULL AND source_text_ciphertext IS NULL
       AND output_dek_version IS NULL AND output_crypto_revision IS NULL AND output_nonce IS NULL AND output_ciphertext IS NULL
       AND canonical_provider_input_hash_dek_version IS NULL AND canonical_provider_input_hash_crypto_revision IS NULL
       AND canonical_provider_input_hash_nonce IS NULL AND canonical_provider_input_hash_ciphertext IS NULL)
      OR
      (content_storage_format = 'encrypted-v1'
       AND source_text IS NULL AND output IS NULL AND canonical_provider_input_hash IS NULL
       AND ((source_text_dek_version IS NULL AND source_text_crypto_revision IS NULL AND source_text_nonce IS NULL AND source_text_ciphertext IS NULL)
            OR public.fukamu_cycle_encrypted_field_valid(source_text_dek_version, source_text_crypto_revision, source_text_nonce, source_text_ciphertext))
       AND ((output_dek_version IS NULL AND output_crypto_revision IS NULL AND output_nonce IS NULL AND output_ciphertext IS NULL)
            OR public.fukamu_cycle_encrypted_field_valid(output_dek_version, output_crypto_revision, output_nonce, output_ciphertext))
       AND ((canonical_provider_input_hash_dek_version IS NULL AND canonical_provider_input_hash_crypto_revision IS NULL
             AND canonical_provider_input_hash_nonce IS NULL AND canonical_provider_input_hash_ciphertext IS NULL)
            OR public.fukamu_cycle_encrypted_field_valid(
                canonical_provider_input_hash_dek_version,
                canonical_provider_input_hash_crypto_revision,
                canonical_provider_input_hash_nonce,
                canonical_provider_input_hash_ciphertext)))
    ),
    ADD CONSTRAINT ai_generations_source_text_tight_limit CHECK (
      content_storage_format = 'encrypted-v1'
      OR (operation_type = 'action_generate' AND source_text IS NULL)
      OR (operation_type = 'goal_refine' AND source_text IS NOT NULL AND char_length(source_text) <= 80)
      OR (operation_type = 'action_refine' AND source_text IS NOT NULL AND char_length(source_text) <= 200)
    ),
    ADD CONSTRAINT ai_generations_output_tight_limit CHECK (
      content_storage_format = 'encrypted-v1'
      OR output IS NULL
      OR (operation_type = 'goal_refine' AND char_length(output) <= 80)
      OR (operation_type IN ('action_generate','action_refine') AND char_length(output) <= 200)
    ),
    ADD CONSTRAINT ai_generations_output_state_storage CHECK (
      (status = 'running'
       AND output IS NULL AND output_ciphertext IS NULL
       AND failure_code IS NULL)
      OR
      (status = 'succeeded'
       AND failure_code IS NULL
       AND (
         (content_storage_format = 'legacy' AND output IS NOT NULL)
         OR (content_storage_format = 'encrypted-v1' AND output_ciphertext IS NOT NULL)
       ))
      OR
      (status = 'failed'
       AND output IS NULL AND output_ciphertext IS NULL
       AND failure_code IS NOT NULL)
    );

CREATE TRIGGER trg_00_goal_versions_content_storage
BEFORE INSERT OR UPDATE ON public.goal_versions
FOR EACH ROW EXECUTE FUNCTION public.fukamu_cycle_apply_content_storage('body');
CREATE TRIGGER trg_00_goal_drafts_content_storage
BEFORE INSERT OR UPDATE ON public.goal_drafts
FOR EACH ROW EXECUTE FUNCTION public.fukamu_cycle_apply_content_storage('body');
CREATE TRIGGER trg_00_goal_version_signals_content_storage
BEFORE INSERT OR UPDATE ON public.goal_version_success_signals
FOR EACH ROW EXECUTE FUNCTION public.fukamu_cycle_apply_content_storage('success_signal');
CREATE TRIGGER trg_00_goal_draft_signals_content_storage
BEFORE INSERT OR UPDATE ON public.goal_draft_success_signals
FOR EACH ROW EXECUTE FUNCTION public.fukamu_cycle_apply_content_storage('success_signal');
CREATE TRIGGER trg_00_pdca_cycles_content_storage
BEFORE INSERT OR UPDATE ON public.pdca_cycles
FOR EACH ROW EXECUTE FUNCTION public.fukamu_cycle_apply_content_storage('plan','do_text','check_text','action');
CREATE TRIGGER trg_00_ai_generations_content_storage
BEFORE INSERT OR UPDATE ON public.ai_generations
FOR EACH ROW EXECUTE FUNCTION public.fukamu_cycle_apply_content_storage(
    'source_text','output','canonical_provider_input_hash'
);

CREATE OR REPLACE FUNCTION public.fukamu_cycle_apply_ai_generation_hash_split()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    legacy_writer BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.input_hash IS DISTINCT FROM OLD.input_hash
            OR NEW.idempotency_request_hash IS DISTINCT FROM OLD.idempotency_request_hash THEN
            RAISE EXCEPTION 'AI generation request hashes are immutable'
                USING ERRCODE = '23514';
        END IF;
        IF OLD.content_storage_format = 'legacy'
           AND NEW.content_storage_format = 'legacy'
           AND NEW.canonical_provider_input_hash IS DISTINCT FROM OLD.canonical_provider_input_hash THEN
            RAISE EXCEPTION 'AI generation canonical provider input hash is immutable'
                USING ERRCODE = '23514';
        END IF;
        IF OLD.content_storage_format = 'encrypted-v1'
           AND (
             NEW.canonical_provider_input_hash_dek_version IS DISTINCT FROM OLD.canonical_provider_input_hash_dek_version
             OR NEW.canonical_provider_input_hash_crypto_revision IS DISTINCT FROM OLD.canonical_provider_input_hash_crypto_revision
             OR NEW.canonical_provider_input_hash_nonce IS DISTINCT FROM OLD.canonical_provider_input_hash_nonce
             OR NEW.canonical_provider_input_hash_ciphertext IS DISTINCT FROM OLD.canonical_provider_input_hash_ciphertext
           ) THEN
            RAISE EXCEPTION 'AI generation encrypted canonical provider input hash is immutable'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    legacy_writer := NEW.idempotency_request_hash IS NULL;
    IF NEW.idempotency_request_hash IS NULL THEN
        NEW.idempotency_request_hash := NEW.input_hash;
    END IF;
    IF NEW.input_hash IS NULL THEN
        NEW.input_hash := NEW.idempotency_request_hash;
    END IF;
    IF NEW.input_hash IS NULL OR NEW.input_hash !~ '^[0-9a-f]{64}$'
       OR NEW.idempotency_request_hash IS NULL
       OR NEW.idempotency_request_hash !~ '^[0-9a-f]{64}$'
       OR NEW.input_hash IS DISTINCT FROM NEW.idempotency_request_hash THEN
        RAISE EXCEPTION 'AI generation request hash is invalid'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.content_storage_format = 'legacy' THEN
        IF NEW.canonical_provider_input_hash IS NOT NULL
           AND NEW.canonical_provider_input_hash !~ '^[0-9a-f]{64}$' THEN
            RAISE EXCEPTION 'AI generation canonical provider input hash is invalid'
                USING ERRCODE = '23514';
        END IF;
        IF NOT legacy_writer AND NEW.canonical_provider_input_hash IS NULL THEN
            RAISE EXCEPTION 'new AI generation is missing canonical provider input hash'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.content_storage_format = 'encrypted-v1' THEN
        IF NOT legacy_writer
           AND NEW.canonical_provider_input_hash_ciphertext IS NULL THEN
            RAISE EXCEPTION 'new encrypted AI generation is missing canonical provider input hash'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'AI generation content storage format is invalid'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
