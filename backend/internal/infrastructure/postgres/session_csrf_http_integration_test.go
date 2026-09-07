package postgres

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/account"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/httpapi"
	"github.com/fukamu/cycle/backend/internal/infrastructure/googleidentity"
	"github.com/fukamu/cycle/backend/internal/infrastructure/system"
	"github.com/fukamu/cycle/backend/internal/securehash"
)

const (
	csrfIntegrationSessionKey = "integration-session-key"
	csrfIntegrationCSRFKey    = "integration-csrf-key"
)

type csrfIntegrationWorkspace struct {
	httpapi.WorkspaceService

	mu          sync.Mutex
	createCalls int
}

func (service *csrfIntegrationWorkspace) CreateDraft(_ context.Context, _ string, body string) (workspace.DraftView, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	service.createCalls++
	return workspace.DraftView{
		ID:        fmt.Sprintf("0198c20b-7b95-7000-8000-%012d", service.createCalls),
		DraftType: "creation",
		Body:      body,
		UpdatedAt: integrationNow(),
	}, nil
}

func (service *csrfIntegrationWorkspace) calls() int {
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.createCalls
}

type csrfSessionArrivalBarrier struct {
	next     http.Handler
	expected int
	release  chan struct{}

	mu       sync.Mutex
	arrivals int
}

func newCSRFSessionArrivalBarrier(next http.Handler, expected int) *csrfSessionArrivalBarrier {
	return &csrfSessionArrivalBarrier{next: next, expected: expected, release: make(chan struct{})}
}

func (barrier *csrfSessionArrivalBarrier) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	wait := false
	if request.Method == http.MethodGet && request.URL.Path == "/api/v1/session" {
		barrier.mu.Lock()
		barrier.arrivals++
		wait = barrier.arrivals <= barrier.expected
		if barrier.arrivals == barrier.expected {
			close(barrier.release)
		}
		barrier.mu.Unlock()
	}
	if wait {
		select {
		case <-barrier.release:
		case <-request.Context().Done():
			return
		}
	}
	barrier.next.ServeHTTP(writer, request)
}

type csrfIntegrationHTTPResponse struct {
	status  int
	body    []byte
	cookies []*http.Cookie
	err     error
}

type csrfIntegrationSessionResponse struct {
	User struct {
		ID string `json:"id"`
	} `json:"user"`
	CSRFToken string `json:"csrfToken"`
}

func TestSessionCSRFConcurrentHTTPDiscoveryConvergesAndBothUnsafeRequestsSucceed(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	spaces := &csrfIntegrationWorkspace{}
	router := newCSRFIntegrationRouter(pool, spaces, csrfIntegrationCSRFKey, false)
	session := bootstrapContractClient(t, router, "0198c20b-7b95-7000-8000-000000000091")
	barrier := newCSRFSessionArrivalBarrier(router, 2)
	server := httptest.NewTLSServer(barrier)
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 10 * time.Second

	start := make(chan struct{})
	results := make(chan csrfIntegrationHTTPResponse, 2)
	for range 2 {
		go func() {
			<-start
			results <- performCSRFIntegrationHTTPRequest(
				client, server.URL, session.cookie, http.MethodGet, "/api/v1/session", "", "", "", "",
			)
		}()
	}
	close(start)

	tokens := make([]string, 0, 2)
	for range 2 {
		response := <-results
		if response.err != nil || response.status != http.StatusOK {
			t.Fatalf("concurrent GET /session = status %d, error %v", response.status, response.err)
		}
		view := decodeCSRFIntegrationSession(t, response.body)
		if view.User.ID != session.userID || view.CSRFToken == "" {
			t.Fatal("concurrent Session response omitted the expected identity or CSRF token")
		}
		tokens = append(tokens, view.CSRFToken)
	}
	if tokens[0] != tokens[1] {
		t.Fatal("concurrent GET /session returned different CSRF tokens")
	}

	unsafeResults := make(chan csrfIntegrationHTTPResponse, 2)
	for index, token := range tokens {
		go func() {
			unsafeResults <- performCSRFIntegrationHTTPRequest(
				client,
				server.URL,
				session.cookie,
				http.MethodPost,
				"/api/v1/goal-drafts",
				contractIntegrationOrigin,
				token,
				session.userID,
				fmt.Sprintf(`{"initialBody":"tab-%d"}`, index+1),
			)
		}()
	}
	for range 2 {
		response := <-unsafeResults
		if response.err != nil || response.status != http.StatusCreated {
			t.Fatalf("unsafe request after concurrent discovery = status %d, error %v", response.status, response.err)
		}
	}
	if spaces.calls() != 2 {
		t.Fatalf("CreateDraft calls = %d, want 2", spaces.calls())
	}
}

