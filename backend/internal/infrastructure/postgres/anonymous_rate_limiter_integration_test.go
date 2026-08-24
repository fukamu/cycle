package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/ports"
)

func TestAnonymousRateLimiterPersistsBlockedAttemptAcrossInstances(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	key := []byte("hmac-ip-key")
	for attempt := 1; attempt <= 2; attempt++ {
		limiter := NewAnonymousRateLimiter(pool, 2, 10)
		if err := limiter.Check(context.Background(), key, integrationNow()); err != nil {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
	}
	if err := NewAnonymousRateLimiter(pool, 2, 10).Check(context.Background(), key, integrationNow()); !errors.Is(err, ports.ErrRateLimitExceeded) {
		t.Fatalf("third attempt error = %v", err)
	}
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT request_count FROM abuse_rate_buckets WHERE scope='anonymous_ip_hour' AND key_hash=$1`, key).Scan(&count); err != nil || count != 3 {
		t.Fatalf("persisted count/error = %d/%v", count, err)
	}
}
