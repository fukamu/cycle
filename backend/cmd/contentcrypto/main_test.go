package main

import "testing"

func TestRunRejectsUnsafeOrAmbiguousArgumentsBeforeConfiguration(t *testing.T) {
	tests := []struct {
		name      string
		arguments []string
	}{
		{name: "missing operation"},
		{name: "multiple operations", arguments: []string{"--status", "--verify"}},
		{name: "mutation without execute", arguments: []string{"--activate-writes"}},
		{name: "invalid batch", arguments: []string{"--status", "--batch-size", "0"}},
		{name: "invalid User UUID", arguments: []string{"--rotate-user-dek", "not-a-uuid", "--execute"}},
		{name: "positional argument", arguments: []string{"--status", "unexpected"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if status := run(test.arguments); status != 2 {
				t.Fatalf("exit status = %d, want 2", status)
			}
		})
	}
}
