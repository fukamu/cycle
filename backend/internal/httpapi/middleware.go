package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
)

const (
	authenticatedUserIDHeader = "X-Fukamu-Authenticated-User-ID"
	expectedUserIDHeader      = "X-Fukamu-Expected-User-ID"
	httpTracerName            = "fukamu-cycle/http"
)

type contextKey string

const (
	sessionContextKey contextKey = "authenticated_session"
)

func (server *api) traceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		provider := server.dependencies.TracerProvider
		if provider == nil {
			provider = otel.GetTracerProvider()
		}
		ctx := request.Context()
		extracted := propagation.TraceContext{}.Extract(ctx, propagation.HeaderCarrier(request.Header))
		parent := trace.SpanContextFromContext(extracted)
		if parent.IsValid() {
			parent = trace.NewSpanContext(trace.SpanContextConfig{
				TraceID: parent.TraceID(), TraceFlags: parent.TraceFlags(), SpanID: parent.SpanID(), Remote: true,
			})
			ctx = trace.ContextWithRemoteSpanContext(ctx, parent)
		}
		ctx, span := provider.Tracer(httpTracerName).Start(ctx, "http.request", trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

func (server *api) requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestID := strings.ToLower(strings.TrimSpace(request.Header.Get("X-Request-ID")))
		if !isCanonicalUUIDv7(requestID) {
			requestID = "00000000-0000-7000-8000-000000000000"
			if server.dependencies.RequestIDs != nil {
				if generated, err := server.dependencies.RequestIDs.NewID(); err == nil {
					requestID = generated
				}
			}
		}
		writer.Header().Set("X-Request-ID", requestID)
		ctx := ports.WithRequestCorrelation(request.Context(), requestID)
		trace.SpanFromContext(ctx).SetAttributes(attribute.String("fukamu.request_id", requestID))
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

func (server *api) panicRecoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer func() {
			if recover() == nil {
				return
			}
			span := trace.SpanFromContext(request.Context())
			span.SetStatus(codes.Error, http.StatusText(http.StatusInternalServerError))
			if server.dependencies.Logger != nil {
				server.dependencies.Logger.LogAttrs(request.Context(), slog.LevelError, "",
					slog.String("request_id", requestID(request.Context())),
					slog.String("trace_id", span.SpanContext().TraceID().String()),
					slog.String("operation", "http_handler_panic"),
					slog.String("error_class", "http_handler_panic"),
					slog.String("error_code", "INTERNAL_ERROR"),
					slog.Int("status_code", http.StatusInternalServerError),
				)
			}
			_, code, message := classifyError(nil)
			if server.dependencies.Metrics != nil {
				server.dependencies.Metrics.ErrorCode(request.Context(), code)
			}
			writer.Header().Set("Cache-Control", "no-store")
			writeJSON(writer, http.StatusInternalServerError, errorEnvelope{Error: apiError{
				Code: code, Message: message, RequestID: requestID(request.Context()),
			}})
		}()
		next.ServeHTTP(writer, request)
	})
}

func (server *api) noStoreMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(writer, request)
	})
}

func (server *api) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		writer.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		writer.Header().Set("X-Frame-Options", "DENY")
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://accounts.google.com https://www.google.com https://www.gstatic.com https://challenges.cloudflare.com https://static.cloudflareinsights.com; connect-src 'self' https://accounts.google.com https://www.google.com https://challenges.cloudflare.com; frame-src https://accounts.google.com https://www.google.com https://challenges.cloudflare.com; img-src 'self' data: https:; style-src 'self' https://accounts.google.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com")
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

func normalizedHTTPMethod(method string) string {
	switch method {
	case http.MethodConnect, http.MethodDelete, http.MethodGet, http.MethodHead, http.MethodOptions,
		http.MethodPatch, http.MethodPost, http.MethodPut, http.MethodTrace:
		return method
	default:
		return "OTHER"
	}
}

func routeTemplate(request *http.Request) string {
	route := chi.RouteContext(request.Context()).RoutePattern()
	if route == "" {
		return "unmatched"
	}
	return route
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
		route := routeTemplate(request)
		method := normalizedHTTPMethod(request.Method)
		span := trace.SpanFromContext(request.Context())
		span.SetName(method + " " + route)
		span.SetAttributes(
			attribute.String("http.request.method", method),
			attribute.String("http.route", route),
			attribute.Int("http.response.status_code", recorder.status),
		)
		if recorder.status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(recorder.status))
		}
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
			slog.String("method", method),
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
		writer.Header().Set(authenticatedUserIDHeader, string(record.UserID))
		expectedUserID, present, err := expectedAuthenticatedUserID(request)
		if err != nil {
			server.writeError(writer, request, err, nil)
			return
		}
		if present && expectedUserID != string(record.UserID) {
			server.writeError(writer, request, errSessionIdentityChanged, nil)
			return
		}
		ctx := context.WithValue(request.Context(), sessionContextKey, record)
		next.ServeHTTP(writer, request.WithContext(ctx))
	})
}

func expectedAuthenticatedUserID(request *http.Request) (string, bool, error) {
	values, present := request.Header[http.CanonicalHeaderKey(expectedUserIDHeader)]
	if !present {
		return "", false, nil
	}
	if len(values) != 1 || !isCanonicalUUIDv7(values[0]) {
		return "", true, errRequestValidation
	}
	return values[0], true, nil
}

func (server *api) validatedPath(next http.HandlerFunc, names ...string) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		for _, name := range names {
			value := chi.URLParam(request, name)
			if !isCanonicalUUIDv7(value) {
				server.writeError(writer, request, errRequestValidation, nil)
				return
			}
		}
		next.ServeHTTP(writer, request)
	}
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
	return ports.CorrelationFromContext(ctx).RequestID
}

func (server *api) remoteIP(request *http.Request) string {
	if server.dependencies.TrustProxy {
		if value := strings.TrimSpace(strings.Split(request.Header.Get("CF-Connecting-IP"), ",")[0]); value != "" {
			return value
		}
	}
	return request.RemoteAddr
}

func isCanonicalUUIDv7(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	if value[14] != '7' || !strings.ContainsRune("89ab", rune(value[19])) {
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
