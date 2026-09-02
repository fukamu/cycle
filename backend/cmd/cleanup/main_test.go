package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	applicationcleanup "github.com/fukamu/cycle/backend/internal/application/cleanup"
	"github.com/fukamu/cycle/backend/internal/infrastructure/postgres"
)

type commandClock struct {
	now   time.Time
	calls int
}

func (clock *commandClock) Now() time.Time {
	clock.calls++
	return clock.now
}

type commandRepository struct {
	counts         applicationcleanup.CandidateCounts
	countErr       error
	deleteErr      error
	aiFailureAt    int
	abuseFailureAt int
	countNow       time.Time
	aiTimes        []time.Time
	abuseTimes     []time.Time
	guardTimes     []time.Time
	aiBatch        []int32
	abuseBatch     []int32
	guardBatch     []int32
	aiRemaining    int64
	abuseRemain    int64
	guardRemain    int64
}

func (repository *commandRepository) CountCandidates(_ context.Context, now time.Time) (applicationcleanup.CandidateCounts, error) {
	repository.countNow = now
	return repository.counts, repository.countErr
}

func (repository *commandRepository) DeleteAIUsageEventsBatch(_ context.Context, now time.Time, batchSize int32) (int64, error) {
	repository.aiTimes = append(repository.aiTimes, now)
	repository.aiBatch = append(repository.aiBatch, batchSize)
	if repository.deleteErr != nil && (repository.aiFailureAt == 0 || len(repository.aiTimes) == repository.aiFailureAt) {
		return 0, repository.deleteErr
	}
	deleted := min(repository.aiRemaining, int64(batchSize))
	repository.aiRemaining -= deleted
	return deleted, nil
}

func (repository *commandRepository) DeleteAbuseRateBucketsBatch(_ context.Context, now time.Time, batchSize int32) (int64, error) {
	repository.abuseTimes = append(repository.abuseTimes, now)
	repository.abuseBatch = append(repository.abuseBatch, batchSize)
	if repository.deleteErr != nil && (repository.abuseFailureAt == 0 || len(repository.abuseTimes) == repository.abuseFailureAt) {
		return 0, repository.deleteErr
	}
	deleted := min(repository.abuseRemain, int64(batchSize))
	repository.abuseRemain -= deleted
	return deleted, nil
}

func (repository *commandRepository) DeleteAnonymousRateLimitGuardsBatch(
	_ context.Context,
	now time.Time,
	batchSize int32,
) (int64, error) {
	repository.guardTimes = append(repository.guardTimes, now)
	repository.guardBatch = append(repository.guardBatch, batchSize)
	deleted := min(repository.guardRemain, int64(batchSize))
	repository.guardRemain -= deleted
	return deleted, nil
}

