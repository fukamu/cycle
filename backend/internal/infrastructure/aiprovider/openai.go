package aiprovider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/responses"

	"github.com/fukamu/cycle/backend/internal/ai/prompts"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

type OpenAI struct {
	client          openai.Client
	model           openai.ResponsesModel
	maxOutputTokens int64
	inputPrice      float64
	outputPrice     float64
	prompts         prompts.Set
}

func NewOpenAI(apiKey, model string, timeout time.Duration, maxOutputTokens int, inputUSDPerMillion, outputUSDPerMillion float64, promptSet prompts.Set) *OpenAI {
	client := openai.NewClient(
		option.WithAPIKey(apiKey), option.WithMaxRetries(0),
		option.WithHTTPClient(&http.Client{Timeout: timeout}),
	)
	return &OpenAI{client: client, model: openai.ResponsesModel(model), maxOutputTokens: int64(maxOutputTokens), inputPrice: inputUSDPerMillion, outputPrice: outputUSDPerMillion, prompts: promptSet}
}

func (provider *OpenAI) Execute(ctx context.Context, input workspace.AIProviderRequest) (workspace.AIProviderResult, error) {
	instructions, schemaName, schema, decode := operationContract(input.Operation, provider.prompts)
	if instructions == "" {
		return workspace.AIProviderResult{}, workspace.ErrAIInvalidResponse
	}
	content, err := json.Marshal(input)
	if err != nil {
		return workspace.AIProviderResult{}, workspace.ErrAIInvalidResponse
	}
	format := responses.ResponseFormatTextConfigParamOfJSONSchema(schemaName, schema)
	format.OfJSONSchema.Strict = openai.Bool(true)
	maxOutputTokens := input.MaxOutputTokens
	if maxOutputTokens <= 0 {
		maxOutputTokens = provider.maxOutputTokens
	}
	response, err := provider.client.Responses.New(ctx, responses.ResponseNewParams{
		Model: provider.model, Instructions: openai.String(instructions),
		Input:           responses.ResponseNewParamsInputUnion{OfString: openai.String(string(content))},
		MaxOutputTokens: openai.Int(maxOutputTokens), Store: openai.Bool(false),
		Text: responses.ResponseTextConfigParam{Format: format, Verbosity: responses.ResponseTextConfigVerbosityLow},
	})
	if err != nil {
		return workspace.AIProviderResult{}, mapOpenAIError(err)
	}
	output, err := decode(response.OutputText())
	result := workspace.AIProviderResult{
		Output: output, InputTokens: response.Usage.InputTokens, OutputTokens: response.Usage.OutputTokens,
		ProviderRequestID: response.ID, Attempts: 1,
	}
	result.CostUSD = (float64(result.InputTokens)*provider.inputPrice + float64(result.OutputTokens)*provider.outputPrice) / 1_000_000
	if err != nil {
		return result, workspace.ErrAIInvalidResponse
	}
	return result, nil
}

type outputDecoder func(string) (string, error)

func operationContract(operation string, promptSet prompts.Set) (string, string, map[string]any, outputDecoder) {
	switch operation {
	case "goal_refine":
		return promptSet.GoalRefine, "fukamu_cycle_goal_suggestion", textSchema("suggestion"), decodeField("suggestion")
	case "action_refine":
		return promptSet.ActionRefine, "fukamu_cycle_refined_action", textSchema("refinedAction"), decodeField("refinedAction")
	case "action_generate":
		return promptSet.ActionGenerate, "fukamu_cycle_generated_actions", map[string]any{
			"type": "object", "additionalProperties": false,
			"properties": map[string]any{"actions": map[string]any{
				"type": "array", "minItems": 1, "maxItems": 3,
				"items": map[string]any{"type": "object", "additionalProperties": false,
					"properties": map[string]any{"text": map[string]any{"type": "string"}}, "required": []string{"text"}},
			}}, "required": []string{"actions"},
		}, decodeActions
	default:
		return "", "", nil, nil
	}
}

func textSchema(field string) map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{field: map[string]any{"type": "string"}}, "required": []string{field},
	}
}

func decodeField(field string) outputDecoder {
	return func(raw string) (string, error) {
		var value map[string]string
		if err := decodeStrict(raw, &value); err != nil || len(value) != 1 || strings.TrimSpace(value[field]) == "" {
			return "", workspace.ErrAIInvalidResponse
		}
		return value[field], nil
	}
}

func decodeActions(raw string) (string, error) {
	var value struct {
		Actions []struct {
			Text string `json:"text"`
		} `json:"actions"`
	}
	if err := decodeStrict(raw, &value); err != nil || len(value.Actions) < 1 || len(value.Actions) > 3 {
		return "", workspace.ErrAIInvalidResponse
	}
	parts := make([]string, len(value.Actions))
	for index, action := range value.Actions {
		if strings.TrimSpace(action.Text) == "" {
			return "", workspace.ErrAIInvalidResponse
		}
		parts[index] = fmt.Sprintf("%d. %s", index+1, strings.TrimSpace(action.Text))
	}
	return strings.Join(parts, "\n\n"), nil
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

func mapOpenAIError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return workspace.ErrAIProviderTimeout
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return workspace.ErrAIProviderTimeout
	}
	return workspace.ErrAIProviderUnavailable
}
