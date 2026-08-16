package postgres

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

func TestAIGenerationLifecyclePreservesConcurrentPlanEditAndIsIdempotent(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	userRecord := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), userRecord); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE pdca_cycles SET
plan='plan', do_text='do', check_text='check', content_revision=3,
plan_revision=1, do_revision=1, check_revision=1 WHERE id=$1`, userRecord.CycleID); err != nil {
		t.Fatal(err)
	}
	repository := NewAIRepository(pool)
	startInput := integrationAIStart(userRecord, 10, 11, 12, integrationNow())
	startInput.ExpectedContentRevision = 3
	if _, err := repository.Start(ctx, startInput); err != nil {
		t.Fatal(err)
	}
	if _, err := NewCycleRepository(pool).SaveFrame(ctx, appcycle.SaveFrameInput{
		UserID: userRecord.UserID, CycleID: domaincycle.ID(userRecord.CycleID), Frame: domaincycle.FramePlan,
		Content: "plan changed while AI runs", ExpectedFrameRevision: 1, Now: integrationNow().Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewCycleRepository(pool).SaveFrame(ctx, appcycle.SaveFrameInput{
		UserID: userRecord.UserID, CycleID: domaincycle.ID(userRecord.CycleID), Frame: domaincycle.FrameAction,
		Content: "must be rejected", ExpectedFrameRevision: 0, Now: integrationNow().Add(time.Second),
	}); !errors.Is(err, domaincycle.ErrAIOperationRunning) {
		t.Fatalf("action save error = %v", err)
	}

	result, err := repository.Succeed(ctx, appai.SuccessInput{
		UserID: userRecord.UserID, CycleID: domaincycle.ID(userRecord.CycleID), GenerationID: startInput.GenerationID,
		GenerationRevision: 3, Action: "1. apply generated action", AttemptCount: 1,
		Usage:            appai.Usage{InputTokens: 100, OutputTokens: 20, ProviderRequestID: "provider-request"},
		EstimatedCostUSD: 0.25, Now: integrationNow().Add(2 * time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.ContextChanged || result.ContentRevision != 5 || result.ActionRevision != 1 {
		t.Fatalf("result = %#v", result)
	}
	active, err := NewCycleRepository(pool).GetActive(ctx, userRecord.UserID)
	if err != nil || active.Plan != "plan changed while AI runs" || active.Action != "1. apply generated action" {
		t.Fatalf("active/error = %#v/%v", active, err)
	}
	replayed, err := repository.Start(ctx, startInput)
	if err != nil || replayed.Existing == nil || replayed.Existing.Status != "succeeded" || replayed.Existing.Output != result.Action {
		t.Fatalf("replay/error = %#v/%v", replayed, err)
	}
	var reserved, actual float64
	if err := pool.QueryRow(ctx, `SELECT reserved_cost_usd, actual_cost_usd FROM ai_budget_monthly`).Scan(&reserved, &actual); err != nil || reserved != 0 || actual != 0.25 {
		t.Fatalf("budget/error = %f/%f/%v", reserved, actual, err)
	}
}

func TestAIConcurrentMonthlyReservationsCannotExceedBudget(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	first := anonymousInput(1, 2, 3, 1)
	second := anonymousInput(4, 5, 6, 2)
	sessions := NewSessionRepository(pool)
	for _, record := range []appsessionRecord{wrapSessionRecord(first), wrapSessionRecord(second)} {
		if _, err := sessions.CreateOrResumeAnonymous(context.Background(), record.value); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='p',do_text='d',check_text='c' WHERE id=$1`, record.value.CycleID); err != nil {
			t.Fatal(err)
		}
	}
	repository := NewAIRepository(pool)
	inputs := []appai.StartInput{
		integrationAIStart(first, 10, 11, 12, integrationNow()),
		integrationAIStart(second, 20, 21, 22, integrationNow()),
	}
	for index := range inputs {
		inputs[index].BudgetReservationUSD = 0.75
		inputs[index].MonthlyBudgetUSD = 1
	}
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, input := range inputs {
		wait.Add(1)
		go func(candidate appai.StartInput) {
			defer wait.Done()
			_, err := repository.Start(context.Background(), candidate)
			results <- err
		}(input)
	}
	wait.Wait()
	close(results)
	var accepted, rejected int
	for err := range results {
		if err == nil {
			accepted++
		} else if errors.Is(err, appai.ErrServiceBudget) {
			rejected++
		} else {
			t.Fatalf("unexpected start error = %v", err)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("accepted/rejected = %d/%d", accepted, rejected)
	}
	var reserved float64
	if err := pool.QueryRow(context.Background(), `SELECT reserved_cost_usd FROM ai_budget_monthly`).Scan(&reserved); err != nil || reserved != 0.75 {
		t.Fatalf("reserved/error = %f/%v", reserved, err)
	}
}

func TestAIStaleLeaseRecoveryReleasesReservation(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	record := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='p',do_text='d',check_text='c' WHERE id=$1`, record.CycleID); err != nil {
		t.Fatal(err)
	}
	repository := NewAIRepository(pool)
	first := integrationAIStart(record, 10, 11, 12, integrationNow())
	first.BudgetReservationUSD = 2
	if _, err := repository.Start(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE ai_generations SET lease_expires_at=$2 WHERE id=$1`, first.GenerationID, integrationNow().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	second := integrationAIStart(record, 20, 21, 22, integrationNow().Add(time.Minute))
	second.BudgetReservationUSD = 2
	if _, err := repository.Start(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	var oldStatus, oldFailure string
	if err := pool.QueryRow(context.Background(), `SELECT status,failure_code FROM ai_generations WHERE id=$1`, first.GenerationID).Scan(&oldStatus, &oldFailure); err != nil || oldStatus != "failed" || oldFailure != "timeout_recovered" {
		t.Fatalf("old generation = %s/%s/%v", oldStatus, oldFailure, err)
	}
	var reserved float64
	if err := pool.QueryRow(context.Background(), `SELECT reserved_cost_usd FROM ai_budget_monthly`).Scan(&reserved); err != nil || reserved != 2 {
		t.Fatalf("reserved/error = %f/%v", reserved, err)
	}
}

// This wrapper keeps the loop values explicit without changing shared helpers.
type appsessionRecord struct {
	value appsession.CreateAnonymousRecord
}

func wrapSessionRecord(value appsession.CreateAnonymousRecord) appsessionRecord {
	return appsessionRecord{value: value}
}

func integrationAIStart(record appsession.CreateAnonymousRecord, generation, usage, key int, now time.Time) appai.StartInput {
	return appai.StartInput{
		UserID: record.UserID, CycleID: domaincycle.ID(record.CycleID),
		GenerationID: uuid(generation), UsageEventID: uuid(usage), GenerationType: appai.GenerationGenerate,
		IdempotencyKey: uuid(key), ExpectedContentRevision: 0, ConfirmReplace: false,
		PromptVersion: "generate-action-v1", InputHash: "hash", Model: "test-model", Provider: "fake",
		Now: now, LeaseExpiresAt: now.Add(time.Minute), BudgetMonthUTC: time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC),
		BudgetReservationUSD: 1, MonthlyBudgetUSD: 10, RollingLimit: 10,
		RatePerUserMinute: 10, RatePerSessionMinute: 10, RatePerIPMinute: 10,
		UserRateKey: []byte("user-" + string(record.UserID)), SessionRateKey: []byte("session-" + record.SessionID),
		IPRateKey: []byte("ip-" + record.SessionID),
	}
}
