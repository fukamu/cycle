// Package kpireport owns the aggregate-only survivor-funnel report contract.
package kpireport

import (
	"context"
	"errors"
	"math"
	"time"
)

const (
	SchemaVersion = "kpi-report-v1"
	QueryVersion  = "survivor-funnel-v1"
)

var (
	ErrInvalidWindow     = errors.New("KPI report window is invalid")
	ErrInvalidAggregates = errors.New("KPI report aggregates are invalid")
	reportLimitations    = []string{"survivor_only", "not_d1_d7", "draft_recovery_unobserved"}
)

type Query struct {
	CohortStart time.Time
	CohortEnd   time.Time
	AsOf        time.Time
}

type DurationSummary struct {
	ObservationCount int64    `json:"observationCount"`
	P50Seconds       *float64 `json:"p50Seconds"`
	P90Seconds       *float64 `json:"p90Seconds"`
}

type Stage struct {
	Numerator                int64 `json:"numerator"`
	CohortDenominator        int64 `json:"cohortDenominator"`
	PreviousStageDenominator int64 `json:"previousStageDenominator"`
}

type Metadata struct {
	SchemaVersion      string    `json:"schemaVersion"`
	QueryVersion       string    `json:"queryVersion"`
	AsOf               time.Time `json:"asOf"`
	CohortStart        time.Time `json:"cohortStart"`
	CohortEndExclusive time.Time `json:"cohortEndExclusive"`
	CountingUnit       string    `json:"countingUnit"`
	SurvivorOnly       bool      `json:"survivorOnly"`
}

type Activation48h struct {
	Numerator         int64           `json:"numerator"`
	CohortDenominator int64           `json:"cohortDenominator"`
	TimeToFirstGoal   DurationSummary `json:"timeToFirstGoalSeconds"`
}

type FirstGoalFunnel168h struct {
	CohortDenominator                int64           `json:"cohortDenominator"`
	Cycle1Completed                  Stage           `json:"cycle1Completed"`
	ReviewDecision                   Stage           `json:"reviewDecision"`
	ReviewDecisionNextCycle          Stage           `json:"reviewDecisionNextCycle"`
	ReviewDecisionTerminalReview     Stage           `json:"reviewDecisionTerminalReview"`
	Cycle2Started                    Stage           `json:"cycle2Started"`
	Cycle3Started                    Stage           `json:"cycle3Started"`
	TimeToCycle1Complete             DurationSummary `json:"timeToCycle1CompleteSeconds"`
	TimeFromCycle1CompleteToDecision DurationSummary `json:"timeFromCycle1CompleteToReviewDecisionSeconds"`
}

type Report struct {
	Metadata            Metadata            `json:"metadata"`
	Activation48h       Activation48h       `json:"activation48h"`
	FirstGoalFunnel168h FirstGoalFunnel168h `json:"firstGoalFunnel168h"`
	Limitations         []string            `json:"limitations"`
}

// Aggregates is the aggregate-only result returned by the reporting adapter.
// It intentionally has no identifier, content, email, or event timestamp field.
type Aggregates struct {
	ActivationDenominator int64
	ActivationNumerator   int64
	ActivationDuration    DurationSummary

	FirstGoalDenominator int64
	Cycle1Completed      int64
	ReviewDecision       int64
	NextCycleDecision    int64
	TerminalDecision     int64
	Cycle2Started        int64
	Cycle3Started        int64
	Cycle1Duration       DurationSummary
	DecisionDuration     DurationSummary
}

type Repository interface {
	Aggregate(context.Context, Query) (Aggregates, error)
}

type Service struct {
	repository Repository
}

func NewService(repository Repository) *Service {
	return &Service{repository: repository}
}

