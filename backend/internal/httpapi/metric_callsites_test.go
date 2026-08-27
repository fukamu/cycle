package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/fukamu/cycle/backend/internal/application/account"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type httpMetricCall struct {
	route    string
	status   int
	duration time.Duration
}

type autosaveMetricCall struct {
	resourceType string
	result       string
	duration     time.Duration
}

type metricCallRecorder struct {
	Metrics
	httpCalls      []httpMetricCall
	autosaves      []autosaveMetricCall
	accountUpgrade []string
	googleLogin    []string
	accountDelete  []string
	errorCodes     []string
	isolation      int
}

func (metrics *metricCallRecorder) ObserveHTTP(_ context.Context, route string, status int, duration time.Duration) {
	metrics.httpCalls = append(metrics.httpCalls, httpMetricCall{route: route, status: status, duration: duration})
}

func (metrics *metricCallRecorder) ObserveAutosave(_ context.Context, resourceType, result string, duration time.Duration) {
	metrics.autosaves = append(metrics.autosaves, autosaveMetricCall{resourceType: resourceType, result: result, duration: duration})
}

func (metrics *metricCallRecorder) AccountUpgrade(_ context.Context, result string) {
	metrics.accountUpgrade = append(metrics.accountUpgrade, result)
}

func (metrics *metricCallRecorder) GoogleLogin(_ context.Context, result string) {
	metrics.googleLogin = append(metrics.googleLogin, result)
}

func (metrics *metricCallRecorder) AccountDelete(_ context.Context, result string) {
	metrics.accountDelete = append(metrics.accountDelete, result)
}

func (metrics *metricCallRecorder) ErrorCode(_ context.Context, code string) {
	metrics.errorCodes = append(metrics.errorCodes, code)
}

func (metrics *metricCallRecorder) AIContextIsolationViolation(context.Context) {
	metrics.isolation++
}

type metricWorkspaceService struct {
	WorkspaceService
	saveDraftErr  error
	saveReviewErr error
	saveFrameErr  error
}

func (service *metricWorkspaceService) SaveDraft(context.Context, string, string, string, int64) (workspace.DraftView, error) {
	return workspace.DraftView{}, service.saveDraftErr
}

func (service *metricWorkspaceService) SaveReview(context.Context, string, string, string, string, int64) (workspace.DraftView, error) {
	return workspace.DraftView{}, service.saveReviewErr
}

func (service *metricWorkspaceService) SaveFrame(context.Context, workspace.SaveFrameInput) (workspace.SaveFrameResult, error) {
	return workspace.SaveFrameResult{}, service.saveFrameErr
}

type metricAccountService struct {
	upgradeErr error
	loginErr   error
	deleteErr  error
}

func (service *metricAccountService) UpgradeGoogle(context.Context, user.ID, string, string) (account.View, error) {
	return account.View{SessionToken: "session"}, service.upgradeErr
}

func (service *metricAccountService) LoginGoogle(context.Context, string, string) (account.View, error) {
	return account.View{SessionToken: "session"}, service.loginErr
}

func (service *metricAccountService) Delete(context.Context, user.ID, bool) error {
	return service.deleteErr
}

func metricHandlerRequest(method, target, body string, params map[string]string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	routeContext := chi.NewRouteContext()
	for key, value := range params {
		routeContext.URLParams.Add(key, value)
	}
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, routeContext)
	ctx = context.WithValue(ctx, sessionContextKey, appsession.AuthenticatedSession{
		ID:     "10000000-0000-7000-8000-000000000001",
		UserID: user.ID("20000000-0000-7000-8000-000000000001"),
	})
	return request.WithContext(ctx)
}

