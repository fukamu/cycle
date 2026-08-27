package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type workspaceObserverRecorder struct {
	events []WorkspaceObservation
}

func (observer *workspaceObserverRecorder) ObserveWorkspace(_ context.Context, event WorkspaceObservation) {
	observer.events = append(observer.events, event)
}

func TestStartGoalMetricsDistinguishLimitFromPersistedInvariant(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name          string
		progressing   int
		wantInvariant bool
		wantEvents    []WorkspaceMetricEvent
	}{
		{
			name: "at limit is ordinary rejection", progressing: 2,
			wantEvents: []WorkspaceMetricEvent{WorkspaceMetricProgressingGoalLimitRejected},
		},
		{
			name: "above limit is rejection and invariant", progressing: 3, wantInvariant: true,
			wantEvents: []WorkspaceMetricEvent{
				WorkspaceMetricProgressingGoalLimitRejected,
				WorkspaceMetricProgressingGoalLimitInvariantViolation,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx := &goalDraftFakeTx{draft: creationDraft("開始する目標", 4), progressing: test.progressing}
			useCases, _ := newGoalDraftTestUseCases(tx, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID)
			observer := &workspaceObserverRecorder{}
			service := &Service{goalDraft: useCases, settings: Settings{EventObserver: observer}}
			_, err := service.StartGoal(
				context.Background(), goalDraftTestUserID, goalDraftTestSessionID, goalDraftTestDraftID, goalDraftTestOperationID, 4,
			)
			if !errors.Is(err, ErrGoalActiveLimit) || errors.Is(err, ErrProgressingGoalLimitInvariant) != test.wantInvariant {
				t.Fatalf("error = %v, want invariant=%v", err, test.wantInvariant)
			}
			if len(observer.events) != len(test.wantEvents) {
				t.Fatalf("events = %#v, want %#v", observer.events, test.wantEvents)
			}
			for index, want := range test.wantEvents {
				if observer.events[index].Event != want {
					t.Fatalf("events = %#v, want %#v", observer.events, test.wantEvents)
				}
			}
		})
	}
}

func TestStartGoalRateLimitMetricEmitsOnlyForLimiterRejection(t *testing.T) {
	t.Parallel()
	requestHash := hashRequest(struct {
		DraftID  string `json:"draftId"`
		Revision int64  `json:"revision"`
	}{goalDraftTestDraftID, 4})
	tests := []struct {
		name       string
		tx         *goalDraftFakeTx
		wantMetric bool
	}{
		{
			name: "rate rejected",
			tx: &goalDraftFakeTx{
				draft:      creationDraft("開始する目標", 4),
				rateCounts: map[string]int{"goal_start_user_minute": 6},
			},
			wantMetric: true,
		},
		{
			name: "database error",
			tx:   &goalDraftFakeTx{fail: map[string]error{"lock_user": errors.New("database unavailable")}},
		},
		{
			name: "replay",
			tx: &goalDraftFakeTx{
				startReplay: &StartReplayState{
					GoalID: goalDraftTestGoalID, CycleID: goalDraftTestCycleID, RequestHash: requestHash,
				},
				goalView: GoalView{ID: goalDraftTestGoalID}, cycleView: CycleView{ID: goalDraftTestCycleID},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			useCases, _ := newGoalDraftTestUseCases(
				test.tx, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID,
			)
			observer := &workspaceObserverRecorder{}
			service := &Service{goalDraft: useCases, settings: Settings{EventObserver: observer}}
			_, _ = service.StartGoal(
				context.Background(), goalDraftTestUserID, goalDraftTestSessionID,
				goalDraftTestDraftID, goalDraftTestOperationID, 4,
			)
			if test.wantMetric {
				if len(observer.events) != 1 || observer.events[0].Event != WorkspaceMetricRateLimitRejected ||
					observer.events[0].Scope != "goal_start" {
					t.Fatalf("events = %#v", observer.events)
				}
			} else if len(observer.events) != 0 {
				t.Fatalf("unexpected events = %#v", observer.events)
			}
		})
	}
}

