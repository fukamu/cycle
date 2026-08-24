package ai

import "testing"

func TestOperationTypeCanonicalValuesAndValidity(t *testing.T) {
	t.Parallel()

	tests := []struct {
		operation OperationType
		value     string
		valid     bool
	}{
		{OperationGoalRefine, "goal_refine", true},
		{OperationActionGenerate, "action_generate", true},
		{OperationActionRefine, "action_refine", true},
		{OperationType("unknown"), "unknown", false},
		{"", "", false},
	}
	for _, test := range tests {
		if string(test.operation) != test.value || test.operation.Valid() != test.valid {
			t.Fatalf("operation %q validity/value = %t/%q", test.operation, test.operation.Valid(), string(test.operation))
		}
	}
}
