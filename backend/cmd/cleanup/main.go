package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	applicationcleanup "github.com/fukamu/cycle/backend/internal/application/cleanup"
	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/infrastructure/postgres"
	"github.com/fukamu/cycle/backend/internal/infrastructure/safelog"
	systeminfra "github.com/fukamu/cycle/backend/internal/infrastructure/system"
)

type cleanupOptions struct {
	mode      applicationcleanup.Mode
	batchSize int64
}

type repositoryOpener func(context.Context, string) (applicationcleanup.Repository, func(), error)

type commandDependencies struct {
	clock          ports.Clock
	openRepository repositoryOpener
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dependencies := commandDependencies{
		clock: systeminfra.Clock{},
		openRepository: func(ctx context.Context, databaseURL string) (applicationcleanup.Repository, func(), error) {
			return postgres.OpenCleanupRepository(ctx, databaseURL)
		},
	}
	os.Exit(runCleanupCommand(ctx, os.Args[1:], os.LookupEnv, os.Stdout, dependencies))
}

func runCleanupCommand(
	ctx context.Context,
	args []string,
	lookupEnv func(string) (string, bool),
	output io.Writer,
	dependencies commandDependencies,
) int {
	logger := safelog.NewJSON(output)
	options, err := parseCleanupOptions(args)
	if err != nil {
		logCleanupFailure(logger, "", "cleanup_arguments_invalid")
		return 1
	}
	databaseURL, present := lookupEnv("DATABASE_URL")
	if !present || databaseURL == "" || postgres.ValidateCleanupDatabaseURL(databaseURL) != nil {
		logCleanupFailure(logger, options.mode, "cleanup_configuration_invalid")
		return 1
	}

	capturedNow := dependencies.clock.Now().UTC()
	repository, closeRepository, err := dependencies.openRepository(ctx, databaseURL)
	if err != nil {
		errorClass := "cleanup_database_unavailable"
		if errors.Is(err, postgres.ErrCleanupDatabaseConfiguration) {
			errorClass = "cleanup_configuration_invalid"
		}
		logCleanupFailure(logger, options.mode, errorClass)
		return 1
	}
	defer closeRepository()

	service := applicationcleanup.NewService(repository)
	var result applicationcleanup.Result
	switch options.mode {
	case applicationcleanup.ModeDryRun:
		result, err = service.DryRun(ctx, capturedNow)
	case applicationcleanup.ModeExecute:
		result, err = service.Execute(ctx, capturedNow, options.batchSize)
	default:
		logCleanupFailure(logger, "", "cleanup_arguments_invalid")
		return 1
	}
	if err != nil {
		if options.mode == applicationcleanup.ModeExecute {
			logCleanupResult(logger, result)
		}
		logCleanupFailure(logger, options.mode, "cleanup_execution_failed")
		return 1
	}
	logCleanupResult(logger, result)
	return 0
}

func parseCleanupOptions(args []string) (cleanupOptions, error) {
	flags := flag.NewFlagSet("cleanup", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dryRun := flags.Bool("dry-run", false, "")
	execute := flags.Bool("execute", false, "")
	batchSize := flags.Int64("batch-size", 0, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return cleanupOptions{}, applicationcleanup.ErrInvalidBatchSize
	}
	dryRunSpecified := false
	executeSpecified := false
	batchSizeSpecified := false
	flags.Visit(func(current *flag.Flag) {
		switch current.Name {
		case "dry-run":
			dryRunSpecified = true
		case "execute":
			executeSpecified = true
		case "batch-size":
			batchSizeSpecified = true
		}
	})
	if dryRunSpecified == executeSpecified ||
		dryRunSpecified && !*dryRun ||
		executeSpecified && !*execute {
		return cleanupOptions{}, applicationcleanup.ErrInvalidBatchSize
	}
	if dryRunSpecified {
		if batchSizeSpecified {
			return cleanupOptions{}, applicationcleanup.ErrInvalidBatchSize
		}
		return cleanupOptions{mode: applicationcleanup.ModeDryRun}, nil
	}
	if !batchSizeSpecified || *batchSize <= 0 || *batchSize > applicationcleanup.MaxBatchSize {
		return cleanupOptions{}, applicationcleanup.ErrInvalidBatchSize
	}
	return cleanupOptions{mode: applicationcleanup.ModeExecute, batchSize: *batchSize}, nil
}

func logCleanupFailure(logger *slog.Logger, mode applicationcleanup.Mode, errorClass string) {
	attributes := []slog.Attr{
		slog.String("operation", "retention_cleanup"),
		slog.String("error_class", errorClass),
	}
	if mode == applicationcleanup.ModeDryRun || mode == applicationcleanup.ModeExecute {
		attributes = append(attributes, slog.String("cleanup_mode", string(mode)))
	}
	logger.LogAttrs(context.Background(), slog.LevelError, "", attributes...)
}

func logCleanupResult(logger *slog.Logger, result applicationcleanup.Result) {
	logCleanupResource(logger, result.Mode, "ai_usage_events", result.AIUsageEvents)
	logCleanupResource(logger, result.Mode, "abuse_rate_buckets", result.AbuseRateBuckets)
	logCleanupResource(logger, result.Mode, "anonymous_rate_limit_guards", result.AnonymousRateLimitGuards)
}

func logCleanupResource(
	logger *slog.Logger,
	mode applicationcleanup.Mode,
	resource string,
	result applicationcleanup.ResourceResult,
) {
	logger.LogAttrs(context.Background(), slog.LevelInfo, "",
		slog.String("operation", "retention_cleanup"),
		slog.String("cleanup_mode", string(mode)),
		slog.String("cleanup_resource", resource),
		slog.Int64("cleanup_candidate_count", result.CandidateCount),
		slog.Int64("cleanup_deleted_count", result.DeletedCount),
		slog.Int64("cleanup_batch_count", result.BatchCount),
	)
}
