package httpapi

import (
	"bytes"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestDecodeAndValidateJSONRejectsCommonFormatErrors(t *testing.T) {
	server := &api{}
	tests := []struct {
		name string
		body string
	}{
		{"unknown field", `{"operationId":"0198c20b-7b95-7000-8000-000000000001","expectedDraftRevision":0,"extra":true}`},
		{"negative revision", `{"operationId":"0198c20b-7b95-7000-8000-000000000001","expectedDraftRevision":-1}`},
		{"non-canonical UUID", `{"operationId":"0198C20B-7B95-7000-8000-000000000001","expectedDraftRevision":0}`},
		{"UUID v4", `{"operationId":"123e4567-e89b-42d3-a456-426614174000","expectedDraftRevision":0}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/", bytes.NewBufferString(test.body))
			var input startGoalRequest
			err := server.decodeAndValidateJSON(httptest.NewRecorder(), request, &input, defaultBodyLimit)
			if !errors.Is(err, errRequestValidation) {
				t.Fatalf("error = %v, want request validation error", err)
			}
		})
	}
}

func TestDecodeAndValidateJSONAcceptsContractShape(t *testing.T) {
	server := &api{}
	request := httptest.NewRequest("POST", "/", bytes.NewBufferString(`{"operationId":"0198c20b-7b95-7000-8000-000000000001","expectedDraftRevision":0}`))
	var input startGoalRequest
	if err := server.decodeAndValidateJSON(httptest.NewRecorder(), request, &input, defaultBodyLimit); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeAndValidateJSONRejectsUnregisteredRequestType(t *testing.T) {
	request := httptest.NewRequest("POST", "/", bytes.NewBufferString(`{}`))
	var input struct{}
	err := (&api{}).decodeAndValidateJSON(httptest.NewRecorder(), request, &input, defaultBodyLimit)
	if !errors.Is(err, errRequestValidation) {
		t.Fatalf("error = %v, want request validation error", err)
	}
}

func TestRequestBodyValidationIsExplicitAndFailClosed(t *testing.T) {
	validID := "0198c20b-7b95-7000-8000-000000000001"
	invalidID := "123e4567-e89b-42d3-a456-426614174000"
	zero := int64(0)
	negative := int64(-1)

	tests := []struct {
		name        string
		destination any
		want        bool
	}{
		{"anonymous bootstrap", &createAnonymousRequest{BootstrapID: validID}, true},
		{"anonymous bootstrap UUID v4", &createAnonymousRequest{BootstrapID: invalidID}, false},
		{"Google token", &googleTokenRequest{IDToken: "token"}, true},
		{"empty Google token", &googleTokenRequest{}, false},
		{"account delete", &deleteAccountRequest{}, true},
		{"draft create", &createDraftRequest{}, true},
		{"draft save", &saveDraftRequest{ExpectedRevision: 0}, true},
		{"draft save negative revision", &saveDraftRequest{ExpectedRevision: -1}, false},
		{"review save", &saveReviewRequest{ExpectedReviewDraftID: validID, ExpectedRevision: 0}, true},
		{"review save UUID v4", &saveReviewRequest{ExpectedReviewDraftID: invalidID}, false},
		{"review save negative revision", &saveReviewRequest{ExpectedReviewDraftID: validID, ExpectedRevision: -1}, false},
		{"goal start", &startGoalRequest{OperationID: validID, ExpectedDraftRevision: 0}, true},
		{"goal start UUID v4", &startGoalRequest{OperationID: invalidID}, false},
		{"goal start negative revision", &startGoalRequest{OperationID: validID, ExpectedDraftRevision: -1}, false},
		{"goal refine without Goal revision", &refineGoalRequest{ExpectedDraftRevision: 0}, true},
		{"goal refine with Goal revision", &refineGoalRequest{ExpectedDraftRevision: 0, ExpectedGoalRevision: &zero}, true},
		{"goal refine negative Draft revision", &refineGoalRequest{ExpectedDraftRevision: -1}, false},
		{"goal refine negative Goal revision", &refineGoalRequest{ExpectedGoalRevision: &negative}, false},
		{"suggestion adopt", &adoptSuggestionRequest{ExpectedDraftRevision: 0, ExpectedGoalRevision: &zero}, true},
		{"suggestion adopt negative Goal revision", &adoptSuggestionRequest{ExpectedGoalRevision: &negative}, false},
		{"review continue", &continueReviewRequest{OperationID: validID, ExpectedGoalRevision: 0, ExpectedDraftRevision: 0}, true},
		{"review continue negative Goal revision", &continueReviewRequest{OperationID: validID, ExpectedGoalRevision: -1}, false},
		{"review continue negative Draft revision", &continueReviewRequest{OperationID: validID, ExpectedDraftRevision: -1}, false},
		{"frame save", &saveFrameRequest{ExpectedFrameRevision: 0}, true},
		{"frame save negative revision", &saveFrameRequest{ExpectedFrameRevision: -1}, false},
		{"action generate", &actionGenerateRequest{ExpectedContentRevision: 0}, true},
		{"action generate negative revision", &actionGenerateRequest{ExpectedContentRevision: -1}, false},
		{"action refine", &actionRefineRequest{ExpectedContentRevision: 0}, true},
		{"action refine negative revision", &actionRefineRequest{ExpectedContentRevision: -1}, false},
		{"cycle complete", &completeCycleRequest{OperationID: validID, ExpectedGoalRevision: 0, ExpectedContentRevision: 0}, true},
		{"cycle complete UUID v4", &completeCycleRequest{OperationID: invalidID}, false},
		{"cycle complete negative Goal revision", &completeCycleRequest{OperationID: validID, ExpectedGoalRevision: -1}, false},
		{"cycle complete negative content revision", &completeCycleRequest{OperationID: validID, ExpectedContentRevision: -1}, false},
		{"goal terminate", &terminateGoalRequest{OperationID: validID, Outcome: goal.StatusAchieved, ExpectedGoalRevision: &zero, ExpectedState: goal.StatusGoalReview}, true},
		{"goal terminate UUID v4", &terminateGoalRequest{OperationID: invalidID, Outcome: goal.StatusAchieved, ExpectedGoalRevision: &zero, ExpectedState: goal.StatusGoalReview}, false},
		{"goal terminate missing outcome", &terminateGoalRequest{OperationID: validID, ExpectedGoalRevision: &zero, ExpectedState: goal.StatusGoalReview}, false},
		{"goal terminate missing revision", &terminateGoalRequest{OperationID: validID, Outcome: goal.StatusAchieved, ExpectedState: goal.StatusGoalReview}, false},
		{"goal terminate negative revision", &terminateGoalRequest{OperationID: validID, Outcome: goal.StatusAchieved, ExpectedGoalRevision: &negative, ExpectedState: goal.StatusGoalReview}, false},
		{"goal terminate missing state", &terminateGoalRequest{OperationID: validID, Outcome: goal.StatusAchieved, ExpectedGoalRevision: &zero}, false},
		{"goal delete", &deleteGoalRequest{ExpectedGoalRevision: 0}, true},
		{"goal delete negative revision", &deleteGoalRequest{ExpectedGoalRevision: -1}, false},
		{"unknown request type", &struct{}{}, false},
		{"typed nil request", (*startGoalRequest)(nil), false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isValidRequestBody(test.destination); got != test.want {
				t.Fatalf("isValidRequestBody() = %t, want %t", got, test.want)
			}
		})
	}
}

func TestListQueryValidation(t *testing.T) {
	tests := []struct {
		query     string
		wantScope string
		wantLimit int
		wantError bool
	}{
		{"", "all", 20, false},
		{"?scope=progressing&limit=50", "progressing", 50, false},
		{"?scope=unknown", "", 0, true},
		{"?limit=0", "", 0, true},
		{"?limit=51", "", 0, true},
		{"?limit=abc", "", 0, true},
	}
	for _, test := range tests {
		request := httptest.NewRequest("GET", "/goals"+test.query, nil)
		scope, limit, err := goalListQuery(request)
		if test.wantError {
			if err == nil {
				t.Fatalf("query %q unexpectedly succeeded", test.query)
			}
			continue
		}
		if err != nil || scope != test.wantScope || limit != test.wantLimit {
			t.Fatalf("query %q = (%q, %d, %v)", test.query, scope, limit, err)
		}
	}
}
