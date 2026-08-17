package actionai

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIQualityFixturesAreValid(t *testing.T) {
	tests := []struct {
		file     string
		required []string
	}{
		{"generate_cases.jsonl", []string{"name", "plan", "do", "check", "expectedThemes"}},
		{"refine_cases.jsonl", []string{"name", "plan", "do", "check", "action", "expectedIntentTerms"}},
	}
	for _, test := range tests {
		t.Run(test.file, func(t *testing.T) {
			path := filepath.Join("..", "..", "..", "testdata", "ai_eval", test.file)
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			scanner := bufio.NewScanner(file)
			count := 0
			for scanner.Scan() {
				count++
				var value map[string]any
				if err := json.Unmarshal(scanner.Bytes(), &value); err != nil {
					t.Fatalf("line %d: %v", count, err)
				}
				for _, key := range test.required {
					if emptyFixtureValue(value[key]) {
						t.Errorf("line %d: %s is empty", count, key)
					}
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
			if count < 3 {
				t.Fatalf("fixture needs representative cases, got %d", count)
			}
		})
	}
}

func emptyFixtureValue(value any) bool {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	default:
		return true
	}
}
