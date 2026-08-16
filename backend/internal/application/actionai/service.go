package actionai

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	domainai "github.com/matoruru/PDCAI/backend/internal/domain/ai"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

type GenerateActionUseCase struct {
	repository Repository
	provider   ActionAI
	builder    *ContextBuilder
	clock      Clock
	ids        IDGenerator
	settings   Settings
}

type RefineActionUseCase struct {
	repository Repository
	provider   ActionAI
	builder    *ContextBuilder
	clock      Clock
	ids        IDGenerator
	settings   Settings
}

func NewGenerateActionUseCase(repository Repository, provider ActionAI, builder *ContextBuilder, clock Clock, ids IDGenerator, settings Settings) *GenerateActionUseCase {
	return &GenerateActionUseCase{repository: repository, provider: provider, builder: builder, clock: clock, ids: ids, settings: settings}
}

func NewRefineActionUseCase(repository Repository, provider ActionAI, builder *ContextBuilder, clock Clock, ids IDGenerator, settings Settings) *RefineActionUseCase {
	return &RefineActionUseCase{repository: repository, provider: provider, builder: builder, clock: clock, ids: ids, settings: settings}
}

type GenerateCommand struct {
	UserID                  user.ID
	CycleID                 domaincycle.ID
	IdempotencyKey          string
	ExpectedContentRevision int64
	ConfirmReplace          bool
	Scope                   RequestScope
}

type RefineCommand struct {
	UserID                  user.ID
	CycleID                 domaincycle.ID
	IdempotencyKey          string
	ExpectedContentRevision int64
	Scope                   RequestScope
}

func (useCase *GenerateActionUseCase) Execute(ctx context.Context, command GenerateCommand) (Result, error) {
	snapshot, err := useCase.repository.LoadSnapshot(ctx, command.UserID, command.CycleID)
	if err != nil {
		return Result{}, err
	}
	missing := missingGenerateFrames(snapshot.Current)
	if len(missing) > 0 {
		return Result{}, &IncompleteError{MissingFrames: missing}
	}
	built, err := useCase.builder.BuildGenerate(snapshot)
	if err != nil {
		return Result{}, err
	}
	generationID, usageID, err := newOperationIDs(useCase.ids)
	if err != nil {
		return Result{}, err
	}
	now := useCase.clock.Now().UTC()
	start, err := useCase.repository.Start(ctx, newStartInput(
		useCase.settings, command.UserID, command.CycleID, generationID, usageID,
		GenerationGenerate, command.IdempotencyKey, command.ExpectedContentRevision,
		command.ConfirmReplace, useCase.settings.GeneratePromptVersion, built, nil, command.Scope, now,
	))
	if err != nil {
		return Result{}, err
	}
	if start.Existing != nil {
		return resultFromExisting(start.Existing)
	}

	var usage Usage
	var action string
	var providerErr error
	attempts := 0
	for attempts < useCase.settings.MaxProviderAttempts {
		attempts++
		attemptContext, cancel := context.WithTimeout(ctx, useCase.settings.ProviderTimeout)
		generated, callErr := useCase.provider.Generate(attemptContext, GenerateActionAIInput{
			Instructions:     built.Instructions,
			Content:          built.Input,
			MaxOutputTokens:  useCase.settings.MaxOutputTokens,
			SafetyIdentifier: safetyIdentifier(useCase.settings.RateLimitHMACKey, command.UserID),
			Retry:            attempts > 1,
		})
		cancel()
		usage.Add(generated.Usage)
		if callErr == nil {
			action, callErr = domainai.RenderGeneratedActions(generated.Actions)
		}
		if callErr == nil {
			providerErr = nil
			break
		}
		providerErr = classifyProviderError(callErr, ctx)
		if ctx.Err() != nil {
			break
		}
	}
	if providerErr != nil {
		useCase.failDetached(generationID, providerErr, attempts, usage, useCase.clock.Now().UTC())
		return Result{}, providerErr
	}

	finishContext, cancelFinish := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancelFinish()
	return useCase.repository.Succeed(finishContext, SuccessInput{
		UserID: command.UserID, CycleID: command.CycleID, GenerationID: generationID,
		GenerationRevision: snapshot.Current.ContentRevision, Action: action, AttemptCount: attempts,
		Usage: usage, EstimatedCostUSD: estimatedCost(useCase.settings, usage), Now: useCase.clock.Now().UTC(),
	})
}

