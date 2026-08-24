package aiprovider

import (
	"errors"
	"reflect"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
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
