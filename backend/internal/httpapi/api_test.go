package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/application/account"
	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

const (
	testOrigin  = "https://pdcai.example"
	testUserID  = "00000000-0000-4000-8000-000000000001"
	testCycleID = "00000000-0000-4000-8000-000000000002"
)

func TestAnonymousBootstrapSetsSecureOpaqueCookie(t *testing.T) {
	t.Parallel()

	sessions := &fakeSessionService{created: appsession.View{
		UserID: user.ID(testUserID), ActiveCycleID: testCycleID, CSRFToken: "csrf-plain", SessionToken: "session-plain",
	}}
	router := NewRouter(Dependencies{Sessions: sessions, Cycles: &fakeCycleService{}, PublicOrigin: testOrigin})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/session/anonymous", strings.NewReader(`{
        "bootstrapId":"c683d6a9-6c10-44a0-b673-55b0ff3e6594",
        "turnstileToken":"test"
    }`))
	request.Header.Set("Origin", testOrigin)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != sessionCookieName || cookies[0].Value != "session-plain" || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookies = %#v", cookies)
	}
	if strings.Contains(response.Body.String(), "session-plain") || !strings.Contains(response.Body.String(), `"csrfToken":"csrf-plain"`) {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestUnsafeCycleRequestRequiresOriginAndCSRF(t *testing.T) {
	t.Parallel()

	sessions := &fakeSessionService{authenticated: appsession.AuthenticatedSession{ID: "session", UserID: user.ID(testUserID)}}
	cycles := &fakeCycleService{}
	router := NewRouter(Dependencies{Sessions: sessions, Cycles: cycles, PublicOrigin: testOrigin})
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/cycles/"+testCycleID+"/frames/plan", strings.NewReader(`{"content":"plan","expectedFrameRevision":0}`))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "session"})
	request.Header.Set("Origin", testOrigin)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "CSRF_INVALID") || cycles.saved {
		t.Fatalf("status/body/saved = %d/%s/%v", response.Code, response.Body.String(), cycles.saved)
	}
}

func TestSaveFrameUsesAuthenticatedUser(t *testing.T) {
	t.Parallel()

	sessions := &fakeSessionService{authenticated: appsession.AuthenticatedSession{ID: "session", UserID: user.ID(testUserID)}}
	cycles := &fakeCycleService{}
	router := NewRouter(Dependencies{Sessions: sessions, Cycles: cycles, PublicOrigin: testOrigin})
	request := httptest.NewRequest(http.MethodPatch, "/api/v1/cycles/"+testCycleID+"/frames/plan", strings.NewReader(`{"content":"plan","expectedFrameRevision":0}`))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "session"})
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("X-CSRF-Token", "valid-csrf")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK || !cycles.saved || cycles.savedUser != user.ID(testUserID) {
		t.Fatalf("status/body/user = %d/%s/%s", response.Code, response.Body.String(), cycles.savedUser)
	}
}

func TestGenerateActionRequiresIdempotencyAndUsesAuthenticatedScope(t *testing.T) {
	t.Parallel()
	sessions := &fakeSessionService{authenticated: appsession.AuthenticatedSession{ID: "session-id", UserID: user.ID(testUserID)}}
	generate := &fakeGenerateActionService{result: appai.Result{
		GenerationID: "00000000-0000-4000-8000-000000000010", Action: "1. 次の行動",
		ContentRevision: 4, ActionRevision: 1,
	}}
	router := NewRouter(Dependencies{
		Sessions: sessions, Cycles: &fakeCycleService{}, PublicOrigin: testOrigin,
		GenerateAction: generate, RefineAction: &fakeRefineActionService{},
	})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/cycles/"+testCycleID+"/actions/generate", strings.NewReader(`{"expectedContentRevision":3,"confirmReplace":false}`))
	request.RemoteAddr = "192.0.2.10:4321"
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "session"})
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("X-CSRF-Token", "valid-csrf")
	request.Header.Set("Idempotency-Key", "00000000-0000-4000-8000-000000000008")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK || generate.command.UserID != user.ID(testUserID) ||
		generate.command.Scope.SessionID != "session-id" || generate.command.Scope.IP != "192.0.2.10" ||
		!strings.Contains(response.Body.String(), `"action":"1. 次の行動"`) {
		t.Fatalf("status/body/command = %d/%s/%#v", response.Code, response.Body.String(), generate.command)
	}
}

func TestGenerateActionMapsBudgetFailure(t *testing.T) {
	t.Parallel()
	sessions := &fakeSessionService{authenticated: appsession.AuthenticatedSession{ID: "session-id", UserID: user.ID(testUserID)}}
	router := NewRouter(Dependencies{
		Sessions: sessions, Cycles: &fakeCycleService{}, PublicOrigin: testOrigin,
		GenerateAction: &fakeGenerateActionService{err: appai.ErrServiceBudget}, RefineAction: &fakeRefineActionService{},
	})
	request := httptest.NewRequest(http.MethodPost, "/api/v1/cycles/"+testCycleID+"/actions/generate", strings.NewReader(`{"expectedContentRevision":3,"confirmReplace":false}`))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "session"})
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("X-CSRF-Token", "valid-csrf")
	request.Header.Set("Idempotency-Key", "00000000-0000-4000-8000-000000000008")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "AI_SERVICE_BUDGET_EXCEEDED") {
		t.Fatalf("status/body = %d/%s", response.Code, response.Body.String())
	}
}

func TestAccountDeleteExpiresCookieOnlyAfterConfirmedSuccess(t *testing.T) {
	t.Parallel()
	sessions := &fakeSessionService{authenticated: appsession.AuthenticatedSession{ID: "session-id", UserID: user.ID(testUserID)}}
	accounts := &fakeAccountService{}
	router := NewRouter(Dependencies{Sessions: sessions, Cycles: &fakeCycleService{}, Account: accounts, PublicOrigin: testOrigin})
	request := httptest.NewRequest(http.MethodDelete, "/api/v1/account", strings.NewReader(`{"confirmed":true}`))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "session"})
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("X-CSRF-Token", "valid-csrf")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || !accounts.confirmed {
		t.Fatalf("status/body/confirmed = %d/%s/%v", response.Code, response.Body.String(), accounts.confirmed)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != sessionCookieName || cookies[0].MaxAge >= 0 {
		t.Fatalf("cookies = %#v", cookies)
	}
}

func TestAccountDeleteFailureKeepsCookie(t *testing.T) {
	t.Parallel()
	sessions := &fakeSessionService{authenticated: appsession.AuthenticatedSession{ID: "session-id", UserID: user.ID(testUserID)}}
	accounts := &fakeAccountService{deleteErr: account.ErrAccountDeleteFailed}
	router := NewRouter(Dependencies{Sessions: sessions, Cycles: &fakeCycleService{}, Account: accounts, PublicOrigin: testOrigin})
	request := httptest.NewRequest(http.MethodDelete, "/api/v1/account", strings.NewReader(`{"confirmed":true}`))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "session"})
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("X-CSRF-Token", "valid-csrf")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || response.Header().Get("Set-Cookie") != "" {
		t.Fatalf("status/cookie/body = %d/%q/%s", response.Code, response.Header().Get("Set-Cookie"), response.Body.String())
	}
}

type fakeSessionService struct {
	authenticated appsession.AuthenticatedSession
	created       appsession.View
}

func (service *fakeSessionService) Authenticate(context.Context, string) (appsession.AuthenticatedSession, error) {
	if service.authenticated.ID == "" {
		return appsession.AuthenticatedSession{}, appsession.ErrSessionExpired
	}
	return service.authenticated, nil
}

func (service *fakeSessionService) Refresh(context.Context, string) (appsession.View, error) {
	return appsession.View{}, appsession.ErrSessionExpired
}

func (service *fakeSessionService) CreateAnonymous(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
	return service.created, nil
}

func (service *fakeSessionService) VerifyCSRF(_ appsession.AuthenticatedSession, token string) error {
	if token != "valid-csrf" {
		return appsession.ErrCSRFInvalid
	}
	return nil
}

type fakeCycleService struct {
	saved     bool
	savedUser user.ID
}

type fakeGenerateActionService struct {
	command appai.GenerateCommand
	result  appai.Result
	err     error
}

func (service *fakeGenerateActionService) Execute(_ context.Context, command appai.GenerateCommand) (appai.Result, error) {
	service.command = command
	return service.result, service.err
}

type fakeRefineActionService struct{}

func (*fakeRefineActionService) Execute(context.Context, appai.RefineCommand) (appai.Result, error) {
	return appai.Result{}, errors.New("not implemented")
}

type fakeAccountService struct {
	confirmed bool
	deleteErr error
}

func (*fakeAccountService) UpgradeGoogle(context.Context, user.ID, string, string) (account.View, error) {
	return account.View{}, errors.New("not implemented")
}

func (*fakeAccountService) LoginGoogle(context.Context, string, string) (account.View, error) {
	return account.View{}, errors.New("not implemented")
}

func (service *fakeAccountService) Delete(_ context.Context, _ user.ID, confirmed bool) error {
	service.confirmed = confirmed
	return service.deleteErr
}

func (service *fakeCycleService) GetActive(context.Context, user.ID) (domaincycle.PDCACycle, error) {
	return domaincycle.PDCACycle{}, nil
}

func (service *fakeCycleService) SaveFrame(_ context.Context, userID user.ID, cycleID domaincycle.ID, frame domaincycle.Frame, content string, _ int64) (domaincycle.SaveFrameResult, error) {
	service.saved = true
	service.savedUser = userID
	return domaincycle.SaveFrameResult{
		Cycle: domaincycle.PDCACycle{
			ID: cycleID, Plan: content, PlanRevision: 1, ContentRevision: 1,
		},
		Frame: frame, SavedAt: time.Date(2026, time.August, 16, 0, 0, 0, 0, time.UTC),
	}, nil
}

func (service *fakeCycleService) Complete(context.Context, user.ID, domaincycle.ID, domaincycle.OperationID, int64) (domaincycle.CompleteResult, error) {
	return domaincycle.CompleteResult{}, errors.New("not implemented")
}

func (service *fakeCycleService) GetCompleted(context.Context, user.ID, domaincycle.ID) (domaincycle.PDCACycle, error) {
	return domaincycle.PDCACycle{}, errors.New("not implemented")
}

func (service *fakeCycleService) ListCompleted(context.Context, user.ID, string, int) (appcycle.CompletedPage, error) {
	return appcycle.CompletedPage{}, nil
}
