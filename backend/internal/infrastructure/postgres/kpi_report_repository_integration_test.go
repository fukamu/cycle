package postgres

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/kpireport"
)

type kpiFixtureBuilder struct {
	t    *testing.T
	pool *pgxpool.Pool
	next int
}

func newKPIFixtureBuilder(t *testing.T, pool *pgxpool.Pool) *kpiFixtureBuilder {
	return &kpiFixtureBuilder{t: t, pool: pool, next: 1}
}

func (builder *kpiFixtureBuilder) id() string {
	builder.t.Helper()
	value := fmt.Sprintf("70000000-0000-7000-8000-%012d", builder.next)
	builder.next++
	return value
}

func (builder *kpiFixtureBuilder) user(createdAt time.Time) string {
	builder.t.Helper()
	userID := builder.id()
	if _, err := builder.pool.Exec(builder.t.Context(), `
INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, createdAt); err != nil {
		builder.t.Fatal(err)
	}
	return userID
}

func (builder *kpiFixtureBuilder) goal(
	userID string,
	startedAt time.Time,
	status string,
	terminalAt *time.Time,
) (string, string) {
	builder.t.Helper()
	goalID := builder.id()
	versionID := builder.id()
	var terminalOperationID any
	var terminalRequestHash any
	if terminalAt != nil {
		terminalOperationID = builder.id()
		terminalRequestHash = "terminal-request"
	}
	if _, err := builder.pool.Exec(builder.t.Context(), `
INSERT INTO goals(
    id,user_id,status,current_version_number,next_cycle_sequence_number,revision,
    terminal_at,terminal_operation_id,terminal_request_hash,created_at,updated_at
) VALUES($1,$2,$3,1,2,0,$4,$5,$6,$7,$7)`,
		goalID, userID, status, terminalAt, terminalOperationID, terminalRequestHash, startedAt); err != nil {
		builder.t.Fatal(err)
	}
	if _, err := builder.pool.Exec(builder.t.Context(), `
INSERT INTO goal_versions(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'GOAL_BODY_CANARY',$4,$5)`,
		versionID, userID, goalID, builder.id(), startedAt); err != nil {
		builder.t.Fatal(err)
	}
	return goalID, versionID
}

func (builder *kpiFixtureBuilder) cycle(
	userID, goalID, versionID string,
	sequence int,
	startedAt time.Time,
	status string,
	finishedAt *time.Time,
) string {
	builder.t.Helper()
	cycleID := builder.id()
	var completedAt any
	var canceledAt any
	var cancellationReason any
	var completionOperationID any
	var completionRequestHash any
	switch status {
	case "completed":
		completedAt = *finishedAt
		completionOperationID = builder.id()
		completionRequestHash = "completion-request"
	case "canceled":
		canceledAt = *finishedAt
		cancellationReason = "goal_ended"
	case "active":
		if finishedAt != nil {
			builder.t.Fatal("active cycle must not have a finishedAt value")
		}
	default:
		builder.t.Fatalf("unknown cycle status %q", status)
	}
	updatedAt := startedAt
	if finishedAt != nil {
		updatedAt = *finishedAt
	}
	if _, err := builder.pool.Exec(builder.t.Context(), `
INSERT INTO pdca_cycles(
    id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,
    completed_at,canceled_at,cancellation_reason,start_operation_id,start_request_hash,
    completion_operation_id,completion_request_hash,created_at,updated_at
) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'start-request',$12,$13,$7,$14)`,
		cycleID, userID, goalID, versionID, sequence, status, startedAt,
		completedAt, canceledAt, cancellationReason, builder.id(),
		completionOperationID, completionRequestHash, updatedAt); err != nil {
		builder.t.Fatal(err)
	}
	return cycleID
}

func (builder *kpiFixtureBuilder) deleteGoal(goalID string) {
	builder.t.Helper()
	if _, err := builder.pool.Exec(builder.t.Context(), `DELETE FROM goals WHERE id=$1`, goalID); err != nil {
		builder.t.Fatal(err)
	}
}

func (builder *kpiFixtureBuilder) deleteUser(userID string) {
	builder.t.Helper()
	if _, err := builder.pool.Exec(builder.t.Context(), `DELETE FROM users WHERE id=$1`, userID); err != nil {
		builder.t.Fatal(err)
	}
}

func TestKPIReportActivationUsesFirstSurvivingGoalAndExact48HourBoundary(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	fixture := newKPIFixtureBuilder(t, pool)
	cohortStart := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	cohortEnd := cohortStart.Add(24 * time.Hour)

	exactUser := fixture.user(cohortStart)
	fixture.goal(exactUser, cohortStart.Add(48*time.Hour), "active_cycle", nil)

	afterUserStart := cohortStart.Add(time.Hour)
	afterUser := fixture.user(afterUserStart)
	fixture.goal(afterUser, afterUserStart.Add(48*time.Hour+time.Microsecond), "active_cycle", nil)

	fixture.user(cohortStart.Add(2 * time.Hour)) // no Goal remains in the denominator.

	multipleUserStart := cohortStart.Add(3 * time.Hour)
	multipleUser := fixture.user(multipleUserStart)
	fixture.goal(multipleUser, multipleUserStart.Add(4*time.Hour), "active_cycle", nil)
	fixture.goal(multipleUser, multipleUserStart.Add(5*time.Hour), "active_cycle", nil)

	shiftedUserStart := cohortStart.Add(4 * time.Hour)
	shiftedUser := fixture.user(shiftedUserStart)
	deletedGoal, _ := fixture.goal(shiftedUser, shiftedUserStart.Add(time.Hour), "active_cycle", nil)
	fixture.goal(shiftedUser, shiftedUserStart.Add(2*time.Hour), "active_cycle", nil)
	fixture.deleteGoal(deletedGoal)

	deletedUser := fixture.user(cohortStart.Add(5 * time.Hour))
	fixture.goal(deletedUser, cohortStart.Add(6*time.Hour), "active_cycle", nil)
	fixture.deleteUser(deletedUser)

	endUser := fixture.user(cohortEnd)
	fixture.goal(endUser, cohortEnd.Add(time.Hour), "active_cycle", nil)

	report, err := kpireport.NewService(NewKPIReportRepository(pool)).Generate(t.Context(), kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortEnd,
		AsOf:        cohortStart.Add(10 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	activation := report.Activation48h
	if activation.CohortDenominator != 5 || activation.Numerator != 3 ||
		activation.TimeToFirstGoal.ObservationCount != 3 {
		t.Fatalf("activation = %#v", activation)
	}
	assertDurationSeconds(t, activation.TimeToFirstGoal.P50Seconds, 4*time.Hour)
	assertDurationSeconds(t, activation.TimeToFirstGoal.P90Seconds, 39*time.Hour+12*time.Minute)

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, prohibited := range []string{
		"GOAL_BODY_CANARY",
		exactUser,
		multipleUser,
		shiftedUser,
		deletedUser,
		"KPI_DATABASE_URL_SECRET_CANARY",
	} {
		if strings.Contains(string(encoded), prohibited) {
			t.Fatalf("aggregate report exposed %q: %s", prohibited, encoded)
		}
	}
}

func TestKPIReportFirstGoalFunnelCoversReviewBranchesAndExact168HourBoundary(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	fixture := newKPIFixtureBuilder(t, pool)
	cohortStart := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	cohortEnd := cohortStart.Add(24 * time.Hour)

	// Next Cycle decision and Cycle 3 exactly at the inclusive 168-hour boundary.
	user1 := fixture.user(cohortStart.Add(-time.Hour))
	goal1Start := cohortStart
	goal1, version1 := fixture.goal(user1, goal1Start, "active_cycle", nil)
	cycle1Completed := goal1Start.Add(10 * time.Hour)
	fixture.cycle(user1, goal1, version1, 1, goal1Start, "completed", &cycle1Completed)
	cycle2Completed := goal1Start.Add(30 * time.Hour)
	fixture.cycle(user1, goal1, version1, 2, goal1Start.Add(20*time.Hour), "completed", &cycle2Completed)
	fixture.cycle(user1, goal1, version1, 3, goal1Start.Add(168*time.Hour), "active", nil)

	// Terminal Review decision exactly at 168 hours, ten hours after Cycle 1 completion.
	user2 := fixture.user(cohortStart.Add(-time.Hour))
	goal2Start := cohortStart.Add(time.Hour)
	goal2Terminal := goal2Start.Add(168 * time.Hour)
	goal2, version2 := fixture.goal(user2, goal2Start, "ended", &goal2Terminal)
	cycle1At158 := goal2Start.Add(158 * time.Hour)
	fixture.cycle(user2, goal2, version2, 1, goal2Start, "completed", &cycle1At158)

	// Active-Cycle terminal/cancel is not a Review decision.
	user3 := fixture.user(cohortStart.Add(-time.Hour))
	goal3Start := cohortStart.Add(2 * time.Hour)
	goal3Terminal := goal3Start.Add(6 * time.Hour)
	goal3, version3 := fixture.goal(user3, goal3Start, "ended", &goal3Terminal)
	cycle1Canceled := goal3Start.Add(5 * time.Hour)
	fixture.cycle(user3, goal3, version3, 1, goal3Start, "canceled", &cycle1Canceled)

	// Cycle 1 completion just beyond the window is excluded.
	user4 := fixture.user(cohortStart.Add(-time.Hour))
	goal4Start := cohortStart.Add(3 * time.Hour)
	goal4, version4 := fixture.goal(user4, goal4Start, "goal_review", nil)
	cycle1After := goal4Start.Add(168*time.Hour + time.Microsecond)
	fixture.cycle(user4, goal4, version4, 1, goal4Start, "completed", &cycle1After)

	// Cycle 1 can succeed without a Review decision.
	user5 := fixture.user(cohortStart.Add(-time.Hour))
	goal5Start := cohortStart.Add(4 * time.Hour)
	goal5, version5 := fixture.goal(user5, goal5Start, "goal_review", nil)
	cycle1Only := goal5Start.Add(10 * time.Hour)
	fixture.cycle(user5, goal5, version5, 1, goal5Start, "completed", &cycle1Only)

	// A Cycle 2 start just beyond the window is not a decision in this report.
	user6 := fixture.user(cohortStart.Add(-time.Hour))
	goal6Start := cohortStart.Add(5 * time.Hour)
	goal6, version6 := fixture.goal(user6, goal6Start, "active_cycle", nil)
	cycle1BeforeLateDecision := goal6Start.Add(10 * time.Hour)
	fixture.cycle(user6, goal6, version6, 1, goal6Start, "completed", &cycle1BeforeLateDecision)
	fixture.cycle(user6, goal6, version6, 2, goal6Start.Add(168*time.Hour+time.Microsecond), "active", nil)

	// Deleting the original first Goal promotes the next surviving Goal.
	user7 := fixture.user(cohortStart.Add(-time.Hour))
	deletedGoal, _ := fixture.goal(user7, cohortStart.Add(6*time.Hour), "active_cycle", nil)
	goal7Start := cohortStart.Add(7 * time.Hour)
	goal7Terminal := goal7Start.Add(20 * time.Hour)
	goal7, version7 := fixture.goal(user7, goal7Start, "achieved", &goal7Terminal)
	cycle1BeforeTerminal := goal7Start.Add(10 * time.Hour)
	fixture.cycle(user7, goal7, version7, 1, goal7Start, "completed", &cycle1BeforeTerminal)
	fixture.deleteGoal(deletedGoal)

	// With the same created_at, the lower Goal ID remains the First Goal and a
	// successful higher-ID Goal cannot rescue the funnel.
	user8 := fixture.user(cohortStart.Add(-time.Hour))
	tiedGoalStart := cohortStart.Add(8 * time.Hour)
	fixture.goal(user8, tiedGoalStart, "active_cycle", nil)
	laterGoalStart := tiedGoalStart
	laterGoal, laterVersion := fixture.goal(user8, laterGoalStart, "active_cycle", nil)
	laterCycle1 := laterGoalStart.Add(10 * time.Hour)
	fixture.cycle(user8, laterGoal, laterVersion, 1, laterGoalStart, "completed", &laterCycle1)
	fixture.cycle(user8, laterGoal, laterVersion, 2, laterGoalStart.Add(20*time.Hour), "active", nil)

	// Cycle 3 just beyond the window is excluded while its Cycle 2 stage remains.
	user9 := fixture.user(cohortStart.Add(-time.Hour))
	goal9Start := cohortStart.Add(10 * time.Hour)
	goal9, version9 := fixture.goal(user9, goal9Start, "active_cycle", nil)
	cycle9One := goal9Start.Add(10 * time.Hour)
	fixture.cycle(user9, goal9, version9, 1, goal9Start, "completed", &cycle9One)
	cycle9Two := goal9Start.Add(30 * time.Hour)
	fixture.cycle(user9, goal9, version9, 2, goal9Start.Add(20*time.Hour), "completed", &cycle9Two)
	fixture.cycle(user9, goal9, version9, 3, goal9Start.Add(168*time.Hour+time.Microsecond), "active", nil)

	// Account Delete removes an otherwise successful funnel from the snapshot.
	deletedUser := fixture.user(cohortStart.Add(-time.Hour))
	deletedGoalStart := cohortStart.Add(11 * time.Hour)
	deletedGoalID, deletedVersion := fixture.goal(deletedUser, deletedGoalStart, "active_cycle", nil)
	deletedCycleOne := deletedGoalStart.Add(10 * time.Hour)
	fixture.cycle(deletedUser, deletedGoalID, deletedVersion, 1, deletedGoalStart, "completed", &deletedCycleOne)
	fixture.cycle(deletedUser, deletedGoalID, deletedVersion, 2, deletedGoalStart.Add(20*time.Hour), "active", nil)
	fixture.deleteUser(deletedUser)

	query := kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortEnd,
		AsOf:        cohortStart.Add(10 * 24 * time.Hour),
	}
	service := kpireport.NewService(NewKPIReportRepository(pool))
	report, err := service.Generate(t.Context(), query)
	if err != nil {
		t.Fatal(err)
	}
	funnel := report.FirstGoalFunnel168h
	if funnel.CohortDenominator != 9 || funnel.Cycle1Completed.Numerator != 6 ||
		funnel.ReviewDecision.Numerator != 4 || funnel.ReviewDecisionNextCycle.Numerator != 2 ||
		funnel.ReviewDecisionTerminalReview.Numerator != 2 || funnel.Cycle2Started.Numerator != 2 ||
		funnel.Cycle3Started.Numerator != 1 {
		t.Fatalf("funnel = %#v", funnel)
	}
	if funnel.Cycle1Completed.PreviousStageDenominator != 9 ||
		funnel.ReviewDecision.PreviousStageDenominator != 6 ||
		funnel.ReviewDecisionNextCycle.PreviousStageDenominator != 4 ||
		funnel.ReviewDecisionTerminalReview.PreviousStageDenominator != 4 ||
		funnel.Cycle2Started.PreviousStageDenominator != 4 ||
		funnel.Cycle3Started.PreviousStageDenominator != 2 {
		t.Fatalf("stage denominators = %#v", funnel)
	}
	if funnel.TimeToCycle1Complete.ObservationCount != 6 ||
		funnel.TimeFromCycle1CompleteToDecision.ObservationCount != 4 {
		t.Fatalf("duration counts = %#v/%#v", funnel.TimeToCycle1Complete, funnel.TimeFromCycle1CompleteToDecision)
	}
	assertDurationSeconds(t, funnel.TimeToCycle1Complete.P50Seconds, 10*time.Hour)
	assertDurationSeconds(t, funnel.TimeToCycle1Complete.P90Seconds, 84*time.Hour)
	assertDurationSeconds(t, funnel.TimeFromCycle1CompleteToDecision.P50Seconds, 10*time.Hour)
	assertDurationSeconds(t, funnel.TimeFromCycle1CompleteToDecision.P90Seconds, 10*time.Hour)

	// Re-running the snapshot against unchanged state must not count replay metadata twice.
	replayed, err := service.Generate(t.Context(), query)
	if err != nil {
		t.Fatal(err)
	}
	firstJSON, _ := json.Marshal(report)
	replayJSON, _ := json.Marshal(replayed)
	if string(firstJSON) != string(replayJSON) {
		t.Fatalf("replayed report changed:\nfirst=%s\nreplay=%s", firstJSON, replayJSON)
	}
}

func TestKPIReportRejectsOutOfOrderCycleStagesAndUsesFirstReviewDecision(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	fixture := newKPIFixtureBuilder(t, pool)
	cohortStart := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	cohortEnd := cohortStart.Add(24 * time.Hour)

	// A Cycle 2 start before Cycle 1 completion is not a Review decision.
	user1 := fixture.user(cohortStart.Add(-time.Hour))
	goal1Start := cohortStart
	goal1, version1 := fixture.goal(user1, goal1Start, "active_cycle", nil)
	cycle1Completed := goal1Start.Add(10 * time.Hour)
	fixture.cycle(user1, goal1, version1, 1, goal1Start, "completed", &cycle1Completed)
	fixture.cycle(user1, goal1, version1, 2, goal1Start.Add(5*time.Hour), "active", nil)

	// A Cycle 3 start before Cycle 2 remains excluded from the Cycle 3 stage.
	user2 := fixture.user(cohortStart.Add(-time.Hour))
	goal2Start := cohortStart.Add(time.Hour)
	goal2, version2 := fixture.goal(user2, goal2Start, "active_cycle", nil)
	cycle2OneCompleted := goal2Start.Add(10 * time.Hour)
	fixture.cycle(user2, goal2, version2, 1, goal2Start, "completed", &cycle2OneCompleted)
	cycle2TwoCompleted := goal2Start.Add(30 * time.Hour)
	fixture.cycle(user2, goal2, version2, 2, goal2Start.Add(20*time.Hour), "completed", &cycle2TwoCompleted)
	fixture.cycle(user2, goal2, version2, 3, goal2Start.Add(15*time.Hour), "active", nil)

	// When Cycle 2 and a later terminal_at coexist, Cycle 2 is the first
	// Review decision and the result stays on the next-Cycle branch.
	user3 := fixture.user(cohortStart.Add(-time.Hour))
	goal3Start := cohortStart.Add(2 * time.Hour)
	goal3Terminal := goal3Start.Add(30 * time.Hour)
	goal3, version3 := fixture.goal(user3, goal3Start, "ended", &goal3Terminal)
	cycle3OneCompleted := goal3Start.Add(10 * time.Hour)
	fixture.cycle(user3, goal3, version3, 1, goal3Start, "completed", &cycle3OneCompleted)
	fixture.cycle(user3, goal3, version3, 2, goal3Start.Add(20*time.Hour), "canceled", &goal3Terminal)

	report, err := kpireport.NewService(NewKPIReportRepository(pool)).Generate(t.Context(), kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortEnd,
		AsOf:        cohortStart.Add(10 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	funnel := report.FirstGoalFunnel168h
	if funnel.CohortDenominator != 3 || funnel.Cycle1Completed.Numerator != 3 ||
		funnel.ReviewDecision.Numerator != 2 || funnel.ReviewDecisionNextCycle.Numerator != 2 ||
		funnel.ReviewDecisionTerminalReview.Numerator != 0 || funnel.Cycle2Started.Numerator != 2 ||
		funnel.Cycle3Started.Numerator != 0 {
		t.Fatalf("ordered funnel = %#v", funnel)
	}
}

func TestKPIReportIncludesExactlyMatureAnchorsAndExcludesFirstGoalAtCohortEnd(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	fixture := newKPIFixtureBuilder(t, pool)
	cohortStart := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	cohortEnd := cohortStart.Add(24 * time.Hour)
	service := kpireport.NewService(NewKPIReportRepository(pool))

	activationUser := fixture.user(cohortStart)
	fixture.goal(activationUser, cohortStart.Add(48*time.Hour), "active_cycle", nil)

	funnelUser := fixture.user(cohortStart.Add(-time.Hour))
	funnelGoal, funnelVersion := fixture.goal(funnelUser, cohortStart, "active_cycle", nil)
	funnelCycleOneCompleted := cohortStart.Add(time.Hour)
	fixture.cycle(
		funnelUser,
		funnelGoal,
		funnelVersion,
		1,
		cohortStart,
		"completed",
		&funnelCycleOneCompleted,
	)
	fixture.cycle(funnelUser, funnelGoal, funnelVersion, 2, cohortStart.Add(2*time.Hour), "active", nil)

	endUser := fixture.user(cohortStart.Add(-time.Hour))
	endGoal, endVersion := fixture.goal(endUser, cohortEnd, "active_cycle", nil)
	endCycleOneCompleted := cohortEnd.Add(time.Hour)
	fixture.cycle(endUser, endGoal, endVersion, 1, cohortEnd, "completed", &endCycleOneCompleted)
	fixture.cycle(endUser, endGoal, endVersion, 2, cohortEnd.Add(2*time.Hour), "active", nil)

	exactActivationMaturity, err := service.Generate(t.Context(), kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortEnd,
		AsOf:        cohortStart.Add(48 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if exactActivationMaturity.Activation48h.CohortDenominator != 1 ||
		exactActivationMaturity.Activation48h.Numerator != 1 {
		t.Fatalf("exact 48-hour maturity report = %#v", exactActivationMaturity.Activation48h)
	}

	exactFunnelMaturity, err := service.Generate(t.Context(), kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortEnd,
		AsOf:        cohortStart.Add(168 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if exactFunnelMaturity.FirstGoalFunnel168h.CohortDenominator != 1 ||
		exactFunnelMaturity.FirstGoalFunnel168h.ReviewDecision.Numerator != 1 {
		t.Fatalf("exact 168-hour maturity report = %#v", exactFunnelMaturity.FirstGoalFunnel168h)
	}

	cohortEndMature, err := service.Generate(t.Context(), kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortEnd,
		AsOf:        cohortEnd.Add(168 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if cohortEndMature.FirstGoalFunnel168h.CohortDenominator != 1 ||
		cohortEndMature.FirstGoalFunnel168h.ReviewDecision.Numerator != 1 {
		t.Fatalf("cohort-end exclusive report = %#v", cohortEndMature.FirstGoalFunnel168h)
	}
}

func TestKPIReportExcludesIndividuallyImmatureAnchors(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	fixture := newKPIFixtureBuilder(t, pool)
	cohortStart := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	cohortEnd := cohortStart.Add(24 * time.Hour)

	earlyUser := fixture.user(cohortStart)
	fixture.goal(earlyUser, cohortStart.Add(time.Hour), "active_cycle", nil)
	lateUserStart := cohortStart.Add(13 * time.Hour)
	lateUser := fixture.user(lateUserStart)
	fixture.goal(lateUser, lateUserStart.Add(time.Hour), "active_cycle", nil)

	activationReport, err := kpireport.NewService(NewKPIReportRepository(pool)).Generate(t.Context(), kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortEnd,
		AsOf:        cohortStart.Add(60 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if activationReport.Activation48h.CohortDenominator != 1 || activationReport.Activation48h.Numerator != 1 ||
		activationReport.FirstGoalFunnel168h.CohortDenominator != 0 {
		t.Fatalf("partially mature activation report = %#v", activationReport)
	}

	funnelReport, err := kpireport.NewService(NewKPIReportRepository(pool)).Generate(t.Context(), kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortEnd,
		AsOf:        cohortStart.Add(180 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if funnelReport.FirstGoalFunnel168h.CohortDenominator != 1 {
		t.Fatalf("partially mature first-goal cohort = %#v", funnelReport.FirstGoalFunnel168h)
	}
}

func TestKPIReportEmptySnapshotProducesNullFiniteDurations(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	cohortStart := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	report, err := kpireport.NewService(NewKPIReportRepository(pool)).Generate(t.Context(), kpireport.Query{
		CohortStart: cohortStart,
		CohortEnd:   cohortStart.Add(24 * time.Hour),
		AsOf:        cohortStart.Add(10 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(encoded) || strings.Contains(string(encoded), "NaN") || strings.Contains(string(encoded), "Inf") ||
		!strings.Contains(string(encoded), `"p50Seconds":null`) || !strings.Contains(string(encoded), `"p90Seconds":null`) {
		t.Fatalf("empty report JSON = %s", encoded)
	}
}

func assertDurationSeconds(t *testing.T, got *float64, want time.Duration) {
	t.Helper()
	if got == nil || math.Abs(*got-want.Seconds()) > 0.000_001 {
		t.Fatalf("duration = %v, want %.6f seconds", got, want.Seconds())
	}
}
