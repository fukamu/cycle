package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/account"
	"github.com/fukamu/cycle/backend/internal/application/ports"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	"github.com/fukamu/cycle/backend/internal/httpapi"
)

const (
	contractOrigin               = "https://cycle.example.test"
	contractRequestID            = "0198c20b-7b95-7000-8000-000000000001"
	contractSessionID            = "10000000-0000-7000-8000-000000000001"
	contractUserID               = "20000000-0000-7000-8000-000000000001"
	contractOtherUserID          = "20000000-0000-7000-8000-000000000002"
	contractDraftID              = "30000000-0000-7000-8000-000000000001"
	contractReviewDraftID        = "31000000-0000-7000-8000-000000000001"
	contractGoalID               = "40000000-0000-7000-8000-000000000001"
	contractCycleID              = "50000000-0000-7000-8000-000000000001"
	contractGenerationID         = "60000000-0000-7000-8000-000000000001"
	contractOperationID          = "70000000-0000-7000-8000-000000000001"
	contractSessionToken         = "opaque-session-token"
	contractCSRFToken            = "opaque-csrf-token"
	contractCookieName           = "__Host-fukamu_cycle_session"
	contractUserIDHeader         = "X-Fukamu-Authenticated-User-ID"
	contractExpectedUserIDHeader = "X-Fukamu-Expected-User-ID"
)

type contractSessionStub struct {
	authenticate    func(context.Context, string) (appsession.AuthenticatedSession, error)
	refresh         func(context.Context, string) (appsession.View, error)
	createAnonymous func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error)
	verifyCSRF      func(appsession.AuthenticatedSession, string) error
}

func (stub *contractSessionStub) Authenticate(ctx context.Context, token string) (appsession.AuthenticatedSession, error) {
	if stub.authenticate == nil {
		panic("unexpected Authenticate call")
	}
	return stub.authenticate(ctx, token)
}

func (stub *contractSessionStub) Refresh(ctx context.Context, token string) (appsession.View, error) {
	if stub.refresh == nil {
		panic("unexpected Refresh call")
	}
	return stub.refresh(ctx, token)
}

func (stub *contractSessionStub) CreateAnonymous(ctx context.Context, input appsession.CreateAnonymousInput) (appsession.View, error) {
	if stub.createAnonymous == nil {
		panic("unexpected CreateAnonymous call")
	}
	return stub.createAnonymous(ctx, input)
}

func (stub *contractSessionStub) VerifyCSRF(record appsession.AuthenticatedSession, token string) error {
	if stub.verifyCSRF == nil {
		panic("unexpected VerifyCSRF call")
	}
	return stub.verifyCSRF(record, token)
}

type contractWorkspaceStub struct {
	httpapi.WorkspaceService
	home           func(context.Context, string) (workspace.HomeView, error)
	createDraft    func(context.Context, string, string) (workspace.DraftView, error)
	saveDraft      func(context.Context, string, string, string, int64) (workspace.DraftView, error)
	startGoal      func(context.Context, string, string, string, string, int64) (workspace.StartGoalResult, error)
	getGoal        func(context.Context, string, string) (workspace.GoalView, error)
	saveReview     func(context.Context, string, string, string, string, int64) (workspace.DraftView, error)
	saveFrame      func(context.Context, workspace.SaveFrameInput) (workspace.SaveFrameResult, error)
	refineGoal     func(context.Context, workspace.GoalRefineInput) (workspace.AIResponse, error)
	adoptGoal      func(context.Context, string, string, string, string, int64, *int64) (workspace.DraftView, error)
	continueReview func(context.Context, string, string, string, int64, int64) (workspace.ContinueReviewResult, error)
	deleteGoal     func(context.Context, string, string, bool, int64, string) error
	generateAction func(context.Context, workspace.ActionGenerateInput) (workspace.AIResponse, error)
	refineAction   func(context.Context, workspace.ActionRefineInput) (workspace.AIResponse, error)
	completeCycle  func(context.Context, workspace.CompleteCycleInput) (workspace.CompleteCycleResult, error)
	terminate      func(context.Context, workspace.TerminateInput) (workspace.TerminateResult, error)
}

func (stub *contractWorkspaceStub) Home(ctx context.Context, userID string) (workspace.HomeView, error) {
	if stub.home == nil {
		panic("unexpected Home call")
	}
	return stub.home(ctx, userID)
}

func (stub *contractWorkspaceStub) CreateDraft(ctx context.Context, userID, body string) (workspace.DraftView, error) {
	if stub.createDraft == nil {
		panic("unexpected CreateDraft call")
	}
	return stub.createDraft(ctx, userID, body)
}

func (stub *contractWorkspaceStub) SaveDraft(ctx context.Context, userID, draftID, body string, revision int64) (workspace.DraftView, error) {
	if stub.saveDraft == nil {
		panic("unexpected SaveDraft call")
	}
	return stub.saveDraft(ctx, userID, draftID, body, revision)
}

func (stub *contractWorkspaceStub) StartGoal(
	ctx context.Context,
	userID string,
	sessionID string,
	draftID string,
	operationID string,
	revision int64,
) (workspace.StartGoalResult, error) {
	if stub.startGoal == nil {
		panic("unexpected StartGoal call")
	}
	return stub.startGoal(ctx, userID, sessionID, draftID, operationID, revision)
}

func (stub *contractWorkspaceStub) GetGoal(ctx context.Context, userID, goalID string) (workspace.GoalView, error) {
	if stub.getGoal == nil {
		panic("unexpected GetGoal call")
	}
	return stub.getGoal(ctx, userID, goalID)
}

func (stub *contractWorkspaceStub) SaveReview(ctx context.Context, userID, goalID, expectedReviewDraftID, body string, revision int64) (workspace.DraftView, error) {
	if stub.saveReview == nil {
		panic("unexpected SaveReview call")
	}
	return stub.saveReview(ctx, userID, goalID, expectedReviewDraftID, body, revision)
}

func (stub *contractWorkspaceStub) SaveFrame(ctx context.Context, input workspace.SaveFrameInput) (workspace.SaveFrameResult, error) {
	if stub.saveFrame == nil {
		panic("unexpected SaveFrame call")
	}
	return stub.saveFrame(ctx, input)
}

func (stub *contractWorkspaceStub) RefineGoal(ctx context.Context, input workspace.GoalRefineInput) (workspace.AIResponse, error) {
	if stub.refineGoal == nil {
		panic("unexpected RefineGoal call")
	}
	return stub.refineGoal(ctx, input)
}

func (stub *contractWorkspaceStub) AdoptGoalSuggestion(
	ctx context.Context,
	userID string,
	draftID string,
	goalID string,
	generationID string,
	expectedDraftRevision int64,
	expectedGoalRevision *int64,
) (workspace.DraftView, error) {
	if stub.adoptGoal == nil {
		panic("unexpected AdoptGoalSuggestion call")
	}
	return stub.adoptGoal(ctx, userID, draftID, goalID, generationID, expectedDraftRevision, expectedGoalRevision)
}

func (stub *contractWorkspaceStub) ContinueReview(
	ctx context.Context,
	userID string,
	goalID string,
	operationID string,
	expectedGoalRevision int64,
	expectedDraftRevision int64,
) (workspace.ContinueReviewResult, error) {
	if stub.continueReview == nil {
		panic("unexpected ContinueReview call")
	}
	return stub.continueReview(ctx, userID, goalID, operationID, expectedGoalRevision, expectedDraftRevision)
}

func (stub *contractWorkspaceStub) DeleteGoal(
	ctx context.Context,
	userID string,
	goalID string,
	confirmed bool,
	expectedRevision int64,
	idempotencyKey string,
) error {
	if stub.deleteGoal == nil {
		panic("unexpected DeleteGoal call")
	}
	return stub.deleteGoal(ctx, userID, goalID, confirmed, expectedRevision, idempotencyKey)
}

func (stub *contractWorkspaceStub) GenerateAction(ctx context.Context, input workspace.ActionGenerateInput) (workspace.AIResponse, error) {
	if stub.generateAction == nil {
		panic("unexpected GenerateAction call")
	}
	return stub.generateAction(ctx, input)
}

func (stub *contractWorkspaceStub) RefineAction(ctx context.Context, input workspace.ActionRefineInput) (workspace.AIResponse, error) {
	if stub.refineAction == nil {
		panic("unexpected RefineAction call")
	}
	return stub.refineAction(ctx, input)
}

func (stub *contractWorkspaceStub) CompleteCycle(ctx context.Context, input workspace.CompleteCycleInput) (workspace.CompleteCycleResult, error) {
	if stub.completeCycle == nil {
		panic("unexpected CompleteCycle call")
	}
	return stub.completeCycle(ctx, input)
}

func (stub *contractWorkspaceStub) Terminate(ctx context.Context, input workspace.TerminateInput) (workspace.TerminateResult, error) {
	if stub.terminate == nil {
		panic("unexpected Terminate call")
	}
	return stub.terminate(ctx, input)
}

type contractAccountStub struct {
	upgrade func(context.Context, user.ID, string, string) (account.View, error)
	login   func(context.Context, string, string) (account.View, error)
	delete  func(context.Context, user.ID, bool) error
}

func (stub *contractAccountStub) UpgradeGoogle(ctx context.Context, userID user.ID, sessionID, token string) (account.View, error) {
	if stub.upgrade == nil {
		panic("unexpected UpgradeGoogle call")
	}
	return stub.upgrade(ctx, userID, sessionID, token)
}

func (stub *contractAccountStub) LoginGoogle(ctx context.Context, sessionID, token string) (account.View, error) {
	if stub.login == nil {
		panic("unexpected LoginGoogle call")
	}
	return stub.login(ctx, sessionID, token)
}

func (stub *contractAccountStub) Delete(ctx context.Context, userID user.ID, confirmed bool) error {
	if stub.delete == nil {
		panic("unexpected Delete call")
	}
	return stub.delete(ctx, userID, confirmed)
}

// requiredMemberWorkspaceProbe keeps the required-member tests black-box while
// making any handler-to-application call observable without duplicating a stub
// for every request shape.
type requiredMemberWorkspaceProbe struct {
	contractWorkspaceStub
	calls int
}

func (probe *requiredMemberWorkspaceProbe) CreateDraft(context.Context, string, string) (workspace.DraftView, error) {
	probe.calls++
	return workspace.DraftView{}, nil
}

func (probe *requiredMemberWorkspaceProbe) SaveDraft(context.Context, string, string, string, int64) (workspace.DraftView, error) {
	probe.calls++
	return workspace.DraftView{}, nil
}

