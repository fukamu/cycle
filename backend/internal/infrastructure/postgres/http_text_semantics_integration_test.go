package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/infrastructure/system"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkspaceHTTPTextSemanticsUseCodePointsAndNormalizeNewlines(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	service := workspace.NewService(store, store, store, store, &contractRejectProvider{}, contractIntegrationClock{now: now}, system.RandomGenerator{}, workspace.Settings{
		MaxProgressingGoals: 2,
		CursorSigningKey:    []byte("test-cursor-key"),
		MaxProviderAttempts: 1,
	})
	router := newContractIntegrationRouter(pool, service)
	client := bootstrapContractClient(t, router, "0198c20b-7b95-7000-8000-000000000071")
	goalAtLimit := strings.Repeat("🌱", 80)
	distinctGoalAtLimit := strings.Repeat("🌱", 79) + "🌿"

	createdResponse := performContractAuthorized(router, client, http.MethodPost, "/api/v1/goal-drafts",
		textSemanticsJSON(t, map[string]any{"initialBody": goalAtLimit}), "")
	if createdResponse.Code != http.StatusCreated {
		t.Fatalf("create Goal Draft response = %d %s", createdResponse.Code, createdResponse.Body.String())
	}
	var createdEnvelope struct {
		Draft workspace.DraftView `json:"draft"`
	}
	decodeTextSemanticsResponse(t, createdResponse, &createdEnvelope)
	if createdEnvelope.Draft.Body != goalAtLimit || createdEnvelope.Draft.Revision != 0 {
		t.Fatalf("created 80-code-point Goal Draft = %#v", createdEnvelope.Draft)
	}
	draftID := createdEnvelope.Draft.ID

	draftAtLimitResponse := performContractAuthorized(router, client, http.MethodPatch, "/api/v1/goal-drafts/"+draftID,
		textSemanticsJSON(t, map[string]any{"body": distinctGoalAtLimit, "expectedRevision": createdEnvelope.Draft.Revision}), "")
	if draftAtLimitResponse.Code != http.StatusOK {
		t.Fatalf("80-code-point Goal Draft response = %d %s", draftAtLimitResponse.Code, draftAtLimitResponse.Body.String())
	}
	var draftAtLimitEnvelope struct {
		Draft workspace.DraftView `json:"draft"`
	}
	decodeTextSemanticsResponse(t, draftAtLimitResponse, &draftAtLimitEnvelope)
	if draftAtLimitEnvelope.Draft.Body != distinctGoalAtLimit || draftAtLimitEnvelope.Draft.Revision != createdEnvelope.Draft.Revision+1 {
		t.Fatalf("80-code-point Goal Draft = %#v", draftAtLimitEnvelope.Draft)
	}

	draftOversizeResponse := performContractAuthorized(router, client, http.MethodPatch, "/api/v1/goal-drafts/"+draftID,
		textSemanticsJSON(t, map[string]any{"body": goalAtLimit + "🌱", "expectedRevision": draftAtLimitEnvelope.Draft.Revision}), "")
	assertTextSemanticsError(t, draftOversizeResponse, http.StatusBadRequest, "GOAL_TEXT_TOO_LONG")

	const (
		rawDraft        = "  下書き\r\n本文\r末尾 \t"
		normalizedDraft = "  下書き\n本文\n末尾 \t"
	)
	normalizedDraftResponse := performContractAuthorized(router, client, http.MethodPatch, "/api/v1/goal-drafts/"+draftID,
		textSemanticsJSON(t, map[string]any{"body": rawDraft, "expectedRevision": draftAtLimitEnvelope.Draft.Revision}), "")
	if normalizedDraftResponse.Code != http.StatusOK {
		t.Fatalf("normalized Goal Draft response = %d %s", normalizedDraftResponse.Code, normalizedDraftResponse.Body.String())
	}
	var normalizedDraftEnvelope struct {
		Draft workspace.DraftView `json:"draft"`
	}
	decodeTextSemanticsResponse(t, normalizedDraftResponse, &normalizedDraftEnvelope)
	if normalizedDraftEnvelope.Draft.Body != normalizedDraft {
		t.Fatalf("normalized Goal Draft response body = %q, want %q", normalizedDraftEnvelope.Draft.Body, normalizedDraft)
	}
	assertPersistedTextSemanticsValue(t, pool, `SELECT body FROM goal_drafts WHERE id=$1`, draftID, normalizedDraft)

	deleteDraftResponse := performContractAuthorized(router, client, http.MethodDelete, "/api/v1/goal-drafts/"+draftID, "", "")
	if deleteDraftResponse.Code != http.StatusNoContent {
		t.Fatalf("delete Goal Draft response = %d %s", deleteDraftResponse.Code, deleteDraftResponse.Body.String())
	}

	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, client.userID, fixture, 2, now.Add(time.Minute))
	frameAtLimit := strings.Repeat("🌱", 200)
	framePath := "/api/v1/goals/" + fixture.goalID + "/cycles/" + fixture.cycleID + "/frames/plan"
	frameAtLimitResponse := performContractAuthorized(router, client, http.MethodPatch, framePath,
		textSemanticsJSON(t, map[string]any{"content": frameAtLimit, "expectedFrameRevision": 0}), "")
	if frameAtLimitResponse.Code != http.StatusOK {
		t.Fatalf("200-code-point Frame response = %d %s", frameAtLimitResponse.Code, frameAtLimitResponse.Body.String())
	}
	var frameAtLimitResult workspace.SaveFrameResult
	decodeTextSemanticsResponse(t, frameAtLimitResponse, &frameAtLimitResult)
	if frameAtLimitResult.Content != frameAtLimit || frameAtLimitResult.FrameRevision != 1 {
		t.Fatalf("200-code-point Frame = %#v", frameAtLimitResult)
	}

	frameOversizeResponse := performContractAuthorized(router, client, http.MethodPatch, framePath,
		textSemanticsJSON(t, map[string]any{"content": frameAtLimit + "🌱", "expectedFrameRevision": frameAtLimitResult.FrameRevision}), "")
	assertTextSemanticsError(t, frameOversizeResponse, http.StatusBadRequest, "FRAME_TEXT_TOO_LONG")

	const (
		rawFrame        = "  P\r\nD\rA \t"
		normalizedFrame = "  P\nD\nA \t"
	)
	normalizedFrameResponse := performContractAuthorized(router, client, http.MethodPatch, framePath,
		textSemanticsJSON(t, map[string]any{"content": rawFrame, "expectedFrameRevision": frameAtLimitResult.FrameRevision}), "")
	if normalizedFrameResponse.Code != http.StatusOK {
		t.Fatalf("normalized Frame response = %d %s", normalizedFrameResponse.Code, normalizedFrameResponse.Body.String())
	}
	var normalizedFrameResult workspace.SaveFrameResult
	decodeTextSemanticsResponse(t, normalizedFrameResponse, &normalizedFrameResult)
	if normalizedFrameResult.Content != normalizedFrame {
		t.Fatalf("normalized Frame response content = %q, want %q", normalizedFrameResult.Content, normalizedFrame)
	}
	assertPersistedTextSemanticsValue(t, pool, `SELECT plan FROM pdca_cycles WHERE id=$1`, fixture.cycleID, normalizedFrame)

	for _, frame := range []cycle.Frame{cycle.FrameDo, cycle.FrameCheck, cycle.FrameAction} {
		if _, err := store.SaveFrame(context.Background(), workspace.SaveFrameInput{
			UserID: client.userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			Frame: frame, Content: string(frame), ExpectedFrameRevision: 0, Now: now.Add(2 * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
	const (
		reviewDraftID = "61000000-0000-7000-8000-000000000071"
		completeID    = "71000000-0000-7000-8000-000000000071"
	)
	completed, err := store.CompleteCycle(context.Background(), workspace.CompleteCycleInput{
		UserID: client.userID, GoalID: fixture.goalID, CycleID: fixture.cycleID, ReviewDraftID: reviewDraftID,
		OperationID: completeID, ExpectedGoalRevision: started.Goal.Revision,
		ExpectedContentRevision: normalizedFrameResult.ContentRevision + 3,
		RequestHash:             "m7-http-text-semantics-complete", Now: now.Add(3 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	reviewPath := "/api/v1/goals/" + fixture.goalID + "/review"
	reviewAtLimitResponse := performContractAuthorized(router, client, http.MethodPatch, reviewPath,
		textSemanticsJSON(t, map[string]any{
			"body": goalAtLimit, "expectedReviewDraftId": reviewDraftID, "expectedRevision": completed.ReviewDraft.Revision,
		}), "")
	if reviewAtLimitResponse.Code != http.StatusOK {
		t.Fatalf("80-code-point Review response = %d %s", reviewAtLimitResponse.Code, reviewAtLimitResponse.Body.String())
	}
	var reviewAtLimitEnvelope struct {
		ReviewDraft workspace.DraftView `json:"reviewDraft"`
	}
	decodeTextSemanticsResponse(t, reviewAtLimitResponse, &reviewAtLimitEnvelope)
	if reviewAtLimitEnvelope.ReviewDraft.Body != goalAtLimit || reviewAtLimitEnvelope.ReviewDraft.Revision != completed.ReviewDraft.Revision+1 {
		t.Fatalf("80-code-point Review Draft = %#v", reviewAtLimitEnvelope.ReviewDraft)
	}

	reviewOversizeResponse := performContractAuthorized(router, client, http.MethodPatch, reviewPath,
		textSemanticsJSON(t, map[string]any{
			"body": goalAtLimit + "🌱", "expectedReviewDraftId": reviewDraftID, "expectedRevision": reviewAtLimitEnvelope.ReviewDraft.Revision,
		}), "")
	assertTextSemanticsError(t, reviewOversizeResponse, http.StatusBadRequest, "GOAL_TEXT_TOO_LONG")

	const (
		rawReview        = "  Review\r\n本文\r末尾 \t"
		normalizedReview = "  Review\n本文\n末尾 \t"
	)
	normalizedReviewResponse := performContractAuthorized(router, client, http.MethodPatch, reviewPath,
		textSemanticsJSON(t, map[string]any{
			"body": rawReview, "expectedReviewDraftId": reviewDraftID, "expectedRevision": reviewAtLimitEnvelope.ReviewDraft.Revision,
		}), "")
	if normalizedReviewResponse.Code != http.StatusOK {
		t.Fatalf("normalized Review response = %d %s", normalizedReviewResponse.Code, normalizedReviewResponse.Body.String())
	}
	var normalizedReviewEnvelope struct {
		ReviewDraft workspace.DraftView `json:"reviewDraft"`
	}
	decodeTextSemanticsResponse(t, normalizedReviewResponse, &normalizedReviewEnvelope)
	if normalizedReviewEnvelope.ReviewDraft.Body != normalizedReview {
		t.Fatalf("normalized Review response body = %q, want %q", normalizedReviewEnvelope.ReviewDraft.Body, normalizedReview)
	}
	assertPersistedTextSemanticsValue(t, pool, `SELECT body FROM goal_drafts WHERE id=$1`, reviewDraftID, normalizedReview)
}

func textSemanticsJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func decodeTextSemanticsResponse(t *testing.T, response *httptest.ResponseRecorder, destination any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), destination); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
}

func assertTextSemanticsError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("error response = %d %s, want status %d and code %s", response.Code, response.Body.String(), status, code)
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeTextSemanticsResponse(t, response, &envelope)
	if envelope.Error.Code != code {
		t.Fatalf("error code = %q, want %q; body = %s", envelope.Error.Code, code, response.Body.String())
	}
}

func assertPersistedTextSemanticsValue(t *testing.T, pool *pgxpool.Pool, query, id, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(context.Background(), query, id).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("persisted text = %q, want %q", got, want)
	}
}
