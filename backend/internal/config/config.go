package config

import (
	"errors"
	"fmt"
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
	AI        AIConfig
	RateLimit RateLimitConfig
	Recaptcha RecaptchaConfig
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
	IdleTTL               time.Duration
	AbsoluteTTL           time.Duration
	ActivityTouchInterval time.Duration
	AnonymousBootstrapTTL time.Duration
}

type AIConfig struct {
	APIKey                   string
	Provider                 string
	Model                    string
	MaxInputTokens           int
	MaxOutputTokens          int
	Timeout                  time.Duration
	MaxProviderAttempts      int
	MaxGenerationsPerUser24h int
	GeneratePromptVersion    string
	RefinePromptVersion      string
	TokenizerEncoding        string
	MonthlyBudgetUSD         float64
	WarningThresholds        []float64
	Pricing                  AIPricingConfig
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

type RecaptchaConfig struct {
	Enabled        bool
	ProjectID      string
	SiteKey        string
	ScoreThreshold float64
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
			MaxOpenConns:    int32(reader.intValue("DB_MAX_OPEN_CONNS", 10)),
			MaxIdleConns:    int32(reader.intValue("DB_MAX_IDLE_CONNS", 5)),
			ConnMaxLifetime: reader.durationMinutes("DB_CONN_MAX_LIFETIME_MINUTES", 30),
		},
		Session: SessionConfig{
			TokenPepper:           reader.stringValue("SESSION_TOKEN_PEPPER", ""),
			CSRFTokenPepper:       reader.stringValue("CSRF_TOKEN_PEPPER", ""),
			BootstrapIDPepper:     reader.stringValue("BOOTSTRAP_ID_PEPPER", ""),
			RateLimitHMACSecret:   reader.stringValue("RATE_LIMIT_HMAC_SECRET", ""),
			IdleTTL:               reader.durationDays("SESSION_IDLE_DAYS", 30),
			AbsoluteTTL:           reader.durationDays("SESSION_ABSOLUTE_DAYS", 180),
			ActivityTouchInterval: reader.durationMinutes("SESSION_ACTIVITY_TOUCH_MINUTES", 15),
			AnonymousBootstrapTTL: reader.durationMinutes("ANONYMOUS_BOOTSTRAP_TTL_MINUTES", 10),
		},
		AI: AIConfig{
			APIKey:                   reader.stringValue("OPENAI_API_KEY", ""),
			Provider:                 reader.stringValue("AI_PROVIDER", "openai"),
			Model:                    reader.stringValue("AI_MODEL", "gpt-5-mini"),
			MaxInputTokens:           reader.intValue("AI_MAX_INPUT_TOKENS", 12000),
			MaxOutputTokens:          reader.intValue("AI_MAX_OUTPUT_TOKENS", 800),
			Timeout:                  reader.durationSeconds("AI_TIMEOUT_SECONDS", 45),
			MaxProviderAttempts:      reader.intValue("AI_MAX_PROVIDER_ATTEMPTS", 2),
			MaxGenerationsPerUser24h: reader.intValue("AI_MAX_GENERATIONS_PER_USER_24H", 10),
			GeneratePromptVersion:    reader.stringValue("AI_GENERATE_PROMPT_VERSION", "generate-action-v1"),
			RefinePromptVersion:      reader.stringValue("AI_REFINE_PROMPT_VERSION", "refine-action-v1"),
			TokenizerEncoding:        reader.stringValue("AI_TOKENIZER_ENCODING", "o200k_base"),
			MonthlyBudgetUSD:         reader.floatValue("AI_MONTHLY_BUDGET_USD", 100),
			WarningThresholds:        reader.floatList("AI_WARNING_THRESHOLDS", []float64{0.5, 0.8}),
			Pricing: AIPricingConfig{
				Model:                     reader.stringValue("AI_PRICE_MODEL", "gpt-5-mini"),
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
		Recaptcha: RecaptchaConfig{
			Enabled:        reader.boolValue("RECAPTCHA_ENABLED", true),
			ProjectID:      reader.stringValue("RECAPTCHA_PROJECT_ID", ""),
			SiteKey:        reader.stringValue("RECAPTCHA_SITE_KEY", ""),
			ScoreThreshold: reader.floatValue("RECAPTCHA_SCORE_THRESHOLD", 0.5),
			ExpectedAction: reader.stringValue("RECAPTCHA_EXPECTED_ACTION", "anonymous_bootstrap"),
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
	if strings.TrimSpace(config.Database.URL) == "" {
		problems = append(problems, "DATABASE_URL is required")
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
	} {
		if len(secret) < minimumSecretLength {
			problems = append(problems, name+" must be at least 24 characters")
		}
	}
	if config.Session.IdleTTL <= 0 || config.Session.AbsoluteTTL < config.Session.IdleTTL || config.Session.ActivityTouchInterval <= 0 || config.Session.AnonymousBootstrapTTL <= 0 {
		problems = append(problems, "session durations are invalid")
	}
	if config.AI.Provider != "openai" {
		problems = append(problems, "AI_PROVIDER must be openai")
	}
	if config.AI.Model == "" || config.AI.MaxInputTokens <= 0 || config.AI.MaxOutputTokens <= 0 || config.AI.Timeout <= 0 {
		problems = append(problems, "AI model, token budgets, and timeout must be positive")
	}
	if config.AI.MaxProviderAttempts < 1 || config.AI.MaxProviderAttempts > 2 {
		problems = append(problems, "AI_MAX_PROVIDER_ATTEMPTS must be between 1 and 2")
	}
	if config.AI.MaxGenerationsPerUser24h <= 0 || config.AI.MonthlyBudgetUSD <= 0 {
		problems = append(problems, "AI limits and monthly budget must be positive")
	}
	if config.AI.Model != config.AI.Pricing.Model {
		problems = append(problems, "AI_MODEL and AI_PRICE_MODEL must match")
	}
	if config.AI.Pricing.InputUSDPerMillionTokens < 0 || config.AI.Pricing.OutputUSDPerMillionTokens < 0 {
		problems = append(problems, "AI prices cannot be negative")
	}
	previous := float64(0)
	for _, threshold := range config.AI.WarningThresholds {
		if threshold <= 0 || threshold >= 1 || threshold <= previous {
			problems = append(problems, "AI warning thresholds must be increasing values between 0 and 1")
			break
		}
		previous = threshold
	}
	if config.RateLimit.AnonymousCreatePerIPHour <= 0 || config.RateLimit.AnonymousCreatePerIP24h <= 0 || config.RateLimit.AIPerUserMinute <= 0 || config.RateLimit.AIPerSessionMinute <= 0 || config.RateLimit.AIPerIPMinute <= 0 {
		problems = append(problems, "rate limits must be positive")
	}
	if config.Recaptcha.ScoreThreshold < 0 || config.Recaptcha.ScoreThreshold > 1 || config.Recaptcha.ExpectedAction == "" {
		problems = append(problems, "reCAPTCHA threshold/action are invalid")
	}
	if config.App.Environment == "production" {
		if config.AI.APIKey == "" {
			problems = append(problems, "OPENAI_API_KEY is required in production")
		}
		if config.Google.WebClientID == "" {
			problems = append(problems, "GOOGLE_WEB_CLIENT_ID is required in production")
		}
		if !config.Recaptcha.Enabled || config.Recaptcha.ProjectID == "" || config.Recaptcha.SiteKey == "" {
			problems = append(problems, "reCAPTCHA must be fully configured in production")
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

func (reader *envReader) floatValue(key string, fallback float64) float64 {
	raw, ok := reader.lookup(key)
	if !ok {
		return fallback
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		reader.addError(key, err)
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
		if err != nil {
			reader.addError(key, err)
			return nil
		}
		values = append(values, value)
	}
	return values
}

func (reader *envReader) durationSeconds(key string, fallback int) time.Duration {
	return time.Duration(reader.intValue(key, fallback)) * time.Second
}

func (reader *envReader) durationMinutes(key string, fallback int) time.Duration {
	return time.Duration(reader.intValue(key, fallback)) * time.Minute
}

func (reader *envReader) durationDays(key string, fallback int) time.Duration {
	return time.Duration(reader.intValue(key, fallback)) * 24 * time.Hour
}

func (reader *envReader) addError(key string, err error) {
	wrapped := fmt.Errorf("%s: %w", key, err)
	if reader.err == nil {
		reader.err = wrapped
		return
	}
	reader.err = errors.Join(reader.err, wrapped)
}

func parseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("must be an absolute origin without credentials, query, or fragment")
	}
	return parsed, nil
}
