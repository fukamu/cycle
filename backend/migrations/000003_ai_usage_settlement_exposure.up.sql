BEGIN;

ALTER TABLE public.ai_usage_events
    ADD COLUMN settlement_budget_month_utc DATE NULL,
    ADD COLUMN settlement_reservation_cost_usd NUMERIC(14,8) NULL;

UPDATE public.ai_usage_events AS usage
SET settlement_budget_month_utc = generation.budget_month_utc,
    settlement_reservation_cost_usd = generation.budget_reserved_cost_usd
FROM public.ai_generations AS generation
WHERE usage.operation_id = generation.id
  AND usage.user_id = generation.user_id
  AND usage.provider_usage_finalized_at IS NULL
  AND generation.status = 'running';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.ai_usage_events
        WHERE provider_usage_finalized_at IS NULL
          AND (
              settlement_budget_month_utc IS NULL
              OR settlement_reservation_cost_usd IS NULL
          )
    ) THEN
        RAISE EXCEPTION 'unfinalized AI usage settlement exposure cannot be reconstructed'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE FUNCTION public.fukamu_cycle_apply_ai_usage_settlement_exposure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    generation_month DATE;
    generation_reservation NUMERIC(14,8);
BEGIN
    IF TG_OP = 'UPDATE'
        AND (
            NEW.operation_id IS DISTINCT FROM OLD.operation_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
        ) THEN
        RAISE EXCEPTION 'AI usage settlement identity is immutable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.provider_usage_finalized_at IS NOT NULL THEN
        NEW.settlement_budget_month_utc := NULL;
        NEW.settlement_reservation_cost_usd := NULL;
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT budget_month_utc, budget_reserved_cost_usd
        INTO generation_month, generation_reservation
        FROM public.ai_generations
        WHERE id = NEW.operation_id
          AND user_id = NEW.user_id
          AND status = 'running';

        IF NOT FOUND THEN
            RAISE EXCEPTION 'unfinalized AI usage requires a running generation exposure'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.settlement_budget_month_utc IS NULL THEN
            NEW.settlement_budget_month_utc := generation_month;
        ELSIF NEW.settlement_budget_month_utc <> generation_month THEN
            RAISE EXCEPTION 'AI usage settlement budget month does not match generation'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.settlement_reservation_cost_usd IS NULL THEN
            NEW.settlement_reservation_cost_usd := generation_reservation;
        ELSIF NEW.settlement_reservation_cost_usd <> generation_reservation THEN
            RAISE EXCEPTION 'AI usage settlement reservation does not match generation'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NEW.settlement_budget_month_utc IS NULL
            OR NEW.settlement_reservation_cost_usd IS NULL THEN
            RAISE EXCEPTION 'unfinalized AI usage settlement exposure is incomplete'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.settlement_budget_month_utc IS DISTINCT FROM OLD.settlement_budget_month_utc
            OR NEW.settlement_reservation_cost_usd IS DISTINCT FROM OLD.settlement_reservation_cost_usd THEN
            RAISE EXCEPTION 'unfinalized AI usage settlement exposure is immutable'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_usage_settlement_exposure
BEFORE INSERT OR UPDATE OF operation_id, user_id, provider_usage_finalized_at, settlement_budget_month_utc, settlement_reservation_cost_usd
ON public.ai_usage_events
FOR EACH ROW
EXECUTE FUNCTION public.fukamu_cycle_apply_ai_usage_settlement_exposure();

ALTER TABLE public.ai_usage_events
    ADD CONSTRAINT ai_usage_events_settlement_exposure
    CHECK (
        (
            provider_usage_finalized_at IS NULL
            AND settlement_budget_month_utc IS NOT NULL
            AND settlement_reservation_cost_usd IS NOT NULL
            AND settlement_reservation_cost_usd >= 0
        )
        OR
        (
            provider_usage_finalized_at IS NOT NULL
            AND settlement_budget_month_utc IS NULL
            AND settlement_reservation_cost_usd IS NULL
        )
    )
    NOT VALID;

ALTER TABLE public.ai_usage_events
    VALIDATE CONSTRAINT ai_usage_events_settlement_exposure;

CREATE FUNCTION public.fukamu_cycle_guard_user_delete_ai_usage_exposure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.ai_usage_events AS usage
        WHERE usage.user_id = OLD.id
          AND usage.provider_usage_finalized_at IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM public.ai_generations AS generation
              WHERE generation.id = usage.operation_id
                AND generation.user_id = usage.user_id
                AND generation.status = 'running'
          )
    ) THEN
        RAISE EXCEPTION 'account delete cannot discard unsettled AI usage exposure'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER trg_user_delete_ai_usage_exposure
BEFORE DELETE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.fukamu_cycle_guard_user_delete_ai_usage_exposure();

COMMIT;
