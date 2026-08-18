package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/matoruru/PDCAI/backend/internal/application/ports"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
)

const sessionCookieName = "__Host-pdcai_session"

type SessionService interface {
	Authenticate(context.Context, string) (appsession.AuthenticatedSession, error)
	Refresh(context.Context, string) (appsession.View, error)
	CreateAnonymous(context.Context, appsession.CreateAnonymousInput) (appsession.View, error)
	VerifyCSRF(appsession.AuthenticatedSession, string) error
}

type WorkspaceService interface {
	Home(context.Context, string) (workspace.HomeView, error)
	CreateDraft(context.Context, string, string) (workspace.DraftView, error)
	GetDraft(context.Context, string, string) (workspace.DraftView, error)
	SaveDraft(context.Context, string, string, string, int64) (workspace.DraftView, error)
	AbandonDraft(context.Context, string, string) error
	StartGoal(context.Context, string, string, string, int64) (workspace.StartGoalResult, error)
	ListGoals(context.Context, string, string, string, int) (workspace.GoalPage, error)
	GetGoal(context.Context, string, string) (workspace.GoalView, error)
	GetReview(context.Context, string, string) (workspace.ReviewView, error)
	SaveReview(context.Context, string, string, string, int64) (workspace.DraftView, error)
	ContinueReview(context.Context, string, string, string, int64, int64) (workspace.ContinueReviewResult, error)
	Terminate(context.Context, workspace.TerminateInput) (workspace.TerminateResult, error)
	DeleteGoal(context.Context, string, string, bool, int64, string) error
	ListCycles(context.Context, string, string, string, int) (workspace.CyclePage, error)
	GetCycle(context.Context, string, string, string) (workspace.CycleView, error)
	SaveFrame(context.Context, workspace.SaveFrameInput) (workspace.SaveFrameResult, error)
	CompleteCycle(context.Context, workspace.CompleteCycleInput) (workspace.CompleteCycleResult, error)
	RefineGoal(context.Context, workspace.GoalRefineInput) (workspace.AIResponse, error)
	AdoptGoalSuggestion(context.Context, string, string, string, int64, *int64) (workspace.DraftView, error)
	RunActionAI(context.Context, workspace.ActionAIInput) (workspace.AIResponse, error)
}

type Metrics interface {
	ObserveHTTP(context.Context, string, int, time.Duration)
	ObserveAutosave(context.Context, string, time.Duration)
	CycleCompleted(context.Context)
	AccountUpgrade(context.Context, string)
	AccountDelete(context.Context, string)
	AnonymousCreate(context.Context, string)
	RateLimitRejected(context.Context, string)
	AIContextIsolationViolation(context.Context)
	ErrorCode(context.Context, string)
}

type Dependencies struct {
	Sessions     SessionService
	Workspace    WorkspaceService
	Account      AccountService
	RequestIDs   ports.IDGenerator
	PublicOrigin string
	Ready        func(context.Context) error
	Logger       *slog.Logger
	Production   bool
	TrustProxy   bool
	StaticDir    string
	Metrics      Metrics
}

type api struct{ dependencies Dependencies }

func NewRouter(dependencies Dependencies) http.Handler {
	server := &api{dependencies: dependencies}
	router := chi.NewRouter()
	router.Use(server.requestIDMiddleware, server.requestLogMiddleware, server.securityHeaders)
	router.Get("/healthz", healthHandler)
	router.Get("/readyz", server.readyHandler)
	if dependencies.Sessions != nil && dependencies.Workspace != nil {
		router.Route("/api/v1", func(v1 chi.Router) {
			v1.Post("/session/anonymous", server.createAnonymous)
			v1.Group(func(protected chi.Router) {
				protected.Use(server.authenticateMiddleware)
				protected.Get("/session", server.getSession)
				protected.Get("/home", server.getHome)
				protected.Get("/goal-drafts/{draftId}", server.getGoalDraft)
				protected.Get("/goals", server.listGoals)
				protected.Get("/goals/{goalId}", server.getGoal)
				protected.Get("/goals/{goalId}/review", server.getGoalReview)
				protected.Get("/goals/{goalId}/cycles", server.listGoalCycles)
				protected.Get("/goals/{goalId}/cycles/{cycleId}", server.getGoalCycle)
				protected.Group(func(unsafe chi.Router) {
					unsafe.Use(server.csrfMiddleware)
					unsafe.Post("/goal-drafts", server.createGoalDraft)
					unsafe.Patch("/goal-drafts/{draftId}", server.saveGoalDraft)
					unsafe.Delete("/goal-drafts/{draftId}", server.abandonGoalDraft)
					unsafe.Post("/goal-drafts/{draftId}/refinements", server.refineGoalDraft)
					unsafe.Post("/goal-drafts/{draftId}/refinements/{generationId}/adopt", server.adoptGoalDraftSuggestion)
					unsafe.Post("/goal-drafts/{draftId}/start", server.startGoal)
					unsafe.Post("/goals/{goalId}/termination", server.terminateGoal)
					unsafe.Delete("/goals/{goalId}", server.deleteGoal)
					unsafe.Patch("/goals/{goalId}/review", server.saveGoalReview)
					unsafe.Post("/goals/{goalId}/review/refinements", server.refineGoalReview)
					unsafe.Post("/goals/{goalId}/review/refinements/{generationId}/adopt", server.adoptGoalReviewSuggestion)
					unsafe.Post("/goals/{goalId}/review/continue", server.continueGoalReview)
					unsafe.Patch("/goals/{goalId}/cycles/{cycleId}/frames/{frame}", server.saveGoalCycleFrame)
					unsafe.Post("/goals/{goalId}/cycles/{cycleId}/actions/generate", server.generateAction)
					unsafe.Post("/goals/{goalId}/cycles/{cycleId}/actions/refine", server.refineAction)
					unsafe.Post("/goals/{goalId}/cycles/{cycleId}/complete", server.completeGoalCycle)
					if dependencies.Account != nil {
						unsafe.Post("/auth/google/upgrade", server.upgradeGoogle)
						unsafe.Post("/auth/google/login", server.loginGoogle)
						unsafe.Delete("/account", server.deleteAccount)
					}
				})
			})
		})
	}
	if dependencies.StaticDir != "" {
		router.Handle("/*", newSPAHandler(dependencies.StaticDir))
	}
	return otelhttp.NewHandler(router, "http.request")
}

type healthResponse struct {
	Status string `json:"status"`
}

func healthHandler(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, healthResponse{Status: "ok"})
}

func (server *api) readyHandler(writer http.ResponseWriter, request *http.Request) {
	if server.dependencies.Ready != nil {
		if err := server.dependencies.Ready(request.Context()); err != nil {
			writeJSON(writer, http.StatusServiceUnavailable, healthResponse{Status: "not_ready"})
			return
		}
	}
	writeJSON(writer, http.StatusOK, healthResponse{Status: "ok"})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func currentUserID(request *http.Request) string {
	record, _ := authenticatedSession(request.Context())
	return string(record.UserID)
}

func sessionID(request *http.Request) string {
	record, _ := authenticatedSession(request.Context())
	return record.ID
}
