package aiprovider

import (
	"context"
	"testing"
)

func TestO200kCounterAndTokenAwareTruncation(t *testing.T) {
	counter, err := NewTokenCounter("o200k_base")
	if err != nil {
		t.Fatal(err)
	}
	count, err := counter.Count(context.Background(), "test-model", "hello world")
	if err != nil || count != 2 {
		t.Fatalf("count/error = %d/%v", count, err)
	}
	truncated, err := counter.Truncate(context.Background(), "test-model", "これは十分に長い日本語の入力テキストです", 8, "…")
	if err != nil {
		t.Fatal(err)
	}
	truncatedCount, err := counter.Count(context.Background(), "test-model", truncated)
	if err != nil || truncatedCount > 8 || truncated == "これは十分に長い日本語の入力テキストです" {
		t.Fatalf("truncated/count/error = %q/%d/%v", truncated, truncatedCount, err)
	}
}