func (useCase *RefineActionUseCase) Execute(ctx context.Context, command RefineCommand) (Result, error) {
	snapshot, err := useCase.repository.LoadSnapshot(ctx, command.UserID, command.CycleID)
	if err != nil {
		return Result{}, err
	}
	missing := missingRefineFrames(snapshot.Current)
	if len(missing) > 0 {
		return Result{}, &IncompleteError{MissingFrames: missing, Refine: true}
	}
	built, err := useCase.builder.BuildRefine(snapshot)
	if err != nil {
		return Result{}, err
	}
	generationID, usageID, err := newOperationIDs(useCase.ids)
	if err != nil {
		return Result{}, err
	}
	now := useCase.clock.Now().UTC()
	refineSource := snapshot.Current.Action
	start, err := useCase.repository.Start(ctx, newStartInput(
		useCase.settings, command.UserID, command.CycleID, generationID, usageID,
		GenerationRefine, command.IdempotencyKey, command.ExpectedContentRevision,
		true, useCase.settings.RefinePromptVersion, built, &refineSource, command.Scope, now,
	))
	if err != nil {
		return Result{}, err
	}
	if start.Existing != nil {
		return resultFromExisting(start.Existing)
	}

	var usage Usage
	var action string
	var providerErr error
	attempts := 0
	for attempts < useCase.settings.MaxProviderAttempts {
		attempts++
		attemptContext, cancel := context.WithTimeout(ctx, useCase.settings.ProviderTimeout)
		refined, callErr := useCase.provider.Refine(attemptContext, RefineActionAIInput{
			Instructions:     built.Instructions,
			Content:          built.Input,
			MaxOutputTokens:  useCase.settings.MaxOutputTokens,
			SafetyIdentifier: safetyIdentifier(useCase.settings.RateLimitHMACKey, command.UserID),
			Retry:            attempts > 1,
		})
		cancel()
		usage.Add(refined.Usage)
		if callErr == nil {
			action, callErr = domainai.ValidateRefinedAction(refined.Action)
		}
		if callErr == nil {
			providerErr = nil
			break
		}
		providerErr = classifyProviderError(callErr, ctx)
		if ctx.Err() != nil {
			break
		}
	}
	if providerErr != nil {
		useCase.failDetached(generationID, providerErr, attempts, usage, useCase.clock.Now().UTC())
		return Result{}, providerErr
	}

	finishContext, cancelFinish := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancelFinish()
	return useCase.repository.Succeed(finishContext, SuccessInput{
		UserID: command.UserID, CycleID: command.CycleID, GenerationID: generationID,
		GenerationRevision: snapshot.Current.ContentRevision, Action: action, AttemptCount: attempts,
		Usage: usage, EstimatedCostUSD: estimatedCost(useCase.settings, usage), Now: useCase.clock.Now().UTC(),
	})
}

func (useCase *GenerateActionUseCase) failDetached(generationID string, cause error, attempts int, usage Usage, now time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = useCase.repository.Fail(ctx, FailureInput{
		GenerationID: generationID, FailureCode: failureCode(cause), AttemptCount: attempts,
		Usage: usage, EstimatedCostUSD: estimatedCost(useCase.settings, usage), Now: now,
	})
}

func (useCase *RefineActionUseCase) failDetached(generationID string, cause error, attempts int, usage Usage, now time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = useCase.repository.Fail(ctx, FailureInput{
		GenerationID: generationID, FailureCode: failureCode(cause), AttemptCount: attempts,
		Usage: usage, EstimatedCostUSD: estimatedCost(useCase.settings, usage), Now: now,
	})
}

