package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
        "recaptchaToken":"test"
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
