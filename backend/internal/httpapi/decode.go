package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/fukamu/cycle/backend/internal/identifier"
)

const defaultBodyLimit = 64 << 10

var errRequestValidation = errors.New("request validation failed")

func decodeJSON(writer http.ResponseWriter, request *http.Request, destination any, limit int64) error {
	request.Body = http.MaxBytesReader(writer, request.Body, limit)
	var body bytes.Buffer
	decoder := json.NewDecoder(io.TeeReader(request.Body, &body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request body must contain one JSON object")
		}
		return err
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(body.Bytes(), &object); err != nil {
		return err
	}
	if !hasValidJSONMembers(object, destination) {
		return errors.New("request body does not match the required JSON object contract")
	}
	return nil
}

type requestJSONContract struct {
	required        []string
	optionalNonNull []string
}

func hasValidJSONMembers(object map[string]json.RawMessage, destination any) bool {
	contract, ok := requestJSONContractFor(destination)
	if !ok || object == nil {
		return false
	}
	for member := range object {
		if !contract.allows(member) {
			return false
		}
	}
	for _, member := range contract.required {
		value, present := object[member]
		if !present || isJSONNull(value) {
			return false
		}
	}
	for _, member := range contract.optionalNonNull {
		if value, present := object[member]; present && isJSONNull(value) {
			return false
		}
	}
	return true
}

func (contract requestJSONContract) allows(member string) bool {
	for _, allowed := range contract.required {
		if member == allowed {
			return true
		}
	}
	for _, allowed := range contract.optionalNonNull {
		if member == allowed {
			return true
		}
	}
	return false
}

func requestJSONContractFor(destination any) (requestJSONContract, bool) {
	switch destination.(type) {
	case *createAnonymousRequest:
		return requestJSONContract{required: []string{"bootstrapId", "turnstileToken"}}, true
	case *googleTokenRequest:
		return requestJSONContract{required: []string{"idToken"}}, true
	case *deleteAccountRequest:
		return requestJSONContract{required: []string{"confirmed"}}, true
	case *createDraftRequest:
		return requestJSONContract{optionalNonNull: []string{"initialBody"}}, true
	case *saveDraftRequest:
		return requestJSONContract{required: []string{"body", "expectedRevision"}}, true
	case *saveReviewRequest:
		return requestJSONContract{required: []string{"body", "expectedReviewDraftId", "expectedRevision"}}, true
	case *startGoalRequest:
		return requestJSONContract{required: []string{"operationId", "expectedDraftRevision"}}, true
	case *refineGoalRequest:
		return requestJSONContract{
			required:        []string{"expectedDraftRevision"},
			optionalNonNull: []string{"expectedGoalRevision"},
		}, true
	case *adoptSuggestionRequest:
		return requestJSONContract{
			required:        []string{"expectedDraftRevision"},
			optionalNonNull: []string{"expectedGoalRevision"},
		}, true
	case *continueReviewRequest:
		return requestJSONContract{required: []string{"operationId", "expectedGoalRevision", "expectedDraftRevision"}}, true
	case *saveFrameRequest:
		return requestJSONContract{required: []string{"content", "expectedFrameRevision"}}, true
	case *changeReviewScheduleRequest:
		return requestJSONContract{
			required:        []string{"action", "expectedReviewScheduleRevision"},
			optionalNonNull: []string{"reviewDate"},
		}, true
	case *actionGenerateRequest:
		return requestJSONContract{required: []string{"expectedContentRevision", "confirmReplace"}}, true
	case *actionRefineRequest:
		return requestJSONContract{required: []string{"expectedContentRevision"}}, true
	case *completeCycleRequest:
		return requestJSONContract{required: []string{"operationId", "expectedGoalRevision", "expectedContentRevision"}}, true
	case *terminateGoalRequest:
		return requestJSONContract{
			required:        []string{"operationId", "outcome", "expectedGoalRevision", "expectedState"},
			optionalNonNull: []string{"activeCycleId", "expectedCycleContentRevision", "confirmDiscardReviewDraft"},
		}, true
	case *deleteGoalRequest:
		return requestJSONContract{required: []string{"confirmed", "expectedGoalRevision"}}, true
	default:
		return requestJSONContract{}, false
	}
}

func isJSONNull(value json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

func isValidRequestBody(destination any) bool {
	switch input := destination.(type) {
	case *createAnonymousRequest:
		return input != nil && identifier.IsCanonicalUUIDv7(input.BootstrapID)
	case *googleTokenRequest:
		return input != nil && input.IDToken != ""
	case *deleteAccountRequest:
		return input != nil
	case *createDraftRequest:
		return input != nil
	case *saveDraftRequest:
		return input != nil && input.ExpectedRevision >= 0
	case *saveReviewRequest:
		return input != nil && identifier.IsCanonicalUUIDv7(input.ExpectedReviewDraftID) && input.ExpectedRevision >= 0
	case *startGoalRequest:
		return input != nil && identifier.IsCanonicalUUIDv7(input.OperationID) && input.ExpectedDraftRevision >= 0
	case *refineGoalRequest:
		return input != nil && input.ExpectedDraftRevision >= 0 &&
			(input.ExpectedGoalRevision == nil || *input.ExpectedGoalRevision >= 0)
	case *adoptSuggestionRequest:
		return input != nil && input.ExpectedDraftRevision >= 0 &&
			(input.ExpectedGoalRevision == nil || *input.ExpectedGoalRevision >= 0)
	case *continueReviewRequest:
		return input != nil && identifier.IsCanonicalUUIDv7(input.OperationID) &&
			input.ExpectedGoalRevision >= 0 && input.ExpectedDraftRevision >= 0
	case *saveFrameRequest:
		return input != nil && input.ExpectedFrameRevision >= 0
	case *changeReviewScheduleRequest:
		if input == nil || input.ExpectedReviewScheduleRevision < 0 {
			return false
		}
		_, err := input.target()
		return err == nil
	case *actionGenerateRequest:
		return input != nil && input.ExpectedContentRevision >= 0
	case *actionRefineRequest:
		return input != nil && input.ExpectedContentRevision >= 0
	case *completeCycleRequest:
		return input != nil && identifier.IsCanonicalUUIDv7(input.OperationID) &&
			input.ExpectedGoalRevision >= 0 && input.ExpectedContentRevision >= 0
	case *terminateGoalRequest:
		return input != nil && identifier.IsCanonicalUUIDv7(input.OperationID) && input.Outcome != "" &&
			input.ExpectedGoalRevision != nil && *input.ExpectedGoalRevision >= 0 && input.ExpectedState != ""
	case *deleteGoalRequest:
		return input != nil && input.ExpectedGoalRevision >= 0
	default:
		return false
	}
}

func (server *api) decodeAndValidateJSON(writer http.ResponseWriter, request *http.Request, destination any, limit int64) error {
	if err := decodeJSON(writer, request, destination, limit); err != nil {
		return fmt.Errorf("%w: %v", errRequestValidation, err)
	}
	if !isValidRequestBody(destination) {
		return errRequestValidation
	}
	return nil
}
