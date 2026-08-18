package workspace

import (
	"context"
	"encoding/json"
)

const (
	providerInputTokenOverhead = 32
	truncationMarker           = "…（入力の一部を省略）"
)

type contextFieldSpec struct {
	name    string
	minimum float64
}

func (service *Service) selectAIContext(ctx context.Context, snapshot AISnapshot) (AISnapshot, error) {
	if service.settings.TokenCounter == nil || service.settings.MaxInputTokens <= 0 || service.settings.Model == "" {
		return AISnapshot{}, ErrAIInputBudget
	}
	if err := assertSameGoalContext(snapshot); err != nil {
		return AISnapshot{}, err
	}

	selected := cloneAISnapshot(snapshot)
	candidates := selected.PastCycles
	maximum := service.settings.MaxContextCycles
	if maximum <= 0 {
		maximum = 10
	}
	if len(candidates) > maximum {
		candidates = candidates[:maximum]
	}
	selected.PastCycles = nil
	if selected.Operation == "action_generate" && selected.CurrentCycle != nil {
		selected.CurrentCycle.Action = ""
	}

	baseTokens, err := service.countProviderInput(ctx, selected)
	if err != nil {
		return AISnapshot{}, err
	}
	if baseTokens > service.settings.MaxInputTokens {
		selected, err = service.truncateCurrentInput(ctx, selected)
		if err != nil {
			return AISnapshot{}, err
		}
	}

	for _, candidate := range candidates {
		withCandidate := cloneAISnapshot(selected)
		withCandidate.PastCycles = append(withCandidate.PastCycles, candidate)
		count, countErr := service.countProviderInput(ctx, withCandidate)
		if countErr != nil {
			return AISnapshot{}, countErr
		}
		if count > service.settings.MaxInputTokens {
			break
		}
		selected = withCandidate
	}
	return selected, nil
}

func assertSameGoalContext(snapshot AISnapshot) error {
	if snapshot.CurrentCycle != nil {
		if snapshot.GoalID == "" || snapshot.CurrentCycle.GoalID != snapshot.GoalID {
			return ErrAIContextIsolation
		}
	}
	for _, item := range snapshot.PastCycles {
		if snapshot.GoalID == "" || item.GoalID != snapshot.GoalID {
			return ErrAIContextIsolation
		}
	}
	return nil
}

func cloneAISnapshot(snapshot AISnapshot) AISnapshot {
	cloned := snapshot
	if snapshot.CurrentCycle != nil {
		current := *snapshot.CurrentCycle
		cloned.CurrentCycle = &current
	}
	cloned.PastCycles = append([]AIContextCycle(nil), snapshot.PastCycles...)
	return cloned
}

func (service *Service) truncateCurrentInput(ctx context.Context, snapshot AISnapshot) (AISnapshot, error) {
	specs := currentFieldSpecs(snapshot.Operation)
	if len(specs) == 0 {
		return AISnapshot{}, ErrAIInputBudget
	}
	empty := cloneAISnapshot(snapshot)
	empty.PastCycles = nil
	for _, spec := range specs {
		setContextField(&empty, spec.name, "")
	}
	fixedTokens, err := service.countProviderInput(ctx, empty)
	if err != nil {
		return AISnapshot{}, err
	}
	available := service.settings.MaxInputTokens - fixedTokens
	if available <= 0 {
		return AISnapshot{}, ErrAIInputBudget
	}

	allocations := make([]int, len(specs))
	originalCounts := make([]int, len(specs))
	used := 0
	for index, spec := range specs {
		allocations[index] = int(float64(available) * spec.minimum)
		originalCounts[index], err = service.settings.TokenCounter.Count(ctx, service.settings.Model, contextField(&snapshot, spec.name))
		if err != nil {
			return AISnapshot{}, err
		}
		used += min(originalCounts[index], allocations[index])
	}
	remaining := available - used
	for index := range specs {
		needed := originalCounts[index] - allocations[index]
		if needed <= 0 || remaining <= 0 {
			continue
		}
		extra := min(needed, remaining)
		allocations[index] += extra
		remaining -= extra
	}

	truncated := cloneAISnapshot(snapshot)
	truncated.PastCycles = nil
	apply := func() error {
		truncated.CurrentTruncated = false
		for index, spec := range specs {
			original := contextField(&snapshot, spec.name)
			value, truncateErr := service.settings.TokenCounter.Truncate(
				ctx, service.settings.Model, original, allocations[index], truncationMarker,
			)
			if truncateErr != nil {
				return truncateErr
			}
			setContextField(&truncated, spec.name, value)
			truncated.CurrentTruncated = truncated.CurrentTruncated || value != original
		}
		return nil
	}
	if err = apply(); err != nil {
		return AISnapshot{}, err
	}
	for attempts := 0; attempts < 16; attempts++ {
		count, countErr := service.countProviderInput(ctx, truncated)
		if countErr != nil {
			return AISnapshot{}, countErr
		}
		if count <= service.settings.MaxInputTokens {
			return truncated, nil
		}
		excess := count - service.settings.MaxInputTokens
		largest := -1
		for index := range allocations {
			if allocations[index] > 0 && (largest < 0 || allocations[index] > allocations[largest]) {
				largest = index
			}
		}
		if largest < 0 {
			break
		}
		allocations[largest] = max(0, allocations[largest]-max(1, excess))
		if err = apply(); err != nil {
			return AISnapshot{}, err
		}
	}
	return AISnapshot{}, ErrAIInputBudget
}

