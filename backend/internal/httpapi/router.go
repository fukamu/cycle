package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	"github.com/matoruru/PDCAI/backend/internal/application/ports"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

const sessionCookieName = "__Host-pdcai_session"

type SessionService interface {
	Authenticate(context.Context, string) (appsession.AuthenticatedSession, error)
	Refresh(context.Context, string) (appsession.View, error)
	CreateAnonymous(context.Context, appsession.CreateAnonymousInput) (appsession.View, error)
	VerifyCSRF(appsession.AuthenticatedSession, string) error
}

type CycleService interface {
	GetActive(context.Context, user.ID) (domaincycle.PDCACycle, error)
	SaveFrame(context.Context, user.ID, domaincycle.ID, domaincycle.Frame, string, int64) (domaincycle.SaveFrameResult, error)
	Complete(context.Context, user.ID, domaincycle.ID, domaincycle.OperationID, int64) (domaincycle.CompleteResult, error)
	GetCompleted(context.Context, user.ID, domaincycle.ID) (domaincycle.PDCACycle, error)
	ListCompleted(context.Context, user.ID, string, int) (appcycle.CompletedPage, error)
}

type GenerateActionService interface {
	Execute(context.Context, appai.GenerateCommand) (appai.Result, error)
}

type RefineActionService interface {
	Execute(context.Context, appai.RefineCommand) (appai.Result, error)
}

type Metrics interface {
	ObserveHTTP(context.Context, string, int, time.Duration)
	ObserveAutosave(context.Context, string, time.Duration)
	CycleCompleted(context.Context)
	AccountUpgrade(context.Context, string)
	AccountDelete(context.Context, string)
	AnonymousCreate(context.Context, string)
	RateLimitRejected(context.Context, string)
	ErrorCode(context.Context, string)
}

type Dependencies struct {
	Sessions       SessionService
	Cycles         CycleService
	Account        AccountService
	GenerateAction GenerateActionService
	RefineAction   RefineActionService
	RequestIDs     ports.IDGenerator
	PublicOrigin   string
	Ready          func(context.Context) error
	Logger         *slog.Logger
	Production     bool
	TrustProxy     bool
	StaticDir      string
	Metrics        Metrics
}

type api struct {
	dependencies Dependencies
}

func NewRouter(dependencies Dependencies) http.Handler {
	server := &api{dependencies: dependencies}
	router := chi.NewRouter()
	router.Use(server.requestIDMiddleware)
	router.Use(server.requestLogMiddleware)
	router.Use(server.securityHeaders)
	router.Get("/healthz", healthHandler)
	router.Get("/readyz", server.readyHandler)
	if dependencies.Sessions == nil || dependencies.Cycles == nil {
		if dependencies.StaticDir != "" {
			router.Handle("/*", newSPAHandler(dependencies.StaticDir))
		}
		return otelhttp.NewHandler(router, "http.request")
	}

	router.Route("/api/v1", func(v1 chi.Router) {
		v1.Post("/session/anonymous", server.createAnonymous)
		v1.Group(func(protected chi.Router) {
			protected.Use(server.authenticateMiddleware)
			protected.Get("/session", server.getSession)
			protected.Get("/cycles/active", server.getActiveCycle)
			protected.Get("/cycles", server.listCompletedCycles)
			protected.Get("/cycles/{cycleId}", server.getCompletedCycle)
			protected.With(server.csrfMiddleware).Patch("/cycles/{cycleId}/frames/{frame}", server.saveFrame)
			if dependencies.GenerateAction != nil && dependencies.RefineAction != nil {
				protected.With(server.csrfMiddleware).Post("/cycles/{cycleId}/actions/generate", server.generateAction)
				protected.With(server.csrfMiddleware).Post("/cycles/{cycleId}/actions/refine", server.refineAction)
			}
			if dependencies.Account != nil {
				protected.With(server.csrfMiddleware).Post("/auth/google/upgrade", server.upgradeGoogle)
				protected.With(server.csrfMiddleware).Post("/auth/google/login", server.loginGoogle)
				protected.With(server.csrfMiddleware).Delete("/account", server.deleteAccount)
			}
			protected.With(server.csrfMiddleware).Post("/cycles/{cycleId}/complete", server.completeCycle)
		})
	})
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
