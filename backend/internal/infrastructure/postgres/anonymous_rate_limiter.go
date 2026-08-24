package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type AnonymousRateLimiter struct {
	pool      *pgxpool.Pool
	hourLimit int
	dayLimit  int
}

func NewAnonymousRateLimiter(pool *pgxpool.Pool, hourLimit, dayLimit int) *AnonymousRateLimiter {
	return &AnonymousRateLimiter{pool: pool, hourLimit: hourLimit, dayLimit: dayLimit}
}

func (limiter *AnonymousRateLimiter) Check(ctx context.Context, keyHash []byte, now time.Time) (err error) {
	tx, err := limiter.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollbackOnError(ctx, tx, &err)
	queries := db.New(tx)
	window := now.UTC().Truncate(time.Hour)
	hourCount, err := queries.IncrementAnonymousIPHourBucket(ctx, db.IncrementAnonymousIPHourBucketParams{
		KeyHash:     keyHash,
		WindowStart: timestamptz(window),
		ExpiresAt:   timestamptz(now.Add(25 * time.Hour)),
	})
	if err != nil {
		return err
	}
	rollingValue, err := queries.CountAnonymousIPRollingUsage(ctx, db.CountAnonymousIPRollingUsageParams{
		KeyHash:       keyHash,
		AcceptedAfter: timestamptz(now.Add(-24 * time.Hour)),
	})
	if err != nil {
		return err
	}
	rollingCount, err := anonymousRollingCount(rollingValue)
	if err != nil {
		return err
	}
	blocked := int64(hourCount) > int64(limiter.hourLimit) || rollingCount > int64(limiter.dayLimit)
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if blocked {
		return ports.ErrAnonymousCreationBlocked
	}
	return nil
}

func anonymousRollingCount(value any) (int64, error) {
	count, ok := value.(int64)
	if !ok || count < 0 {
		return 0, fmt.Errorf("invalid anonymous rolling count type/value: %T", value)
	}
	return count, nil
}
