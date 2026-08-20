package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestHealth(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	NewRouter(Dependencies{}).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
}

func TestPathUUIDValidationRejectsNonCanonicalIdentifiers(t *testing.T) {
	server := &api{}
	router := chi.NewRouter()
	called := false
	router.Get("/goals/{goalId}", server.validatedPath(func(writer http.ResponseWriter, _ *http.Request) {
		called = true
		writer.WriteHeader(http.StatusNoContent)
	}, "goalId"))

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/goals/NOT-A-UUID", nil))

	if called {
		t.Fatal("handler was called for an invalid path UUID")
	}
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"VALIDATION_ERROR"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestPathUUIDValidationRejectsOtherUUIDVersions(t *testing.T) {
	server := &api{}
	router := chi.NewRouter()
	called := false
	router.Get("/goals/{goalId}", server.validatedPath(func(writer http.ResponseWriter, _ *http.Request) {
		called = true
		writer.WriteHeader(http.StatusNoContent)
	}, "goalId"))

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/goals/123e4567-e89b-42d3-a456-426614174000", nil))

	if called || response.Code != http.StatusBadRequest {
		t.Fatalf("handler called/status = %t/%d", called, response.Code)
	}
}

func TestIdempotencyKeyRequiresCanonicalUUIDv7(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request.Header.Set("Idempotency-Key", "123e4567-e89b-42d3-a456-426614174000")
	if got := idempotencyKey(request); got != "" {
		t.Fatalf("UUID v4 key = %q", got)
	}
	request.Header.Set("Idempotency-Key", "0198c20b-7b95-7000-8000-000000000001")
	if got := idempotencyKey(request); got != "0198c20b-7b95-7000-8000-000000000001" {
		t.Fatalf("UUID v7 key = %q", got)
	}
}

func TestSecurityHeaders(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	NewRouter(Dependencies{Production: true}).ServeHTTP(response, request)
	if response.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("Content-Security-Policy is missing")
	}
	if response.Header().Get("Strict-Transport-Security") == "" {
		t.Fatal("Strict-Transport-Security is missing in production")
	}
}
