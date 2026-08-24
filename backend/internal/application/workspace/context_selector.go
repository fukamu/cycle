package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

const (
	providerInputTokenOverhead = 32
	truncationMarker           = "…（入力の一部を省略）"
)

type contextFieldSpec struct {
	name    string
	minimum float64
}

func (service *Service) selectAIContextForUser(userID string) AIContextSelector {
	return func(ctx context.Context, snapshot AISnapshot) (AISnapshot, error) {
		limits, err := service.entitlements.Limits(ctx, user.ID(userID))
		if err != nil {
			return AISnapshot{}, err
		}
		switch snapshot.Operation {
		case domainai.OperationGoalRefine:
			snapshot.MaxOutputTokens = int64(limits.GoalRefineOutputTokens)
		case domainai.OperationActionGenerate, domainai.OperationActionRefine:
			snapshot.MaxOutputTokens = int64(limits.ActionOutputTokens)
		default:
			return AISnapshot{}, ErrAIInputBudget
		}
		if snapshot.MaxOutputTokens <= 0 {
			return AISnapshot{}, ErrAIInputBudget
		}
		return service.selectAIContext(ctx, snapshot, limits.MaxAIInputTokens)
	}
}

func (service *Service) selectAIContext(ctx context.Context, snapshot AISnapshot, maxInputTokens int) (AISnapshot, error) {
	if service.settings.TokenCounter == nil || maxInputTokens <= 0 || service.settings.Model == "" {
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
	if selected.Operation == domainai.OperationActionGenerate && selected.CurrentCycle != nil {
		selected.CurrentCycle.Action = ""
	}

	baseTokens, err := service.countProviderInput(ctx, selected)
	if err != nil {
		return AISnapshot{}, err
	}
	if baseTokens > maxInputTokens {
		selected, err = service.truncateCurrentInput(ctx, selected, maxInputTokens)
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
		if count > maxInputTokens {
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

func (service *Service) truncateCurrentInput(ctx context.Context, snapshot AISnapshot, maxInputTokens int) (AISnapshot, error) {
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
	available := maxInputTokens - fixedTokens
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
		if count <= maxInputTokens {
			return truncated, nil
		}
		excess := count - maxInputTokens
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

func currentFieldSpecs(operation domainai.OperationType) []contextFieldSpec {
	switch operation {
	case domainai.OperationGoalRefine:
		return []contextFieldSpec{{"source", 0.7}, {"goal", 0.3}}
	case domainai.OperationActionGenerate:
		return []contextFieldSpec{{"goal", 0.1}, {"plan", 0.1}, {"do", 0.1}, {"check", 0.1}}
	case domainai.OperationActionRefine:
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
	encoded, err := service.providerLogicalInputJSON(snapshot)
	if err != nil {
		return 0, err
	}
	operationSettings, err := service.aiOperationSettings(snapshot.Operation)
	if err != nil {
		return 0, err
	}
	instructions := operationSettings.instructions
	if service.settings.MaxProviderAttempts > 1 {
		instructions += invalidResponseRetryInstruction
	}
	instructionTokens, err := service.settings.TokenCounter.Count(ctx, service.settings.Model, instructions)
	if err != nil {
		return 0, err
	}
	inputTokens, err := service.settings.TokenCounter.Count(ctx, service.settings.Model, string(encoded))
	if err != nil {
		return 0, err
	}
	return instructionTokens + inputTokens + providerInputTokenOverhead, nil
}

type aiOperationSettings struct {
	instructions  string
	promptVersion string
}

func (service *Service) aiOperationSettings(operation domainai.OperationType) (aiOperationSettings, error) {
	switch operation {
	case domainai.OperationGoalRefine:
		return aiOperationSettings{service.settings.GoalRefineInstructions, service.settings.GoalPromptVersion}, nil
	case domainai.OperationActionGenerate:
		return aiOperationSettings{service.settings.ActionGenerateInstructions, service.settings.GeneratePromptVersion}, nil
	case domainai.OperationActionRefine:
		return aiOperationSettings{service.settings.ActionRefineInstructions, service.settings.RefinePromptVersion}, nil
	default:
		return aiOperationSettings{}, ErrAIInputBudget
	}
}

func (service *Service) refineGoalAIInput(snapshot AISnapshot) RefineGoalAIInput {
	settings, _ := service.aiOperationSettings(domainai.OperationGoalRefine)
	return RefineGoalAIInput{
		Instructions: settings.instructions, GoalBody: snapshot.GoalBody, SourceText: snapshot.SourceText,
		PastCycles: aiInputCycles(snapshot.PastCycles), MaxOutputTokens: snapshot.MaxOutputTokens,
	}
}

func (service *Service) generateActionAIInput(snapshot AISnapshot) GenerateActionAIInput {
	settings, _ := service.aiOperationSettings(domainai.OperationActionGenerate)
	return GenerateActionAIInput{
		Instructions: settings.instructions, GoalBody: snapshot.GoalBody,
		CurrentCycle: aiInputCurrentCycle(snapshot.CurrentCycle), PastCycles: aiInputCycles(snapshot.PastCycles),
		MaxOutputTokens: snapshot.MaxOutputTokens,
	}
}

func (service *Service) refineActionAIInput(snapshot AISnapshot) RefineActionAIInput {
	settings, _ := service.aiOperationSettings(domainai.OperationActionRefine)
	return RefineActionAIInput{
		Instructions: settings.instructions, GoalBody: snapshot.GoalBody,
		CurrentCycle: aiInputCurrentCycle(snapshot.CurrentCycle), PastCycles: aiInputCycles(snapshot.PastCycles),
		MaxOutputTokens: snapshot.MaxOutputTokens,
	}
}

func (service *Service) providerLogicalInputJSON(snapshot AISnapshot) ([]byte, error) {
	switch snapshot.Operation {
	case domainai.OperationGoalRefine:
		return json.Marshal(service.refineGoalAIInput(snapshot))
	case domainai.OperationActionGenerate:
		return json.Marshal(service.generateActionAIInput(snapshot))
	case domainai.OperationActionRefine:
		return json.Marshal(service.refineActionAIInput(snapshot))
	default:
		return nil, ErrAIInputBudget
	}
}

func aiInputCurrentCycle(item *AIContextCycle) *AIInputCycle {
	if item == nil {
		return nil
	}
	return aiInputCycle(*item, false)
}

func aiInputCycles(items []AIContextCycle) []AIInputCycle {
	result := make([]AIInputCycle, len(items))
	for index, item := range items {
		result[index] = *aiInputCycle(item, true)
	}
	return result
}

func aiInputCycle(item AIContextCycle, includeGoalBody bool) *AIInputCycle {
	goalBody := ""
	if includeGoalBody {
		goalBody = item.GoalBody
	}
	return &AIInputCycle{
		SequenceNumber: item.SequenceNumber, Status: item.Status, GoalBody: goalBody,
		Plan: item.Plan, Do: item.Do, Check: item.Check, Action: item.Action,
	}
}

func (service *Service) setCanonicalProviderInputHash(snapshot *AISnapshot) error {
	selectedContext, err := service.providerLogicalInputJSON(*snapshot)
	if err != nil {
		return err
	}
	settings, err := service.aiOperationSettings(snapshot.Operation)
	if err != nil {
		return err
	}
	canonical, err := json.Marshal(struct {
		PromptVersion      string                 `json:"promptVersion"`
		OperationType      domainai.OperationType `json:"operationType"`
		Model              string                 `json:"model"`
		TargetRevision     int64                  `json:"targetRevision"`
		SourceGoalRevision int64                  `json:"sourceGoalRevision"`
		SelectedContext    json.RawMessage        `json:"selectedContext"`
		ContextCycleIDs    []string               `json:"contextCycleIds"`
	}{
		settings.promptVersion, snapshot.Operation, service.settings.Model,
		snapshot.TargetRevision, snapshot.SourceGoalRevision, selectedContext, aiContextCycleIDs(snapshot.PastCycles),
	})
	if err != nil {
		return err
	}
	digest := sha256.Sum256(canonical)
	snapshot.CanonicalProviderInputHash = hex.EncodeToString(digest[:])
	return nil
}
