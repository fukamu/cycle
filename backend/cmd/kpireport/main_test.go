package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/kpireport"
	"github.com/fukamu/cycle/backend/internal/infrastructure/postgres"
)

const (
	validDatabaseURL = "postgres://report-user:KPI_DATABASE_URL_SECRET_CANARY@db.example:5432/report-db?sslmode=disable"
	startArgument    = "2026-01-01T00:00:00Z"
	endArgument      = "2026-01-02T00:00:00Z"
	asOfArgument     = "2026-01-09T00:00:00Z"
)

type reportRepositoryStub struct {
	query      kpireport.Query
	aggregates kpireport.Aggregates
	err        error
	calls      int
}

func (repository *reportRepositoryStub) Aggregate(
	_ context.Context,
	query kpireport.Query,
) (kpireport.Aggregates, error) {
	repository.calls++
	repository.query = query
	return repository.aggregates, repository.err
}

func validArguments() []string {
	return []string{
		"--cohort-start=" + startArgument,
		"--cohort-end=" + endArgument,
		"--as-of=" + asOfArgument,
	}
}

func validAggregates() kpireport.Aggregates {
	p50 := 3600.0
	p90 := 7200.0
	return kpireport.Aggregates{
		ActivationDenominator: 3,
		ActivationNumerator:   2,
		ActivationDuration: kpireport.DurationSummary{
			ObservationCount: 2,
			P50Seconds:       &p50,
			P90Seconds:       &p90,
		},
		FirstGoalDenominator: 2,
		Cycle1Completed:      2,
		ReviewDecision:       2,
		NextCycleDecision:    1,
		TerminalDecision:     1,
		Cycle2Started:        1,
		Cycle3Started:        1,
		Cycle1Duration: kpireport.DurationSummary{
			ObservationCount: 2,
			P50Seconds:       &p50,
			P90Seconds:       &p90,
		},
		DecisionDuration: kpireport.DurationSummary{
			ObservationCount: 2,
			P50Seconds:       &p50,
			P90Seconds:       &p90,
		},
	}
}

