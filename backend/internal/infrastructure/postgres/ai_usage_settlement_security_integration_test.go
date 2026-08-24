package postgres

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

const settlementSecurityUserID = "10000000-0000-7000-8000-000000000001"

func TestAIUsageSettlementExposureTriggerRejectsIdentityMutation(t *testing.T) {
	pool := integrationPool(t)
	_, _, snapshot, now, _ := seedSettlementSecurityRunningAction(t, pool)
	const otherUserID = "10000000-0000-7000-8000-000000000002"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, otherUserID, now); err != nil {
		t.Fatal(err)
	}

	for name, test := range map[string]struct {
		query     string
		arguments []any
	}{
		"unfinalized owner": {
			query:     `UPDATE ai_usage_events SET user_id=$2 WHERE operation_id=$1`,
			arguments: []any{snapshot.GenerationID, otherUserID},
		},
		"unfinalized operation": {
			query:     `UPDATE ai_usage_events SET operation_id=$2 WHERE operation_id=$1`,
			arguments: []any{snapshot.GenerationID, "83000000-0000-7000-8000-000000000002"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := pool.Exec(context.Background(), test.query, test.arguments...)
			assertPostgresSQLState(t, err, "23514")
		})
	}

	const finalizedID = "83000000-0000-7000-8000-000000000003"
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,
 provider_usage_finalized_at,quota_retain_until)
VALUES($1,$2,'goal_refine','succeeded','fake','test','goal-v2',$3,$3,$4)`,
		finalizedID, settlementSecurityUserID, now, workspace.AIUsageQuotaRetainUntil(now)); err != nil {
		t.Fatal(err)
	}
	for name, test := range map[string]struct {
		query     string
		arguments []any
	}{
		"finalized owner": {
			query:     `UPDATE ai_usage_events SET user_id=$2 WHERE operation_id=$1`,
			arguments: []any{finalizedID, otherUserID},
		},
		"finalized operation": {
			query:     `UPDATE ai_usage_events SET operation_id=$2 WHERE operation_id=$1`,
			arguments: []any{finalizedID, "83000000-0000-7000-8000-000000000004"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := pool.Exec(context.Background(), test.query, test.arguments...)
			assertPostgresSQLState(t, err, "23514")
		})
	}

	var runningOwner, finalizedOwner string
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT user_id::text FROM ai_usage_events WHERE operation_id=$1),
(SELECT user_id::text FROM ai_usage_events WHERE operation_id=$2)`,
		snapshot.GenerationID, finalizedID).Scan(&runningOwner, &finalizedOwner); err != nil {
		t.Fatal(err)
	}
	if runningOwner != settlementSecurityUserID || finalizedOwner != settlementSecurityUserID {
		t.Fatalf("usage owners after rejected identity updates = %s/%s", runningOwner, finalizedOwner)
	}
}

func TestAccountRepositoryDeleteAccountRollsBackOnSettlementMetadataMismatch(t *testing.T) {
	pool := integrationPool(t)
	_, _, snapshot, now, settings := seedSettlementSecurityRunningAction(t, pool)

	triggerDisabled := false
	if _, err := pool.Exec(context.Background(), `ALTER TABLE ai_usage_events DISABLE TRIGGER trg_ai_usage_settlement_exposure`); err != nil {
		t.Fatal(err)
	}
	triggerDisabled = true
	t.Cleanup(func() {
		if triggerDisabled {
			_, _ = pool.Exec(context.Background(), `ALTER TABLE ai_usage_events ENABLE TRIGGER trg_ai_usage_settlement_exposure`)
		}
	})
	if _, err := pool.Exec(context.Background(), `UPDATE ai_usage_events
SET settlement_reservation_cost_usd=settlement_reservation_cost_usd+0.01
WHERE operation_id=$1`, snapshot.GenerationID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `ALTER TABLE ai_usage_events ENABLE TRIGGER trg_ai_usage_settlement_exposure`); err != nil {
		t.Fatal(err)
	}
	triggerDisabled = false

	if _, err := NewAccountRepository(pool).DeleteAccount(
		context.Background(), user.ID(settlementSecurityUserID), now.Add(2*time.Minute),
	); err == nil {
		t.Fatal("DeleteAccount succeeded with mismatched settlement metadata")
	}
	assertSettlementSecurityState(t, pool, snapshot.GenerationID, 1, 1, 1,
		decimalFromTestFloat(settings.ActionAI.ReservationUSD), "0.00000000", "0.00000000")
}

