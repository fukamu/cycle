BEGIN;

ALTER TABLE public.pdca_cycles
    DROP CONSTRAINT pdca_cycles_cancellation_reason_check;

ALTER TABLE public.pdca_cycles
    ADD CONSTRAINT pdca_cycles_cancellation_reason_check
    CHECK (
        cancellation_reason IS NULL
        OR cancellation_reason IN ('goal_achieved', 'goal_ended', 'replanned')
    );

COMMIT;
