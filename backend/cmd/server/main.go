package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/ai/prompts"
	"github.com/matoruru/PDCAI/backend/internal/application/account"
	"github.com/matoruru/PDCAI/backend/internal/application/ports"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
	"github.com/matoruru/PDCAI/backend/internal/config"
	"github.com/matoruru/PDCAI/backend/internal/httpapi"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/aiprovider"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/googleidentity"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/observability"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/postgres"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/system"
	turnstileinfra "github.com/matoruru/PDCAI/backend/internal/infrastructure/turnstile"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		logger.Error("invalid configuration", "error_class", "configuration_invalid")
		os.Exit(1)
	}
	promptSet, err := prompts.Resolve(prompts.Versions{
		GoalRefine: settings.AI.GoalPromptVersion, ActionGenerate: settings.AI.GeneratePromptVersion,
		ActionRefine: settings.AI.RefinePromptVersion,
	})
	if err != nil {
		logger.Error("invalid prompt configuration", "error_class", "prompt_configuration_invalid")
		os.Exit(1)
	}
	observability.Setup()
	metrics, err := observability.NewMetrics(logger, settings.AI.WarningThresholds)
	if err != nil {
		logger.Error("metrics unavailable", "error_class", "metrics_startup_failed")
		os.Exit(1)
	}
	startupContext, cancelStartup := context.WithTimeout(context.Background(), 10*time.Second)
	pool, err := postgres.Open(startupContext, settings.Database)
	cancelStartup()
	if err != nil {
		logger.Error("database unavailable", "error_class", "database_startup_failed")
		os.Exit(1)
	}
	defer pool.Close()

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
	var aiProvider workspace.AIProvider = aiprovider.Fake{}
	if settings.AI.APIKey != "" {
		aiProvider = aiprovider.NewOpenAI(settings.AI.APIKey, settings.AI.Model, settings.AI.Timeout, settings.AI.ActionMaxOutputTokens,
			settings.AI.Pricing.InputUSDPerMillionTokens, settings.AI.Pricing.OutputUSDPerMillionTokens, promptSet)
	}
	tokenCounter, err := aiprovider.NewTokenCounter(settings.AI.TokenizerEncoding)
	if err != nil {
		logger.Error("AI tokenizer unavailable", "error_class", "tokenizer_startup_failed")
		os.Exit(1)
	}
	reservationUSD := (float64(settings.AI.MaxInputTokens)*settings.AI.Pricing.InputUSDPerMillionTokens +
		float64(settings.AI.ActionMaxOutputTokens)*settings.AI.Pricing.OutputUSDPerMillionTokens) / 1_000_000 * float64(settings.AI.MaxProviderAttempts)
	workspaceStore := postgres.NewWorkspaceStore(pool, postgres.WorkspaceStoreSettings{
		CursorSigningKey: []byte(settings.Session.CursorSigningSecret), Provider: settings.AI.Provider, Model: settings.AI.Model,
		GoalPromptVersion: settings.AI.GoalPromptVersion, GeneratePromptVersion: settings.AI.GeneratePromptVersion,
		RefinePromptVersion: settings.AI.RefinePromptVersion, RollingLimit: settings.AI.MaxGenerationsPerUser24h,
		MonthlyBudgetUSD: settings.AI.MonthlyBudgetUSD, ReservationUSD: reservationUSD, LeaseDuration: settings.AI.LeaseDuration,
		RateHashKey: []byte(settings.Session.RateLimitHMACSecret), AIPerUserMinute: settings.RateLimit.AIPerUserMinute,
		AIPerSessionMinute: settings.RateLimit.AIPerSessionMinute, AIPerIPMinute: settings.RateLimit.AIPerIPMinute,
	})
	workspaceService := workspace.NewService(workspaceStore, aiProvider, system.Clock{}, random, workspace.Settings{
		MaxProgressingGoals: settings.Goals.MaxProgressingGoals, MaxProviderAttempts: settings.AI.MaxProviderAttempts,
		MaxRetryBackoff: settings.AI.MaxRetryBackoff, FinalizationGrace: settings.AI.FinalizationGrace, Model: settings.AI.Model,
		MaxInputTokens: settings.AI.MaxInputTokens, GoalRefineMaxOutputTokens: settings.AI.GoalRefineMaxOutputTokens,
		ActionMaxOutputTokens: settings.AI.ActionMaxOutputTokens, MaxContextCycles: settings.AI.MaxContextCycles,
		GoalRefineInstructions: promptSet.GoalRefine, ActionGenerateInstructions: promptSet.ActionGenerate,
		ActionRefineInstructions: promptSet.ActionRefine, TokenCounter: tokenCounter,
		GoalPromptVersion: settings.AI.GoalPromptVersion, GeneratePromptVersion: settings.AI.GeneratePromptVersion,
		RefinePromptVersion: settings.AI.RefinePromptVersion, AIObserver: metrics,
	})
	var googleVerifier account.GoogleVerifier = googleidentity.NewVerifier(settings.Google.WebClientID)
	if settings.App.Environment == "test" {
		googleVerifier = googleidentity.FakeVerifier{}
	}
	accountService := account.NewService(
		postgres.NewAccountRepository(pool), googleVerifier, system.Clock{}, random, random,
		account.Settings{
			SessionHashKey: []byte(settings.Session.TokenPepper), CSRFHashKey: []byte(settings.Session.CSRFTokenPepper),
			IdleTTL: settings.Session.IdleTTL, AbsoluteTTL: settings.Session.AbsoluteTTL,
		},
	)
	router := httpapi.NewRouter(httpapi.Dependencies{
		Sessions: sessionService, Workspace: workspaceService, Account: accountService, RequestIDs: random,
		PublicOrigin: settings.App.PublicOrigin.String(), Ready: pool.Ping, Logger: logger,
		Production: settings.App.Environment == "production", TrustProxy: settings.App.Environment == "production",
		StaticDir: settings.App.StaticDir, Metrics: metrics,
	})
	server := &http.Server{
		Addr: settings.App.HTTPAddress, Handler: router,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second,
		WriteTimeout: settings.AI.LeaseDuration + settings.AI.FinalizationGrace, IdleTimeout: 120 * time.Second,
	}
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- server.ListenAndServe() }()
	logger.Info("server started", "address", settings.App.HTTPAddress, "environment", settings.App.Environment)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	select {
	case received := <-signals:
		logger.Info("shutdown requested", "signal", received.String())
	case listenErr := <-serverErrors:
		if !errors.Is(listenErr, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "error_class", "http_server_failed")
			os.Exit(1)
		}
	}
	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelShutdown()
	if err = server.Shutdown(shutdownContext); err != nil {
		logger.Error("graceful shutdown failed", "error_class", "http_shutdown_failed")
		os.Exit(1)
	}
}
