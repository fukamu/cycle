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
	"github.com/fukamu/cycle/backend/internal/domain/user"
	"github.com/fukamu/cycle/backend/internal/httpapi"
)

const (
	contractOrigin       = "https://cycle.example.test"
	contractRequestID    = "0198c20b-7b95-7000-8000-000000000001"
	contractSessionID    = "10000000-0000-7000-8000-000000000001"
	contractUserID       = "20000000-0000-7000-8000-000000000001"
	contractOtherUserID  = "20000000-0000-7000-8000-000000000002"
	contractDraftID      = "30000000-0000-7000-8000-000000000001"
	contractGoalID       = "40000000-0000-7000-8000-000000000001"
	contractCycleID      = "50000000-0000-7000-8000-000000000001"
	contractGenerationID = "60000000-0000-7000-8000-000000000001"
	contractOperationID  = "70000000-0000-7000-8000-000000000001"
	contractSessionToken = "opaque-session-token"
	contractCSRFToken    = "opaque-csrf-token"
	contractCookieName   = "__Host-fukamu_cycle_session"
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
	home        func(context.Context, string) (workspace.HomeView, error)
	createDraft func(context.Context, string, string) (workspace.DraftView, error)
	saveDraft   func(context.Context, string, string, string, int64) (workspace.DraftView, error)
	getGoal     func(context.Context, string, string) (workspace.GoalView, error)
	refineGoal  func(context.Context, workspace.GoalRefineInput) (workspace.AIResponse, error)
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

func (stub *contractWorkspaceStub) GetGoal(ctx context.Context, userID, goalID string) (workspace.GoalView, error) {
	if stub.getGoal == nil {
		panic("unexpected GetGoal call")
	}
	return stub.getGoal(ctx, userID, goalID)
}

func (stub *contractWorkspaceStub) RefineGoal(ctx context.Context, input workspace.GoalRefineInput) (workspace.AIResponse, error) {
	if stub.refineGoal == nil {
		panic("unexpected RefineGoal call")
	}
	return stub.refineGoal(ctx, input)
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