func TestCreateDraftMetricEmitsOnlyAfterFreshCommit(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name       string
		tx         *goalDraftFakeTx
		wantEvents int
	}{
		{name: "fresh", tx: &goalDraftFakeTx{}, wantEvents: 1},
		{name: "error", tx: &goalDraftFakeTx{fail: map[string]error{"insert_creation_draft": errors.New("failed")}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			useCases, _ := newGoalDraftTestUseCases(test.tx, goalDraftTestDraftID)
			observer := &workspaceObserverRecorder{}
			service := &Service{goalDraft: useCases, settings: Settings{EventObserver: observer}}
			_, _ = service.CreateDraft(context.Background(), goalDraftTestUserID, "新しい目標")
			if len(observer.events) != test.wantEvents {
				t.Fatalf("events = %#v, want %d", observer.events, test.wantEvents)
			}
			if test.wantEvents == 1 && observer.events[0].Event != WorkspaceMetricGoalCreationDraftCreated {
				t.Fatalf("creation event = %#v", observer.events)
			}
		})
	}
}

func TestStartGoalTransitionMetricsEmitOnlyForFreshCommit(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		tx         *goalDraftFakeTx
		wantEvents []WorkspaceMetricEvent
	}{
		{
			name: "fresh",
			tx: &goalDraftFakeTx{
				draft:    creationDraft("開始する目標", 4),
				goalView: GoalView{ID: goalDraftTestGoalID}, cycleView: CycleView{ID: goalDraftTestCycleID},
			},
			wantEvents: []WorkspaceMetricEvent{
				WorkspaceMetricGoalStarted, WorkspaceMetricGoalVersionCreated, WorkspaceMetricCycleStarted,
			},
		},
		{
			name: "replay",
			tx: &goalDraftFakeTx{
				startReplay: &StartReplayState{
					GoalID: goalDraftTestGoalID, CycleID: goalDraftTestCycleID,
					RequestHash: hashRequest(struct {
						DraftID  string `json:"draftId"`
						Revision int64  `json:"revision"`
					}{goalDraftTestDraftID, 4}),
				},
				goalView: GoalView{ID: goalDraftTestGoalID}, cycleView: CycleView{ID: goalDraftTestCycleID},
			},
		},
		{name: "error", tx: &goalDraftFakeTx{fail: map[string]error{"lock_user": errors.New("failed")}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			useCases, _ := newGoalDraftTestUseCases(test.tx, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID)
			observer := &workspaceObserverRecorder{}
			service := &Service{goalDraft: useCases, settings: Settings{EventObserver: observer}}
			_, _ = service.StartGoal(
				context.Background(), goalDraftTestUserID, goalDraftTestSessionID, goalDraftTestDraftID, goalDraftTestOperationID, 4,
			)
			if len(observer.events) != len(test.wantEvents) {
				t.Fatalf("events = %#v, want %#v", observer.events, test.wantEvents)
			}
			for index, event := range test.wantEvents {
				if observer.events[index].Event != event {
					t.Fatalf("events = %#v, want %#v", observer.events, test.wantEvents)
				}
			}
		})
	}
}