func (probe *requiredMemberWorkspaceProbe) StartGoal(context.Context, string, string, string, string, int64) (workspace.StartGoalResult, error) {
	probe.calls++
	return workspace.StartGoalResult{}, nil
}

func (probe *requiredMemberWorkspaceProbe) RefineGoal(context.Context, workspace.GoalRefineInput) (workspace.AIResponse, error) {
	probe.calls++
	return workspace.AIResponse{}, nil
}

func (probe *requiredMemberWorkspaceProbe) AdoptGoalSuggestion(context.Context, string, string, string, string, int64, *int64) (workspace.DraftView, error) {
	probe.calls++
	return workspace.DraftView{}, nil
}

func (probe *requiredMemberWorkspaceProbe) SaveReview(context.Context, string, string, string, string, int64) (workspace.DraftView, error) {
	probe.calls++
	return workspace.DraftView{}, nil
}

func (probe *requiredMemberWorkspaceProbe) ContinueReview(context.Context, string, string, string, int64, int64) (workspace.ContinueReviewResult, error) {
	probe.calls++
	return workspace.ContinueReviewResult{}, nil
}

func (probe *requiredMemberWorkspaceProbe) DeleteGoal(context.Context, string, string, bool, int64, string) error {
	probe.calls++
	return nil
}

func (probe *requiredMemberWorkspaceProbe) SaveFrame(context.Context, workspace.SaveFrameInput) (workspace.SaveFrameResult, error) {
	probe.calls++
	return workspace.SaveFrameResult{}, nil
}

func (probe *requiredMemberWorkspaceProbe) GenerateAction(context.Context, workspace.ActionGenerateInput) (workspace.AIResponse, error) {
	probe.calls++
	return workspace.AIResponse{}, nil
}

func (probe *requiredMemberWorkspaceProbe) RefineAction(context.Context, workspace.ActionRefineInput) (workspace.AIResponse, error) {
	probe.calls++
	return workspace.AIResponse{}, nil
}

func (probe *requiredMemberWorkspaceProbe) CompleteCycle(context.Context, workspace.CompleteCycleInput) (workspace.CompleteCycleResult, error) {
	probe.calls++
	return workspace.CompleteCycleResult{}, nil
}

func (probe *requiredMemberWorkspaceProbe) Terminate(context.Context, workspace.TerminateInput) (workspace.TerminateResult, error) {
	probe.calls++
	return workspace.TerminateResult{}, nil
}

type requiredMemberAccountProbe struct {
	calls int
}

func (probe *requiredMemberAccountProbe) UpgradeGoogle(context.Context, user.ID, string, string) (account.View, error) {
	probe.calls++
	return account.View{}, nil
}

func (probe *requiredMemberAccountProbe) LoginGoogle(context.Context, string, string) (account.View, error) {
	probe.calls++
	return account.View{}, nil
}

func (probe *requiredMemberAccountProbe) Delete(context.Context, user.ID, bool) error {
	probe.calls++
	return nil
}

type contractRoute struct {
	name   string
	method string
	path   string
}

var protectedContractRoutes = []contractRoute{
	{"session", http.MethodGet, "/api/v1/session"},
	{"home", http.MethodGet, "/api/v1/home"},
	{"get draft", http.MethodGet, "/api/v1/goal-drafts/" + contractDraftID},
	{"list goals", http.MethodGet, "/api/v1/goals"},
	{"get goal", http.MethodGet, "/api/v1/goals/" + contractGoalID},
	{"get review", http.MethodGet, "/api/v1/goals/" + contractGoalID + "/review"},
	{"list cycles", http.MethodGet, "/api/v1/goals/" + contractGoalID + "/cycles"},
	{"get cycle", http.MethodGet, "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID},
	{"create draft", http.MethodPost, "/api/v1/goal-drafts"},
	{"save draft", http.MethodPatch, "/api/v1/goal-drafts/" + contractDraftID},
	{"abandon draft", http.MethodDelete, "/api/v1/goal-drafts/" + contractDraftID},
	{"refine draft", http.MethodPost, "/api/v1/goal-drafts/" + contractDraftID + "/refinements"},
	{"adopt draft suggestion", http.MethodPost, "/api/v1/goal-drafts/" + contractDraftID + "/refinements/" + contractGenerationID + "/adopt"},
	{"start goal", http.MethodPost, "/api/v1/goal-drafts/" + contractDraftID + "/start"},
	{"terminate goal", http.MethodPost, "/api/v1/goals/" + contractGoalID + "/termination"},
	{"delete goal", http.MethodDelete, "/api/v1/goals/" + contractGoalID},
	{"save review", http.MethodPatch, "/api/v1/goals/" + contractGoalID + "/review"},
	{"refine review", http.MethodPost, "/api/v1/goals/" + contractGoalID + "/review/refinements"},
	{"adopt review suggestion", http.MethodPost, "/api/v1/goals/" + contractGoalID + "/review/refinements/" + contractGenerationID + "/adopt"},
	{"continue review", http.MethodPost, "/api/v1/goals/" + contractGoalID + "/review/continue"},
	{"save frame", http.MethodPatch, "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/frames/plan"},
	{"generate action", http.MethodPost, "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/actions/generate"},
	{"refine action", http.MethodPost, "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/actions/refine"},
	{"complete cycle", http.MethodPost, "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/complete"},
	{"upgrade Google", http.MethodPost, "/api/v1/auth/google/upgrade"},
	{"login Google", http.MethodPost, "/api/v1/auth/google/login"},
	{"delete account", http.MethodDelete, "/api/v1/account"},
}

var unsafeContractRoutes = protectedContractRoutes[8:]

func TestProtectedEndpointMatrixRequiresSession(t *testing.T) {
	sessions := &contractSessionStub{
		authenticate: func(context.Context, string) (appsession.AuthenticatedSession, error) {
			panic("Authenticate must not run when the cookie is absent")
		},
	}
	router := contractRouter(sessions, &contractWorkspaceStub{}, &contractAccountStub{}, nil)
	for _, route := range protectedContractRoutes {
		t.Run(route.name, func(t *testing.T) {
			response := serveContract(router, route.method, route.path, "", nil)
			assertContractError(t, response, http.StatusUnauthorized, "SESSION_MISSING", nil)
		})
	}

	t.Run("expired cookie", func(t *testing.T) {
		expired := &contractSessionStub{
			authenticate: func(_ context.Context, token string) (appsession.AuthenticatedSession, error) {
				if token != contractSessionToken {
					t.Fatalf("session token = %q", token)
				}
				return appsession.AuthenticatedSession{}, appsession.ErrSessionExpired
			},
		}
		expiredRouter := contractRouter(expired, &contractWorkspaceStub{}, &contractAccountStub{}, nil)
		response := serveContract(expiredRouter, http.MethodGet, "/api/v1/home", "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
		})
		assertContractError(t, response, http.StatusUnauthorized, "SESSION_EXPIRED", nil)
	})
}

func TestUnsafeEndpointMatrixRequiresOriginAndCSRF(t *testing.T) {
	verifyCalls := 0
	sessions := authenticatedContractSessions()
	sessions.verifyCSRF = func(_ appsession.AuthenticatedSession, token string) error {
		verifyCalls++
		if token != "" {
			t.Fatalf("missing-token case received %q", token)
		}
		return appsession.ErrCSRFInvalid
	}
	router := contractRouter(sessions, &contractWorkspaceStub{}, &contractAccountStub{}, nil)
	for _, route := range unsafeContractRoutes {
		t.Run(route.name, func(t *testing.T) {
			response := serveContract(router, route.method, route.path, "", func(request *http.Request) {
				request.AddCookie(contractSessionCookie())
				request.Header.Set("Origin", contractOrigin)
			})
			assertContractError(t, response, http.StatusForbidden, "CSRF_INVALID", nil)
		})
	}
	if verifyCalls != len(unsafeContractRoutes) {
		t.Fatalf("VerifyCSRF calls = %d, want %d", verifyCalls, len(unsafeContractRoutes))
	}

	for _, origin := range []string{"", contractOrigin + "/", contractOrigin + ".evil", "https://other.example.test"} {
		t.Run("origin "+origin, func(t *testing.T) {
			originVerifyCalls := 0
			originSessions := authenticatedContractSessions()
			originSessions.verifyCSRF = func(appsession.AuthenticatedSession, string) error {
				originVerifyCalls++
				return nil
			}
			originRouter := contractRouter(originSessions, &contractWorkspaceStub{}, &contractAccountStub{}, nil)
			response := serveContract(originRouter, http.MethodPost, "/api/v1/goal-drafts", `{}`, func(request *http.Request) {
				request.AddCookie(contractSessionCookie())
				request.Header.Set("Origin", origin)
				request.Header.Set("X-CSRF-Token", contractCSRFToken)
			})
			assertContractError(t, response, http.StatusForbidden, "CSRF_INVALID", nil)
			if originVerifyCalls != 0 {
				t.Fatalf("VerifyCSRF ran %d times before Origin rejection", originVerifyCalls)
			}
		})
	}

	t.Run("safe read does not require Origin or CSRF", func(t *testing.T) {
		safeVerifyCalls := 0
		safeSessions := authenticatedContractSessions()
		safeSessions.verifyCSRF = func(appsession.AuthenticatedSession, string) error {
			safeVerifyCalls++
			return appsession.ErrCSRFInvalid
		}
		workspaces := &contractWorkspaceStub{home: func(_ context.Context, userID string) (workspace.HomeView, error) {
			if userID != contractUserID {
				t.Fatalf("Home user = %q", userID)
			}
			return workspace.HomeView{ProgressingGoals: []workspace.GoalView{}}, nil
		}}
		safeRouter := contractRouter(safeSessions, workspaces, &contractAccountStub{}, nil)
		response := serveContract(safeRouter, http.MethodGet, "/api/v1/home", "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
		})
		if response.Code != http.StatusOK {
			t.Fatalf("safe response = %d %s", response.Code, response.Body.String())
		}
		if safeVerifyCalls != 0 {
			t.Fatalf("VerifyCSRF calls = %d", safeVerifyCalls)
		}
	})
}

