BEGIN;

ALTER TABLE public.ai_generations
    ADD COLUMN idempotency_request_hash TEXT NULL,
    ADD COLUMN canonical_provider_input_hash TEXT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.ai_generations
        WHERE input_hash IS NULL
           OR input_hash !~ '^[0-9a-f]{64}$'
    ) THEN
        RAISE EXCEPTION 'legacy AI generation request hash is invalid'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

UPDATE public.ai_generations
SET idempotency_request_hash = input_hash;

CREATE FUNCTION public.fukamu_cycle_apply_ai_generation_hash_split()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    legacy_writer BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.input_hash IS DISTINCT FROM OLD.input_hash
            OR NEW.idempotency_request_hash IS DISTINCT FROM OLD.idempotency_request_hash
            OR NEW.canonical_provider_input_hash IS DISTINCT FROM OLD.canonical_provider_input_hash THEN
            RAISE EXCEPTION 'AI generation hashes are immutable'
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

    IF NEW.input_hash IS NULL
        OR NEW.input_hash !~ '^[0-9a-f]{64}$'
        OR NEW.idempotency_request_hash IS NULL
        OR NEW.idempotency_request_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'AI generation request hash is invalid'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.input_hash IS DISTINCT FROM NEW.idempotency_request_hash THEN
        RAISE EXCEPTION 'AI generation request hash aliases disagree'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.canonical_provider_input_hash IS NOT NULL
        AND NEW.canonical_provider_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'AI generation canonical provider input hash is invalid'
            USING ERRCODE = '23514';
    END IF;
    IF NOT legacy_writer AND NEW.canonical_provider_input_hash IS NULL THEN
        RAISE EXCEPTION 'new AI generation is missing canonical provider input hash'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_generation_hash_split
BEFORE INSERT OR UPDATE OF input_hash, idempotency_request_hash, canonical_provider_input_hash
ON public.ai_generations
FOR EACH ROW
EXECUTE FUNCTION public.fukamu_cycle_apply_ai_generation_hash_split();

ALTER TABLE public.ai_generations
    ALTER COLUMN idempotency_request_hash SET NOT NULL,
    ADD CONSTRAINT ai_generations_hash_split
    CHECK (
        input_hash = idempotency_request_hash
        AND input_hash ~ '^[0-9a-f]{64}$'
        AND idempotency_request_hash ~ '^[0-9a-f]{64}$'
        AND (
            canonical_provider_input_hash IS NULL
            OR canonical_provider_input_hash ~ '^[0-9a-f]{64}$'
        )
    )
    NOT VALID;

ALTER TABLE public.ai_generations
    VALIDATE CONSTRAINT ai_generations_hash_split;

COMMENT ON COLUMN public.ai_generations.input_hash IS
    'Temporary rollback alias of idempotency_request_hash; remove in a later contract migration.';
COMMENT ON COLUMN public.ai_generations.idempotency_request_hash IS
    'Immutable request replay identity.';
COMMENT ON COLUMN public.ai_generations.canonical_provider_input_hash IS
    'Immutable canonical provider input identity; NULL only for pre-split records and rollback-window legacy-writer inserts.';

COMMIT;
