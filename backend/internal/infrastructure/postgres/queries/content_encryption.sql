-- name: GetContentEncryptionMode :one
SELECT mode
FROM content_encryption_control
WHERE singleton = TRUE;

-- name: GetContentEncryptionState :one
SELECT mode, generation
FROM content_encryption_control
WHERE singleton = TRUE;

-- name: LockContentEncryptionControl :one
SELECT mode, generation
FROM content_encryption_control
WHERE singleton = TRUE
FOR UPDATE;

-- name: SetContentEncryptionModeCAS :execrows
UPDATE content_encryption_control
SET mode = sqlc.arg(new_mode)::text,
    generation = generation + 1,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE singleton = TRUE
  AND mode = sqlc.arg(expected_mode)::text
  AND generation = sqlc.arg(expected_generation)::bigint;

-- name: SetEncryptedContentWriter :one
SELECT set_config('fukamu_cycle.content_writer', 'encrypted-v1', TRUE)::text;

-- name: CreateContentEncryptionJob :execrows
INSERT INTO content_encryption_jobs (
    id, operation, status, phase, started_at, updated_at
) VALUES (
    sqlc.arg(id)::uuid,
    sqlc.arg(operation)::text,
    'running',
    sqlc.arg(phase)::text,
    sqlc.arg(started_at)::timestamptz,
    sqlc.arg(started_at)::timestamptz
);

-- name: UpdateContentEncryptionJobProgress :execrows
UPDATE content_encryption_jobs
SET phase = sqlc.arg(phase)::text,
    processed_count = processed_count + sqlc.arg(processed_delta)::bigint,
    conflict_count = conflict_count + sqlc.arg(conflict_delta)::bigint,
    failure_count = failure_count + sqlc.arg(failure_delta)::bigint,
    updated_at = sqlc.arg(updated_at)::timestamptz
WHERE id = sqlc.arg(id)::uuid
  AND status = 'running';

-- name: FinishContentEncryptionJob :execrows
UPDATE content_encryption_jobs
SET status = sqlc.arg(status)::text,
    phase = sqlc.arg(phase)::text,
    updated_at = sqlc.arg(completed_at)::timestamptz,
    completed_at = sqlc.arg(completed_at)::timestamptz
WHERE id = sqlc.arg(id)::uuid
  AND status = 'running'
  AND sqlc.arg(status)::text IN ('completed','failed');

-- name: GetActiveUserContentDEK :one
SELECT user_id, dek_version, kek_key_version, wrapped_dek, created_at
FROM user_content_deks
WHERE user_id = sqlc.arg(user_id)::uuid
  AND is_write_key = TRUE;

-- name: LockUserForContentKey :one
SELECT id
FROM users
WHERE id = sqlc.arg(user_id)::uuid
FOR UPDATE;

-- name: GetUserContentDEK :one
SELECT user_id, dek_version, kek_key_version, wrapped_dek, is_write_key, created_at
FROM user_content_deks
WHERE user_id = sqlc.arg(user_id)::uuid
  AND dek_version = sqlc.arg(dek_version)::integer;

-- name: GetNextUserContentDEKVersion :one
SELECT COALESCE(MAX(dek_version), 0)::integer + 1 AS next_version
FROM user_content_deks
WHERE user_id = sqlc.arg(user_id)::uuid;

-- name: InsertUserContentDEK :execrows
INSERT INTO user_content_deks (
    user_id, dek_version, kek_key_version, wrapped_dek, is_write_key, created_at
) VALUES (
    sqlc.arg(user_id)::uuid,
    sqlc.arg(dek_version)::integer,
    sqlc.arg(kek_key_version)::text,
    sqlc.arg(wrapped_dek)::bytea,
    sqlc.arg(is_write_key)::boolean,
    sqlc.arg(created_at)::timestamptz
)
ON CONFLICT (user_id, dek_version) DO NOTHING;

-- name: DemoteUserContentWriteDEK :execrows
UPDATE user_content_deks
SET is_write_key = FALSE
WHERE user_id = sqlc.arg(user_id)::uuid
  AND is_write_key = TRUE;