func TestSessionCSRFLegacyVerifierConvergesWithoutBreakingStableValidation(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	spaces := &csrfIntegrationWorkspace{}
	router := newCSRFIntegrationRouter(pool, spaces, csrfIntegrationCSRFKey, false)
	session := bootstrapContractClient(t, router, "0198c20b-7b95-7000-8000-000000000092")
	legacyToken := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x5a}, 32))
	setCSRFVerifierForCookie(t, pool, session.cookie, csrfIntegrationCSRFKey, legacyToken)

	server := httptest.NewTLSServer(router)
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 10 * time.Second

	for name, token := range map[string]string{
		"legacy verifier": legacyToken,
		"stable derived":  session.csrf,
	} {
		t.Run(name+" before discovery convergence", func(t *testing.T) {
			response := performCSRFIntegrationHTTPRequest(
				client, server.URL, session.cookie, http.MethodPost, "/api/v1/goal-drafts",
				contractIntegrationOrigin, token, session.userID, `{"initialBody":"legacy rollout"}`,
			)
			assertCSRFIntegrationStatus(t, response, http.StatusCreated, "")
		})
	}

	refreshed := performCSRFIntegrationHTTPRequest(
		client, server.URL, session.cookie, http.MethodGet, "/api/v1/session", "", "", "", "",
	)
	assertCSRFIntegrationStatus(t, refreshed, http.StatusOK, "")
	view := decodeCSRFIntegrationSession(t, refreshed.body)
	if view.CSRFToken != session.csrf {
		t.Fatal("GET /session did not converge to the bootstrap stable CSRF token")
	}
	assertCSRFVerifierForCookie(t, pool, session.cookie, csrfIntegrationCSRFKey, view.CSRFToken)

	legacy := performCSRFIntegrationHTTPRequest(
		client, server.URL, session.cookie, http.MethodPost, "/api/v1/goal-drafts",
		contractIntegrationOrigin, legacyToken, session.userID, `{"initialBody":"stale legacy"}`,
	)
	assertCSRFIntegrationStatus(t, legacy, http.StatusForbidden, "CSRF_INVALID")
	stable := performCSRFIntegrationHTTPRequest(
		client, server.URL, session.cookie, http.MethodPost, "/api/v1/goal-drafts",
		contractIntegrationOrigin, view.CSRFToken, session.userID, `{"initialBody":"stable"}`,
	)
	assertCSRFIntegrationStatus(t, stable, http.StatusCreated, "")
}

func TestSessionCSRFRejectsInvalidTokenAndOriginBeforeUnsafeUseCase(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	spaces := &csrfIntegrationWorkspace{}
	router := newCSRFIntegrationRouter(pool, spaces, csrfIntegrationCSRFKey, false)
	session := bootstrapContractClient(t, router, "0198c20b-7b95-7000-8000-000000000093")
	server := httptest.NewTLSServer(router)
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 10 * time.Second
	differentWellFormedToken := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xa5}, 32))

	tests := []struct {
		name, origin, token string
	}{
		{name: "missing token", origin: contractIntegrationOrigin},
		{name: "malformed token", origin: contractIntegrationOrigin, token: "not-base64url"},
		{name: "different well-formed token", origin: contractIntegrationOrigin, token: differentWellFormedToken},
		{name: "missing origin", token: session.csrf},
		{name: "different origin", origin: "https://attacker.integration.test", token: session.csrf},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performCSRFIntegrationHTTPRequest(
				client, server.URL, session.cookie, http.MethodPost, "/api/v1/goal-drafts",
				test.origin, test.token, session.userID, `{"initialBody":"must not run"}`,
			)
			assertCSRFIntegrationStatus(t, response, http.StatusForbidden, "CSRF_INVALID")
		})
	}
	if spaces.calls() != 0 {
		t.Fatalf("CreateDraft calls after CSRF rejections = %d, want 0", spaces.calls())
	}
}