func TestParseKPIReportQueryRequiresExplicitOrderedUTCInstants(t *testing.T) {
	query, err := parseKPIReportQuery([]string{
		"--cohort-start=2026-01-01T00:00:00.125+00:00",
		"--cohort-end=2026-01-02T00:00:00Z",
		"--as-of=2026-01-09T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if query.CohortStart.Location() != time.UTC || query.CohortStart.Nanosecond() != 125_000_000 {
		t.Fatalf("cohort start = %v", query.CohortStart)
	}

	tests := [][]string{
		{},
		{"--cohort-start=" + startArgument, "--cohort-end=" + endArgument},
		{"--cohort-start=2026-01-01T09:00:00+09:00", "--cohort-end=" + endArgument, "--as-of=" + asOfArgument},
		{"--cohort-start=not-an-instant", "--cohort-end=" + endArgument, "--as-of=" + asOfArgument},
		{"--cohort-start=" + endArgument, "--cohort-end=" + endArgument, "--as-of=" + asOfArgument},
		{"--cohort-start=" + startArgument, "--cohort-end=" + asOfArgument, "--as-of=" + endArgument},
		{"--cohort-start=" + startArgument, "--cohort-start=" + startArgument, "--cohort-end=" + endArgument, "--as-of=" + asOfArgument},
		{"--cohort-start=" + startArgument, "--cohort-end=" + endArgument, "--as-of=" + asOfArgument, "GOAL_BODY_CANARY"},
		{"--private-token=SESSION_TOKEN_CANARY"},
	}
	for index, arguments := range tests {
		if parsed, parseErr := parseKPIReportQuery(arguments); !errors.Is(parseErr, errInvalidKPIReportArguments) {
			t.Fatalf("case %d parse = %#v/%v", index, parsed, parseErr)
		}
	}
}

func TestInvalidArgumentsStopBeforeEnvironmentAndDoNotEchoCanaries(t *testing.T) {
	invalidArguments := [][]string{
		{"--cohort-start=GOAL_BODY_CANARY"},
		{"--private-token=SESSION_TOKEN_CANARY"},
		{"--cohort-start=" + startArgument, "--cohort-end=" + endArgument, "--as-of=" + asOfArgument, "RAW_USER_ID_CANARY"},
	}
	for index, arguments := range invalidArguments {
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		lookupCalls := 0
		openCalls := 0
		exitCode := runKPIReportCommand(t.Context(), arguments, func(string) (string, bool) {
			lookupCalls++
			return validDatabaseURL, true
		}, &stdout, &stderr, commandDependencies{
			openRepository: func(context.Context, string) (kpireport.Repository, func(), error) {
				openCalls++
				return &reportRepositoryStub{}, func() {}, nil
			},
		})
		if exitCode != 1 || lookupCalls != 0 || openCalls != 0 || stdout.Len() != 0 {
			t.Fatalf("case %d exit/lookup/open/stdout = %d/%d/%d/%q", index, exitCode, lookupCalls, openCalls, stdout.String())
		}
		assertNoReportCanary(t, stderr.String())
		assertFailureClass(t, stderr.Bytes(), "kpi_report_arguments_invalid")
	}
}

func TestInvalidDatabaseConfigurationStopsBeforeOpenWithoutEchoingValue(t *testing.T) {
	invalidURLs := []string{
		"",
		"postgres://",
		"postgres://report-user@db.example:5432",
		"postgres://report-user:KPI_DATABASE_URL_SECRET_CANARY@db.example/report-db?service=unsafe",
	}
	for index, databaseURL := range invalidURLs {
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		lookupKeys := []string{}
		openCalls := 0
		exitCode := runKPIReportCommand(t.Context(), validArguments(), func(key string) (string, bool) {
			lookupKeys = append(lookupKeys, key)
			return databaseURL, databaseURL != ""
		}, &stdout, &stderr, commandDependencies{
			openRepository: func(context.Context, string) (kpireport.Repository, func(), error) {
				openCalls++
				return &reportRepositoryStub{}, func() {}, nil
			},
		})
		if exitCode != 1 || !reflect.DeepEqual(lookupKeys, []string{"KPI_DATABASE_URL"}) || openCalls != 0 || stdout.Len() != 0 {
			t.Fatalf("case %d exit/keys/open/stdout = %d/%v/%d/%q", index, exitCode, lookupKeys, openCalls, stdout.String())
		}
		if databaseURL != "" && strings.Contains(stderr.String(), databaseURL) {
			t.Fatalf("case %d exposed database URL: %s", index, stderr.String())
		}
		assertNoReportCanary(t, stderr.String())
		assertFailureClass(t, stderr.Bytes(), "kpi_report_configuration_invalid")
	}
}

func TestSuccessReadsOnlyKPIDatabaseURLAndWritesFixedAggregateJSON(t *testing.T) {
	repository := &reportRepositoryStub{aggregates: validAggregates()}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	lookupKeys := []string{}
	closed := 0
	exitCode := runKPIReportCommand(t.Context(), validArguments(), func(key string) (string, bool) {
		lookupKeys = append(lookupKeys, key)
		return validDatabaseURL, true
	}, &stdout, &stderr, commandDependencies{
		openRepository: func(_ context.Context, databaseURL string) (kpireport.Repository, func(), error) {
			if databaseURL != validDatabaseURL {
				t.Fatalf("database URL was changed")
			}
			return repository, func() { closed++ }, nil
		},
	})
	if exitCode != 0 || stderr.Len() != 0 || closed != 1 || repository.calls != 1 ||
		!reflect.DeepEqual(lookupKeys, []string{"KPI_DATABASE_URL"}) {
		t.Fatalf("exit/stderr/closed/calls/keys = %d/%q/%d/%d/%v", exitCode, stderr.String(), closed, repository.calls, lookupKeys)
	}
	var report kpireport.Report
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Metadata.CountingUnit != "application_user" || !report.Metadata.SurvivorOnly ||
		report.Activation48h.Numerator != 2 || report.FirstGoalFunnel168h.ReviewDecision.Numerator != 2 {
		t.Fatalf("report = %#v", report)
	}
	assertFixedReportJSONSchema(t, stdout.Bytes())
	assertNoReportCanary(t, stdout.String())
}

func TestDatabaseAndRepositoryErrorsDoNotExposeValues(t *testing.T) {
	tests := []struct {
		name      string
		openErr   error
		reportErr error
		wantClass string
	}{
		{
			name:      "ambient configuration",
			openErr:   errors.Join(postgres.ErrKPIReportDatabaseConfiguration, errors.New("KPI_DATABASE_URL_SECRET_CANARY")),
			wantClass: "kpi_report_configuration_invalid",
		},
		{
			name:      "database unavailable",
			openErr:   errors.New("KPI_DATABASE_URL_SECRET_CANARY"),
			wantClass: "kpi_report_database_unavailable",
		},
		{
			name:      "query failure",
			reportErr: errors.New("RAW_USER_ID_CANARY GOAL_BODY_CANARY SESSION_TOKEN_CANARY"),
			wantClass: "kpi_report_execution_failed",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			repository := &reportRepositoryStub{aggregates: validAggregates(), err: test.reportErr}
			exitCode := runKPIReportCommand(t.Context(), validArguments(), func(string) (string, bool) {
				return validDatabaseURL, true
			}, &stdout, &stderr, commandDependencies{
				openRepository: func(context.Context, string) (kpireport.Repository, func(), error) {
					if test.openErr != nil {
						return nil, nil, test.openErr
					}
					return repository, func() {}, nil
				},
			})
			if exitCode != 1 || stdout.Len() != 0 {
				t.Fatalf("exit/stdout = %d/%q", exitCode, stdout.String())
			}
			assertNoReportCanary(t, stderr.String())
			assertFailureClass(t, stderr.Bytes(), test.wantClass)
		})
	}
}

