package cycle

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

const (
	defaultPageLimit = 20
	maxPageLimit     = 50
	previewRunes     = 120
)

var (
	ErrCycleNotFound     = errors.New("cycle not found")
	ErrCycleNotCompleted = errors.New("cycle not completed")
	ErrInvalidCursor     = errors.New("invalid cursor")
	ErrInvalidPageLimit  = errors.New("invalid page limit")
)

type Repository interface {
	GetActive(context.Context, user.ID) (domaincycle.PDCACycle, error)
	GetOwned(context.Context, user.ID, domaincycle.ID) (domaincycle.PDCACycle, error)
	SaveFrame(context.Context, SaveFrameInput) (domaincycle.SaveFrameResult, error)
	Complete(context.Context, CompleteInput) (domaincycle.CompleteResult, error)
	ListCompleted(context.Context, user.ID, *Cursor, int32) ([]domaincycle.PDCACycle, error)
}

type SaveFrameInput struct {
	UserID                user.ID
	CycleID               domaincycle.ID
	Frame                 domaincycle.Frame
	Content               string
	ExpectedFrameRevision int64
	Now                   time.Time
}

type CompleteInput struct {
	UserID                  user.ID
	CycleID                 domaincycle.ID
	NextCycleID             domaincycle.ID
	OperationID             domaincycle.OperationID
	ExpectedContentRevision int64
	Now                     time.Time
}

type Cursor struct {
	SequenceNumber int32  `json:"sequenceNumber"`
	CycleID        string `json:"cycleId"`
}

type CompletedSummary struct {
	ID             domaincycle.ID
	SequenceNumber int32
	StartedAt      time.Time
	CompletedAt    time.Time
	PlanPreview    string
}

type CompletedPage struct {
	Items      []CompletedSummary
	NextCursor string
}

type Clock interface {
	Now() time.Time
}

type IDGenerator interface {
	NewID() (string, error)
}

type Service struct {
	repository   Repository
	clock        Clock
	ids          IDGenerator
	cursorSecret []byte
}

func NewService(repository Repository, clock Clock, ids IDGenerator, cursorSecret []byte) *Service {
	return &Service{repository: repository, clock: clock, ids: ids, cursorSecret: append([]byte(nil), cursorSecret...)}
}

func (service *Service) GetActive(ctx context.Context, userID user.ID) (domaincycle.PDCACycle, error) {
	return service.repository.GetActive(ctx, userID)
}

func (service *Service) SaveFrame(ctx context.Context, userID user.ID, cycleID domaincycle.ID, frame domaincycle.Frame, content string, expectedFrameRevision int64) (domaincycle.SaveFrameResult, error) {
	return service.repository.SaveFrame(ctx, SaveFrameInput{
		UserID:                userID,
		CycleID:               cycleID,
		Frame:                 frame,
		Content:               content,
		ExpectedFrameRevision: expectedFrameRevision,
		Now:                   service.clock.Now().UTC(),
	})
}

func (service *Service) Complete(ctx context.Context, userID user.ID, cycleID domaincycle.ID, operationID domaincycle.OperationID, expectedContentRevision int64) (domaincycle.CompleteResult, error) {
	nextID, err := service.ids.NewID()
	if err != nil {
		return domaincycle.CompleteResult{}, err
	}
	return service.repository.Complete(ctx, CompleteInput{
		UserID:                  userID,
		CycleID:                 cycleID,
		NextCycleID:             domaincycle.ID(nextID),
		OperationID:             operationID,
		ExpectedContentRevision: expectedContentRevision,
		Now:                     service.clock.Now().UTC(),
	})
}

func (service *Service) GetCompleted(ctx context.Context, userID user.ID, cycleID domaincycle.ID) (domaincycle.PDCACycle, error) {
	result, err := service.repository.GetOwned(ctx, userID, cycleID)
	if err != nil {
		return domaincycle.PDCACycle{}, err
	}
	if result.Status != domaincycle.StatusCompleted {
		return domaincycle.PDCACycle{}, ErrCycleNotCompleted
	}
	return result, nil
}

func (service *Service) ListCompleted(ctx context.Context, userID user.ID, encodedCursor string, requestedLimit int) (CompletedPage, error) {
	limit := requestedLimit
	if limit == 0 {
		limit = defaultPageLimit
	}
	if limit < 1 || limit > maxPageLimit {
		return CompletedPage{}, ErrInvalidPageLimit
	}
	cursor, err := service.decodeCursor(encodedCursor)
	if err != nil {
		return CompletedPage{}, err
	}
	cycles, err := service.repository.ListCompleted(ctx, userID, cursor, int32(limit+1))
	if err != nil {
		return CompletedPage{}, err
	}
	hasNext := len(cycles) > limit
	if hasNext {
		cycles = cycles[:limit]
	}
	items := make([]CompletedSummary, 0, len(cycles))
	for _, item := range cycles {
		if item.CompletedAt == nil {
			return CompletedPage{}, errors.New("completed cycle has no completion time")
		}
		items = append(items, CompletedSummary{
			ID:             item.ID,
			SequenceNumber: item.SequenceNumber,
			StartedAt:      item.StartedAt,
			CompletedAt:    *item.CompletedAt,
			PlanPreview:    runePrefix(item.Plan, previewRunes),
		})
	}
	page := CompletedPage{Items: items}
	if hasNext && len(cycles) > 0 {
		last := cycles[len(cycles)-1]
		page.NextCursor, err = service.encodeCursor(Cursor{SequenceNumber: last.SequenceNumber, CycleID: string(last.ID)})
		if err != nil {
			return CompletedPage{}, err
		}
	}
	return page, nil
}

func (service *Service) encodeCursor(cursor Cursor) (string, error) {
	payload, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	signature := sign(service.cursorSecret, payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (service *Service) decodeCursor(encoded string) (*Cursor, error) {
	if encoded == "" {
		return nil, nil
	}
	parts := strings.Split(encoded, ".")
	if len(parts) != 2 {
		return nil, ErrInvalidCursor
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrInvalidCursor
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(signature, sign(service.cursorSecret, payload)) {
		return nil, ErrInvalidCursor
	}
	var cursor Cursor
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cursor); err != nil || cursor.SequenceNumber < 1 || !isCanonicalUUID(cursor.CycleID) {
		return nil, ErrInvalidCursor
	}
	return &cursor, nil
}

func sign(secret []byte, payload []byte) []byte {
	hash := hmac.New(sha256.New, secret)
	_, _ = hash.Write(payload)
	return hash.Sum(nil)
}

func runePrefix(value string, count int) string {
	if utf8.RuneCountInString(value) <= count {
		return value
	}
	return string([]rune(value)[:count])
}

func isCanonicalUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}
