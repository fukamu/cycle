package main

import (
	"log/slog"
	"os"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/infrastructure/postgres"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		logger.Error("DATABASE_URL is required", "error_class", "migration_configuration_invalid")
		os.Exit(1)
	}
	directory := os.Getenv("MIGRATIONS_DIR")
	if directory == "" {
		directory = "migrations"
	}
	result, err := postgres.Migrate(databaseURL, directory)
	for _, migration := range result.Applied {
		logger.Info("database migration applied",
			"migration_version", migration.Version,
			"migration_direction", migration.Direction,
			"migration_file", migration.File,
			"migration_duration_ms", float64(migration.Duration)/float64(time.Millisecond),
		)
	}
	if err != nil {
		logger.Error("database migration failed", "error_class", "migration_failed", "error", err)
		os.Exit(1)
	}
	logger.Info("database migrations complete",
		"migration_applied_count", len(result.Applied),
		"migration_no_change", result.NoChange(),
	)
}
