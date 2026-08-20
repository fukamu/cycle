package config

import (
	"strings"
	"testing"
)

func TestLoadDevelopmentConfig(t *testing.T) {
	t.Parallel()

	config, err := Load(mapLookup(validEnvironment()))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.AI.MaxInputTokens != 12000 || config.AI.GoalRefineMaxOutputTokens != 400 || config.AI.ActionMaxOutputTokens != 800 || config.AI.MaxContextCycles != 10 {
		t.Fatalf("AI token defaults = %#v", config.AI)
	}
	if config.Database.MaxOpenConns != 10 {
		t.Fatalf("MaxOpenConns = %d", config.Database.MaxOpenConns)
	}
	if config.Goals.MaxProgressingGoals != 2 {
		t.Fatalf("MaxProgressingGoals = %d, want free limit 2", config.Goals.MaxProgressingGoals)
	}
}

func TestLoadAcceptsPaidProgressingGoalBoundary(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	environment["MAX_PROGRESSING_GOALS"] = "3"
	config, err := Load(mapLookup(environment))
	if err != nil {
		t.Fatal(err)
	}
	if config.Goals.MaxProgressingGoals != 3 {
		t.Fatalf("MaxProgressingGoals = %d, want paid boundary 3", config.Goals.MaxProgressingGoals)
	}
}

func TestLoadRejectsPricingModelMismatch(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	environment["AI_PRICING_MODEL"] = "different-model"
	_, err := Load(mapLookup(environment))
	if err == nil || !strings.Contains(err.Error(), "AI_MODEL and AI_PRICING_MODEL must match") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadRejectsInsecureProductionConfiguration(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	environment["APP_ENV"] = "production"
	_, err := Load(mapLookup(environment))
	if err == nil || !strings.Contains(err.Error(), "https") || !strings.Contains(err.Error(), "OPENAI_API_KEY") || !strings.Contains(err.Error(), "Turnstile") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadAcceptsCompleteProductionTurnstileConfiguration(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	environment["APP_ENV"] = "production"
	environment["PUBLIC_ORIGIN"] = "https://pdcai.matoruru.com"
	environment["OPENAI_API_KEY"] = "test-openai-key"
	environment["GOOGLE_WEB_CLIENT_ID"] = "test.apps.googleusercontent.com"
	environment["TURNSTILE_ENABLED"] = "true"
	environment["TURNSTILE_SECRET_KEY"] = "test-turnstile-secret"
	environment["AI_PRICE_INPUT_USD_PER_MILLION"] = "1"
	environment["AI_PRICE_OUTPUT_USD_PER_MILLION"] = "1"
	if _, err := Load(mapLookup(environment)); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}

func validEnvironment() map[string]string {
	return map[string]string{
		"APP_ENV":                "development",
		"PUBLIC_ORIGIN":          "http://localhost:5173",
		"DATABASE_URL":           "postgres://pdcai:pdcai@localhost:5432/pdcai?sslmode=disable",
		"SESSION_TOKEN_PEPPER":   "123456789012345678901234",
		"CSRF_TOKEN_PEPPER":      "123456789012345678901234",
		"BOOTSTRAP_ID_PEPPER":    "123456789012345678901234",
		"RATE_LIMIT_HMAC_SECRET": "123456789012345678901234",
		"CURSOR_SIGNING_SECRET":  "123456789012345678901234",
		"TURNSTILE_ENABLED":      "false",
	}
}

func mapLookup(environment map[string]string) LookupEnv {
	return func(key string) (string, bool) {
		value, ok := environment[key]
		return value, ok
	}
}
