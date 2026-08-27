package workspace

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

var (
	goalDeleteTestNow = time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	goalDeleteUserID  = "10000000-0000-7000-8000-000000000001"
	goalDeleteGoalID  = "30000000-0000-7000-8000-000000000001"
	goalDeleteKey     = "87000000-0000-7000-8000-000000000001"
)

type goalDeleteFakeClock struct{ now time.Time }

func (clock goalDeleteFakeClock) Now() time.Time { return clock.now }

type goalDeleteFakeUOW struct {
	tx         *goalDeleteFakeTx
	committed  int
	rolledBack int
	called     int
}

func (uow *goalDeleteFakeUOW) WithinGoalTransaction(_ context.Context, operation func(GoalTx) error) error {
	uow.called++
	err := operation(uow.tx)
	if err != nil {
		uow.rolledBack++
		return err
	}
	uow.committed++
	return nil
}

type goalDeleteFakeTx struct {
	trace       []string
	receipt     *GoalDeleteReceipt
	target      GoalDeleteTarget
	draftIDs    []string
	cycleIDs    []string
	generations []GoalDeleteGeneration
	usages      []GoalDeleteUsage
	monthly     []MonthlyReservation
	fail        map[string]error
	rows        map[string]int64
	inserted    *GoalDeleteReceiptRecord
	redactedIDs []string
	deletedIDs  []string
}

func newGoalDeleteFakeTx() *goalDeleteFakeTx {
	return &goalDeleteFakeTx{
		target: GoalDeleteTarget{Revision: 7},
		fail:   map[string]error{},
		rows:   map[string]int64{},
	}
}

func (tx *goalDeleteFakeTx) step(name string) error {
	tx.trace = append(tx.trace, name)
	return tx.fail[name]
}

func (tx *goalDeleteFakeTx) affected(name string, fallback int64) (int64, error) {
	if err := tx.step(name); err != nil {
		return 0, err
	}
	if rows, ok := tx.rows[name]; ok {
		return rows, nil
	}
	return fallback, nil
}

func (tx *goalDeleteFakeTx) LockUser(context.Context, string) error {
	return tx.step("lock_user")
}

func (tx *goalDeleteFakeTx) FindGoalDeleteReceipt(context.Context, string, string) (*GoalDeleteReceipt, error) {
	if err := tx.step("find_receipt"); err != nil {
		return nil, err
	}
	return tx.receipt, nil
}

func (tx *goalDeleteFakeTx) LockGoalForDelete(context.Context, string, string) (GoalDeleteTarget, error) {
	if err := tx.step("lock_goal"); err != nil {
		return GoalDeleteTarget{}, err
	}
	return tx.target, nil
}

func (tx *goalDeleteFakeTx) LockGoalDraftIDs(context.Context, string, string) ([]string, error) {
	if err := tx.step("lock_drafts"); err != nil {
		return nil, err
	}
	return tx.draftIDs, nil
}

func (tx *goalDeleteFakeTx) LockGoalCycleIDs(context.Context, string, string) ([]string, error) {
	if err := tx.step("lock_cycles"); err != nil {
		return nil, err
	}
	return tx.cycleIDs, nil
}

func (tx *goalDeleteFakeTx) LockRunningGoalGenerations(context.Context, string, string) ([]GoalDeleteGeneration, error) {
	if err := tx.step("lock_generations"); err != nil {
		return nil, err
	}
	return tx.generations, nil
}

func (tx *goalDeleteFakeTx) LockGoalUsages(context.Context, string, string) ([]GoalDeleteUsage, error) {
	if err := tx.step("lock_usages"); err != nil {
		return nil, err
	}
	return tx.usages, nil
}

func (tx *goalDeleteFakeTx) SumLockedGoalReservationsByMonth(context.Context, string, string, []string) ([]MonthlyReservation, error) {
	if err := tx.step("sum_reservations"); err != nil {
		return nil, err
	}
	return tx.monthly, nil
}

func (tx *goalDeleteFakeTx) ReleaseGoalBudgetReservationCAS(context.Context, time.Time, string, time.Time) (int64, error) {
	return tx.affected("release_budget", 1)
}

