BEGIN;

ALTER TABLE public.ai_generations
    DROP CONSTRAINT ai_generations_hash_split;

DROP TRIGGER trg_ai_generation_hash_split ON public.ai_generations;

DROP FUNCTION public.fukamu_cycle_apply_ai_generation_hash_split();

ALTER TABLE public.ai_generations
    DROP COLUMN canonical_provider_input_hash,
    DROP COLUMN idempotency_request_hash;

COMMIT;