-- name: PromoteUserContentWriteDEK :execrows
UPDATE user_content_deks
SET is_write_key = TRUE
WHERE user_id = sqlc.arg(user_id)::uuid
  AND dek_version = sqlc.arg(dek_version)::integer
  AND is_write_key = FALSE;

-- name: ReserveUserContentNonce :execrows
INSERT INTO user_content_nonce_reservations(user_id, dek_version, nonce, created_at)
VALUES (
    sqlc.arg(user_id)::uuid,
    sqlc.arg(dek_version)::integer,
    sqlc.arg(nonce)::bytea,
    sqlc.arg(created_at)::timestamptz
)
ON CONFLICT DO NOTHING;

-- name: UserHasEncryptedContent :one
SELECT (
    EXISTS (SELECT 1 FROM goal_versions WHERE user_id = sqlc.arg(user_id)::uuid AND content_storage_format = 'encrypted-v1')
    OR EXISTS (SELECT 1 FROM goal_drafts WHERE user_id = sqlc.arg(user_id)::uuid AND content_storage_format = 'encrypted-v1')
    OR EXISTS (
      SELECT 1 FROM goal_version_success_signals signal
      JOIN goal_versions version ON version.id = signal.goal_version_id
      WHERE version.user_id = sqlc.arg(user_id)::uuid AND signal.content_storage_format = 'encrypted-v1'
    )
    OR EXISTS (
      SELECT 1 FROM goal_draft_success_signals signal
      JOIN goal_drafts draft ON draft.id = signal.goal_draft_id
      WHERE draft.user_id = sqlc.arg(user_id)::uuid AND signal.content_storage_format = 'encrypted-v1'
    )
    OR EXISTS (SELECT 1 FROM pdca_cycles WHERE user_id = sqlc.arg(user_id)::uuid AND content_storage_format = 'encrypted-v1')
    OR EXISTS (SELECT 1 FROM ai_generations WHERE user_id = sqlc.arg(user_id)::uuid AND content_storage_format = 'encrypted-v1')
)::boolean AS has_encrypted_content;

-- name: CountLegacyContentRows :one
SELECT (
    (SELECT count(*) FROM goal_versions WHERE content_storage_format = 'legacy')
  + (SELECT count(*) FROM goal_drafts WHERE content_storage_format = 'legacy')
  + (SELECT count(*) FROM goal_version_success_signals WHERE content_storage_format = 'legacy')
  + (SELECT count(*) FROM goal_draft_success_signals WHERE content_storage_format = 'legacy')
  + (SELECT count(*) FROM pdca_cycles WHERE content_storage_format = 'legacy')
  + (SELECT count(*) FROM ai_generations WHERE content_storage_format = 'legacy')
)::bigint AS legacy_count;

-- name: CountRunningAIGenerationsForContentActivation :one
SELECT count(*)::bigint AS running_count
FROM ai_generations
WHERE status = 'running';

-- name: ListContentStorageInventory :many
WITH inventory AS (
  SELECT 'goal_versions'::text resource, content_storage_format FROM goal_versions
  UNION ALL SELECT 'goal_version_success_signals', content_storage_format FROM goal_version_success_signals
  UNION ALL SELECT 'goal_drafts', content_storage_format FROM goal_drafts
  UNION ALL SELECT 'goal_draft_success_signals', content_storage_format FROM goal_draft_success_signals
  UNION ALL SELECT 'pdca_cycles', content_storage_format FROM pdca_cycles
  UNION ALL SELECT 'ai_generations', content_storage_format FROM ai_generations
)
SELECT resource, content_storage_format, count(*)::bigint AS row_count
FROM inventory
GROUP BY resource, content_storage_format
ORDER BY resource, content_storage_format;

-- name: ListContentDEKInventory :many
SELECT dek_version, is_write_key, count(*)::bigint AS key_count
FROM user_content_deks
GROUP BY dek_version, is_write_key
ORDER BY dek_version, is_write_key DESC;

