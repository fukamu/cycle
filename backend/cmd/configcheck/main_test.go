package main

import (
	"strings"
	"testing"
)

func TestCheckConfigurationRejectsExternalTelemetryInDevelopment(t *testing.T) {
	environment := map[string]string{
		"APP_ENV":                     "development",
		"DATABASE_URL":                "postgres://fukamu:fukamu@localhost:5432/fukamu_cycle?sslmode=disable",
		"SESSION_TOKEN_PEPPER":        "123456789012345678901234",
		"CSRF_TOKEN_PEPPER":           "123456789012345678901234",
		"BOOTSTRAP_ID_PEPPER":         "123456789012345678901234",
		"RATE_LIMIT_HMAC_SECRET":      "123456789012345678901234",
		"CURSOR_SIGNING_SECRET":       "123456789012345678901234",
		"TURNSTILE_ENABLED":           "false",
		"OTEL_EXPORTER_OTLP_ENDPOINT": "https://telemetry.example.invalid",
		"OTEL_EXPORTER_OTLP_HEADERS":  "authorization=SECRET_HEADER_CANARY",
	}
	err := checkConfigurationWithLookup(func(key string) (string, bool) {
		value, ok := environment[key]
		return value, ok
	})
	if err == nil || err.Error() != "telemetry configuration invalid" {
		t.Fatalf("checkConfigurationWithLookup() error = %v", err)
	}
	for _, canary := range []string{"telemetry.example.invalid", "SECRET_HEADER_CANARY"} {
		if strings.Contains(err.Error(), canary) {
			t.Fatalf("configuration error exposed %q", canary)
		}
	}
}
