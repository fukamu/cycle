package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/ports"
)

func TestAnonymousRateLimiterPersistsBlockedAttemptAcrossInstances(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	key := []byte("hmac-ip-key")
	deleteAnonymousRateLimitGuard(t, pool, key)
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

func TestAnonymousRateLimiterExplicitlyUsesReadCommitted(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	key := []byte("hmac-ip-read-committed")
	deleteAnonymousRateLimitGuard(t, pool, key)

	dropIsolationTrigger := func() {
		_, _ = pool.Exec(context.Background(), `
DROP TRIGGER IF EXISTS test_require_anonymous_guard_read_committed
    ON public.anonymous_rate_limit_guards;
DROP FUNCTION IF EXISTS public.test_require_anonymous_guard_read_committed()`)
	}
	dropIsolationTrigger()
	t.Cleanup(dropIsolationTrigger)
	if _, err := pool.Exec(t.Context(), `
CREATE FUNCTION public.test_require_anonymous_guard_read_committed()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'anonymous guard transaction must use read committed';
    END IF;
    RETURN NEW;
END
$function$;
CREATE TRIGGER test_require_anonymous_guard_read_committed
BEFORE INSERT OR UPDATE ON public.anonymous_rate_limit_guards
FOR EACH ROW EXECUTE FUNCTION public.test_require_anonymous_guard_read_committed()`); err != nil {
		t.Fatal(err)
	}

	config, err := pgxpool.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["default_transaction_isolation"] = "serializable"
	isolationPool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(isolationPool.Close)
	var defaultIsolation string
	if err := isolationPool.QueryRow(t.Context(), `SHOW default_transaction_isolation`).Scan(&defaultIsolation); err != nil {
		t.Fatal(err)
	}
	if defaultIsolation != "serializable" {
		t.Fatalf("test pool default isolation = %q, want serializable", defaultIsolation)
	}

	if err := NewAnonymousRateLimiter(isolationPool, 5, 20).Check(t.Context(), key, integrationNow()); err != nil {
		t.Fatalf("explicit read committed check: %v", err)
	}
}

func TestAnonymousRateLimiterIncludesOverlappingBoundaryHour(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	key := []byte("hmac-ip-boundary-hour")
	deleteAnonymousRateLimitGuard(t, pool, key)

	canonicalTime := futureCanonicalTime(t, pool, 72*time.Hour)
	currentHour := canonicalTime.Truncate(time.Hour)
	prepareAnonymousRateLimitGuard(t, pool, key, canonicalTime)
	if _, err := pool.Exec(t.Context(), `
INSERT INTO abuse_rate_buckets(scope,key_hash,window_start,request_count,expires_at) VALUES
('anonymous_ip_hour',$1,$2,5,$4),
('anonymous_ip_hour',$1,$3,15,$4)`,
		key, currentHour.Add(-24*time.Hour), currentHour, canonicalTime.Add(25*time.Hour)); err != nil {
		t.Fatal(err)
	}

	err := NewAnonymousRateLimiter(pool, 100, 20).Check(t.Context(), key, integrationNow())
	if !errors.Is(err, ports.ErrRateLimitExceeded) {
		t.Fatalf("21st conservative rolling attempt error = %v, want %v", err, ports.ErrRateLimitExceeded)
	}

	var boundaryCount, currentCount int
	if err := pool.QueryRow(t.Context(), `
SELECT
    COALESCE(sum(request_count) FILTER (WHERE window_start=$2),0)::int,
    COALESCE(sum(request_count) FILTER (WHERE window_start=$3),0)::int
FROM abuse_rate_buckets
WHERE scope='anonymous_ip_hour' AND key_hash=$1`,
		key, currentHour.Add(-24*time.Hour), currentHour).Scan(&boundaryCount, &currentCount); err != nil {
		t.Fatal(err)
	}
	if boundaryCount != 5 || currentCount != 16 {
		t.Fatalf("boundary/current counts = %d/%d, want 5/16", boundaryCount, currentCount)
	}
}

func TestAnonymousRateLimiterSerializesCanonicalTimeAndExcludesFutureBuckets(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	key := []byte("hmac-ip-canonical-lock")
	deleteAnonymousRateLimitGuard(t, pool, key)

	canonicalTime := futureCanonicalTime(t, pool, 96*time.Hour)
	currentHour := canonicalTime.Truncate(time.Hour)
	guardExpiry := canonicalTime.Add(25 * time.Hour)
	bucketExpiry := canonicalTime.Add(26 * time.Hour)
	prepareAnonymousRateLimitGuard(t, pool, key, canonicalTime)
	if _, err := pool.Exec(t.Context(), `
INSERT INTO abuse_rate_buckets(scope,key_hash,window_start,request_count,expires_at) VALUES
('anonymous_ip_hour',$1,$2,1,$4),
('anonymous_ip_hour',$1,$3,100,$4)`,
		key, currentHour, currentHour.Add(time.Hour), bucketExpiry); err != nil {
		t.Fatal(err)
	}

	holder, err := pool.BeginTx(t.Context(), pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = holder.Rollback(context.Background()) })
	if _, err := holder.Exec(t.Context(), `
UPDATE public.anonymous_rate_limit_guards
SET expires_at=$2
WHERE scope='anonymous_ip' AND key_hash=$1`, key, guardExpiry); err != nil {
		t.Fatal(err)
	}

	checkContext, cancelCheck := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancelCheck()
	result := make(chan error, 1)
	go func() {
		result <- NewAnonymousRateLimiter(pool, 5, 2).Check(
			checkContext,
			key,
			canonicalTime.Add(-48*time.Hour),
		)
	}()
	waitForAnonymousGuardLock(t, pool)
	if err := holder.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatalf("serialized check error = %v, want allowed", err)
	}

	var persistedGuardExpiry, persistedBucketExpiry time.Time
	var currentCount int
	if err := pool.QueryRow(t.Context(), `
SELECT
    (SELECT expires_at FROM public.anonymous_rate_limit_guards
     WHERE scope='anonymous_ip' AND key_hash=$1),
    (SELECT expires_at FROM abuse_rate_buckets
     WHERE scope='anonymous_ip_hour' AND key_hash=$1 AND window_start=$2),
    (SELECT request_count FROM abuse_rate_buckets
     WHERE scope='anonymous_ip_hour' AND key_hash=$1 AND window_start=$2)`, key, currentHour).Scan(
		&persistedGuardExpiry, &persistedBucketExpiry, &currentCount,
	); err != nil {
		t.Fatal(err)
	}
	if !persistedGuardExpiry.Equal(guardExpiry) {
		t.Fatalf("guard expiry = %s, want monotonic %s", persistedGuardExpiry, guardExpiry)
	}
	if !persistedBucketExpiry.Equal(bucketExpiry) {
		t.Fatalf("bucket expiry = %s, want monotonic %s", persistedBucketExpiry, bucketExpiry)
	}
	if currentCount != 2 {
		t.Fatalf("canonical-hour count = %d, want 2", currentCount)
	}
}

