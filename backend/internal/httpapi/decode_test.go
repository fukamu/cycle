package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestDecodeAndValidateJSONRejectsCommonFormatErrors(t *testing.T) {
	const validBody = `{"operationId":"0198c20b-7b95-7000-8000-000000000001","expectedDraftRevision":0}`
	server := &api{}
	tests := []struct {
		name  string
		body  string
		limit int64
	}{
		{name: "unknown field", body: `{"operationId":"0198c20b-7b95-7000-8000-000000000001","expectedDraftRevision":0,"extra":true}`},
		{name: "case-insensitive field alias", body: `{"operationId":"0198c20b-7b95-7000-8000-000000000001","OperationId":null,"expectedDraftRevision":0}`},
		{name: "negative revision", body: `{"operationId":"0198c20b-7b95-7000-8000-000000000001","expectedDraftRevision":-1}`},
		{name: "non-canonical UUID", body: `{"operationId":"0198C20B-7B95-7000-8000-000000000001","expectedDraftRevision":0}`},
		{name: "UUID v4", body: `{"operationId":"123e4567-e89b-42d3-a456-426614174000","expectedDraftRevision":0}`},
		{name: "trailing JSON value", body: validBody + `{}`},
		{name: "body limit", body: validBody, limit: int64(len(validBody) - 1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			limit := test.limit
			if limit == 0 {
				limit = defaultBodyLimit
			}
			request := httptest.NewRequest("POST", "/", bytes.NewBufferString(test.body))
			var input startGoalRequest
			err := server.decodeAndValidateJSON(httptest.NewRecorder(), request, &input, limit)
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

func TestDecodeAndValidateJSONEnforcesTypedMemberContracts(t *testing.T) {
	const validID = "0198c20b-7b95-7000-8000-000000000001"
	tests := []struct {
		name        string
		body        string
		required    []string
		destination func() any
	}{
		{
			name: "anonymous session", body: `{"bootstrapId":"` + validID + `","turnstileToken":""}`,
			required: []string{"bootstrapId", "turnstileToken"}, destination: func() any { return &createAnonymousRequest{} },
		},
		{
			name: "Google token", body: `{"idToken":"token"}`,
			required: []string{"idToken"}, destination: func() any { return &googleTokenRequest{} },
		},
		{
			name: "account delete", body: `{"confirmed":false}`,
			required: []string{"confirmed"}, destination: func() any { return &deleteAccountRequest{} },
		},
		{
			name: "draft create", body: `{}`,
			destination: func() any { return &createDraftRequest{} },
		},
		{
			name: "draft save", body: `{"body":"","expectedRevision":0}`,
			required: []string{"body", "expectedRevision"}, destination: func() any { return &saveDraftRequest{} },
		},
		{
			name: "review save", body: `{"body":"","expectedReviewDraftId":"` + validID + `","expectedRevision":0}`,
			required: []string{"body", "expectedReviewDraftId", "expectedRevision"}, destination: func() any { return &saveReviewRequest{} },
		},
		{
			name: "goal start", body: `{"operationId":"` + validID + `","expectedDraftRevision":0}`,
			required: []string{"operationId", "expectedDraftRevision"}, destination: func() any { return &startGoalRequest{} },
		},
		{
			name: "goal refine", body: `{"expectedDraftRevision":0}`,
			required: []string{"expectedDraftRevision"}, destination: func() any { return &refineGoalRequest{} },
		},
		{
			name: "suggestion adopt", body: `{"expectedDraftRevision":0}`,
			required: []string{"expectedDraftRevision"}, destination: func() any { return &adoptSuggestionRequest{} },
		},
		{
			name: "review continue", body: `{"operationId":"` + validID + `","expectedGoalRevision":0,"expectedDraftRevision":0}`,
			required: []string{"operationId", "expectedGoalRevision", "expectedDraftRevision"}, destination: func() any { return &continueReviewRequest{} },
		},
		{
			name: "frame save", body: `{"content":"","expectedFrameRevision":0}`,
			required: []string{"content", "expectedFrameRevision"}, destination: func() any { return &saveFrameRequest{} },
		},
		{
			name: "review schedule clear", body: `{"action":"clear","expectedReviewScheduleRevision":0}`,
			required: []string{"action", "expectedReviewScheduleRevision"}, destination: func() any { return &changeReviewScheduleRequest{} },
		},
		{
			name: "action generate", body: `{"expectedContentRevision":0,"confirmReplace":false}`,
			required: []string{"expectedContentRevision", "confirmReplace"}, destination: func() any { return &actionGenerateRequest{} },
		},
		{
			name: "action refine", body: `{"expectedContentRevision":0}`,
			required: []string{"expectedContentRevision"}, destination: func() any { return &actionRefineRequest{} },
		},
		{
			name: "cycle complete", body: `{"operationId":"` + validID + `","expectedGoalRevision":0,"expectedContentRevision":0}`,
			required: []string{"operationId", "expectedGoalRevision", "expectedContentRevision"}, destination: func() any { return &completeCycleRequest{} },
		},
		{
			name: "goal terminate", body: `{"operationId":"` + validID + `","outcome":"ended","expectedGoalRevision":0,"expectedState":"goal_review","confirmDiscardReviewDraft":false}`,
			required: []string{"operationId", "outcome", "expectedGoalRevision", "expectedState"}, destination: func() any { return &terminateGoalRequest{} },
		},
		{
			name: "goal delete", body: `{"confirmed":false,"expectedGoalRevision":0}`,
			required: []string{"confirmed", "expectedGoalRevision"}, destination: func() any { return &deleteGoalRequest{} },
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertDecodeAccepted(t, test.body, test.destination())
			assertDecodeRejected(t, `null`, test.destination())
			for _, member := range test.required {
				t.Run("missing "+member, func(t *testing.T) {
					assertDecodeRejected(t, jsonWithoutMember(t, test.body, member), test.destination())
				})
				t.Run("null "+member, func(t *testing.T) {
					assertDecodeRejected(t, jsonWithNullMember(t, test.body, member), test.destination())
				})
			}
		})
	}
}

func TestDecodeAndValidateJSONPreservesOptionalMemberContracts(t *testing.T) {
	tests := []struct {
		name        string
		missingBody string
		presentBody string
		nullBody    string
		destination func() any
	}{
		{
			name: "initial body", missingBody: `{}`, presentBody: `{"initialBody":""}`, nullBody: `{"initialBody":null}`,
			destination: func() any { return &createDraftRequest{} },
		},
		{
			name: "goal refine expected Goal revision", missingBody: `{"expectedDraftRevision":0}`,
			presentBody: `{"expectedDraftRevision":0,"expectedGoalRevision":0}`,
			nullBody:    `{"expectedDraftRevision":0,"expectedGoalRevision":null}`,
			destination: func() any { return &refineGoalRequest{} },
		},
		{
			name: "suggestion adopt expected Goal revision", missingBody: `{"expectedDraftRevision":0}`,
			presentBody: `{"expectedDraftRevision":0,"expectedGoalRevision":0}`,
			nullBody:    `{"expectedDraftRevision":0,"expectedGoalRevision":null}`,
			destination: func() any { return &adoptSuggestionRequest{} },
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertDecodeAccepted(t, test.missingBody, test.destination())
			assertDecodeAccepted(t, test.presentBody, test.destination())
			assertDecodeRejected(t, test.nullBody, test.destination())
		})
	}
}

func TestDecodeAndValidateJSONPreservesDuplicateMemberLastWins(t *testing.T) {
	const validID = "0198c20b-7b95-7000-8000-000000000001"
	tests := []struct {
		name      string
		body      string
		wantError bool
	}{
		{
			name: "last revision is valid",
			body: `{"operationId":"` + validID + `","expectedDraftRevision":-1,"expectedDraftRevision":0}`,
		},
		{
			name:      "last revision is invalid",
			body:      `{"operationId":"` + validID + `","expectedDraftRevision":0,"expectedDraftRevision":-1}`,
			wantError: true,
		},
		{
			name: "last revision replaces null",
			body: `{"operationId":"` + validID + `","expectedDraftRevision":null,"expectedDraftRevision":0}`,
		},
		{
			name:      "last revision is null",
			body:      `{"operationId":"` + validID + `","expectedDraftRevision":0,"expectedDraftRevision":null}`,
			wantError: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.wantError {
				assertDecodeRejected(t, test.body, &startGoalRequest{})
				return
			}
			assertDecodeAccepted(t, test.body, &startGoalRequest{})
		})
	}
}

func assertDecodeAccepted(t *testing.T, body string, destination any) {
	t.Helper()
	request := httptest.NewRequest("POST", "/", bytes.NewBufferString(body))
	if err := (&api{}).decodeAndValidateJSON(httptest.NewRecorder(), request, destination, defaultBodyLimit); err != nil {
		t.Fatalf("decode body %s: %v", body, err)
	}
}

func assertDecodeRejected(t *testing.T, body string, destination any) {
	t.Helper()
	request := httptest.NewRequest("POST", "/", bytes.NewBufferString(body))
	err := (&api{}).decodeAndValidateJSON(httptest.NewRecorder(), request, destination, defaultBodyLimit)
	if !errors.Is(err, errRequestValidation) {
		t.Fatalf("decode body %s error = %v, want request validation error", body, err)
	}
}

func jsonWithoutMember(t *testing.T, body, member string) string {
	t.Helper()
	object := decodeJSONObjectForTest(t, body)
	delete(object, member)
	return encodeJSONObjectForTest(t, object)
}

func jsonWithNullMember(t *testing.T, body, member string) string {
	t.Helper()
	object := decodeJSONObjectForTest(t, body)
	object[member] = json.RawMessage("null")
	return encodeJSONObjectForTest(t, object)
}

func decodeJSONObjectForTest(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &object); err != nil {
		t.Fatal(err)
	}
	return object
}

func encodeJSONObjectForTest(t *testing.T, object map[string]json.RawMessage) string {
	t.Helper()
	body, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
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
