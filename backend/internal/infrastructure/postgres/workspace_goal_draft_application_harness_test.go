package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

const goalDraftIntegrationFallbackID = "00000000-0000-7000-8000-000000000000"

var errGoalDraftIntegrationIDExhausted = errors.New("Goal Draft integration ID generator exhausted")

type goalDraftIntegrationClock struct {
	now time.Time
}

func (clock goalDraftIntegrationClock) Now() time.Time {
	return clock.now
}

type goalDraftIntegrationIDGenerator struct {
	ids   []string
	index int
}

func (generator *goalDraftIntegrationIDGenerator) NewID() (string, error) {
	if generator.index >= len(generator.ids) {
		return "", errGoalDraftIntegrationIDExhausted
	}
	id := generator.ids[generator.index]
	generator.index++
	return id, nil
}

func newGoalDraftIntegrationUseCases(store *WorkspaceStore, now time.Time, maxProgressing int, ids ...string) *workspace.GoalDraftUseCases {
	policy := workspace.NewStaticEntitlementPolicy(workspace.Entitlements{
		MaxProgressingGoals:       maxProgressing,
		MaxAIOperationsPer24Hours: store.settings.RollingLimit,
	})
	return workspace.NewGoalDraftUseCases(
		store,
		policy,
		goalDraftIntegrationClock{now: now},
		&goalDraftIntegrationIDGenerator{ids: ids},
		workspace.GoalDraftUseCaseSettings{
			Provider: store.settings.Provider, Model: store.settings.Model,
			GoalPromptVersion: store.settings.GoalPromptVersion,
			MonthlyBudgetUSD:  store.settings.MonthlyBudgetUSD, ReservationUSD: store.settings.ReservationUSD,
			LeaseDuration: store.settings.LeaseDuration, RateHashKey: store.settings.RateHashKey,
			AIPerUserMinute: store.settings.AIPerUserMinute, AIPerSessionMinute: store.settings.AIPerSessionMinute,
			AIPerIPMinute: store.settings.AIPerIPMinute,
		},
	)
}

func executeGoalDraftCreateUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID string,
	draftID string,
	body string,
	now time.Time,
) (workspace.DraftView, error) {
	return newGoalDraftIntegrationUseCases(store, now, 0, draftID).CreateDraft(ctx, userID, body)
}

func executeGoalDraftSaveUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID string,
	draftID string,
	body string,
	expectedRevision int64,
	now time.Time,
) (workspace.DraftView, error) {
	return newGoalDraftIntegrationUseCases(store, now, 0).SaveDraft(ctx, userID, draftID, body, expectedRevision)
}

func executeGoalReviewSaveUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID string,
	goalID string,
	expectedReviewDraftID string,
	body string,
	expectedRevision int64,
	now time.Time,
) (workspace.DraftView, error) {
	return newGoalDraftIntegrationUseCases(store, now, 0).SaveReview(
		ctx,
		userID,
		goalID,
		expectedReviewDraftID,
		body,
		expectedRevision,
	)
}

func executeGoalStartUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.StartGoalInput,
	maxProgressing int,
) (workspace.StartGoalResult, error) {
	return newGoalDraftIntegrationUseCases(store,
		input.Now,
		maxProgressing,
		input.GoalID,
		input.VersionID,
		input.CycleID,
	).StartGoal(ctx, input.UserID, input.DraftID, input.OperationID, input.ExpectedDraftRevision)
}

func executeGoalRefineBeginUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.GoalRefineInput,
	selectContext workspace.AIContextSelector,
) (workspace.AISnapshot, error) {
	ids := []string(nil)
	if input.GenerationID == "" {
		ids = append(ids, goalDraftIntegrationFallbackID)
	}
	now := input.Now
	if now.IsZero() {
		now = time.Unix(0, 0).UTC()
	}
	return newGoalDraftIntegrationUseCases(store, now, 0, ids...).BeginGoalRefine(ctx, input, selectContext)
}

func executeGoalRefineFinishUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	snapshot workspace.AISnapshot,
	result workspace.AIProviderResult,
	providerErr error,
	now time.Time,
) (workspace.AIResponse, error) {
	return newGoalDraftIntegrationUseCases(store, now, 0).FinishGoalRefine(ctx, snapshot, result, providerErr, now)
}

func executeGoalSuggestionAdoptUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID string,
	draftID string,
	goalID string,
	generationID string,
	expectedDraftRevision int64,
	expectedGoalRevision *int64,
	now time.Time,
) (workspace.DraftView, error) {
	return newGoalDraftIntegrationUseCases(store, now, 0).AdoptGoalSuggestion(
		ctx,
		userID,
		draftID,
		goalID,
		generationID,
		expectedDraftRevision,
		expectedGoalRevision,
	)
}

func goalRefineRequestHashFixture(input workspace.GoalRefineInput) string {
	canonical, _ := json.Marshal(struct {
		Operation             string `json:"operation"`
		DraftID               string `json:"draftId"`
		GoalID                string `json:"goalId,omitempty"`
		ExpectedDraftRevision int64  `json:"expectedDraftRevision"`
		ExpectedGoalRevision  *int64 `json:"expectedGoalRevision,omitempty"`
	}{"goal_refine", input.DraftID, input.GoalID, input.ExpectedDraftRevision, input.ExpectedGoalRevision})
	return sha256Hex(canonical)
}
