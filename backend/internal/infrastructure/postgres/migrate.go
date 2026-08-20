package postgres

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

type AppliedMigration struct {
	Version   uint
	Direction string
	File      string
	Duration  time.Duration
}

type MigrationResult struct {
	Applied []AppliedMigration
}

func (r MigrationResult) NoChange() bool {
	return len(r.Applied) == 0
}

type migrationLogCollector struct {
	applied []AppliedMigration
}

func (c *migrationLogCollector) Printf(format string, values ...interface{}) {
	if format != "%v (%v)\n" || len(values) != 2 {
		return
	}
	logString, logOK := values[0].(string)
	duration, durationOK := values[1].(time.Duration)
	if !logOK || !durationOK {
		return
	}
	parts := strings.SplitN(logString, " ", 2)
	if len(parts) != 2 {
		return
	}
	versionDirection := strings.SplitN(parts[0], "/", 2)
	if len(versionDirection) != 2 {
		return
	}
	version, err := strconv.ParseUint(versionDirection[0], 10, 64)
	if err != nil {
		return
	}
	direction := map[string]string{"u": "up", "d": "down"}[versionDirection[1]]
	if direction == "" {
		return
	}
	c.applied = append(c.applied, AppliedMigration{
		Version:   uint(version),
		Direction: direction,
		File:      fmt.Sprintf("%06d_%s.%s.sql", version, parts[1], direction),
		Duration:  duration,
	})
}

func (*migrationLogCollector) Verbose() bool {
	return false
}

func Migrate(databaseURL string, directory string) (result MigrationResult, resultErr error) {
	absoluteDirectory, err := filepath.Abs(directory)
	if err != nil {
		return result, fmt.Errorf("resolve migrations: %w", err)
	}
	sourceURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absoluteDirectory)}).String()
	runner, err := migrate.New(sourceURL, databaseURL)
	if err != nil {
		return result, fmt.Errorf("create migration runner: %w", err)
	}
	collector := &migrationLogCollector{}
	runner.Log = collector
	defer func() {
		sourceErr, databaseErr := runner.Close()
		resultErr = errors.Join(resultErr, sourceErr, databaseErr)
		result.Applied = append(result.Applied, collector.applied...)
	}()
	if err := runner.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return result, fmt.Errorf("apply migrations: %w", err)
	}
	return result, nil
}
