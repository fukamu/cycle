BEGIN;

CREATE TABLE public.goal_version_success_signals (
    goal_version_id UUID PRIMARY KEY REFERENCES public.goal_versions(id) ON DELETE CASCADE,
    success_signal TEXT NOT NULL,
    CONSTRAINT goal_version_success_signals_nonempty_max_120
        CHECK (char_length(success_signal) BETWEEN 1 AND 120)
);

CREATE TABLE public.goal_draft_success_signals (
    goal_draft_id UUID PRIMARY KEY REFERENCES public.goal_drafts(id) ON DELETE CASCADE,
    success_signal TEXT NOT NULL,
    CONSTRAINT goal_draft_success_signals_nonempty_max_120
        CHECK (char_length(success_signal) BETWEEN 1 AND 120)
);

COMMIT;
