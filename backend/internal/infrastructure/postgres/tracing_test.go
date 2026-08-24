package postgres

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/fukamu/cycle/backend/internal/application/ports"
)

func TestQueryTracerPreservesParentAndSafeCorrelation(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	})

	ctx, parent := provider.Tracer("test").Start(context.Background(), "parent")
	ctx = ports.WithRequestCorrelation(ctx, "0198c20b-7b95-7000-8000-000000000001")
	ctx = ports.WithAIGenerationCorrelation(ctx, "0198c20b-7b95-7000-8000-000000000002", "goal_refine")
	queryCtx := (queryTracer{}).TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: "SELECT 1"})
	(queryTracer{}).TraceQueryEnd(queryCtx, nil, pgx.TraceQueryEndData{})
	parent.End()

	spans := exporter.GetSpans()
	if len(spans) != 2 {
		t.Fatalf("exported spans = %d, want 2", len(spans))
	}
	var database tracetest.SpanStub
	for _, span := range spans {
		if span.Name == "postgres.select" {
			database = span
		}
	}
	if !database.SpanContext.IsValid() {
		t.Fatal("postgres span not found")
	}
	if database.Parent.SpanID() != parent.SpanContext().SpanID() || database.SpanContext.TraceID() != parent.SpanContext().TraceID() {
		t.Fatalf("postgres parent/trace = %s/%s, want %s/%s", database.Parent.SpanID(), database.SpanContext.TraceID(), parent.SpanContext().SpanID(), parent.SpanContext().TraceID())
	}
	want := map[attribute.Key]string{
		"fukamu.request_id":        "0198c20b-7b95-7000-8000-000000000001",
		"fukamu.ai_generation_id":  "0198c20b-7b95-7000-8000-000000000002",
		"fukamu.ai_operation_type": "goal_refine",
	}
	for _, keyValue := range database.Attributes {
		if expected, ok := want[keyValue.Key]; ok && keyValue.Value.AsString() == expected {
			delete(want, keyValue.Key)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing correlation attributes: %#v; got %#v", want, database.Attributes)
	}
}

func TestSQLOperation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		statement string
		want      string
	}{
		{name: "sqlc comment", statement: "-- name: GetSession :one\nSELECT id FROM sessions", want: "select"},
		{name: "block comment", statement: "/* generated */ UPDATE sessions SET last_seen_at = now()", want: "update"},
		{name: "multiple comments", statement: "-- generated\n/* sqlc */\nDELETE FROM sessions", want: "delete"},
		{name: "plain statement", statement: "INSERT INTO users (id) VALUES ($1)", want: "insert"},
		{name: "line comment only", statement: "-- name: Missing", want: "query"},
		{name: "block comment only", statement: "/* generated */", want: "query"},
		{name: "empty", statement: "  ", want: "query"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := sqlOperation(test.statement); got != test.want {
				t.Fatalf("sqlOperation() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestNormalizeObservedSQL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		statement string
		want      string
	}{
		{
			name:      "sqlc owner lock",
			statement: "-- name: LockUser :one\nSELECT id FROM users WHERE id = $1::uuid FOR UPDATE",
			want:      "select id from users where id=$1 for update",
		},
		{
			name:      "typed comparison",
			statement: "/* generated */ UPDATE goals SET status = $1::text, revision = $2::bigint WHERE updated_at <= $3::timestamptz",
			want:      "update goals set status=$1,revision=$2 where updated_at<=$3",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := normalizeObservedSQL(test.statement); got != test.want {
				t.Fatalf("normalizeObservedSQL() = %q, want %q", got, test.want)
			}
		})
	}
}