func (tx *goalDeleteFakeTx) TerminalizeGoalGenerationCAS(_ context.Context, _, _ string, generation GoalDeleteGeneration, _ time.Time) (int64, error) {
	return tx.affected("terminal_generation:"+generation.ID, 1)
}

func (tx *goalDeleteFakeTx) FailRunningGoalUsageCAS(_ context.Context, _, _, operationID string) (int64, error) {
	return tx.affected("fail_usage:"+operationID, 1)
}

func (tx *goalDeleteFakeTx) RedactGoalUsagesCAS(_ context.Context, _, _ string, operationIDs []string) (int64, error) {
	tx.redactedIDs = append([]string(nil), operationIDs...)
	return tx.affected("redact_usages", int64(len(operationIDs)))
}

func (tx *goalDeleteFakeTx) DeleteExpiredFinalizedGoalUsagesCAS(_ context.Context, _, _ string, operationIDs []string, _ time.Time) (int64, error) {
	tx.deletedIDs = append([]string(nil), operationIDs...)
	return tx.affected("delete_usages", int64(len(operationIDs)))
}

func (tx *goalDeleteFakeTx) DeleteGoalCAS(context.Context, string, string, int64) (int64, error) {
	return tx.affected("delete_goal", 1)
}

func (tx *goalDeleteFakeTx) InsertGoalDeleteReceipt(_ context.Context, record GoalDeleteReceiptRecord) (int64, error) {
	tx.inserted = &record
	return tx.affected("insert_receipt", 1)
}

func newGoalDeleteTestUseCases(tx *goalDeleteFakeTx) (*GoalUseCases, *goalDeleteFakeUOW) {
	uow := &goalDeleteFakeUOW{tx: tx}
	return NewGoalUseCases(nil, uow, goalDeleteFakeClock{now: goalDeleteTestNow}, GoalUseCaseSettings{}), uow
}

func goalDeleteRequestHash(goalID string, confirmed bool, revision int64) string {
	return hashRequest(struct {
		GoalID    string `json:"goalId"`
		Confirmed bool   `json:"confirmed"`
		Revision  int64  `json:"revision"`
	}{goalID, confirmed, revision})
}

func TestGoalUseCasesDeleteOwnsLockOrderRetentionAndExactMutations(t *testing.T) {
	finalized := goalDeleteTestNow.Add(-time.Minute)
	tx := newGoalDeleteFakeTx()
	tx.draftIDs = []string{"41000000-0000-7000-8000-000000000001"}
	tx.cycleIDs = []string{"51000000-0000-7000-8000-000000000001"}
	tx.generations = []GoalDeleteGeneration{{
		ID: "61000000-0000-7000-8000-000000000001", ReservedCostUSD: "0.10000000",
	}}
	tx.monthly = []MonthlyReservation{{
		MonthUtc: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), AmountUSD: "0.10000000",
	}}
	tx.usages = []GoalDeleteUsage{
		{OperationID: "62000000-0000-7000-8000-000000000001", Status: "succeeded", QuotaRetainUntil: goalDeleteTestNow.Add(time.Nanosecond), ProviderUsageFinalizedAt: &finalized},
		{OperationID: "62000000-0000-7000-8000-000000000002", Status: "succeeded", QuotaRetainUntil: goalDeleteTestNow, ProviderUsageFinalizedAt: &finalized},
		{OperationID: "62000000-0000-7000-8000-000000000003", Status: "failed", QuotaRetainUntil: goalDeleteTestNow.Add(-time.Hour)},
	}
	useCases, uow := newGoalDeleteTestUseCases(tx)

	if err := useCases.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, true, 7, goalDeleteKey); err != nil {
		t.Fatalf("DeleteGoal: %v", err)
	}
	wantTrace := []string{
		"lock_user", "find_receipt", "lock_goal", "lock_drafts", "lock_cycles", "lock_generations",
		"sum_reservations", "release_budget",
		"terminal_generation:61000000-0000-7000-8000-000000000001",
		"fail_usage:61000000-0000-7000-8000-000000000001",
		"lock_usages", "redact_usages", "delete_usages", "delete_goal", "insert_receipt",
	}
	if !reflect.DeepEqual(tx.trace, wantTrace) {
		t.Fatalf("trace = %#v, want %#v", tx.trace, wantTrace)
	}
	if !reflect.DeepEqual(tx.redactedIDs, []string{
		"62000000-0000-7000-8000-000000000001",
		"62000000-0000-7000-8000-000000000003",
	}) {
		t.Fatalf("redacted usage IDs = %#v", tx.redactedIDs)
	}
	if !reflect.DeepEqual(tx.deletedIDs, []string{"62000000-0000-7000-8000-000000000002"}) {
		t.Fatalf("deleted usage IDs = %#v", tx.deletedIDs)
	}
	if uow.committed != 1 || uow.rolledBack != 0 || tx.inserted == nil {
		t.Fatalf("transaction = commit %d rollback %d receipt %#v", uow.committed, uow.rolledBack, tx.inserted)
	}
	if tx.inserted.ExpiresAt != goalDeleteTestNow.Add(24*time.Hour) {
		t.Fatalf("receipt expiry = %v", tx.inserted.ExpiresAt)
	}
}

