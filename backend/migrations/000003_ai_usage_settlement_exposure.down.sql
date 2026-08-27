BEGIN;

DROP TRIGGER trg_user_delete_ai_usage_exposure ON public.users;

DROP FUNCTION public.fukamu_cycle_guard_user_delete_ai_usage_exposure();

ALTER TABLE public.ai_usage_events
    DROP CONSTRAINT ai_usage_events_settlement_exposure;

DROP TRIGGER trg_ai_usage_settlement_exposure ON public.ai_usage_events;

DROP FUNCTION public.fukamu_cycle_apply_ai_usage_settlement_exposure();

ALTER TABLE public.ai_usage_events
    DROP COLUMN settlement_budget_month_utc,
    DROP COLUMN settlement_reservation_cost_usd;

COMMIT;