func TestSessionCSRFRejectsRevokedAndExpiredSessionsBeforeUnsafeUseCase(t *testing.T) {
	tests := []struct {
		name   string
		update string
	}{
		{name: "revoked", update: `UPDATE sessions SET revoked_at=$2 WHERE token_hash=$1`},
		{name: "idle expired", update: `UPDATE sessions SET idle_expires_at=$2 WHERE token_hash=$1`},
		{name: "absolute expired", update: `UPDATE sessions SET absolute_expires_at=$2 WHERE token_hash=$1`},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := integrationPool(t)
			resetDatabase(t, pool)
			spaces := &csrfIntegrationWorkspace{}
			router := newCSRFIntegrationRouter(pool, spaces, csrfIntegrationCSRFKey, false)
			session := bootstrapContractClient(
				t, router, fmt.Sprintf("0198c20b-7b95-7000-8000-%012d", 94+index),
			)
			tokenHash := securehash.HMACSHA256([]byte(csrfIntegrationSessionKey), []byte(session.cookie.Value))
			result, err := pool.Exec(context.Background(), test.update, tokenHash, integrationNow())
			if err != nil {
				t.Fatal(err)
			}
			if result.RowsAffected() != 1 {
				t.Fatalf("updated Session rows = %d, want 1", result.RowsAffected())
			}

			server := httptest.NewTLSServer(router)
			t.Cleanup(server.Close)
			client := server.Client()
			client.Timeout = 10 * time.Second
			response := performCSRFIntegrationHTTPRequest(
				client, server.URL, session.cookie, http.MethodPost, "/api/v1/goal-drafts",
				contractIntegrationOrigin, session.csrf, session.userID, `{"initialBody":"must not run"}`,
			)
			assertCSRFIntegrationStatus(t, response, http.StatusUnauthorized, "SESSION_EXPIRED")
			if spaces.calls() != 0 {
				t.Fatalf("CreateDraft calls = %d, want 0", spaces.calls())
			}
		})
	}
}