func TestExpectedAuthenticatedUserGuard(t *testing.T) {
	t.Run("mismatch rejects before CSRF and unsafe use case", func(t *testing.T) {
		verifyCalls := 0
		createCalls := 0
		sessions := authenticatedContractSessions()
		sessions.verifyCSRF = func(appsession.AuthenticatedSession, string) error {
			verifyCalls++
			return nil
		}
		spaces := &contractWorkspaceStub{createDraft: func(context.Context, string, string) (workspace.DraftView, error) {
			createCalls++
			return workspace.DraftView{}, nil
		}}
		router := contractRouter(sessions, spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/goal-drafts", `{}`, func(request *http.Request) {
			addContractAuthentication(request)
			request.Header.Set(contractExpectedUserIDHeader, contractOtherUserID)
		})
		if verifyCalls != 0 || createCalls != 0 {
			t.Fatalf("downstream calls after identity mismatch = CSRF %d, create %d", verifyCalls, createCalls)
		}
		assertContractError(t, response, http.StatusConflict, "SESSION_IDENTITY_CHANGED", nil)
		assertAuthenticatedUserHeader(t, response, contractUserID)
	})

	for _, malformed := range []string{"", "not-a-user-id", "2000000A-0000-7000-8000-000000000001", contractUserID + "," + contractUserID} {
		t.Run("malformed "+malformed, func(t *testing.T) {
			homeCalls := 0
			spaces := &contractWorkspaceStub{home: func(context.Context, string) (workspace.HomeView, error) {
				homeCalls++
				return workspace.HomeView{}, nil
			}}
			router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
			response := serveContract(router, http.MethodGet, "/api/v1/home", "", func(request *http.Request) {
				request.AddCookie(contractSessionCookie())
				request.Header[http.CanonicalHeaderKey(contractExpectedUserIDHeader)] = []string{malformed}
			})
			if homeCalls != 0 {
				t.Fatalf("Home calls after malformed expected user header = %d", homeCalls)
			}
			assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
			assertAuthenticatedUserHeader(t, response, contractUserID)
		})
	}

	for _, test := range []struct {
		name      string
		configure func(*http.Request)
	}{
		{name: "absent header preserves rolling compatibility"},
		{name: "matching header reaches the use case", configure: func(request *http.Request) {
			request.Header.Set(contractExpectedUserIDHeader, contractUserID)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			verifyCalls := 0
			createCalls := 0
			sessions := authenticatedContractSessions()
			sessions.verifyCSRF = func(appsession.AuthenticatedSession, string) error {
				verifyCalls++
				return nil
			}
			spaces := &contractWorkspaceStub{createDraft: func(_ context.Context, userID, body string) (workspace.DraftView, error) {
				createCalls++
				if userID != contractUserID || body != "kept" {
					t.Fatalf("CreateDraft input = %q/%q", userID, body)
				}
				return workspace.DraftView{}, nil
			}}
			router := contractRouter(sessions, spaces, &contractAccountStub{}, nil)
			response := serveContract(router, http.MethodPost, "/api/v1/goal-drafts", `{"initialBody":"kept"}`, func(request *http.Request) {
				addContractAuthentication(request)
				if test.configure != nil {
					test.configure(request)
				}
			})
			if response.Code != http.StatusCreated || verifyCalls != 1 || createCalls != 1 {
				t.Fatalf("response/downstream calls = %d/CSRF %d/create %d: %s", response.Code, verifyCalls, createCalls, response.Body.String())
			}
			assertAuthenticatedUserHeader(t, response, contractUserID)
		})
	}

	t.Run("duplicate header values are malformed", func(t *testing.T) {
		homeCalls := 0
		spaces := &contractWorkspaceStub{home: func(context.Context, string) (workspace.HomeView, error) {
			homeCalls++
			return workspace.HomeView{}, nil
		}}
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodGet, "/api/v1/home", "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
			request.Header[http.CanonicalHeaderKey(contractExpectedUserIDHeader)] = []string{contractUserID, contractUserID}
		})
		if homeCalls != 0 {
			t.Fatalf("Home calls after duplicate expected user header = %d", homeCalls)
		}
		assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
		assertAuthenticatedUserHeader(t, response, contractUserID)
	})
}

func TestAnonymousBootstrapHTTPBoundary(t *testing.T) {
	t.Run("success sets host cookie without exposing session token", func(t *testing.T) {
		createCalls := 0
		sessions := &contractSessionStub{createAnonymous: func(_ context.Context, input appsession.CreateAnonymousInput) (appsession.View, error) {
			createCalls++
			if input.BootstrapID != contractOperationID || input.TurnstileToken != "turnstile-token" {
				t.Fatalf("bootstrap input = %#v", input)
			}
			return appsession.View{UserID: user.ID(contractUserID), CSRFToken: contractCSRFToken, SessionToken: contractSessionToken}, nil
		}}
		router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous",
			`{"bootstrapId":"`+contractOperationID+`","turnstileToken":"turnstile-token"}`,
			func(request *http.Request) { request.Header.Set("Origin", contractOrigin) })
		if response.Code != http.StatusCreated {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		if createCalls != 1 || strings.Contains(response.Body.String(), contractSessionToken) {
			t.Fatalf("create calls/body = %d/%s", createCalls, response.Body.String())
		}
		cookie := findContractCookie(t, response.Result())
		assertSessionCookie(t, cookie, contractSessionToken)
		var body contractSessionResponse
		decodeContractJSON(t, response, &body)
		if body.User.ID != contractUserID || body.CSRFToken != contractCSRFToken || body.User.GoogleConnected || body.User.GoogleEmail != nil {
			t.Fatalf("session response = %#v", body)
		}
	})

	for _, origin := range []string{"", contractOrigin + "/", contractOrigin + ".evil", "https://other.example.test"} {
		t.Run("rejects origin "+origin, func(t *testing.T) {
			sessions := &contractSessionStub{createAnonymous: func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
				panic("CreateAnonymous ran for an invalid Origin")
			}}
			router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
			response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous",
				`{"bootstrapId":"`+contractOperationID+`","turnstileToken":"token"}`,
				func(request *http.Request) { request.Header.Set("Origin", origin) })
			assertContractError(t, response, http.StatusForbidden, "CSRF_INVALID", nil)
		})
	}

	for _, test := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"blocked", ports.ErrAnonymousCreationBlocked, http.StatusForbidden, "ANONYMOUS_CREATION_BLOCKED"},
		{"rate limited", ports.ErrRateLimitExceeded, http.StatusTooManyRequests, "RATE_LIMIT_EXCEEDED"},
		{"anti-abuse unavailable", ports.ErrAntiAbuseUnavailable, http.StatusServiceUnavailable, "ANTI_ABUSE_SERVICE_UNAVAILABLE"},
	} {
		t.Run(test.name, func(t *testing.T) {
			sessions := &contractSessionStub{createAnonymous: func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
				return appsession.View{}, test.err
			}}
			router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
			response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous",
				`{"bootstrapId":"`+contractOperationID+`","turnstileToken":"token"}`,
				func(request *http.Request) { request.Header.Set("Origin", contractOrigin) })
			assertContractError(t, response, test.status, test.code, nil)
			if len(response.Result().Cookies()) != 0 {
				t.Fatalf("failure set cookies: %#v", response.Result().Cookies())
			}
		})
	}

	t.Run("valid existing cookie is reused", func(t *testing.T) {
		sessions := &contractSessionStub{
			refresh: func(_ context.Context, token string) (appsession.View, error) {
				if token != contractSessionToken {
					t.Fatalf("Refresh token = %q", token)
				}
				return appsession.View{UserID: user.ID(contractUserID), CSRFToken: "rotated-csrf", SessionToken: token}, nil
			},
			createAnonymous: func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
				panic("CreateAnonymous ran for an existing valid Session")
			},
		}
		router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous",
			`{"bootstrapId":"`+contractOperationID+`","turnstileToken":"token"}`,
			func(request *http.Request) {
				request.Header.Set("Origin", contractOrigin)
				request.AddCookie(contractSessionCookie())
			})
		if response.Code != http.StatusOK || len(response.Result().Cookies()) != 0 {
			t.Fatalf("reuse response/cookies = %d/%#v", response.Code, response.Result().Cookies())
		}
		var body contractSessionResponse
		decodeContractJSON(t, response, &body)
		if body.User.ID != contractUserID || body.CSRFToken != "rotated-csrf" {
			t.Fatalf("reuse session response = %#v", body)
		}
	})

	for _, test := range []struct {
		name string
		body string
	}{
		{name: "root null", body: `null`},
		{name: "missing bootstrap ID", body: `{"turnstileToken":"token"}`},
		{name: "missing Turnstile token", body: `{"bootstrapId":"` + contractOperationID + `"}`},
		{name: "unknown member", body: `{"bootstrapId":"` + contractOperationID + `","turnstileToken":"token","unknown":true}`},
		{name: "oversized body", body: `{"bootstrapId":"` + contractOperationID + `","turnstileToken":"` + strings.Repeat("x", 70<<10) + `"}`},
	} {
		t.Run("existing cookie rejects invalid body "+test.name, func(t *testing.T) {
			sessions := &contractSessionStub{
				refresh: func(context.Context, string) (appsession.View, error) {
					panic("Refresh ran before anonymous request validation")
				},
				createAnonymous: func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
					panic("CreateAnonymous ran after invalid input")
				},
			}
			router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
			response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous", test.body, func(request *http.Request) {
				request.Header.Set("Origin", contractOrigin)
				request.AddCookie(contractSessionCookie())
			})
			assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
		})
	}

	for _, test := range []struct {
		name       string
		refreshErr error
	}{
		{name: "expired existing cookie creates a replacement", refreshErr: appsession.ErrSessionExpired},
		{name: "missing existing cookie creates a replacement", refreshErr: appsession.ErrSessionMissing},
	} {
		t.Run(test.name, func(t *testing.T) {
			const replacementToken = "replacement-session-token"
			createCalls := 0
			sessions := &contractSessionStub{
				refresh: func(_ context.Context, token string) (appsession.View, error) {
					if token != contractSessionToken {
						t.Fatalf("Refresh token = %q", token)
					}
					return appsession.View{}, fmt.Errorf("refresh existing cookie: %w", test.refreshErr)
				},
				createAnonymous: func(_ context.Context, input appsession.CreateAnonymousInput) (appsession.View, error) {
					createCalls++
					if input.BootstrapID != contractOperationID || input.TurnstileToken != "token" {
						t.Fatalf("bootstrap input = %#v", input)
					}
					return appsession.View{
						UserID:       user.ID(contractUserID),
						CSRFToken:    contractCSRFToken,
						SessionToken: replacementToken,
						Created:      true,
					}, nil
				},
			}
			router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
			response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous",
				`{"bootstrapId":"`+contractOperationID+`","turnstileToken":"token"}`,
				func(request *http.Request) {
					request.Header.Set("Origin", contractOrigin)
					request.AddCookie(contractSessionCookie())
				})
			if response.Code != http.StatusCreated || createCalls != 1 {
				t.Fatalf("fallback response/create calls = %d/%d: %s", response.Code, createCalls, response.Body.String())
			}
			assertSessionCookie(t, findContractCookie(t, response.Result()), replacementToken)
			var body contractSessionResponse
			decodeContractJSON(t, response, &body)
			if body.User.ID != contractUserID || body.CSRFToken != contractCSRFToken || strings.Contains(response.Body.String(), replacementToken) {
				t.Fatalf("fallback session response = %#v / %s", body, response.Body.String())
			}
		})
	}

	t.Run("unexpected refresh error stops before anonymous creation", func(t *testing.T) {
		refreshErr := errors.New("session storage unavailable: sensitive detail")
		sessions := &contractSessionStub{
			refresh: func(context.Context, string) (appsession.View, error) {
				return appsession.View{}, refreshErr
			},
			createAnonymous: func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
				panic("CreateAnonymous ran after an unexpected refresh error")
			},
		}
		router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous",
			`{"bootstrapId":"`+contractOperationID+`","turnstileToken":"token"}`,
			func(request *http.Request) {
				request.Header.Set("Origin", contractOrigin)
				request.AddCookie(contractSessionCookie())
			})
		assertContractError(t, response, http.StatusInternalServerError, "INTERNAL_ERROR", nil)
		if len(response.Result().Cookies()) != 0 {
			t.Fatalf("refresh failure set cookies: %#v", response.Result().Cookies())
		}
		if strings.Contains(response.Body.String(), refreshErr.Error()) || strings.Contains(response.Body.String(), "sensitive detail") {
			t.Fatalf("refresh error leaked to response: %s", response.Body.String())
		}
	})
}