func TestGoalUseCasesDeleteReceiptAndPublicErrorPrecedence(t *testing.T) {
	t.Run("confirmation before transaction", func(t *testing.T) {
		tx := newGoalDeleteFakeTx()
		useCases, uow := newGoalDeleteTestUseCases(tx)
		err := useCases.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, false, 7, goalDeleteKey)
		if !errors.Is(err, ErrDeleteConfirmation) || uow.called != 0 {
			t.Fatalf("error = %v, transactions = %d", err, uow.called)
		}
	})

	t.Run("active replay before Goal lookup", func(t *testing.T) {
		tx := newGoalDeleteFakeTx()
		tx.receipt = &GoalDeleteReceipt{
			GoalID: goalDeleteGoalID, RequestHash: goalDeleteRequestHash(goalDeleteGoalID, true, 7),
			ExpiresAt: goalDeleteTestNow.Add(time.Minute),
		}
		useCases, uow := newGoalDeleteTestUseCases(tx)
		if err := useCases.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, true, 7, goalDeleteKey); err != nil {
			t.Fatalf("replay: %v", err)
		}
		if !reflect.DeepEqual(tx.trace, []string{"lock_user", "find_receipt"}) || uow.committed != 1 {
			t.Fatalf("trace/commit = %#v/%d", tx.trace, uow.committed)
		}
	})

	t.Run("different hash remains reused after expiry", func(t *testing.T) {
		tx := newGoalDeleteFakeTx()
		tx.receipt = &GoalDeleteReceipt{
			GoalID: goalDeleteGoalID, RequestHash: "different", ExpiresAt: goalDeleteTestNow,
		}
		useCases, uow := newGoalDeleteTestUseCases(tx)
		err := useCases.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, true, 7, goalDeleteKey)
		if !errors.Is(err, ErrIdempotencyKeyReused) || uow.rolledBack != 1 {
			t.Fatalf("error/rollback = %v/%d", err, uow.rolledBack)
		}
	})

	t.Run("expired matching receipt no longer replays", func(t *testing.T) {
		tx := newGoalDeleteFakeTx()
		tx.receipt = &GoalDeleteReceipt{
			GoalID: goalDeleteGoalID, RequestHash: goalDeleteRequestHash(goalDeleteGoalID, true, 7),
			ExpiresAt: goalDeleteTestNow,
		}
		tx.fail["lock_goal"] = ErrNotFound
		useCases, uow := newGoalDeleteTestUseCases(tx)
		err := useCases.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, true, 7, goalDeleteKey)
		if !errors.Is(err, ErrNotFound) || uow.rolledBack != 1 {
			t.Fatalf("error/rollback = %v/%d", err, uow.rolledBack)
		}
	})

	t.Run("revision conflict before child locks", func(t *testing.T) {
		tx := newGoalDeleteFakeTx()
		tx.target.Revision = 8
		useCases, uow := newGoalDeleteTestUseCases(tx)
		err := useCases.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, true, 7, goalDeleteKey)
		if !errors.Is(err, ErrDeleteConflict) || uow.rolledBack != 1 {
			t.Fatalf("error/rollback = %v/%d", err, uow.rolledBack)
		}
		if strings.Join(tx.trace, ",") != "lock_user,find_receipt,lock_goal" {
			t.Fatalf("trace = %#v", tx.trace)
		}
	})
}