func TestSessionCSRFRotationRevokesOldSessionAndBindsTokenToNewSession(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	spaces := &csrfIntegrationWorkspace{}
	router := newCSRFIntegrationRouter(pool, spaces, csrfIntegrationCSRFKey, true)
	oldSession := bootstrapContractClient(t, router, "0198c20b-7b95-7000-8000-000000000097")
	server := httptest.NewTLSServer(router)
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 10 * time.Second

	upgrade := performCSRFIntegrationHTTPRequest(
		client,
		server.URL,
		oldSession.cookie,
		http.MethodPost,
		"/api/v1/auth/google/upgrade",
		contractIntegrationOrigin,
		oldSession.csrf,
		oldSession.userID,
		`{"idToken":"test-google:csrf-session-rotation"}`,
	)
	assertCSRFIntegrationStatus(t, upgrade, http.StatusOK, "")
	newSessionView := decodeCSRFIntegrationSession(t, upgrade.body)
	newCookie := csrfIntegrationSessionCookie(upgrade.cookies)
	if newCookie == nil || newCookie.Value == "" || newCookie.Value == oldSession.cookie.Value {
		t.Fatal("Google upgrade did not rotate the Session cookie")
	}
	if newSessionView.User.ID != oldSession.userID || newSessionView.CSRFToken == "" || newSessionView.CSRFToken == oldSession.csrf {
		t.Fatal("Google upgrade did not bind a distinct CSRF token to the new Session")
	}

	oldCookie := performCSRFIntegrationHTTPRequest(
		client, server.URL, oldSession.cookie, http.MethodPost, "/api/v1/goal-drafts",
		contractIntegrationOrigin, oldSession.csrf, oldSession.userID, `{"initialBody":"old cookie"}`,
	)
	assertCSRFIntegrationStatus(t, oldCookie, http.StatusUnauthorized, "SESSION_EXPIRED")
	oldCSRF := performCSRFIntegrationHTTPRequest(
		client, server.URL, newCookie, http.MethodPost, "/api/v1/goal-drafts",
		contractIntegrationOrigin, oldSession.csrf, oldSession.userID, `{"initialBody":"old csrf"}`,
	)
	assertCSRFIntegrationStatus(t, oldCSRF, http.StatusForbidden, "CSRF_INVALID")
	newCSRF := performCSRFIntegrationHTTPRequest(
		client, server.URL, newCookie, http.MethodPost, "/api/v1/goal-drafts",
		contractIntegrationOrigin, newSessionView.CSRFToken, oldSession.userID, `{"initialBody":"new csrf"}`,
	)
	assertCSRFIntegrationStatus(t, newCSRF, http.StatusCreated, "")
	if spaces.calls() != 1 {
		t.Fatalf("CreateDraft calls = %d, want 1", spaces.calls())
	}
}

func TestSessionCSRFMaintenancePepperRotationRejectsOldAndConvergesToNewToken(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	spaces := &csrfIntegrationWorkspace{}
	oldRouter := newCSRFIntegrationRouter(pool, spaces, "integration-old-csrf-key", false)
	session := bootstrapContractClient(t, oldRouter, "0198c20b-7b95-7000-8000-000000000098")
	newRouter := newCSRFIntegrationRouter(pool, spaces, "integration-new-csrf-key", false)
	server := httptest.NewTLSServer(newRouter)
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 10 * time.Second

	oldToken := performCSRFIntegrationHTTPRequest(
		client, server.URL, session.cookie, http.MethodPost, "/api/v1/goal-drafts",
		contractIntegrationOrigin, session.csrf, session.userID, `{"initialBody":"old pepper"}`,
	)
	assertCSRFIntegrationStatus(t, oldToken, http.StatusForbidden, "CSRF_INVALID")
	refreshed := performCSRFIntegrationHTTPRequest(
		client, server.URL, session.cookie, http.MethodGet, "/api/v1/session", "", "", "", "",
	)
	assertCSRFIntegrationStatus(t, refreshed, http.StatusOK, "")
	newSession := decodeCSRFIntegrationSession(t, refreshed.body)
	if newSession.CSRFToken == "" || newSession.CSRFToken == session.csrf {
		t.Fatal("CSRF token did not change across maintenance pepper rotation")
	}
	newToken := performCSRFIntegrationHTTPRequest(
		client, server.URL, session.cookie, http.MethodPost, "/api/v1/goal-drafts",
		contractIntegrationOrigin, newSession.CSRFToken, session.userID, `{"initialBody":"new pepper"}`,
	)
	assertCSRFIntegrationStatus(t, newToken, http.StatusCreated, "")
}

func newCSRFIntegrationRouter(pool *pgxpool.Pool, spaces httpapi.WorkspaceService, csrfKey string, includeAccount bool) http.Handler {
	random := system.RandomGenerator{}
	clock := contractIntegrationClock{now: integrationNow()}
	sessions := appsession.NewService(
		NewSessionRepository(pool), clock, random, random, system.AllowAnonymous{},
		appsession.Settings{
			SessionHashKey:     []byte(csrfIntegrationSessionKey),
			CSRFHashKey:        []byte(csrfKey),
			BootstrapHashKey:   []byte("integration-bootstrap-key"),
			IdleTTL:            30 * 24 * time.Hour,
			AbsoluteTTL:        180 * 24 * time.Hour,
			ActivityTouchAfter: 15 * time.Minute,
			BootstrapTTL:       10 * time.Minute,
		},
	)
	dependencies := httpapi.Dependencies{
		Sessions: sessions, Workspace: spaces, PublicOrigin: contractIntegrationOrigin,
	}
	if includeAccount {
		dependencies.Account = account.NewService(
			NewAccountRepository(pool), googleidentity.FakeVerifier{}, clock, random, random,
			account.Settings{
				SessionHashKey: []byte(csrfIntegrationSessionKey),
				CSRFHashKey:    []byte(csrfKey),
				IdleTTL:        30 * 24 * time.Hour,
				AbsoluteTTL:    180 * 24 * time.Hour,
			},
		)
	}
	return httpapi.NewRouter(dependencies)
}

