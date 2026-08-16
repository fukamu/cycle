package main

import (
	"log/slog"
	"os"

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
	if err := postgres.Migrate(databaseURL, directory); err != nil {
		logger.Error("database migration failed", "error_class", "migration_failed", "error", err)
		os.Exit(1)
	}
	logger.Info("database migrations complete")
}
