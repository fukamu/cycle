package ports

import "context"

type correlationContextKey struct{}

// Correlation carries only short-lived, non-user observability identifiers.
// It must never contain request bodies, provider payloads, credentials, IP
// addresses, or long-lived user identifiers.
type Correlation struct {
	RequestID       string
	AIGenerationID  string
	AIOperationType string
}

func WithRequestCorrelation(ctx context.Context, requestID string) context.Context {
	correlation := CorrelationFromContext(ctx)
	correlation.RequestID = requestID
	return context.WithValue(ctx, correlationContextKey{}, correlation)
}

func WithAIGenerationCorrelation(ctx context.Context, generationID, operationType string) context.Context {
	correlation := CorrelationFromContext(ctx)
	correlation.AIGenerationID = generationID
	correlation.AIOperationType = operationType
	return context.WithValue(ctx, correlationContextKey{}, correlation)
}

func CorrelationFromContext(ctx context.Context) Correlation {
	if ctx == nil {
		return Correlation{}
	}
	correlation, _ := ctx.Value(correlationContextKey{}).(Correlation)
	return correlation
}
