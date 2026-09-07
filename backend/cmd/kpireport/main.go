package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/kpireport"
	"github.com/fukamu/cycle/backend/internal/infrastructure/postgres"
	"github.com/fukamu/cycle/backend/internal/infrastructure/safelog"
)

var errInvalidKPIReportArguments = errors.New("KPI report arguments are invalid")

type reportOpener func(context.Context, string) (kpireport.Repository, func(), error)

type commandDependencies struct {
	openRepository reportOpener
}

type timestampFlag struct {
	value     string
	specified bool
}

func (value *timestampFlag) String() string { return "" }

func (value *timestampFlag) Set(raw string) error {
	if value.specified {
		return errInvalidKPIReportArguments
	}
	value.specified = true
	value.value = raw
	return nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	lookupEnvironment := os.LookupEnv
	os.Exit(runKPIReportCommand(
		ctx,
		os.Args[1:],
		lookupEnvironment,
		os.Stdout,
		os.Stderr,
		commandDependencies{
			openRepository: func(ctx context.Context, databaseURL string) (kpireport.Repository, func(), error) {
				return postgres.OpenKPIReportRepository(ctx, databaseURL)
			},
		},
	))
}

func runKPIReportCommand(
	ctx context.Context,
	args []string,
	lookupEnv func(string) (string, bool),
	stdout io.Writer,
	stderr io.Writer,
	dependencies commandDependencies,
) int {
	query, err := parseKPIReportQuery(args)
	if err != nil {
		logKPIReportFailure(stderr, "kpi_report_arguments_invalid")
		return 1
	}
	databaseURL, present := lookupEnv("KPI_DATABASE_URL")
	if !present || databaseURL == "" || postgres.ValidateKPIReportDatabaseURL(databaseURL) != nil {
		logKPIReportFailure(stderr, "kpi_report_configuration_invalid")
		return 1
	}
	repository, closeRepository, err := dependencies.openRepository(ctx, databaseURL)
	if err != nil {
		errorClass := "kpi_report_database_unavailable"
		if errors.Is(err, postgres.ErrKPIReportDatabaseConfiguration) {
			errorClass = "kpi_report_configuration_invalid"
		}
		logKPIReportFailure(stderr, errorClass)
		return 1
	}
	defer closeRepository()

	report, err := kpireport.NewService(repository).Generate(ctx, query)
	if err != nil {
		logKPIReportFailure(stderr, "kpi_report_execution_failed")
		return 1
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(true)
	if err = encoder.Encode(report); err != nil {
		logKPIReportFailure(stderr, "kpi_report_output_failed")
		return 1
	}
	return 0
}

func parseKPIReportQuery(args []string) (kpireport.Query, error) {
	flags := flag.NewFlagSet("kpireport", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var cohortStartValue timestampFlag
	var cohortEndValue timestampFlag
	var asOfValue timestampFlag
	flags.Var(&cohortStartValue, "cohort-start", "")
	flags.Var(&cohortEndValue, "cohort-end", "")
	flags.Var(&asOfValue, "as-of", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 ||
		!cohortStartValue.specified || !cohortEndValue.specified || !asOfValue.specified {
		return kpireport.Query{}, errInvalidKPIReportArguments
	}
	cohortStart, err := parseUTCInstant(cohortStartValue.value)
	if err != nil {
		return kpireport.Query{}, errInvalidKPIReportArguments
	}
	cohortEnd, err := parseUTCInstant(cohortEndValue.value)
	if err != nil {
		return kpireport.Query{}, errInvalidKPIReportArguments
	}
	asOf, err := parseUTCInstant(asOfValue.value)
	if err != nil || cohortStart.IsZero() || cohortEnd.IsZero() || asOf.IsZero() ||
		!cohortStart.Before(cohortEnd) || cohortEnd.After(asOf) {
		return kpireport.Query{}, errInvalidKPIReportArguments
	}
	return kpireport.Query{CohortStart: cohortStart, CohortEnd: cohortEnd, AsOf: asOf}, nil
}

func parseUTCInstant(raw string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, errInvalidKPIReportArguments
	}
	_, offset := parsed.Zone()
	if offset != 0 {
		return time.Time{}, errInvalidKPIReportArguments
	}
	return parsed.UTC(), nil
}

func logKPIReportFailure(output io.Writer, errorClass string) {
	logger := safelog.NewJSON(output)
	logger.LogAttrs(context.Background(), slog.LevelError, "",
		slog.String("operation", "kpi_report"),
		slog.String("error_class", errorClass),
	)
}
