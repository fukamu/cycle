BEGIN;

ALTER TABLE goal_delete_receipts
    DROP CONSTRAINT goal_delete_receipts_idempotency_key_uuid_v7,
    DROP CONSTRAINT goal_delete_receipts_deleted_goal_id_uuid_v7;

ALTER TABLE ai_usage_events
    DROP CONSTRAINT ai_usage_events_operation_id_uuid_v7;

ALTER TABLE ai_generations
    DROP CONSTRAINT ai_generations_id_uuid_v7,
    DROP CONSTRAINT ai_generations_idempotency_key_uuid_v7,
    DROP CONSTRAINT ai_generations_context_cycle_ids_uuid_v7;

ALTER TABLE goal_drafts
    DROP CONSTRAINT goal_drafts_id_uuid_v7;

ALTER TABLE pdca_cycles
    DROP CONSTRAINT pdca_cycles_id_uuid_v7,
    DROP CONSTRAINT pdca_cycles_start_operation_id_uuid_v7,
    DROP CONSTRAINT pdca_cycles_completion_operation_id_uuid_v7;

ALTER TABLE goal_versions
    DROP CONSTRAINT goal_versions_id_uuid_v7,
    DROP CONSTRAINT goal_versions_created_by_operation_id_uuid_v7;

ALTER TABLE goals
    DROP CONSTRAINT goals_id_uuid_v7,
    DROP CONSTRAINT goals_terminal_operation_id_uuid_v7;

ALTER TABLE sessions
    DROP CONSTRAINT sessions_id_uuid_v7;

ALTER TABLE auth_identities
    DROP CONSTRAINT auth_identities_id_uuid_v7;

ALTER TABLE users
    DROP CONSTRAINT users_id_uuid_v7;

DROP FUNCTION pdcai_uuid_array_is_v7(UUID[]);
DROP FUNCTION pdcai_uuid_is_v7(UUID);

COMMIT;
