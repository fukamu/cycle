package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/httpapi"
	"github.com/fukamu/cycle/backend/internal/infrastructure/system"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	contractIntegrationOrigin      = "https://cycle.integration.test"
	contractIntegrationRequestID   = "0198c20b-7b95-7000-8000-000000000001"
	contractIntegrationBootstrapID = "0198c20b-7b95-7000-8000-000000000002"
	contractIntegrationCookieName  = "__Host-fukamu_cycle_session"
)

type contractIntegrationClock struct {
	now time.Time
}

func (clock contractIntegrationClock) Now() time.Time { return clock.now }

type contractNoCallWorkspace struct {
	httpapi.WorkspaceService
}

type contractRejectProvider struct {
	calls int
}

func (provider *contractRejectProvider) Execute(context.Context, workspace.AIProviderRequest) (workspace.AIProviderResult, error) {
	provider.calls++
	return workspace.AIProviderResult{}, errors.New("provider must not be called for another user's resource")
}

type contractIntegrationClient struct {
	userID string
	csrf   string
	cookie *http.Cookie
}

type contractBootstrapResult struct {
	status int
	body   string
	userID string
	csrf   string
	cookie *http.Cookie
	err    error
}

func TestAnonymousBootstrapConcurrentRetriesConverge(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	router := newContractIntegrationRouter(pool, &contractNoCallWorkspace{})

	const attempts = 4
	start := make(chan struct{})
	results := make(chan contractBootstrapResult, attempts)
	var wait sync.WaitGroup
	for index := 0; index < attempts; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results <- performContractBootstrap(router, contractIntegrationBootstrapID, nil)
		}()
	}
	close(start)
	wait.Wait()
	close(results)

	users := map[string]struct{}{}
	cookies := map[string]struct{}{}
	var reusable *http.Cookie
	for result := range results {
		if result.err != nil || result.status != http.StatusCreated {
			t.Fatalf("bootstrap result = status %d, error %v, body %s", result.status, result.err, result.body)
		}
		if result.userID == "" || result.csrf == "" || result.cookie == nil || result.cookie.Value == "" {
			t.Fatalf("incomplete bootstrap result = %#v", result)
		}
		users[result.userID] = struct{}{}
		cookies[result.cookie.Value] = struct{}{}
		if reusable == nil {
			reusable = result.cookie
		}
	}
	if len(users) != 1 {
		t.Fatalf("bootstrap user IDs = %#v, want one", users)
	}
	if len(cookies) != attempts {
		t.Fatalf("unique session cookies = %d, want %d", len(cookies), attempts)
	}

	cardinality := readBootstrapCardinality(t, pool)
	if cardinality.users != 1 || cardinality.bootstraps != 1 || cardinality.sessions != attempts || cardinality.sessionUsers != 1 {
		t.Fatalf("bootstrap cardinality = %#v", cardinality)
	}
	if cardinality.goals != 0 || cardinality.versions != 0 || cardinality.cycles != 0 || cardinality.drafts != 0 {
		t.Fatalf("bootstrap created workspace data: %#v", cardinality)
	}

	reused := performContractBootstrap(router, contractIntegrationBootstrapID, reusable)
	if reused.err != nil || reused.status != http.StatusOK {
		t.Fatalf("existing-session bootstrap = status %d, error %v, body %s", reused.status, reused.err, reused.body)
	}
	for userID := range users {
		if reused.userID != userID {
			t.Fatalf("reused user = %s, want %s", reused.userID, userID)
		}
	}
	afterReuse := readBootstrapCardinality(t, pool)
	if afterReuse.sessions != attempts || afterReuse.users != 1 || afterReuse.bootstraps != 1 {
		t.Fatalf("existing cookie created another record: %#v", afterReuse)
	}
}

