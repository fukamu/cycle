package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/account"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type AccountRepository struct {
	pool *pgxpool.Pool
}

func NewAccountRepository(pool *pgxpool.Pool) *AccountRepository {
	return &AccountRepository{pool: pool}
}

func (repository *AccountRepository) UpgradeGoogle(ctx context.Context, input account.UpgradeRecord) (result account.AuthResult, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)
	if err = lockUser(ctx, tx, input.CurrentUserID); err != nil {
		return result, err
	}
	var linkedUser pgtype.UUID
	var linkedEmail pgtype.Text
	err = tx.QueryRow(ctx, `SELECT user_id,
CASE WHEN email_verified_at_link IS TRUE THEN email_at_link ELSE NULL END
FROM auth_identities
WHERE provider='google' AND provider_subject=$1`, input.Identity.Subject).Scan(&linkedUser, &linkedEmail)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		_, err = tx.Exec(ctx, `INSERT INTO auth_identities (
id,user_id,provider,provider_subject,email_at_link,email_verified_at_link,created_at
) VALUES($1,$2,'google',$3,$4,$5,$6)`, mustUUID(input.IdentityID), mustUUID(string(input.CurrentUserID)),
			input.Identity.Subject, input.Identity.Email, input.Identity.EmailVerified, input.Now)
		if err != nil {
			if isUniqueViolation(err) {
				return result, account.ErrGoogleIdentityLinked
			}
			return result, err
		}
		result.GoogleEmail = verifiedGoogleEmail(input.Identity)
	case err != nil:
		return result, err
	case uuidString(linkedUser) != string(input.CurrentUserID):
		return result, account.ErrGoogleIdentityLinked
	default:
		result.GoogleEmail = nullableText(linkedEmail)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM anonymous_bootstraps WHERE user_id=$1`, mustUUID(string(input.CurrentUserID))); err != nil {
		return result, err
	}
	if err = rotateSession(ctx, tx, input.CurrentSessionID, input.NewSessionID, input.CurrentUserID,
		input.SessionTokenHash, input.CSRFTokenHash, input.Now, input.IdleExpiresAt, input.AbsoluteExpiresAt); err != nil {
		return result, err
	}
	result.UserID = input.CurrentUserID
	err = tx.Commit(ctx)
	return result, err
}

func (repository *AccountRepository) LoginGoogle(ctx context.Context, input account.LoginRecord) (result account.AuthResult, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)
	var targetUser pgtype.UUID
	var googleEmail pgtype.Text
	err = tx.QueryRow(ctx, `SELECT user_id,
CASE WHEN email_verified_at_link IS TRUE THEN email_at_link ELSE NULL END
FROM auth_identities
WHERE provider='google' AND provider_subject=$1`, input.Identity.Subject).Scan(&targetUser, &googleEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, account.ErrGoogleAccountNotLinked
	}
	if err != nil {
		return result, err
	}
	result.UserID = user.ID(uuidString(targetUser))
	result.GoogleEmail = nullableText(googleEmail)
	if err = lockUser(ctx, tx, result.UserID); err != nil {
		return result, err
	}
	command, updateErr := tx.Exec(ctx, `UPDATE sessions SET revoked_at=$2
