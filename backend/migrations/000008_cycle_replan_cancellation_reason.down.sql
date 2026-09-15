BEGIN;

DO $migration$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.pdca_cycles
        WHERE cancellation_reason = 'replanned'
    ) THEN
        RAISE EXCEPTION 'cannot remove replanned cancellation reason while rows still use it'
            USING ERRCODE = '23514';
    END IF;
END
$migration$;

ALTER TABLE public.pdca_cycles
    DROP CONSTRAINT pdca_cycles_cancellation_reason_check;

ALTER TABLE public.pdca_cycles
    ADD CONSTRAINT pdca_cycles_cancellation_reason_check
    CHECK (
        cancellation_reason IS NULL
        OR cancellation_reason IN ('goal_achieved', 'goal_ended')
    );

COMMIT;
