package goal

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

const MaxGoalCodePoints = 80

var (
	ErrTextRequired       = errors.New("goal text is required")
	ErrTextTooLong        = errors.New("goal text is too long")
	ErrForbiddenCharacter = errors.New("goal text contains a forbidden character")
	ErrStateConflict      = errors.New("goal state conflict")
	ErrAlreadyTerminal    = errors.New("goal is already terminal")
	ErrDiscardRequired    = errors.New("review draft discard confirmation is required")
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

func NormalizeText(value string, allowEmpty bool) (string, error) {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
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

func NewDraft(id, userID, body string, now time.Time) (Draft, error) {
	body, err := NormalizeText(body, true)
	if err != nil {
		return Draft{}, err
	}
	now = now.UTC()
	return Draft{ID: id, UserID: userID, Type: DraftCreation, Body: body, CreatedAt: now, UpdatedAt: now}, nil
}

func SaveDraft(current Draft, body string, expectedRevision int64, now time.Time) (Draft, bool, error) {
	if current.Revision != expectedRevision {
		return Draft{}, false, ErrStateConflict
	}
	body, err := NormalizeText(body, true)
	if err != nil {
		return Draft{}, false, err
	}
	if current.Body == body {
		return current, true, nil
	}
	current.Body = body
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
	now = now.UTC()
	created := Goal{
		ID: goalID, UserID: draft.UserID, Status: StatusActiveCycle,
		CurrentVersionNumber: 1, NextCycleSequenceNumber: 2,
		CreatedAt: now, UpdatedAt: now,
	}
	version := Version{
		ID: versionID, UserID: draft.UserID, GoalID: goalID, VersionNumber: 1,
		Body: body, CreatedByOperationID: operationID, CreatedAt: now,
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
		Body: version.Body, CreatedAt: now, UpdatedAt: now,
	}, nil
}

func ContinueReview(current Goal, version Version, draft Draft, versionID, cycleID, operationID, requestHash string, now time.Time) (ContinueResult, error) {
	if current.Status != StatusGoalReview || draft.Type != DraftReview || draft.GoalID == nil || *draft.GoalID != current.ID || version.GoalID != current.ID {
		return ContinueResult{}, ErrStateConflict
	}
	body, err := NormalizeText(draft.Body, false)
	if err != nil {
		return ContinueResult{}, err
	}
	selected := version
	created := normalizeLineEndings(version.Body) != normalizeLineEndings(body)
	if created {
		selected = Version{
			ID: versionID, UserID: current.UserID, GoalID: current.ID,
			VersionNumber: current.CurrentVersionNumber + 1, Body: body,
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
		Goal: current, Version: selected, VersionCreated: created,
		Cycle: cycle.New(cycleID, current.UserID, current.ID, selected.ID, sequence, operationID, requestHash, now),
	}, nil
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
