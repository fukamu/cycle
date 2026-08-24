package postgres

import "github.com/fukamu/cycle/backend/internal/application/workspace"

type aiIntegrationApplicationSettings struct {
	Entitlements workspace.Entitlements
	GoalDraft    workspace.GoalDraftUseCaseSettings
	ActionAI     workspace.ActionAIUseCaseSettings
}

func defaultAIIntegrationApplicationSettings() aiIntegrationApplicationSettings {
	return aiIntegrationApplicationSettings{}
}
