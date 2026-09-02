package cleanup

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

type fakeRepository struct {
	countResult  CandidateCounts
	countErr     error
	countNow     time.Time
	countCalls   int
	aiResults    []int64
	abuseResults []int64
	guardResults []int64
	aiCalls      int
	abuseCalls   int
	guardCalls   int
	deleteTimes  []time.Time
	batchSizes   []int32
	deleteOrder  []string
}

func (repository *fakeRepository) CountCandidates(_ context.Context, now time.Time) (CandidateCounts, error) {
	repository.countCalls++
	repository.countNow = now
	return repository.countResult, repository.countErr
}

func (repository *fakeRepository) DeleteAIUsageEventsBatch(_ context.Context, now time.Time, batchSize int32) (int64, error) {
	repository.aiCalls++
	repository.deleteOrder = append(repository.deleteOrder, "ai_usage_events")
	repository.deleteTimes = append(repository.deleteTimes, now)
	repository.batchSizes = append(repository.batchSizes, batchSize)
	return nextResult(&repository.aiResults), nil
}

func (repository *fakeRepository) DeleteAbuseRateBucketsBatch(_ context.Context, now time.Time, batchSize int32) (int64, error) {
	repository.abuseCalls++
	repository.deleteOrder = append(repository.deleteOrder, "abuse_rate_buckets")
	repository.deleteTimes = append(repository.deleteTimes, now)
	repository.batchSizes = append(repository.batchSizes, batchSize)
	return nextResult(&repository.abuseResults), nil
}

func (repository *fakeRepository) DeleteAnonymousRateLimitGuardsBatch(
	_ context.Context,
	now time.Time,
	batchSize int32,
) (int64, error) {
	repository.guardCalls++
	repository.deleteOrder = append(repository.deleteOrder, "anonymous_rate_limit_guards")
	repository.deleteTimes = append(repository.deleteTimes, now)
	repository.batchSizes = append(repository.batchSizes, batchSize)
	return nextResult(&repository.guardResults), nil
}

func nextResult(results *[]int64) int64 {
	if len(*results) == 0 {
		return 0
	}
	result := (*results)[0]
	*results = (*results)[1:]
	return result
}

func TestDryRunUsesOneUTCReadOnlyRepositorySnapshot(t *testing.T) {
	repository := &fakeRepository{countResult: CandidateCounts{
		AIUsageEvents: 3, AbuseRateBuckets: 5, AnonymousRateLimitGuards: 7,
	}}
	service := NewService(repository)
	local := time.Date(2026, time.August, 25, 9, 30, 0, 0, time.FixedZone("JST", 9*60*60))
	result, err := service.DryRun(t.Context(), local)
	if err != nil {
		t.Fatal(err)
	}
	if repository.countCalls != 1 || !repository.countNow.Equal(local.UTC()) || repository.countNow.Location() != time.UTC {
		t.Fatalf("snapshot calls/time = %d/%s, want one UTC capture %s", repository.countCalls, repository.countNow, local.UTC())
	}
	if repository.aiCalls != 0 || repository.abuseCalls != 0 || repository.guardCalls != 0 {
		t.Fatalf("dry-run mutation calls = ai:%d abuse:%d guards:%d",
			repository.aiCalls, repository.abuseCalls, repository.guardCalls)
	}
	if result.Mode != ModeDryRun || result.AIUsageEvents.CandidateCount != 3 ||
		result.AbuseRateBuckets.CandidateCount != 5 || result.AnonymousRateLimitGuards.CandidateCount != 7 ||
		result.AIUsageEvents.DeletedCount != 0 || result.AbuseRateBuckets.DeletedCount != 0 ||
		result.AnonymousRateLimitGuards.DeletedCount != 0 {
		t.Fatalf("dry-run result = %+v", result)
	}
}

func TestExecuteUsesFixedDeadlineAndBoundedResourceSpecificBatches(t *testing.T) {
	repository := &fakeRepository{
		aiResults: []int64{2, 1, 0}, abuseResults: []int64{2, 2, 0}, guardResults: []int64{1, 0},
	}
	service := NewService(repository)
	now := time.Date(2026, time.August, 25, 10, 0, 0, 123456000, time.FixedZone("offset", 3*60*60))
	result, err := service.Execute(t.Context(), now, 2)
	if err != nil {
		t.Fatal(err)
	}
	if result.AIUsageEvents != (ResourceResult{CandidateCount: 3, DeletedCount: 3, BatchCount: 2}) ||
		result.AbuseRateBuckets != (ResourceResult{CandidateCount: 4, DeletedCount: 4, BatchCount: 2}) ||
		result.AnonymousRateLimitGuards != (ResourceResult{CandidateCount: 1, DeletedCount: 1, BatchCount: 1}) {
		t.Fatalf("execute result = %+v", result)
	}
	if repository.aiCalls != 3 || repository.abuseCalls != 3 || repository.guardCalls != 2 {
		t.Fatalf("batch calls = ai:%d abuse:%d guards:%d, want 3/3/2 including terminal empty transactions",
			repository.aiCalls, repository.abuseCalls, repository.guardCalls)
	}
	wantOrder := []string{
		"ai_usage_events", "ai_usage_events", "ai_usage_events",
		"abuse_rate_buckets", "abuse_rate_buckets", "abuse_rate_buckets",
		"anonymous_rate_limit_guards", "anonymous_rate_limit_guards",
	}
	if fmt.Sprint(repository.deleteOrder) != fmt.Sprint(wantOrder) {
		t.Fatalf("resource order = %v, want %v", repository.deleteOrder, wantOrder)
	}
	for index, got := range repository.deleteTimes {
		if !got.Equal(now.UTC()) || got.Location() != time.UTC || repository.batchSizes[index] != 2 {
			t.Fatalf("call %d deadline/batch = %s/%d", index, got, repository.batchSizes[index])
		}
	}
}