func newStartInput(settings Settings, userID user.ID, cycleID domaincycle.ID, generationID, usageID string, generationType GenerationType, idempotencyKey string, expectedRevision int64, confirmReplace bool, promptVersion string, built BuiltContext, refineSource *string, scope RequestScope, now time.Time) StartInput {
	month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	return StartInput{
		UserID: userID, CycleID: cycleID, GenerationID: generationID, UsageEventID: usageID,
		GenerationType: generationType, IdempotencyKey: idempotencyKey,
		ExpectedContentRevision: expectedRevision, ConfirmReplace: confirmReplace,
		PromptVersion: promptVersion, InputHash: built.InputHash, RefineSourceAction: refineSource,
		ContextCycleIDs: built.ContextCycleIDs, Model: settings.Model, Provider: settings.Provider,
		Now: now, LeaseExpiresAt: now.Add(settings.LeaseDuration), BudgetMonthUTC: month,
		BudgetReservationUSD: maxReservation(settings), MonthlyBudgetUSD: settings.MonthlyBudgetUSD,
		RollingLimit:      settings.MaxGenerationsPerUser24h,
		RatePerUserMinute: settings.RatePerUserMinute, RatePerSessionMinute: settings.RatePerSessionMinute,
		RatePerIPMinute: settings.RatePerIPMinute,
		UserRateKey:     keyedHash(settings.RateLimitHMACKey, "user:"+string(userID)),
		SessionRateKey:  keyedHash(settings.RateLimitHMACKey, "session:"+scope.SessionID),
		IPRateKey:       keyedHash(settings.RateLimitHMACKey, "ip:"+scope.IP),
	}
}

func newOperationIDs(ids IDGenerator) (string, string, error) {
	generationID, err := ids.NewID()
	if err != nil {
		return "", "", err
	}
	usageID, err := ids.NewID()
	if err != nil {
		return "", "", err
	}
	return generationID, usageID, nil
}

func missingGenerateFrames(current domaincycle.PDCACycle) []domaincycle.Frame {
	missing := make([]domaincycle.Frame, 0, 3)
	for _, frame := range []domaincycle.Frame{domaincycle.FramePlan, domaincycle.FrameDo, domaincycle.FrameCheck} {
		if domaincycle.IsBlank(current.FrameContent(frame)) {
			missing = append(missing, frame)
		}
	}
	return missing
}

func missingRefineFrames(current domaincycle.PDCACycle) []domaincycle.Frame {
	missing := missingGenerateFrames(current)
	if domaincycle.IsBlank(current.Action) {
		missing = append(missing, domaincycle.FrameAction)
	}
	return missing
}

func resultFromExisting(existing *ExistingGeneration) (Result, error) {
	switch existing.Status {
	case "succeeded":
		return Result{GenerationID: existing.GenerationID, Action: existing.Output,
			ContentRevision: existing.Cycle.ContentRevision, ActionRevision: existing.Cycle.ActionRevision}, nil
	case "running":
		return Result{}, ErrOperationInProgress
	default:
		return Result{}, errorForFailureCode(existing.FailureCode)
	}
}

func classifyProviderError(err error, requestContext context.Context) error {
	if requestContext.Err() != nil {
		return requestContext.Err()
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrProviderTimeout) {
		return ErrProviderTimeout
	}
	if errors.Is(err, ErrInvalidResponse) || errors.Is(err, domainai.ErrInvalidActionCount) || errors.Is(err, domainai.ErrInvalidActionText) {
		return ErrInvalidResponse
	}
	return ErrProviderUnavailable
}

func failureCode(err error) string {
	switch {
	case errors.Is(err, ErrProviderTimeout):
		return "provider_timeout"
	case errors.Is(err, ErrInvalidResponse):
		return "invalid_response"
	case errors.Is(err, context.Canceled):
		return "request_canceled"
	default:
		return "provider_unavailable"
	}
}

func errorForFailureCode(code string) error {
	switch code {
	case "provider_timeout":
		return ErrProviderTimeout
	case "invalid_response":
		return ErrInvalidResponse
	default:
		return ErrProviderUnavailable
	}
}

func maxReservation(settings Settings) float64 {
	perAttempt := float64(settings.MaxInputTokens)*settings.InputUSDPerMillion/1_000_000 +
		float64(settings.MaxOutputTokens)*settings.OutputUSDPerMillion/1_000_000
	return float64(settings.MaxProviderAttempts) * perAttempt
}

func estimatedCost(settings Settings, usage Usage) float64 {
	return float64(usage.InputTokens)*settings.InputUSDPerMillion/1_000_000 +
		float64(usage.OutputTokens)*settings.OutputUSDPerMillion/1_000_000
}

func keyedHash(key []byte, value string) []byte {
	if value == "" {
		return nil
	}
	hash := hmac.New(sha256.New, key)
	_, _ = hash.Write([]byte(value))
	return hash.Sum(nil)
}

func safetyIdentifier(key []byte, userID user.ID) string {
	return hex.EncodeToString(keyedHash(key, "provider:"+string(userID)))
}