func TestContinueAndTerminateMetricsEmitOnlyForFreshTransitions(t *testing.T) {
	t.Parallel()
	t.Run("Continue fresh", func(t *testing.T) {
		tx := reviewTransitionFixture(goal.StatusGoalReview)
		uow := &reviewTransitionTestUOW{tx: tx}
		useCases := NewReviewTransitionUseCases(uow, &reviewTransitionTestClock{now: reviewTransitionTestNow},
			&reviewTransitionTestIDs{values: []string{reviewTransitionTestVersion2ID, reviewTransitionTestCycle2ID}})
		observer := &workspaceObserverRecorder{}
		service := &Service{reviewTransitions: useCases, settings: Settings{EventObserver: observer}}
		_, err := service.ContinueReview(context.Background(), reviewTransitionTestUserID, reviewTransitionTestGoalID,
			reviewTransitionTestOperation, 5, 3)
		if err != nil {
			t.Fatal(err)
		}
		want := []WorkspaceMetricEvent{
			WorkspaceMetricGoalReviewContinued, WorkspaceMetricGoalVersionCreated, WorkspaceMetricCycleStarted,
		}
		if len(observer.events) != len(want) || !observer.events[0].VersionChanged {
			t.Fatalf("continue events = %#v", observer.events)
		}
		for index := range want {
			if observer.events[index].Event != want[index] {
				t.Fatalf("continue events = %#v", observer.events)
			}
		}
	})
	t.Run("Continue replay", func(t *testing.T) {
		tx := reviewTransitionFixture(goal.StatusActiveCycle)
		tx.cycle.ID = reviewTransitionTestCycle2ID
		tx.cycle.SequenceNumber = 2
		tx.goal.Revision = 6
		tx.goal.NextCycleSequenceNumber = 3
		input := ContinueReviewInput{
			UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
			OperationID: reviewTransitionTestOperation, ExpectedGoalRevision: 5, ExpectedDraftRevision: 3,
		}
		tx.continueReceipts = []*ContinueReviewReceipt{{
			GoalID: input.GoalID, CycleID: tx.cycle.ID, RequestHash: continueReviewRequestHash(input), VersionCreated: false,
		}}
		useCases := NewReviewTransitionUseCases(&reviewTransitionTestUOW{tx: tx}, nil, nil)
		observer := &workspaceObserverRecorder{}
		service := &Service{reviewTransitions: useCases, settings: Settings{EventObserver: observer}}
		_, err := service.ContinueReview(context.Background(), input.UserID, input.GoalID, input.OperationID,
			input.ExpectedGoalRevision, input.ExpectedDraftRevision)
		if err != nil || len(observer.events) != 0 {
			t.Fatalf("continue replay error/events = %v/%#v", err, observer.events)
		}
	})
	t.Run("Terminate fresh", func(t *testing.T) {
		tx := reviewTransitionFixture(goal.StatusActiveCycle)
		revision := tx.cycle.Revisions.Content
		input := TerminateInput{
			UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
			OperationID: reviewTransitionTestOperation, Outcome: goal.StatusAchieved,
			ExpectedGoalRevision: 5, ExpectedState: goal.StatusActiveCycle,
			ActiveCycleID: tx.cycle.ID, ExpectedCycleContentRevision: &revision,
		}
		useCases := NewReviewTransitionUseCases(&reviewTransitionTestUOW{tx: tx},
			&reviewTransitionTestClock{now: reviewTransitionTestNow}, nil)
		observer := &workspaceObserverRecorder{}
		service := &Service{reviewTransitions: useCases, settings: Settings{EventObserver: observer}}
		_, err := service.Terminate(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		if len(observer.events) != 2 || observer.events[0].Event != WorkspaceMetricGoalTerminal ||
			observer.events[0].Outcome != goal.StatusAchieved || observer.events[0].SourceState != goal.StatusActiveCycle ||
			observer.events[1].Event != WorkspaceMetricCycleCanceled ||
			observer.events[1].CancellationReason != cycle.CancellationGoalAchieved {
			t.Fatalf("terminate events = %#v", observer.events)
		}
	})
	t.Run("Terminate replay", func(t *testing.T) {
		tx := reviewTransitionFixture(goal.StatusActiveCycle)
		revision := tx.cycle.Revisions.Content
		input := TerminateInput{
			UserID: reviewTransitionTestUserID, GoalID: reviewTransitionTestGoalID,
			OperationID: reviewTransitionTestOperation, Outcome: goal.StatusEnded,
			ExpectedGoalRevision: 5, ExpectedState: goal.StatusActiveCycle,
			ActiveCycleID: tx.cycle.ID, ExpectedCycleContentRevision: &revision,
		}
		now := reviewTransitionTestNow
		reason := cycle.CancellationGoalEnded
		tx.goal.Status, tx.goal.Revision, tx.goal.TerminalAt = goal.StatusEnded, 6, &now
		tx.cycle.Status, tx.cycle.CanceledAt, tx.cycle.CancellationReason = cycle.StatusCanceled, &now, &reason
		tx.termination = &GoalTerminationReceipt{GoalID: input.GoalID, RequestHash: terminateRequestHash(input)}
		useCases := NewReviewTransitionUseCases(&reviewTransitionTestUOW{tx: tx}, nil, nil)
		observer := &workspaceObserverRecorder{}
		service := &Service{reviewTransitions: useCases, settings: Settings{EventObserver: observer}}
		_, err := service.Terminate(context.Background(), input)
		if err != nil || len(observer.events) != 0 {
			t.Fatalf("terminate replay error/events = %v/%#v", err, observer.events)
		}
	})
}

func TestDeleteGoalMetricLabelsFreshReplayAndFailure(t *testing.T) {
	t.Parallel()
	requestHash := goalDeleteRequestHash(goalDeleteGoalID, true, 7)
	tests := []struct {
		name       string
		configure  func(*goalDeleteFakeTx)
		wantResult string
		wantSource goal.Status
	}{
		{
			name: "fresh", wantResult: "success", wantSource: goal.StatusActiveCycle,
			configure: func(tx *goalDeleteFakeTx) { tx.target.Status = goal.StatusActiveCycle },
		},
		{
			name: "replay", wantResult: "idempotent",
			configure: func(tx *goalDeleteFakeTx) {
				tx.receipt = &GoalDeleteReceipt{
					GoalID: goalDeleteGoalID, RequestHash: requestHash, ExpiresAt: goalDeleteTestNow.Add(time.Minute),
				}
			},
		},
		{
			name: "failure", wantResult: "failure", wantSource: goal.StatusGoalReview,
			configure: func(tx *goalDeleteFakeTx) { tx.target.Status, tx.target.Revision = goal.StatusGoalReview, 8 },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx := newGoalDeleteFakeTx()
			test.configure(tx)
			useCases, _ := newGoalDeleteTestUseCases(tx)
			observer := &workspaceObserverRecorder{}
			service := &Service{goals: useCases, settings: Settings{EventObserver: observer}}
			_ = service.DeleteGoal(context.Background(), goalDeleteUserID, goalDeleteGoalID, true, 7, goalDeleteKey)
			if len(observer.events) != 1 || observer.events[0].Event != WorkspaceMetricGoalDeleted ||
				observer.events[0].Result != test.wantResult || observer.events[0].SourceState != test.wantSource {
				t.Fatalf("delete event = %#v", observer.events)
			}
		})
	}
}