func TestParseCleanupOptionsRequiresOneModeAndExplicitSafeExecuteBatch(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want cleanupOptions
		ok   bool
	}{
		{name: "dry run", args: []string{"--dry-run"}, want: cleanupOptions{mode: applicationcleanup.ModeDryRun}, ok: true},
		{name: "execute", args: []string{"--execute", "--batch-size=1000"}, want: cleanupOptions{mode: applicationcleanup.ModeExecute, batchSize: 1000}, ok: true},
		{name: "no mode"},
		{name: "both", args: []string{"--dry-run", "--execute", "--batch-size=1"}},
		{name: "both with false", args: []string{"--dry-run=false", "--execute", "--batch-size=1"}},
		{name: "false mode", args: []string{"--dry-run=false"}},
		{name: "execute no batch", args: []string{"--execute"}},
		{name: "execute zero", args: []string{"--execute", "--batch-size=0"}},
		{name: "execute negative", args: []string{"--execute", "--batch-size=-1"}},
		{name: "execute over safety bound", args: []string{"--execute", "--batch-size=1001"}},
		{name: "dry run batch", args: []string{"--dry-run", "--batch-size=1"}},
		{name: "positional", args: []string{"--dry-run", "private-value"}},
		{name: "unknown", args: []string{"--private-token=SESSION_TOKEN_CANARY"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseCleanupOptions(test.args)
			if test.ok {
				if err != nil || got != test.want {
					t.Fatalf("parse = %+v/%v, want %+v", got, err, test.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("parse unexpectedly succeeded: %+v", got)
			}
		})
	}
}

func TestInvalidCLIStopsBeforeClockDatabaseAndDoesNotEchoCanaries(t *testing.T) {
	invalidArguments := [][]string{
		{"--execute"},
		{"--execute", "--batch-size=-1"},
		{"--execute", "--batch-size=1001"},
		{"--dry-run", "--batch-size=GOAL_BODY_CANARY"},
		{"--private-token=SESSION_TOKEN_CANARY"},
	}
	for index, arguments := range invalidArguments {
		t.Run(fmt.Sprintf("%d", index), func(t *testing.T) {
			var output bytes.Buffer
			clock := &commandClock{now: time.Now()}
			lookupCalls := 0
			openCalls := 0
			exitCode := runCleanupCommand(t.Context(), arguments, func(key string) (string, bool) {
				lookupCalls++
				return "postgres://DATABASE_URL_SECRET_CANARY", true
			}, &output, commandDependencies{
				clock: clock,
				openRepository: func(context.Context, string) (applicationcleanup.Repository, func(), error) {
					openCalls++
					return &commandRepository{}, func() {}, nil
				},
			})
			if exitCode != 1 || lookupCalls != 0 || clock.calls != 0 || openCalls != 0 {
				t.Fatalf("invalid command exit/lookup/clock/open = %d/%d/%d/%d", exitCode, lookupCalls, clock.calls, openCalls)
			}
			for _, canary := range []string{"GOAL_BODY_CANARY", "SESSION_TOKEN_CANARY", "DATABASE_URL_SECRET_CANARY", "private-token"} {
				if strings.Contains(output.String(), canary) {
					t.Fatalf("invalid command echoed %q: %s", canary, output.String())
				}
			}
			record := decodeCleanupLog(t, output.String())
			if record["operation"] != "retention_cleanup" || record["error_class"] != "cleanup_arguments_invalid" {
				t.Fatalf("invalid command log = %v", record)
			}
		})
	}
}

func TestInvalidDatabaseURLStopsBeforeClockAndRepositoryWithoutEchoingValues(t *testing.T) {
	const canary = "DATABASE_URL_RAW_CANARY"
	invalidURLs := []string{
		"postgres://",
		"postgres://url-user@db.example:5432",
		"postgres://db.example:5432/url-db",
		"postgres://url-user@db.example:5432/url-db?host=" + canary,
		"postgres://url-user:" + canary + "@db.example:5432/url-db?service=unsafe",
	}
	for index, databaseURL := range invalidURLs {
		t.Run(fmt.Sprintf("%d", index), func(t *testing.T) {
			var output bytes.Buffer
			clock := &commandClock{now: time.Now()}
			lookupCalls := 0
			openCalls := 0
			exitCode := runCleanupCommand(t.Context(), []string{"--dry-run"}, func(key string) (string, bool) {
				lookupCalls++
				if key != "DATABASE_URL" {
					t.Fatalf("environment key = %q", key)
				}
				return databaseURL, true
			}, &output, commandDependencies{
				clock: clock,
				openRepository: func(context.Context, string) (applicationcleanup.Repository, func(), error) {
					openCalls++
					return &commandRepository{}, func() {}, nil
				},
			})
			if exitCode != 1 || lookupCalls != 1 || clock.calls != 0 || openCalls != 0 {
				t.Fatalf("invalid URL exit/lookup/clock/open = %d/%d/%d/%d", exitCode, lookupCalls, clock.calls, openCalls)
			}
			if strings.Contains(output.String(), canary) || strings.Contains(output.String(), databaseURL) {
				t.Fatalf("invalid URL log exposed input: %s", output.String())
			}
			record := decodeCleanupLog(t, output.String())
			if record["operation"] != "retention_cleanup" || record["cleanup_mode"] != "dry_run" ||
				record["error_class"] != "cleanup_configuration_invalid" {
				t.Fatalf("invalid URL log = %v", record)
			}
		})
	}
}

func TestDryRunReadsOnlyDatabaseURLCapturesNowOnceAndLogsAggregates(t *testing.T) {
	const databaseURL = "postgres://cleanup-user:DATABASE_URL_SECRET_CANARY@db.example:5432/cleanup-db?sslmode=disable"
	now := time.Date(2026, time.August, 25, 12, 34, 56, 789, time.FixedZone("JST", 9*60*60))
	clock := &commandClock{now: now}
	repository := &commandRepository{counts: applicationcleanup.CandidateCounts{
		AIUsageEvents: 2, AbuseRateBuckets: 4, AnonymousRateLimitGuards: 6,
	}}
	var output bytes.Buffer
	lookupKeys := []string{}
	closed := 0
	exitCode := runCleanupCommand(t.Context(), []string{"--dry-run"}, func(key string) (string, bool) {
		lookupKeys = append(lookupKeys, key)
		return databaseURL, true
	}, &output, commandDependencies{
		clock: clock,
		openRepository: func(_ context.Context, gotURL string) (applicationcleanup.Repository, func(), error) {
			if gotURL != databaseURL {
				t.Fatalf("database URL = %q", gotURL)
			}
			return repository, func() { closed++ }, nil
		},
	})
	if exitCode != 0 || clock.calls != 1 || closed != 1 || len(lookupKeys) != 1 || lookupKeys[0] != "DATABASE_URL" {
		t.Fatalf("dry-run exit/clock/close/lookups = %d/%d/%d/%v", exitCode, clock.calls, closed, lookupKeys)
	}
	if !repository.countNow.Equal(now.UTC()) || repository.countNow.Location() != time.UTC ||
		len(repository.aiTimes) != 0 || len(repository.abuseTimes) != 0 || len(repository.guardTimes) != 0 {
		t.Fatalf("dry-run repository time/mutations = %s/%d/%d/%d",
			repository.countNow, len(repository.aiTimes), len(repository.abuseTimes), len(repository.guardTimes))
	}
	if strings.Contains(output.String(), "DATABASE_URL_SECRET_CANARY") {
		t.Fatalf("dry-run leaked database URL: %s", output.String())
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("dry-run log lines = %d: %s", len(lines), output.String())
	}
	ai := decodeCleanupLog(t, lines[0])
	abuse := decodeCleanupLog(t, lines[1])
	guards := decodeCleanupLog(t, lines[2])
	assertCleanupAggregate(t, ai, "dry_run", "ai_usage_events", 2, 0, 0)
	assertCleanupAggregate(t, abuse, "dry_run", "abuse_rate_buckets", 4, 0, 0)
	assertCleanupAggregate(t, guards, "dry_run", "anonymous_rate_limit_guards", 6, 0, 0)
}

func TestExecuteUsesFixedCaptureAndExplicitBatch(t *testing.T) {
	now := time.Date(2026, time.August, 25, 1, 2, 3, 4, time.UTC)
	clock := &commandClock{now: now}
	repository := &commandRepository{aiRemaining: 3, abuseRemain: 1, guardRemain: 2}
	var output bytes.Buffer
	exitCode := runCleanupCommand(t.Context(), []string{"--execute", "--batch-size=2"}, fixedDatabaseLookup, &output, commandDependencies{
		clock: clock,
		openRepository: func(context.Context, string) (applicationcleanup.Repository, func(), error) {
			return repository, func() {}, nil
		},
	})
	if exitCode != 0 || clock.calls != 1 {
		t.Fatalf("execute exit/clock = %d/%d", exitCode, clock.calls)
	}
	if len(repository.aiBatch) != 3 || len(repository.abuseBatch) != 2 || len(repository.guardBatch) != 2 {
		t.Fatalf("execute batch calls = ai:%v abuse:%v guards:%v",
			repository.aiBatch, repository.abuseBatch, repository.guardBatch)
	}
	allCaptured := append([]time.Time{}, repository.aiTimes...)
	allCaptured = append(allCaptured, repository.abuseTimes...)
	allCaptured = append(allCaptured, repository.guardTimes...)
	for _, captured := range allCaptured {
		if !captured.Equal(now) {
			t.Fatalf("execute changed captured deadline to %s", captured)
		}
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	assertCleanupAggregate(t, decodeCleanupLog(t, lines[0]), "execute", "ai_usage_events", 3, 3, 2)
	assertCleanupAggregate(t, decodeCleanupLog(t, lines[1]), "execute", "abuse_rate_buckets", 1, 1, 1)
	assertCleanupAggregate(t, decodeCleanupLog(t, lines[2]), "execute", "anonymous_rate_limit_guards", 2, 2, 1)
}

func TestExecuteFailureLogsCommittedPartialAggregatesBeforeSafeFailure(t *testing.T) {
	const canary = "PRIVATE_PARTIAL_ERROR_CANARY"
	repository := &commandRepository{
		aiRemaining: 3,
		deleteErr:   errors.New(canary),
		aiFailureAt: 2,
	}
	var output bytes.Buffer
	exitCode := runCleanupCommand(t.Context(), []string{"--execute", "--batch-size=1"}, fixedDatabaseLookup, &output, commandDependencies{
		clock: &commandClock{now: time.Now()},
		openRepository: func(context.Context, string) (applicationcleanup.Repository, func(), error) {
			return repository, func() {}, nil
		},
	})
	if exitCode != 1 || strings.Contains(output.String(), canary) {
		t.Fatalf("partial failure exit/log = %d/%s", exitCode, output.String())
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("partial failure lines = %d: %s", len(lines), output.String())
	}
	assertCleanupAggregate(t, decodeCleanupLog(t, lines[0]), "execute", "ai_usage_events", 1, 1, 1)
	assertCleanupAggregate(t, decodeCleanupLog(t, lines[1]), "execute", "abuse_rate_buckets", 0, 0, 0)
	assertCleanupAggregate(t, decodeCleanupLog(t, lines[2]), "execute", "anonymous_rate_limit_guards", 0, 0, 0)
	failure := decodeCleanupLog(t, lines[3])
	if failure["error_class"] != "cleanup_execution_failed" || failure["cleanup_mode"] != "execute" {
		t.Fatalf("partial failure classification = %v", failure)
	}
}

func TestRepositoryConfigurationFailureUsesSafeConfigurationClass(t *testing.T) {
	const canary = "AMBIENT_PG_RAW_CANARY"
	var output bytes.Buffer
	exitCode := runCleanupCommand(t.Context(), []string{"--dry-run"}, fixedDatabaseLookup, &output, commandDependencies{
		clock: &commandClock{now: time.Now()},
		openRepository: func(context.Context, string) (applicationcleanup.Repository, func(), error) {
			return nil, nil, fmt.Errorf("%s: %w", canary, postgres.ErrCleanupDatabaseConfiguration)
		},
	})
	if exitCode != 1 || strings.Contains(output.String(), canary) {
		t.Fatalf("configuration failure exit/log = %d/%s", exitCode, output.String())
	}
	record := decodeCleanupLog(t, output.String())
	if record["error_class"] != "cleanup_configuration_invalid" || record["cleanup_mode"] != "dry_run" {
		t.Fatalf("configuration failure log = %v", record)
	}
}

func TestDatabaseAndExecutionErrorsNeverLogRawValues(t *testing.T) {
	const canary = "GOAL_BODY_SESSION_TOKEN_DATABASE_URL_CANARY"
	tests := []struct {
		name       string
		open       repositoryOpener
		repository *commandRepository
	}{
		{name: "open", open: func(context.Context, string) (applicationcleanup.Repository, func(), error) {
			return nil, nil, errors.New(canary)
		}},
		{name: "execute", repository: &commandRepository{deleteErr: errors.New(canary)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			opener := test.open
			if opener == nil {
				opener = func(context.Context, string) (applicationcleanup.Repository, func(), error) {
					return test.repository, func() {}, nil
				}
			}
			exitCode := runCleanupCommand(t.Context(), []string{"--execute", "--batch-size=1"}, fixedDatabaseLookup, &output, commandDependencies{
				clock:          &commandClock{now: time.Now()},
				openRepository: opener,
			})
			if exitCode != 1 || strings.Contains(output.String(), canary) {
				t.Fatalf("failure exit/log = %d/%s", exitCode, output.String())
			}
		})
	}
}

func fixedDatabaseLookup(key string) (string, bool) {
	if key != "DATABASE_URL" {
		panic("unexpected environment lookup")
	}
	return "postgres://cleanup-user:test-password@db.example:5432/cleanup-db?sslmode=disable", true
}

func decodeCleanupLog(t *testing.T, line string) map[string]any {
	t.Helper()
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &record); err != nil {
		t.Fatalf("decode log %q: %v", line, err)
	}
	return record
}

func assertCleanupAggregate(t *testing.T, record map[string]any, mode, resource string, candidate, deleted, batches int64) {
	t.Helper()
	if record["operation"] != "retention_cleanup" || record["cleanup_mode"] != mode ||
		record["cleanup_resource"] != resource || record["cleanup_candidate_count"] != float64(candidate) ||
		record["cleanup_deleted_count"] != float64(deleted) || record["cleanup_batch_count"] != float64(batches) {
		t.Fatalf("cleanup aggregate = %v", record)
	}
}
