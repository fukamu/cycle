package postgres

import (
	"testing"
	"time"
)

func TestMigrationLogCollectorRecordsAppliedFile(t *testing.T) {
	collector := &migrationLogCollector{}
	collector.Printf("%v (%v)\n", "1/u fukamu_cycle_baseline", 1250*time.Microsecond)

	if len(collector.applied) != 1 {
		t.Fatalf("applied count = %d, want 1", len(collector.applied))
	}
	got := collector.applied[0]
	if got.Version != 1 || got.Direction != "up" || got.File != "000001_fukamu_cycle_baseline.up.sql" || got.Duration != 1250*time.Microsecond {
		t.Fatalf("applied migration = %+v", got)
	}
}

func TestMigrationLogCollectorIgnoresNonCompletionMessages(t *testing.T) {
	collector := &migrationLogCollector{}
	collector.Printf("error: %v", "migration failed")
	collector.Printf("%v (%v)\n", "invalid", time.Second)

	if !(MigrationResult{Applied: collector.applied}).NoChange() {
		t.Fatalf("applied migrations = %v, want none", collector.applied)
	}
}