func TestAnonymousRateLimiterDoesNotBypassUncommittedPrecedingHour(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	key := []byte("hmac-ip-hour-rollover")
	deleteAnonymousRateLimitGuard(t, pool, key)

	canonicalTime := futureCanonicalTime(t, pool, 120*time.Hour)
	currentHour := canonicalTime.Truncate(time.Hour)
	prepareAnonymousRateLimitGuard(t, pool, key, canonicalTime.Add(-time.Hour))

	holder, err := pool.BeginTx(t.Context(), pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = holder.Rollback(context.Background()) })
	if _, err := holder.Exec(t.Context(), `
UPDATE public.anonymous_rate_limit_guards
SET expires_at=$2
WHERE scope='anonymous_ip' AND key_hash=$1`, key, canonicalTime.Add(25*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(t.Context(), `
INSERT INTO abuse_rate_buckets(scope,key_hash,window_start,request_count,expires_at)
VALUES ('anonymous_ip_hour',$1,$2,1,$3)`,
		key, currentHour.Add(-time.Hour), canonicalTime.Add(25*time.Hour)); err != nil {
		t.Fatal(err)
	}

	checkContext, cancelCheck := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancelCheck()
	result := make(chan error, 1)
	go func() {
		result <- NewAnonymousRateLimiter(pool, 5, 1).Check(
			checkContext,
			key,
			canonicalTime.Add(-48*time.Hour),
		)
	}()
	waitForAnonymousGuardLock(t, pool)
	if err := holder.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, ports.ErrRateLimitExceeded) {
		t.Fatalf("serialized rollover attempt error = %v, want %v", err, ports.ErrRateLimitExceeded)
	}

	var precedingCount, currentCount int
	if err := pool.QueryRow(t.Context(), `
SELECT
    COALESCE(sum(request_count) FILTER (WHERE window_start=$2),0)::int,
    COALESCE(sum(request_count) FILTER (WHERE window_start=$3),0)::int
FROM abuse_rate_buckets
WHERE scope='anonymous_ip_hour' AND key_hash=$1`,
		key, currentHour.Add(-time.Hour), currentHour).Scan(&precedingCount, &currentCount); err != nil {
		t.Fatal(err)
	}
	if precedingCount != 1 || currentCount != 1 {
		t.Fatalf("preceding/current committed counts = %d/%d, want 1/1", precedingCount, currentCount)
	}
}

