// Package cleanup owns retention-cleanup orchestration independently from the
// PostgreSQL implementation and the maintenance command.
package cleanup

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	ErrInvalidBatchSize = errors.New("cleanup batch size is invalid")
	ErrInvalidDeadline  = errors.New("cleanup deadline is invalid")
	ErrRepositoryState  = errors.New("cleanup repository returned an invalid count")
)

type Mode string

const (
	ModeDryRun   Mode  = "dry_run"
	ModeExecute  Mode  = "execute"
	MaxBatchSize int64 = 1000
)

type CandidateCounts struct {
	AIUsageEvents    int64
	AbuseRateBuckets int64
}

type ResourceResult struct {
	CandidateCount int64
	DeletedCount   int64
	BatchCount     int64
}

type Result struct {
	Mode             Mode
	AIUsageEvents    ResourceResult
	AbuseRateBuckets ResourceResult
}

type Repository interface {
	CountCandidates(context.Context, time.Time) (CandidateCounts, error)
	DeleteAIUsageEventsBatch(context.Context, time.Time, int32) (int64, error)
	DeleteAbuseRateBucketsBatch(context.Context, time.Time, int32) (int64, error)
}

type Service struct {
	repository Repository
}

func NewService(repository Repository) *Service {
	return &Service{repository: repository}
}

func (service *Service) DryRun(ctx context.Context, capturedNow time.Time) (Result, error) {
	result := Result{Mode: ModeDryRun}
	if capturedNow.IsZero() {
		return result, ErrInvalidDeadline
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	counts, err := service.repository.CountCandidates(ctx, capturedNow.UTC())
	if err != nil {
		return result, err
	}
	if counts.AIUsageEvents < 0 || counts.AbuseRateBuckets < 0 {
		return result, ErrRepositoryState
	}
	result.AIUsageEvents.CandidateCount = counts.AIUsageEvents
	result.AbuseRateBuckets.CandidateCount = counts.AbuseRateBuckets
	return result, nil
}

func (service *Service) Execute(ctx context.Context, capturedNow time.Time, batchSize int64) (Result, error) {
	result := Result{Mode: ModeExecute}
	if capturedNow.IsZero() {
		return result, ErrInvalidDeadline
	}
	if batchSize <= 0 || batchSize > MaxBatchSize {
		return result, ErrInvalidBatchSize
	}
	deadline := capturedNow.UTC()
	batch := int32(batchSize)
	var err error
	result.AIUsageEvents, err = runBatches(ctx, batch, func(ctx context.Context) (int64, error) {
		return service.repository.DeleteAIUsageEventsBatch(ctx, deadline, batch)
	})
	if err != nil {
		return result, err
	}
	result.AbuseRateBuckets, err = runBatches(ctx, batch, func(ctx context.Context) (int64, error) {
		return service.repository.DeleteAbuseRateBucketsBatch(ctx, deadline, batch)
	})
	return result, err
}

func runBatches(ctx context.Context, batchSize int32, deleteBatch func(context.Context) (int64, error)) (ResourceResult, error) {
	var result ResourceResult
	for {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		deleted, err := deleteBatch(ctx)
		if err != nil {
			return result, err
		}
		if deleted < 0 || deleted > int64(batchSize) {
			return result, fmt.Errorf("%w: deleted=%d batch_size=%d", ErrRepositoryState, deleted, batchSize)
		}
		if deleted == 0 {
			return result, nil
		}
		result.CandidateCount += deleted
		result.DeletedCount += deleted
		result.BatchCount++
	}
}
