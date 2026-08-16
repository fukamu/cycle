package cycle

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

const MaxFrameCodePoints = 2000

var (
	ErrInvalidFrame       = errors.New("invalid frame")
	ErrInvalidText        = errors.New("invalid frame text")
	ErrFrameTooLong       = errors.New("frame text exceeds 2000 code points")
	ErrCycleNotActive     = errors.New("cycle is not active")
	ErrRevisionConflict   = errors.New("cycle revision conflict")
	ErrAIOperationRunning = errors.New("AI operation is running")
	ErrCycleIncomplete    = errors.New("cycle is incomplete")
	ErrInvalidTransition  = errors.New("invalid cycle transition")
)

type ID string
type OperationID string

type Status string

const (
	StatusActive    Status = "active"
	StatusCompleted Status = "completed"
)

type Frame string

const (
	FramePlan   Frame = "plan"
	FrameDo     Frame = "do"
	FrameCheck  Frame = "check"
	FrameAction Frame = "action"
)

var allFrames = []Frame{FramePlan, FrameDo, FrameCheck, FrameAction}

type PDCACycle struct {
	ID                                 ID
	UserID                             user.ID
	SequenceNumber                     int32
	Status                             Status
	StartedAt                          time.Time
	CompletedAt                        *time.Time
	Plan                               string
	Do                                 string
	Check                              string
	Action                             string
	ContentRevision                    int64
	PlanRevision                       int64
	DoRevision                         int64
	CheckRevision                      int64
	ActionRevision                     int64
	ActionLastAIAppliedContentRevision *int64
	ActionUserModifiedAfterAI          bool
	CompletionOperationID              *OperationID
	CreatedAt                          time.Time
	UpdatedAt                          time.Time
}

type SaveFrameResult struct {
	Cycle   PDCACycle
	NoOp    bool
	Frame   Frame
	SavedAt time.Time
}

type ApplyAIResult struct {
	Cycle          PDCACycle
	ContextChanged bool
}

type CompleteResult struct {
	Completed PDCACycle
	Next      PDCACycle
}

type IncompleteError struct {
	MissingFrames []Frame
}

func (err *IncompleteError) Error() string {
	return fmt.Sprintf("%s: %v", ErrCycleIncomplete, err.MissingFrames)
}

func (err *IncompleteError) Unwrap() error {
	return ErrCycleIncomplete
}