WHERE id=$1 AND revoked_at IS NULL`, mustUUID(input.CurrentSessionID), input.Now)
	if updateErr != nil {
		return result, updateErr
	}
	if command.RowsAffected() != 1 {
		return result, pgx.ErrNoRows
	}
	if err = insertAccountSession(ctx, tx, input.NewSessionID, result.UserID, input.SessionTokenHash, input.CSRFTokenHash,
		input.Now, input.IdleExpiresAt, input.AbsoluteExpiresAt); err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}

func (repository *AccountRepository) DeleteAccount(ctx context.Context, userID user.ID, now time.Time) (err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollbackOnError(ctx, tx, &err)
	if err = lockUser(ctx, tx, userID); err != nil {
		return err
	}
	userUUID := mustUUID(string(userID))
	goalRows, err := tx.Query(ctx, `SELECT id FROM goals WHERE user_id=$1 ORDER BY id FOR UPDATE`, userUUID)
	if err != nil {
		return err
	}
	if err = consumeLockedUUIDRows(goalRows); err != nil {
		return err
	}
	draftRows, err := tx.Query(ctx, `SELECT id FROM goal_drafts WHERE user_id=$1 ORDER BY id FOR UPDATE`, userUUID)
	if err != nil {
		return err
	}
	if err = consumeLockedUUIDRows(draftRows); err != nil {
		return err
	}
	cycleRows, err := tx.Query(ctx, `SELECT id FROM pdca_cycles WHERE user_id=$1 ORDER BY id FOR UPDATE`, userUUID)
	if err != nil {
		return err
	}
	if err = consumeLockedUUIDRows(cycleRows); err != nil {
		return err
	}

	type generationExposure struct {
		id          string
		month       time.Time
		reservation string
	}
	generationRows, err := tx.Query(ctx, `SELECT id,budget_month_utc,budget_reserved_cost_usd::text
FROM ai_generations WHERE user_id=$1 AND status='running' ORDER BY id FOR UPDATE`, userUUID)
	if err != nil {
		return err
	}
	generationExposures := make([]generationExposure, 0)
	generationByID := make(map[string]generationExposure)
	for generationRows.Next() {
		var generation generationExposure
		if err = generationRows.Scan(&generation.id, &generation.month, &generation.reservation); err != nil {
			generationRows.Close()
			return err
		}
		generationExposures = append(generationExposures, generation)
		generationByID[generation.id] = generation
	}
	generationRows.Close()
	if err = generationRows.Err(); err != nil {
		return err
	}
	type releasedUsageExposure struct {
		operationID string
		month       time.Time
		reservation string
	}
	usageRows, err := tx.Query(ctx, `SELECT operation_id,settlement_budget_month_utc,
settlement_reservation_cost_usd::text FROM ai_usage_events
WHERE user_id=$1 AND provider_usage_finalized_at IS NULL ORDER BY operation_id FOR UPDATE`, userUUID)
	if err != nil {
		return err
	}
	releasedUsageExposures := make([]releasedUsageExposure, 0)
	for usageRows.Next() {
		var usage releasedUsageExposure
		if err = usageRows.Scan(&usage.operationID, &usage.month, &usage.reservation); err != nil {
			usageRows.Close()
			return err
		}
		if generation, running := generationByID[usage.operationID]; running {
			if !generation.month.Equal(usage.month) || generation.reservation != usage.reservation {
				usageRows.Close()
				return errors.New("account delete running AI settlement exposure invariant failed")
			}
			continue
		}
		releasedUsageExposures = append(releasedUsageExposures, usage)
	}
	usageRows.Close()
	if err = usageRows.Err(); err != nil {
		return err
	}
	type monthlyExposure struct {
		month             time.Time
		reservedToRelease string
		unattributedToAdd string
	}
	exposureRows, err := tx.Query(ctx, `WITH exposures AS (
  SELECT budget_month_utc AS month_utc,budget_reserved_cost_usd AS reserved_to_release,
         budget_reserved_cost_usd AS unattributed_to_add
  FROM ai_generations
  WHERE user_id=$1 AND status='running'
  UNION ALL
  SELECT usage.settlement_budget_month_utc,0::numeric,usage.settlement_reservation_cost_usd
  FROM ai_usage_events AS usage
  WHERE usage.user_id=$1 AND usage.provider_usage_finalized_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM ai_generations AS generation
      WHERE generation.id=usage.operation_id AND generation.user_id=usage.user_id AND generation.status='running'
    )
)
SELECT month_utc,SUM(reserved_to_release)::text,SUM(unattributed_to_add)::text
FROM exposures GROUP BY month_utc ORDER BY month_utc`, userUUID)
	if err != nil {
		return err
	}
	monthlyExposures := make([]monthlyExposure, 0)
	for exposureRows.Next() {
		var exposure monthlyExposure
		if err = exposureRows.Scan(&exposure.month, &exposure.reservedToRelease, &exposure.unattributedToAdd); err != nil {
			exposureRows.Close()
			return err
		}
		monthlyExposures = append(monthlyExposures, exposure)
	}
	exposureRows.Close()
	if err = exposureRows.Err(); err != nil {
		return err
	}
	for _, generation := range generationExposures {
		command, updateErr := tx.Exec(ctx, `UPDATE ai_generations SET budget_reserved_cost_usd=0
