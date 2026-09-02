package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type anonymousMetricSessions struct {
	refresh func(context.Context, string) (appsession.View, error)
	create  func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error)
}

func (*anonymousMetricSessions) Authenticate(context.Context, string) (appsession.AuthenticatedSession, error) {
	panic("unexpected Authenticate call")
}

func (sessions *anonymousMetricSessions) Refresh(ctx context.Context, token string) (appsession.View, error) {
	if sessions.refresh == nil {
		return appsession.View{}, errors.New("session not found")
	}
	return sessions.refresh(ctx, token)
}

func (sessions *anonymousMetricSessions) CreateAnonymous(ctx context.Context, input appsession.CreateAnonymousInput) (appsession.View, error) {
	if sessions.create == nil {
		panic("unexpected CreateAnonymous call")
	}
	return sessions.create(ctx, input)
}

func (*anonymousMetricSessions) VerifyCSRF(appsession.AuthenticatedSession, string) error {
	panic("unexpected VerifyCSRF call")
}

type anonymousMetricRecorder struct {
	Metrics
	results    []string
	errorCodes []string
}

func (metrics *anonymousMetricRecorder) AnonymousCreate(_ context.Context, result string) {
	metrics.results = append(metrics.results, result)
}

func (metrics *anonymousMetricRecorder) ErrorCode(_ context.Context, code string) {
	metrics.errorCodes = append(metrics.errorCodes, code)
}

func TestAnonymousCreateMetricDistinguishesFreshCookieReuseAndDatabaseReplay(t *testing.T) {
	t.Parallel()
	const (
		origin       = "https://app.example.test"
		bootstrapID  = "0198c20b-7b95-7000-8000-000000000001"
		sessionToken = "session-token"
	)
	tests := []struct {
		name       string
		view       appsession.View
		cookie     bool
		wantStatus int
		wantResult string
	}{
		{
			name: "fresh", view: appsession.View{UserID: user.ID(bootstrapID), SessionToken: sessionToken, Created: true},
			wantStatus: http.StatusCreated, wantResult: "success",
		},
		{
			name: "database replay", view: appsession.View{UserID: user.ID(bootstrapID), SessionToken: sessionToken},
			wantStatus: http.StatusCreated, wantResult: "idempotent",
		},
		{
			name: "cookie reuse", view: appsession.View{UserID: user.ID(bootstrapID), SessionToken: sessionToken},
			cookie: true, wantStatus: http.StatusOK, wantResult: "idempotent",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metrics := &anonymousMetricRecorder{}
			sessions := &anonymousMetricSessions{}
			if test.cookie {
				sessions.refresh = func(context.Context, string) (appsession.View, error) { return test.view, nil }
			} else {
				sessions.create = func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) { return test.view, nil }
			}
			server := &api{
				dependencies: Dependencies{Sessions: sessions, PublicOrigin: origin, Metrics: metrics},
			}
			request := httptest.NewRequest(http.MethodPost, "/api/v1/session/anonymous",
				strings.NewReader(`{"bootstrapId":"`+bootstrapID+`","turnstileToken":"token"}`))
			request.Header.Set("Origin", origin)
			if test.cookie {
				request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
			}
			response := httptest.NewRecorder()
			server.createAnonymous(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status/body = %d/%s", response.Code, response.Body.String())
			}
			if len(metrics.results) != 1 || metrics.results[0] != test.wantResult {
				t.Fatalf("anonymous metrics = %#v, want %q", metrics.results, test.wantResult)
			}
			if strings.Contains(response.Body.String(), "created") || strings.Contains(response.Body.String(), "replayed") {
				t.Fatalf("internal replay classification reached wire: %s", response.Body.String())
			}
		})
	}
}

func TestAnonymousCreateRefreshFallbackOnlyHandlesInvalidSessionErrors(t *testing.T) {
	t.Parallel()
	const (
		origin       = "https://app.example.test"
		bootstrapID  = "0198c20b-7b95-7000-8000-000000000001"
		sessionToken = "session-token"
	)
	tests := []struct {
		name           string
		refreshErr     error
		wantStatus     int
		wantResult     string
		wantErrorCodes []string
		wantCreate     bool
		wantSetCookie  bool
	}{
		{
			name: "expired", refreshErr: appsession.ErrSessionExpired,
			wantStatus: http.StatusCreated, wantResult: "success", wantCreate: true, wantSetCookie: true,
		},
		{
			name: "missing", refreshErr: appsession.ErrSessionMissing,
			wantStatus: http.StatusCreated, wantResult: "success", wantCreate: true, wantSetCookie: true,
		},
		{
			name: "unexpected", refreshErr: errors.New("session storage unavailable"),
			wantStatus: http.StatusInternalServerError, wantResult: "failure", wantErrorCodes: []string{"INTERNAL_ERROR"},
		},
		{
			name: "known non-fallback error", refreshErr: appsession.ErrCSRFInvalid,
			wantStatus: http.StatusInternalServerError, wantResult: "failure", wantErrorCodes: []string{"INTERNAL_ERROR"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metrics := &anonymousMetricRecorder{}
			createCalls := 0
			sessions := &anonymousMetricSessions{
				refresh: func(context.Context, string) (appsession.View, error) {
					return appsession.View{}, test.refreshErr
				},
				create: func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
					createCalls++
					return appsession.View{UserID: user.ID(bootstrapID), SessionToken: "replacement-token", Created: true}, nil
				},
			}
			server := &api{dependencies: Dependencies{Sessions: sessions, PublicOrigin: origin, Metrics: metrics}}
			request := httptest.NewRequest(http.MethodPost, "/api/v1/session/anonymous",
				strings.NewReader(`{"bootstrapId":"`+bootstrapID+`","turnstileToken":"token"}`))
			request.Header.Set("Origin", origin)
			request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
			response := httptest.NewRecorder()

			server.createAnonymous(response, request)

			if response.Code != test.wantStatus {
				t.Fatalf("status/body = %d/%s", response.Code, response.Body.String())
			}
			wantCreateCalls := 0
			if test.wantCreate {
				wantCreateCalls = 1
			}
			if createCalls != wantCreateCalls {
				t.Fatalf("CreateAnonymous calls = %d, want %d", createCalls, wantCreateCalls)
			}
			if len(metrics.results) != 1 || metrics.results[0] != test.wantResult {
				t.Fatalf("anonymous metrics = %#v, want %q", metrics.results, test.wantResult)
			}
			if !equalStrings(metrics.errorCodes, test.wantErrorCodes) {
				t.Fatalf("error code metrics = %#v, want %#v", metrics.errorCodes, test.wantErrorCodes)
			}
			if got := len(response.Result().Cookies()) > 0; got != test.wantSetCookie {
				t.Fatalf("Set-Cookie present = %t, want %t", got, test.wantSetCookie)
			}
		})
	}
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
