BEGIN;

CREATE TABLE public.pdca_cycle_review_schedules (
    cycle_id UUID PRIMARY KEY REFERENCES public.pdca_cycles(id) ON DELETE CASCADE,
    review_date DATE NULL,
    review_schedule_revision BIGINT NOT NULL CHECK (review_schedule_revision >= 0),
    CHECK (
      review_date IS NULL
      OR review_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    ),
    CHECK (review_schedule_revision > 0 OR review_date IS NULL)
);

COMMIT;
