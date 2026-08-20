BEGIN;

CREATE FUNCTION pdcai_uuid_is_v7(value UUID)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT (get_byte(uuid_send(value), 6) >> 4) = 7
       AND (get_byte(uuid_send(value), 8) >> 6) = 2
$$;

CREATE FUNCTION pdcai_uuid_array_is_v7(items UUID[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT COALESCE(bool_and(value IS NOT NULL AND pdcai_uuid_is_v7(value)), TRUE)
    FROM unnest(items) AS value
$$;

ALTER TABLE users
    ADD CONSTRAINT users_id_uuid_v7 CHECK (pdcai_uuid_is_v7(id));

ALTER TABLE auth_identities
    ADD CONSTRAINT auth_identities_id_uuid_v7 CHECK (pdcai_uuid_is_v7(id));

ALTER TABLE sessions
    ADD CONSTRAINT sessions_id_uuid_v7 CHECK (pdcai_uuid_is_v7(id));

ALTER TABLE goals
    ADD CONSTRAINT goals_id_uuid_v7 CHECK (pdcai_uuid_is_v7(id)),
    ADD CONSTRAINT goals_terminal_operation_id_uuid_v7 CHECK (pdcai_uuid_is_v7(terminal_operation_id));

ALTER TABLE goal_versions
    ADD CONSTRAINT goal_versions_id_uuid_v7 CHECK (pdcai_uuid_is_v7(id)),
    ADD CONSTRAINT goal_versions_created_by_operation_id_uuid_v7 CHECK (pdcai_uuid_is_v7(created_by_operation_id));

ALTER TABLE pdca_cycles
    ADD CONSTRAINT pdca_cycles_id_uuid_v7 CHECK (pdcai_uuid_is_v7(id)),
    ADD CONSTRAINT pdca_cycles_start_operation_id_uuid_v7 CHECK (pdcai_uuid_is_v7(start_operation_id)),
    ADD CONSTRAINT pdca_cycles_completion_operation_id_uuid_v7 CHECK (pdcai_uuid_is_v7(completion_operation_id));

ALTER TABLE goal_drafts
    ADD CONSTRAINT goal_drafts_id_uuid_v7 CHECK (pdcai_uuid_is_v7(id));

ALTER TABLE ai_generations
    ADD CONSTRAINT ai_generations_id_uuid_v7 CHECK (pdcai_uuid_is_v7(id)),
    ADD CONSTRAINT ai_generations_idempotency_key_uuid_v7 CHECK (pdcai_uuid_is_v7(idempotency_key)),
    ADD CONSTRAINT ai_generations_context_cycle_ids_uuid_v7 CHECK (pdcai_uuid_array_is_v7(context_cycle_ids));

ALTER TABLE ai_usage_events
    ADD CONSTRAINT ai_usage_events_operation_id_uuid_v7 CHECK (pdcai_uuid_is_v7(operation_id));

ALTER TABLE goal_delete_receipts
    ADD CONSTRAINT goal_delete_receipts_idempotency_key_uuid_v7 CHECK (pdcai_uuid_is_v7(idempotency_key)),
    ADD CONSTRAINT goal_delete_receipts_deleted_goal_id_uuid_v7 CHECK (pdcai_uuid_is_v7(deleted_goal_id));

COMMIT;
