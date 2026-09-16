BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.goal_version_success_signals)
       OR EXISTS (SELECT 1 FROM public.goal_draft_success_signals) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'cannot remove goal success signal storage while data exists';
    END IF;
END
$$;

DROP TABLE public.goal_draft_success_signals;
DROP TABLE public.goal_version_success_signals;

COMMIT;
