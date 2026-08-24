package ai

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

var (
	ErrInvalidGoalSuggestion = errors.New("goal suggestion is invalid")
	ErrInvalidActionCount    = errors.New("generated action count must be between 1 and 3")
	ErrInvalidActionText     = errors.New("generated action text is invalid")
)

func ValidateGoalSuggestion(suggestion string) (string, error) {
	normalized, valid := normalizeAIText(suggestion)
	if !valid {
		return "", errors.Join(ErrInvalidGoalSuggestion, goal.ErrForbiddenCharacter)
	}
	if strings.TrimSpace(normalized) == "" {
		return "", errors.Join(ErrInvalidGoalSuggestion, goal.ErrTextRequired)
	}
	if utf8.RuneCountInString(normalized) > goal.MaxGoalCodePoints {
		return "", errors.Join(ErrInvalidGoalSuggestion, goal.ErrTextTooLong)
	}
	return normalized, nil
}

func RenderGeneratedActions(actions []string) (string, error) {
	if len(actions) < 1 || len(actions) > 3 {
		return "", ErrInvalidActionCount
	}
	rendered := make([]string, 0, len(actions))
	for index, action := range actions {
		normalized, valid := normalizeAIText(action)
		if !valid {
			return "", errors.Join(ErrInvalidActionText, cycle.ErrForbiddenCharacter)
		}
		normalized = strings.TrimSpace(normalized)
		if normalized == "" {
			return "", ErrInvalidActionText
		}
		rendered = append(rendered, fmt.Sprintf("%d. %s", index+1, normalized))
	}
	output := strings.Join(rendered, "\n\n")
	if utf8.RuneCountInString(output) > cycle.MaxFrameCodePoints {
		return "", errors.Join(ErrInvalidActionText, cycle.ErrFrameTextTooLong)
	}
	return output, nil
}

func ValidateRefinedAction(action string) (string, error) {
	normalized, valid := normalizeAIText(action)
	if !valid {
		return "", errors.Join(ErrInvalidActionText, cycle.ErrForbiddenCharacter)
	}
	if strings.TrimSpace(normalized) == "" {
		return "", ErrInvalidActionText
	}
	if utf8.RuneCountInString(normalized) > cycle.MaxFrameCodePoints {
		return "", errors.Join(ErrInvalidActionText, cycle.ErrFrameTextTooLong)
	}
	return normalized, nil
}

func normalizeAIText(value string) (string, bool) {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	for _, codePoint := range value {
		if unicode.IsControl(codePoint) && codePoint != '\n' && codePoint != '\t' {
			return "", false
		}
	}
	return value, true
}
