package postgres

import (
	"errors"
	"math"
	"os"
	"strings"
	"testing"
)

func TestKPIReportPoolConfigIsSingleConnectionUTCAndRejectsAmbientPostgresSettings(t *testing.T) {
	const databaseURL = "postgres://report-user:REPORT_SECRET_CANARY@db.example/report-db?sslmode=disable"
	config, err := kpiReportPoolConfig(databaseURL, func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	if config.MaxConns != 1 || config.MinConns != 0 || config.MinIdleConns != 0 {
		t.Fatalf("pool bounds = max:%d min:%d idle:%d", config.MaxConns, config.MinConns, config.MinIdleConns)
	}
	if got := config.ConnConfig.RuntimeParams["application_name"]; got != "fukamu_kpi_report" {
		t.Fatalf("application_name = %q", got)
	}
	if got := config.ConnConfig.RuntimeParams["search_path"]; got != "pg_catalog,public" {
		t.Fatalf("search_path = %q", got)
	}
	if got := config.ConnConfig.RuntimeParams["timezone"]; got != "UTC" {
		t.Fatalf("timezone = %q", got)
	}

	_, err = kpiReportPoolConfig(databaseURL, func(key string) (string, bool) {
		if key == "PGHOST" {
			return "AMBIENT_HOST_CANARY", true
		}
		return "", false
	})
	if !errors.Is(err, ErrKPIReportDatabaseConfiguration) {
		t.Fatalf("ambient configuration error = %v", err)
	}
	if strings.Contains(err.Error(), "AMBIENT_HOST_CANARY") || strings.Contains(err.Error(), "REPORT_SECRET_CANARY") {
		t.Fatalf("configuration error exposed input: %v", err)
	}
}

func TestValidateKPIReportDatabaseURLNeverReturnsInput(t *testing.T) {
	const canary = "RAW_KPI_DATABASE_URL_CANARY"
	invalid := []string{
		"postgres://",
		"postgres://report-user@db.example",
		"postgres://report-user:" + canary + "@db.example/report-db?host=other",
		"postgres://report-user:" + canary + "@db.example/report-db?service=unsafe",
	}
	for index, databaseURL := range invalid {
		err := ValidateKPIReportDatabaseURL(databaseURL)
		if !errors.Is(err, ErrKPIReportDatabaseConfiguration) {
			t.Fatalf("case %d error = %v", index, err)
		}
		if strings.Contains(err.Error(), canary) || strings.Contains(err.Error(), databaseURL) {
			t.Fatalf("case %d exposed input: %v", index, err)
		}
	}
}

func TestDurationSummaryUsesNullPercentilesForZeroAndPreservesFiniteValues(t *testing.T) {
	zero := durationSummary(0, math.NaN(), math.Inf(1))
	if zero.ObservationCount != 0 || zero.P50Seconds != nil || zero.P90Seconds != nil {
		t.Fatalf("zero duration = %#v", zero)
	}
	nonzero := durationSummary(2, 12.5, 20)
	if nonzero.ObservationCount != 2 || nonzero.P50Seconds == nil || *nonzero.P50Seconds != 12.5 ||
		nonzero.P90Seconds == nil || *nonzero.P90Seconds != 20 {
		t.Fatalf("nonzero duration = %#v", nonzero)
	}
}

func TestKPIReportRepositoryUsesGeneratedQueryInReadOnlyRepeatableReadTransaction(t *testing.T) {
	contents, err := readKPIReportRepositorySource()
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"IsoLevel:   pgx.RepeatableRead",
		"AccessMode: pgx.ReadOnly",
		"db.New(tx).AggregateSurvivorFunnelKPI",
		"if !row.RepeatableRead || !row.ReadOnly",
	} {
		if !strings.Contains(contents, required) {
			t.Fatalf("repository source is missing %q", required)
		}
	}
}

func readKPIReportRepositorySource() (string, error) {
	contents, err := os.ReadFile("kpi_report_repository.go")
	return string(contents), err
}
