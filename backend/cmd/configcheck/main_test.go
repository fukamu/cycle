package main

import (
	"strings"
	"testing"
)

func TestCheckConfigurationRejectsExternalTelemetryInDevelopment(t *testing.T) {
	environment := validConfigcheckEnvironment()
	environment["OTEL_EXPORTER_OTLP_ENDPOINT"] = "https://telemetry.example.invalid"
	environment["OTEL_EXPORTER_OTLP_HEADERS"] = "authorization=SECRET_HEADER_CANARY"
	err := checkConfigurationWithLookup(mapConfigcheckLookup(environment))
	if err == nil || err.Error() != "telemetry configuration invalid" {
		t.Fatalf("checkConfigurationWithLookup() error = %v", err)
	}
	for _, canary := range []string{"telemetry.example.invalid", "SECRET_HEADER_CANARY"} {
		if strings.Contains(err.Error(), canary) {
			t.Fatalf("configuration error exposed %q", canary)
		}
	}
}

func TestCheckConfigurationAcceptsCSRFAndSessionAbsoluteBoundaries(t *testing.T) {
	environment := validConfigcheckEnvironment()
	environment["SESSION_ABSOLUTE_DAYS"] = "180"
	if err := checkConfigurationWithLookup(mapConfigcheckLookup(environment)); err != nil {
		t.Fatalf("checkConfigurationWithLookup() error = %v", err)
	}
}

func TestCheckConfigurationRejectsShortCSRFPepper(t *testing.T) {
	environment := validConfigcheckEnvironment()
	environment["CSRF_TOKEN_PEPPER"] = "1234567890123456789012345678901"
	if err := checkConfigurationWithLookup(mapConfigcheckLookup(environment)); err == nil || err.Error() != "configuration invalid" {
		t.Fatalf("checkConfigurationWithLookup() error = %v", err)
	}
}

func TestCheckConfigurationRejectsSessionAbsoluteTTLAbove180Days(t *testing.T) {
	environment := validConfigcheckEnvironment()
	environment["SESSION_ABSOLUTE_DAYS"] = "181"
	if err := checkConfigurationWithLookup(mapConfigcheckLookup(environment)); err == nil || err.Error() != "configuration invalid" {
		t.Fatalf("checkConfigurationWithLookup() error = %v", err)
	}
}

func validConfigcheckEnvironment() map[string]string {
	return map[string]string{
		"APP_ENV":                "development",
		"DATABASE_URL":           "postgres://fukamu:fukamu@localhost:5432/fukamu_cycle?sslmode=disable",
		"SESSION_TOKEN_PEPPER":   "123456789012345678901234",
		"CSRF_TOKEN_PEPPER":      "12345678901234567890123456789012",
		"BOOTSTRAP_ID_PEPPER":    "123456789012345678901234",
		"RATE_LIMIT_HMAC_SECRET": "123456789012345678901234",
		"CURSOR_SIGNING_SECRET":  "123456789012345678901234",
		"TURNSTILE_ENABLED":      "false",
	}
}

func mapConfigcheckLookup(environment map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := environment[key]
		return value, ok
	}
}
