package workspace

import "time"

const (
	AIRollingWindow              = 24 * time.Hour
	AIUsageRetentionSafetyMargin = 15 * time.Minute
	AIUsageRetentionDuration     = AIRollingWindow + AIUsageRetentionSafetyMargin
)

// AIUsageQuotaRetainUntil returns the earliest instant at which a finalized,
// content-free usage event may be physically deleted. The rolling quota still
// counts only AIRollingWindow; the safety margin protects deletion boundaries.
func AIUsageQuotaRetainUntil(acceptedAt time.Time) time.Time {
	return acceptedAt.Add(AIUsageRetentionDuration)
}
