package aiprovider

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/responses"
	"github.com/openai/openai-go/v3/shared"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
)

type OpenAI struct {
	client          openai.Client
	model           openai.ResponsesModel
	reasoningEffort shared.ReasoningEffort
	maxOutputTokens int64
	inputPrice      float64
	outputPrice     float64
}

var (
	_ workspace.GoalRefiner     = (*OpenAI)(nil)
	_ workspace.ActionGenerator = (*OpenAI)(nil)
)

func NewOpenAI(apiKey, model, reasoningEffort string, timeout time.Duration, maxOutputTokens int, inputUSDPerMillion, outputUSDPerMillion float64) *OpenAI {
	client := openai.NewClient(
		option.WithAPIKey(apiKey), option.WithMaxRetries(0),
		option.WithHTTPClient(&http.Client{Timeout: timeout}),
	)
	return &OpenAI{client: client, model: openai.ResponsesModel(model), reasoningEffort: shared.ReasoningEffort(reasoningEffort), maxOutputTokens: int64(maxOutputTokens), inputPrice: inputUSDPerMillion, outputPrice: outputUSDPerMillion}
}

func (provider *OpenAI) RefineGoal(ctx context.Context, input workspace.RefineGoalAIInput) (workspace.GoalRefineAIResult, workspace.AIUsage, error) {
	raw, usage, err := provider.execute(ctx, string(domainai.OperationGoalRefine), input.Instructions, input.MaxOutputTokens, input, goalRefineContract())
	if err != nil {
		return workspace.GoalRefineAIResult{}, usage, err
	}
	result, err := decodeGoalRefine(raw)
	if err != nil {
		return workspace.GoalRefineAIResult{}, usage, workspace.ErrAIInvalidResponse
	}
	return result, usage, nil
}

func (provider *OpenAI) GenerateAction(ctx context.Context, input workspace.GenerateActionAIInput) (workspace.GenerateActionAIResult, workspace.AIUsage, error) {
	if input.CurrentCycle == nil {
		return workspace.GenerateActionAIResult{}, workspace.AIUsage{}, workspace.ErrAIInputIncomplete
	}
	raw, usage, err := provider.execute(ctx, string(domainai.OperationActionGenerate), input.Instructions, input.MaxOutputTokens, input, actionGenerateContract())
	if err != nil {
		return workspace.GenerateActionAIResult{}, usage, err
	}
	result, err := decodeGeneratedActions(raw)
	if err != nil {
		return workspace.GenerateActionAIResult{}, usage, workspace.ErrAIInvalidResponse
	}
	return result, usage, nil
}

func (provider *OpenAI) RefineAction(ctx context.Context, input workspace.RefineActionAIInput) (workspace.RefineActionAIResult, workspace.AIUsage, error) {
	if input.CurrentCycle == nil {
		return workspace.RefineActionAIResult{}, workspace.AIUsage{}, workspace.ErrAIInputIncomplete
	}
	raw, usage, err := provider.execute(ctx, string(domainai.OperationActionRefine), input.Instructions, input.MaxOutputTokens, input, actionRefineContract())
	if err != nil {
		return workspace.RefineActionAIResult{}, usage, err
	}
	result, err := decodeRefinedAction(raw)
	if err != nil {
		return workspace.RefineActionAIResult{}, usage, workspace.ErrAIInvalidResponse
	}
	return result, usage, nil
}

type responseContract struct {
	schemaName string
	schema     map[string]any
}

func (provider *OpenAI) execute(ctx context.Context, operationType, instructions string, maxOutputTokens int64, input any, contract responseContract) (output string, usage workspace.AIUsage, resultErr error) {
	attributes := []attribute.KeyValue{attribute.String("fukamu.ai_operation_type", operationType)}
	correlation := ports.CorrelationFromContext(ctx)
	if correlation.RequestID != "" {
		attributes = append(attributes, attribute.String("fukamu.request_id", correlation.RequestID))
	}
	if correlation.AIGenerationID != "" {
		attributes = append(attributes, attribute.String("fukamu.ai_generation_id", correlation.AIGenerationID))
	}
	ctx, span := otel.Tracer("fukamu-cycle/openai").Start(ctx, "openai.responses.create",
		trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(attributes...))
	defer func() {
		if resultErr != nil {
			span.SetStatus(codes.Error, "provider request failed")
		}
		span.End()
	}()
	return provider.executeRequest(ctx, instructions, maxOutputTokens, input, contract)
}

