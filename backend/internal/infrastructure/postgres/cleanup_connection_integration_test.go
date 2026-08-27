package postgres

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestOpenCleanupRepositoryConnectsOnlyFromCompleteDatabaseURL(t *testing.T) {
	databaseURL := cleanupIntegrationDatabaseURL(t)
	parsedURL, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	clearCleanupPostgresEnvironment(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	repository, closeRepository, err := OpenCleanupRepository(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer closeRepository()
	if repository.pool.Config().ConnConfig.Host != parsedURL.Hostname() {
		t.Fatalf("opened host = %q, want URL host", repository.pool.Config().ConnConfig.Host)
	}
}

func TestOpenCleanupRepositoryRejectsPartialURLInsteadOfAmbientPGTarget(t *testing.T) {
	databaseURL := cleanupIntegrationDatabaseURL(t)
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	clearCleanupPostgresEnvironment(t)
	port := parsed.Port()
	if port == "" {
		port = "5432"
	}
	password, _ := parsed.User.Password()
	sslmode := parsed.Query().Get("sslmode")
	if sslmode == "" {
		sslmode = "prefer"
	}
	for name, value := range map[string]string{
		"PGHOST": parsed.Hostname(), "PGPORT": port,
		"PGDATABASE": strings.TrimPrefix(parsed.Path, "/"), "PGUSER": parsed.User.Username(),
		"PGPASSWORD": password, "PGSSLMODE": sslmode,
	} {
		t.Setenv(name, value)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	repository, closeRepository, err := OpenCleanupRepository(ctx, "postgres://")
	if closeRepository != nil {
		closeRepository()
	}
	if repository != nil || !errors.Is(err, ErrCleanupDatabaseConfiguration) {
		t.Fatalf("repository/error = %#v/%v, want fixed pre-connect rejection", repository, err)
	}
}

func TestOpenCleanupRepositoryRejectsAmbientPGEvenWithCompleteURL(t *testing.T) {
	databaseURL := cleanupIntegrationDatabaseURL(t)
	clearCleanupPostgresEnvironment(t)
	const canary = "AMBIENT_APPLICATION_NAME_CANARY"
	t.Setenv("PGAPPNAME", canary)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	repository, closeRepository, err := OpenCleanupRepository(ctx, databaseURL)
	if closeRepository != nil {
		closeRepository()
	}
	if repository != nil || !errors.Is(err, ErrCleanupDatabaseConfiguration) {
		t.Fatalf("repository/error = %#v/%v, want fixed ambient rejection", repository, err)
	}
	if strings.Contains(err.Error(), canary) || strings.Contains(err.Error(), databaseURL) {
		t.Fatalf("ambient rejection exposed raw configuration: %v", err)
	}
}

func cleanupIntegrationDatabaseURL(t *testing.T) string {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set; use only a disposable PostgreSQL database")
	}
	if err := ValidateCleanupDatabaseURL(databaseURL); err != nil {
		t.Fatalf("TEST_DATABASE_URL does not meet cleanup command contract: %v", err)
	}
	return databaseURL
}

func clearCleanupPostgresEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range cleanupPostgresEnvironmentVariables {
		t.Setenv(name, "")
	}
}