func performCSRFIntegrationHTTPRequest(
	client *http.Client,
	baseURL string,
	cookie *http.Cookie,
	method, path, origin, csrfToken, expectedUserID, body string,
) csrfIntegrationHTTPResponse {
	request, err := http.NewRequest(method, baseURL+path, strings.NewReader(body))
	if err != nil {
		return csrfIntegrationHTTPResponse{err: err}
	}
	request.Header.Set("X-Request-ID", contractIntegrationRequestID)
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if csrfToken != "" {
		request.Header.Set("X-CSRF-Token", csrfToken)
	}
	if expectedUserID != "" {
		request.Header.Set("X-Fukamu-Expected-User-ID", expectedUserID)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response, err := client.Do(request)
	if err != nil {
		return csrfIntegrationHTTPResponse{err: err}
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	return csrfIntegrationHTTPResponse{
		status: response.StatusCode, body: responseBody, cookies: response.Cookies(), err: err,
	}
}

func decodeCSRFIntegrationSession(t *testing.T, body []byte) csrfIntegrationSessionResponse {
	t.Helper()
	var response csrfIntegrationSessionResponse
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode Session response: %v", err)
	}
	return response
}

func assertCSRFIntegrationStatus(t *testing.T, response csrfIntegrationHTTPResponse, wantStatus int, wantCode string) {
	t.Helper()
	if response.err != nil || response.status != wantStatus {
		t.Fatalf("HTTP response = status %d, error %v; want %d", response.status, response.err, wantStatus)
	}
	if wantCode == "" {
		return
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.body, &envelope); err != nil || envelope.Error.Code != wantCode {
		t.Fatalf("error response = %#v, decode error = %v; want %s", envelope, err, wantCode)
	}
}

func csrfIntegrationSessionCookie(cookies []*http.Cookie) *http.Cookie {
	for _, cookie := range cookies {
		if cookie.Name == contractIntegrationCookieName {
			return cookie
		}
	}
	return nil
}

func setCSRFVerifierForCookie(t *testing.T, pool *pgxpool.Pool, cookie *http.Cookie, csrfKey, token string) {
	t.Helper()
	tokenHash := securehash.HMACSHA256([]byte(csrfIntegrationSessionKey), []byte(cookie.Value))
	verifier := securehash.HMACSHA256([]byte(csrfKey), []byte(token))
	result, err := pool.Exec(context.Background(), `UPDATE sessions SET csrf_token_hash=$2 WHERE token_hash=$1`, tokenHash, verifier)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsAffected() != 1 {
		t.Fatalf("updated Session rows = %d, want 1", result.RowsAffected())
	}
}

func assertCSRFVerifierForCookie(t *testing.T, pool *pgxpool.Pool, cookie *http.Cookie, csrfKey, token string) {
	t.Helper()
	tokenHash := securehash.HMACSHA256([]byte(csrfIntegrationSessionKey), []byte(cookie.Value))
	var stored []byte
	if err := pool.QueryRow(context.Background(), `SELECT csrf_token_hash FROM sessions WHERE token_hash=$1`, tokenHash).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	want := securehash.HMACSHA256([]byte(csrfKey), []byte(token))
	if !bytes.Equal(stored, want) {
		t.Fatal("stored CSRF verifier does not match the converged token")
	}
}
