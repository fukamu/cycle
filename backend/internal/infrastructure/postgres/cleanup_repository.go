package postgres

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	applicationcleanup "github.com/fukamu/cycle/backend/internal/application/cleanup"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type CleanupRepository struct {
	pool *pgxpool.Pool
}

var _ applicationcleanup.Repository = (*CleanupRepository)(nil)

var ErrCleanupDatabaseConfiguration = errors.New("invalid cleanup database configuration")

var cleanupPostgresEnvironmentVariables = []string{
	"PGHOST",
	"PGPORT",
	"PGDATABASE",
	"PGUSER",
	"PGPASSWORD",
	"PGPASSFILE",
	"PGAPPNAME",
	"PGCONNECT_TIMEOUT",
	"PGSSLMODE",
	"PGSSLKEY",
	"PGSSLCERT",
	"PGSSLSNI",
	"PGSSLROOTCERT",
	"PGSSLPASSWORD",
	"PGSSLNEGOTIATION",
	"PGTARGETSESSIONATTRS",
	"PGSERVICE",
	"PGSERVICEFILE",
	"PGTZ",
	"PGOPTIONS",
	"PGMINPROTOCOLVERSION",
	"PGMAXPROTOCOLVERSION",
	"PGCHANNELBINDING",
	"PGREQUIREAUTH",
}

var cleanupDatabaseURLQueryKeys = map[string]struct{}{
	"channel_binding":            {},
	"connect_timeout":            {},
	"default_query_exec_mode":    {},
	"description_cache_capacity": {},
	"krbspn":                     {},
	"krbsrvname":                 {},
	"max_protocol_version":       {},
	"min_protocol_version":       {},
	"require_auth":               {},
	"sslcert":                    {},
	"sslkey":                     {},
	"sslmode":                    {},
	"sslnegotiation":             {},
	"sslpassword":                {},
	"sslrootcert":                {},
	"sslsni":                     {},
	"statement_cache_capacity":   {},
	"target_session_attrs":       {},
}

func NewCleanupRepository(pool *pgxpool.Pool) *CleanupRepository {
	return &CleanupRepository{pool: pool}
}

// ValidateCleanupDatabaseURL checks the maintenance command's stricter,
// single-target DATABASE_URL contract without opening a pool or connecting.
func ValidateCleanupDatabaseURL(databaseURL string) error {
	_, err := normalizeCleanupDatabaseURL(databaseURL)
	return err
}

// OpenCleanupRepository opens the maintenance command's only external
// dependency from DATABASE_URL. It deliberately rejects pgx-recognized PG*
// environment configuration instead of merging ambient connection defaults.
func OpenCleanupRepository(ctx context.Context, databaseURL string) (*CleanupRepository, func(), error) {
	poolConfig, err := cleanupPoolConfig(databaseURL, os.LookupEnv)
	if err != nil {
		return nil, nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, nil, fmt.Errorf("open cleanup database pool")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("ping cleanup database")
	}
	return NewCleanupRepository(pool), pool.Close, nil
}

func cleanupPoolConfig(
	databaseURL string,
	lookupEnv func(string) (string, bool),
) (*pgxpool.Config, error) {
	normalizedURL, err := normalizeCleanupDatabaseURL(databaseURL)
	if err != nil {
		return nil, err
	}
	for _, name := range cleanupPostgresEnvironmentVariables {
		if value, present := lookupEnv(name); present && value != "" {
			return nil, ErrCleanupDatabaseConfiguration
		}
	}
	poolConfig, err := pgxpool.ParseConfig(normalizedURL)
	if err != nil {
		return nil, ErrCleanupDatabaseConfiguration
	}
	poolConfig.ConnConfig.Tracer = queryTracer{}
	poolConfig.ConnConfig.RuntimeParams = map[string]string{
		"application_name": "fukamu_cleanup",
		"search_path":      "pg_catalog,public",
		"timezone":         "UTC",
	}
	poolConfig.MaxConns = 1
	poolConfig.MinConns = 0
	poolConfig.MinIdleConns = 0
	return poolConfig, nil
}

