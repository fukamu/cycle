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
	results []string
}

func (metrics *anonymousMetricRecorder) AnonymousCreate(_ context.Context, result string) {
	metrics.results = append(metrics.results, result)
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
