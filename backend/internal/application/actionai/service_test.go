package actionai

import (
	"context"
	"errors"
	"testing"
	"time"

	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

func TestGenerateRetriesInvalidOutputAndAppliesValidatedAction(t *testing.T) {
	repository := &fakeAIRepository{snapshot: validAISnapshot()}
	provider := &fakeActionProvider{generate: []GeneratedAction{
		{Actions: []string{"1", "2", "3", "4"}, Usage: Usage{InputTokens: 10, OutputTokens: 5}},
		{Actions: []string{"小さく試す", "結果を記録する"}, Usage: Usage{InputTokens: 11, OutputTokens: 6}},
	}}
	useCase := NewGenerateActionUseCase(repository, provider, NewContextBuilder(runeTokenCounter{}, 10_000), fixedAIClock{}, &sequenceIDs{}, testAISettings())

	result, err := useCase.Execute(context.Background(), GenerateCommand{
		UserID: "user", CycleID: "cycle", IdempotencyKey: testUUID(8), ExpectedContentRevision: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if provider.generateCalls != 2 || !provider.lastGenerate.Retry {
		t.Fatalf("provider calls/retry = %d/%v", provider.generateCalls, provider.lastGenerate.Retry)
	}
	if repository.success.Action != "1. 小さく試す\n\n2. 結果を記録する" || repository.success.Usage.InputTokens != 21 || result.Action == "" {
		t.Fatalf("success/result = %#v/%#v", repository.success, result)
	}
}

func TestGenerateFailureLeavesTerminalRecordAndReturnsClassifiedError(t *testing.T) {
	repository := &fakeAIRepository{snapshot: validAISnapshot()}
	provider := &fakeActionProvider{generateErrors: []error{context.DeadlineExceeded, context.DeadlineExceeded}}
	useCase := NewGenerateActionUseCase(repository, provider, NewContextBuilder(runeTokenCounter{}, 10_000), fixedAIClock{}, &sequenceIDs{}, testAISettings())

	_, err := useCase.Execute(context.Background(), GenerateCommand{
		UserID: "user", CycleID: "cycle", IdempotencyKey: testUUID(8), ExpectedContentRevision: 3,
	})
	if !errors.Is(err, ErrProviderTimeout) || repository.failure.FailureCode != "provider_timeout" || repository.failure.AttemptCount != 2 {
		t.Fatalf("error/failure = %v/%#v", err, repository.failure)
	}
}

func TestGenerateIdempotentSuccessDoesNotCallProvider(t *testing.T) {
	snapshot := validAISnapshot()
	repository := &fakeAIRepository{snapshot: snapshot, start: StartResult{Existing: &ExistingGeneration{
		Status: "succeeded", GenerationID: "existing", Output: "saved", Cycle: snapshot.Current,
	}}}
	provider := &fakeActionProvider{}
	useCase := NewGenerateActionUseCase(repository, provider, NewContextBuilder(runeTokenCounter{}, 10_000), fixedAIClock{}, &sequenceIDs{}, testAISettings())
	result, err := useCase.Execute(context.Background(), GenerateCommand{
		UserID: "user", CycleID: "cycle", IdempotencyKey: testUUID(8), ExpectedContentRevision: 3,
	})
	if err != nil || result.Action != "saved" || provider.generateCalls != 0 {
		t.Fatalf("result/error/calls = %#v/%v/%d", result, err, provider.generateCalls)
	}
}

func TestRefineUsesDedicatedProviderMethod(t *testing.T) {
	snapshot := validAISnapshot()
	snapshot.Current.Action = "元のアクション"
	repository := &fakeAIRepository{snapshot: snapshot}
	provider := &fakeActionProvider{refine: []RefinedAction{{Action: "意図を保った具体的な行動"}}}
	useCase := NewRefineActionUseCase(repository, provider, NewContextBuilder(runeTokenCounter{}, 10_000), fixedAIClock{}, &sequenceIDs{}, testAISettings())
	_, err := useCase.Execute(context.Background(), RefineCommand{
		UserID: "user", CycleID: "cycle", IdempotencyKey: testUUID(8), ExpectedContentRevision: 3,
	})
	if err != nil || provider.refineCalls != 1 || provider.generateCalls != 0 || repository.startInput.RefineSourceAction == nil {
		t.Fatalf("error/provider/start = %v/%#v/%#v", err, provider, repository.startInput)
	}
}

type fakeAIRepository struct {
	snapshot   Snapshot
	start      StartResult
	startInput StartInput
	success    SuccessInput
	failure    FailureInput
}

func (repository *fakeAIRepository) LoadSnapshot(context.Context, user.ID, domaincycle.ID) (Snapshot, error) {
	return repository.snapshot, nil
}
func (repository *fakeAIRepository) Start(_ context.Context, input StartInput) (StartResult, error) {
	repository.startInput = input
	return repository.start, nil
}
func (repository *fakeAIRepository) Succeed(_ context.Context, input SuccessInput) (Result, error) {
	repository.success = input
	return Result{GenerationID: input.GenerationID, Action: input.Action, ContentRevision: 4, ActionRevision: 1}, nil
}
func (repository *fakeAIRepository) Fail(_ context.Context, input FailureInput) error {
	repository.failure = input
	return nil
}

type fakeActionProvider struct {
	generate       []GeneratedAction
	generateErrors []error
	refine         []RefinedAction
	generateCalls  int
	refineCalls    int
	lastGenerate   GenerateActionAIInput
}

func (provider *fakeActionProvider) Generate(_ context.Context, input GenerateActionAIInput) (GeneratedAction, error) {
	index := provider.generateCalls
	provider.generateCalls++
	provider.lastGenerate = input
	if index < len(provider.generateErrors) && provider.generateErrors[index] != nil {
		return GeneratedAction{}, provider.generateErrors[index]
	}
	return provider.generate[index], nil
}
func (provider *fakeActionProvider) Refine(context.Context, RefineActionAIInput) (RefinedAction, error) {
	index := provider.refineCalls
	provider.refineCalls++
	return provider.refine[index], nil
}

type fixedAIClock struct{}

func (fixedAIClock) Now() time.Time { return time.Date(2026, 8, 16, 1, 2, 3, 0, time.UTC) }

type sequenceIDs struct{ next int }

func (ids *sequenceIDs) NewID() (string, error) {
	ids.next++
	return testUUID(ids.next), nil
}

func validAISnapshot() Snapshot {
	return Snapshot{Current: domaincycle.PDCACycle{
		ID: "cycle", UserID: "user", Status: domaincycle.StatusActive,
		Plan: "plan", Do: "do", Check: "check", Action: "", ContentRevision: 3,
	}}
}

func testAISettings() Settings {
	return Settings{
		Provider: "openai", Model: "test", MaxInputTokens: 10_000, MaxOutputTokens: 800,
		ProviderTimeout: time.Second, MaxProviderAttempts: 2, MaxGenerationsPerUser24h: 10,
		GeneratePromptVersion: "generate-action-v1", RefinePromptVersion: "refine-action-v1",
		MonthlyBudgetUSD: 100, InputUSDPerMillion: 1, OutputUSDPerMillion: 2,
		RatePerUserMinute: 3, RatePerSessionMinute: 3, RatePerIPMinute: 10,
		RateLimitHMACKey: []byte("test-key"), LeaseDuration: time.Minute,
	}
}

func testUUID(number int) string {
	return "00000000-0000-4000-8000-00000000000" + string(rune('0'+number))
}