func TestWorkspaceHTTPContractHidesOwnerResourcesFromAnotherSession(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const ownerID = "10000000-0000-7000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, ownerID, now); err != nil {
		t.Fatal(err)
	}

	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})
	fixtures := progressingGoalFixtures()
	active := startProgressingGoal(t, store, ownerID, fixtures[0], 2, now)
	if _, err := executeGoalDraftCreateUseCase(store, context.Background(), ownerID, fixtures[1].draftID, "所有者だけの下書き", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	provider := &contractRejectProvider{}
	service := workspace.NewService(store, store, store, store, store, store, store, provider, contractIntegrationClock{now: now.Add(2 * time.Minute)}, system.RandomGenerator{}, workspace.Settings{
		MaxProgressingGoals: 2,
		CursorSigningKey:    []byte("test-cursor-key"),
		MaxProviderAttempts: 1,
	})
	router := newContractIntegrationRouter(pool, service)
	outsider := bootstrapContractClient(t, router, "0198c20b-7b95-7000-8000-000000000003")

	beforeDraft, err := store.GetDraft(context.Background(), ownerID, fixtures[1].draftID)
	if err != nil {
		t.Fatal(err)
	}
	beforeGoal, err := executeGoalGetUseCase(store, context.Background(), ownerID, fixtures[0].goalID, now)
	if err != nil {
		t.Fatal(err)
	}
	beforeCycle, err := executeCycleGetUseCase(store, context.Background(), ownerID, fixtures[0].goalID, fixtures[0].cycleID, now)
	if err != nil {
		t.Fatal(err)
	}
	beforeCounts := readOwnerWorkspaceCounts(t, pool, ownerID)

	for _, path := range []string{"/api/v1/home", "/api/v1/goals"} {
		response := performContractAuthorized(router, outsider, http.MethodGet, path, "", "")
		if response.Code != http.StatusOK {
			t.Fatalf("%s = %d %s", path, response.Code, response.Body.String())
		}
		body := response.Body.String()
		if strings.Contains(body, fixtures[0].goalID) || strings.Contains(body, fixtures[1].draftID) || strings.Contains(body, fixtures[0].body) || strings.Contains(body, "所有者だけの下書き") {
			t.Fatalf("%s leaked owner data: %s", path, body)
		}
	}

	newOperation := func() string {
		id, idErr := (system.RandomGenerator{}).NewID()
		if idErr != nil {
			t.Fatal(idErr)
		}
		return id
	}
	generationID := newOperation()
	tests := []struct {
		name           string
		method         string
		path           string
		body           string
		idempotencyKey string
		code           string
	}{
		{"get draft", http.MethodGet, "/api/v1/goal-drafts/" + fixtures[1].draftID, "", "", "GOAL_DRAFT_NOT_FOUND"},
		{"save draft", http.MethodPatch, "/api/v1/goal-drafts/" + fixtures[1].draftID, `{"body":"外部更新","expectedRevision":0}`, "", "GOAL_DRAFT_NOT_FOUND"},
		{"abandon draft", http.MethodDelete, "/api/v1/goal-drafts/" + fixtures[1].draftID, "", "", "GOAL_DRAFT_NOT_FOUND"},
		{"refine draft", http.MethodPost, "/api/v1/goal-drafts/" + fixtures[1].draftID + "/refinements", `{"expectedDraftRevision":0}`, newOperation(), "GOAL_DRAFT_NOT_FOUND"},
		{"adopt draft", http.MethodPost, "/api/v1/goal-drafts/" + fixtures[1].draftID + "/refinements/" + generationID + "/adopt", `{"expectedDraftRevision":0}`, "", "GOAL_DRAFT_NOT_FOUND"},
		{"start goal", http.MethodPost, "/api/v1/goal-drafts/" + fixtures[1].draftID + "/start", fmt.Sprintf(`{"operationId":%q,"expectedDraftRevision":0}`, newOperation()), "", "GOAL_DRAFT_NOT_FOUND"},
		{"get goal", http.MethodGet, "/api/v1/goals/" + fixtures[0].goalID, "", "", "GOAL_NOT_FOUND"},
		{"get review", http.MethodGet, "/api/v1/goals/" + fixtures[0].goalID + "/review", "", "", "GOAL_NOT_FOUND"},
		{"save review", http.MethodPatch, "/api/v1/goals/" + fixtures[0].goalID + "/review", fmt.Sprintf(`{"body":"外部更新","expectedReviewDraftId":%q,"expectedRevision":0}`, fixtures[1].draftID), "", "GOAL_NOT_FOUND"},
		{"refine review", http.MethodPost, "/api/v1/goals/" + fixtures[0].goalID + "/review/refinements", `{"expectedDraftRevision":0,"expectedGoalRevision":0}`, newOperation(), "GOAL_NOT_FOUND"},
		{"adopt review", http.MethodPost, "/api/v1/goals/" + fixtures[0].goalID + "/review/refinements/" + generationID + "/adopt", `{"expectedDraftRevision":0,"expectedGoalRevision":0}`, "", "GOAL_NOT_FOUND"},
		{"continue review", http.MethodPost, "/api/v1/goals/" + fixtures[0].goalID + "/review/continue", fmt.Sprintf(`{"operationId":%q,"expectedGoalRevision":0,"expectedDraftRevision":0}`, newOperation()), "", "GOAL_NOT_FOUND"},
		{"terminate goal", http.MethodPost, "/api/v1/goals/" + fixtures[0].goalID + "/termination", fmt.Sprintf(`{"operationId":%q,"outcome":"ended","expectedGoalRevision":0,"expectedState":"active_cycle","activeCycleId":%q,"expectedCycleContentRevision":0}`, newOperation(), fixtures[0].cycleID), "", "GOAL_NOT_FOUND"},
		{"delete goal", http.MethodDelete, "/api/v1/goals/" + fixtures[0].goalID, `{"confirmed":true,"expectedGoalRevision":0}`, newOperation(), "GOAL_NOT_FOUND"},
		{"list cycles", http.MethodGet, "/api/v1/goals/" + fixtures[0].goalID + "/cycles", "", "", "GOAL_NOT_FOUND"},
		{"get cycle", http.MethodGet, "/api/v1/goals/" + fixtures[0].goalID + "/cycles/" + fixtures[0].cycleID, "", "", "GOAL_NOT_FOUND"},
		{"save frame", http.MethodPatch, "/api/v1/goals/" + fixtures[0].goalID + "/cycles/" + fixtures[0].cycleID + "/frames/plan", `{"content":"外部更新","expectedFrameRevision":0}`, "", "GOAL_NOT_FOUND"},
		{"generate action", http.MethodPost, "/api/v1/goals/" + fixtures[0].goalID + "/cycles/" + fixtures[0].cycleID + "/actions/generate", `{"expectedContentRevision":0,"confirmReplace":false}`, newOperation(), "CYCLE_NOT_FOUND"},
		{"refine action", http.MethodPost, "/api/v1/goals/" + fixtures[0].goalID + "/cycles/" + fixtures[0].cycleID + "/actions/refine", `{"expectedContentRevision":0}`, newOperation(), "CYCLE_NOT_FOUND"},
		{"complete cycle", http.MethodPost, "/api/v1/goals/" + fixtures[0].goalID + "/cycles/" + fixtures[0].cycleID + "/complete", fmt.Sprintf(`{"operationId":%q,"expectedGoalRevision":0,"expectedContentRevision":0}`, newOperation()), "", "GOAL_NOT_FOUND"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performContractAuthorized(router, outsider, test.method, test.path, test.body, test.idempotencyKey)
			if response.Code != http.StatusNotFound {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Error.Code != test.code {
				t.Fatalf("error envelope = %#v, decode error = %v, want %s", envelope, err, test.code)
			}
		})
	}

	afterDraft, err := store.GetDraft(context.Background(), ownerID, fixtures[1].draftID)
	if err != nil {
		t.Fatal(err)
	}
	afterGoal, err := executeGoalGetUseCase(store, context.Background(), ownerID, fixtures[0].goalID, now)
	if err != nil {
		t.Fatal(err)
	}
	afterCycle, err := executeCycleGetUseCase(store, context.Background(), ownerID, fixtures[0].goalID, fixtures[0].cycleID, now)
	if err != nil {
		t.Fatal(err)
	}
	afterCounts := readOwnerWorkspaceCounts(t, pool, ownerID)
	if !reflect.DeepEqual(beforeDraft, afterDraft) || !reflect.DeepEqual(beforeGoal, afterGoal) || !reflect.DeepEqual(beforeCycle, afterCycle) || beforeCounts != afterCounts {
		t.Fatalf("owner state changed\nbefore draft/goal/cycle/counts: %#v / %#v / %#v / %#v\nafter: %#v / %#v / %#v / %#v",
			beforeDraft, beforeGoal, beforeCycle, beforeCounts, afterDraft, afterGoal, afterCycle, afterCounts)
	}
	if provider.calls != 0 {
		t.Fatalf("provider calls = %d", provider.calls)
	}
	if active.Goal.ID != fixtures[0].goalID || active.Cycle.ID != fixtures[0].cycleID {
		t.Fatalf("fixture changed unexpectedly: %#v", active)
	}
}