func NewInitial(id ID, userID user.ID, now time.Time) PDCACycle {
	now = now.UTC()
	return PDCACycle{
		ID:             id,
		UserID:         userID,
		SequenceNumber: 1,
		Status:         StatusActive,
		StartedAt:      now,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func ParseFrame(value string) (Frame, error) {
	frame := Frame(value)
	for _, candidate := range allFrames {
		if frame == candidate {
			return frame, nil
		}
	}
	return "", ErrInvalidFrame
}

func NormalizeAndValidateText(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", ErrInvalidText
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	if utf8.RuneCountInString(normalized) > MaxFrameCodePoints {
		return "", ErrFrameTooLong
	}
	for _, codePoint := range normalized {
		if isForbiddenControl(codePoint) {
			return "", ErrInvalidText
		}
	}
	return normalized, nil
}

func IsBlank(value string) bool {
	return strings.TrimFunc(value, unicode.IsSpace) == ""
}

func SaveFrame(current PDCACycle, frame Frame, content string, expectedFrameRevision int64, aiRunning bool, now time.Time) (SaveFrameResult, error) {
	if current.Status != StatusActive {
		return SaveFrameResult{}, ErrCycleNotActive
	}
	if _, err := ParseFrame(string(frame)); err != nil {
		return SaveFrameResult{}, err
	}
	if frame == FrameAction && aiRunning {
		return SaveFrameResult{}, ErrAIOperationRunning
	}
	if expectedFrameRevision < 0 || current.FrameRevision(frame) != expectedFrameRevision {
		return SaveFrameResult{}, ErrRevisionConflict
	}
	normalized, err := NormalizeAndValidateText(content)
	if err != nil {
		return SaveFrameResult{}, err
	}
	if current.FrameContent(frame) == normalized {
		return SaveFrameResult{Cycle: current, NoOp: true, Frame: frame, SavedAt: now.UTC()}, nil
	}

	updated := current
	switch frame {
	case FramePlan:
		updated.Plan = normalized
		updated.PlanRevision++
	case FrameDo:
		updated.Do = normalized
		updated.DoRevision++
	case FrameCheck:
		updated.Check = normalized
		updated.CheckRevision++
	case FrameAction:
		updated.Action = normalized
		updated.ActionRevision++
		if updated.ActionLastAIAppliedContentRevision != nil {
			updated.ActionUserModifiedAfterAI = true
		}
	default:
		return SaveFrameResult{}, ErrInvalidFrame
	}
	updated.ContentRevision++
	updated.UpdatedAt = now.UTC()
	return SaveFrameResult{Cycle: updated, Frame: frame, SavedAt: now.UTC()}, nil
}

func ApplyAIAction(current PDCACycle, action string, generationContentRevision int64, now time.Time) (ApplyAIResult, error) {
	if current.Status != StatusActive {
		return ApplyAIResult{}, ErrCycleNotActive
	}
	normalized, err := NormalizeAndValidateText(action)
	if err != nil {
		return ApplyAIResult{}, err
	}
	if IsBlank(normalized) {
		return ApplyAIResult{}, ErrInvalidText
	}
	updated := current
	updated.Action = normalized
	updated.ActionRevision++
	updated.ContentRevision++
	updated.UpdatedAt = now.UTC()
	appliedRevision := updated.ContentRevision
	updated.ActionLastAIAppliedContentRevision = &appliedRevision
	updated.ActionUserModifiedAfterAI = false
	return ApplyAIResult{
		Cycle:          updated,
		ContextChanged: current.ContentRevision != generationContentRevision,
	}, nil
}

func Complete(current PDCACycle, now time.Time, nextID ID, operationID OperationID, expectedContentRevision int64, aiRunning bool) (CompleteResult, error) {
	if current.Status != StatusActive {
		return CompleteResult{}, ErrCycleNotActive
	}
	if expectedContentRevision < 0 || current.ContentRevision != expectedContentRevision {
		return CompleteResult{}, ErrRevisionConflict
	}
	if aiRunning {
		return CompleteResult{}, ErrAIOperationRunning
	}
	if nextID == "" || operationID == "" {
		return CompleteResult{}, ErrInvalidTransition
	}
	missing := current.MissingRequiredFrames()
	if len(missing) > 0 {
		return CompleteResult{}, &IncompleteError{MissingFrames: missing}
	}

	transitionTime := now.UTC()
	completed := current
	completed.Status = StatusCompleted
	completed.CompletedAt = &transitionTime
	completed.CompletionOperationID = &operationID
	completed.UpdatedAt = transitionTime
	next := PDCACycle{
		ID:             nextID,
		UserID:         current.UserID,
		SequenceNumber: current.SequenceNumber + 1,
		Status:         StatusActive,
		StartedAt:      transitionTime,
		CreatedAt:      transitionTime,
		UpdatedAt:      transitionTime,
	}
	return CompleteResult{Completed: completed, Next: next}, nil
}

func (current PDCACycle) FrameRevision(frame Frame) int64 {
	switch frame {
	case FramePlan:
		return current.PlanRevision
	case FrameDo:
		return current.DoRevision
	case FrameCheck:
		return current.CheckRevision
	case FrameAction:
		return current.ActionRevision
	default:
		return -1
	}
}

func (current PDCACycle) FrameContent(frame Frame) string {
	switch frame {
	case FramePlan:
		return current.Plan
	case FrameDo:
		return current.Do
	case FrameCheck:
		return current.Check
	case FrameAction:
		return current.Action
	default:
		return ""
	}
}

func (current PDCACycle) MissingRequiredFrames() []Frame {
	missing := make([]Frame, 0, len(allFrames))
	for _, frame := range allFrames {
		if IsBlank(current.FrameContent(frame)) {
			missing = append(missing, frame)
		}
	}
	return missing
}

func isForbiddenControl(codePoint rune) bool {
	if codePoint == '\n' || codePoint == '\t' {
		return false
	}
	return codePoint == 0x7f || (codePoint >= 0 && codePoint < 0x20)
}
