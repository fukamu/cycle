package prompts

import (
	_ "embed"
	"fmt"

	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
)

const (
	VersionGoalRefineV2     = "goal-refine-v2"
	VersionActionGenerateV2 = "action-generate-v2"
	VersionActionRefineV2   = "action-refine-v2"
)

//go:embed goal-refine-v2.txt
var goalRefineV2 string

//go:embed action-generate-v2.txt
var actionGenerateV2 string

//go:embed action-refine-v2.txt
var actionRefineV2 string

type Versions struct {
	GoalRefine     string
	ActionGenerate string
	ActionRefine   string
}

type Set struct {
	GoalRefine     string
	ActionGenerate string
	ActionRefine   string
}

type registryKey struct {
	operation domainai.OperationType
	version   string
}

var registry = map[registryKey]string{
	{domainai.OperationGoalRefine, VersionGoalRefineV2}:         goalRefineV2,
	{domainai.OperationActionGenerate, VersionActionGenerateV2}: actionGenerateV2,
	{domainai.OperationActionRefine, VersionActionRefineV2}:     actionRefineV2,
}

func Resolve(versions Versions) (Set, error) {
	goalRefine, err := lookup(domainai.OperationGoalRefine, versions.GoalRefine)
	if err != nil {
		return Set{}, err
	}
	actionGenerate, err := lookup(domainai.OperationActionGenerate, versions.ActionGenerate)
	if err != nil {
		return Set{}, err
	}
	actionRefine, err := lookup(domainai.OperationActionRefine, versions.ActionRefine)
	if err != nil {
		return Set{}, err
	}
	return Set{GoalRefine: goalRefine, ActionGenerate: actionGenerate, ActionRefine: actionRefine}, nil
}

func lookup(operation domainai.OperationType, version string) (string, error) {
	instructions, ok := registry[registryKey{operation: operation, version: version}]
	if !ok {
		return "", fmt.Errorf("prompt asset is not registered for %s version %q", operation, version)
	}
	return instructions, nil
}
