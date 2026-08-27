package postgres

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/fukamu/cycle/backend/internal/application/ports"
)

type queryTracer struct{}

func (queryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	operation := sqlOperation(data.SQL)
	attributes := []attribute.KeyValue{
		attribute.String("db.system.name", "postgresql"),
		attribute.String("db.operation.name", operation),
	}
	correlation := ports.CorrelationFromContext(ctx)
	if correlation.RequestID != "" {
		attributes = append(attributes, attribute.String("fukamu.request_id", correlation.RequestID))
	}
	if correlation.AIGenerationID != "" {
		attributes = append(attributes, attribute.String("fukamu.ai_generation_id", correlation.AIGenerationID))
	}
	if correlation.AIOperationType != "" {
		attributes = append(attributes, attribute.String("fukamu.ai_operation_type", correlation.AIOperationType))
	}
	ctx, _ = otel.Tracer("fukamu-cycle/postgres").Start(ctx, "postgres."+operation, trace.WithAttributes(attributes...))
	return ctx
}

func sqlOperation(statement string) string {
	fields := strings.Fields(sqlWithoutLeadingComments(statement))
	if len(fields) == 0 {
		return "query"
	}
	return strings.ToLower(fields[0])
}

func sqlWithoutLeadingComments(statement string) string {
	statement = strings.TrimSpace(statement)
	for statement != "" {
		switch {
		case strings.HasPrefix(statement, "--"):
			newline := strings.IndexByte(statement, '\n')
			if newline < 0 {
				return ""
			}
			statement = strings.TrimSpace(statement[newline+1:])
		case strings.HasPrefix(statement, "/*"):
			end := strings.Index(statement[2:], "*/")
			if end < 0 {
				return ""
			}
			statement = strings.TrimSpace(statement[end+4:])
		default:
			return statement
		}
	}
	return ""
}

func (queryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	span := trace.SpanFromContext(ctx)
	if data.Err != nil {
		span.SetStatus(codes.Error, "database operation failed")
	}
	span.End()
}
