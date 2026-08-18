package postgres

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matoruru/PDCAI/backend/internal/application/account"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
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
	err = tx.QueryRow(ctx, `SELECT user_id FROM auth_identities
WHERE provider='google' AND provider_subject=$1`, input.Identity.Subject).Scan(&linkedUser)
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
	case err != nil:
		return result, err
	case uuidString(linkedUser) != string(input.CurrentUserID):
		return result, account.ErrGoogleIdentityLinked
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
	err = tx.QueryRow(ctx, `SELECT user_id FROM auth_identities
WHERE provider='google' AND provider_subject=$1`, input.Identity.Subject).Scan(&targetUser)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, account.ErrGoogleAccountNotLinked
	}
	if err != nil {
		return result, err
	}
	result.UserID = user.ID(uuidString(targetUser))
	if err = lockUser(ctx, tx, result.UserID); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `UPDATE sessions SET revoked_at=$2
WHERE id=$1 AND revoked_at IS NULL`, mustUUID(input.CurrentSessionID), input.Now); err != nil {
		return result, err
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
	cycleRows, err := tx.Query(ctx, `SELECT id FROM goals WHERE user_id=$1 ORDER BY id FOR UPDATE`, mustUUID(string(userID)))
	if err != nil {
		return err
	}
	for cycleRows.Next() {
		var ignored pgtype.UUID
		if err = cycleRows.Scan(&ignored); err != nil {
			cycleRows.Close()
			return err
		}
	}
	cycleRows.Close()
	if err = cycleRows.Err(); err != nil {
		return err
	}

	rows, err := tx.Query(ctx, `SELECT budget_month_utc,budget_reserved_cost_usd
FROM ai_generations WHERE user_id=$1 AND status='running' ORDER BY id FOR UPDATE`, mustUUID(string(userID)))
	if err != nil {
		return err
	}
	reservations := map[time.Time]float64{}
	for rows.Next() {
		var month time.Time
		var value float64
		if err = rows.Scan(&month, &value); err != nil {
			rows.Close()
			return err
		}
		reservations[month.UTC()] += value
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	months := make([]time.Time, 0, len(reservations))
	for month := range reservations {
		months = append(months, month)
	}
	sort.Slice(months, func(i, j int) bool { return months[i].Before(months[j]) })
	for _, month := range months {
		command, updateErr := tx.Exec(ctx, `UPDATE ai_budget_monthly SET
reserved_cost_usd=reserved_cost_usd-$2,
unattributed_cost_usd=unattributed_cost_usd+$2,
updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2`, month, reservations[month], now)
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() != 1 {
			return errors.New("account delete budget reservation invariant failed")
		}
	}
	command, err := tx.Exec(ctx, `DELETE FROM users WHERE id=$1`, mustUUID(string(userID)))
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
