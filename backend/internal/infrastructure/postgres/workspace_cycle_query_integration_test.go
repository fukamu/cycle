package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type cycleQuerySnapshotContextKey struct{}

type cycleQuerySnapshotTracer struct{}

type cycleQuerySnapshotBarrier struct {
	secondReadStarted chan struct{}
	releaseSecondRead chan struct{}
	startedOnce       sync.Once
	releaseOnce       sync.Once
}

func newCycleQuerySnapshotBarrier() *cycleQuerySnapshotBarrier {
	return &cycleQuerySnapshotBarrier{
		secondReadStarted: make(chan struct{}),
		releaseSecondRead: make(chan struct{}),
	}
}

func (*cycleQuerySnapshotTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	barrier, ok := ctx.Value(cycleQuerySnapshotContextKey{}).(*cycleQuerySnapshotBarrier)
	if !ok || barrier == nil || !isCycleSnapshotSecondRead(data.SQL) {
		return ctx
	}
	barrier.startedOnce.Do(func() { close(barrier.secondReadStarted) })
	select {
	case <-barrier.releaseSecondRead:
	case <-ctx.Done():
	}
	return ctx
}

func (*cycleQuerySnapshotTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
}

func (barrier *cycleQuerySnapshotBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseSecondRead) })
}

func isCycleSnapshotSecondRead(sql string) bool {
	normalized := normalizeObservedSQL(sql)
	return strings.Contains(normalized, " from pdca_cycles c ") &&
		(strings.HasPrefix(normalized, "select c.id,c.sequence_number,") ||
			strings.HasPrefix(normalized, "select c.id,c.goal_id,"))
}