func TestCleanupRejectsZeroDeadlineWithoutRepositoryAccess(t *testing.T) {
	repository := &fakeRepository{}
	service := NewService(repository)
	if _, err := service.DryRun(t.Context(), time.Time{}); !errors.Is(err, ErrInvalidDeadline) {
		t.Fatalf("dry-run zero deadline error = %v", err)
	}
	if _, err := service.Execute(t.Context(), time.Time{}, 1); !errors.Is(err, ErrInvalidDeadline) {
		t.Fatalf("execute zero deadline error = %v", err)
	}
	if repository.countCalls != 0 || repository.aiCalls != 0 || repository.abuseCalls != 0 || repository.guardCalls != 0 {
		t.Fatalf("zero deadline accessed repository: %+v", repository)
	}
}

func TestExecuteRejectsInvalidBatchWithoutRepositoryMutation(t *testing.T) {
	for _, batchSize := range []int64{-1, 0, MaxBatchSize + 1} {
		t.Run(fmt.Sprintf("%d", batchSize), func(t *testing.T) {
			repository := &fakeRepository{}
			_, err := NewService(repository).Execute(t.Context(), time.Now(), batchSize)
			if !errors.Is(err, ErrInvalidBatchSize) {
				t.Fatalf("batch %d error = %v", batchSize, err)
			}
			if repository.aiCalls != 0 || repository.abuseCalls != 0 || repository.guardCalls != 0 || repository.countCalls != 0 {
				t.Fatalf("batch %d mutated repository", batchSize)
			}
		})
	}
}

type cancelAfterOneBatchRepository struct {
	cancel    context.CancelFunc
	remaining int64
	calls     int
	canceled  bool
}

func (*cancelAfterOneBatchRepository) CountCandidates(context.Context, time.Time) (CandidateCounts, error) {
	return CandidateCounts{}, nil
}

func (repository *cancelAfterOneBatchRepository) DeleteAIUsageEventsBatch(
	_ context.Context,
	_ time.Time,
	_ int32,
) (int64, error) {
	repository.calls++
	if repository.remaining == 0 {
		return 0, nil
	}
	repository.remaining--
	if !repository.canceled {
		repository.canceled = true
		repository.cancel()
	}
	return 1, nil
}

func (*cancelAfterOneBatchRepository) DeleteAbuseRateBucketsBatch(context.Context, time.Time, int32) (int64, error) {
	return 0, nil
}

func (*cancelAfterOneBatchRepository) DeleteAnonymousRateLimitGuardsBatch(
	context.Context,
	time.Time,
	int32,
) (int64, error) {
	return 0, nil
}

func TestCancellationAfterCommittedBatchReturnsPartialResultAndRerunFinishesRemaining(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	repository := &cancelAfterOneBatchRepository{cancel: cancel, remaining: 2}
	service := NewService(repository)
	now := time.Date(2026, time.August, 25, 0, 0, 0, 0, time.UTC)

	partial, err := service.Execute(ctx, now, 1)
	if !errors.Is(err, context.Canceled) ||
		partial.AIUsageEvents != (ResourceResult{CandidateCount: 1, DeletedCount: 1, BatchCount: 1}) {
		t.Fatalf("canceled partial result/error = %+v/%v", partial, err)
	}
	if repository.calls != 1 || repository.remaining != 1 {
		t.Fatalf("canceled cleanup calls/remaining = %d/%d, want 1/1", repository.calls, repository.remaining)
	}

	rerun, err := service.Execute(context.Background(), now, 1)
	if err != nil ||
		rerun.AIUsageEvents != (ResourceResult{CandidateCount: 1, DeletedCount: 1, BatchCount: 1}) ||
		repository.remaining != 0 {
		t.Fatalf("cleanup rerun result/error/remaining = %+v/%v/%d", rerun, err, repository.remaining)
	}
}

func TestExecuteFailsClosedOnImpossibleRepositoryCount(t *testing.T) {
	repository := &fakeRepository{aiResults: []int64{3}}
	_, err := NewService(repository).Execute(t.Context(), time.Now(), 2)
	if !errors.Is(err, ErrRepositoryState) || repository.abuseCalls != 0 || repository.guardCalls != 0 {
		t.Fatalf("invalid repository count error/calls = %v/%d/%d", err, repository.abuseCalls, repository.guardCalls)
	}
}

func TestDryRunFailsClosedOnImpossibleAnonymousGuardCount(t *testing.T) {
	repository := &fakeRepository{countResult: CandidateCounts{AnonymousRateLimitGuards: -1}}
	result, err := NewService(repository).DryRun(t.Context(), time.Now())
	if !errors.Is(err, ErrRepositoryState) || result != (Result{Mode: ModeDryRun}) ||
		repository.aiCalls != 0 || repository.abuseCalls != 0 || repository.guardCalls != 0 {
		t.Fatalf("invalid guard count result/error/repository = %+v/%v/%+v", result, err, repository)
	}
}

func TestCanceledCleanupDoesNotStartAnotherTransaction(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	repository := &fakeRepository{}
	_, err := NewService(repository).Execute(ctx, time.Now(), 1)
	if !errors.Is(err, context.Canceled) || repository.aiCalls != 0 || repository.abuseCalls != 0 || repository.guardCalls != 0 {
		t.Fatalf("canceled execute = %v, calls ai:%d abuse:%d guards:%d",
			err, repository.aiCalls, repository.abuseCalls, repository.guardCalls)
	}
}
