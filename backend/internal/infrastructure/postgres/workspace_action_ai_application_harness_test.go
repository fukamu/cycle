package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
)

const actionAIIntegrationFallbackID = "88000000-0000-7000-8000-000000000000"

var errActionAIIntegrationIDExhausted = errors.New("Action AI integration ID generator exhausted")

type actionAIIntegrationClock struct {
	now time.Time
}

func (clock actionAIIntegrationClock) Now() time.Time {
	return clock.now
}

type actionAIIntegrationIDGenerator struct {
	ids   []string
	index int
}

func (generator *actionAIIntegrationIDGenerator) NewID() (string, error) {
	if generator.index >= len(generator.ids) {
		return "", errActionAIIntegrationIDExhausted
	}
	id := generator.ids[generator.index]
	generator.index++
	return id, nil
}

func newActionAIIntegrationUseCases(
	store *WorkspaceStore,
	now time.Time,
	ids ...string,
) *workspace.ActionAIUseCases {
	return newActionAIIntegrationUseCasesWithSettings(
		store, now, defaultAIIntegrationApplicationSettings(), ids...,
	)
}

func newActionAIIntegrationUseCasesWithSettings(
	store *WorkspaceStore,
	now time.Time,
	settings aiIntegrationApplicationSettings,
	ids ...string,
) *workspace.ActionAIUseCases {
	policy := workspace.NewStaticEntitlementPolicy(settings.Entitlements)
	return workspace.NewActionAIUseCases(
		store,
		policy,
		actionAIIntegrationClock{now: now},
		&actionAIIntegrationIDGenerator{ids: ids},
		settings.ActionAI,
	)
}

func executeActionGenerateBeginUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.ActionGenerateInput,
	selectContext workspace.AIContextSelector,
) (workspace.AISnapshot, error) {
	return executeActionGenerateBeginUseCaseWithSettings(
		store, ctx, input, selectContext, defaultAIIntegrationApplicationSettings(),
	)
}

func executeActionGenerateBeginUseCaseWithSettings(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.ActionGenerateInput,
	selectContext workspace.AIContextSelector,
	settings aiIntegrationApplicationSettings,
) (workspace.AISnapshot, error) {
	ids := []string(nil)
	if input.GenerationID == "" {
		ids = append(ids, actionAIIntegrationFallbackID)
	}
	now := input.Now
	if now.IsZero() {
		now = time.Unix(0, 0).UTC()
	}
	return newActionAIIntegrationUseCasesWithSettings(store, now, settings, ids...).BeginGenerate(ctx, input, selectContext)
}

func executeActionRefineBeginUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.ActionRefineInput,
	selectContext workspace.AIContextSelector,
) (workspace.AISnapshot, error) {
	return executeActionRefineBeginUseCaseWithSettings(
		store, ctx, input, selectContext, defaultAIIntegrationApplicationSettings(),
	)
}

func executeActionRefineBeginUseCaseWithSettings(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.ActionRefineInput,
	selectContext workspace.AIContextSelector,
	settings aiIntegrationApplicationSettings,
) (workspace.AISnapshot, error) {
	ids := []string(nil)
	if input.GenerationID == "" {
		ids = append(ids, actionAIIntegrationFallbackID)
	}
	now := input.Now
	if now.IsZero() {
		now = time.Unix(0, 0).UTC()
	}
	return newActionAIIntegrationUseCasesWithSettings(store, now, settings, ids...).BeginRefine(ctx, input, selectContext)
}

func executeActionFinishUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	snapshot workspace.AISnapshot,
	result workspace.AIExecutionResult,
	providerErr error,
	now time.Time,
) (workspace.AIResponse, error) {
	return executeActionFinishUseCaseWithSettings(
		store, ctx, snapshot, result, providerErr, now, defaultAIIntegrationApplicationSettings(),
	)
}

func executeActionFinishUseCaseWithSettings(
	store *WorkspaceStore,
	ctx context.Context,
	snapshot workspace.AISnapshot,
	result workspace.AIExecutionResult,
	providerErr error,
	now time.Time,
	settings aiIntegrationApplicationSettings,
) (workspace.AIResponse, error) {
	return newActionAIIntegrationUseCasesWithSettings(store, now, settings).Finish(ctx, snapshot, result, providerErr, now)
}

func actionGenerateRequestHashFixture(input workspace.ActionGenerateInput) string {
	return actionAIRequestHashFixture(
		domainai.OperationActionGenerate,
		input.GoalID,
		input.CycleID,
		input.ExpectedContentRevision,
		input.ConfirmReplace,
	)
}

func actionRefineRequestHashFixture(input workspace.ActionRefineInput) string {
	return actionAIRequestHashFixture(
		domainai.OperationActionRefine,
		input.GoalID,
		input.CycleID,
		input.ExpectedContentRevision,
		false,
	)
}

func actionAIRequestHashFixture(
	operation domainai.OperationType,
	goalID string,
	cycleID string,
	expectedContentRevision int64,
	confirmReplace bool,
) string {
	canonical, _ := json.Marshal(struct {
		Operation               domainai.OperationType `json:"operation"`
		GoalID                  string                 `json:"goalId"`
		CycleID                 string                 `json:"cycleId"`
		ExpectedContentRevision int64                  `json:"expectedContentRevision"`
		ConfirmReplace          bool                   `json:"confirmReplace,omitempty"`
	}{operation, goalID, cycleID, expectedContentRevision, confirmReplace})
	return sha256Hex(canonical)
}
