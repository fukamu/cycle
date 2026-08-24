package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/fukamu/cycle/backend/internal/ai/prompts"
	"github.com/fukamu/cycle/backend/internal/application/account"
	"github.com/fukamu/cycle/backend/internal/application/ports"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/config"
	"github.com/fukamu/cycle/backend/internal/httpapi"
	"github.com/fukamu/cycle/backend/internal/infrastructure/aiprovider"
	"github.com/fukamu/cycle/backend/internal/infrastructure/googleidentity"
	"github.com/fukamu/cycle/backend/internal/infrastructure/observability"
	"github.com/fukamu/cycle/backend/internal/infrastructure/postgres"
	"github.com/fukamu/cycle/backend/internal/infrastructure/safelog"
	"github.com/fukamu/cycle/backend/internal/infrastructure/system"
	turnstileinfra "github.com/fukamu/cycle/backend/internal/infrastructure/turnstile"
)

func maximumAIReservationUSD(maxInputTokens, maxOutputTokens, maxProviderAttempts int, inputUSDPerMillionTokens, outputUSDPerMillionTokens float64) float64 {
	return (float64(maxInputTokens)*inputUSDPerMillionTokens +
		float64(maxOutputTokens)*outputUSDPerMillionTokens) / 1_000_000 * float64(maxProviderAttempts)
}

type telemetryShutdowner interface {
	Shutdown(context.Context) error
}

func newTelemetryShutdown(runtime telemetryShutdowner, logger *slog.Logger, timeout time.Duration) func() error {
	var once sync.Once
	var shutdownErr error
	return func() error {
		once.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			shutdownErr = runtime.Shutdown(ctx)
			if shutdownErr != nil && logger != nil {
				logger.Error("telemetry shutdown failed", "error_class", "telemetry_shutdown_failed")
			}
		})
		return shutdownErr
	}
}

func main() {
	os.Exit(run())
}

