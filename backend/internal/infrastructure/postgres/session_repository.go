package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
	db "github.com/matoruru/PDCAI/backend/internal/infrastructure/postgres/generated"
)

type SessionRepository struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

func NewSessionRepository(pool *pgxpool.Pool) *SessionRepository {
	return &SessionRepository{pool: pool, queries: db.New(pool)}
}

func (repository *SessionRepository) FindByTokenHash(ctx context.Context, hash []byte, now time.Time) (appsession.AuthenticatedSession, error) {
	row, err := repository.queries.GetSessionByTokenHash(ctx, db.GetSessionByTokenHashParams{
		TokenHash:     hash,
		IdleExpiresAt: timestamptz(now),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return appsession.AuthenticatedSession{}, appsession.ErrSessionExpired
		}
		return appsession.AuthenticatedSession{}, err
	}
	return appsession.AuthenticatedSession{
		ID:                uuidString(row.ID),
		UserID:            user.ID(uuidString(row.UserID)),
		CSRFTokenHash:     row.CsrfTokenHash,
		LastSeenAt:        row.LastSeenAt.Time,
		IdleExpiresAt:     row.IdleExpiresAt.Time,
		AbsoluteExpiresAt: row.AbsoluteExpiresAt.Time,
		GoogleConnected:   row.GoogleConnected,
		GoogleEmail:       row.GoogleEmail,
	}, nil
}

func (repository *SessionRepository) RotateCSRF(ctx context.Context, sessionID string, hash []byte, now time.Time) error {
	rows, err := repository.queries.RotateSessionCSRF(ctx, db.RotateSessionCSRFParams{
		ID:            mustUUID(sessionID),
		CsrfTokenHash: hash,
		IdleExpiresAt: timestamptz(now),
	})
	if err != nil {
		return err
	}
	if rows != 1 {
		return appsession.ErrSessionExpired
	}
	return nil
}

func (repository *SessionRepository) Touch(ctx context.Context, sessionID string, now time.Time, idleExpiresAt time.Time) error {
	return repository.queries.TouchSession(ctx, db.TouchSessionParams{
		ID:            mustUUID(sessionID),
		LastSeenAt:    timestamptz(now),
		IdleExpiresAt: timestamptz(idleExpiresAt),
	})
}

func (repository *SessionRepository) CreateOrResumeAnonymous(ctx context.Context, input appsession.CreateAnonymousRecord) (appsession.AnonymousRecord, error) {
	for attempt := 0; attempt < 2; attempt++ {
		record, err := repository.createOrResumeAnonymousOnce(ctx, input)
		if err == nil {
			return record, nil
		}
		var databaseError *pgconn.PgError
		if !errors.As(err, &databaseError) || databaseError.Code != "23505" || databaseError.ConstraintName != "anonymous_bootstraps_pkey" {
			return appsession.AnonymousRecord{}, err
		}
	}
	return appsession.AnonymousRecord{}, errors.New("anonymous bootstrap conflict did not converge")
}

func (repository *SessionRepository) createOrResumeAnonymousOnce(ctx context.Context, input appsession.CreateAnonymousRecord) (record appsession.AnonymousRecord, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return record, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback(ctx)
		}
	}()

	var existingUserID pgtype.UUID
	var existingExpires time.Time
	err = tx.QueryRow(ctx, `
SELECT user_id, expires_at
FROM anonymous_bootstraps
WHERE key_hash = $1
FOR UPDATE`, input.BootstrapKeyHash).Scan(&existingUserID, &existingExpires)
	switch {
	case err == nil && existingExpires.After(input.Now):
		err = insertSession(ctx, tx, input, existingUserID)
		if err != nil {
			return record, err
		}
		err = tx.Commit(ctx)
		return appsession.AnonymousRecord{UserID: user.ID(uuidString(existingUserID)), Created: false}, err
	case err == nil:
		if _, err = tx.Exec(ctx, `DELETE FROM anonymous_bootstraps WHERE key_hash = $1`, input.BootstrapKeyHash); err != nil {
			return record, err
		}
	case errors.Is(err, pgx.ErrNoRows):
		err = nil
	default:
		return record, err
	}

	userID := mustUUID(string(input.UserID))
	if _, err = tx.Exec(ctx, `
INSERT INTO users (id, last_active_at, created_at, updated_at)
VALUES ($1, $2, $2, $2)`, userID, input.Now); err != nil {
		return record, err
	}
	if err = insertSession(ctx, tx, input, userID); err != nil {
		return record, err
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO anonymous_bootstraps (key_hash, user_id, expires_at, created_at)
VALUES ($1, $2, $3, $4)`, input.BootstrapKeyHash, userID, input.BootstrapExpires, input.Now); err != nil {
		return record, err
	}
	if err = tx.Commit(ctx); err != nil {
		return record, err
	}
	return appsession.AnonymousRecord{UserID: input.UserID, Created: true}, nil
}

func insertSession(ctx context.Context, tx pgx.Tx, input appsession.CreateAnonymousRecord, userID pgtype.UUID) error {
	_, err := tx.Exec(ctx, `
INSERT INTO sessions (
    id, user_id, token_hash, csrf_token_hash, created_at, last_seen_at,
    idle_expires_at, absolute_expires_at
) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
		mustUUID(input.SessionID), userID, input.SessionTokenHash, input.CSRFTokenHash,
		input.Now, input.IdleExpiresAt, input.AbsoluteExpiresAt)
	if err != nil {
		return fmt.Errorf("insert session: %w", err)
	}
	return nil
}

func mustUUID(value string) pgtype.UUID {
	var result pgtype.UUID
	if err := result.Scan(value); err != nil {
		panic(fmt.Sprintf("invalid UUID passed to PostgreSQL adapter: %q", value))
	}
	return result
}

func uuidString(value pgtype.UUID) string {
	encoded, err := value.MarshalJSON()
	if err != nil || len(encoded) < 2 {
		return ""
	}
	return string(encoded[1 : len(encoded)-1])
}

func timestamptz(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}
