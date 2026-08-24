package config

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const minimumSecretLength = 24

type LookupEnv func(string) (string, bool)

type Config struct {
	App       AppConfig
	Database  DatabaseConfig
	Session   SessionConfig
	Goals     GoalConfig
	AI        AIConfig
	RateLimit RateLimitConfig
	Turnstile TurnstileConfig
	Google    GoogleConfig
}

type AppConfig struct {
	Environment  string
	PublicOrigin *url.URL
	HTTPAddress  string
	StaticDir    string
}

type DatabaseConfig struct {
	URL             string
	MaxOpenConns    int32
	MaxIdleConns    int32
	ConnMaxLifetime time.Duration
}

type SessionConfig struct {
	TokenPepper           string
	CSRFTokenPepper       string
	BootstrapIDPepper     string
	RateLimitHMACSecret   string
	CursorSigningSecret   string
	IdleTTL               time.Duration
	AbsoluteTTL           time.Duration
	ActivityTouchInterval time.Duration
	AnonymousBootstrapTTL time.Duration
}

type GoalConfig struct {
	MaxProgressingGoals int
}

type AIConfig struct {
	APIKey                    string
	Provider                  string
	Model                     string
	ReasoningEffort           string
	MaxInputTokens            int
	GoalRefineMaxOutputTokens int
	ActionMaxOutputTokens     int
	MaxContextCycles          int
	Timeout                   time.Duration
	MaxProviderAttempts       int
	MaxRetryBackoff           time.Duration
	FinalizationGrace         time.Duration
	LeaseDuration             time.Duration
	MaxGenerationsPerUser24h  int
	GoalPromptVersion         string
	GeneratePromptVersion     string
	RefinePromptVersion       string
	TokenizerEncoding         string
	MonthlyBudgetUSD          float64
	WarningThresholds         []float64
	Pricing                   AIPricingConfig
}

type AIPricingConfig struct {
	Model                     string
	InputUSDPerMillionTokens  float64
	OutputUSDPerMillionTokens float64
}

type RateLimitConfig struct {
	AnonymousCreatePerIPHour int
	AnonymousCreatePerIP24h  int
	AIPerUserMinute          int
	AIPerSessionMinute       int
	AIPerIPMinute            int
}

type TurnstileConfig struct {
	Enabled        bool
	SecretKey      string
	ExpectedAction string
}

type GoogleConfig struct {
	WebClientID string
}

