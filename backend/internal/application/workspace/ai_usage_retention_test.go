package workspace

import (
	"testing"
	"time"
)

func TestAIUsageQuotaRetainUntilAddsRollingWindowAndSafetyMargin(t *testing.T) {
	acceptedAt := time.Date(2026, time.August, 24, 12, 34, 56, 789, time.FixedZone("test", 9*60*60))
	want := acceptedAt.Add(24*time.Hour + 15*time.Minute)
	if got := AIUsageQuotaRetainUntil(acceptedAt); !got.Equal(want) {
		t.Fatalf("AIUsageQuotaRetainUntil() = %s, want %s", got, want)
	}
	if AIRollingWindow != 24*time.Hour {
		t.Fatalf("AIRollingWindow = %s, want 24h", AIRollingWindow)
	}
}