func run() (exitCode int) {
	logger := safelog.NewJSON(os.Stdout)
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		logger.Error("invalid configuration", "error_class", "configuration_invalid")
		return 1
	}
	telemetrySettings := observability.Settings{
		Environment: settings.App.Environment,
		Endpoint:    settings.Telemetry.OTLPEndpoint,
		Headers:     settings.Telemetry.OTLPHeaders,
	}
	if err = observability.ValidateSettings(telemetrySettings); err != nil {
		logger.Error("invalid telemetry configuration", "error_class", "telemetry_configuration_invalid")
		return 1
	}
	telemetryStartupContext, cancelTelemetryStartup := context.WithTimeout(context.Background(), 10*time.Second)
	telemetryRuntime, err := observability.Setup(telemetryStartupContext, logger, telemetrySettings)
	cancelTelemetryStartup()
	if err != nil {
		logger.Error("telemetry unavailable", "error_class", "telemetry_startup_failed")
		return 1
	}
	shutdownTelemetry := newTelemetryShutdown(telemetryRuntime, logger, 15*time.Second)
	defer func() {
		_ = shutdownTelemetry()
	}()
	metrics, err := observability.NewMetrics(telemetryRuntime.MeterProvider(), logger, settings.AI.WarningThresholds)
	if err != nil {
		logger.Error("metrics unavailable", "error_class", "metrics_startup_failed")
		return 1
	}
	promptSet, err := prompts.Resolve(prompts.Versions{
		GoalRefine: settings.AI.GoalPromptVersion, ActionGenerate: settings.AI.GeneratePromptVersion,
		ActionRefine: settings.AI.RefinePromptVersion,
	})
	if err != nil {
		logger.Error("invalid prompt configuration", "error_class", "prompt_configuration_invalid")
		return 1
	}
	startupContext, cancelStartup := context.WithTimeout(context.Background(), 10*time.Second)
	pool, err := postgres.Open(startupContext, settings.Database)
	cancelStartup()
	if err != nil {
		logger.Error("database unavailable", "error_class", "database_startup_failed")
		return 1
	}
	closePool := true
	defer func() {
		cleanupServerResources(shutdownTelemetry, pool.Close, closePool)
	}()

	random := system.RandomGenerator{}
	var antiAbuse ports.AntiAbuseVerifier = system.AllowAnonymous{}
	if settings.Turnstile.Enabled {
		antiAbuse = turnstileinfra.NewVerifier(
			&http.Client{Timeout: 10 * time.Second},
			postgres.NewAnonymousRateLimiter(pool, settings.RateLimit.AnonymousCreatePerIPHour, settings.RateLimit.AnonymousCreatePerIP24h),
			system.Clock{},
			turnstileinfra.Settings{
				SecretKey: settings.Turnstile.SecretKey, ExpectedAction: settings.Turnstile.ExpectedAction,
				ExpectedHost: settings.App.PublicOrigin.Hostname(), RateHashKey: []byte(settings.Session.RateLimitHMACSecret),
				Observer: metrics,
			},
		)
	}
	sessionService := appsession.NewService(
		postgres.NewSessionRepository(pool), system.Clock{}, random, random, antiAbuse,
		appsession.Settings{
			SessionHashKey: []byte(settings.Session.TokenPepper), CSRFHashKey: []byte(settings.Session.CSRFTokenPepper),
			BootstrapHashKey: []byte(settings.Session.BootstrapIDPepper), IdleTTL: settings.Session.IdleTTL,
			AbsoluteTTL: settings.Session.AbsoluteTTL, ActivityTouchAfter: settings.Session.ActivityTouchInterval,
			BootstrapTTL: settings.Session.AnonymousBootstrapTTL,
		},
	)
	var goalRefiner workspace.GoalRefiner = aiprovider.Fake{}
	var actionGenerator workspace.ActionGenerator = aiprovider.Fake{}
	if settings.AI.APIKey != "" {
		provider := aiprovider.NewOpenAI(settings.AI.APIKey, settings.AI.Model, settings.AI.ReasoningEffort, settings.AI.Timeout, settings.AI.ActionMaxOutputTokens,
			settings.AI.Pricing.InputUSDPerMillionTokens, settings.AI.Pricing.OutputUSDPerMillionTokens)
		goalRefiner = provider
		actionGenerator = provider
	}
	tokenCounter, err := aiprovider.NewTokenCounter(settings.AI.TokenizerEncoding)
	if err != nil {
		logger.Error("AI tokenizer unavailable", "error_class", "tokenizer_startup_failed")
		return 1
	}
	actionReservationUSD := maximumAIReservationUSD(settings.AI.MaxInputTokens, settings.AI.ActionMaxOutputTokens, settings.AI.MaxProviderAttempts,
		settings.AI.Pricing.InputUSDPerMillionTokens, settings.AI.Pricing.OutputUSDPerMillionTokens)
	goalRefineReservationUSD := maximumAIReservationUSD(settings.AI.MaxInputTokens, settings.AI.GoalRefineMaxOutputTokens, settings.AI.MaxProviderAttempts,
		settings.AI.Pricing.InputUSDPerMillionTokens, settings.AI.Pricing.OutputUSDPerMillionTokens)
	workspaceStore := postgres.NewWorkspaceStore(pool)
	workspaceService := workspace.NewService(workspaceStore, workspaceStore, workspaceStore, workspaceStore, workspaceStore, workspaceStore, workspaceStore,
		workspaceStore, goalRefiner, actionGenerator, system.Clock{}, random, workspace.Settings{
			MaxProgressingGoals: settings.Goals.MaxProgressingGoals, Provider: settings.AI.Provider,
			CursorSigningKey: []byte(settings.Session.CursorSigningSecret),
			RollingLimit:     settings.AI.MaxGenerationsPerUser24h, MonthlyBudgetUSD: settings.AI.MonthlyBudgetUSD,
			ReservationUSD: goalRefineReservationUSD, ActionReservationUSD: actionReservationUSD, LeaseDuration: settings.AI.LeaseDuration,
			RateHashKey: []byte(settings.Session.RateLimitHMACSecret), AIPerUserMinute: settings.RateLimit.AIPerUserMinute,
			AIPerSessionMinute: settings.RateLimit.AIPerSessionMinute, AIPerIPMinute: settings.RateLimit.AIPerIPMinute,
			MaxProviderAttempts: settings.AI.MaxProviderAttempts,
			MaxRetryBackoff:     settings.AI.MaxRetryBackoff, FinalizationGrace: settings.AI.FinalizationGrace, Model: settings.AI.Model,
			MaxInputTokens: settings.AI.MaxInputTokens, GoalRefineMaxOutputTokens: settings.AI.GoalRefineMaxOutputTokens,
			ActionMaxOutputTokens: settings.AI.ActionMaxOutputTokens, MaxContextCycles: settings.AI.MaxContextCycles,
			GoalRefineInstructions: promptSet.GoalRefine, ActionGenerateInstructions: promptSet.ActionGenerate,
			ActionRefineInstructions: promptSet.ActionRefine, TokenCounter: tokenCounter,
			GoalPromptVersion: settings.AI.GoalPromptVersion, GeneratePromptVersion: settings.AI.GeneratePromptVersion,
			RefinePromptVersion: settings.AI.RefinePromptVersion, AIObserver: metrics, EventObserver: metrics,
		})
	var googleVerifier account.GoogleVerifier = googleidentity.NewVerifier(settings.Google.WebClientID)
	if settings.App.Environment == "test" {
		googleVerifier = googleidentity.FakeVerifier{}
	}
	accountService := account.NewService(
		postgres.NewAccountRepository(pool), googleVerifier, system.Clock{}, random, random,
		account.Settings{
			SessionHashKey: []byte(settings.Session.TokenPepper), CSRFHashKey: []byte(settings.Session.CSRFTokenPepper),
			IdleTTL: settings.Session.IdleTTL, AbsoluteTTL: settings.Session.AbsoluteTTL, Observer: metrics,
		},
	)
	router := httpapi.NewRouter(httpapi.Dependencies{
		Sessions: sessionService, Workspace: workspaceService, Account: accountService, RequestIDs: random,
		PublicOrigin: settings.App.PublicOrigin.String(), Ready: pool.Ping, Logger: logger,
		Production: settings.App.Environment == "production", TrustProxy: settings.App.Environment == "production",
		StaticDir: settings.App.StaticDir, Metrics: metrics, TracerProvider: telemetryRuntime.TracerProvider(),
	})
	server := &http.Server{
		Addr: settings.App.HTTPAddress, Handler: router, ErrorLog: safelog.NewHTTPServerErrorLog(logger),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second,
		WriteTimeout: settings.AI.LeaseDuration + settings.AI.FinalizationGrace, IdleTimeout: 120 * time.Second,
	}
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- server.ListenAndServe() }()
	logger.Info("server started", "operation", "server_start")

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case <-signals:
		logger.Info("shutdown requested", "operation", "server_shutdown_requested")
	case listenErr := <-serverErrors:
		if !errors.Is(listenErr, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "error_class", "http_server_failed")
			exitCode = 1
		}
	}
	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelShutdown()
	if err = server.Shutdown(shutdownContext); err != nil {
		logger.Error("graceful shutdown failed", "error_class", "http_shutdown_failed")
		closePool = false
		return 1
	}
	return exitCode
}

func cleanupServerResources(shutdownTelemetry func() error, closePool func(), closePoolAllowed bool) {
	_ = shutdownTelemetry()
	if closePoolAllowed {
		closePool()
	}
}