func TestAnonymousRateLimiterRollsBackSentinelWhenCanonicalAdvanceFails(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	key := []byte("hmac-ip-sentinel-rollback")
	deleteAnonymousRateLimitGuard(t, pool, key)

	dropFailureTrigger := func() {
		_, _ = pool.Exec(context.Background(), `
DROP TRIGGER IF EXISTS test_fail_anonymous_guard_advance
    ON public.anonymous_rate_limit_guards;
DROP FUNCTION IF EXISTS public.test_fail_anonymous_guard_advance()`)
	}
	dropFailureTrigger()
	t.Cleanup(dropFailureTrigger)
	if _, err := pool.Exec(t.Context(), `
CREATE FUNCTION public.test_fail_anonymous_guard_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.expires_at = '-infinity'::timestamptz THEN
        RAISE EXCEPTION 'forced canonical advance failure';
    END IF;
    RETURN NEW;
END
$function$;
CREATE TRIGGER test_fail_anonymous_guard_advance
BEFORE UPDATE ON public.anonymous_rate_limit_guards
FOR EACH ROW EXECUTE FUNCTION public.test_fail_anonymous_guard_advance()`); err != nil {
		t.Fatal(err)
	}

	if err := NewAnonymousRateLimiter(pool, 5, 20).Check(t.Context(), key, integrationNow()); err == nil {
		t.Fatal("check error = nil, want forced canonical advance failure")
	}

	var guardCount, bucketCount int
	if err := pool.QueryRow(t.Context(), `
SELECT
    (SELECT count(*) FROM public.anonymous_rate_limit_guards
     WHERE scope='anonymous_ip' AND key_hash=$1),
    (SELECT count(*) FROM abuse_rate_buckets
     WHERE scope='anonymous_ip_hour' AND key_hash=$1)`, key).Scan(&guardCount, &bucketCount); err != nil {
		t.Fatal(err)
	}
	if guardCount != 0 || bucketCount != 0 {
		t.Fatalf("rolled-back guard/bucket counts = %d/%d, want 0/0", guardCount, bucketCount)
	}
}

func deleteAnonymousRateLimitGuard(t *testing.T, pool *pgxpool.Pool, key []byte) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
DELETE FROM public.anonymous_rate_limit_guards
WHERE scope='anonymous_ip' AND key_hash=$1`, key); err != nil {
		t.Fatal(err)
	}
}

func prepareAnonymousRateLimitGuard(t *testing.T, pool *pgxpool.Pool, key []byte, canonicalTime time.Time) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
INSERT INTO public.anonymous_rate_limit_guards(scope,key_hash,expires_at)
VALUES ('anonymous_ip',$1,$2)`, key, canonicalTime.Add(25*time.Hour)); err != nil {
		t.Fatal(err)
	}
}

func futureCanonicalTime(t *testing.T, pool *pgxpool.Pool, offset time.Duration) time.Time {
	t.Helper()
	var databaseTime time.Time
	if err := pool.QueryRow(t.Context(), `SELECT clock_timestamp()`).Scan(&databaseTime); err != nil {
		t.Fatal(err)
	}
	return databaseTime.UTC().Truncate(time.Hour).Add(offset + 30*time.Minute)
}

func waitForAnonymousGuardLock(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		if err := pool.QueryRow(t.Context(), `
SELECT EXISTS (
    SELECT 1
    FROM pg_stat_activity
    WHERE datname=current_database()
      AND pid <> pg_backend_pid()
      AND state='active'
      AND wait_event_type='Lock'
      AND query LIKE '%INSERT INTO public.anonymous_rate_limit_guards%'
)`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("anonymous rate limiter did not wait for the held guard lock")
}