func Load(lookup LookupEnv) (Config, error) {
	reader := envReader{lookup: lookup}
	publicOrigin, err := parseURL(reader.stringValue("PUBLIC_ORIGIN", "http://localhost:5173"))
	if err != nil {
		return Config{}, fmt.Errorf("PUBLIC_ORIGIN: %w", err)
	}

	config := Config{
		App: AppConfig{
			Environment:  reader.stringValue("APP_ENV", "development"),
			PublicOrigin: publicOrigin,
			HTTPAddress:  reader.stringValue("HTTP_ADDRESS", ":8080"),
			StaticDir:    reader.stringValue("STATIC_DIR", ""),
		},
		Database: DatabaseConfig{
			URL:             reader.stringValue("DATABASE_URL", ""),
			MaxOpenConns:    reader.int32Value("DB_MAX_OPEN_CONNS", 10),
			MaxIdleConns:    reader.int32Value("DB_MAX_IDLE_CONNS", 5),
			ConnMaxLifetime: reader.durationMinutes("DB_CONN_MAX_LIFETIME_MINUTES", 30),
		},
		Session: SessionConfig{
			TokenPepper:           reader.stringValue("SESSION_TOKEN_PEPPER", ""),
			CSRFTokenPepper:       reader.stringValue("CSRF_TOKEN_PEPPER", ""),
			BootstrapIDPepper:     reader.stringValue("BOOTSTRAP_ID_PEPPER", ""),
			RateLimitHMACSecret:   reader.stringValue("RATE_LIMIT_HMAC_SECRET", ""),
			CursorSigningSecret:   reader.stringValue("CURSOR_SIGNING_SECRET", ""),
			IdleTTL:               reader.durationDays("SESSION_IDLE_DAYS", 30),
			AbsoluteTTL:           reader.durationDays("SESSION_ABSOLUTE_DAYS", 180),
			ActivityTouchInterval: reader.durationMinutes("SESSION_ACTIVITY_TOUCH_MINUTES", 15),
			AnonymousBootstrapTTL: reader.durationMinutes("ANONYMOUS_BOOTSTRAP_TTL_MINUTES", 10),
		},
		Goals: GoalConfig{MaxProgressingGoals: reader.intValue("MAX_PROGRESSING_GOALS", 2)},
		AI: AIConfig{
			APIKey:                    reader.stringValue("OPENAI_API_KEY", ""),
			Provider:                  reader.stringValue("AI_PROVIDER", "openai"),
			Model:                     reader.stringValue("AI_MODEL", "gpt-5.6-luna"),
			ReasoningEffort:           reader.stringValue("AI_REASONING_EFFORT", "medium"),
			MaxInputTokens:            reader.intValue("AI_MAX_INPUT_TOKENS", 12000),
			GoalRefineMaxOutputTokens: reader.intValue("AI_GOAL_REFINE_MAX_OUTPUT_TOKENS", 400),
			ActionMaxOutputTokens:     reader.intValue("AI_ACTION_MAX_OUTPUT_TOKENS", 800),
			MaxContextCycles:          reader.intValue("AI_MAX_CONTEXT_CYCLES", 10),
			Timeout:                   reader.durationSeconds("AI_TIMEOUT_SECONDS", 45),
			MaxProviderAttempts:       reader.intValue("AI_MAX_PROVIDER_ATTEMPTS", 2),
			MaxRetryBackoff:           reader.durationSeconds("AI_MAX_RETRY_BACKOFF_SECONDS", 5),
			FinalizationGrace:         reader.durationSeconds("AI_FINALIZATION_GRACE_SECONDS", 15),
			LeaseDuration:             reader.durationSeconds("AI_LEASE_SECONDS", 120),
			MaxGenerationsPerUser24h:  reader.intValue("AI_MAX_GENERATIONS_PER_USER_24H", 10),
			GoalPromptVersion:         reader.stringValue("AI_GOAL_REFINE_PROMPT_VERSION", "goal-refine-v2"),
			GeneratePromptVersion:     reader.stringValue("AI_GENERATE_PROMPT_VERSION", "action-generate-v2"),
			RefinePromptVersion:       reader.stringValue("AI_REFINE_PROMPT_VERSION", "action-refine-v2"),
			TokenizerEncoding:         reader.stringValue("AI_TOKENIZER_ENCODING", "o200k_base"),
			MonthlyBudgetUSD:          reader.floatValue("AI_MONTHLY_BUDGET_USD", 100),
			WarningThresholds:         reader.floatList("AI_WARNING_THRESHOLDS", []float64{0.5, 0.8}),
			Pricing: AIPricingConfig{
				Model:                     reader.stringValue("AI_PRICING_MODEL", "gpt-5.6-luna"),
				InputUSDPerMillionTokens:  reader.floatValue("AI_PRICE_INPUT_USD_PER_MILLION", 0),
				OutputUSDPerMillionTokens: reader.floatValue("AI_PRICE_OUTPUT_USD_PER_MILLION", 0),
			},
		},
		RateLimit: RateLimitConfig{
			AnonymousCreatePerIPHour: reader.intValue("RATE_ANONYMOUS_CREATE_PER_IP_HOUR", 5),
			AnonymousCreatePerIP24h:  reader.intValue("RATE_ANONYMOUS_CREATE_PER_IP_24H", 20),
			AIPerUserMinute:          reader.intValue("RATE_AI_PER_USER_MINUTE", 3),
			AIPerSessionMinute:       reader.intValue("RATE_AI_PER_SESSION_MINUTE", 3),
			AIPerIPMinute:            reader.intValue("RATE_AI_PER_IP_MINUTE", 10),
		},
		Turnstile: TurnstileConfig{
			Enabled:        reader.boolValue("TURNSTILE_ENABLED", true),
			SecretKey:      reader.stringValue("TURNSTILE_SECRET_KEY", ""),
			ExpectedAction: reader.stringValue("TURNSTILE_EXPECTED_ACTION", "anonymous_bootstrap"),
		},
		Google: GoogleConfig{WebClientID: reader.stringValue("GOOGLE_WEB_CLIENT_ID", "")},
	}
	if reader.err != nil {
		return Config{}, reader.err
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config Config) Validate() error {
	var problems []string
	if config.App.Environment != "development" && config.App.Environment != "test" && config.App.Environment != "production" {
		problems = append(problems, "APP_ENV must be development, test, or production")
	}
	if config.App.PublicOrigin == nil || config.App.PublicOrigin.Scheme == "" || config.App.PublicOrigin.Host == "" {
		problems = append(problems, "PUBLIC_ORIGIN must be an absolute URL")
	} else if config.App.Environment == "production" && config.App.PublicOrigin.Scheme != "https" {
		problems = append(problems, "PUBLIC_ORIGIN must use https in production")
	}
	if strings.TrimSpace(config.App.HTTPAddress) == "" {
		problems = append(problems, "HTTP_ADDRESS is required")
	}
	if err := validateDatabaseURL(config.Database.URL); err != nil {
		problems = append(problems, err.Error())
	}
	if config.Database.MaxOpenConns <= 0 || config.Database.MaxIdleConns < 0 || config.Database.MaxIdleConns > config.Database.MaxOpenConns {
		problems = append(problems, "database connection limits are invalid")
	}
	if config.Database.ConnMaxLifetime <= 0 {
		problems = append(problems, "DB_CONN_MAX_LIFETIME_MINUTES must be positive")
	}
	for name, secret := range map[string]string{
		"SESSION_TOKEN_PEPPER":   config.Session.TokenPepper,
		"CSRF_TOKEN_PEPPER":      config.Session.CSRFTokenPepper,
		"BOOTSTRAP_ID_PEPPER":    config.Session.BootstrapIDPepper,
		"RATE_LIMIT_HMAC_SECRET": config.Session.RateLimitHMACSecret,
		"CURSOR_SIGNING_SECRET":  config.Session.CursorSigningSecret,
	} {
		if len(secret) < minimumSecretLength {
			problems = append(problems, name+" must be at least 24 characters")
		}
	}
	if config.Session.IdleTTL <= 0 || config.Session.AbsoluteTTL < config.Session.IdleTTL || config.Session.ActivityTouchInterval <= 0 || config.Session.AnonymousBootstrapTTL <= 0 {
		problems = append(problems, "session durations are invalid")
	}
	if config.Goals.MaxProgressingGoals <= 0 {
		problems = append(problems, "MAX_PROGRESSING_GOALS must be positive")
	}
	if config.AI.Provider != "openai" {
		problems = append(problems, "AI_PROVIDER must be openai")
	}
	if !isGPT56ReasoningEffort(config.AI.ReasoningEffort) {
		problems = append(problems, "AI_REASONING_EFFORT must be none, low, medium, high, xhigh, or max")
	}
	if config.AI.Model == "" || config.AI.MaxInputTokens <= 0 || config.AI.GoalRefineMaxOutputTokens <= 0 || config.AI.ActionMaxOutputTokens <= 0 || config.AI.MaxContextCycles < 1 || config.AI.MaxContextCycles > 10 || config.AI.Timeout <= 0 {
		problems = append(problems, "AI model, token budgets, context cycle limit (1..10), and timeout are invalid")
	}
	if config.AI.MaxProviderAttempts < 1 || config.AI.MaxProviderAttempts > 2 {
		problems = append(problems, "AI_MAX_PROVIDER_ATTEMPTS must be between 1 and 2")
	}
	minimumLease := config.AI.Timeout*time.Duration(config.AI.MaxProviderAttempts) + config.AI.MaxRetryBackoff + config.AI.FinalizationGrace
	if config.AI.MaxRetryBackoff < 0 || config.AI.FinalizationGrace <= 0 || config.AI.LeaseDuration <= minimumLease {
		problems = append(problems, "AI_LEASE_SECONDS must exceed provider timeout attempts plus retry backoff and finalization grace")
	}
	if config.AI.GoalPromptVersion == "" || config.AI.GeneratePromptVersion == "" || config.AI.RefinePromptVersion == "" {
		problems = append(problems, "AI prompt versions are required")
	}
	if config.AI.MaxGenerationsPerUser24h <= 0 || !isFinite(config.AI.MonthlyBudgetUSD) || config.AI.MonthlyBudgetUSD <= 0 {
		problems = append(problems, "AI limits and monthly budget must be positive")
	}
	if config.AI.Model != config.AI.Pricing.Model {
		problems = append(problems, "AI_MODEL and AI_PRICING_MODEL must match")
	}
	if !isFinite(config.AI.Pricing.InputUSDPerMillionTokens) ||
		!isFinite(config.AI.Pricing.OutputUSDPerMillionTokens) ||
		config.AI.Pricing.InputUSDPerMillionTokens < 0 ||
		config.AI.Pricing.OutputUSDPerMillionTokens < 0 {
		problems = append(problems, "AI prices must be finite and cannot be negative")
	}
	if config.App.Environment == "production" && (config.AI.Pricing.InputUSDPerMillionTokens <= 0 || config.AI.Pricing.OutputUSDPerMillionTokens <= 0) {
		problems = append(problems, "production AI prices must be positive")
	}
	previous := float64(0)
	for _, threshold := range config.AI.WarningThresholds {
		if !isFinite(threshold) || threshold <= 0 || threshold >= 1 || threshold <= previous {
			problems = append(problems, "AI warning thresholds must be increasing values between 0 and 1")
			break
		}
		previous = threshold
	}
	if config.RateLimit.AnonymousCreatePerIPHour <= 0 || config.RateLimit.AnonymousCreatePerIP24h <= 0 || config.RateLimit.AIPerUserMinute <= 0 || config.RateLimit.AIPerSessionMinute <= 0 || config.RateLimit.AIPerIPMinute <= 0 {
		problems = append(problems, "rate limits must be positive")
	}
	if config.Turnstile.ExpectedAction == "" {
		problems = append(problems, "TURNSTILE_EXPECTED_ACTION is required")
	}
	if config.App.Environment == "production" {
		if config.AI.APIKey == "" {
			problems = append(problems, "OPENAI_API_KEY is required in production")
		}
		if config.Google.WebClientID == "" {
			problems = append(problems, "GOOGLE_WEB_CLIENT_ID is required in production")
		}
		if !config.Turnstile.Enabled || config.Turnstile.SecretKey == "" {
			problems = append(problems, "Turnstile must be fully configured in production")
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

type envReader struct {
	lookup LookupEnv
	err    error
}

func (reader *envReader) stringValue(key string, fallback string) string {
	if value, ok := reader.lookup(key); ok {
		return strings.TrimSpace(value)
	}
	return fallback
}

func (reader *envReader) intValue(key string, fallback int) int {
	raw, ok := reader.lookup(key)
	if !ok {
		return fallback
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		reader.addError(key, err)
		return 0
	}
	return value
}

func (reader *envReader) int32Value(key string, fallback int32) int32 {
	raw, ok := reader.lookup(key)
	if !ok {
		return fallback
	}
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 32)
	if err != nil {
		reader.addError(key, errors.New("must be a signed 32-bit integer"))
		return 0
	}
	return int32(value)
}

func (reader *envReader) floatValue(key string, fallback float64) float64 {
	raw, ok := reader.lookup(key)
	if !ok {
		return fallback
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || !isFinite(value) {
		reader.addError(key, errors.New("must be a finite number"))
		return 0
	}
	return value
}

func (reader *envReader) boolValue(key string, fallback bool) bool {
	raw, ok := reader.lookup(key)
	if !ok {
		return fallback
	}
	value, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		reader.addError(key, err)
		return false
	}
	return value
}

func (reader *envReader) floatList(key string, fallback []float64) []float64 {
	raw, ok := reader.lookup(key)
	if !ok {
		return append([]float64(nil), fallback...)
	}
	parts := strings.Split(raw, ",")
	values := make([]float64, 0, len(parts))
	for _, part := range parts {
		value, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
		if err != nil || !isFinite(value) {
			reader.addError(key, errors.New("must contain only finite numbers"))
			return nil
		}
		values = append(values, value)
	}
	return values
}

func (reader *envReader) durationSeconds(key string, fallback int) time.Duration {
	return reader.durationValue(key, fallback, time.Second)
}

func (reader *envReader) durationMinutes(key string, fallback int) time.Duration {
	return reader.durationValue(key, fallback, time.Minute)
}

func (reader *envReader) durationDays(key string, fallback int) time.Duration {
	return reader.durationValue(key, fallback, 24*time.Hour)
}

func (reader *envReader) durationValue(key string, fallback int, unit time.Duration) time.Duration {
	value := int64(fallback)
	if raw, ok := reader.lookup(key); ok {
		parsed, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil {
			reader.addError(key, errors.New("must be an integer within the supported duration range"))
			return 0
		}
		value = parsed
	}

	const (
		maxDuration = time.Duration(1<<63 - 1)
		minDuration = time.Duration(-1 << 63)
	)
	if value > int64(maxDuration/unit) || value < int64(minDuration/unit) {
		reader.addError(key, errors.New("must be within the supported duration range"))
		return 0
	}
	return time.Duration(value) * unit
}

func (reader *envReader) addError(key string, err error) {
	wrapped := fmt.Errorf("%s: %w", key, err)
	if reader.err == nil {
		reader.err = wrapped
		return
	}
	reader.err = errors.Join(reader.err, wrapped)
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func isGPT56ReasoningEffort(value string) bool {
	switch value {
	case "none", "low", "medium", "high", "xhigh", "max":
		return true
	default:
		return false
	}
}

func parseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Hostname() == "" ||
		parsed.User != nil ||
		parsed.Opaque != "" ||
		parsed.Path != "" ||
		parsed.RawPath != "" ||
		parsed.RawQuery != "" ||
		parsed.ForceQuery ||
		parsed.Fragment != "" ||
		strings.Contains(raw, "#") {
		return nil, errors.New("must be a canonical absolute origin without credentials, path, query, or fragment")
	}
	return parsed, nil
}

func validateDatabaseURL(raw string) error {
	const message = "DATABASE_URL must be a postgres or postgresql URL with a host and database name"

	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil ||
		(parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") ||
		parsed.Hostname() == "" ||
		parsed.Opaque != "" ||
		parsed.Fragment != "" ||
		strings.Contains(raw, "#") {
		return errors.New(message)
	}
	databaseName := strings.TrimPrefix(parsed.Path, "/")
	if strings.TrimSpace(databaseName) == "" {
		return errors.New(message)
	}
	return nil
}
