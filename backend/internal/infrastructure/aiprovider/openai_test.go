package aiprovider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
)

func TestOpenAIGenerateUsesResponsesStructuredOutputWithoutStorageOrTools(t *testing.T) {
	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/responses" || request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("request = %s, auth = %s", request.URL.Path, request.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(request.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
          "id":"resp_test","object":"response","created_at":1,"status":"completed","model":"test-model",
          "output":[{"id":"msg_test","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"{\"actions\":[{\"text\":\"小さく試す\"}]}","annotations":[]}]}],
          "usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":17}
        }`))
	}))
	defer server.Close()
	provider := &OpenAIActionAI{
		client: openai.NewClient(
			option.WithAPIKey("test-key"), option.WithBaseURL(server.URL+"/v1/"), option.WithMaxRetries(0),
		),
		model: openai.ResponsesModel("test-model"),
	}

	result, err := provider.Generate(context.Background(), appai.GenerateActionAIInput{
		Instructions: "instructions", Content: "cycle data", MaxOutputTokens: 800, SafetyIdentifier: "safe-user",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Actions) != 1 || result.Actions[0] != "小さく試す" || result.Usage.InputTokens != 12 || result.Usage.OutputTokens != 5 {
		t.Fatalf("result = %#v", result)
	}
	if requestBody["store"] != false || requestBody["max_output_tokens"] != float64(800) || requestBody["safety_identifier"] != "safe-user" {
		t.Fatalf("request body = %#v", requestBody)
	}
	if _, exists := requestBody["tools"]; exists {
		t.Fatalf("tools must not be sent: %#v", requestBody["tools"])
	}
	textConfig, ok := requestBody["text"].(map[string]any)
	if !ok {
		t.Fatalf("text config = %#v", requestBody["text"])
	}
	format, ok := textConfig["format"].(map[string]any)
	if !ok || format["type"] != "json_schema" || format["strict"] != true {
		t.Fatalf("structured format = %#v", textConfig["format"])
	}
}
