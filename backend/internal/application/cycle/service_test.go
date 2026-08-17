package cycle

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

func TestListCompletedBuildsSignedCursorAndPreview(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 16, 0, 0, 0, 0, time.UTC)
	repository := &fakeCycleRepository{completed: []domaincycle.PDCACycle{
		completedCycle("00000000-0000-4000-8000-000000000003", 3, strings.Repeat("計", 121), now),
		completedCycle("00000000-0000-4000-8000-000000000002", 2, "second", now),
	}}
	service := NewService(repository, fakeClock{now}, fakeID{}, []byte("cursor-secret"))
	page, err := service.ListCompleted(context.Background(), user.ID("user"), "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || len([]rune(page.Items[0].PlanPreview)) != 120 || page.NextCursor == "" {
		t.Fatalf("page = %#v", page)
	}
	decoded, err := service.decodeCursor(page.NextCursor)
	if err != nil || decoded.SequenceNumber != 3 {
		t.Fatalf("decoded = %#v, %v", decoded, err)
	}
	if _, err = service.ListCompleted(context.Background(), user.ID("user"), page.NextCursor+"x", 1); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("tampered cursor error = %v", err)
	}
}

func TestGetCompletedRejectsActive(t *testing.T) {
	t.Parallel()

	repository := &fakeCycleRepository{owned: domaincycle.PDCACycle{Status: domaincycle.StatusActive}}
	service := NewService(repository, fakeClock{}, fakeID{}, []byte("cursor-secret"))
	_, err := service.GetCompleted(context.Background(), user.ID("user"), domaincycle.ID("cycle"))
	if !errors.Is(err, ErrCycleNotCompleted) {
		t.Fatalf("error = %v", err)
	}
}

func completedCycle(id string, sequence int32, plan string, completedAt time.Time) domaincycle.PDCACycle {
	return domaincycle.PDCACycle{
		ID:             domaincycle.ID(id),
		SequenceNumber: sequence,
		Status:         domaincycle.StatusCompleted,
		StartedAt:      completedAt.Add(-time.Hour),
		CompletedAt:    &completedAt,
		Plan:           plan,
	}
}

type fakeClock struct{ now time.Time }

func (clock fakeClock) Now() time.Time { return clock.now }

type fakeID struct{}

func (fakeID) NewID() (string, error) { return "00000000-0000-4000-8000-000000000009", nil }

type fakeCycleRepository struct {
	owned     domaincycle.PDCACycle
	completed []domaincycle.PDCACycle
}

func (repository *fakeCycleRepository) GetActive(context.Context, user.ID) (domaincycle.PDCACycle, error) {
	return domaincycle.PDCACycle{}, nil
}

func (repository *fakeCycleRepository) GetOwned(context.Context, user.ID, domaincycle.ID) (domaincycle.PDCACycle, error) {
	return repository.owned, nil
}

func (repository *fakeCycleRepository) SaveFrame(context.Context, SaveFrameInput) (domaincycle.SaveFrameResult, error) {
	return domaincycle.SaveFrameResult{}, nil
}

func (repository *fakeCycleRepository) Complete(context.Context, CompleteInput) (domaincycle.CompleteResult, error) {
	return domaincycle.CompleteResult{}, nil
}

func (repository *fakeCycleRepository) ListCompleted(context.Context, user.ID, *Cursor, int32) ([]domaincycle.PDCACycle, error) {
	return append([]domaincycle.PDCACycle(nil), repository.completed...), nil
}
