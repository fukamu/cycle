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

	recaptchaclient "cloud.google.com/go/recaptchaenterprise/v2/apiv1"

	"github.com/matoruru/PDCAI/backend/internal/application/account"
	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	"github.com/matoruru/PDCAI/backend/internal/application/ports"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	"github.com/matoruru/PDCAI/backend/internal/config"
	"github.com/matoruru/PDCAI/backend/internal/httpapi"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/aiprovider"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/googleidentity"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/observability"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/postgres"
	recaptchainfra "github.com/matoruru/PDCAI/backend/internal/infrastructure/recaptcha"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/system"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		logger.Error("invalid configuration", "error_class", "configuration_invalid", "error", err)
		os.Exit(1)
	}
	telemetryContext, cancelTelemetrySetup := context.WithTimeout(context.Background(), 10*time.Second)
	shutdownTelemetry, err := observability.Setup(telemetryContext, settings.App.Environment == "production")
	cancelTelemetrySetup()
	if err != nil {
		logger.Error("telemetry unavailable", "error_class", "telemetry_startup_failed")
		os.Exit(1)
	}
	defer func() {
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if shutdownErr := shutdownTelemetry(shutdownContext); shutdownErr != nil {
			logger.Error("telemetry shutdown failed", "error_class", "telemetry_shutdown_failed")
		}
	}()
	metrics, err := observability.NewMetrics(settings.AI.WarningThresholds)
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
	if settings.Recaptcha.Enabled {
		recaptchaContext, cancelRecaptcha := context.WithTimeout(context.Background(), 10*time.Second)
		recaptchaClient, recaptchaErr := recaptchaclient.NewClient(recaptchaContext)
		cancelRecaptcha()
		if recaptchaErr != nil {
			logger.Error("reCAPTCHA client unavailable", "error_class", "recaptcha_startup_failed")
			os.Exit(1)
		}
		defer recaptchaClient.Close()
		antiAbuse = recaptchainfra.NewVerifier(
			recaptchaClient,
			postgres.NewAnonymousRateLimiter(pool, settings.RateLimit.AnonymousCreatePerIPHour, settings.RateLimit.AnonymousCreatePerIP24h),
			system.Clock{},
			recaptchainfra.Settings{
				ProjectID: settings.Recaptcha.ProjectID, SiteKey: settings.Recaptcha.SiteKey,
				ExpectedAction: settings.Recaptcha.ExpectedAction, ExpectedHost: settings.App.PublicOrigin.Hostname(),
				ScoreThreshold: settings.Recaptcha.ScoreThreshold, RateHashKey: []byte(settings.Session.RateLimitHMACSecret),
			},
		)
	}
	sessionService := appsession.NewService(
		postgres.NewSessionRepository(pool), system.Clock{}, random, random, antiAbuse,
		appsession.Settings{
			SessionHashKey:     []byte(settings.Session.TokenPepper),
			CSRFHashKey:        []byte(settings.Session.CSRFTokenPepper),
			BootstrapHashKey:   []byte(settings.Session.BootstrapIDPepper),
			IdleTTL:            settings.Session.IdleTTL,
			AbsoluteTTL:        settings.Session.AbsoluteTTL,
			ActivityTouchAfter: settings.Session.ActivityTouchInterval,
			BootstrapTTL:       settings.Session.AnonymousBootstrapTTL,
		},
	)
	cycleService := appcycle.NewService(
		postgres.NewCycleRepository(pool), system.Clock{}, random, []byte(settings.Session.TokenPepper),
	)
	tokenCounter, err := aiprovider.NewTokenCounter(settings.AI.TokenizerEncoding)
	if err != nil {
		logger.Error("AI tokenizer configuration failed", "error_class", "ai_tokenizer_invalid")
		os.Exit(1)
	}
	var actionProvider appai.ActionAI = aiprovider.FakeActionAI{}
	if settings.AI.APIKey != "" {
		actionProvider = aiprovider.NewOpenAIActionAI(settings.AI.APIKey, settings.AI.Model, settings.AI.Timeout)
	}
	aiRepository := postgres.NewAIRepository(pool)
	aiSettings := appai.Settings{
		Provider: settings.AI.Provider, Model: settings.AI.Model,
		MaxInputTokens: settings.AI.MaxInputTokens, MaxOutputTokens: settings.AI.MaxOutputTokens,
		ProviderTimeout: settings.AI.Timeout, MaxProviderAttempts: settings.AI.MaxProviderAttempts,
		MaxGenerationsPerUser24h: settings.AI.MaxGenerationsPerUser24h,
		GeneratePromptVersion:    settings.AI.GeneratePromptVersion, RefinePromptVersion: settings.AI.RefinePromptVersion,
		MonthlyBudgetUSD:     settings.AI.MonthlyBudgetUSD,
		InputUSDPerMillion:   settings.AI.Pricing.InputUSDPerMillionTokens,
		OutputUSDPerMillion:  settings.AI.Pricing.OutputUSDPerMillionTokens,
		RatePerUserMinute:    settings.RateLimit.AIPerUserMinute,
		RatePerSessionMinute: settings.RateLimit.AIPerSessionMinute,
		RatePerIPMinute:      settings.RateLimit.AIPerIPMinute,
		RateLimitHMACKey:     []byte(settings.Session.RateLimitHMACSecret),
		LeaseDuration:        60 * time.Second,
	}
	contextBuilder := appai.NewContextBuilder(tokenCounter, settings.AI.MaxInputTokens)
	generateAction := appai.NewGenerateActionUseCase(aiRepository, actionProvider, contextBuilder, system.Clock{}, random, aiSettings)
	refineAction := appai.NewRefineActionUseCase(aiRepository, actionProvider, contextBuilder, system.Clock{}, random, aiSettings)
	generateAction.SetObserver(metrics)
	refineAction.SetObserver(metrics)
	var googleVerifier account.GoogleVerifier = googleidentity.NewVerifier(settings.Google.WebClientID)
	if settings.App.Environment == "test" {
		googleVerifier = googleidentity.FakeVerifier{}
	}
	accountService := account.NewService(
		postgres.NewAccountRepository(pool), googleVerifier,
		system.Clock{}, random, random,
		account.Settings{
			SessionHashKey: []byte(settings.Session.TokenPepper), CSRFHashKey: []byte(settings.Session.CSRFTokenPepper),
			IdleTTL: settings.Session.IdleTTL, AbsoluteTTL: settings.Session.AbsoluteTTL,
		},
	)
	router := httpapi.NewRouter(httpapi.Dependencies{
		Sessions:       sessionService,
		Cycles:         cycleService,
		GenerateAction: generateAction,
		RefineAction:   refineAction,
		Account:        accountService,
		RequestIDs:     random,
		PublicOrigin:   settings.App.PublicOrigin.String(),
		Ready:          pool.Ping,
		Logger:         logger,
		Production:     settings.App.Environment == "production",
		TrustProxy:     settings.App.Environment == "production",
		StaticDir:      settings.App.StaticDir,
		Metrics:        metrics,
	})
	server := &http.Server{
		Addr:              settings.App.HTTPAddress,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	shutdownContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("server starting", "address", server.Addr)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-shutdownContext.Done():
		gracefulContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(gracefulContext); err != nil {
			logger.Error("server shutdown failed", "error_class", "shutdown_failed")
			os.Exit(1)
		}
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server stopped", "error_class", "listen_failed")
			os.Exit(1)
		}
	}
}