func TestZeroObservationOutputUsesNullAndFiniteJSON(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := runKPIReportCommand(t.Context(), validArguments(), func(string) (string, bool) {
		return validDatabaseURL, true
	}, &stdout, &stderr, commandDependencies{
		openRepository: func(context.Context, string) (kpireport.Repository, func(), error) {
			return &reportRepositoryStub{}, func() {}, nil
		},
	})
	if exitCode != 0 || stderr.Len() != 0 || !json.Valid(stdout.Bytes()) {
		t.Fatalf("exit/stderr/json = %d/%q/%q", exitCode, stderr.String(), stdout.String())
	}
	if strings.Contains(stdout.String(), "NaN") || strings.Contains(stdout.String(), "Inf") ||
		!strings.Contains(stdout.String(), `"p50Seconds":null`) || !strings.Contains(stdout.String(), `"p90Seconds":null`) {
		t.Fatalf("zero-observation JSON = %s", stdout.String())
	}
}

func assertNoReportCanary(t *testing.T, output string) {
	t.Helper()
	for _, canary := range []string{
		"KPI_DATABASE_URL_SECRET_CANARY",
		"GOAL_BODY_CANARY",
		"SESSION_TOKEN_CANARY",
		"RAW_USER_ID_CANARY",
		"private-token",
	} {
		if strings.Contains(output, canary) {
			t.Fatalf("output exposed %q: %s", canary, output)
		}
	}
}

func assertFailureClass(t *testing.T, encoded []byte, want string) {
	t.Helper()
	var record map[string]any
	if err := json.Unmarshal(encoded, &record); err != nil {
		t.Fatal(err)
	}
	if record["operation"] != "kpi_report" || record["error_class"] != want {
		t.Fatalf("failure = %#v, want %q", record, want)
	}
}

func assertFixedReportJSONSchema(t *testing.T, encoded []byte) {
	t.Helper()
	var report map[string]any
	if err := json.Unmarshal(encoded, &report); err != nil {
		t.Fatal(err)
	}
	assertExactKeys(t, report, "report", "metadata", "activation48h", "firstGoalFunnel168h", "limitations")
	metadata := report["metadata"].(map[string]any)
	assertExactKeys(t, metadata, "metadata",
		"schemaVersion", "queryVersion", "asOf", "cohortStart", "cohortEndExclusive", "countingUnit", "survivorOnly")
	activation := report["activation48h"].(map[string]any)
	assertExactKeys(t, activation, "activation48h", "numerator", "cohortDenominator", "timeToFirstGoalSeconds")
	assertDurationKeys(t, activation["timeToFirstGoalSeconds"], "activation48h.timeToFirstGoalSeconds")
	funnel := report["firstGoalFunnel168h"].(map[string]any)
	assertExactKeys(t, funnel, "firstGoalFunnel168h",
		"cohortDenominator",
		"cycle1Completed",
		"reviewDecision",
		"reviewDecisionNextCycle",
		"reviewDecisionTerminalReview",
		"cycle2Started",
		"cycle3Started",
		"timeToCycle1CompleteSeconds",
		"timeFromCycle1CompleteToReviewDecisionSeconds")
	for _, stageName := range []string{
		"cycle1Completed",
		"reviewDecision",
		"reviewDecisionNextCycle",
		"reviewDecisionTerminalReview",
		"cycle2Started",
		"cycle3Started",
	} {
		stage := funnel[stageName].(map[string]any)
		assertExactKeys(t, stage, "firstGoalFunnel168h."+stageName,
			"numerator", "cohortDenominator", "previousStageDenominator")
	}
	assertDurationKeys(t, funnel["timeToCycle1CompleteSeconds"], "firstGoalFunnel168h.timeToCycle1CompleteSeconds")
	assertDurationKeys(t, funnel["timeFromCycle1CompleteToReviewDecisionSeconds"], "firstGoalFunnel168h.timeFromCycle1CompleteToReviewDecisionSeconds")
}

func assertDurationKeys(t *testing.T, value any, path string) {
	t.Helper()
	duration := value.(map[string]any)
	assertExactKeys(t, duration, path, "observationCount", "p50Seconds", "p90Seconds")
}

func assertExactKeys(t *testing.T, value map[string]any, path string, expected ...string) {
	t.Helper()
	actual := make([]string, 0, len(value))
	for key := range value {
		actual = append(actual, key)
	}
	slices.Sort(actual)
	slices.Sort(expected)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("%s keys = %v, want %v", path, actual, expected)
	}
}
