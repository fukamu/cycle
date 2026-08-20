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
	server := &api{validate: newRequestValidator()}
	request := httptest.NewRequest("POST", "/", bytes.NewBufferString(`{"operationId":"0198c20b-7b95-7000-8000-000000000001","expectedDraftRevision":0}`))
	var input startGoalRequest
	if err := server.decodeAndValidateJSON(httptest.NewRecorder(), request, &input, defaultBodyLimit); err != nil {
		t.Fatal(err)
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