func TestUnknownJSONAndBodyLimitsFailBeforeUseCase(t *testing.T) {
	t.Run("anonymous unknown field", func(t *testing.T) {
		sessions := &contractSessionStub{createAnonymous: func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
			panic("CreateAnonymous ran after unknown-field input")
		}}
		router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous",
			`{"bootstrapId":"`+contractOperationID+`","turnstileToken":"token","unknown":true}`,
			func(request *http.Request) { request.Header.Set("Origin", contractOrigin) })
		assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
	})

	tests := []struct {
		name    string
		path    string
		body    string
		account *contractAccountStub
		space   *contractWorkspaceStub
	}{
		{
			name: "workspace unknown field", path: "/api/v1/goal-drafts", body: `{"initialBody":"","unknown":true}`,
			space: &contractWorkspaceStub{createDraft: func(context.Context, string, string) (workspace.DraftView, error) {
				panic("CreateDraft ran after unknown-field input")
			}}, account: &contractAccountStub{},
		},
		{
			name: "workspace body over 64 KiB", path: "/api/v1/goal-drafts",
			body: `{"initialBody":"` + strings.Repeat("x", 70<<10) + `"}`,
			space: &contractWorkspaceStub{createDraft: func(context.Context, string, string) (workspace.DraftView, error) {
				panic("CreateDraft ran after oversized input")
			}}, account: &contractAccountStub{},
		},
		{
			name: "Google unknown field", path: "/api/v1/auth/google/upgrade", body: `{"idToken":"token","unknown":true}`,
			space: &contractWorkspaceStub{}, account: &contractAccountStub{upgrade: func(context.Context, user.ID, string, string) (account.View, error) {
				panic("UpgradeGoogle ran after unknown-field input")
			}},
		},
		{
			name: "Google body over 16 KiB", path: "/api/v1/auth/google/upgrade",
			body:  `{"idToken":"` + strings.Repeat("x", 17<<10) + `"}`,
			space: &contractWorkspaceStub{}, account: &contractAccountStub{upgrade: func(context.Context, user.ID, string, string) (account.View, error) {
				panic("UpgradeGoogle ran after oversized input")
			}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := contractRouter(authenticatedContractSessions(), test.space, test.account, nil)
			response := serveContract(router, http.MethodPost, test.path, test.body, addContractAuthentication)
			assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
		})
	}
}

func TestJSONBodyEndpointMatrixRejectsRootNullBeforeUseCase(t *testing.T) {
	tested := 0
	for _, route := range unsafeContractRoutes {
		if route.name == "abandon draft" {
			continue
		}
		tested++
		t.Run(route.name, func(t *testing.T) {
			spaces := &requiredMemberWorkspaceProbe{}
			accounts := &requiredMemberAccountProbe{}
			response := serveContract(contractRouter(authenticatedContractSessions(), spaces, accounts, nil),
				route.method, route.path, `null`, func(request *http.Request) {
					addContractAuthentication(request)
					request.Header.Set("Idempotency-Key", contractOperationID)
				})
			assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
			if spaces.calls != 0 || accounts.calls != 0 {
				t.Fatalf("use case calls = workspace %d/account %d, want 0/0", spaces.calls, accounts.calls)
			}
		})
	}
	if tested != 18 {
		t.Fatalf("JSON body endpoint coverage = %d, want 18", tested)
	}
}

func TestRequiredJSONMembersRejectOmissionBeforeUseCase(t *testing.T) {
	tests := []struct {
		name           string
		method         string
		path           string
		body           string
		idempotencyKey bool
	}{
		{
			name: "creation draft body", method: http.MethodPatch, path: "/api/v1/goal-drafts/" + contractDraftID,
			body: `{"expectedRevision":0}`,
		},
		{
			name: "review draft body", method: http.MethodPatch, path: "/api/v1/goals/" + contractGoalID + "/review",
			body: `{"expectedReviewDraftId":"` + contractReviewDraftID + `","expectedRevision":0}`,
		},
		{
			name: "cycle frame content", method: http.MethodPatch,
			path: "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/frames/plan",
			body: `{"expectedFrameRevision":0}`,
		},
		{
			name: "goal delete revision", method: http.MethodDelete, path: "/api/v1/goals/" + contractGoalID,
			body: `{"confirmed":true}`, idempotencyKey: true,
		},
		{
			name: "goal start revision", method: http.MethodPost, path: "/api/v1/goal-drafts/" + contractDraftID + "/start",
			body: `{"operationId":"` + contractOperationID + `"}`,
		},
		{
			name: "review continue draft revision", method: http.MethodPost, path: "/api/v1/goals/" + contractGoalID + "/review/continue",
			body: `{"operationId":"` + contractOperationID + `","expectedGoalRevision":0}`,
		},
		{
			name: "cycle completion content revision", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/complete",
			body: `{"operationId":"` + contractOperationID + `","expectedGoalRevision":0}`,
		},
		{
			name: "creation refinement revision", method: http.MethodPost,
			path: "/api/v1/goal-drafts/" + contractDraftID + "/refinements", body: `{}`, idempotencyKey: true,
		},
		{
			name: "review refinement requires goal revision", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/review/refinements",
			body: `{"expectedDraftRevision":0}`, idempotencyKey: true,
		},
		{
			name: "creation refinement forbids goal revision", method: http.MethodPost,
			path: "/api/v1/goal-drafts/" + contractDraftID + "/refinements",
			body: `{"expectedDraftRevision":0,"expectedGoalRevision":0}`, idempotencyKey: true,
		},
		{
			name: "creation suggestion adoption revision", method: http.MethodPost,
			path: "/api/v1/goal-drafts/" + contractDraftID + "/refinements/" + contractGenerationID + "/adopt", body: `{}`,
		},
		{
			name: "review suggestion adoption requires goal revision", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/review/refinements/" + contractGenerationID + "/adopt",
			body: `{"expectedDraftRevision":0}`,
		},
		{
			name: "creation suggestion adoption forbids goal revision", method: http.MethodPost,
			path: "/api/v1/goal-drafts/" + contractDraftID + "/refinements/" + contractGenerationID + "/adopt",
			body: `{"expectedDraftRevision":0,"expectedGoalRevision":0}`,
		},
		{
			name: "action generation revision", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/actions/generate",
			body: `{"confirmReplace":false}`, idempotencyKey: true,
		},
		{
			name: "action refinement revision", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/actions/refine",
			body: `{}`, idempotencyKey: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := &requiredMemberWorkspaceProbe{}
			response := serveContract(contractRouter(authenticatedContractSessions(), probe, &contractAccountStub{}, nil),
				test.method, test.path, test.body, func(request *http.Request) {
					addContractAuthentication(request)
					if test.idempotencyKey {
						request.Header.Set("Idempotency-Key", contractOperationID)
					}
				})
			assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
			if probe.calls != 0 {
				t.Fatalf("workspace use case calls = %d, want 0", probe.calls)
			}
		})
	}
}

func TestRequiredJSONMembersPreserveExplicitZeroFalseAndEmptyValues(t *testing.T) {
	tests := []struct {
		name           string
		method         string
		path           string
		body           string
		idempotencyKey bool
		wantStatus     int
	}{
		{
			name: "optional creation draft body remains omitted", method: http.MethodPost,
			path: "/api/v1/goal-drafts", body: `{}`, wantStatus: http.StatusCreated,
		},
		{
			name: "creation draft empty body and zero revision", method: http.MethodPatch,
			path: "/api/v1/goal-drafts/" + contractDraftID, body: `{"body":"","expectedRevision":0}`, wantStatus: http.StatusOK,
		},
		{
			name: "review draft empty body and zero revision", method: http.MethodPatch,
			path: "/api/v1/goals/" + contractGoalID + "/review",
			body: `{"body":"","expectedReviewDraftId":"` + contractReviewDraftID + `","expectedRevision":0}`, wantStatus: http.StatusOK,
		},
		{
			name: "cycle frame empty content and zero revision", method: http.MethodPatch,
			path: "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/frames/plan",
			body: `{"content":"","expectedFrameRevision":0}`, wantStatus: http.StatusOK,
		},
		{
			name: "goal delete true confirmation and zero revision", method: http.MethodDelete,
			path: "/api/v1/goals/" + contractGoalID, body: `{"confirmed":true,"expectedGoalRevision":0}`,
			idempotencyKey: true, wantStatus: http.StatusNoContent,
		},
		{
			name: "goal start zero revision", method: http.MethodPost,
			path: "/api/v1/goal-drafts/" + contractDraftID + "/start",
			body: `{"operationId":"` + contractOperationID + `","expectedDraftRevision":0}`, wantStatus: http.StatusOK,
		},
		{
			name: "creation refinement zero revision and omitted goal revision", method: http.MethodPost,
			path: "/api/v1/goal-drafts/" + contractDraftID + "/refinements",
			body: `{"expectedDraftRevision":0}`, idempotencyKey: true, wantStatus: http.StatusOK,
		},
		{
			name: "creation suggestion adoption zero revision and omitted goal revision", method: http.MethodPost,
			path: "/api/v1/goal-drafts/" + contractDraftID + "/refinements/" + contractGenerationID + "/adopt",
			body: `{"expectedDraftRevision":0}`, wantStatus: http.StatusOK,
		},
		{
			name: "review continue zero revisions", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/review/continue",
			body: `{"operationId":"` + contractOperationID + `","expectedGoalRevision":0,"expectedDraftRevision":0}`, wantStatus: http.StatusOK,
		},
		{
			name: "action generation zero revision and false confirmation", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/actions/generate",
			body: `{"expectedContentRevision":0,"confirmReplace":false}`, idempotencyKey: true, wantStatus: http.StatusOK,
		},
		{
			name: "cycle completion zero revisions", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/complete",
			body: `{"operationId":"` + contractOperationID + `","expectedGoalRevision":0,"expectedContentRevision":0}`, wantStatus: http.StatusOK,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := &requiredMemberWorkspaceProbe{}
			response := serveContract(contractRouter(authenticatedContractSessions(), probe, &contractAccountStub{}, nil),
				test.method, test.path, test.body, func(request *http.Request) {
					addContractAuthentication(request)
					if test.idempotencyKey {
						request.Header.Set("Idempotency-Key", contractOperationID)
					}
				})
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.wantStatus, response.Body.String())
			}
			if probe.calls != 1 {
				t.Fatalf("workspace use case calls = %d, want 1", probe.calls)
			}
		})
	}
}