func TestSuggestionAdoptionMetricEmitsOnlyForFreshCAS(t *testing.T) {
	t.Parallel()
	adoptedAt := goalDraftTestNow
	adoptedRevision := int64(5)
	tests := []struct {
		name       string
		tx         *goalDraftFakeTx
		wantEvents int
	}{
		{
			name: "fresh",
			tx: &goalDraftFakeTx{
				draft:      creationDraft("元の本文", 4),
				suggestion: GoalSuggestionState{TargetRevision: 4, SourceText: "元の本文", Output: "改善した本文"},
			},
			wantEvents: 1,
		},
		{
			name: "replay",
			tx: &goalDraftFakeTx{
				draft: creationDraft("改善した本文", 5),
				suggestion: GoalSuggestionState{
					TargetRevision: 4, SourceText: "元の本文", Output: "改善した本文",
					AdoptedAt: &adoptedAt, AdoptedDraftRevision: &adoptedRevision,
				},
			},
		},
		{
			name: "error",
			tx: &goalDraftFakeTx{
				draft:      creationDraft("編集後", 5),
				suggestion: GoalSuggestionState{TargetRevision: 4, SourceText: "元の本文", Output: "改善した本文"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			useCases, _ := newGoalDraftTestUseCases(test.tx)
			observer := &workspaceObserverRecorder{}
			service := &Service{goalDraft: useCases, settings: Settings{EventObserver: observer}}
			_, _ = service.AdoptGoalSuggestion(
				context.Background(), goalDraftTestUserID, goalDraftTestDraftID, "", goalDraftTestGenerationID,
				test.tx.draft.Revision, nil,
			)
			if len(observer.events) != test.wantEvents {
				t.Fatalf("events = %#v, want %d", observer.events, test.wantEvents)
			}
			if test.wantEvents == 1 && (observer.events[0].Event != WorkspaceMetricAISuggestionAdopted ||
				observer.events[0].SuggestionSource != "creation") {
				t.Fatalf("adoption event = %#v", observer.events)
			}
		})
	}
}

type aiObservationRecorder struct {
	observations []AIObservation
}

func (observer *aiObservationRecorder) ObserveAI(_ context.Context, observation AIObservation) {
	observer.observations = append(observer.observations, observation)
}

func TestAIObserverCallsCoverAttemptsRejectionsAndSettlementPaths(t *testing.T) {
	t.Parallel()
	t.Run("provider attempt results", func(t *testing.T) {
		for _, test := range []struct {
			name       string
			err        error
			wantResult string
		}{
			{name: "success", wantResult: "success"},
			{name: "invalid", err: ErrAIInvalidResponse, wantResult: "invalid_response"},
			{name: "timeout", err: ErrAIProviderTimeout, wantResult: "timeout"},
			{name: "unavailable", err: ErrAIProviderUnavailable, wantResult: "unavailable"},
			{name: "rejected", err: ErrAIProviderRejected, wantResult: "rejected"},
			{name: "failure", err: errors.New("failure"), wantResult: "failure"},
		} {
			t.Run(test.name, func(t *testing.T) {
				observer := &workspaceObserverRecorder{}
				service := &Service{settings: Settings{EventObserver: observer, MaxProviderAttempts: 1}}
				_, _ = service.executeAIAttempts(context.Background(), domainai.OperationActionGenerate,
					func(context.Context, bool) (string, AIUsage, error) { return "", AIUsage{}, test.err })
				if len(observer.events) != 1 || observer.events[0].Event != WorkspaceMetricAIProviderAttempt ||
					observer.events[0].Operation != domainai.OperationActionGenerate || observer.events[0].Result != test.wantResult {
					t.Fatalf("attempt events = %#v", observer.events)
				}
			})
		}
	})
	t.Run("rejections", func(t *testing.T) {
		observer := &workspaceObserverRecorder{}
		service := &Service{settings: Settings{EventObserver: observer}}
		service.observeAIRejection(context.Background(), ErrAIUserLimit)
		service.observeAIRejection(context.Background(), ErrAIBudget)
		service.observeAIRejection(context.Background(), ErrAIRateLimit)
		if len(observer.events) != 3 || observer.events[0].Event != WorkspaceMetricAIQuotaRejected ||
			observer.events[1].Event != WorkspaceMetricAIBudgetRejected ||
			observer.events[2].Event != WorkspaceMetricRateLimitRejected || observer.events[2].Scope != "ai" {
			t.Fatalf("rejection events = %#v", observer.events)
		}
	})
	t.Run("normal late and failed settlement", func(t *testing.T) {
		for _, test := range []struct {
			name        string
			response    AIResponse
			providerErr error
			finishErr   error
			wantAI      string
		}{
			{
				name:     "normal success",
				response: AIResponse{ContextChanged: true, SettlementPath: "normal", SettlementResult: "success"},
				wantAI:   "success",
			},
			{
				name:        "late idempotent provider failure",
				response:    AIResponse{SettlementPath: "late", SettlementResult: "idempotent"},
				providerErr: ErrAIProviderUnavailable, wantAI: "failure",
			},
			{
				name:      "commit failure",
				response:  AIResponse{SettlementPath: "normal", SettlementResult: "failure"},
				finishErr: errors.New("commit failed"), wantAI: "failure",
			},
		} {
			t.Run(test.name, func(t *testing.T) {
				events := &workspaceObserverRecorder{}
				aiObserver := &aiObservationRecorder{}
				service := &Service{
					clock:    goalDraftFakeClock{now: goalDraftTestNow},
					settings: Settings{EventObserver: events, AIObserver: aiObserver},
				}
				service.observeAI(context.Background(), AISnapshot{
					GenerationID: goalDraftTestGenerationID, Operation: domainai.OperationGoalRefine,
				}, AIExecutionResult{}, test.response, test.providerErr, test.finishErr, 7, goalDraftTestNow)
				if len(events.events) != 1 || events.events[0].Event != WorkspaceMetricAICostSettlement ||
					events.events[0].SettlementPath != test.response.SettlementPath ||
					events.events[0].Result != test.response.SettlementResult {
					t.Fatalf("settlement events = %#v", events.events)
				}
				if len(aiObserver.observations) != 1 || aiObserver.observations[0].Result != test.wantAI ||
					aiObserver.observations[0].ContextChanged != test.response.ContextChanged ||
					aiObserver.observations[0].ProviderDuration != 7 {
					t.Fatalf("AI observations = %#v", aiObserver.observations)
				}
			})
		}
	})
}

var errAICorrelationProbe = errors.New("stop after correlation probe")

type actionCorrelationProbeUOW struct {
	tx    *actionCorrelationProbeTx
	entry ports.Correlation
}

func (uow *actionCorrelationProbeUOW) WithinActionAITransaction(ctx context.Context, operation func(ActionAITx) error) error {
	uow.entry = ports.CorrelationFromContext(ctx)
	return operation(uow.tx)
}

type actionCorrelationProbeTx struct {
	ActionAITx
	replay   *ActionAIReplayState
	finds    []ports.Correlation
	observed ports.Correlation
}

func (*actionCorrelationProbeTx) LockUser(context.Context, string) error { return nil }

func (tx *actionCorrelationProbeTx) FindActionAIReplay(ctx context.Context, _ string, _ domainai.OperationType, _ string) (*ActionAIReplayState, error) {
	tx.finds = append(tx.finds, ports.CorrelationFromContext(ctx))
	return tx.replay, nil
}

func (tx *actionCorrelationProbeTx) LockGoalWithCurrentVersion(ctx context.Context, _ string, _ string) (GoalTargetState, error) {
	tx.observed = ports.CorrelationFromContext(ctx)
	return GoalTargetState{}, errAICorrelationProbe
}

type goalCorrelationProbeUOW struct {
	tx    *goalCorrelationProbeTx
	entry ports.Correlation
}

func (uow *goalCorrelationProbeUOW) WithinGoalDraftTransaction(ctx context.Context, operation func(GoalDraftTx) error) error {
	uow.entry = ports.CorrelationFromContext(ctx)
	return operation(uow.tx)
}

type goalCorrelationProbeTx struct {
	GoalDraftTx
	replay   *GoalRefineReplayState
	observed ports.Correlation
}

func (*goalCorrelationProbeTx) LockUser(context.Context, string) error { return nil }

func (tx *goalCorrelationProbeTx) FindGoalRefineReplay(context.Context, string, string) (*GoalRefineReplayState, error) {
	return tx.replay, nil
}

func (tx *goalCorrelationProbeTx) LockDraftByID(ctx context.Context, _ string, _ string) (goal.Draft, error) {
	tx.observed = ports.CorrelationFromContext(ctx)
	return goal.Draft{}, errAICorrelationProbe
}

func TestAIBeginCorrelationUsesPersistedReplayIDAndNeverCandidate(t *testing.T) {
	t.Parallel()
	const (
		candidateID = "10000000-0000-7000-8000-000000000001"
		persistedID = "20000000-0000-7000-8000-000000000001"
		requestID   = "request-id"
	)
	baseContext := ports.WithRequestCorrelation(context.Background(), requestID)
	t.Run("Action fresh and replay", func(t *testing.T) {
		input := ActionGenerateInput{
			UserID: "user", GoalID: "goal", CycleID: "cycle",
			ExpectedContentRevision: 7, IdempotencyKey: "operation",
		}
		for _, replayed := range []bool{false, true} {
			t.Run(map[bool]string{false: "fresh", true: "replay"}[replayed], func(t *testing.T) {
				tx := &actionCorrelationProbeTx{}
				wantGenerationID := candidateID
				if replayed {
					wantGenerationID = persistedID
					requestHash := actionAIRequestHash(actionAIInput{
						UserID: input.UserID, GoalID: input.GoalID, CycleID: input.CycleID,
						Operation:               domainai.OperationActionGenerate,
						ExpectedContentRevision: input.ExpectedContentRevision, IdempotencyKey: input.IdempotencyKey,
					})
					output := "replayed action"
					tx.replay = &ActionAIReplayState{
						GenerationID: persistedID, GoalID: input.GoalID, CycleID: input.CycleID,
						IdempotencyRequestHash: requestHash, Status: aiStatusSucceeded,
						TargetRevision: input.ExpectedContentRevision, Output: &output,
					}
				}
				uow := &actionCorrelationProbeUOW{tx: tx}
				service := NewService(nil, nil, nil, nil, nil, nil, nil, uow, nil, nil,
					replayTestClock{}, replayTestIDs{}, Settings{})
				_, err := service.GenerateAction(baseContext, input)
				if !errors.Is(err, errAICorrelationProbe) {
					t.Fatalf("error = %v", err)
				}
				if uow.entry.AIGenerationID != "" || uow.entry.RequestID != requestID {
					t.Fatalf("transaction entry correlation = %#v", uow.entry)
				}
				if tx.observed.AIGenerationID != wantGenerationID ||
					tx.observed.AIOperationType != string(domainai.OperationActionGenerate) || tx.observed.RequestID != requestID {
					t.Fatalf("observed correlation = %#v, want generation %q", tx.observed, wantGenerationID)
				}
			})
		}
	})
	t.Run("Goal Refine fresh and replay", func(t *testing.T) {
		input := GoalRefineInput{UserID: "user", DraftID: "draft", IdempotencyKey: "operation"}
		for _, replayed := range []bool{false, true} {
			t.Run(map[bool]string{false: "fresh", true: "replay"}[replayed], func(t *testing.T) {
				tx := &goalCorrelationProbeTx{}
				wantGenerationID := candidateID
				if replayed {
					wantGenerationID = persistedID
					tx.replay = &GoalRefineReplayState{GenerationID: persistedID}
				}
				uow := &goalCorrelationProbeUOW{tx: tx}
				service := NewService(nil, uow, nil, nil, nil, nil, nil, nil, nil, nil,
					replayTestClock{}, replayTestIDs{}, Settings{})
				_, err := service.RefineGoal(baseContext, input)
				if !errors.Is(err, errAICorrelationProbe) {
					t.Fatalf("error = %v", err)
				}
				if uow.entry.AIGenerationID != "" || uow.entry.RequestID != requestID {
					t.Fatalf("transaction entry correlation = %#v", uow.entry)
				}
				if tx.observed.AIGenerationID != wantGenerationID ||
					tx.observed.AIOperationType != string(domainai.OperationGoalRefine) || tx.observed.RequestID != requestID {
					t.Fatalf("observed correlation = %#v, want generation %q", tx.observed, wantGenerationID)
				}
			})
		}
	})
}

func TestActionReplayStatesAreReReadWithPersistedCorrelation(t *testing.T) {
	t.Parallel()
	const (
		persistedID = "20000000-0000-7000-8000-000000000001"
		requestID   = "request-id"
	)
	input := ActionGenerateInput{
		UserID: "user", GoalID: "goal", CycleID: "cycle",
		ExpectedContentRevision: 7, IdempotencyKey: "operation",
	}
	requestHash := actionAIRequestHash(actionAIInput{
		UserID: input.UserID, GoalID: input.GoalID, CycleID: input.CycleID,
		Operation:               domainai.OperationActionGenerate,
		ExpectedContentRevision: input.ExpectedContentRevision, IdempotencyKey: input.IdempotencyKey,
	})
	output := "replayed action"
	for _, test := range []struct {
		name        string
		status      string
		failureCode string
		output      *string
		checkError  func(error) bool
	}{
		{
			name: "running", status: aiStatusRunning,
			checkError: func(err error) bool {
				var inProgress *AIOperationInProgressError
				return errors.As(err, &inProgress)
			},
		},
		{
			name: "failed", status: aiStatusFailed, failureCode: "provider_unavailable",
			checkError: func(err error) bool { return errors.Is(err, ErrAIProviderUnavailable) },
		},
		{
			name: "succeeded", status: aiStatusSucceeded, output: &output,
			checkError: func(err error) bool { return errors.Is(err, errAICorrelationProbe) },
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			tx := &actionCorrelationProbeTx{replay: &ActionAIReplayState{
				GenerationID: persistedID, GoalID: input.GoalID, CycleID: input.CycleID,
				IdempotencyRequestHash: requestHash, Status: test.status,
				TargetRevision: input.ExpectedContentRevision, FailureCode: test.failureCode, Output: test.output,
			}}
			uow := &actionCorrelationProbeUOW{tx: tx}
			service := NewService(nil, nil, nil, nil, nil, nil, nil, uow, nil, nil,
				replayTestClock{}, replayTestIDs{}, Settings{})
			_, err := service.GenerateAction(ports.WithRequestCorrelation(context.Background(), requestID), input)
			if !test.checkError(err) {
				t.Fatalf("error = %v", err)
			}
			if len(tx.finds) != 2 || tx.finds[0].AIGenerationID != "" ||
				tx.finds[1].AIGenerationID != persistedID || tx.finds[1].RequestID != requestID ||
				tx.finds[1].AIOperationType != string(domainai.OperationActionGenerate) {
				t.Fatalf("replay find correlations = %#v", tx.finds)
			}
		})
	}
}