func TestRequestLogMiddlewareObservesHTTPExactlyOnce(t *testing.T) {
	t.Parallel()
	metrics := &metricCallRecorder{}
	server := &api{dependencies: Dependencies{Metrics: metrics}}
	router := chi.NewRouter()
	router.Use(server.requestLogMiddleware)
	router.Get("/goals/{goalId}", func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/goals/opaque", nil))
	if len(metrics.httpCalls) != 1 || metrics.httpCalls[0].route != "/goals/{goalId}" ||
		metrics.httpCalls[0].status != http.StatusNoContent || metrics.httpCalls[0].duration < 0 {
		t.Fatalf("HTTP metric calls = %#v", metrics.httpCalls)
	}
}

func TestAutosaveMetricsRunOnceAtAllProductionHandlers(t *testing.T) {
	t.Parallel()
	const objectID = "30000000-0000-7000-8000-000000000001"
	genericFailure := errors.New("save failed")
	tests := []struct {
		name         string
		resourceType string
		result       string
		configure    func(*metricWorkspaceService)
		invoke       func(*api, http.ResponseWriter, *http.Request)
		body         string
		params       map[string]string
	}{
		{
			name: "creation success", resourceType: "creation_draft", result: "success",
			invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.saveGoalDraft(writer, request)
			},
			body: `{"body":"goal","expectedRevision":1}`, params: map[string]string{"draftId": objectID},
		},
		{
			name: "creation failure", resourceType: "creation_draft", result: "failure",
			configure: func(service *metricWorkspaceService) { service.saveDraftErr = genericFailure },
			invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.saveGoalDraft(writer, request)
			},
			body: `{"body":"goal","expectedRevision":1}`, params: map[string]string{"draftId": objectID},
		},
		{
			name: "review conflict", resourceType: "review_draft", result: "conflict",
			configure: func(service *metricWorkspaceService) { service.saveReviewErr = workspace.ErrReviewRevisionConflict },
			invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.saveGoalReview(writer, request)
			},
			body:   `{"body":"review","expectedReviewDraftId":"` + objectID + `","expectedRevision":1}`,
			params: map[string]string{"goalId": objectID},
		},
		{
			name: "cycle frame conflict", resourceType: "cycle_frame", result: "conflict",
			configure: func(service *metricWorkspaceService) { service.saveFrameErr = cycle.ErrRevisionConflict },
			invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.saveGoalCycleFrame(writer, request)
			},
			body:   `{"content":"plan","expectedFrameRevision":1}`,
			params: map[string]string{"goalId": objectID, "cycleId": objectID, "frame": "plan"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			spaces := &metricWorkspaceService{}
			if test.configure != nil {
				test.configure(spaces)
			}
			metrics := &metricCallRecorder{}
			server := &api{dependencies: Dependencies{Workspace: spaces, Metrics: metrics}}
			response := httptest.NewRecorder()
			test.invoke(server, response, metricHandlerRequest(http.MethodPatch, "/", test.body, test.params))
			if len(metrics.autosaves) != 1 || metrics.autosaves[0].resourceType != test.resourceType ||
				metrics.autosaves[0].result != test.result || metrics.autosaves[0].duration < 0 {
				t.Fatalf("autosave calls = %#v", metrics.autosaves)
			}
		})
	}
}

func TestAccountHandlerMetricsRecordOneDurableResult(t *testing.T) {
	t.Parallel()
	failure := errors.New("operation failed")
	tests := []struct {
		name       string
		configure  func(*metricAccountService)
		invoke     func(*api, http.ResponseWriter, *http.Request)
		body       string
		metric     func(*metricCallRecorder) []string
		wantResult string
	}{
		{
			name: "upgrade success", invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.upgradeGoogle(writer, request)
			},
			body: `{"idToken":"token"}`, metric: func(metrics *metricCallRecorder) []string { return metrics.accountUpgrade }, wantResult: "success",
		},
		{
			name: "upgrade failure", configure: func(service *metricAccountService) { service.upgradeErr = failure },
			invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.upgradeGoogle(writer, request)
			},
			body: `{"idToken":"token"}`, metric: func(metrics *metricCallRecorder) []string { return metrics.accountUpgrade }, wantResult: "failure",
		},
		{
			name: "login success", invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.loginGoogle(writer, request)
			},
			body: `{"idToken":"token"}`, metric: func(metrics *metricCallRecorder) []string { return metrics.googleLogin }, wantResult: "success",
		},
		{
			name: "login failure", configure: func(service *metricAccountService) { service.loginErr = failure },
			invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.loginGoogle(writer, request)
			},
			body: `{"idToken":"token"}`, metric: func(metrics *metricCallRecorder) []string { return metrics.googleLogin }, wantResult: "failure",
		},
		{
			name: "delete success", invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.deleteAccount(writer, request)
			},
			body: `{"confirmed":true}`, metric: func(metrics *metricCallRecorder) []string { return metrics.accountDelete }, wantResult: "success",
		},
		{
			name: "delete failure", configure: func(service *metricAccountService) { service.deleteErr = failure },
			invoke: func(server *api, writer http.ResponseWriter, request *http.Request) {
				server.deleteAccount(writer, request)
			},
			body: `{"confirmed":true}`, metric: func(metrics *metricCallRecorder) []string { return metrics.accountDelete }, wantResult: "failure",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			accounts := &metricAccountService{}
			if test.configure != nil {
				test.configure(accounts)
			}
			metrics := &metricCallRecorder{}
			server := &api{dependencies: Dependencies{Account: accounts, Metrics: metrics}}
			response := httptest.NewRecorder()
			test.invoke(server, response, metricHandlerRequest(http.MethodPost, "/", test.body, nil))
			calls := test.metric(metrics)
			if len(calls) != 1 || calls[0] != test.wantResult {
				t.Fatalf("metric calls = %#v, want one %q", calls, test.wantResult)
			}
		})
	}
}

func TestWriteErrorRecordsCodeAndIsolationExactlyOnce(t *testing.T) {
	t.Parallel()
	metrics := &metricCallRecorder{}
	server := &api{dependencies: Dependencies{Metrics: metrics}}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	server.writeError(response, request, errors.Join(workspace.ErrAIContextIsolation, errors.New("internal detail")), nil)
	if metrics.isolation != 1 || len(metrics.errorCodes) != 1 || metrics.errorCodes[0] != "INTERNAL_ERROR" {
		t.Fatalf("isolation/error metrics = %d/%#v", metrics.isolation, metrics.errorCodes)
	}
}