func TestGoalTransitionJSONMembersMapExactly(t *testing.T) {
	const remoteAddress = "203.0.113.9:4321"
	configureAI := func(request *http.Request) {
		addContractAuthentication(request)
		request.Header.Set("Idempotency-Key", contractOperationID)
		request.RemoteAddr = remoteAddress
	}

	t.Run("creation refinement keeps goal revision omitted", func(t *testing.T) {
		want := workspace.GoalRefineInput{
			UserID: contractUserID, DraftID: contractDraftID, ExpectedDraftRevision: 2,
			IdempotencyKey: contractOperationID, SessionID: contractSessionID, RemoteAddress: remoteAddress,
		}
		spaces := &contractWorkspaceStub{refineGoal: func(_ context.Context, input workspace.GoalRefineInput) (workspace.AIResponse, error) {
			if !reflect.DeepEqual(input, want) {
				t.Fatalf("RefineGoal input = %#v, want %#v", input, want)
			}
			return workspace.AIResponse{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, "/api/v1/goal-drafts/"+contractDraftID+"/refinements",
			`{"expectedDraftRevision":2}`, configureAI)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("review refinement keeps goal revision present", func(t *testing.T) {
		goalRevision := int64(7)
		want := workspace.GoalRefineInput{
			UserID: contractUserID, GoalID: contractGoalID, ExpectedDraftRevision: 3,
			ExpectedGoalRevision: &goalRevision, IdempotencyKey: contractOperationID,
			SessionID: contractSessionID, RemoteAddress: remoteAddress,
		}
		spaces := &contractWorkspaceStub{refineGoal: func(_ context.Context, input workspace.GoalRefineInput) (workspace.AIResponse, error) {
			if !reflect.DeepEqual(input, want) {
				t.Fatalf("RefineGoal input = %#v, want %#v", input, want)
			}
			return workspace.AIResponse{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, "/api/v1/goals/"+contractGoalID+"/review/refinements",
			`{"expectedDraftRevision":3,"expectedGoalRevision":7}`, configureAI)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("creation adoption keeps goal revision omitted", func(t *testing.T) {
		spaces := &contractWorkspaceStub{adoptGoal: func(
			_ context.Context, userID, draftID, goalID, generationID string,
			expectedDraftRevision int64, expectedGoalRevision *int64,
		) (workspace.DraftView, error) {
			if userID != contractUserID || draftID != contractDraftID || goalID != "" ||
				generationID != contractGenerationID || expectedDraftRevision != 4 || expectedGoalRevision != nil {
				t.Fatalf("AdoptGoalSuggestion input = %q/%q/%q/%q/%d/%v",
					userID, draftID, goalID, generationID, expectedDraftRevision, expectedGoalRevision)
			}
			return workspace.DraftView{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, "/api/v1/goal-drafts/"+contractDraftID+"/refinements/"+contractGenerationID+"/adopt",
			`{"expectedDraftRevision":4}`, addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("review adoption keeps goal revision present", func(t *testing.T) {
		spaces := &contractWorkspaceStub{adoptGoal: func(
			_ context.Context, userID, draftID, goalID, generationID string,
			expectedDraftRevision int64, expectedGoalRevision *int64,
		) (workspace.DraftView, error) {
			if userID != contractUserID || draftID != "" || goalID != contractGoalID ||
				generationID != contractGenerationID || expectedDraftRevision != 5 ||
				expectedGoalRevision == nil || *expectedGoalRevision != 11 {
				t.Fatalf("AdoptGoalSuggestion input = %q/%q/%q/%q/%d/%v",
					userID, draftID, goalID, generationID, expectedDraftRevision, expectedGoalRevision)
			}
			return workspace.DraftView{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, "/api/v1/goals/"+contractGoalID+"/review/refinements/"+contractGenerationID+"/adopt",
			`{"expectedDraftRevision":5,"expectedGoalRevision":11}`, addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("continue review keeps both revisions", func(t *testing.T) {
		spaces := &contractWorkspaceStub{continueReview: func(
			_ context.Context, userID, goalID, operationID string, expectedGoalRevision, expectedDraftRevision int64,
		) (workspace.ContinueReviewResult, error) {
			if userID != contractUserID || goalID != contractGoalID || operationID != contractOperationID ||
				expectedGoalRevision != 13 || expectedDraftRevision != 6 {
				t.Fatalf("ContinueReview input = %q/%q/%q/%d/%d",
					userID, goalID, operationID, expectedGoalRevision, expectedDraftRevision)
			}
			return workspace.ContinueReviewResult{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, "/api/v1/goals/"+contractGoalID+"/review/continue",
			`{"operationId":"`+contractOperationID+`","expectedGoalRevision":13,"expectedDraftRevision":6}`,
			addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("complete cycle keeps both revisions", func(t *testing.T) {
		want := workspace.CompleteCycleInput{
			UserID: contractUserID, GoalID: contractGoalID, CycleID: contractCycleID,
			OperationID: contractOperationID, ExpectedGoalRevision: 17, ExpectedContentRevision: 8,
		}
		spaces := &contractWorkspaceStub{completeCycle: func(_ context.Context, input workspace.CompleteCycleInput) (workspace.CompleteCycleResult, error) {
			if !reflect.DeepEqual(input, want) {
				t.Fatalf("CompleteCycle input = %#v, want %#v", input, want)
			}
			return workspace.CompleteCycleResult{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, "/api/v1/goals/"+contractGoalID+"/cycles/"+contractCycleID+"/complete",
			`{"operationId":"`+contractOperationID+`","expectedGoalRevision":17,"expectedContentRevision":8}`,
			addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("delete goal preserves false confirmation", func(t *testing.T) {
		spaces := &contractWorkspaceStub{deleteGoal: func(
			_ context.Context, userID, goalID string, confirmed bool, expectedRevision int64, idempotencyKey string,
		) error {
			if userID != contractUserID || goalID != contractGoalID || confirmed ||
				expectedRevision != 19 || idempotencyKey != contractOperationID {
				t.Fatalf("DeleteGoal input = %q/%q/%t/%d/%q",
					userID, goalID, confirmed, expectedRevision, idempotencyKey)
			}
			return workspace.ErrDeleteConfirmation
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodDelete, "/api/v1/goals/"+contractGoalID,
			`{"confirmed":false,"expectedGoalRevision":19}`, configureAI)
		assertContractError(t, response, http.StatusBadRequest, "GOAL_DELETE_CONFIRMATION_REQUIRED", nil)
	})
}

func TestRecoveryDetailsAndFailuresExposeNoSensitiveCause(t *testing.T) {
	t.Run("existing draft identifier", func(t *testing.T) {
		spaces := &contractWorkspaceStub{createDraft: func(context.Context, string, string) (workspace.DraftView, error) {
			return workspace.DraftView{}, fmt.Errorf("create conflict: %w", &workspace.DraftAlreadyExistsError{DraftID: contractDraftID})
		}}
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/goal-drafts", `{}`, addContractAuthentication)
		assertContractError(t, response, http.StatusConflict, "GOAL_CREATION_DRAFT_ALREADY_EXISTS", map[string]any{"draftId": contractDraftID})
	})

	t.Run("running generation identifier", func(t *testing.T) {
		spaces := &contractWorkspaceStub{refineGoal: func(context.Context, workspace.GoalRefineInput) (workspace.AIResponse, error) {
			return workspace.AIResponse{}, fmt.Errorf("refine conflict: %w", &workspace.AIOperationInProgressError{GenerationID: contractGenerationID})
		}}
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/goal-drafts/"+contractDraftID+"/refinements",
			`{"expectedDraftRevision":0}`, func(request *http.Request) {
				addContractAuthentication(request)
				request.Header.Set("Idempotency-Key", contractOperationID)
			})
		assertContractError(t, response, http.StatusConflict, "AI_OPERATION_IN_PROGRESS", map[string]any{"generationId": contractGenerationID})
	})

	t.Run("internal read error", func(t *testing.T) {
		const secret = "postgres://secret-user:secret-password@private.example/database"
		var logs bytes.Buffer
		spaces := &contractWorkspaceStub{getGoal: func(context.Context, string, string) (workspace.GoalView, error) {
			return workspace.GoalView{}, errors.New(secret)
		}}
		logger := slog.New(slog.NewJSONHandler(&logs, nil))
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, logger)
		response := serveContract(router, http.MethodGet, "/api/v1/goals/"+contractGoalID, "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
		})
		assertContractError(t, response, http.StatusInternalServerError, "INTERNAL_ERROR", nil)
		if strings.Contains(response.Body.String(), secret) || strings.Contains(logs.String(), secret) {
			t.Fatalf("internal cause leaked in response/log: %s / %s", response.Body.String(), logs.String())
		}
	})

	t.Run("mutation body and storage error", func(t *testing.T) {
		const bodySentinel = "private goal body sentinel"
		const errorSentinel = "database credential sentinel"
		var logs bytes.Buffer
		spaces := &contractWorkspaceStub{saveDraft: func(context.Context, string, string, string, int64) (workspace.DraftView, error) {
			return workspace.DraftView{}, errors.New(errorSentinel)
		}}
		logger := slog.New(slog.NewJSONHandler(&logs, nil))
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, logger)
		response := serveContract(router, http.MethodPatch, "/api/v1/goal-drafts/"+contractDraftID,
			`{"body":"`+bodySentinel+`","expectedRevision":0}`, addContractAuthentication)
		assertContractError(t, response, http.StatusInternalServerError, "GOAL_DRAFT_SAVE_FAILED", nil)
		combined := response.Body.String() + logs.String()
		if strings.Contains(combined, bodySentinel) || strings.Contains(combined, errorSentinel) {
			t.Fatalf("body or cause leaked: %s", combined)
		}
	})
}

func TestAutosaveRevisionConflictsHaveStableHTTPContract(t *testing.T) {
	t.Run("creation draft", func(t *testing.T) {
		spaces := &contractWorkspaceStub{saveDraft: func(_ context.Context, userID, draftID, body string, revision int64) (workspace.DraftView, error) {
			if userID != contractUserID || draftID != contractDraftID || body != "local goal" || revision != 3 {
				t.Fatalf("SaveDraft input = %q/%q/%q/%d", userID, draftID, body, revision)
			}
			return workspace.DraftView{}, workspace.ErrDraftRevisionConflict
		}}
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodPatch, "/api/v1/goal-drafts/"+contractDraftID,
			`{"body":"local goal","expectedRevision":3}`, addContractAuthentication)
		assertContractError(t, response, http.StatusConflict, "GOAL_DRAFT_REVISION_CONFLICT", nil)
	})

	t.Run("goal review draft", func(t *testing.T) {
		spaces := &contractWorkspaceStub{saveReview: func(_ context.Context, userID, goalID, expectedReviewDraftID, body string, revision int64) (workspace.DraftView, error) {
			if userID != contractUserID || goalID != contractGoalID || expectedReviewDraftID != contractReviewDraftID ||
				body != "local review goal" || revision != 5 {
				t.Fatalf("SaveReview input = %q/%q/%q/%q/%d", userID, goalID, expectedReviewDraftID, body, revision)
			}
			return workspace.DraftView{}, workspace.ErrReviewRevisionConflict
		}}
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodPatch, "/api/v1/goals/"+contractGoalID+"/review",
			`{"body":"local review goal","expectedReviewDraftId":"`+contractReviewDraftID+`","expectedRevision":5}`, addContractAuthentication)
		assertContractError(t, response, http.StatusConflict, "GOAL_REVIEW_DRAFT_REVISION_CONFLICT", nil)
	})

	t.Run("goal review draft lease is a required UUIDv7", func(t *testing.T) {
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, &contractAccountStub{}, nil)
		for _, test := range []struct {
			name string
			body string
		}{
			{name: "missing", body: `{"body":"local review goal","expectedRevision":5}`},
			{name: "invalid", body: `{"body":"local review goal","expectedReviewDraftId":"not-a-uuid","expectedRevision":5}`},
		} {
			t.Run(test.name, func(t *testing.T) {
				response := serveContract(router, http.MethodPatch, "/api/v1/goals/"+contractGoalID+"/review",
					test.body, addContractAuthentication)
				assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
			})
		}
	})

	t.Run("cycle frame", func(t *testing.T) {
		spaces := &contractWorkspaceStub{saveFrame: func(_ context.Context, input workspace.SaveFrameInput) (workspace.SaveFrameResult, error) {
			if input.UserID != contractUserID || input.GoalID != contractGoalID || input.CycleID != contractCycleID ||
				input.Frame != cycle.FramePlan || input.Content != "local plan" || input.ExpectedFrameRevision != 7 {
				t.Fatalf("SaveFrame input = %#v", input)
			}
			return workspace.SaveFrameResult{}, cycle.ErrRevisionConflict
		}}
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodPatch,
			"/api/v1/goals/"+contractGoalID+"/cycles/"+contractCycleID+"/frames/plan",
			`{"content":"local plan","expectedFrameRevision":7}`, addContractAuthentication)
		assertContractError(t, response, http.StatusConflict, "CYCLE_REVISION_CONFLICT", nil)
	})
}

func TestGoalStartUsesAuthenticatedSessionAndReturnsGenericRateLimit(t *testing.T) {
	spaces := &contractWorkspaceStub{startGoal: func(
		_ context.Context,
		userID string,
		sessionID string,
		draftID string,
		operationID string,
		revision int64,
	) (workspace.StartGoalResult, error) {
		if userID != contractUserID || sessionID != contractSessionID || draftID != contractDraftID ||
			operationID != contractOperationID || revision != 4 {
			t.Fatalf("StartGoal input = %q/%q/%q/%q/%d", userID, sessionID, draftID, operationID, revision)
		}
		return workspace.StartGoalResult{}, ports.ErrRateLimitExceeded
	}}
	router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
	response := serveContract(
		router,
		http.MethodPost,
		"/api/v1/goal-drafts/"+contractDraftID+"/start",
		`{"operationId":"`+contractOperationID+`","expectedDraftRevision":4}`,
		addContractAuthentication,
	)
	assertContractError(t, response, http.StatusTooManyRequests, "RATE_LIMIT_EXCEEDED", nil)
	if len(response.Result().Cookies()) != 0 {
		t.Fatalf("rate rejection set cookies: %#v", response.Result().Cookies())
	}
}

func TestTypedActionAIHTTPContract(t *testing.T) {
	const remoteAddress = "203.0.113.9:4321"
	generatePath := "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/actions/generate"
	refinePath := "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/actions/refine"
	wantResponse := workspace.AIResponse{
		GenerationID: contractGenerationID, Action: "1. 次の行動", ContentRevision: 8,
		ActionRevision: 3, ContextChanged: true,
	}
	configure := func(request *http.Request) {
		addContractAuthentication(request)
		request.Header.Set("Idempotency-Key", contractOperationID)
		request.RemoteAddr = remoteAddress
	}

	t.Run("generate uses only the typed generate method", func(t *testing.T) {
		calls := 0
		wantInput := workspace.ActionGenerateInput{
			UserID: contractUserID, GoalID: contractGoalID, CycleID: contractCycleID,
			ExpectedContentRevision: 7, ConfirmReplace: true, IdempotencyKey: contractOperationID,
			SessionID: contractSessionID, RemoteAddress: remoteAddress,
		}
		spaces := &contractWorkspaceStub{generateAction: func(_ context.Context, input workspace.ActionGenerateInput) (workspace.AIResponse, error) {
			calls++
			if !reflect.DeepEqual(input, wantInput) {
				t.Fatalf("GenerateAction input = %#v, want %#v", input, wantInput)
			}
			return wantResponse, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, generatePath, `{"expectedContentRevision":7,"confirmReplace":true}`, configure)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		if calls != 1 {
			t.Fatalf("GenerateAction calls = %d, want 1", calls)
		}
		var got workspace.AIResponse
		decodeContractJSON(t, response, &got)
		if !reflect.DeepEqual(got, wantResponse) {
			t.Fatalf("response = %#v, want %#v", got, wantResponse)
		}
	})

	t.Run("generate preserves false replacement confirmation", func(t *testing.T) {
		wantInput := workspace.ActionGenerateInput{
			UserID: contractUserID, GoalID: contractGoalID, CycleID: contractCycleID,
			ExpectedContentRevision: 9, ConfirmReplace: false, IdempotencyKey: contractOperationID,
			SessionID: contractSessionID, RemoteAddress: remoteAddress,
		}
		spaces := &contractWorkspaceStub{generateAction: func(_ context.Context, input workspace.ActionGenerateInput) (workspace.AIResponse, error) {
			if !reflect.DeepEqual(input, wantInput) {
				t.Fatalf("GenerateAction input = %#v, want %#v", input, wantInput)
			}
			return workspace.AIResponse{}, workspace.ErrAIReplacementRequired
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, generatePath, `{"expectedContentRevision":9,"confirmReplace":false}`, configure)
		assertContractError(t, response, http.StatusConflict, "ACTION_REPLACEMENT_CONFIRMATION_REQUIRED", nil)
	})

	t.Run("refine uses only the typed refine method", func(t *testing.T) {
		calls := 0
		wantInput := workspace.ActionRefineInput{
			UserID: contractUserID, GoalID: contractGoalID, CycleID: contractCycleID,
			ExpectedContentRevision: 11, IdempotencyKey: contractOperationID,
			SessionID: contractSessionID, RemoteAddress: remoteAddress,
		}
		spaces := &contractWorkspaceStub{refineAction: func(_ context.Context, input workspace.ActionRefineInput) (workspace.AIResponse, error) {
			calls++
			if !reflect.DeepEqual(input, wantInput) {
				t.Fatalf("RefineAction input = %#v, want %#v", input, wantInput)
			}
			return wantResponse, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, refinePath, `{"expectedContentRevision":11}`, configure)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		if calls != 1 {
			t.Fatalf("RefineAction calls = %d, want 1", calls)
		}
		var got workspace.AIResponse
		decodeContractJSON(t, response, &got)
		if !reflect.DeepEqual(got, wantResponse) {
			t.Fatalf("response = %#v, want %#v", got, wantResponse)
		}
	})

	t.Run("typed errors retain their public codes", func(t *testing.T) {
		generateSpaces := &contractWorkspaceStub{generateAction: func(context.Context, workspace.ActionGenerateInput) (workspace.AIResponse, error) {
			return workspace.AIResponse{}, workspace.ErrActionGenerateInputIncomplete
		}}
		generateResponse := serveContract(contractRouter(authenticatedContractSessions(), generateSpaces, &contractAccountStub{}, nil),
			http.MethodPost, generatePath, `{"expectedContentRevision":7,"confirmReplace":false}`, configure)
		assertContractError(t, generateResponse, http.StatusBadRequest, "ACTION_GENERATE_INPUT_INCOMPLETE", nil)

		refineSpaces := &contractWorkspaceStub{refineAction: func(context.Context, workspace.ActionRefineInput) (workspace.AIResponse, error) {
			return workspace.AIResponse{}, workspace.ErrActionRefineInputIncomplete
		}}
		refineResponse := serveContract(contractRouter(authenticatedContractSessions(), refineSpaces, &contractAccountStub{}, nil),
			http.MethodPost, refinePath, `{"expectedContentRevision":11}`, configure)
		assertContractError(t, refineResponse, http.StatusBadRequest, "ACTION_REFINE_INPUT_INCOMPLETE", nil)
	})

	for _, test := range []struct {
		name string
		path string
		body string
	}{
		{name: "generate requires idempotency key", path: generatePath, body: `{"expectedContentRevision":7,"confirmReplace":false}`},
		{name: "refine requires idempotency key", path: refinePath, body: `{"expectedContentRevision":11}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := serveContract(contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, &contractAccountStub{}, nil),
				http.MethodPost, test.path, test.body, addContractAuthentication)
			assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
		})
	}
}

func TestGoalTerminationDiscriminatedUnionHTTPContract(t *testing.T) {
	const path = "/api/v1/goals/" + contractGoalID + "/termination"

	t.Run("active cycle variant", func(t *testing.T) {
		cycleRevision := int64(5)
		want := workspace.TerminateInput{
			UserID: contractUserID, GoalID: contractGoalID, OperationID: contractOperationID,
			Outcome: "achieved", ExpectedGoalRevision: 3, ExpectedState: "active_cycle",
			ActiveCycleID: contractCycleID, ExpectedCycleContentRevision: &cycleRevision,
		}
		spaces := &contractWorkspaceStub{terminate: func(_ context.Context, input workspace.TerminateInput) (workspace.TerminateResult, error) {
			if !reflect.DeepEqual(input, want) {
				t.Fatalf("Terminate input = %#v, want %#v", input, want)
			}
			return workspace.TerminateResult{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, path,
			`{"operationId":"`+contractOperationID+`","outcome":"achieved","expectedGoalRevision":3,"expectedState":"active_cycle","activeCycleId":"`+contractCycleID+`","expectedCycleContentRevision":5}`,
			addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("goal review variant preserves false confirmation", func(t *testing.T) {
		want := workspace.TerminateInput{
			UserID: contractUserID, GoalID: contractGoalID, OperationID: contractOperationID,
			Outcome: "ended", ExpectedGoalRevision: 7, ExpectedState: "goal_review",
			ConfirmDiscardReviewDraft: false,
		}
		spaces := &contractWorkspaceStub{terminate: func(_ context.Context, input workspace.TerminateInput) (workspace.TerminateResult, error) {
			if !reflect.DeepEqual(input, want) {
				t.Fatalf("Terminate input = %#v, want %#v", input, want)
			}
			return workspace.TerminateResult{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, path,
			`{"operationId":"`+contractOperationID+`","outcome":"ended","expectedGoalRevision":7,"expectedState":"goal_review","confirmDiscardReviewDraft":false}`,
			addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
	})

	validActivePrefix := `{"operationId":"` + contractOperationID + `","outcome":"achieved","expectedGoalRevision":3,"expectedState":"active_cycle"`
	validReviewPrefix := `{"operationId":"` + contractOperationID + `","outcome":"ended","expectedGoalRevision":3,"expectedState":"goal_review"`
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "missing expected goal revision", body: `{"operationId":"` + contractOperationID + `","outcome":"ended","expectedState":"goal_review","confirmDiscardReviewDraft":false}`},
		{name: "null expected goal revision", body: `{"operationId":"` + contractOperationID + `","outcome":"ended","expectedGoalRevision":null,"expectedState":"goal_review","confirmDiscardReviewDraft":false}`},
		{name: "negative expected goal revision", body: `{"operationId":"` + contractOperationID + `","outcome":"ended","expectedGoalRevision":-1,"expectedState":"goal_review","confirmDiscardReviewDraft":false}`},
		{name: "unknown expected state", body: `{"operationId":"` + contractOperationID + `","outcome":"ended","expectedGoalRevision":3,"expectedState":"paused","confirmDiscardReviewDraft":false}`},
		{name: "expected state wrong type", body: `{"operationId":"` + contractOperationID + `","outcome":"ended","expectedGoalRevision":3,"expectedState":1,"confirmDiscardReviewDraft":false}`},
		{name: "active missing cycle id", body: validActivePrefix + `,"expectedCycleContentRevision":5}`},
		{name: "active null cycle id", body: validActivePrefix + `,"activeCycleId":null,"expectedCycleContentRevision":5}`},
		{name: "active cycle id wrong type", body: validActivePrefix + `,"activeCycleId":1,"expectedCycleContentRevision":5}`},
		{name: "active non UUIDv7 cycle id", body: validActivePrefix + `,"activeCycleId":"123e4567-e89b-42d3-a456-426614174000","expectedCycleContentRevision":5}`},
		{name: "active missing cycle revision", body: validActivePrefix + `,"activeCycleId":"` + contractCycleID + `"}`},
		{name: "active null cycle revision", body: validActivePrefix + `,"activeCycleId":"` + contractCycleID + `","expectedCycleContentRevision":null}`},
		{name: "active cycle revision wrong type", body: validActivePrefix + `,"activeCycleId":"` + contractCycleID + `","expectedCycleContentRevision":"5"}`},
		{name: "active negative cycle revision", body: validActivePrefix + `,"activeCycleId":"` + contractCycleID + `","expectedCycleContentRevision":-1}`},
		{name: "active includes review confirmation", body: validActivePrefix + `,"activeCycleId":"` + contractCycleID + `","expectedCycleContentRevision":5,"confirmDiscardReviewDraft":false}`},
		{name: "active includes null review confirmation", body: validActivePrefix + `,"activeCycleId":"` + contractCycleID + `","expectedCycleContentRevision":5,"confirmDiscardReviewDraft":null}`},
		{name: "review missing confirmation", body: validReviewPrefix + `}`},
		{name: "review null confirmation", body: validReviewPrefix + `,"confirmDiscardReviewDraft":null}`},
		{name: "review confirmation wrong type", body: validReviewPrefix + `,"confirmDiscardReviewDraft":"false"}`},
		{name: "review includes active cycle id", body: validReviewPrefix + `,"activeCycleId":"` + contractCycleID + `","confirmDiscardReviewDraft":false}`},
		{name: "review includes null active cycle id", body: validReviewPrefix + `,"activeCycleId":null,"confirmDiscardReviewDraft":false}`},
		{name: "review includes cycle revision", body: validReviewPrefix + `,"expectedCycleContentRevision":5,"confirmDiscardReviewDraft":false}`},
		{name: "review includes null cycle revision", body: validReviewPrefix + `,"expectedCycleContentRevision":null,"confirmDiscardReviewDraft":false}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			spaces := &contractWorkspaceStub{terminate: func(context.Context, workspace.TerminateInput) (workspace.TerminateResult, error) {
				calls++
				return workspace.TerminateResult{}, nil
			}}
			response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
				http.MethodPost, path, test.body, addContractAuthentication)
			assertContractError(t, response, http.StatusBadRequest, "VALIDATION_ERROR", nil)
			if calls != 0 {
				t.Fatalf("Terminate calls = %d, want 0", calls)
			}
		})
	}

	t.Run("invalid outcome retains stable semantic error", func(t *testing.T) {
		calls := 0
		spaces := &contractWorkspaceStub{terminate: func(context.Context, workspace.TerminateInput) (workspace.TerminateResult, error) {
			calls++
			return workspace.TerminateResult{}, nil
		}}
		response := serveContract(contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil),
			http.MethodPost, path,
			`{"operationId":"`+contractOperationID+`","outcome":"paused","expectedGoalRevision":3,"expectedState":"active_cycle","activeCycleId":"`+contractCycleID+`","expectedCycleContentRevision":5}`,
			addContractAuthentication)
		assertContractError(t, response, http.StatusBadRequest, "INVALID_GOAL_OUTCOME", nil)
		if calls != 0 {
			t.Fatalf("Terminate calls = %d, want 0", calls)
		}
	})
}

func TestSessionAndAccountCookieContract(t *testing.T) {
	t.Run("session refresh", func(t *testing.T) {
		sessions := authenticatedContractSessions()
		sessions.refresh = func(_ context.Context, token string) (appsession.View, error) {
			if token != contractSessionToken {
				t.Fatalf("Refresh token = %q", token)
			}
			return appsession.View{UserID: user.ID(contractUserID), CSRFToken: "rotated-csrf"}, nil
		}
		router := contractRouter(sessions, &contractWorkspaceStub{}, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodGet, "/api/v1/session", "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
		})
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		var body contractSessionResponse
		decodeContractJSON(t, response, &body)
		if body.User.ID != contractUserID || body.CSRFToken != "rotated-csrf" {
			t.Fatalf("session response = %#v", body)
		}
	})

	t.Run("same-user upgrade rotates cookie", func(t *testing.T) {
		accounts := &contractAccountStub{upgrade: func(_ context.Context, userID user.ID, sessionID, token string) (account.View, error) {
			if string(userID) != contractUserID || sessionID != contractSessionID || token != "google-token" {
				t.Fatalf("upgrade input = %s/%s/%s", userID, sessionID, token)
			}
			return account.View{UserID: userID, GoogleConnected: true, SessionToken: "upgraded-session", CSRFToken: "upgraded-csrf"}, nil
		}}
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, accounts, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/auth/google/upgrade", `{"idToken":"google-token"}`, addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertSessionCookie(t, findContractCookie(t, response.Result()), "upgraded-session")
		var body contractSessionResponse
		decodeContractJSON(t, response, &body)
		if body.User.ID != contractUserID || !body.User.GoogleConnected || body.CSRFToken != "upgraded-csrf" {
			t.Fatalf("upgrade response = %#v", body)
		}
	})

	t.Run("login may switch to linked user and rotates cookie", func(t *testing.T) {
		accounts := &contractAccountStub{login: func(_ context.Context, sessionID, token string) (account.View, error) {
			if sessionID != contractSessionID || token != "google-token" {
				t.Fatalf("login input = %s/%s", sessionID, token)
			}
			return account.View{UserID: user.ID(contractOtherUserID), GoogleConnected: true, SessionToken: "login-session", CSRFToken: "login-csrf"}, nil
		}}
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, accounts, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/auth/google/login", `{"idToken":"google-token"}`, addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertSessionCookie(t, findContractCookie(t, response.Result()), "login-session")
		var body contractSessionResponse
		decodeContractJSON(t, response, &body)
		if body.User.ID != contractOtherUserID || body.CSRFToken != "login-csrf" {
			t.Fatalf("login response = %#v", body)
		}
	})

	t.Run("account delete expires cookie", func(t *testing.T) {
		deleteCalls := 0
		accounts := &contractAccountStub{delete: func(_ context.Context, userID user.ID, confirmed bool) error {
			deleteCalls++
			if string(userID) != contractUserID || !confirmed {
				t.Fatalf("delete input = %s/%t", userID, confirmed)
			}
			return nil
		}}
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, accounts, nil)
		response := serveContract(router, http.MethodDelete, "/api/v1/account", `{"confirmed":true}`, addContractAuthentication)
		if response.Code != http.StatusNoContent || deleteCalls != 1 {
			t.Fatalf("delete response/calls = %d/%d: %s", response.Code, deleteCalls, response.Body.String())
		}
		cookie := findContractCookie(t, response.Result())
		if cookie.Value != "" || cookie.MaxAge >= 0 || cookie.Path != "/" || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("clear cookie = %#v", cookie)
		}
	})

	t.Run("account delete preserves false confirmation", func(t *testing.T) {
		deleteCalls := 0
		accounts := &contractAccountStub{delete: func(_ context.Context, userID user.ID, confirmed bool) error {
			deleteCalls++
			if string(userID) != contractUserID || confirmed {
				t.Fatalf("delete input = %s/%t", userID, confirmed)
			}
			return account.ErrDeleteConfirmationRequired
		}}
		response := serveContract(
			contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, accounts, nil),
			http.MethodDelete, "/api/v1/account", `{"confirmed":false}`, addContractAuthentication,
		)
		assertContractError(t, response, http.StatusBadRequest, "ACCOUNT_DELETE_CONFIRMATION_REQUIRED", nil)
		if deleteCalls != 1 {
			t.Fatalf("Delete calls = %d, want 1", deleteCalls)
		}
		if len(response.Result().Cookies()) != 0 {
			t.Fatalf("failed delete set cookies: %#v", response.Result().Cookies())
		}
	})
}

func TestAuthenticatedUserResponseHeaderContract(t *testing.T) {
	t.Run("safe success identifies the authenticated user", func(t *testing.T) {
		spaces := &contractWorkspaceStub{home: func(_ context.Context, userID string) (workspace.HomeView, error) {
			if userID != contractUserID {
				t.Fatalf("Home user = %q", userID)
			}
			return workspace.HomeView{ProgressingGoals: []workspace.GoalView{}}, nil
		}}
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodGet, "/api/v1/home", "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
		})
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertAuthenticatedUserHeader(t, response, contractUserID)
	})

	t.Run("authenticated handler error retains the source user", func(t *testing.T) {
		spaces := &contractWorkspaceStub{getGoal: func(context.Context, string, string) (workspace.GoalView, error) {
			return workspace.GoalView{}, errors.New("storage unavailable")
		}}
		router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodGet, "/api/v1/goals/"+contractGoalID, "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
		})
		assertContractError(t, response, http.StatusInternalServerError, "INTERNAL_ERROR", nil)
		assertAuthenticatedUserHeader(t, response, contractUserID)
	})

	t.Run("CSRF rejection retains the source user", func(t *testing.T) {
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/goal-drafts", "{}", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
			request.Header.Set("Origin", contractOrigin)
		})
		assertContractError(t, response, http.StatusForbidden, "CSRF_INVALID", nil)
		assertAuthenticatedUserHeader(t, response, contractUserID)
	})

	t.Run("session refresh identifies the authenticated user", func(t *testing.T) {
		sessions := authenticatedContractSessions()
		sessions.refresh = func(context.Context, string) (appsession.View, error) {
			return appsession.View{
				UserID:    contractUserID,
				CSRFToken: "rotated-csrf",
			}, nil
		}
		router := contractRouter(sessions, &contractWorkspaceStub{}, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodGet, "/api/v1/session", "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
		})
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertAuthenticatedUserHeader(t, response, contractUserID)
	})

	t.Run("Google login identifies source user while returning target user", func(t *testing.T) {
		accounts := &contractAccountStub{login: func(context.Context, string, string) (account.View, error) {
			return account.View{
				UserID:          contractOtherUserID,
				GoogleConnected: true,
				SessionToken:    "login-session",
				CSRFToken:       "login-csrf",
			}, nil
		}}
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, accounts, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/auth/google/login", `{"idToken":"google-token"}`, addContractAuthentication)
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertAuthenticatedUserHeader(t, response, contractUserID)
		var body contractSessionResponse
		decodeContractJSON(t, response, &body)
		if body.User.ID != contractOtherUserID {
			t.Fatalf("login response user = %q", body.User.ID)
		}
	})

	t.Run("account delete identifies the deleted source user", func(t *testing.T) {
		accounts := &contractAccountStub{delete: func(context.Context, user.ID, bool) error {
			return nil
		}}
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, accounts, nil)
		response := serveContract(router, http.MethodDelete, "/api/v1/account", `{"confirmed":true}`, addContractAuthentication)
		if response.Code != http.StatusNoContent {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertAuthenticatedUserHeader(t, response, contractUserID)
	})

	t.Run("missing authentication does not invent a user", func(t *testing.T) {
		sessions := &contractSessionStub{
			authenticate: func(context.Context, string) (appsession.AuthenticatedSession, error) {
				panic("Authenticate must not run without a cookie")
			},
		}
		router := contractRouter(sessions, &contractWorkspaceStub{}, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodGet, "/api/v1/home", "", nil)
		assertContractError(t, response, http.StatusUnauthorized, "SESSION_MISSING", nil)
		assertNoAuthenticatedUserHeader(t, response)
		assertNoStore(t, response)
	})

	t.Run("anonymous bootstrap does not claim an authenticated source user", func(t *testing.T) {
		sessions := &contractSessionStub{
			createAnonymous: func(context.Context, appsession.CreateAnonymousInput) (appsession.View, error) {
				return appsession.View{
					UserID:       contractUserID,
					CSRFToken:    contractCSRFToken,
					SessionToken: contractSessionToken,
				}, nil
			},
		}
		router := contractRouter(sessions, &contractWorkspaceStub{}, nil, nil)
		response := serveContract(router, http.MethodPost, "/api/v1/session/anonymous",
			`{"bootstrapId":"`+contractOperationID+`","turnstileToken":"turnstile-token"}`,
			func(request *http.Request) { request.Header.Set("Origin", contractOrigin) })
		if response.Code != http.StatusCreated {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertNoAuthenticatedUserHeader(t, response)
		assertNoStore(t, response)
	})

	t.Run("unmatched API response is not cacheable", func(t *testing.T) {
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodGet, "/api/v1/not-a-route", "", nil)
		if response.Code != http.StatusNotFound {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertNoAuthenticatedUserHeader(t, response)
		assertNoStore(t, response)
	})

	t.Run("health does not claim an authenticated source user", func(t *testing.T) {
		router := contractRouter(authenticatedContractSessions(), &contractWorkspaceStub{}, &contractAccountStub{}, nil)
		response := serveContract(router, http.MethodGet, "/healthz", "", func(request *http.Request) {
			request.AddCookie(contractSessionCookie())
		})
		if response.Code != http.StatusOK {
			t.Fatalf("response = %d %s", response.Code, response.Body.String())
		}
		assertNoAuthenticatedUserHeader(t, response)
		if got := response.Header().Get("Cache-Control"); got != "" {
			t.Fatalf("health Cache-Control = %q, want empty", got)
		}
	})
}

