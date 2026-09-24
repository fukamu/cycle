package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/launchgate"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	"github.com/fukamu/cycle/backend/internal/httpapi"
)

type contractLaunchGateStub struct {
	decision launchgate.Decision
	err      error
	userID   user.ID
	calls    int
}

func (stub *contractLaunchGateStub) Check(_ context.Context, userID user.ID) (launchgate.Decision, error) {
	stub.calls++
	stub.userID = userID
	return stub.decision, stub.err
}

func launchGateRouter(gate httpapi.LaunchGateService, spaces httpapi.WorkspaceService, production bool) http.Handler {
	return httpapi.NewRouter(httpapi.Dependencies{
		Sessions: authenticatedContractSessions(), Workspace: spaces, LaunchGate: gate,
		PublicOrigin: contractOrigin, Production: production,
	})
}

func TestLaunchStatusDecisionMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name                    string
		public, allowed, access bool
	}{
		{"closed allowed", false, true, true},
		{"closed denied", false, false, false},
		{"public allowed", true, true, true},
		{"public unlisted", true, false, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			gate := &contractLaunchGateStub{decision: launchgate.Decision{
				PublicAccessEnabled: test.public, UserAllowed: test.allowed, CanAccess: test.access,
			}}
			response := serveContract(
				launchGateRouter(gate, &contractWorkspaceStub{}, true),
				http.MethodGet,
				"/api/v1/launch-status",
				"",
				func(request *http.Request) { request.AddCookie(contractSessionCookie()) },
			)
			if response.Code != http.StatusOK {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			var payload struct {
				PublicAccessEnabled bool `json:"publicAccessEnabled"`
				UserAllowed         bool `json:"userAllowed"`
				CanAccess           bool `json:"canAccess"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if payload.PublicAccessEnabled != test.public || payload.UserAllowed != test.allowed || payload.CanAccess != test.access {
				t.Fatalf("payload = %#v", payload)
			}
			if gate.userID != user.ID(contractUserID) || gate.calls != 1 {
				t.Fatalf("gate identity/calls = %q/%d", gate.userID, gate.calls)
			}
			if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Vary") != "Cookie" {
				t.Fatalf("cache headers = %q/%q", response.Header().Get("Cache-Control"), response.Header().Get("Vary"))
			}
			if response.Header().Get(contractUserIDHeader) != contractUserID {
				t.Fatal("authenticated response identity is missing")
			}
		})
	}
}

func TestLaunchStatusRequiresAuthenticatedSessionBeforeGate(t *testing.T) {
	t.Parallel()
	gate := &contractLaunchGateStub{decision: launchgate.Decision{PublicAccessEnabled: true, CanAccess: true}}
	response := serveContract(
		launchGateRouter(gate, &contractWorkspaceStub{}, true),
		http.MethodGet,
		"/api/v1/launch-status",
		"",
		nil,
	)
	if response.Code != http.StatusUnauthorized || gate.calls != 0 {
		t.Fatalf("response/gate calls = %d/%d: %s", response.Code, gate.calls, response.Body.String())
	}
	var envelope contractErrorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "SESSION_MISSING" {
		t.Fatalf("error code = %q", envelope.Error.Code)
	}
}

func TestLaunchGateEnforcesDirectBusinessAPIAndFailsClosed(t *testing.T) {
	t.Parallel()
	homeCalls := 0
	spaces := &contractWorkspaceStub{home: func(context.Context, string) (workspace.HomeView, error) {
		homeCalls++
		return workspace.HomeView{}, nil
	}}

	for _, test := range []struct {
		name       string
		gate       httpapi.LaunchGateService
		production bool
		wantStatus int
		wantCode   string
	}{
		{
			name: "unlisted",
			gate: &contractLaunchGateStub{decision: launchgate.Decision{
				PublicAccessEnabled: false, UserAllowed: false, CanAccess: false,
			}},
			production: true, wantStatus: http.StatusForbidden, wantCode: "LAUNCH_ACCESS_DENIED",
		},
		{
			name: "repository unavailable", gate: &contractLaunchGateStub{err: errors.New("private database error")},
			production: true, wantStatus: http.StatusServiceUnavailable, wantCode: "LAUNCH_GATE_UNAVAILABLE",
		},
		{
			name: "missing production composition", gate: nil,
			production: true, wantStatus: http.StatusServiceUnavailable, wantCode: "LAUNCH_GATE_UNAVAILABLE",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := serveContract(
				launchGateRouter(test.gate, spaces, test.production),
				http.MethodGet,
				"/api/v1/home",
				"",
				func(request *http.Request) { request.AddCookie(contractSessionCookie()) },
			)
			if response.Code != test.wantStatus {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			var envelope contractErrorEnvelope
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Error.Code != test.wantCode || envelope.Error.Message == "" || envelope.Error.RequestID == "" {
				t.Fatalf("error = %#v", envelope.Error)
			}
		})
	}
	if homeCalls != 0 {
		t.Fatalf("business handler calls = %d, want 0", homeCalls)
	}
}

func TestLaunchGateAllowsDirectBusinessAPIForAllowlistOrPublicAccess(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name     string
		decision launchgate.Decision
	}{
		{name: "allowlisted while closed", decision: launchgate.Decision{UserAllowed: true, CanAccess: true}},
		{name: "unlisted after general availability", decision: launchgate.Decision{PublicAccessEnabled: true, CanAccess: true}},
	} {
		t.Run(test.name, func(t *testing.T) {
			homeCalls := 0
			spaces := &contractWorkspaceStub{home: func(_ context.Context, userID string) (workspace.HomeView, error) {
				homeCalls++
				if userID != contractUserID {
					t.Fatalf("user ID = %q", userID)
				}
				return workspace.HomeView{ProgressingGoals: []workspace.GoalView{}}, nil
			}}
			gate := &contractLaunchGateStub{decision: test.decision}
			response := serveContract(
				launchGateRouter(gate, spaces, true),
				http.MethodGet,
				"/api/v1/home",
				"",
				func(request *http.Request) { request.AddCookie(contractSessionCookie()) },
			)
			if response.Code != http.StatusOK || homeCalls != 1 {
				t.Fatalf("response/calls = %d/%d: %s", response.Code, homeCalls, response.Body.String())
			}
		})
	}
}
