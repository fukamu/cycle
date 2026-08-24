package aiprovider

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	openai "github.com/openai/openai-go/v3"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

func TestTypedDecodersReturnRawSemanticValues(t *testing.T) {
	t.Parallel()

	goal, err := decodeGoalRefine(`{"suggestion":"  \r\n"}`)
	if err != nil || goal.Suggestion != "  \r\n" {
		t.Fatalf("goal = %#v, %v", goal, err)
	}
	generated, err := decodeGeneratedActions(`{"actions":[{"text":"  first  "},{"text":""}]}`)
	if err != nil || !reflect.DeepEqual(generated.Actions, []string{"  first  ", ""}) {
		t.Fatalf("generated = %#v, %v", generated, err)
	}
	refined, err := decodeRefinedAction(`{"refinedAction":"  \r\n"}`)
	if err != nil || refined.RefinedAction != "  \r\n" {
		t.Fatalf("refined = %#v, %v", refined, err)
	}
}

func TestTypedTextDecodersRejectInvalidJSONStructure(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name string
		raw  string
	}{
		{name: "missing", raw: `{}`},
		{name: "null", raw: `{"suggestion":null}`},
		{name: "wrong type", raw: `{"suggestion":1}`},
		{name: "unknown", raw: `{"suggestion":"ok","extra":true}`},
		{name: "trailing", raw: `{"suggestion":"ok"} {}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := decodeGoalRefine(test.raw); !errors.Is(err, workspace.ErrAIInvalidResponse) {
				t.Fatalf("decodeGoalRefine(%s) error = %v", test.raw, err)
			}
		})
	}
}

func TestDecodeGeneratedActionsEnforcesOnlyStructureAndCardinality(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name string
		raw  string
	}{
		{name: "missing", raw: `{}`},
		{name: "null", raw: `{"actions":null}`},
		{name: "empty", raw: `{"actions":[]}`},
		{name: "four", raw: `{"actions":[{"text":"1"},{"text":"2"},{"text":"3"},{"text":"4"}]}`},
		{name: "missing item text", raw: `{"actions":[{}]}`},
		{name: "null item text", raw: `{"actions":[{"text":null}]}`},
		{name: "wrong item type", raw: `{"actions":[{"text":1}]}`},
		{name: "unknown item field", raw: `{"actions":[{"text":"1","extra":true}]}`},
		{name: "unknown top field", raw: `{"actions":[{"text":"1"}],"extra":true}`},
		{name: "trailing", raw: `{"actions":[{"text":"1"}]} []`},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := decodeGeneratedActions(test.raw); !errors.Is(err, workspace.ErrAIInvalidResponse) {
				t.Fatalf("decodeGeneratedActions(%s) error = %v", test.raw, err)
			}
		})
	}
}

func TestDecodeRefinedActionRejectsInvalidJSONStructure(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{
		`{}`, `{"refinedAction":null}`, `{"refinedAction":1}`,
		`{"refinedAction":"ok","extra":true}`, `{"refinedAction":"ok"} {}`,
	} {
		if _, err := decodeRefinedAction(raw); !errors.Is(err, workspace.ErrAIInvalidResponse) {
			t.Fatalf("decodeRefinedAction(%s) error = %v", raw, err)
		}
	}
}

func TestOperationSpecificSchemasRemainStrict(t *testing.T) {
	t.Parallel()

	goal := goalRefineContract()
	refine := actionRefineContract()
	generate := actionGenerateContract()
	if goal.schemaName == refine.schemaName || goal.schemaName == generate.schemaName || refine.schemaName == generate.schemaName {
		t.Fatal("schema names must be operation specific")
	}
	for _, contract := range []responseContract{goal, refine, generate} {
		if contract.schema["type"] != "object" || contract.schema["additionalProperties"] != false {
			t.Fatalf("schema %q is not strict: %#v", contract.schemaName, contract.schema)
		}
	}
}

func TestOpenAIResponsesTransportSendsOperationSpecificStrictContracts(t *testing.T) {
	goalInput := workspace.RefineGoalAIInput{
		Instructions: "goal instructions", GoalBody: "Goal", SourceText: "Draft",
		PastCycles: []workspace.AIInputCycle{}, MaxOutputTokens: 401,
	}
	generateInput := workspace.GenerateActionAIInput{
		Instructions: "generate instructions", GoalBody: "Goal",
		CurrentCycle: &workspace.AIInputCycle{
			SequenceNumber: 3, Status: cycle.StatusActive, GoalBody: "Goal v2",
			Plan: "P", Do: "D", Check: "C", Action: "",
		},
		PastCycles: []workspace.AIInputCycle{{
			SequenceNumber: 2, Status: cycle.StatusCompleted, GoalBody: "Goal v1",
			Plan: "past P", Do: "past D", Check: "past C", Action: "past A",
		}},
		MaxOutputTokens: 802,
	}
	refineInput := workspace.RefineActionAIInput{
		Instructions: "refine instructions", GoalBody: "Goal",
		CurrentCycle: &workspace.AIInputCycle{
			SequenceNumber: 3, Status: cycle.StatusActive, GoalBody: "Goal v2",
			Plan: "P", Do: "D", Check: "C", Action: "current A",
		},
		PastCycles: []workspace.AIInputCycle{}, MaxOutputTokens: 0,
	}

	tests := []struct {
		name                 string
		instructions         string
		schemaName           string
		schema               map[string]any
		maxOutputTokens      int64
		expectedInput        any
		structuredOutput     string
		invokeAndAssertTyped func(*testing.T, *OpenAI) workspace.AIUsage
	}{
		{
			name: "goal refine", instructions: goalInput.Instructions,
			schemaName: "fukamu_cycle_goal_suggestion", schema: expectedTextWireSchema("suggestion"),
			maxOutputTokens: goalInput.MaxOutputTokens, expectedInput: goalInput,
			structuredOutput: `{"suggestion":"提案"}`,
			invokeAndAssertTyped: func(t *testing.T, provider *OpenAI) workspace.AIUsage {
				t.Helper()
				result, usage, err := provider.RefineGoal(context.Background(), goalInput)
				if err != nil || result.Suggestion != "提案" {
					t.Fatalf("RefineGoal() = %#v, %v", result, err)
				}
				return usage
			},
		},
		{
			name: "action generate", instructions: generateInput.Instructions,
			schemaName: "fukamu_cycle_generated_actions", schema: expectedGeneratedActionsWireSchema(),
			maxOutputTokens: generateInput.MaxOutputTokens, expectedInput: generateInput,
			structuredOutput: `{"actions":[{"text":"first"},{"text":"second"}]}`,
			invokeAndAssertTyped: func(t *testing.T, provider *OpenAI) workspace.AIUsage {
				t.Helper()
				result, usage, err := provider.GenerateAction(context.Background(), generateInput)
				if err != nil || !reflect.DeepEqual(result.Actions, []string{"first", "second"}) {
					t.Fatalf("GenerateAction() = %#v, %v", result, err)
				}
				return usage
			},
		},
		{
			name: "action refine", instructions: refineInput.Instructions,
			schemaName: "fukamu_cycle_refined_action", schema: expectedTextWireSchema("refinedAction"),
			maxOutputTokens: 999, expectedInput: refineInput,
			structuredOutput: `{"refinedAction":"refined"}`,
			invokeAndAssertTyped: func(t *testing.T, provider *OpenAI) workspace.AIUsage {
				t.Helper()
				result, usage, err := provider.RefineAction(context.Background(), refineInput)
				if err != nil || result.RefinedAction != "refined" {
					t.Fatalf("RefineAction() = %#v, %v", result, err)
				}
				return usage
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			requests := make(chan capturedOpenAIRequest, 1)
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				requests <- captureOpenAIRequest(request)
				writeOpenAIJSON(writer, http.StatusOK, completedOpenAIResponse(test.structuredOutput))
			}))
			defer server.Close()
			t.Setenv("OPENAI_BASE_URL", server.URL+"/v1/")

			provider := NewOpenAI("contract-key", "contract-model", openAIContractReasoningEffort, time.Second, 999, 2.5, 10)
			usage := test.invokeAndAssertTyped(t, provider)
			assertOpenAIUsage(t, usage)
			assertOpenAIWireRequest(t, <-requests, test.instructions, test.schemaName, test.schema, test.maxOutputTokens, test.expectedInput)
		})
	}
}

func TestOpenAIResponsesTransportClassifiesHTTPStatusesWithoutSDKRetries(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		retryable bool
	}{
		{name: "bad request", status: http.StatusBadRequest},
		{name: "unauthorized", status: http.StatusUnauthorized},
		{name: "request timeout", status: http.StatusRequestTimeout},
		{name: "conflict", status: http.StatusConflict},
		{name: "unprocessable entity", status: http.StatusUnprocessableEntity},
		{name: "rate limited", status: http.StatusTooManyRequests, retryable: true},
		{name: "internal server error", status: http.StatusInternalServerError, retryable: true},
		{name: "service unavailable", status: http.StatusServiceUnavailable, retryable: true},
		{name: "last server error", status: 599, retryable: true},
		{name: "outside HTTP server error range", status: 600},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var requestCount atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				requestCount.Add(1)
				writeOpenAIJSON(writer, test.status, map[string]any{"error": map[string]any{
					"message": "provider rejected request", "type": "provider_error", "param": nil, "code": "contract_error",
				}})
			}))
			defer server.Close()
			t.Setenv("OPENAI_BASE_URL", server.URL+"/v1/")

			provider := NewOpenAI("contract-key", "contract-model", openAIContractReasoningEffort, time.Second, 999, 2.5, 10)
			_, usage, err := provider.RefineGoal(context.Background(), validGoalRefineTransportInput())
			assertOpenAIRequestIDWithoutNumericUsage(t, usage)
			if requestCount.Load() != 1 {
				t.Fatalf("request count = %d, want 1; SDK retries must remain disabled", requestCount.Load())
			}
			if test.retryable {
				if !errors.Is(err, workspace.ErrAIProviderUnavailable) {
					t.Fatalf("error = %v, want retryable ErrAIProviderUnavailable", err)
				}
				return
			}
			assertNonRetryableProviderError(t, err)
		})
	}
}

func TestOpenAIResponsesTransportRejectsMalformedIncompleteAndRefusalResponses(t *testing.T) {
	tests := []struct {
		name          string
		writeResponse func(http.ResponseWriter)
		wantUsage     bool
	}{
		{
			name: "malformed JSON",
			writeResponse: func(writer http.ResponseWriter) {
				writer.Header().Set("Content-Type", "application/json")
				writer.Header().Set("X-Request-ID", openAIContractRequestID)
				writer.WriteHeader(http.StatusOK)
				_, _ = io.WriteString(writer, `{"id":`)
			},
		},
		{
			name: "malformed structured output", wantUsage: true,
			writeResponse: func(writer http.ResponseWriter) {
				writeOpenAIJSON(writer, http.StatusOK, completedOpenAIResponse(`{"suggestion":`))
			},
		},
		{
			name: "incomplete response with otherwise valid structured output", wantUsage: true,
			writeResponse: func(writer http.ResponseWriter) {
				response := completedOpenAIResponse(`{"suggestion":"must not be accepted"}`)
				response["status"] = "incomplete"
				response["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
				writeOpenAIJSON(writer, http.StatusOK, response)
			},
		},
		{
			name: "completed refusal", wantUsage: true,
			writeResponse: func(writer http.ResponseWriter) {
				response := completedOpenAIResponse("")
				response["output"] = []any{map[string]any{
					"id": "msg_refusal", "type": "message", "role": "assistant", "status": "completed",
					"content": []any{map[string]any{"type": "refusal", "refusal": "cannot comply"}},
				}}
				writeOpenAIJSON(writer, http.StatusOK, response)
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				test.writeResponse(writer)
			}))
			defer server.Close()
			t.Setenv("OPENAI_BASE_URL", server.URL+"/v1/")

			provider := NewOpenAI("contract-key", "contract-model", openAIContractReasoningEffort, time.Second, 999, 2.5, 10)
			_, usage, err := provider.RefineGoal(context.Background(), validGoalRefineTransportInput())
			if !errors.Is(err, workspace.ErrAIInvalidResponse) {
				t.Fatalf("error = %v, want ErrAIInvalidResponse", err)
			}
			if test.wantUsage {
				assertOpenAIUsage(t, usage)
			} else {
				assertOpenAIRequestIDWithoutNumericUsage(t, usage)
			}
		})
	}
}

func TestOpenAIResponsesTransportRejectsMissingOrInvalidUsage(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "usage missing", mutate: func(response map[string]any) { delete(response, "usage") }},
		{name: "usage null", mutate: func(response map[string]any) { response["usage"] = nil }},
		{name: "input tokens missing", mutate: func(response map[string]any) {
			delete(response["usage"].(map[string]any), "input_tokens")
		}},
		{name: "output tokens missing", mutate: func(response map[string]any) {
			delete(response["usage"].(map[string]any), "output_tokens")
		}},
		{name: "negative input tokens", mutate: func(response map[string]any) {
			response["usage"].(map[string]any)["input_tokens"] = -1
		}},
		{name: "negative output tokens", mutate: func(response map[string]any) {
			response["usage"].(map[string]any)["output_tokens"] = -1
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				response := completedOpenAIResponse(`{"suggestion":"valid output cannot excuse invalid usage"}`)
				test.mutate(response)
				writeOpenAIJSON(writer, http.StatusOK, response)
			}))
			defer server.Close()
			t.Setenv("OPENAI_BASE_URL", server.URL+"/v1/")

			provider := NewOpenAI("contract-key", "contract-model", openAIContractReasoningEffort, time.Second, 999, 2.5, 10)
			_, usage, err := provider.RefineGoal(context.Background(), validGoalRefineTransportInput())
			if !errors.Is(err, workspace.ErrAIInvalidResponse) {
				t.Fatalf("error = %v, want fail-closed ErrAIInvalidResponse", err)
			}
			assertOpenAIRequestIDWithoutNumericUsage(t, usage)
		})
	}
}

func TestOpenAIResponsesTransportMapsClientTimeout(t *testing.T) {
	requestStarted := make(chan struct{})
	requestCanceled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		streamUntilRequestCanceled(t, writer, request, requestStarted, requestCanceled)
	}))
	defer server.Close()
	t.Setenv("OPENAI_BASE_URL", server.URL+"/v1/")

	provider := NewOpenAI("contract-key", "contract-model", openAIContractReasoningEffort, 50*time.Millisecond, 999, 2.5, 10)
	_, usage, err := provider.RefineGoal(context.Background(), validGoalRefineTransportInput())
	if !errors.Is(err, workspace.ErrAIProviderTimeout) {
		t.Fatalf("error = %v, want ErrAIProviderTimeout", err)
	}
	if usage != (workspace.AIUsage{}) {
		t.Fatalf("usage = %#v, want zero", usage)
	}
	select {
	case <-requestStarted:
	default:
		t.Fatal("provider timeout occurred before the request reached the server")
	}
	assertRequestContextCanceled(t, requestCanceled)
}

func TestOpenAIResponsesTransportPreservesCallerCancellation(t *testing.T) {
	requestStarted := make(chan struct{})
	requestCanceled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		streamUntilRequestCanceled(t, writer, request, requestStarted, requestCanceled)
	}))
	defer server.Close()
	t.Setenv("OPENAI_BASE_URL", server.URL+"/v1/")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-requestStarted
		cancel()
	}()
	provider := NewOpenAI("contract-key", "contract-model", openAIContractReasoningEffort, time.Second, 999, 2.5, 10)
	_, usage, err := provider.RefineGoal(ctx, validGoalRefineTransportInput())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if usage != (workspace.AIUsage{}) {
		t.Fatalf("usage = %#v, want zero", usage)
	}
	assertRequestContextCanceled(t, requestCanceled)
}

type capturedOpenAIRequest struct {
	method        string
	path          string
	authorization string
	contentType   string
	body          map[string]any
	err           error
}

func captureOpenAIRequest(request *http.Request) capturedOpenAIRequest {
	captured := capturedOpenAIRequest{
		method: request.Method, path: request.URL.Path,
		authorization: request.Header.Get("Authorization"), contentType: request.Header.Get("Content-Type"),
	}
	defer request.Body.Close()
	captured.err = json.NewDecoder(request.Body).Decode(&captured.body)
	return captured
}

func assertOpenAIWireRequest(
	t *testing.T,
	request capturedOpenAIRequest,
	instructions, schemaName string,
	schema map[string]any,
	maxOutputTokens int64,
	expectedInput any,
) {
	t.Helper()
	if request.err != nil {
		t.Fatalf("decode request: %v", request.err)
	}
	if request.method != http.MethodPost || request.path != "/v1/responses" {
		t.Fatalf("request = %s %s, want POST /v1/responses", request.method, request.path)
	}
	if request.authorization != "Bearer contract-key" {
		t.Fatalf("Authorization = %q", request.authorization)
	}
	if !strings.HasPrefix(request.contentType, "application/json") {
		t.Fatalf("Content-Type = %q", request.contentType)
	}
	if request.body["model"] != "contract-model" || request.body["instructions"] != instructions {
		t.Fatalf("model/instructions = %#v/%#v", request.body["model"], request.body["instructions"])
	}
	if want := map[string]any{"effort": openAIContractReasoningEffort}; !reflect.DeepEqual(request.body["reasoning"], want) {
		t.Fatalf("reasoning = %#v, want %#v", request.body["reasoning"], want)
	}
	store, present := request.body["store"]
	if !present || store != false {
		t.Fatalf("store = %#v (present %t), want explicit false", store, present)
	}
	if request.body["max_output_tokens"] != float64(maxOutputTokens) {
		t.Fatalf("max_output_tokens = %#v, want %d", request.body["max_output_tokens"], maxOutputTokens)
	}
	if _, present := request.body["tools"]; present {
		t.Fatalf("tools must not be enabled: %#v", request.body["tools"])
	}
	for _, forbidden := range []string{"user", "safety_identifier", "previous_response_id"} {
		if _, present := request.body[forbidden]; present {
			t.Fatalf("%s must not be sent", forbidden)
		}
	}

	wantText := map[string]any{
		"format": map[string]any{
			"type": "json_schema", "name": schemaName, "strict": true, "schema": jsonValue(t, schema),
		},
		"verbosity": "low",
	}
	if !reflect.DeepEqual(request.body["text"], wantText) {
		t.Fatalf("text contract = %#v, want %#v", request.body["text"], wantText)
	}

	wireInput, ok := request.body["input"].(string)
	if !ok {
		t.Fatalf("input = %#v, want JSON string", request.body["input"])
	}
	var decodedInput any
	if err := json.Unmarshal([]byte(wireInput), &decodedInput); err != nil {
		t.Fatalf("decode wire input: %v", err)
	}
	if want := jsonValue(t, expectedInput); !reflect.DeepEqual(decodedInput, want) {
		t.Fatalf("input = %#v, want %#v", decodedInput, want)
	}
}

func validGoalRefineTransportInput() workspace.RefineGoalAIInput {
	return workspace.RefineGoalAIInput{
		Instructions: "goal instructions", GoalBody: "Goal", SourceText: "Draft",
		PastCycles: []workspace.AIInputCycle{}, MaxOutputTokens: 401,
	}
}

func expectedTextWireSchema(field string) map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{field: map[string]any{"type": "string"}},
		"required":   []string{field},
	}
}

func expectedGeneratedActionsWireSchema() map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{"actions": map[string]any{
			"type": "array", "minItems": 1, "maxItems": 3,
			"items": map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{"text": map[string]any{"type": "string"}},
				"required":   []string{"text"},
			},
		}},
		"required": []string{"actions"},
	}
}

func completedOpenAIResponse(structuredOutput string) map[string]any {
	return map[string]any{
		"id": openAIContractResponseID, "object": "response", "status": "completed", "model": "contract-model",
		"output": []any{map[string]any{
			"id": "msg_contract", "type": "message", "role": "assistant", "status": "completed",
			"content": []any{map[string]any{
				"type": "output_text", "text": structuredOutput, "annotations": []any{},
			}},
		}},
		"usage": map[string]any{
			"input_tokens": 120, "output_tokens": 30, "total_tokens": 150,
			"input_tokens_details":  map[string]any{"cached_tokens": 0},
			"output_tokens_details": map[string]any{"reasoning_tokens": 0},
		},
	}
}

func writeOpenAIJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("X-Request-ID", openAIContractRequestID)
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

const (
	openAIContractRequestID       = "req_header_contract"
	openAIContractResponseID      = "resp_body_contract_must_not_be_used_for_support"
	openAIContractReasoningEffort = "medium"
)

func assertOpenAIRequestIDWithoutNumericUsage(t *testing.T, usage workspace.AIUsage) {
	t.Helper()
	if usage.InputTokens != 0 || usage.OutputTokens != 0 || usage.CostUSD != 0 ||
		usage.ProviderRequestID != openAIContractRequestID {
		t.Fatalf("usage = %#v, want only support request ID", usage)
	}
}

func assertOpenAIUsage(t *testing.T, usage workspace.AIUsage) {
	t.Helper()
	if usage.InputTokens != 120 || usage.OutputTokens != 30 || usage.ProviderRequestID != openAIContractRequestID {
		t.Fatalf("usage = %#v", usage)
	}
	const wantCost = 0.0006
	if math.Abs(usage.CostUSD-wantCost) > 0.000000001 {
		t.Fatalf("cost = %.12f, want %.12f", usage.CostUSD, wantCost)
	}
}

func assertNonRetryableProviderError(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, workspace.ErrAIProviderRejected) {
		t.Fatalf("error = %v, want ErrAIProviderRejected", err)
	}
	for _, retryable := range []error{
		workspace.ErrAIProviderUnavailable,
		workspace.ErrAIProviderTimeout,
		workspace.ErrAIInvalidResponse,
	} {
		if errors.Is(err, retryable) {
			t.Fatalf("error = %v, ordinary 4xx must not map to retryable %v", err, retryable)
		}
	}
	var sdkError *openai.Error
	if errors.As(err, &sdkError) {
		t.Fatalf("OpenAI SDK error leaked across the Infrastructure boundary: %T", err)
	}
}

func assertRequestContextCanceled(t *testing.T, canceled <-chan struct{}) {
	t.Helper()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("provider request context was not canceled at the server")
	}
}

func streamUntilRequestCanceled(t *testing.T, writer http.ResponseWriter, request *http.Request, started, canceled chan<- struct{}) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, `{"id":`)
	flusher, ok := writer.(http.Flusher)
	if !ok {
		t.Error("test response writer does not support flushing")
		return
	}
	flusher.Flush()
	close(started)
	<-request.Context().Done()
	close(canceled)
}

func jsonValue(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal JSON value: %v", err)
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode JSON value: %v", err)
	}
	return decoded
}
