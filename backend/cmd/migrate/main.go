package main

import (
	"log/slog"
	"os"
	"time"

	"github.com/fukamu/cycle/backend/internal/infrastructure/postgres"
	"github.com/fukamu/cycle/backend/internal/infrastructure/safelog"
)

func main() {
	logger := safelog.NewJSON(os.Stdout)
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		logger.Error("DATABASE_URL is required", "operation", "migration_start", "error_class", "migration_configuration_invalid")
		os.Exit(1)
	}
	directory := os.Getenv("MIGRATIONS_DIR")
	if directory == "" {
		directory = "migrations"
	}
	result, err := postgres.Migrate(databaseURL, directory)
	if logMigrationResult(logger, result, err) != 0 {
		os.Exit(1)
	}
}

func logMigrationResult(logger *slog.Logger, result postgres.MigrationResult, migrationErr error) int {
	for _, migration := range result.Applied {
		logger.Info("database migration applied",
			"operation", "migration_apply",
			"migration_version", migration.Version,
			"migration_direction", migration.Direction,
			"migration_file", migration.File,
			"migration_duration_ms", float64(migration.Duration)/float64(time.Millisecond),
		)
	}
	if migrationErr != nil {
		logger.Error("database migration failed", "operation", "migration_apply", "error_class", "migration_failed")
		return 1
	}
	logger.Info("database migrations complete",
		"operation", "migration_complete",
		"migration_applied_count", len(result.Applied),
		"migration_no_change", result.NoChange(),
	)
	return 0
}
