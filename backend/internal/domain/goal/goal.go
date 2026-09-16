package goal

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

const (
	MaxGoalCodePoints          = 80
	MaxSuccessSignalCodePoints = 120
)

var (
	ErrTextRequired         = errors.New("goal text is required")
	ErrTextTooLong          = errors.New("goal text is too long")
	ErrSuccessSignalTooLong = errors.New("goal success signal is too long")
	ErrForbiddenCharacter   = errors.New("goal text contains a forbidden character")
	ErrStateConflict        = errors.New("goal state conflict")
	ErrAlreadyTerminal      = errors.New("goal is already terminal")
	ErrDiscardRequired      = errors.New("review draft discard confirmation is required")
)

type Status string

const (
	StatusActiveCycle Status = "active_cycle"
	StatusGoalReview  Status = "goal_review"
	StatusAchieved    Status = "achieved"
	StatusEnded       Status = "ended"
)

type Goal struct {
	ID                      string
	UserID                  string
	Status                  Status
	CurrentVersionNumber    int32
	NextCycleSequenceNumber int32
	Revision                int64
	TerminalAt              *time.Time
	TerminalOperationID     *string
	TerminalRequestHash     *string
	CreatedAt               time.Time
	UpdatedAt               time.Time
}

type Version struct {
	ID                   string
	UserID               string
	GoalID               string
	VersionNumber        int32
	Body                 string
	SuccessSignal        *string
	CreatedByOperationID string
	CreatedAt            time.Time
}

type DraftType string

const (
	DraftCreation DraftType = "creation"
	DraftReview   DraftType = "review"
)

