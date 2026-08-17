package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
)

type contextKey string

const (
	requestIDContextKey contextKey = "request_id"
	sessionContextKey   contextKey = "authenticated_session"
)

func (server *api) requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestID := strings.ToLower(strings.TrimSpace(request.Header.Get("X-Request-ID")))
		if !isCanonicalUUID(requestID) {
			requestID = "00000000-0000-4000-8000-000000000000"
			if server.dependencies.RequestIDs != nil {
				if generated, err := server.dependencies.RequestIDs.NewID(); err == nil {
					requestID = generated
				}
			}
		}
		writer.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), requestIDContextKey, requestID)))
	})
}

func (server *api) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		writer.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		writer.Header().Set("X-Frame-Options", "DENY")
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://accounts.google.com https://www.google.com https://www.gstatic.com https://challenges.cloudflare.com; connect-src 'self' https://accounts.google.com https://www.google.com https://challenges.cloudflare.com; frame-src https://accounts.google.com https://www.google.com https://challenges.cloudflare.com; img-src 'self' data: https:; style-src 'self' https://accounts.google.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com")
		if server.dependencies.Production {
			writer.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(writer, request)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (recorder *statusRecorder) WriteHeader(status int) {
	recorder.status = status
	recorder.ResponseWriter.WriteHeader(status)
}

func (server *api) requestLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: writer, status: http.StatusOK}
		next.ServeHTTP(recorder, request)
		duration := time.Since(started)
		route := chi.RouteContext(request.Context()).RoutePattern()
		if route == "" {
			route = "unmatched"
		}
		span := trace.SpanFromContext(request.Context())
		span.SetName(request.Method + " " + route)
		span.SetAttributes(attribute.String("http.route", route), attribute.Int("http.response.status_code", recorder.status))
		if server.dependencies.Metrics != nil {
			server.dependencies.Metrics.ObserveHTTP(request.Context(), route, recorder.status, duration)
		}
		if server.dependencies.Logger == nil {
			return
		}
		server.dependencies.Logger.LogAttrs(request.Context(), slog.LevelInfo, "http request",
			slog.String("request_id", requestID(request.Context())),
			slog.String("trace_id", span.SpanContext().TraceID().String()),
			slog.String("route_template", route),
			slog.String("method", request.Method),
			slog.Int("status_code", recorder.status),
			slog.Int64("latency_ms", duration.Milliseconds()),
		)
	})
}

func (server *api) authenticateMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie(sessionCookieName)
		if err != nil {
			server.writeError(writer, request, appsession.ErrSessionMissing, nil)
			return
		}
		record, err := server.dependencies.Sessions.Authenticate(request.Context(), cookie.Value)
		if err != nil {
			server.writeError(writer, request, err, nil)
			return
		}
		ctx := context.WithValue(request.Context(), sessionContextKey, record)
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

func (server *api) csrfMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !server.validOrigin(request) {
			server.writeError(writer, request, appsession.ErrCSRFInvalid, nil)
			return
		}
		record, ok := authenticatedSession(request.Context())
		if !ok || server.dependencies.Sessions.VerifyCSRF(record, request.Header.Get("X-CSRF-Token")) != nil {
			server.writeError(writer, request, appsession.ErrCSRFInvalid, nil)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (server *api) validOrigin(request *http.Request) bool {
	return request.Header.Get("Origin") == server.dependencies.PublicOrigin
}

func authenticatedSession(ctx context.Context) (appsession.AuthenticatedSession, bool) {
	record, ok := ctx.Value(sessionContextKey).(appsession.AuthenticatedSession)
	return record, ok
}

func requestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDContextKey).(string)
	return value
}

func isCanonicalUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}
