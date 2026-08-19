package prompts

import (
	_ "embed"
	"fmt"
)

const (
	OperationGoalRefine     = "goal_refine"
	OperationActionGenerate = "action_generate"
	OperationActionRefine   = "action_refine"

	VersionGoalRefineV1     = "goal-refine-v1"
	VersionActionGenerateV1 = "action-generate-v1"
	VersionActionRefineV1   = "action-refine-v1"
)

//go:embed goal-refine-v1.txt
var goalRefineV1 string

//go:embed action-generate-v1.txt
var actionGenerateV1 string

//go:embed action-refine-v1.txt
var actionRefineV1 string

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
	operation string
	version   string
}

var registry = map[registryKey]string{
	{OperationGoalRefine, VersionGoalRefineV1}:         goalRefineV1,
	{OperationActionGenerate, VersionActionGenerateV1}: actionGenerateV1,
	{OperationActionRefine, VersionActionRefineV1}:     actionRefineV1,
}

func Resolve(versions Versions) (Set, error) {
	goalRefine, err := lookup(OperationGoalRefine, versions.GoalRefine)
	if err != nil {
		return Set{}, err
	}
	actionGenerate, err := lookup(OperationActionGenerate, versions.ActionGenerate)
	if err != nil {
		return Set{}, err
	}
	actionRefine, err := lookup(OperationActionRefine, versions.ActionRefine)
	if err != nil {
		return Set{}, err
	}
	return Set{GoalRefine: goalRefine, ActionGenerate: actionGenerate, ActionRefine: actionRefine}, nil
}

func lookup(operation, version string) (string, error) {
	instructions, ok := registry[registryKey{operation: operation, version: version}]
	if !ok {
		return "", fmt.Errorf("prompt asset is not registered for %s version %q", operation, version)
	}
	return instructions, nil
}
