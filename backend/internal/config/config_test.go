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
	if config.AI.GoalPromptVersion != "goal-refine-v2" || config.AI.GeneratePromptVersion != "action-generate-v2" || config.AI.RefinePromptVersion != "action-refine-v2" {
		t.Fatalf("AI prompt defaults = %#v", config.AI)
	}
	if config.AI.ReasoningEffort != "medium" {
		t.Fatalf("ReasoningEffort = %q, want medium", config.AI.ReasoningEffort)
	}
	if config.Database.MaxOpenConns != 10 {
		t.Fatalf("MaxOpenConns = %d", config.Database.MaxOpenConns)
	}
	if config.Goals.MaxProgressingGoals != 2 {
		t.Fatalf("MaxProgressingGoals = %d, want free limit 2", config.Goals.MaxProgressingGoals)
	}
	if config.RateLimit.GoalStartPerUserMinute != 5 || config.RateLimit.GoalStartPerSessionMinute != 5 {
		t.Fatalf("Goal Start rate defaults = %#v", config.RateLimit)
	}
	if config.Telemetry.OTLPEndpoint != "" || config.Telemetry.OTLPHeaders != "" {
		t.Fatalf("development telemetry = %#v, want in-memory defaults", config.Telemetry)
	}
}

func TestLoadRequiresProductionTelemetryConfigurationWithoutExposingHeaders(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	environment["APP_ENV"] = "production"
	environment["PUBLIC_ORIGIN"] = "https://cycle.staging.fukamu.matoruru.com"
	environment["OPENAI_API_KEY"] = "test-openai-key"
	environment["GOOGLE_WEB_CLIENT_ID"] = "test.apps.googleusercontent.com"
	environment["TURNSTILE_ENABLED"] = "true"
	environment["TURNSTILE_SECRET_KEY"] = "test-turnstile-secret"
	environment["AI_PRICE_INPUT_USD_PER_MILLION"] = "1"
	environment["AI_PRICE_OUTPUT_USD_PER_MILLION"] = "1"
	_, err := Load(mapLookup(environment))
	if err == nil || !strings.Contains(err.Error(), "OTEL_EXPORTER_OTLP_ENDPOINT") || !strings.Contains(err.Error(), "OTEL_EXPORTER_OTLP_HEADERS") {
		t.Fatalf("Load() error = %v", err)
	}

	const headerCanary = "authorization=test-only-header-canary"
	environment["OTEL_EXPORTER_OTLP_HEADERS"] = headerCanary
	_, err = Load(mapLookup(environment))
	if err == nil || !strings.Contains(err.Error(), "OTEL_EXPORTER_OTLP_ENDPOINT") || strings.Contains(err.Error(), "OTEL_EXPORTER_OTLP_HEADERS") {
		t.Fatalf("Load() error = %v", err)
	}
	if strings.Contains(err.Error(), headerCanary) {
		t.Fatal("Load() error exposed OTEL_EXPORTER_OTLP_HEADERS")
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

func TestLoadValidatesGoalStartRateLimitsStrictly(t *testing.T) {
	t.Parallel()
	environment := validEnvironment()
	environment["RATE_GOAL_START_PER_USER_MINUTE"] = "7"
	environment["RATE_GOAL_START_PER_SESSION_MINUTE"] = "9"
	loaded, err := Load(mapLookup(environment))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.RateLimit.GoalStartPerUserMinute != 7 || loaded.RateLimit.GoalStartPerSessionMinute != 9 {
		t.Fatalf("Goal Start rate config = %#v", loaded.RateLimit)
	}
	for _, key := range []string{"RATE_GOAL_START_PER_USER_MINUTE", "RATE_GOAL_START_PER_SESSION_MINUTE"} {
		for _, value := range []string{"0", "-1", "not-an-integer"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				t.Parallel()
				invalid := validEnvironment()
				invalid[key] = value
				if _, loadErr := Load(mapLookup(invalid)); loadErr == nil {
					t.Fatalf("Load accepted %s=%q", key, value)
				}
			})
		}
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
	environment["PUBLIC_ORIGIN"] = "https://cycle.staging.fukamu.matoruru.com"
	environment["OPENAI_API_KEY"] = "test-openai-key"
	environment["GOOGLE_WEB_CLIENT_ID"] = "test.apps.googleusercontent.com"
	environment["TURNSTILE_ENABLED"] = "true"
	environment["TURNSTILE_SECRET_KEY"] = "test-turnstile-secret"
	environment["AI_PRICE_INPUT_USD_PER_MILLION"] = "1"
	environment["AI_PRICE_OUTPUT_USD_PER_MILLION"] = "1"
	environment["OTEL_EXPORTER_OTLP_ENDPOINT"] = "https://telemetry.example.test"
	environment["OTEL_EXPORTER_OTLP_HEADERS"] = "authorization=Bearer%20test-only"
	config, err := Load(mapLookup(environment))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.Telemetry.OTLPEndpoint != environment["OTEL_EXPORTER_OTLP_ENDPOINT"] || config.Telemetry.OTLPHeaders != environment["OTEL_EXPORTER_OTLP_HEADERS"] {
		t.Fatalf("Telemetry = %#v", config.Telemetry)
	}
}

func TestLoadAcceptsSupportedReasoningEfforts(t *testing.T) {
	t.Parallel()

	for _, effort := range []string{"none", "low", "medium", "high", "xhigh", "max"} {
		t.Run(effort, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment["AI_REASONING_EFFORT"] = effort
			config, err := Load(mapLookup(environment))
			if err != nil || config.AI.ReasoningEffort != effort {
				t.Fatalf("Load() = %#v, %v", config.AI, err)
			}
		})
	}
}

