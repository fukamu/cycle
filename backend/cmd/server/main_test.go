package main

import (
	"math"
	"testing"
)

func TestMaximumAIReservationUSDUsesOperationOutputLimit(t *testing.T) {
	t.Parallel()

	const (
		maxInputTokens      = 1_000
		maxProviderAttempts = 2
		inputPrice          = 1.0
		outputPrice         = 2.0
	)

	goalRefine := maximumAIReservationUSD(maxInputTokens, 400, maxProviderAttempts, inputPrice, outputPrice)
	action := maximumAIReservationUSD(maxInputTokens, 800, maxProviderAttempts, inputPrice, outputPrice)

	if math.Abs(goalRefine-0.0036) > 1e-12 {
		t.Fatalf("Goal Refine reservation = %.12f, want 0.0036", goalRefine)
	}
	if math.Abs(action-0.0052) > 1e-12 {
		t.Fatalf("Action reservation = %.12f, want 0.0052", action)
	}
	if goalRefine >= action {
		t.Fatalf("Goal Refine reservation %.12f must be lower than Action reservation %.12f", goalRefine, action)
	}
}