func TestFinishGoalRefinePreservesContextChangedOnProviderFailure(t *testing.T) {
	t.Parallel()
	tx := &goalDraftFakeTx{
		draft: creationDraft("Provider中に編集", 2),
		generationLocator: &AIGenerationLocator{
			UserID: goalDraftTestUserID, Operation: goalRefineOperation, Status: aiStatusRunning,
			DraftID: goalDraftTestDraftID,
		},
		settlementState: GoalRefineSettlementState{
			BudgetMonthUtc: goalDraftTestMonth, ReservedCostUSD: "0.10000000", TargetRevision: 1,
		},
	}
	useCases, _ := newGoalDraftTestUseCases(tx)
	response, err := useCases.FinishGoalRefine(context.Background(), AISnapshot{
		GenerationID: goalDraftTestGenerationID, TargetRevision: 1,
	}, AIExecutionResult{}, ErrAIProviderUnavailable, goalDraftTestNow)
	if !errors.Is(err, ErrAIProviderUnavailable) || !response.ContextChanged ||
		response.SettlementPath != "normal" || response.SettlementResult != "success" {
		t.Fatalf("response/error = %#v / %v", response, err)
	}
}

func TestFinishActionAIPreservesContextChangedOnProviderFailure(t *testing.T) {
	t.Parallel()
	now := goalDraftTestNow
	current := actionAIUnitFixture(now)
	current.Revisions.Content = 9
	tx := &actionAIUnitTestTx{
		target: GoalTargetState{Status: goal.StatusActiveCycle, CurrentVersionID: current.GoalVersionID}, current: current,
		locator: &AIGenerationLocator{UserID: current.UserID, GoalID: current.GoalID, CycleID: current.ID,
			Operation: domainai.OperationActionGenerate, Status: aiStatusRunning},
		settlement: ActionAISettlementState{
			GoalVersionID: current.GoalVersionID, BudgetMonthUtc: goalDraftTestMonth,
			ReservedCostUSD: "0.05", TargetRevision: 7,
		},
		terminalRows: 1, budgetRows: 1, usageRows: 1,
	}
	useCases, _ := newActionAIUnitUseCases(tx, now, &actionAIUnitTestIDs{})
	response, err := useCases.Finish(context.Background(), AISnapshot{
		GenerationID: goalDraftTestGenerationID, Operation: domainai.OperationActionGenerate, TargetRevision: 7,
	}, AIExecutionResult{}, ErrAIProviderUnavailable, now)
	if !errors.Is(err, ErrAIProviderUnavailable) || !response.ContextChanged ||
		response.SettlementPath != "normal" || response.SettlementResult != "success" {
		t.Fatalf("response/error = %#v / %v", response, err)
	}
}