func (provider *OpenAI) executeRequest(ctx context.Context, instructions string, maxOutputTokens int64, input any, contract responseContract) (string, workspace.AIUsage, error) {
	if strings.TrimSpace(instructions) == "" {
		return "", workspace.AIUsage{}, workspace.ErrAIInputIncomplete
	}
	content, err := json.Marshal(input)
	if err != nil {
		return "", workspace.AIUsage{}, workspace.ErrAIInvalidResponse
	}
	format := responses.ResponseFormatTextConfigParamOfJSONSchema(contract.schemaName, contract.schema)
	format.OfJSONSchema.Strict = openai.Bool(true)
	if maxOutputTokens <= 0 {
		maxOutputTokens = provider.maxOutputTokens
	}
	var httpResponse *http.Response
	response, err := provider.client.Responses.New(ctx, responses.ResponseNewParams{
		Model: provider.model, Instructions: openai.String(instructions),
		Input:           responses.ResponseNewParamsInputUnion{OfString: openai.String(string(content))},
		MaxOutputTokens: openai.Int(maxOutputTokens), Store: openai.Bool(false),
		Reasoning: shared.ReasoningParam{Effort: provider.reasoningEffort},
		Text:      responses.ResponseTextConfigParam{Format: format, Verbosity: responses.ResponseTextConfigVerbosityLow},
	}, option.WithResponseInto(&httpResponse))
	providerRequestID := openAIRequestID(httpResponse)
	if err != nil {
		usage := workspace.AIUsage{ProviderRequestID: providerRequestID}
		mappedErr := mapOpenAIError(err, httpResponse)
		if errors.Is(mappedErr, context.Canceled) || errors.Is(mappedErr, workspace.ErrAIProviderTimeout) {
			return "", usage, mappedErr
		}
		if httpResponse != nil && httpResponse.StatusCode >= http.StatusOK && httpResponse.StatusCode < http.StatusMultipleChoices {
			return "", usage, workspace.ErrAIInvalidResponse
		}
		return "", usage, mappedErr
	}
	if response == nil || !response.JSON.Usage.Valid() ||
		!response.Usage.JSON.InputTokens.Valid() || !response.Usage.JSON.OutputTokens.Valid() ||
		response.Usage.InputTokens < 0 || response.Usage.OutputTokens < 0 {
		return "", workspace.AIUsage{ProviderRequestID: providerRequestID}, workspace.ErrAIInvalidResponse
	}
	usage := workspace.AIUsage{
		InputTokens: response.Usage.InputTokens, OutputTokens: response.Usage.OutputTokens,
		ProviderRequestID: providerRequestID,
	}
	usage.CostUSD = (float64(usage.InputTokens)*provider.inputPrice + float64(usage.OutputTokens)*provider.outputPrice) / 1_000_000
	if response.Status != responses.ResponseStatusCompleted {
		return "", usage, workspace.ErrAIInvalidResponse
	}
	return response.OutputText(), usage, nil
}

func openAIRequestID(response *http.Response) string {
	if response == nil {
		return ""
	}
	return response.Header.Get("x-request-id")
}

func goalRefineContract() responseContract {
	return responseContract{schemaName: "fukamu_cycle_goal_suggestion", schema: textSchema("suggestion")}
}

func actionRefineContract() responseContract {
	return responseContract{schemaName: "fukamu_cycle_refined_action", schema: textSchema("refinedAction")}
}

func actionGenerateContract() responseContract {
	return responseContract{schemaName: "fukamu_cycle_generated_actions", schema: map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{"actions": map[string]any{
			"type": "array", "minItems": 1, "maxItems": 3,
			"items": map[string]any{"type": "object", "additionalProperties": false,
				"properties": map[string]any{"text": map[string]any{"type": "string"}}, "required": []string{"text"}},
		}}, "required": []string{"actions"},
	}}
}

func textSchema(field string) map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{field: map[string]any{"type": "string"}}, "required": []string{field},
	}
}

func decodeGoalRefine(raw string) (workspace.GoalRefineAIResult, error) {
	var value struct {
		Suggestion *string `json:"suggestion"`
	}
	if err := decodeStrict(raw, &value); err != nil || value.Suggestion == nil {
		return workspace.GoalRefineAIResult{}, workspace.ErrAIInvalidResponse
	}
	return workspace.GoalRefineAIResult{Suggestion: *value.Suggestion}, nil
}

func decodeGeneratedActions(raw string) (workspace.GenerateActionAIResult, error) {
	var value struct {
		Actions *[]struct {
			Text *string `json:"text"`
		} `json:"actions"`
	}
	if err := decodeStrict(raw, &value); err != nil || value.Actions == nil || len(*value.Actions) < 1 || len(*value.Actions) > 3 {
		return workspace.GenerateActionAIResult{}, workspace.ErrAIInvalidResponse
	}
	actions := make([]string, len(*value.Actions))
	for index, action := range *value.Actions {
		if action.Text == nil {
			return workspace.GenerateActionAIResult{}, workspace.ErrAIInvalidResponse
		}
		actions[index] = *action.Text
	}
	return workspace.GenerateActionAIResult{Actions: actions}, nil
}

func decodeRefinedAction(raw string) (workspace.RefineActionAIResult, error) {
	var value struct {
		RefinedAction *string `json:"refinedAction"`
	}
	if err := decodeStrict(raw, &value); err != nil || value.RefinedAction == nil {
		return workspace.RefineActionAIResult{}, workspace.ErrAIInvalidResponse
	}
	return workspace.RefineActionAIResult{RefinedAction: *value.RefinedAction}, nil
}

func decodeStrict(raw string, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing response data")
	}
	return nil
}

func mapOpenAIError(err error, response *http.Response) error {
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return workspace.ErrAIProviderTimeout
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return workspace.ErrAIProviderTimeout
	}
	statusCode := 0
	if response != nil {
		statusCode = response.StatusCode
	} else {
		var apiError *openai.Error
		if errors.As(err, &apiError) {
			statusCode = apiError.StatusCode
		}
	}
	if statusCode != 0 {
		if statusCode == http.StatusTooManyRequests ||
			(statusCode >= http.StatusInternalServerError && statusCode <= 599) {
			return workspace.ErrAIProviderUnavailable
		}
		return workspace.ErrAIProviderRejected
	}
	return workspace.ErrAIProviderUnavailable
}