type Draft struct {
	ID                string
	UserID            string
	Type              DraftType
	GoalID            *string
	BaseGoalVersionID *string
	ReviewCycleID     *string
	Body              string
	SuccessSignal     *string
	Revision          int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type InitialAggregate struct {
	Goal    Goal
	Version Version
	Cycle   cycle.PDCACycle
}

type ContinueResult struct {
	Goal           Goal
	Version        Version
	VersionCreated bool
	Cycle          cycle.PDCACycle
}

type ReplanResult struct {
	Goal          Goal
	CanceledCycle cycle.PDCACycle
	Cycle         cycle.PDCACycle
}

func NormalizeText(value string, allowEmpty bool) (string, error) {
	value = normalizeLineEndings(value)
	for _, codePoint := range value {
		if codePoint == 0 || (codePoint < 0x20 && codePoint != '\n' && codePoint != '\t') || codePoint == 0x7f {
			return "", ErrForbiddenCharacter
		}
	}
	if utf8.RuneCountInString(value) > MaxGoalCodePoints {
		return "", ErrTextTooLong
	}
	if !allowEmpty && strings.TrimSpace(value) == "" {
		return "", ErrTextRequired
	}
	return value, nil
}

// NormalizeSuccessSignal canonicalizes an optional, user-authored success
// signal. A nil or Unicode-whitespace-only value has one canonical form: nil.
func NormalizeSuccessSignal(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	normalized := normalizeLineEndings(*value)
	for _, codePoint := range normalized {
		if codePoint == 0 || (codePoint < 0x20 && codePoint != '\n' && codePoint != '\t') || codePoint == 0x7f {
			return nil, ErrForbiddenCharacter
		}
	}
	if strings.TrimSpace(normalized) == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(normalized) > MaxSuccessSignalCodePoints {
		return nil, ErrSuccessSignalTooLong
	}
	return &normalized, nil
}

func NewDraft(id, userID, body string, now time.Time) (Draft, error) {
	body, err := NormalizeText(body, true)
	if err != nil {
		return Draft{}, err
	}
	now = now.UTC()
	return Draft{ID: id, UserID: userID, Type: DraftCreation, Body: body, CreatedAt: now, UpdatedAt: now}, nil
}

func SaveDraft(current Draft, body string, successSignal *string, expectedRevision int64, now time.Time) (Draft, bool, error) {
	body, err := NormalizeText(body, true)
	if err != nil {
		return Draft{}, false, err
	}
	successSignal, err = NormalizeSuccessSignal(successSignal)
	if err != nil {
		return Draft{}, false, err
	}
	if current.Body == body && optionalTextEqual(current.SuccessSignal, successSignal) {
		return current, true, nil
	}
	if current.Revision != expectedRevision {
		return Draft{}, false, ErrStateConflict
	}
	current.Body = body
	current.SuccessSignal = successSignal
	current.Revision++
	current.UpdatedAt = now.UTC()
	return current, false, nil
}

func StartInitial(draft Draft, goalID, versionID, cycleID, operationID, requestHash string, now time.Time) (InitialAggregate, error) {
	if draft.Type != DraftCreation {
		return InitialAggregate{}, ErrStateConflict
	}
	body, err := NormalizeText(draft.Body, false)
	if err != nil {
		return InitialAggregate{}, err
	}
	successSignal, err := NormalizeSuccessSignal(draft.SuccessSignal)
	if err != nil {
		return InitialAggregate{}, err
	}
	now = now.UTC()
	created := Goal{
		ID: goalID, UserID: draft.UserID, Status: StatusActiveCycle,
		CurrentVersionNumber: 1, NextCycleSequenceNumber: 2,
		CreatedAt: now, UpdatedAt: now,
	}
	version := Version{
		ID: versionID, UserID: draft.UserID, GoalID: goalID, VersionNumber: 1,
		Body: body, SuccessSignal: successSignal, CreatedByOperationID: operationID, CreatedAt: now,
	}
	return InitialAggregate{
		Goal: created, Version: version,
		Cycle: cycle.New(cycleID, draft.UserID, goalID, versionID, 1, operationID, requestHash, now),
	}, nil
}

func EnterReview(current Goal, now time.Time) (Goal, error) {
	if current.Status != StatusActiveCycle {
		return Goal{}, ErrStateConflict
	}
	current.Status = StatusGoalReview
	current.Revision++
	current.UpdatedAt = now.UTC()
	return current, nil
}

func NewReviewDraft(id string, current Goal, version Version, completedCycle cycle.PDCACycle, now time.Time) (Draft, error) {
	if current.Status != StatusGoalReview || version.GoalID != current.ID || completedCycle.GoalID != current.ID || completedCycle.Status != cycle.StatusCompleted {
		return Draft{}, ErrStateConflict
	}
	now = now.UTC()
	goalID, versionID, cycleID := current.ID, version.ID, completedCycle.ID
	return Draft{
		ID: id, UserID: current.UserID, Type: DraftReview,
		GoalID: &goalID, BaseGoalVersionID: &versionID, ReviewCycleID: &cycleID,
		Body: version.Body, SuccessSignal: version.SuccessSignal, CreatedAt: now, UpdatedAt: now,
	}, nil
}

func ContinueReview(current Goal, version Version, draft Draft, versionID, cycleID, operationID, requestHash string, now time.Time) (ContinueResult, error) {
	body, successSignal, changed, err := ReviewContentChanged(current, version, draft)
	if err != nil {
		return ContinueResult{}, err
	}
	selected := version
	if changed {
		selected = Version{
			ID: versionID, UserID: current.UserID, GoalID: current.ID,
			VersionNumber: current.CurrentVersionNumber + 1, Body: body, SuccessSignal: successSignal,
			CreatedByOperationID: operationID, CreatedAt: now.UTC(),
		}
		current.CurrentVersionNumber++
	}
	sequence := current.NextCycleSequenceNumber
	current.NextCycleSequenceNumber++
	current.Status = StatusActiveCycle
	current.Revision++
	current.UpdatedAt = now.UTC()
	return ContinueResult{
		Goal: current, Version: selected, VersionCreated: changed,
		Cycle: cycle.New(cycleID, current.UserID, current.ID, selected.ID, sequence, operationID, requestHash, now),
	}, nil
}

func Replan(
	current Goal,
	currentVersion Version,
	activeCycle cycle.PDCACycle,
	newCycleID, operationID, requestHash string,
	now time.Time,
) (ReplanResult, error) {
	if current.Status != StatusActiveCycle || current.UserID != currentVersion.UserID ||
		current.ID != currentVersion.GoalID || current.CurrentVersionNumber != currentVersion.VersionNumber ||
		activeCycle.Status != cycle.StatusActive || activeCycle.UserID != current.UserID ||
		activeCycle.GoalID != current.ID || activeCycle.GoalVersionID != currentVersion.ID ||
		activeCycle.SequenceNumber != current.NextCycleSequenceNumber-1 {
		return ReplanResult{}, ErrStateConflict
	}

	now = now.UTC()
	canceled, err := cycle.Cancel(activeCycle, cycle.CancellationReplanned, now)
	if err != nil {
		return ReplanResult{}, err
	}
	next := cycle.New(
		newCycleID,
		current.UserID,
		current.ID,
		currentVersion.ID,
		current.NextCycleSequenceNumber,
		operationID,
		requestHash,
		now,
	)
	current.NextCycleSequenceNumber++
	current.Revision++
	current.UpdatedAt = now

	return ReplanResult{Goal: current, CanceledCycle: canceled, Cycle: next}, nil
}

// ReviewContentChanged validates the Review aggregate references and returns
// the normalized Draft tuple together with whether it differs from the
// immutable current Version. Goal body whitespace remains significant.
func ReviewContentChanged(current Goal, version Version, draft Draft) (string, *string, bool, error) {
	if err := validateReviewReferences(current, version, draft); err != nil {
		return "", nil, false, err
	}
	body, err := NormalizeText(draft.Body, false)
	if err != nil {
		return "", nil, false, err
	}
	successSignal, err := NormalizeSuccessSignal(draft.SuccessSignal)
	if err != nil {
		return "", nil, false, err
	}
	changed := normalizeLineEndings(version.Body) != normalizeLineEndings(body) ||
		!optionalTextEqual(version.SuccessSignal, successSignal)
	return body, successSignal, changed, nil
}

// ReviewDraftDiffersFromVersion compares a Review Draft for discard
// confirmation. Unlike Continue Review, an empty Draft is valid here because
// it is being discarded rather than promoted to an immutable Version.
func ReviewDraftDiffersFromVersion(current Goal, version Version, draft Draft) (bool, error) {
	if err := validateReviewReferences(current, version, draft); err != nil {
		return false, err
	}
	draftSuccessSignal, err := NormalizeSuccessSignal(draft.SuccessSignal)
	if err != nil {
		return false, err
	}
	return normalizeLineEndings(version.Body) != normalizeLineEndings(draft.Body) ||
		!optionalTextEqual(version.SuccessSignal, draftSuccessSignal), nil
}

func validateReviewReferences(current Goal, version Version, draft Draft) error {
	if current.Status != StatusGoalReview || version.UserID != current.UserID || version.GoalID != current.ID ||
		version.VersionNumber != current.CurrentVersionNumber || draft.UserID != current.UserID ||
		draft.Type != DraftReview || draft.GoalID == nil || *draft.GoalID != current.ID ||
		draft.BaseGoalVersionID == nil || *draft.BaseGoalVersionID != version.ID ||
		draft.ReviewCycleID == nil || *draft.ReviewCycleID == "" {
		return ErrStateConflict
	}
	return nil
}

func Terminate(current Goal, outcome Status, operationID, requestHash string, now time.Time) (Goal, error) {
	if current.Status == StatusAchieved || current.Status == StatusEnded {
		return Goal{}, ErrAlreadyTerminal
	}
	if current.Status != StatusActiveCycle && current.Status != StatusGoalReview {
		return Goal{}, ErrStateConflict
	}
	if outcome != StatusAchieved && outcome != StatusEnded {
		return Goal{}, ErrStateConflict
	}
	now = now.UTC()
	current.Status = outcome
	current.Revision++
	current.TerminalAt = &now
	current.TerminalOperationID = &operationID
	current.TerminalRequestHash = &requestHash
	current.UpdatedAt = now
	return current, nil
}

func normalizeLineEndings(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
}

func optionalTextEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