func TestGoalUseCasesDeleteRequiresEveryCASAndStrictLockOrder(t *testing.T) {
	valid := func() *goalDeleteFakeTx {
		tx := newGoalDeleteFakeTx()
		tx.generations = []GoalDeleteGeneration{{ID: "61000000-0000-7000-8000-000000000001", ReservedCostUSD: "0.10000000"}}
		tx.monthly = []MonthlyReservation{{MonthUtc: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), AmountUSD: "0.10000000"}}
		finalized := goalDeleteTestNow
		tx.usages = []GoalDeleteUsage{
			{OperationID: "62000000-0000-7000-8000-000000000001", Status: "succeeded", QuotaRetainUntil: goalDeleteTestNow.Add(time.Nanosecond), ProviderUsageFinalizedAt: &finalized},
			{OperationID: "62000000-0000-7000-8000-000000000002", Status: "succeeded", QuotaRetainUntil: goalDeleteTestNow, ProviderUsageFinalizedAt: &finalized},
		}
		return tx
	}
	for _, step := range []string{
		"release_budget", "terminal_generation:61000000-0000-7000-8000-000000000001",
		"fail_usage:61000000-0000-7000-8000-000000000001", "redact_usages", "delete_usages", "delete_goal", "insert_receipt",
	} {
		t.Run(step, func(t *testing.T) {
			tx := valid()
			tx.rows[step] = 0
			useCases, uow := newGoalDeleteTestUseCases(tx)
			err := useCases.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, true, 7, goalDeleteKey)
			if !errors.Is(err, ErrGoalPersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 {
				t.Fatalf("error/transaction = %v/%d/%d", err, uow.rolledBack, uow.committed)
			}
		})
	}

	invalid := []struct {
		name   string
		mutate func(*goalDeleteFakeTx)
	}{
		{"draft order", func(tx *goalDeleteFakeTx) { tx.draftIDs = []string{"b", "a"} }},
		{"cycle duplicate", func(tx *goalDeleteFakeTx) { tx.cycleIDs = []string{"a", "a"} }},
		{"generation order", func(tx *goalDeleteFakeTx) {
			tx.generations = []GoalDeleteGeneration{{ID: "b", ReservedCostUSD: "1"}, {ID: "a", ReservedCostUSD: "1"}}
		}},
		{"budget month duplicate", func(tx *goalDeleteFakeTx) {
			month := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
			tx.monthly = []MonthlyReservation{{MonthUtc: month, AmountUSD: "1"}, {MonthUtc: month, AmountUSD: "1"}}
		}},
		{"budget nonpositive", func(tx *goalDeleteFakeTx) {
			tx.monthly = []MonthlyReservation{{MonthUtc: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), AmountUSD: "0"}}
		}},
		{"usage order", func(tx *goalDeleteFakeTx) {
			tx.usages = []GoalDeleteUsage{
				{OperationID: "b", Status: "failed", QuotaRetainUntil: goalDeleteTestNow},
				{OperationID: "a", Status: "failed", QuotaRetainUntil: goalDeleteTestNow},
			}
		}},
	}
	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			tx := newGoalDeleteFakeTx()
			test.mutate(tx)
			useCases, uow := newGoalDeleteTestUseCases(tx)
			err := useCases.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, true, 7, goalDeleteKey)
			if !errors.Is(err, ErrGoalPersistenceInvariant) || uow.rolledBack != 1 {
				t.Fatalf("error/rollback = %v/%d", err, uow.rolledBack)
			}
		})
	}
}
