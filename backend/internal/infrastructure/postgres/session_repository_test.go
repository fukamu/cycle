package postgres

import (
	"fmt"
	"strings"
	"testing"
)

func TestMustUUIDPanicDoesNotContainRawValue(t *testing.T) {
	const rawValue = "GOAL_BODY_SESSION_TOKEN_PRIVATE@example.com"
	defer func() {
		panicValue := recover()
		if panicValue == nil {
			t.Fatal("mustUUID did not panic for an invalid value")
		}
		message := fmt.Sprint(panicValue)
		if strings.Contains(message, rawValue) || strings.Contains(message, "private@example.com") {
			t.Fatalf("mustUUID panic leaked raw adapter input: %q", message)
		}
		if message != "invalid UUID passed to PostgreSQL adapter" {
			t.Fatalf("mustUUID panic = %q, want stable classification", message)
		}
	}()
	_ = mustUUID(rawValue)
}
