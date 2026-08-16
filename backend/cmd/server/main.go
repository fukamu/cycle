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

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	"github.com/matoruru/PDCAI/backend/internal/application/ports"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	"github.com/matoruru/PDCAI/backend/internal/config"
	"github.com/matoruru/PDCAI/backend/internal/httpapi"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/aiprovider"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/postgres"
	"github.com/matoruru/PDCAI/backend/internal/infrastructure/system"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		logger.Error("invalid configuration", "error_class", "configuration_invalid", "error", err)
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
		antiAbuse = system.DenyAnonymous{}
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
	router := httpapi.NewRouter(httpapi.Dependencies{
		Sessions:       sessionService,
		Cycles:         cycleService,
		GenerateAction: generateAction,
		RefineAction:   refineAction,
		RequestIDs:     random,
		PublicOrigin:   settings.App.PublicOrigin.String(),
		Ready:          pool.Ping,
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