func TestWorkspaceHTTPCycleHierarchyReturnsCycleNotFoundForOwnedGoalMismatch(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})
	provider := &contractRejectProvider{}
	service := workspace.NewService(store, store, store, store, store, store, store, provider,
		contractIntegrationClock{now: now.Add(2 * time.Minute)}, system.RandomGenerator{}, workspace.Settings{
			MaxProgressingGoals: 2,
			CursorSigningKey:    []byte("test-cursor-key"),
			MaxProviderAttempts: 1,
		})
	router := newContractIntegrationRouter(pool, service)
	owner := bootstrapContractClient(t, router, "0198c20b-7b95-7000-8000-000000000004")
	fixtures := progressingGoalFixtures()
	first := startProgressingGoal(t, store, owner.userID, fixtures[0], 2, now)
	_ = startProgressingGoal(t, store, owner.userID, fixtures[1], 2, now.Add(time.Minute))
	beforeCounts := readOwnerWorkspaceCounts(t, pool, owner.userID)
	beforeFirstGoal, err := executeGoalGetUseCase(store, context.Background(), owner.userID, fixtures[0].goalID, now)
	if err != nil {
		t.Fatal(err)
	}
	beforeSecondGoal, err := executeGoalGetUseCase(store, context.Background(), owner.userID, fixtures[1].goalID, now)
	if err != nil {
		t.Fatal(err)
	}
	beforeFirstCycle, err := executeCycleGetUseCase(store, context.Background(), owner.userID, fixtures[0].goalID, fixtures[0].cycleID, now)
	if err != nil {
		t.Fatal(err)
	}
	beforeSecondCycle, err := executeCycleGetUseCase(store, context.Background(), owner.userID, fixtures[1].goalID, fixtures[1].cycleID, now)
	if err != nil {
		t.Fatal(err)
	}

	operationID, err := (system.RandomGenerator{}).NewID()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"get cycle", http.MethodGet, "/api/v1/goals/" + fixtures[0].goalID + "/cycles/" + fixtures[1].cycleID, ""},
		{"save frame", http.MethodPatch, "/api/v1/goals/" + fixtures[0].goalID + "/cycles/" + fixtures[1].cycleID + "/frames/plan", `{"content":"外部更新","expectedFrameRevision":0}`},
		{"complete cycle with stale Goal revision", http.MethodPost, "/api/v1/goals/" + fixtures[0].goalID + "/cycles/" + fixtures[1].cycleID + "/complete", fmt.Sprintf(`{"operationId":%q,"expectedGoalRevision":%d,"expectedContentRevision":0}`, operationID, first.Goal.Revision+1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performContractAuthorized(router, owner, test.method, test.path, test.body, "")
			if response.Code != http.StatusNotFound {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Error.Code != "CYCLE_NOT_FOUND" {
				t.Fatalf("error envelope = %#v, decode error = %v", envelope, err)
			}
		})
	}
	if afterCounts := readOwnerWorkspaceCounts(t, pool, owner.userID); afterCounts != beforeCounts {
		t.Fatalf("owner state changed: before=%#v after=%#v", beforeCounts, afterCounts)
	}
	afterFirstGoal, err := executeGoalGetUseCase(store, context.Background(), owner.userID, fixtures[0].goalID, now)
	if err != nil {
		t.Fatal(err)
	}
	afterSecondGoal, err := executeGoalGetUseCase(store, context.Background(), owner.userID, fixtures[1].goalID, now)
	if err != nil {
		t.Fatal(err)
	}
	afterFirstCycle, err := executeCycleGetUseCase(store, context.Background(), owner.userID, fixtures[0].goalID, fixtures[0].cycleID, now)
	if err != nil {
		t.Fatal(err)
	}
	afterSecondCycle, err := executeCycleGetUseCase(store, context.Background(), owner.userID, fixtures[1].goalID, fixtures[1].cycleID, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(beforeFirstGoal, afterFirstGoal) || !reflect.DeepEqual(beforeSecondGoal, afterSecondGoal) ||
		!reflect.DeepEqual(beforeFirstCycle, afterFirstCycle) || !reflect.DeepEqual(beforeSecondCycle, afterSecondCycle) {
		t.Fatalf("owned Goal/Cycle mismatch changed state\nbefore: %#v / %#v / %#v / %#v\nafter: %#v / %#v / %#v / %#v",
			beforeFirstGoal, beforeSecondGoal, beforeFirstCycle, beforeSecondCycle,
			afterFirstGoal, afterSecondGoal, afterFirstCycle, afterSecondCycle)
	}
	if provider.calls != 0 {
		t.Fatalf("provider calls = %d", provider.calls)
	}
}

