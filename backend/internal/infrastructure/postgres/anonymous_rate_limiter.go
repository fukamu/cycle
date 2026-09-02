package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
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

func (limiter *AnonymousRateLimiter) Check(ctx context.Context, keyHash []byte, _ time.Time) (err error) {
	tx, err := limiter.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer rollbackOnError(ctx, tx, &err)
	queries := db.New(tx)
	if err = queries.AcquireAnonymousIPRateLimitGuard(ctx, keyHash); err != nil {
		return err
	}
	canonicalValue, err := queries.AdvanceAnonymousIPRateLimitGuard(ctx, keyHash)
	if err != nil {
		return err
	}
	if !canonicalValue.Valid || canonicalValue.InfinityModifier != pgtype.Finite {
		return fmt.Errorf("invalid anonymous rate limit canonical time")
	}
	canonicalTime := canonicalValue.Time.UTC()
	window := canonicalTime.Truncate(time.Hour)
	hourCount, err := queries.IncrementAnonymousIPHourBucket(ctx, db.IncrementAnonymousIPHourBucketParams{
		KeyHash:     keyHash,
		WindowStart: timestamptz(window),
		ExpiresAt:   timestamptz(canonicalTime.Add(25 * time.Hour)),
	})
	if err != nil {
		return err
	}
	rollingCount, err := queries.CountAnonymousIPRollingUsage(ctx, db.CountAnonymousIPRollingUsageParams{
		KeyHash:         keyHash,
		IncludedFrom:    timestamptz(window.Add(-24 * time.Hour)),
		IncludedThrough: timestamptz(window),
	})
	if err != nil {
		return err
	}
	blocked := int64(hourCount) > int64(limiter.hourLimit) || rollingCount > int64(limiter.dayLimit)
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if blocked {
		return ports.ErrRateLimitExceeded
	}
	return nil
}