func currentFieldSpecs(operation string) []contextFieldSpec {
	switch operation {
	case "goal_refine":
		return []contextFieldSpec{{"source", 0.7}, {"goal", 0.3}}
	case "action_generate":
		return []contextFieldSpec{{"goal", 0.1}, {"plan", 0.1}, {"do", 0.1}, {"check", 0.1}}
	case "action_refine":
		return []contextFieldSpec{{"action", 0.4}, {"goal", 0.2}, {"plan", 0.133}, {"do", 0.133}, {"check", 0.133}}
	default:
		return nil
	}
}

func contextField(snapshot *AISnapshot, name string) string {
	switch name {
	case "goal":
		return snapshot.GoalBody
	case "source":
		return snapshot.SourceText
	case "plan":
		return snapshot.CurrentCycle.Plan
	case "do":
		return snapshot.CurrentCycle.Do
	case "check":
		return snapshot.CurrentCycle.Check
	case "action":
		return snapshot.CurrentCycle.Action
	default:
		return ""
	}
}

func setContextField(snapshot *AISnapshot, name, value string) {
	switch name {
	case "goal":
		snapshot.GoalBody = value
	case "source":
		snapshot.SourceText = value
	case "plan":
		snapshot.CurrentCycle.Plan = value
	case "do":
		snapshot.CurrentCycle.Do = value
	case "check":
		snapshot.CurrentCycle.Check = value
	case "action":
		snapshot.CurrentCycle.Action = value
	}
}

func (service *Service) countProviderInput(ctx context.Context, snapshot AISnapshot) (int, error) {
	request := providerRequestFromSnapshot(snapshot, service.outputTokenLimit(snapshot.Operation))
	encoded, err := json.Marshal(request)
	if err != nil {
		return 0, err
	}
	instructionTokens, err := service.settings.TokenCounter.Count(ctx, service.settings.Model, service.instructions(snapshot.Operation))
	if err != nil {
		return 0, err
	}
	inputTokens, err := service.settings.TokenCounter.Count(ctx, service.settings.Model, string(encoded))
	if err != nil {
		return 0, err
	}
	return instructionTokens + inputTokens + providerInputTokenOverhead, nil
}

func (service *Service) instructions(operation string) string {
	switch operation {
	case "goal_refine":
		return service.settings.GoalRefineInstructions
	case "action_generate":
		return service.settings.ActionGenerateInstructions
	case "action_refine":
		return service.settings.ActionRefineInstructions
	default:
		return ""
	}
}

func (service *Service) outputTokenLimit(operation string) int64 {
	if operation == "goal_refine" {
		return int64(service.settings.GoalRefineMaxOutputTokens)
	}
	return int64(service.settings.ActionMaxOutputTokens)
}

func providerRequestFromSnapshot(snapshot AISnapshot, maxOutputTokens int64) AIProviderRequest {
	request := AIProviderRequest{
		Operation: snapshot.Operation, GoalBody: snapshot.GoalBody,
		PastCycles: []AIProviderCycle{}, MaxOutputTokens: maxOutputTokens,
	}
	if snapshot.Operation == "goal_refine" {
		request.SourceText = snapshot.SourceText
	}
	if snapshot.CurrentCycle != nil {
		request.CurrentCycle = providerCycle(*snapshot.CurrentCycle, false)
	}
	for _, item := range snapshot.PastCycles {
		request.PastCycles = append(request.PastCycles, *providerCycle(item, true))
	}
	return request
}

func providerCycle(item AIContextCycle, includeGoalBody bool) *AIProviderCycle {
	goalBody := ""
	if includeGoalBody {
		goalBody = item.GoalBody
	}
	return &AIProviderCycle{
		SequenceNumber: item.SequenceNumber, Status: item.Status, GoalBody: goalBody,
		Plan: item.Plan, Do: item.Do, Check: item.Check, Action: item.Action,
	}
}