type contractErrorEnvelope struct {
	Error struct {
		Code      string         `json:"code"`
		Message   string         `json:"message"`
		RequestID string         `json:"requestId"`
		Details   map[string]any `json:"details,omitempty"`
	} `json:"error"`
}

type contractSessionResponse struct {
	User struct {
		ID              string  `json:"id"`
		GoogleConnected bool    `json:"googleConnected"`
		GoogleEmail     *string `json:"googleEmail"`
	} `json:"user"`
	CSRFToken string `json:"csrfToken"`
}

func contractRouter(sessions httpapi.SessionService, spaces httpapi.WorkspaceService, accounts httpapi.AccountService, logger *slog.Logger) http.Handler {
	return httpapi.NewRouter(httpapi.Dependencies{
		Sessions: sessions, Workspace: spaces, Account: accounts,
		PublicOrigin: contractOrigin, Logger: logger,
	})
}

func authenticatedContractSessions() *contractSessionStub {
	return &contractSessionStub{
		authenticate: func(_ context.Context, token string) (appsession.AuthenticatedSession, error) {
			if token != contractSessionToken {
				return appsession.AuthenticatedSession{}, appsession.ErrSessionExpired
			}
			return appsession.AuthenticatedSession{ID: contractSessionID, UserID: user.ID(contractUserID)}, nil
		},
		verifyCSRF: func(_ appsession.AuthenticatedSession, token string) error {
			if token != contractCSRFToken {
				return appsession.ErrCSRFInvalid
			}
			return nil
		},
	}
}

