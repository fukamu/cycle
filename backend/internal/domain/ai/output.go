package ai

import (
	"errors"
	"fmt"
	"strings"

	"github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

var (
	ErrInvalidActionCount = errors.New("generated action count must be between 1 and 3")
	ErrInvalidActionText  = errors.New("generated action text is invalid")
)

func RenderGeneratedActions(actions []string) (string, error) {
	if len(actions) < 1 || len(actions) > 3 {
		return "", ErrInvalidActionCount
	}
	rendered := make([]string, 0, len(actions))
	for index, action := range actions {
		normalized, err := cycle.NormalizeAndValidateText(action)
		if err != nil || cycle.IsBlank(normalized) {
			return "", errors.Join(ErrInvalidActionText, err)
		}
		rendered = append(rendered, fmt.Sprintf("%d. %s", index+1, strings.TrimSpace(normalized)))
	}
	output := strings.Join(rendered, "\n\n")
	if _, err := cycle.NormalizeAndValidateText(output); err != nil {
		return "", errors.Join(ErrInvalidActionText, err)
	}
	return output, nil
}

func ValidateRefinedAction(action string) (string, error) {
	normalized, err := cycle.NormalizeAndValidateText(action)
	if err != nil || cycle.IsBlank(normalized) {
		return "", errors.Join(ErrInvalidActionText, err)
	}
	return normalized, nil
}
