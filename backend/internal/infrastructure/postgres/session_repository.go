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

	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type SessionRepository struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

var errSessionPersistenceInvariant = errors.New("session persistence invariant failed")

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
	sessionID := uuidString(row.ID)
	userID := uuidString(row.UserID)
	lastSeenAt, lastSeenValid := sessionFiniteTimestamptz(row.LastSeenAt)
	idleExpiresAt, idleExpiresValid := sessionFiniteTimestamptz(row.IdleExpiresAt)
	absoluteExpiresAt, absoluteExpiresValid := sessionFiniteTimestamptz(row.AbsoluteExpiresAt)
	if sessionID == "" || userID == "" || !lastSeenValid || !idleExpiresValid || !absoluteExpiresValid {
		return appsession.AuthenticatedSession{}, fmt.Errorf(
			"%w: required Session identity or timestamp is invalid",
			errSessionPersistenceInvariant,
		)
	}
	return appsession.AuthenticatedSession{
		ID:                sessionID,
		UserID:            user.ID(userID),
		CSRFTokenHash:     row.CsrfTokenHash,
		LastSeenAt:        lastSeenAt,
		IdleExpiresAt:     idleExpiresAt,
		AbsoluteExpiresAt: absoluteExpiresAt,
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
	txQueries := repository.queries.WithTx(tx)

	var existingUserID pgtype.UUID
	var existingExpires time.Time
	located, locateErr := txQueries.LocateAnonymousBootstrap(ctx, input.BootstrapKeyHash)
	err = locateErr
	if err == nil {
		existingUserID, existingExpires, err = sessionAnonymousBootstrapState(located.UserID, located.ExpiresAt)
		if err != nil {
			return record, err
		}
		locatedUserID := existingUserID
		if err = lockUser(ctx, tx, user.ID(uuidString(locatedUserID))); err != nil {
			return record, err
		}
		locked, lockErr := txQueries.LockAnonymousBootstrapByUser(ctx, db.LockAnonymousBootstrapByUserParams{
			KeyHash: input.BootstrapKeyHash,
			UserID:  locatedUserID,
		})
		err = lockErr
		if err == nil {
			existingUserID, existingExpires, err = sessionAnonymousBootstrapState(locked.UserID, locked.ExpiresAt)
			if err != nil {
				return record, err
			}
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return record, err
		}
	}
	switch {
	case err == nil && existingExpires.After(input.Now):
		err = insertSession(ctx, txQueries, input, existingUserID)
		if err != nil {
			return record, err
		}
		err = tx.Commit(ctx)
		return appsession.AnonymousRecord{UserID: user.ID(uuidString(existingUserID)), Created: false}, err
	case err == nil:
		if err = txQueries.DeleteAnonymousBootstrapByKeyHash(ctx, input.BootstrapKeyHash); err != nil {
			return record, err
		}
	case errors.Is(err, pgx.ErrNoRows):
		err = nil
	default:
		return record, err
	}

	userID := mustUUID(string(input.UserID))
	if err = txQueries.InsertAnonymousUser(ctx, db.InsertAnonymousUserParams{
		UserID: userID,
		Now:    timestamptz(input.Now),
	}); err != nil {
		return record, err
	}
	if err = insertSession(ctx, txQueries, input, userID); err != nil {
		return record, err
	}
	if err = txQueries.InsertAnonymousBootstrap(ctx, db.InsertAnonymousBootstrapParams{
		KeyHash:   input.BootstrapKeyHash,
		UserID:    userID,
		ExpiresAt: timestamptz(input.BootstrapExpires),
		Now:       timestamptz(input.Now),
	}); err != nil {
		return record, err
	}
	if err = tx.Commit(ctx); err != nil {
		return record, err
	}
	return appsession.AnonymousRecord{UserID: input.UserID, Created: true}, nil
}

func insertSession(
	ctx context.Context,
	queries *db.Queries,
	input appsession.CreateAnonymousRecord,
	userID pgtype.UUID,
) error {
	err := queries.InsertSession(ctx, db.InsertSessionParams{
		SessionID:         mustUUID(input.SessionID),
		UserID:            userID,
		TokenHash:         input.SessionTokenHash,
		CsrfTokenHash:     input.CSRFTokenHash,
		Now:               timestamptz(input.Now),
		IdleExpiresAt:     timestamptz(input.IdleExpiresAt),
		AbsoluteExpiresAt: timestamptz(input.AbsoluteExpiresAt),
	})
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
	if !value.Valid {
		return ""
	}
	encoded, err := value.MarshalJSON()
	if err != nil || len(encoded) < 2 {
		return ""
	}
	return string(encoded[1 : len(encoded)-1])
}

func timestamptz(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func sessionFiniteTimestamptz(value pgtype.Timestamptz) (time.Time, bool) {
	if !value.Valid || value.InfinityModifier != pgtype.Finite {
		return time.Time{}, false
	}
	return value.Time.UTC(), true
}

func sessionAnonymousBootstrapState(
	userID pgtype.UUID,
	expiresAt pgtype.Timestamptz,
) (pgtype.UUID, time.Time, error) {
	expires, expiresValid := sessionFiniteTimestamptz(expiresAt)
	if uuidString(userID) == "" || !expiresValid {
		return pgtype.UUID{}, time.Time{}, fmt.Errorf(
			"%w: anonymous bootstrap identity or expiry is invalid",
			errSessionPersistenceInvariant,
		)
	}
	return userID, expires, nil
}
