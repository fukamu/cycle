package kpireport

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"
)

type repositoryStub struct {
	query      Query
	aggregates Aggregates
	err        error
	calls      int
}

func (repository *repositoryStub) Aggregate(_ context.Context, query Query) (Aggregates, error) {
	repository.calls++
	repository.query = query
	return repository.aggregates, repository.err
}

func TestServiceBuildsFixedAggregateOnlyReport(t *testing.T) {
	p50 := 10.0
	p90 := 20.0
	repository := &repositoryStub{aggregates: Aggregates{
		ActivationDenominator: 3,
		ActivationNumerator:   2,
		ActivationDuration:    DurationSummary{ObservationCount: 2, P50Seconds: &p50, P90Seconds: &p90},
		FirstGoalDenominator:  2,
		Cycle1Completed:       2,
		ReviewDecision:        2,
		NextCycleDecision:     1,
		TerminalDecision:      1,
		Cycle2Started:         1,
		Cycle3Started:         1,
		Cycle1Duration:        DurationSummary{ObservationCount: 2, P50Seconds: &p50, P90Seconds: &p90},
		DecisionDuration:      DurationSummary{ObservationCount: 2, P50Seconds: &p50, P90Seconds: &p90},
	}}
	start := time.Date(2026, 1, 1, 9, 0, 0, 0, time.FixedZone("UTC+9", 9*60*60))
	end := start.Add(24 * time.Hour)
	asOf := end.Add(8 * 24 * time.Hour)
	report, err := NewService(repository).Generate(t.Context(), Query{
		CohortStart: start,
		CohortEnd:   end,
		AsOf:        asOf,
	})
	if err != nil {
		t.Fatal(err)
	}
	if repository.calls != 1 || repository.query.CohortStart.Location() != time.UTC ||
		repository.query.CohortEnd.Location() != time.UTC || repository.query.AsOf.Location() != time.UTC {
		t.Fatalf("repository call = %d, query = %#v", repository.calls, repository.query)
	}
	if report.Metadata.SchemaVersion != SchemaVersion || report.Metadata.QueryVersion != QueryVersion ||
		report.Metadata.CountingUnit != "application_user" || !report.Metadata.SurvivorOnly {
		t.Fatalf("metadata = %#v", report.Metadata)
	}
	if report.FirstGoalFunnel168h.Cycle1Completed.PreviousStageDenominator != 2 ||
		report.FirstGoalFunnel168h.ReviewDecision.PreviousStageDenominator != 2 ||
		report.FirstGoalFunnel168h.ReviewDecisionNextCycle.PreviousStageDenominator != 2 ||
		report.FirstGoalFunnel168h.Cycle3Started.PreviousStageDenominator != 1 {
		t.Fatalf("funnel denominators = %#v", report.FirstGoalFunnel168h)
	}
	if !reflect.DeepEqual(report.Limitations, reportLimitations) {
		t.Fatalf("limitations = %#v", report.Limitations)
	}
	report.Limitations[0] = "mutated"
	if reportLimitations[0] != "survivor_only" {
		t.Fatal("report exposed the package limitation slice")
	}
}

func TestServiceRejectsInvalidWindowBeforeRepository(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tests := []Query{
		{},
		{CohortStart: now, CohortEnd: now, AsOf: now},
		{CohortStart: now.Add(time.Hour), CohortEnd: now, AsOf: now.Add(2 * time.Hour)},
		{CohortStart: now, CohortEnd: now.Add(2 * time.Hour), AsOf: now.Add(time.Hour)},
	}
	for index, query := range tests {
		repository := &repositoryStub{}
		_, err := NewService(repository).Generate(t.Context(), query)
		if !errors.Is(err, ErrInvalidWindow) || repository.calls != 0 {
			t.Fatalf("case %d error/calls = %v/%d", index, err, repository.calls)
		}
	}
}

func TestServiceRejectsInvalidOrNonFiniteAggregates(t *testing.T) {
	p50 := 1.0
	p90 := 2.0
	valid := Aggregates{
		ActivationDenominator: 1,
		ActivationNumerator:   1,
		ActivationDuration:    DurationSummary{ObservationCount: 1, P50Seconds: &p50, P90Seconds: &p90},
		FirstGoalDenominator:  1,
		Cycle1Completed:       1,
		ReviewDecision:        1,
		NextCycleDecision:     1,
		Cycle2Started:         1,
		Cycle1Duration:        DurationSummary{ObservationCount: 1, P50Seconds: &p50, P90Seconds: &p90},
		DecisionDuration:      DurationSummary{ObservationCount: 1, P50Seconds: &p50, P90Seconds: &p90},
	}
	tests := []Aggregates{
		func() Aggregates { value := valid; value.ActivationDenominator = -1; return value }(),
		func() Aggregates { value := valid; value.ActivationNumerator = 2; return value }(),
		func() Aggregates { value := valid; value.ReviewDecision = 2; return value }(),
		func() Aggregates { value := valid; value.TerminalDecision = 1; return value }(),
		func() Aggregates { value := valid; value.Cycle2Started = 0; return value }(),
		func() Aggregates { value := valid; value.Cycle3Started = 2; return value }(),
		func() Aggregates { value := valid; value.ActivationDuration.ObservationCount = 0; return value }(),
		func() Aggregates { value := valid; value.ActivationDuration.P50Seconds = nil; return value }(),
		func() Aggregates {
			value := valid
			nan := math.NaN()
			value.ActivationDuration.P50Seconds = &nan
			return value
		}(),
	}
	query := Query{
		CohortStart: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		CohortEnd:   time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		AsOf:        time.Date(2026, 1, 9, 0, 0, 0, 0, time.UTC),
	}
	for index, aggregates := range tests {
		_, err := NewService(&repositoryStub{aggregates: aggregates}).Generate(t.Context(), query)
		if !errors.Is(err, ErrInvalidAggregates) {
			t.Fatalf("case %d error = %v", index, err)
		}
	}
}

func TestServiceAllowsZeroDenominatorsWithNullDurations(t *testing.T) {
	query := Query{
		CohortStart: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		CohortEnd:   time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		AsOf:        time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
	}
	report, err := NewService(&repositoryStub{}).Generate(t.Context(), query)
	if err != nil {
		t.Fatal(err)
	}
	if report.Activation48h.TimeToFirstGoal.P50Seconds != nil ||
		report.FirstGoalFunnel168h.TimeToCycle1Complete.P90Seconds != nil {
		t.Fatalf("zero report durations = %#v", report)
	}
}
