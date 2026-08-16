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
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
)

type OpenAIActionAI struct {
	client openai.Client
	model  openai.ResponsesModel
}

func NewOpenAIActionAI(apiKey, model string, timeout time.Duration) *OpenAIActionAI {
	client := openai.NewClient(
		option.WithAPIKey(apiKey),
		option.WithMaxRetries(0),
		option.WithHTTPClient(&http.Client{Timeout: timeout}),
	)
	return &OpenAIActionAI{client: client, model: openai.ResponsesModel(model)}
}

func (provider *OpenAIActionAI) Generate(ctx context.Context, input appai.GenerateActionAIInput) (appai.GeneratedAction, error) {
	ctx, span := provider.startSpan(ctx, "generate")
	defer span.End()
	format := responses.ResponseFormatTextConfigParamOfJSONSchema("pdcai_generated_actions", generateSchema())
	format.OfJSONSchema.Strict = openai.Bool(true)
	response, err := provider.client.Responses.New(ctx, responses.ResponseNewParams{
		Model:            provider.model,
		Instructions:     openai.String(retryInstructions(input.Instructions, input.Retry)),
		Input:            responses.ResponseNewParamsInputUnion{OfString: openai.String(input.Content)},
		MaxOutputTokens:  openai.Int(int64(input.MaxOutputTokens)),
		SafetyIdentifier: openai.String(input.SafetyIdentifier),
		Store:            openai.Bool(false),
		Text:             responses.ResponseTextConfigParam{Format: format, Verbosity: responses.ResponseTextConfigVerbosityLow},
	})
	if err != nil {
		span.SetStatus(codes.Error, "provider request failed")
		return appai.GeneratedAction{}, mapOpenAIError(err)
	}
	result := appai.GeneratedAction{Usage: usageFromResponse(response)}
	var payload struct {
		Actions []struct {
			Text string `json:"text"`
		} `json:"actions"`
	}
	if err = decodeStrict(response.OutputText(), &payload); err != nil {
		return result, appai.ErrInvalidResponse
	}
	result.Actions = make([]string, 0, len(payload.Actions))
	for _, action := range payload.Actions {
		result.Actions = append(result.Actions, action.Text)
	}
	return result, nil
}

func (provider *OpenAIActionAI) Refine(ctx context.Context, input appai.RefineActionAIInput) (appai.RefinedAction, error) {
	ctx, span := provider.startSpan(ctx, "refine")
	defer span.End()
	format := responses.ResponseFormatTextConfigParamOfJSONSchema("pdcai_refined_action", refineSchema())
	format.OfJSONSchema.Strict = openai.Bool(true)
	response, err := provider.client.Responses.New(ctx, responses.ResponseNewParams{
		Model:            provider.model,
		Instructions:     openai.String(retryInstructions(input.Instructions, input.Retry)),
		Input:            responses.ResponseNewParamsInputUnion{OfString: openai.String(input.Content)},
		MaxOutputTokens:  openai.Int(int64(input.MaxOutputTokens)),
		SafetyIdentifier: openai.String(input.SafetyIdentifier),
		Store:            openai.Bool(false),
		Text:             responses.ResponseTextConfigParam{Format: format, Verbosity: responses.ResponseTextConfigVerbosityLow},
	})
	if err != nil {
		span.SetStatus(codes.Error, "provider request failed")
		return appai.RefinedAction{}, mapOpenAIError(err)
	}
	result := appai.RefinedAction{Usage: usageFromResponse(response)}
	var payload struct {
		RefinedAction string `json:"refinedAction"`
	}
	if err = decodeStrict(response.OutputText(), &payload); err != nil {
		return result, appai.ErrInvalidResponse
	}
	result.Action = payload.RefinedAction
	return result, nil
}

func (provider *OpenAIActionAI) startSpan(ctx context.Context, operation string) (context.Context, trace.Span) {
	return otel.Tracer("pdcai/openai").Start(ctx, "openai.responses."+operation, trace.WithAttributes(
		attribute.String("gen_ai.provider.name", "openai"),
		attribute.String("gen_ai.request.model", string(provider.model)),
	))
}

func generateSchema() map[string]any {
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"actions": map[string]any{
				"type": "array", "minItems": 1, "maxItems": 3,
				"items": map[string]any{
					"type": "object", "additionalProperties": false,
					"properties": map[string]any{"text": map[string]any{"type": "string"}},
					"required":   []string{"text"},
				},
			},
		},
		"required": []string{"actions"},
	}
}

func refineSchema() map[string]any {
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties":           map[string]any{"refinedAction": map[string]any{"type": "string"}},
		"required":             []string{"refinedAction"},
	}
}

func retryInstructions(base string, retry bool) string {
	if !retry {
		return base
	}
	return base + "\n前回の応答は検証に失敗した。JSON Schemaを厳守し、最終テキストを2000文字以内にする。"
}

func decodeStrict(raw string, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values or trailing data")
	}
	return nil
}

func usageFromResponse(response *responses.Response) appai.Usage {
	return appai.Usage{
		InputTokens:       response.Usage.InputTokens,
		OutputTokens:      response.Usage.OutputTokens,
		ProviderRequestID: response.ID,
	}
}

func mapOpenAIError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return appai.ErrProviderTimeout
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return appai.ErrProviderTimeout
	}
	return appai.ErrProviderUnavailable
}
