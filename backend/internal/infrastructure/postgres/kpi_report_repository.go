package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/kpireport"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

var ErrKPIReportDatabaseConfiguration = errors.New("invalid KPI report database configuration")

type KPIReportRepository struct {
	pool *pgxpool.Pool
}

var _ kpireport.Repository = (*KPIReportRepository)(nil)

func NewKPIReportRepository(pool *pgxpool.Pool) *KPIReportRepository {
	return &KPIReportRepository{pool: pool}
}

// ValidateKPIReportDatabaseURL applies the single-target, explicit PostgreSQL
// connection contract without connecting or including the input in an error.
func ValidateKPIReportDatabaseURL(databaseURL string) error {
	if _, err := normalizeCleanupDatabaseURL(databaseURL); err != nil {
		return ErrKPIReportDatabaseConfiguration
	}
	return nil
}

// OpenKPIReportRepository opens only the explicitly supplied KPI_DATABASE_URL.
// Ambient PG* connection settings are rejected by kpiReportPoolConfig.
func OpenKPIReportRepository(
	ctx context.Context,
	databaseURL string,
) (*KPIReportRepository, func(), error) {
	poolConfig, err := kpiReportPoolConfig(databaseURL, os.LookupEnv)
	if err != nil {
		return nil, nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, nil, fmt.Errorf("open KPI report database pool")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("ping KPI report database")
	}
	return NewKPIReportRepository(pool), pool.Close, nil
}

func kpiReportPoolConfig(
	databaseURL string,
	lookupEnv func(string) (string, bool),
) (*pgxpool.Config, error) {
	poolConfig, err := cleanupPoolConfig(databaseURL, lookupEnv)
	if err != nil {
		return nil, ErrKPIReportDatabaseConfiguration
	}
	poolConfig.ConnConfig.RuntimeParams["application_name"] = "fukamu_kpi_report"
	return poolConfig, nil
}

func (repository *KPIReportRepository) Aggregate(
	ctx context.Context,
	query kpireport.Query,
) (result kpireport.Aggregates, _ error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return result, err
	}
	defer rollbackCleanup(ctx, tx)

	row, err := db.New(tx).AggregateSurvivorFunnelKPI(ctx, db.AggregateSurvivorFunnelKPIParams{
		CohortStart: timestamptz(query.CohortStart),
		CohortEnd:   timestamptz(query.CohortEnd),
		AsOf:        timestamptz(query.AsOf),
	})
	if err != nil {
		return result, err
	}
	if !row.RepeatableRead || !row.ReadOnly {
		return result, fmt.Errorf("KPI report transaction is not a repeatable-read read-only snapshot")
	}

	result = kpireport.Aggregates{
		ActivationDenominator: row.ActivationDenominator,
		ActivationNumerator:   row.ActivationNumerator,
		ActivationDuration: durationSummary(
			row.ActivationDurationCount,
			row.ActivationDurationP50Seconds,
			row.ActivationDurationP90Seconds,
		),
		FirstGoalDenominator: row.FirstGoalDenominator,
		Cycle1Completed:      row.CycleOneCompleted,
		ReviewDecision:       row.ReviewDecision,
		NextCycleDecision:    row.NextCycleDecision,
		TerminalDecision:     row.TerminalReviewDecision,
		Cycle2Started:        row.CycleTwoStarted,
		Cycle3Started:        row.CycleThreeStarted,
		Cycle1Duration: durationSummary(
			row.CycleOneDurationCount,
			row.CycleOneDurationP50Seconds,
			row.CycleOneDurationP90Seconds,
		),
		DecisionDuration: durationSummary(
			row.DecisionDurationCount,
			row.DecisionDurationP50Seconds,
			row.DecisionDurationP90Seconds,
		),
	}
	if err = tx.Commit(ctx); err != nil {
		return kpireport.Aggregates{}, err
	}
	return result, nil
}

func durationSummary(count int64, p50, p90 float64) kpireport.DurationSummary {
	result := kpireport.DurationSummary{ObservationCount: count}
	if count == 0 {
		return result
	}
	result.P50Seconds = &p50
	result.P90Seconds = &p90
	return result
}
