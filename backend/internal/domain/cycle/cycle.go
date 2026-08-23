package cycle

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxFrameCodePoints = 200

var (
	ErrInvalidFrame       = errors.New("invalid PDCA frame")
	ErrFrameTextTooLong   = errors.New("frame text is too long")
	ErrForbiddenCharacter = errors.New("text contains a forbidden character")
	ErrCycleNotActive     = errors.New("cycle is not active")
	ErrRevisionConflict   = errors.New("cycle revision conflict")
	ErrCycleIncomplete    = errors.New("cycle completion input is incomplete")
	ErrAIOperationRunning = errors.New("AI operation is running")
)

type Status string

const (
	StatusActive    Status = "active"
	StatusCompleted Status = "completed"
	StatusCanceled  Status = "canceled"
)

type CancellationReason string

const (
	CancellationGoalAchieved CancellationReason = "goal_achieved"
	CancellationGoalEnded    CancellationReason = "goal_ended"
)

type Frame string

const (
	FramePlan   Frame = "plan"
	FrameDo     Frame = "do"
	FrameCheck  Frame = "check"
	FrameAction Frame = "action"
)

var allFrames = []Frame{FramePlan, FrameDo, FrameCheck, FrameAction}

type Revisions struct {
	Content int64
	Plan    int64
	Do      int64
	Check   int64
	Action  int64
}

type PDCACycle struct {
	ID                    string
	UserID                string
	GoalID                string
	GoalVersionID         string
	SequenceNumber        int32
	Status                Status
	StartedAt             time.Time
	CompletedAt           *time.Time
	CanceledAt            *time.Time
	CancellationReason    *CancellationReason
	Plan                  string
	Do                    string
	Check                 string
	Action                string
	Revisions             Revisions
	ActionLastAIRevision  *int64
	ActionModifiedAfterAI bool
	StartOperationID      string
	StartRequestHash      string
	CompletionOperationID *string
	CompletionRequestHash *string
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

type SaveFrameResult struct {
	Cycle   PDCACycle
	Frame   Frame
	Content string
	NoOp    bool
	SavedAt time.Time
}

func New(id, userID, goalID, goalVersionID string, sequence int32, operationID, requestHash string, now time.Time) PDCACycle {
	now = now.UTC()
	return PDCACycle{
		ID: id, UserID: userID, GoalID: goalID, GoalVersionID: goalVersionID,
		SequenceNumber: sequence, Status: StatusActive, StartedAt: now,
		StartOperationID: operationID, StartRequestHash: requestHash,
		CreatedAt: now, UpdatedAt: now,
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
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	for _, codePoint := range value {
		if codePoint == 0 || (codePoint < 0x20 && codePoint != '\n' && codePoint != '\t') || codePoint == 0x7f {
			return "", ErrForbiddenCharacter
		}
	}
	if utf8.RuneCountInString(value) > MaxFrameCodePoints {
		return "", ErrFrameTextTooLong
	}
	return value, nil
}

func IsBlank(value string) bool { return strings.TrimSpace(value) == "" }

func SaveFrame(current PDCACycle, frame Frame, content string, expectedRevision int64, aiRunning bool, now time.Time) (SaveFrameResult, error) {
	if current.Status != StatusActive {
		return SaveFrameResult{}, ErrCycleNotActive
	}
	if aiRunning && frame == FrameAction {
		return SaveFrameResult{}, ErrAIOperationRunning
	}
	if _, err := ParseFrame(string(frame)); err != nil {
		return SaveFrameResult{}, err
	}
	content, err := NormalizeAndValidateText(content)
	if err != nil {
		return SaveFrameResult{}, err
	}
	if current.FrameContent(frame) == content {
		return SaveFrameResult{Cycle: current, Frame: frame, Content: content, NoOp: true, SavedAt: current.UpdatedAt}, nil
	}
	if current.FrameRevision(frame) != expectedRevision {
		return SaveFrameResult{}, ErrRevisionConflict
	}
	current.Revisions.Content++
	switch frame {
	case FramePlan:
		current.Plan = content
		current.Revisions.Plan++
	case FrameDo:
		current.Do = content
		current.Revisions.Do++
	case FrameCheck:
		current.Check = content
		current.Revisions.Check++
	case FrameAction:
		current.Action = content
		current.Revisions.Action++
		current.ActionModifiedAfterAI = current.ActionLastAIRevision != nil
	default:
		return SaveFrameResult{}, ErrInvalidFrame
	}
	current.UpdatedAt = now.UTC()
	return SaveFrameResult{Cycle: current, Frame: frame, Content: content, SavedAt: current.UpdatedAt}, nil
}

func ApplyAIAction(current PDCACycle, action string, expectedContentRevision int64, now time.Time) (PDCACycle, error) {
	if current.Status != StatusActive {
		return PDCACycle{}, ErrCycleNotActive
	}
	if current.Revisions.Content != expectedContentRevision {
		return PDCACycle{}, ErrRevisionConflict
	}
	action, err := NormalizeAndValidateText(action)
	if err != nil || IsBlank(action) {
		if err != nil {
			return PDCACycle{}, err
		}
		return PDCACycle{}, ErrCycleIncomplete
	}
	current.Action = action
	current.Revisions.Content++
	current.Revisions.Action++
	appliedRevision := current.Revisions.Content
	current.ActionLastAIRevision = &appliedRevision
	current.ActionModifiedAfterAI = false
	current.UpdatedAt = now.UTC()
	return current, nil
}

func Complete(current PDCACycle, operationID, requestHash string, expectedContentRevision int64, aiRunning bool, now time.Time) (PDCACycle, error) {
	if current.Status != StatusActive {
		return PDCACycle{}, ErrCycleNotActive
	}
	if current.Revisions.Content != expectedContentRevision {
		return PDCACycle{}, ErrRevisionConflict
	}
	if aiRunning {
		return PDCACycle{}, ErrAIOperationRunning
	}
	if len(current.MissingRequiredFrames()) != 0 {
		return PDCACycle{}, ErrCycleIncomplete
	}
	now = now.UTC()
	current.Status = StatusCompleted
	current.CompletedAt = &now
	current.CompletionOperationID = &operationID
	current.CompletionRequestHash = &requestHash
	current.UpdatedAt = now
	return current, nil
}

func Cancel(current PDCACycle, reason CancellationReason, now time.Time) (PDCACycle, error) {
	if current.Status != StatusActive {
		return PDCACycle{}, ErrCycleNotActive
	}
	if reason != CancellationGoalAchieved && reason != CancellationGoalEnded {
		return PDCACycle{}, ErrCycleNotActive
	}
	now = now.UTC()
	current.Status = StatusCanceled
	current.CanceledAt = &now
	current.CancellationReason = &reason
	current.UpdatedAt = now
	return current, nil
}

func (current PDCACycle) FrameRevision(frame Frame) int64 {
	switch frame {
	case FramePlan:
		return current.Revisions.Plan
	case FrameDo:
		return current.Revisions.Do
	case FrameCheck:
		return current.Revisions.Check
	case FrameAction:
		return current.Revisions.Action
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
	missing := make([]Frame, 0, 4)
	for _, frame := range allFrames {
		if IsBlank(current.FrameContent(frame)) {
			missing = append(missing, frame)
		}
	}
	return missing
}
