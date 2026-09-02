package postgres

import (
	"os"
	"strings"
	"testing"
)

func TestCleanupSQLUsesBoundedOrderedLocksAndOuterPredicateRevalidation(t *testing.T) {
	querySource, err := os.ReadFile("queries/cleanup.sql")
	if err != nil {
		t.Fatal(err)
	}
	normalized := strings.ToLower(strings.Join(strings.Fields(string(querySource)), " "))
	for fragment, wantCount := range map[string]int{
		"public.ai_usage_events":                                           3,
		"public.abuse_rate_buckets":                                        3,
		"public.anonymous_rate_limit_guards":                               3,
		"for update skip locked":                                           3,
		"limit sqlc.arg(batch_size)::integer":                              3,
		"target.content_deleted = true":                                    1,
		"target.provider_usage_finalized_at is not null":                   1,
		"target.quota_retain_until <= sqlc.arg(captured_now)::timestamptz": 1,
		"target.expires_at <= sqlc.arg(captured_now)::timestamptz":         2,
		"order by expires_at, scope, key_hash":                             2,
	} {
		if got := strings.Count(normalized, fragment); got != wantCount {
			t.Errorf("%q count = %d, want %d in %s", fragment, got, wantCount, normalized)
		}
	}
	for _, orderedCandidates := range []string{
		"order by quota_retain_until, operation_id",
		"order by expires_at, scope, key_hash, window_start",
	} {
		if !strings.Contains(normalized, orderedCandidates) {
			t.Errorf("cleanup query is missing %q", orderedCandidates)
		}
	}
}

func TestCleanupRepositoryKeepsDryRunReadOnlyAndCancellationRollbackDetached(t *testing.T) {
	source, err := os.ReadFile("cleanup_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, fragment := range []string{
		"IsoLevel:   pgx.RepeatableRead",
		"AccessMode: pgx.ReadOnly",
		"pgx.TxOptions{IsoLevel: pgx.ReadCommitted}",
		"context.WithoutCancel(ctx)",
		"poolConfig.MaxConns = 1",
		"poolConfig.MinConns = 0",
		`"search_path":      "pg_catalog,public"`,
	} {
		if !strings.Contains(text, fragment) {
			t.Errorf("cleanup repository is missing %q", fragment)
		}
	}
}
