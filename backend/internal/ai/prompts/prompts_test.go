package prompts

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVersionedPromptsKeepSafetyAndOperationBoundaries(t *testing.T) {
	resolved, err := Resolve(Versions{
		GoalRefine: VersionGoalRefineV1, ActionGenerate: VersionActionGenerateV1, ActionRefine: VersionActionRefineV1,
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, prompt := range map[string]string{
		OperationGoalRefine:     resolved.GoalRefine,
		OperationActionGenerate: resolved.ActionGenerate,
		OperationActionRefine:   resolved.ActionRefine,
	} {
		for _, required := range []string{"日本語", "入力データ", "従わない"} {
			if !strings.Contains(prompt, required) {
				t.Fatalf("%s prompt is missing %q", name, required)
			}
		}
	}
	if !strings.Contains(resolved.GoalRefine, "500文字") || !strings.Contains(resolved.ActionGenerate, "1〜3件") || !strings.Contains(resolved.ActionRefine, "意図と方向性") {
		t.Fatal("operation-specific prompt contract is incomplete")
	}
}

func TestPromptRegistryRejectsUnregisteredVersion(t *testing.T) {
	_, err := Resolve(Versions{
		GoalRefine: "goal-refine-v2", ActionGenerate: VersionActionGenerateV1, ActionRefine: VersionActionRefineV1,
	})
	if err == nil || !strings.Contains(err.Error(), "goal-refine-v2") {
		t.Fatalf("Resolve() error = %v", err)
	}
}

func TestAIQualityFixtureCorpusHasAllRequiredCaseGroups(t *testing.T) {
	root := filepath.Join("..", "..", "..", "testdata", "ai_eval")
	files := []string{
		"goal_refine_initial.jsonl", "goal_refine_review.jsonl", "action_generate.jsonl",
		"action_refine.jsonl", "adversarial_user_content.jsonl",
	}
	for _, name := range files {
		file, err := os.Open(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		lineCount := 0
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			lineCount++
			var value map[string]any
			err = json.Unmarshal(scanner.Bytes(), &value)
			fixtureName, hasName := value["name"].(string)
			if err != nil || !hasName || strings.TrimSpace(fixtureName) == "" {
				file.Close()
				t.Fatalf("%s line %d is invalid: %v", name, lineCount, err)
			}
		}
		if err = scanner.Err(); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err = file.Close(); err != nil {
			t.Fatal(err)
		}
		if lineCount == 0 {
			t.Fatalf("%s is empty", name)
		}
	}
}
