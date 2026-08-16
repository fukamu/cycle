package postgres

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

func TestAnonymousCreationTransactionAndReplay(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	repository := NewSessionRepository(pool)
	input := anonymousInput(1, 2, 3, 1)

	created, err := repository.CreateOrResumeAnonymous(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	replayInput := anonymousInput(4, 5, 6, 1)
	replayed, err := repository.CreateOrResumeAnonymous(context.Background(), replayInput)
	if err != nil {
		t.Fatal(err)
	}
	if !created.Created || replayed.Created || created.UserID != replayed.UserID || created.ActiveCycleID != replayed.ActiveCycleID {
		t.Fatalf("created/replayed = %#v/%#v", created, replayed)
	}
	assertCount(t, pool, "users", 1)
	assertCount(t, pool, "pdca_cycles", 1)
	assertCount(t, pool, "sessions", 2)
}

func TestAnonymousCreationRollsBackUserWhenCycleInsertFails(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	ctx := context.Background()
	now := integrationNow()
	duplicateCycleID := uuid(2)
	_, err := pool.Exec(ctx, `INSERT INTO users (id, last_active_at, created_at, updated_at) VALUES ($1, $2, $2, $2)`, uuid(99), now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
INSERT INTO pdca_cycles (id, user_id, sequence_number, status, started_at, created_at, updated_at)
VALUES ($1, $2, 1, 'active', $3, $3, $3)`, duplicateCycleID, uuid(99), now)
	if err != nil {
		t.Fatal(err)
	}

	input := anonymousInput(1, 2, 3, 1)
	input.CycleID = duplicateCycleID
	_, err = NewSessionRepository(pool).CreateOrResumeAnonymous(ctx, input)
	if err == nil {
		t.Fatal("expected duplicate cycle ID failure")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, string(input.UserID)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled-back user count/error = %d/%v", count, err)
	}
}

func TestActiveCycleUniqueConstraint(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	input := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(context.Background(), `
INSERT INTO pdca_cycles (id, user_id, sequence_number, status, started_at, created_at, updated_at)
VALUES ($1, $2, 2, 'active', $3, $3, $3)`, uuid(7), string(input.UserID), integrationNow())
	if err == nil {
		t.Fatal("expected one-active-cycle unique violation")
	}
}

func TestFrameRevisionConcurrency(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	input := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	repository := NewCycleRepository(pool)
	base := appcycle.SaveFrameInput{UserID: input.UserID, CycleID: domaincycle.ID(input.CycleID), Frame: domaincycle.FramePlan, ExpectedFrameRevision: 0, Now: integrationNow()}
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, content := range []string{"first", "second"} {
		wait.Add(1)
		go func(value string) {
			defer wait.Done()
			request := base
			request.Content = value
			_, err := repository.SaveFrame(context.Background(), request)
			results <- err
		}(content)
	}
	wait.Wait()
	close(results)
	var successes, conflicts int
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, domaincycle.ErrRevisionConflict) {
			conflicts++
		} else {
			t.Fatalf("unexpected save error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes/conflicts = %d/%d", successes, conflicts)
	}
}

func TestDifferentFrameSavesBothSucceed(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	input := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	repository := NewCycleRepository(pool)
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, item := range []struct {
		frame   domaincycle.Frame
		content string
	}{{domaincycle.FramePlan, "plan"}, {domaincycle.FrameDo, "do"}} {
		wait.Add(1)
		go func(frame domaincycle.Frame, content string) {
			defer wait.Done()
			_, err := repository.SaveFrame(context.Background(), appcycle.SaveFrameInput{
				UserID: input.UserID, CycleID: domaincycle.ID(input.CycleID), Frame: frame,
				Content: content, ExpectedFrameRevision: 0, Now: integrationNow(),
			})
			results <- err
		}(item.frame, item.content)
	}
	wait.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	active, err := repository.GetActive(context.Background(), input.UserID)
	if err != nil || active.Plan != "plan" || active.Do != "do" || active.ContentRevision != 2 {
		t.Fatalf("active/error = %#v/%v", active, err)
	}
}

func TestCompleteIsAtomicAndIdempotent(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	input := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE pdca_cycles SET plan='p', do_text='d', check_text='c', action='a' WHERE id=$1`, input.CycleID); err != nil {
		t.Fatal(err)
	}
	repository := NewCycleRepository(pool)
	request := appcycle.CompleteInput{
		UserID: input.UserID, CycleID: domaincycle.ID(input.CycleID), NextCycleID: domaincycle.ID(uuid(7)),
		OperationID: domaincycle.OperationID(uuid(8)), ExpectedContentRevision: 0, Now: integrationNow(),
	}
	first, err := repository.Complete(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	retry := request
	retry.NextCycleID = domaincycle.ID(uuid(9))
	second, err := repository.Complete(ctx, retry)
	if err != nil {
		t.Fatal(err)
	}
	if first.Completed.ID != second.Completed.ID || first.Next.ID != second.Next.ID || !first.Next.StartedAt.Equal(*first.Completed.CompletedAt) {
		t.Fatalf("first/second = %#v/%#v", first, second)
	}
	var activeCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND status='active'`, string(input.UserID)).Scan(&activeCount); err != nil || activeCount != 1 {
		t.Fatalf("active count/error = %d/%v", activeCount, err)
	}
}

func TestCompleteRollbackWhenNextInsertFails(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	input := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE pdca_cycles SET plan='p', do_text='d', check_text='c', action='a' WHERE id=$1`, input.CycleID); err != nil {
		t.Fatal(err)
	}
	_, err := NewCycleRepository(pool).Complete(ctx, appcycle.CompleteInput{
		UserID: input.UserID, CycleID: domaincycle.ID(input.CycleID), NextCycleID: domaincycle.ID(input.CycleID),
		OperationID: domaincycle.OperationID(uuid(8)), ExpectedContentRevision: 0, Now: integrationNow(),
	})
	if err == nil {
		t.Fatal("expected next insert failure")
	}
	var status string
	var completedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT status, completed_at FROM pdca_cycles WHERE id=$1`, input.CycleID).Scan(&status, &completedAt); err != nil || status != "active" || completedAt != nil {
		t.Fatalf("cycle after rollback = %s/%v/%v", status, completedAt, err)
	}
}

func TestConcurrentCompleteCreatesExactlyOneNextCycle(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	input := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE pdca_cycles SET plan='p', do_text='d', check_text='c', action='a' WHERE id=$1`, input.CycleID); err != nil {
		t.Fatal(err)
	}
	repository := NewCycleRepository(pool)
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for index := 0; index < 2; index++ {
		wait.Add(1)
		go func(offset int) {
			defer wait.Done()
			_, err := repository.Complete(ctx, appcycle.CompleteInput{
				UserID: input.UserID, CycleID: domaincycle.ID(input.CycleID),
				NextCycleID: domaincycle.ID(uuid(10 + offset)), OperationID: domaincycle.OperationID(uuid(20 + offset)),
				ExpectedContentRevision: 0, Now: integrationNow(),
			})
			results <- err
		}(index)
	}
	wait.Wait()
	close(results)
	var successes, conflicts int
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, domaincycle.ErrCycleNotActive) || errors.Is(err, domaincycle.ErrRevisionConflict) {
			conflicts++
		} else {
			t.Fatalf("unexpected complete error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes/conflicts = %d/%d", successes, conflicts)
	}
	assertCount(t, pool, "pdca_cycles", 2)
	var activeCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND status='active'`, string(input.UserID)).Scan(&activeCount); err != nil || activeCount != 1 {
		t.Fatalf("active count/error = %d/%v", activeCount, err)
	}
}

func TestCompletedCycleSaveIsRejected(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	input := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE pdca_cycles SET status='completed', completed_at=$2 WHERE id=$1`, input.CycleID, integrationNow()); err != nil {
		t.Fatal(err)
	}
	_, err := NewCycleRepository(pool).SaveFrame(ctx, appcycle.SaveFrameInput{
		UserID: input.UserID, CycleID: domaincycle.ID(input.CycleID), Frame: domaincycle.FramePlan,
		Content: "changed", ExpectedFrameRevision: 0, Now: integrationNow(),
	})
	if !errors.Is(err, domaincycle.ErrCycleNotActive) {
		t.Fatalf("completed save error = %v", err)
	}
}