func TestCycleQueryApplicationOwnsPaginationNullableRowsAndOwnerErrors(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		ownerID    = "10000000-0000-7000-8000-000000000001"
		outsiderID = "10000000-0000-7000-8000-000000000002"
		completed  = "42000000-0000-7000-8000-000000000002"
		canceled   = "42000000-0000-7000-8000-000000000003"
	)
	insertAIConcurrencyUser(t, pool, ownerID, now)
	insertAIConcurrencyUser(t, pool, outsiderID, now)
	store := NewWorkspaceStore(pool)
	fixtures := progressingGoalFixtures()
	first := startProgressingGoal(t, store, ownerID, fixtures[0], 3, now.Add(-3*time.Hour))
	second := startProgressingGoal(t, store, ownerID, fixtures[1], 3, now.Add(-2*time.Hour))
	_ = startProgressingGoal(t, store, outsiderID, fixtures[2], 3, now.Add(-time.Hour))

	longPlan := strings.Repeat("計", 130)
	statements := []struct {
		sql  string
		args []any
	}{
		{
			`UPDATE pdca_cycles SET plan=$2,plan_revision=1,content_revision=1,updated_at=$3 WHERE id=$1`,
			[]any{fixtures[0].cycleID, longPlan, now.Add(-150 * time.Minute)},
		},
		{
			`INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,completed_at,
 plan,do_text,check_text,action,content_revision,plan_revision,do_revision,check_revision,action_revision,
 start_operation_id,start_request_hash,completion_operation_id,completion_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,2,'completed',$5,$6,'P','D','C','A',4,1,1,1,1,$7,'start-2',$8,'complete-2',$5,$6)`,
			[]any{completed, ownerID, fixtures[0].goalID, fixtures[0].versionID, now.Add(-2 * time.Hour), now.Add(-90 * time.Minute),
				"52000000-0000-7000-8000-000000000002", "62000000-0000-7000-8000-000000000002"},
		},
		{
			`INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,canceled_at,cancellation_reason,
 start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,3,'canceled',$5,$6,'goal_ended',$7,'start-3',$5,$6)`,
			[]any{canceled, ownerID, fixtures[0].goalID, fixtures[0].versionID, now.Add(-time.Hour), now.Add(-30 * time.Minute),
				"52000000-0000-7000-8000-000000000003"},
		},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(context.Background(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	useCases := newCycleApplicationTestUseCases(store, now)
	page, err := useCases.ListCycles(context.Background(), ownerID, fixtures[0].goalID, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Items[0].ID != canceled || page.Items[1].ID != completed || page.NextCursor == nil {
		t.Fatalf("first Cycle page = %#v", page)
	}
	if page.Items[0].CompletedAt != nil || page.Items[0].CanceledAt == nil ||
		page.Items[1].CompletedAt == nil || page.Items[1].CanceledAt != nil {
		t.Fatalf("terminal nullable fields = %#v / %#v", page.Items[0], page.Items[1])
	}
	last, err := useCases.ListCycles(context.Background(), ownerID, fixtures[0].goalID, *page.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(last.Items) != 1 || last.Items[0].ID != fixtures[0].cycleID || last.NextCursor != nil ||
		last.Items[0].CompletedAt != nil || last.Items[0].CanceledAt != nil || len([]rune(last.Items[0].PlanPreview)) != 121 {
		t.Fatalf("last Cycle page = %#v", last)
	}

	active, err := useCases.GetCycle(context.Background(), ownerID, fixtures[0].goalID, fixtures[0].cycleID)
	if err != nil || active.ID != fixtures[0].cycleID || active.CompletedAt != nil || active.CanceledAt != nil ||
		active.ContentRevision != 1 || active.FrameRevisions.Plan != 1 {
		t.Fatalf("active Cycle = %#v, error = %v", active, err)
	}

	assertCycleQueryError(t, workspace.ErrGoalNotFound, func() error {
		_, queryErr := useCases.ListCycles(context.Background(), outsiderID, fixtures[0].goalID, "", 20)
		return queryErr
	})
	assertCycleQueryError(t, workspace.ErrGoalNotFound, func() error {
		_, queryErr := useCases.GetCycle(context.Background(), outsiderID, fixtures[0].goalID, fixtures[0].cycleID)
		return queryErr
	})
	assertCycleQueryError(t, workspace.ErrCycleNotFound, func() error {
		_, queryErr := useCases.GetCycle(context.Background(), ownerID, fixtures[0].goalID, second.Cycle.ID)
		return queryErr
	})
	assertCycleQueryError(t, workspace.ErrCycleNotFound, func() error {
		_, queryErr := useCases.GetCycle(context.Background(), ownerID, fixtures[0].goalID, "49000000-0000-7000-8000-000000000099")
		return queryErr
	})
	if first.Cycle.ID != fixtures[0].cycleID {
		t.Fatalf("first seeded Cycle = %#v", first.Cycle)
	}
}

func TestCycleQueryUsesOneSnapshotAcrossGoalDelete(t *testing.T) {
	tests := []struct {
		name   string
		invoke func(context.Context, *WorkspaceStore, progressingGoalFixture) (string, error)
	}{
		{
			name: "list",
			invoke: func(ctx context.Context, store *WorkspaceStore, fixture progressingGoalFixture) (string, error) {
				rows, err := store.QueryCycleRows(ctx, workspace.CycleListQuery{
					UserID: "10000000-0000-7000-8000-000000000001", GoalID: fixture.goalID, FetchLimit: 20,
				})
				if err != nil {
					return "", err
				}
				if len(rows) != 1 {
					return "", fmt.Errorf("Cycle rows length = %d, want 1", len(rows))
				}
				return rows[0].ID, nil
			},
		},
		{
			name: "get",
			invoke: func(ctx context.Context, store *WorkspaceStore, fixture progressingGoalFixture) (string, error) {
				view, err := store.QueryCycle(ctx,
					"10000000-0000-7000-8000-000000000001", fixture.goalID, fixture.cycleID)
				return view.ID, err
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertCycleQuerySnapshotAcrossGoalDelete(t, test.invoke)
		})
	}
}

func assertCycleQuerySnapshotAcrossGoalDelete(
	t *testing.T,
	invoke func(context.Context, *WorkspaceStore, progressingGoalFixture) (string, error),
) {
	t.Helper()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	fixture := progressingGoalFixtures()[0]
	baseStore := NewWorkspaceStore(pool)
	_ = startProgressingGoal(t, baseStore, userID, fixture, 2, now)

	config := pool.Config()
	config.ConnConfig.Tracer = &cycleQuerySnapshotTracer{}
	config.MinConns = 0
	config.MaxConns = 1
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tracedPool.Close)
	tracedStore := NewWorkspaceStore(tracedPool)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	barrier := newCycleQuerySnapshotBarrier()
	defer barrier.release()
	type queryResult struct {
		cycleID string
		err     error
	}
	results := make(chan queryResult, 1)
	go func() {
		queryCtx := context.WithValue(ctx, cycleQuerySnapshotContextKey{}, barrier)
		cycleID, queryErr := invoke(queryCtx, tracedStore, fixture)
		results <- queryResult{cycleID: cycleID, err: queryErr}
	}()

	select {
	case <-barrier.secondReadStarted:
	case <-ctx.Done():
		t.Fatalf("Cycle query did not reach its second read: %v", ctx.Err())
	}
	command, err := pool.Exec(ctx, `DELETE FROM goals WHERE id=$1 AND user_id=$2`, fixture.goalID, userID)
	if err != nil {
		t.Fatal(err)
	}
	if command.RowsAffected() != 1 {
		t.Fatalf("deleted Goal rows = %d, want 1", command.RowsAffected())
	}
	barrier.release()

	select {
	case result := <-results:
		if result.err != nil || result.cycleID != fixture.cycleID {
			t.Fatalf("snapshot Cycle = %q, error = %v", result.cycleID, result.err)
		}
	case <-ctx.Done():
		t.Fatalf("Cycle query did not finish: %v", ctx.Err())
	}
	if _, err = invoke(ctx, baseStore, fixture); !errors.Is(err, workspace.ErrGoalNotFound) {
		t.Fatalf("post-delete Cycle query error = %v, want %v", err, workspace.ErrGoalNotFound)
	}
	var goalCount, cycleCount int
	if err = pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM goals WHERE id=$1 AND user_id=$2),
(SELECT count(*) FROM pdca_cycles WHERE id=$3 AND goal_id=$1 AND user_id=$2)`,
		fixture.goalID, userID, fixture.cycleID).Scan(&goalCount, &cycleCount); err != nil {
		t.Fatal(err)
	}
	if goalCount != 0 || cycleCount != 0 {
		t.Fatalf("post-delete Goal/Cycle counts = %d/%d, want 0/0", goalCount, cycleCount)
	}
}

func assertCycleQueryError(t *testing.T, expected error, invoke func() error) {
	t.Helper()
	if err := invoke(); !errors.Is(err, expected) {
		t.Fatalf("Cycle query error = %v, want %v", err, expected)
	}
}
