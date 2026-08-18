package prompts

import _ "embed"

//go:embed goal-refine-v1.txt
var GoalRefine string

//go:embed action-generate-v1.txt
var ActionGenerate string

//go:embed action-refine-v1.txt
var ActionRefine string
