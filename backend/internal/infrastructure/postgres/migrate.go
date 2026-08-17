package postgres

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

func Migrate(databaseURL string, directory string) (resultErr error) {
	absoluteDirectory, err := filepath.Abs(directory)
	if err != nil {
		return fmt.Errorf("resolve migrations: %w", err)
	}
	sourceURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absoluteDirectory)}).String()
	runner, err := migrate.New(sourceURL, databaseURL)
	if err != nil {
		return fmt.Errorf("create migration runner: %w", err)
	}
	defer func() {
		sourceErr, databaseErr := runner.Close()
		resultErr = errors.Join(resultErr, sourceErr, databaseErr)
	}()
	if err := runner.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}