func serveContract(router http.Handler, method, path, body string, configure func(*http.Request)) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("X-Request-ID", contractRequestID)
	if body != "" {
		request.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if configure != nil {
		configure(request)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func addContractAuthentication(request *http.Request) {
	request.AddCookie(contractSessionCookie())
	request.Header.Set("Origin", contractOrigin)
	request.Header.Set("X-CSRF-Token", contractCSRFToken)
}

func contractSessionCookie() *http.Cookie {
	return &http.Cookie{Name: contractCookieName, Value: contractSessionToken, Path: "/"}
}

func assertContractError(t *testing.T, response *httptest.ResponseRecorder, status int, code string, details map[string]any) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d: %s", response.Code, status, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := response.Header().Get("X-Request-ID"); got != contractRequestID {
		t.Fatalf("X-Request-ID = %q", got)
	}
	var envelope contractErrorEnvelope
	decodeContractJSON(t, response, &envelope)
	if envelope.Error.Code != code || envelope.Error.RequestID != contractRequestID || envelope.Error.Message == "" {
		t.Fatalf("error = %#v", envelope.Error)
	}
	if !reflect.DeepEqual(envelope.Error.Details, details) {
		t.Fatalf("details = %#v, want %#v", envelope.Error.Details, details)
	}
}

func assertAuthenticatedUserHeader(t *testing.T, response *httptest.ResponseRecorder, want string) {
	t.Helper()
	if got := response.Header().Get(contractUserIDHeader); got != want {
		t.Fatalf("%s = %q, want %q", contractUserIDHeader, got, want)
	}
	assertNoStore(t, response)
}

func assertNoAuthenticatedUserHeader(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if got := response.Header().Get(contractUserIDHeader); got != "" {
		t.Fatalf("%s = %q, want empty", contractUserIDHeader, got)
	}
}

func assertNoStore(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want %q", got, "no-store")
	}
}

func decodeContractJSON(t *testing.T, response *httptest.ResponseRecorder, destination any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), destination); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
}

func findContractCookie(t *testing.T, response *http.Response) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Cookies() {
		if cookie.Name == contractCookieName {
			return cookie
		}
	}
	t.Fatalf("%s cookie not found in %q", contractCookieName, response.Header.Get("Set-Cookie"))
	return nil
}

func assertSessionCookie(t *testing.T, cookie *http.Cookie, value string) {
	t.Helper()
	if cookie.Name != contractCookieName || cookie.Value != value || cookie.Path != "/" || cookie.Domain != "" ||
		!cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != 0 {
		t.Fatalf("session cookie = %#v", cookie)
	}
}