type bootstrapCardinality struct {
	users        int
	bootstraps   int
	sessions     int
	sessionUsers int
	goals        int
	versions     int
	cycles       int
	drafts       int
}

func readBootstrapCardinality(t *testing.T, pool *pgxpool.Pool) bootstrapCardinality {
	t.Helper()
	var result bootstrapCardinality
	err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users),
(SELECT count(*) FROM anonymous_bootstraps),
(SELECT count(*) FROM sessions),
(SELECT count(DISTINCT user_id) FROM sessions),
(SELECT count(*) FROM goals),
(SELECT count(*) FROM goal_versions),
(SELECT count(*) FROM pdca_cycles),
(SELECT count(*) FROM goal_drafts)`).Scan(
		&result.users, &result.bootstraps, &result.sessions, &result.sessionUsers,
		&result.goals, &result.versions, &result.cycles, &result.drafts,
	)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

type ownerWorkspaceCounts struct {
	goals  int
	cycles int
	drafts int
}

func readOwnerWorkspaceCounts(t *testing.T, pool *pgxpool.Pool, userID string) ownerWorkspaceCounts {
	t.Helper()
	var result ownerWorkspaceCounts
	err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goals WHERE user_id=$1),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1)`, userID).Scan(&result.goals, &result.cycles, &result.drafts)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func newContractIntegrationRouter(pool *pgxpool.Pool, spaces httpapi.WorkspaceService) http.Handler {
	random := system.RandomGenerator{}
	clock := contractIntegrationClock{now: integrationNow()}
	sessions := appsession.NewService(
		NewSessionRepository(pool), clock, random, random, system.AllowAnonymous{},
		appsession.Settings{
			SessionHashKey:     []byte("integration-session-key"),
			CSRFHashKey:        []byte("integration-csrf-key"),
			BootstrapHashKey:   []byte("integration-bootstrap-key"),
			IdleTTL:            30 * 24 * time.Hour,
			AbsoluteTTL:        180 * 24 * time.Hour,
			ActivityTouchAfter: 15 * time.Minute,
			BootstrapTTL:       10 * time.Minute,
		},
	)
	return httpapi.NewRouter(httpapi.Dependencies{
		Sessions: sessions, Workspace: spaces, PublicOrigin: contractIntegrationOrigin,
	})
}