func TestAccountRepositoryDeleteAccountCountsRunningGenerationAndMatchingUsageOnce(t *testing.T) {
	pool := integrationPool(t)
	_, _, snapshot, now, settings := seedSettlementSecurityRunningAction(t, pool)
	result, err := NewAccountRepository(pool).DeleteAccount(
		context.Background(), user.ID(settlementSecurityUserID), now.Add(2*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.SettlementOperationCount != 1 || result.UnattributedCostUSD <= 0 {
		t.Fatalf("delete result = %#v, want one deduplicated running operation with unattributed cost", result)
	}
	assertSettlementSecurityState(t, pool, snapshot.GenerationID, 0, 0, 0,
		"0.00000000", "0.00000000", decimalFromTestFloat(settings.ActionAI.ReservationUSD))
}

func TestAccountRepositoryDeleteAccountRollsBackOnOrphanUsageDeleteCASMiss(t *testing.T) {
	pool := integrationPool(t)
	_, _, snapshot, now, settings := seedSettlementSecurityRunningAction(t, pool)
	month := settlementSecurityMonth(now)
	if err := releaseSettlementSecurityGeneration(t, pool, snapshot.GenerationID, month, settings.ActionAI.ReservationUSD, now); err != nil {
		t.Fatal(err)
	}

	const functionName = "account_delete_suppress_orphan_usage_delete"
	const triggerName = "account_delete_suppress_orphan_usage_delete"
	if _, err := pool.Exec(context.Background(), `CREATE FUNCTION account_delete_suppress_orphan_usage_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation_id = '83000000-0000-7000-8000-000000000001'::uuid THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END
$$`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DROP TRIGGER IF EXISTS "+triggerName+" ON ai_usage_events")
		_, _ = pool.Exec(context.Background(), "DROP FUNCTION IF EXISTS "+functionName+"()")
	})
	if _, err := pool.Exec(context.Background(), `CREATE TRIGGER account_delete_suppress_orphan_usage_delete
BEFORE DELETE ON ai_usage_events
FOR EACH ROW EXECUTE FUNCTION account_delete_suppress_orphan_usage_delete()`); err != nil {
		t.Fatal(err)
	}

	result, err := NewAccountRepository(pool).DeleteAccount(
		context.Background(), user.ID(settlementSecurityUserID), now.Add(2*time.Minute),
	)
	if err == nil {
		t.Fatal("DeleteAccount succeeded after orphan Usage delete affected zero rows")
	}
	if result.SettlementOperationCount != 1 || result.UnattributedCostUSD != 0 {
		t.Fatalf("rollback delete result = %#v, want one known failed orphan settlement and no committed cost", result)
	}
	assertSettlementSecurityState(t, pool, snapshot.GenerationID, 1, 1, 1,
		"0.00000000", "0.00000000", "0.00000000")
}

func TestAccountRepositoryDeleteAccountAfterCallbackKeepsActualWithoutUnattributedCost(t *testing.T) {
	pool := integrationPool(t)
	store, _, snapshot, now, settings := seedSettlementSecurityRunningAction(t, pool)
	result := workspace.AIExecutionResult{
		Output: "精算後に削除する行動", Attempts: 1,
		Usage: workspace.AIUsage{InputTokens: 12, OutputTokens: 5,
			CostUSD: 0.004, ProviderRequestID: "provider-before-account-delete"},
	}
	if _, err := executeActionFinishUseCaseWithSettings(store, context.Background(), snapshot, result, nil, now.Add(2*time.Minute), settings); err != nil {
		t.Fatal(err)
	}
	deleteResult, err := NewAccountRepository(pool).DeleteAccount(
		context.Background(), user.ID(settlementSecurityUserID), now.Add(3*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if deleteResult.SettlementOperationCount != 0 || deleteResult.UnattributedCostUSD != 0 {
		t.Fatalf("already finalized delete result = %#v", deleteResult)
	}
	assertSettlementSecurityState(t, pool, snapshot.GenerationID, 0, 0, 0,
		"0.00000000", "0.00400000", "0.00000000")
}

func TestAccountRepositoryDeleteAccountTransfersRunningGenerationWithoutUsage(t *testing.T) {
	pool := integrationPool(t)
	_, _, snapshot, now, settings := seedSettlementSecurityRunningAction(t, pool)
	if _, err := pool.Exec(context.Background(), `DELETE FROM ai_usage_events WHERE operation_id=$1`, snapshot.GenerationID); err != nil {
		t.Fatal(err)
	}

	deleteResult, err := NewAccountRepository(pool).DeleteAccount(
		context.Background(), user.ID(settlementSecurityUserID), now.Add(2*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if deleteResult.SettlementOperationCount != 1 || deleteResult.UnattributedCostUSD <= 0 {
		t.Fatalf("running generation without usage delete result = %#v", deleteResult)
	}
	assertSettlementSecurityState(t, pool, snapshot.GenerationID, 0, 0, 0,
		"0.00000000", "0.00000000", decimalFromTestFloat(settings.ActionAI.ReservationUSD))
}

func TestOldAccountDeleteGuardRollsBackPriorReservationTransfer(t *testing.T) {
	pool := integrationPool(t)
	fixture := seedAccountDeleteReservationFixture(t, pool)
	now := integrationNow()
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
SELECT id,user_id,goal_id,operation_type,'accepted',provider,model,prompt_version,$2,$3
FROM ai_generations WHERE id=$1`, fixture.actionID, now, workspace.AIUsageQuotaRetainUntil(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd-$2::numeric WHERE month_utc=$1`, fixture.september, fixture.actionCost); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE ai_generations
SET status='failed',failure_code='goal_deleted',budget_reserved_cost_usd=0,
lease_expires_at=NULL,finished_at=$2 WHERE id=$1`, fixture.actionID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE ai_usage_events
SET status='failed',goal_id=NULL,content_deleted=true WHERE operation_id=$1`, fixture.actionID); err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var ignored string
	if err = tx.QueryRow(context.Background(), `SELECT id::text FROM users WHERE id=$1 FOR UPDATE`, fixture.userID).Scan(&ignored); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(context.Background(), `UPDATE ai_generations SET budget_reserved_cost_usd=0
WHERE user_id=$1 AND id=$2 AND status='running'`, fixture.userID, fixture.refineID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(context.Background(), `UPDATE ai_budget_monthly SET
reserved_cost_usd=reserved_cost_usd-$2::numeric,
unattributed_cost_usd=unattributed_cost_usd+$2::numeric
WHERE month_utc=$1 AND reserved_cost_usd >= $2::numeric`, fixture.august, fixture.refineCost); err != nil {
		t.Fatal(err)
	}
	_, deleteErr := tx.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, fixture.userID)
	assertPostgresSQLState(t, deleteErr, "23514")
	if err = tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}

	var users, usages int
	var actionStatus, actionReserved, refineReserved string
	if err = pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$2),
(SELECT status FROM ai_generations WHERE id=$2),
(SELECT budget_reserved_cost_usd::text FROM ai_generations WHERE id=$2),
(SELECT budget_reserved_cost_usd::text FROM ai_generations WHERE id=$3)`,
		fixture.userID, fixture.actionID, fixture.refineID).Scan(
		&users, &usages, &actionStatus, &actionReserved, &refineReserved,
	); err != nil {
		t.Fatal(err)
	}
	if users != 1 || usages != 1 || actionStatus != "failed" || actionReserved != "0.00000000" || refineReserved != "2.50000000" {
		t.Fatalf("guard rollback user/usage/action/refine = %d/%d %s/%s/%s",
			users, usages, actionStatus, actionReserved, refineReserved)
	}
	assertAccountDeleteBudget(t, context.Background(), pool, fixture.august, fixture.initialAug, fixture.initialUnat)
	assertAccountDeleteBudget(t, context.Background(), pool, fixture.september,
		fixture.initialSep-fixture.actionCost, fixture.initialUnat)
}

func seedSettlementSecurityRunningAction(
	t *testing.T,
	pool *pgxpool.Pool,
) (*WorkspaceStore, progressingGoalFixture, workspace.AISnapshot, time.Time, aiIntegrationApplicationSettings) {
	t.Helper()
	resetDatabase(t, pool)
	now := integrationNow()
	insertAIConcurrencyUser(t, pool, settlementSecurityUserID, now)
	settings := aiConcurrencySettings()
	store := NewWorkspaceStore(pool)
	fixture, _, snapshot := seedRunningActionAI(t, pool, store, settlementSecurityUserID, now, settings)
	return store, fixture, snapshot, now, settings
}

func releaseSettlementSecurityGeneration(
	t *testing.T,
	pool *pgxpool.Pool,
	operationID string,
	month time.Time,
	reservation float64,
	now time.Time,
) error {
	t.Helper()
	tx, err := pool.Begin(context.Background())
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err = tx.Exec(context.Background(), `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd-$2 WHERE month_utc=$1`, month, reservation); err != nil {
		return err
	}
	if _, err = tx.Exec(context.Background(), `UPDATE ai_generations
SET status='failed',failure_code='goal_deleted',budget_reserved_cost_usd=0,
lease_expires_at=NULL,finished_at=$2 WHERE id=$1`, operationID, now.Add(time.Minute)); err != nil {
		return err
	}
	if _, err = tx.Exec(context.Background(), `UPDATE ai_usage_events
SET status='failed',goal_id=NULL,content_deleted=true WHERE operation_id=$1`, operationID); err != nil {
		return err
	}
	return tx.Commit(context.Background())
}

func assertSettlementSecurityState(
	t *testing.T,
	pool *pgxpool.Pool,
	operationID string,
	wantUsers, wantGenerations, wantUsages int,
	wantReserved, wantActual, wantUnattributed string,
) {
	t.Helper()
	month := settlementSecurityMonth(integrationNow())
	var users, generations, usages int
	var reserved, actual, unattributed string
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM ai_generations WHERE id=$2),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$2),
(SELECT reserved_cost_usd::text FROM ai_budget_monthly WHERE month_utc=$3),
(SELECT actual_cost_usd::text FROM ai_budget_monthly WHERE month_utc=$3),
(SELECT unattributed_cost_usd::text FROM ai_budget_monthly WHERE month_utc=$3)`,
		settlementSecurityUserID, operationID, month).Scan(
		&users, &generations, &usages, &reserved, &actual, &unattributed,
	); err != nil {
		t.Fatal(err)
	}
	if users != wantUsers || generations != wantGenerations || usages != wantUsages ||
		reserved != wantReserved || actual != wantActual || unattributed != wantUnattributed {
		t.Fatalf("settlement state user/gen/usage budget = %d/%d/%d %s/%s/%s, want %d/%d/%d %s/%s/%s",
			users, generations, usages, reserved, actual, unattributed,
			wantUsers, wantGenerations, wantUsages, wantReserved, wantActual, wantUnattributed)
	}
}

func settlementSecurityMonth(now time.Time) time.Time {
	return time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
}

func decimalFromTestFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', 8, 64)
}
