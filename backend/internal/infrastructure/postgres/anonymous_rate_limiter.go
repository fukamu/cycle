package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matoruru/PDCAI/backend/internal/application/ports"
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
	window := now.UTC().Truncate(time.Hour)
	var hourCount int
	err = tx.QueryRow(ctx, `INSERT INTO abuse_rate_buckets(scope,key_hash,window_start,request_count,expires_at)
VALUES('anonymous_ip_hour',$1,$2,1,$3)
ON CONFLICT(scope,key_hash,window_start) DO UPDATE
SET request_count=abuse_rate_buckets.request_count+1,expires_at=EXCLUDED.expires_at
RETURNING request_count`, keyHash, window, now.Add(25*time.Hour)).Scan(&hourCount)
	if err != nil {
		return err
	}
	var rollingCount int
	if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(request_count),0) FROM abuse_rate_buckets
WHERE scope='anonymous_ip_hour' AND key_hash=$1 AND window_start > $2`, keyHash, now.Add(-24*time.Hour)).Scan(&rollingCount); err != nil {
		return err
	}
	blocked := hourCount > limiter.hourLimit || rollingCount > limiter.dayLimit
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if blocked {
		return ports.ErrAnonymousCreationBlocked
	}
	return nil
}