-- name: ListRecentContentEncryptionJobs :many
SELECT operation, status, phase, processed_count, conflict_count, failure_count
FROM content_encryption_jobs
ORDER BY started_at DESC, id DESC
LIMIT 20;

-- name: ListLegacyGoalVersionsForEncryption :many
SELECT id, user_id, body
FROM goal_versions
WHERE content_storage_format = 'legacy'
ORDER BY user_id, id
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: BackfillGoalVersionEncryptionCAS :execrows
UPDATE goal_versions SET body = sqlc.arg(body)::text
WHERE id = sqlc.arg(id)::uuid AND user_id = sqlc.arg(user_id)::uuid
  AND content_storage_format = 'legacy';

-- name: ListLegacyGoalDraftsForEncryption :many
SELECT id, user_id, body, revision
FROM goal_drafts
WHERE content_storage_format = 'legacy'
ORDER BY user_id, id
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: BackfillGoalDraftEncryptionCAS :execrows
UPDATE goal_drafts SET body = sqlc.arg(body)::text
WHERE id = sqlc.arg(id)::uuid AND user_id = sqlc.arg(user_id)::uuid
  AND content_storage_format = 'legacy';

-- name: ListLegacyGoalVersionSignalsForEncryption :many
SELECT signal.goal_version_id, version.user_id, signal.success_signal
FROM goal_version_success_signals signal
JOIN goal_versions version ON version.id = signal.goal_version_id
WHERE signal.content_storage_format = 'legacy'
ORDER BY version.user_id, signal.goal_version_id
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: BackfillGoalVersionSignalEncryptionCAS :execrows
UPDATE goal_version_success_signals SET success_signal = sqlc.arg(success_signal)::text
WHERE goal_version_id = sqlc.arg(goal_version_id)::uuid
  AND content_storage_format = 'legacy';

-- name: ListLegacyGoalDraftSignalsForEncryption :many
SELECT signal.goal_draft_id, draft.user_id, signal.success_signal, draft.revision
FROM goal_draft_success_signals signal
JOIN goal_drafts draft ON draft.id = signal.goal_draft_id
WHERE signal.content_storage_format = 'legacy'
ORDER BY draft.user_id, signal.goal_draft_id
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: BackfillGoalDraftSignalEncryptionCAS :execrows
UPDATE goal_draft_success_signals SET success_signal = sqlc.arg(success_signal)::text
WHERE goal_draft_id = sqlc.arg(goal_draft_id)::uuid
  AND content_storage_format = 'legacy';

-- name: ListLegacyCyclesForEncryption :many
SELECT id, user_id, plan, do_text, check_text, action,
       plan_revision, do_revision, check_revision, action_revision
FROM pdca_cycles
WHERE content_storage_format = 'legacy'
ORDER BY user_id, id
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: BackfillCycleEncryptionCAS :execrows
UPDATE pdca_cycles
SET plan = sqlc.arg(plan)::text,
    do_text = sqlc.arg(do_text)::text,
    check_text = sqlc.arg(check_text)::text,
    action = sqlc.arg(action)::text
WHERE id = sqlc.arg(id)::uuid AND user_id = sqlc.arg(user_id)::uuid
  AND content_storage_format = 'legacy';

-- name: ListLegacyAIGenerationsForEncryption :many
SELECT id, user_id, source_text, output, canonical_provider_input_hash
FROM ai_generations
WHERE content_storage_format = 'legacy'
ORDER BY user_id, id
LIMIT sqlc.arg(fetch_limit)::integer;

-- name: BackfillAIGenerationEncryptionCAS :execrows
UPDATE ai_generations
SET source_text = sqlc.narg(source_text)::text,
    output = sqlc.narg(output)::text,
    canonical_provider_input_hash = sqlc.narg(canonical_provider_input_hash)::text
WHERE id = sqlc.arg(id)::uuid AND user_id = sqlc.arg(user_id)::uuid
  AND content_storage_format = 'legacy';

