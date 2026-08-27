package httpapi

import (
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
	decoder := json.NewDecoder(request.Body)
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
	return nil
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