func (service *Service) Generate(ctx context.Context, query Query) (Report, error) {
	query = Query{
		CohortStart: query.CohortStart.UTC(),
		CohortEnd:   query.CohortEnd.UTC(),
		AsOf:        query.AsOf.UTC(),
	}
	if query.CohortStart.IsZero() || query.CohortEnd.IsZero() || query.AsOf.IsZero() ||
		!query.CohortStart.Before(query.CohortEnd) || query.CohortEnd.After(query.AsOf) {
		return Report{}, ErrInvalidWindow
	}
	if err := ctx.Err(); err != nil {
		return Report{}, err
	}
	aggregates, err := service.repository.Aggregate(ctx, query)
	if err != nil {
		return Report{}, err
	}
	if !validAggregates(aggregates) {
		return Report{}, ErrInvalidAggregates
	}

	firstGoalDenominator := aggregates.FirstGoalDenominator
	reviewDenominator := aggregates.Cycle1Completed
	decisionBranchDenominator := aggregates.ReviewDecision
	cycle3Denominator := aggregates.Cycle2Started
	return Report{
		Metadata: Metadata{
			SchemaVersion:      SchemaVersion,
			QueryVersion:       QueryVersion,
			AsOf:               query.AsOf,
			CohortStart:        query.CohortStart,
			CohortEndExclusive: query.CohortEnd,
			CountingUnit:       "application_user",
			SurvivorOnly:       true,
		},
		Activation48h: Activation48h{
			Numerator:         aggregates.ActivationNumerator,
			CohortDenominator: aggregates.ActivationDenominator,
			TimeToFirstGoal:   aggregates.ActivationDuration,
		},
		FirstGoalFunnel168h: FirstGoalFunnel168h{
			CohortDenominator: firstGoalDenominator,
			Cycle1Completed:   stage(aggregates.Cycle1Completed, firstGoalDenominator, firstGoalDenominator),
			ReviewDecision:    stage(aggregates.ReviewDecision, firstGoalDenominator, reviewDenominator),
			ReviewDecisionNextCycle: stage(
				aggregates.NextCycleDecision,
				firstGoalDenominator,
				decisionBranchDenominator,
			),
			ReviewDecisionTerminalReview: stage(
				aggregates.TerminalDecision,
				firstGoalDenominator,
				decisionBranchDenominator,
			),
			Cycle2Started:                    stage(aggregates.Cycle2Started, firstGoalDenominator, decisionBranchDenominator),
			Cycle3Started:                    stage(aggregates.Cycle3Started, firstGoalDenominator, cycle3Denominator),
			TimeToCycle1Complete:             aggregates.Cycle1Duration,
			TimeFromCycle1CompleteToDecision: aggregates.DecisionDuration,
		},
		Limitations: append([]string(nil), reportLimitations...),
	}, nil
}

func stage(numerator, cohortDenominator, previousStageDenominator int64) Stage {
	return Stage{
		Numerator:                numerator,
		CohortDenominator:        cohortDenominator,
		PreviousStageDenominator: previousStageDenominator,
	}
}

func validAggregates(value Aggregates) bool {
	counts := []int64{
		value.ActivationDenominator,
		value.ActivationNumerator,
		value.FirstGoalDenominator,
		value.Cycle1Completed,
		value.ReviewDecision,
		value.NextCycleDecision,
		value.TerminalDecision,
		value.Cycle2Started,
		value.Cycle3Started,
	}
	for _, count := range counts {
		if count < 0 {
			return false
		}
	}
	if value.ActivationNumerator > value.ActivationDenominator ||
		value.Cycle1Completed > value.FirstGoalDenominator ||
		value.ReviewDecision > value.Cycle1Completed ||
		value.NextCycleDecision+value.TerminalDecision != value.ReviewDecision ||
		value.Cycle2Started != value.NextCycleDecision ||
		value.Cycle3Started > value.Cycle2Started {
		return false
	}
	return validDuration(value.ActivationDuration, value.ActivationNumerator) &&
		validDuration(value.Cycle1Duration, value.Cycle1Completed) &&
		validDuration(value.DecisionDuration, value.ReviewDecision)
}

func validDuration(value DurationSummary, expectedCount int64) bool {
	if value.ObservationCount != expectedCount {
		return false
	}
	if value.ObservationCount == 0 {
		return value.P50Seconds == nil && value.P90Seconds == nil
	}
	if value.P50Seconds == nil || value.P90Seconds == nil {
		return false
	}
	p50 := *value.P50Seconds
	p90 := *value.P90Seconds
	return p50 >= 0 && p90 >= p50 && !math.IsNaN(p50) && !math.IsNaN(p90) &&
		!math.IsInf(p50, 0) && !math.IsInf(p90, 0)
}