func bootstrapContractClient(t *testing.T, router http.Handler, bootstrapID string) contractIntegrationClient {
	t.Helper()
	result := performContractBootstrap(router, bootstrapID, nil)
	if result.err != nil || result.status != http.StatusCreated || result.cookie == nil {
		t.Fatalf("bootstrap = status %d, error %v, body %s", result.status, result.err, result.body)
	}
	return contractIntegrationClient{userID: result.userID, csrf: result.csrf, cookie: result.cookie}
}

func performContractBootstrap(router http.Handler, bootstrapID string, cookie *http.Cookie) contractBootstrapResult {
	body := fmt.Sprintf(`{"bootstrapId":%q,"turnstileToken":"test-token"}`, bootstrapID)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/session/anonymous", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("Origin", contractIntegrationOrigin)
	request.Header.Set("X-Request-ID", contractIntegrationRequestID)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	result := contractBootstrapResult{status: response.Code, body: response.Body.String()}
	var payload struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
		CSRF string `json:"csrfToken"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		result.err = err
		return result
	}
	result.userID = payload.User.ID
	result.csrf = payload.CSRF
	for _, candidate := range response.Result().Cookies() {
		if candidate.Name == contractIntegrationCookieName {
			result.cookie = candidate
			break
		}
	}
	if cookie != nil && result.cookie == nil {
		result.cookie = cookie
	}
	return result
}

func performContractAuthorized(router http.Handler, client contractIntegrationClient, method, path, body, idempotencyKey string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("X-Request-ID", contractIntegrationRequestID)
	request.Header.Set("Origin", contractIntegrationOrigin)
	request.Header.Set("X-CSRF-Token", client.csrf)
	if body != "" {
		request.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	request.AddCookie(client.cookie)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