WHERE user_id=$1 AND id=$2 AND status='running' AND budget_month_utc=$3
  AND budget_reserved_cost_usd=$4::numeric`, userUUID, mustUUID(generation.id), generation.month, generation.reservation)
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("account delete generation reservation invariant failed")
		}
	}
	for _, exposure := range monthlyExposures {
		command, updateErr := tx.Exec(ctx, `UPDATE ai_budget_monthly SET
reserved_cost_usd=reserved_cost_usd-$2,
unattributed_cost_usd=unattributed_cost_usd+$3,
updated_at=$4
WHERE month_utc=$1 AND reserved_cost_usd >= $2::numeric`, exposure.month, exposure.reservedToRelease,
			exposure.unattributedToAdd, now)
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("account delete budget settlement exposure invariant failed")
		}
	}
	for _, usage := range releasedUsageExposures {
		command, deleteErr := tx.Exec(ctx, `DELETE FROM ai_usage_events AS usage
WHERE usage.user_id=$1 AND usage.operation_id=$2 AND usage.provider_usage_finalized_at IS NULL
  AND usage.settlement_budget_month_utc=$3 AND usage.settlement_reservation_cost_usd=$4::numeric
  AND NOT EXISTS (
    SELECT 1 FROM ai_generations AS generation
    WHERE generation.id=usage.operation_id AND generation.user_id=usage.user_id AND generation.status='running'
  )`, userUUID, mustUUID(usage.operationID), usage.month, usage.reservation)
		if deleteErr != nil {
			return deleteErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("account delete released AI usage exposure invariant failed")
		}
	}
	command, err := tx.Exec(ctx, `DELETE FROM users WHERE id=$1`, userUUID)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return pgx.ErrNoRows
	}
	err = tx.Commit(ctx)
	return err
}

func lockUser(ctx context.Context, tx pgx.Tx, userID user.ID) error {
	var ignored pgtype.UUID
	return tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, mustUUID(string(userID))).Scan(&ignored)
}

func consumeLockedUUIDRows(rows pgx.Rows) error {
	defer rows.Close()
	for rows.Next() {
		var ignored pgtype.UUID
		if err := rows.Scan(&ignored); err != nil {
			return err
		}
	}
	return rows.Err()
}

func rotateSession(ctx context.Context, tx pgx.Tx, currentSessionID, newSessionID string, userID user.ID, tokenHash, csrfHash []byte, now, idleExpiry, absoluteExpiry time.Time) error {
	command, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at=$3
WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, mustUUID(currentSessionID), mustUUID(string(userID)), now)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return pgx.ErrNoRows
	}
	return insertAccountSession(ctx, tx, newSessionID, userID, tokenHash, csrfHash, now, idleExpiry, absoluteExpiry)
}

func insertAccountSession(ctx context.Context, tx pgx.Tx, sessionID string, userID user.ID, tokenHash, csrfHash []byte, now, idleExpiry, absoluteExpiry time.Time) error {
	_, err := tx.Exec(ctx, `INSERT INTO sessions (
id,user_id,token_hash,csrf_token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at
) VALUES($1,$2,$3,$4,$5,$5,$6,$7)`, mustUUID(sessionID), mustUUID(string(userID)), tokenHash, csrfHash, now, idleExpiry, absoluteExpiry)
	return err
}

func verifiedGoogleEmail(identity account.GoogleIdentity) *string {
	if identity.Email == nil || identity.EmailVerified == nil || !*identity.EmailVerified {
		return nil
	}
	email := *identity.Email
	return &email
}

func nullableText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}