func normalizeCleanupDatabaseURL(databaseURL string) (string, error) {
	trimmed := strings.TrimSpace(databaseURL)
	parsed, err := url.Parse(trimmed)
	if err != nil || trimmed == "" ||
		(parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") ||
		parsed.Opaque != "" || parsed.Fragment != "" || strings.Contains(trimmed, "#") ||
		parsed.Hostname() == "" || strings.Contains(parsed.Host, ",") ||
		(strings.Count(parsed.Host, ":") > 1 && !strings.HasPrefix(parsed.Host, "[")) || parsed.User == nil ||
		(strings.Contains(parsed.Hostname(), ":") && net.ParseIP(strings.SplitN(parsed.Hostname(), "%", 2)[0]) == nil) ||
		strings.TrimSpace(parsed.User.Username()) == "" || !strings.HasPrefix(parsed.Path, "/") {
		return "", ErrCleanupDatabaseConfiguration
	}
	databaseName := strings.TrimPrefix(parsed.Path, "/")
	if strings.TrimSpace(databaseName) == "" || strings.Contains(databaseName, "/") {
		return "", ErrCleanupDatabaseConfiguration
	}
	port := parsed.Port()
	if port == "" {
		port = "5432"
	}
	parsedPort, err := strconv.ParseUint(port, 10, 16)
	if err != nil || parsedPort == 0 {
		return "", ErrCleanupDatabaseConfiguration
	}

	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return "", ErrCleanupDatabaseConfiguration
	}
	for key, values := range query {
		if _, allowed := cleanupDatabaseURLQueryKeys[key]; !allowed || len(values) != 1 {
			return "", ErrCleanupDatabaseConfiguration
		}
	}
	for _, key := range []string{"sslcert", "sslkey", "sslrootcert", "sslpassword"} {
		if _, present := query[key]; !present {
			query.Set(key, "")
		}
	}
	if _, present := query["sslmode"]; !present {
		query.Set("sslmode", "prefer")
	}
	query.Set("passfile", "")

	password, _ := parsed.User.Password()
	normalized := &url.URL{
		Scheme:   parsed.Scheme,
		User:     url.UserPassword(parsed.User.Username(), password),
		Host:     net.JoinHostPort(parsed.Hostname(), port),
		Path:     parsed.Path,
		RawQuery: query.Encode(),
	}
	return normalized.String(), nil
}

func (repository *CleanupRepository) CountCandidates(
	ctx context.Context,
	capturedNow time.Time,
) (result applicationcleanup.CandidateCounts, _ error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return result, err
	}
	defer rollbackCleanup(ctx, tx)
	queries := db.New(tx)
	result.AIUsageEvents, err = queries.CountCleanupAIUsageEvents(ctx, timestamptz(capturedNow.UTC()))
	if err != nil {
		return result, err
	}
	result.AbuseRateBuckets, err = queries.CountCleanupAbuseRateBuckets(ctx, timestamptz(capturedNow.UTC()))
	if err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func (repository *CleanupRepository) DeleteAIUsageEventsBatch(
	ctx context.Context,
	capturedNow time.Time,
	batchSize int32,
) (int64, error) {
	return repository.deleteBatch(ctx, func(queries *db.Queries) (int64, error) {
		return queries.DeleteCleanupAIUsageEventsBatch(ctx, db.DeleteCleanupAIUsageEventsBatchParams{
			CapturedNow: timestamptz(capturedNow.UTC()),
			BatchSize:   batchSize,
		})
	})
}

func (repository *CleanupRepository) DeleteAbuseRateBucketsBatch(
	ctx context.Context,
	capturedNow time.Time,
	batchSize int32,
) (int64, error) {
	return repository.deleteBatch(ctx, func(queries *db.Queries) (int64, error) {
		return queries.DeleteCleanupAbuseRateBucketsBatch(ctx, db.DeleteCleanupAbuseRateBucketsBatchParams{
			CapturedNow: timestamptz(capturedNow.UTC()),
			BatchSize:   batchSize,
		})
	})
}

func (repository *CleanupRepository) deleteBatch(
	ctx context.Context,
	deleteRows func(*db.Queries) (int64, error),
) (deleted int64, _ error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, err
	}
	defer rollbackCleanup(ctx, tx)
	deleted, err = deleteRows(db.New(tx))
	if err != nil {
		return 0, err
	}
	if deleted < 0 {
		return 0, fmt.Errorf("negative cleanup delete count")
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return deleted, nil
}

func rollbackCleanup(ctx context.Context, tx pgx.Tx) {
	_ = tx.Rollback(context.WithoutCancel(ctx))
}
