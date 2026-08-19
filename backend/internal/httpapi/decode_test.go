package httpapi

import (
	"bytes"
	"errors"
	"net/http/httptest"
	"testing"
)

func TestDecodeAndValidateJSONRejectsCommonFormatErrors(t *testing.T) {
	server := &api{validate: newRequestValidator()}
	tests := []struct {
		name string
		body string
	}{
		{"unknown field", `{"operationId":"123e4567-e89b-42d3-a456-426614174000","expectedDraftRevision":0,"extra":true}`},
		{"negative revision", `{"operationId":"123e4567-e89b-42d3-a456-426614174000","expectedDraftRevision":-1}`},
		{"non-canonical UUID", `{"operationId":"123E4567-E89B-42D3-A456-426614174000","expectedDraftRevision":0}`},
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
	server := &api{validate: newRequestValidator()}
	request := httptest.NewRequest("POST", "/", bytes.NewBufferString(`{"operationId":"123e4567-e89b-42d3-a456-426614174000","expectedDraftRevision":0}`))
	var input startGoalRequest
	if err := server.decodeAndValidateJSON(httptest.NewRecorder(), request, &input, defaultBodyLimit); err != nil {
		t.Fatal(err)
	}
}
