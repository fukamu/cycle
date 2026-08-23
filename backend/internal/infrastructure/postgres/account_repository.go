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

	type generationReservation struct {
		id pgtype.UUID
	}
	generationRows, err := tx.Query(ctx, `SELECT id
FROM ai_generations WHERE user_id=$1 AND status='running' ORDER BY id FOR UPDATE`, userUUID)
	if err != nil {
		return err
	}
	generationReservations := make([]generationReservation, 0)
	for generationRows.Next() {
		var generation generationReservation
		if err = generationRows.Scan(&generation.id); err != nil {
			generationRows.Close()
			return err
		}
		generationReservations = append(generationReservations, generation)
	}
	generationRows.Close()
	if err = generationRows.Err(); err != nil {
		return err
	}
	type monthlyReservation struct {
		month  time.Time
		amount pgtype.Numeric
	}
	reservationRows, err := tx.Query(ctx, `SELECT budget_month_utc,SUM(budget_reserved_cost_usd)
FROM ai_generations WHERE user_id=$1 AND status='running'
GROUP BY budget_month_utc ORDER BY budget_month_utc`, userUUID)
	if err != nil {
		return err
	}
	monthlyReservations := make([]monthlyReservation, 0)
	for reservationRows.Next() {
		var reservation monthlyReservation
		if err = reservationRows.Scan(&reservation.month, &reservation.amount); err != nil {
			reservationRows.Close()
			return err
		}
		monthlyReservations = append(monthlyReservations, reservation)
	}
	reservationRows.Close()
	if err = reservationRows.Err(); err != nil {
		return err
	}
	for _, generation := range generationReservations {
		command, updateErr := tx.Exec(ctx, `UPDATE ai_generations SET budget_reserved_cost_usd=0
WHERE user_id=$1 AND id=$2 AND status='running'`, userUUID, generation.id)
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("account delete generation reservation invariant failed")
		}
	}
	for _, reservation := range monthlyReservations {
		command, updateErr := tx.Exec(ctx, `UPDATE ai_budget_monthly SET
reserved_cost_usd=reserved_cost_usd-$2,
unattributed_cost_usd=unattributed_cost_usd+$2,
updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2`, reservation.month, reservation.amount, now)
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("account delete budget reservation invariant failed")
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