func TestCrossUserCycleLookupReturnsNotFound(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	first := anonymousInput(1, 2, 3, 1)
	second := anonymousInput(4, 5, 6, 2)
	repository := NewSessionRepository(pool)
	if _, err := repository.CreateOrResumeAnonymous(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.CreateOrResumeAnonymous(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	_, err := NewCycleRepository(pool).GetOwned(context.Background(), second.UserID, domaincycle.ID(first.CycleID))
	if !errors.Is(err, appcycle.ErrCycleNotFound) {
		t.Fatalf("cross-user error = %v", err)
	}
}

func integrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func resetDatabase(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	for _, name := range []string{"000001_init.down.sql", "000001_init.up.sql"} {
		path := filepath.Join("..", "..", "..", "migrations", name)
		script, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		connection, err := pool.Acquire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		results, execErr := connection.Conn().PgConn().Exec(context.Background(), string(script)).ReadAll()
		connection.Release()
		if execErr != nil {
			t.Fatal(execErr)
		}
		for _, result := range results {
			if result.Err != nil {
				t.Fatal(result.Err)
			}
		}
	}
}

func anonymousInput(userNumber, cycleNumber, sessionNumber, bootstrapNumber int) appsession.CreateAnonymousRecord {
	now := integrationNow()
	return appsession.CreateAnonymousRecord{
		BootstrapKeyHash: []byte{byte(bootstrapNumber)}, BootstrapExpires: now.Add(10 * time.Minute),
		UserID: user.ID(uuid(userNumber)), CycleID: uuid(cycleNumber), SessionID: uuid(sessionNumber),
		SessionTokenHash: []byte{byte(sessionNumber), 1}, CSRFTokenHash: []byte{byte(sessionNumber), 2},
		Now: now, IdleExpiresAt: now.Add(30 * 24 * time.Hour), AbsoluteExpiresAt: now.Add(180 * 24 * time.Hour),
	}
}

func integrationNow() time.Time {
	return time.Date(2026, time.August, 16, 0, 0, 0, 0, time.UTC)
}

func uuid(number int) string {
	return "00000000-0000-4000-8000-" + leftPad(number)
}

func leftPad(number int) string {
	const digits = "000000000000"
	raw := []byte(digits)
	for index := len(raw) - 1; number > 0 && index >= 0; index-- {
		raw[index] = byte('0' + number%10)
		number /= 10
	}
	return string(raw)
}

func assertCount(t *testing.T, pool *pgxpool.Pool, table string, expected int) {
	t.Helper()
	allowed := map[string]bool{"users": true, "pdca_cycles": true, "sessions": true}
	if !allowed[table] {
		t.Fatalf("invalid test table %q", table)
	}
	var count int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != expected {
		t.Fatalf("%s count/error = %d/%v, want %d", table, count, err, expected)
	}
}