func TestLoadRejectsUnsupportedReasoningEffort(t *testing.T) {
	t.Parallel()

	for name, effort := range map[string]string{"empty": "", "unsupported minimal": "minimal", "invalid case": "MEDIUM"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment["AI_REASONING_EFFORT"] = effort
			_, err := Load(mapLookup(environment))
			if err == nil || !strings.Contains(err.Error(), "AI_REASONING_EFFORT") {
				t.Fatalf("Load() error = %v", err)
			}
		})
	}
}

func TestLoadRejectsNonCanonicalPublicOrigin(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		value string
	}{
		{name: "path", value: "http://localhost:5173/app"},
		{name: "trailing slash", value: "http://localhost:5173/"},
		{name: "query", value: "http://localhost:5173?source=test"},
		{name: "userinfo", value: "http://user:password@localhost:5173"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment["PUBLIC_ORIGIN"] = test.value
			if _, err := Load(mapLookup(environment)); err == nil {
				t.Fatalf("Load() accepted non-canonical PUBLIC_ORIGIN %q", test.value)
			}
		})
	}
}

func TestLoadRejectsInvalidDatabaseURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		value string
	}{
		{name: "malformed", value: "://not-a-url"},
		{name: "non-postgres scheme", value: "mysql://user:password@localhost:3306/fukamu_cycle"},
		{name: "missing database path", value: "postgres://user:password@localhost:5432"},
		{name: "empty database name", value: "postgres://user:password@localhost:5432/"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment["DATABASE_URL"] = test.value
			_, err := Load(mapLookup(environment))
			if err == nil {
				t.Fatalf("Load() accepted invalid DATABASE_URL %q", test.value)
			}
			if strings.Contains(err.Error(), test.value) {
				t.Fatal("Load() error exposed DATABASE_URL")
			}
		})
	}
}

func TestLoadAcceptsPostgresqlDatabaseURL(t *testing.T) {
	t.Parallel()

	environment := validEnvironment()
	environment["DATABASE_URL"] = "postgresql://user:password@localhost:5432/fukamu_cycle?sslmode=disable"
	if _, err := Load(mapLookup(environment)); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadRejectsNonFiniteNumbers(t *testing.T) {
	t.Parallel()

	for _, key := range []string{
		"AI_MONTHLY_BUDGET_USD",
		"AI_PRICE_INPUT_USD_PER_MILLION",
		"AI_PRICE_OUTPUT_USD_PER_MILLION",
		"AI_WARNING_THRESHOLDS",
	} {
		for _, value := range []string{"NaN", "+Inf", "-Inf"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				t.Parallel()
				environment := validEnvironment()
				environment[key] = value
				if _, err := Load(mapLookup(environment)); err == nil {
					t.Fatalf("Load() accepted non-finite %s=%q", key, value)
				}
			})
		}
	}
}

func TestLoadRejectsDatabaseConnectionIntegerOverflow(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "max open wraps to positive int32", key: "DB_MAX_OPEN_CONNS", value: "4294967306"},
		{name: "max idle wraps to positive int32", key: "DB_MAX_IDLE_CONNS", value: "4294967301"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment[test.key] = test.value
			if _, err := Load(mapLookup(environment)); err == nil {
				t.Fatalf("Load() accepted overflowing %s=%q", test.key, test.value)
			}
		})
	}
}

func TestLoadRejectsDurationOverflow(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "seconds", key: "AI_TIMEOUT_SECONDS", value: "18446744074"},
		{name: "minutes", key: "DB_CONN_MAX_LIFETIME_MINUTES", value: "307445735"},
		{name: "days", key: "SESSION_IDLE_DAYS", value: "213504"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment[test.key] = test.value
			if _, err := Load(mapLookup(environment)); err == nil {
				t.Fatalf("Load() accepted overflowing %s=%q", test.key, test.value)
			}
		})
	}
}

func validEnvironment() map[string]string {
	return map[string]string{
		"APP_ENV":                "development",
		"PUBLIC_ORIGIN":          "http://localhost:5173",
		"DATABASE_URL":           "postgres://fukamu_cycle:fukamu_cycle@localhost:5432/fukamu_cycle?sslmode=disable",
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