-- name: ListEncryptedContentForVerification :many
WITH encrypted_fields AS (
  SELECT user_id, 'goal_versions'::text object_type, id object_id, 'body'::text field,
         public.fukamu_cycle_content_read_text(content_storage_format, body, body_dek_version, body_crypto_revision, body_nonce, body_ciphertext) stored
  FROM goal_versions WHERE content_storage_format = 'encrypted-v1'
  UNION ALL
  SELECT version.user_id, 'goal_version_success_signals', signal.goal_version_id, 'success_signal',
         public.fukamu_cycle_content_read_text(signal.content_storage_format, signal.success_signal, signal.success_signal_dek_version, signal.success_signal_crypto_revision, signal.success_signal_nonce, signal.success_signal_ciphertext)
  FROM goal_version_success_signals signal JOIN goal_versions version ON version.id = signal.goal_version_id
  WHERE signal.content_storage_format = 'encrypted-v1'
  UNION ALL
  SELECT user_id, 'goal_drafts', id, 'body',
         public.fukamu_cycle_content_read_text(content_storage_format, body, body_dek_version, body_crypto_revision, body_nonce, body_ciphertext)
  FROM goal_drafts WHERE content_storage_format = 'encrypted-v1'
  UNION ALL
  SELECT draft.user_id, 'goal_draft_success_signals', signal.goal_draft_id, 'success_signal',
         public.fukamu_cycle_content_read_text(signal.content_storage_format, signal.success_signal, signal.success_signal_dek_version, signal.success_signal_crypto_revision, signal.success_signal_nonce, signal.success_signal_ciphertext)
  FROM goal_draft_success_signals signal JOIN goal_drafts draft ON draft.id = signal.goal_draft_id
  WHERE signal.content_storage_format = 'encrypted-v1'
  UNION ALL
  SELECT user_id, 'pdca_cycles', id, field,
         public.fukamu_cycle_content_read_text(content_storage_format, plaintext, dek_version, crypto_revision, nonce, ciphertext)
  FROM pdca_cycles
  CROSS JOIN LATERAL (VALUES
    ('plan'::text, plan, plan_dek_version, plan_crypto_revision, plan_nonce, plan_ciphertext),
    ('do_text', do_text, do_text_dek_version, do_text_crypto_revision, do_text_nonce, do_text_ciphertext),
    ('check_text', check_text, check_text_dek_version, check_text_crypto_revision, check_text_nonce, check_text_ciphertext),
    ('action', action, action_dek_version, action_crypto_revision, action_nonce, action_ciphertext)
  ) fields(field, plaintext, dek_version, crypto_revision, nonce, ciphertext)
  WHERE content_storage_format = 'encrypted-v1'
  UNION ALL
  SELECT user_id, 'ai_generations', id, field,
         public.fukamu_cycle_content_read_text(content_storage_format, plaintext, dek_version, crypto_revision, nonce, ciphertext)
  FROM ai_generations
  CROSS JOIN LATERAL (VALUES
    ('source_text'::text, source_text, source_text_dek_version, source_text_crypto_revision, source_text_nonce, source_text_ciphertext),
    ('output', output, output_dek_version, output_crypto_revision, output_nonce, output_ciphertext),
    ('canonical_provider_input_hash', canonical_provider_input_hash, canonical_provider_input_hash_dek_version, canonical_provider_input_hash_crypto_revision, canonical_provider_input_hash_nonce, canonical_provider_input_hash_ciphertext)
  ) fields(field, plaintext, dek_version, crypto_revision, nonce, ciphertext)
  WHERE content_storage_format = 'encrypted-v1' AND ciphertext IS NOT NULL
)
SELECT user_id, object_type, object_id, field, stored
FROM encrypted_fields
WHERE (user_id::text, object_type, object_id::text, field) >
      (sqlc.arg(after_user_id)::text, sqlc.arg(after_object_type)::text,
       sqlc.arg(after_object_id)::text, sqlc.arg(after_field)::text)
ORDER BY user_id::text, object_type, object_id::text, field
LIMIT sqlc.arg(fetch_limit)::integer;
