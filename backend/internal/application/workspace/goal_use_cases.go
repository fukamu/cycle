package workspace

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

const goalDeleteReceiptTTL = 24 * time.Hour

var ErrGoalPersistenceInvariant = errors.New("Goal persistence invariant violated")

type GoalUseCases struct {
	queries  GoalQueryRepository
	uow      GoalUnitOfWork
	clock    ports.Clock
	settings GoalUseCaseSettings
}

func NewGoalUseCases(
	queries GoalQueryRepository,
	uow GoalUnitOfWork,
	clock ports.Clock,
	settings GoalUseCaseSettings,
) *GoalUseCases {
	settings.CursorSigningKey = append([]byte(nil), settings.CursorSigningKey...)
	return &GoalUseCases{queries: queries, uow: uow, clock: clock, settings: settings}
}

func (useCases *GoalUseCases) ListGoals(ctx context.Context, userID, scope, cursor string, limit int) (GoalPage, error) {
	selected := GoalListScope(scope)
	if selected == "" {
		selected = GoalListAll
	}
	switch selected {
	case GoalListAll, GoalListProgressing, GoalListHistory:
	default:
		return GoalPage{}, ErrInvalidCursor
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	after, err := useCases.decodeGoalCursor(cursor, selected)
	if err != nil {
		return GoalPage{}, err
	}
	rows, err := useCases.queries.QueryGoalRows(ctx, GoalListQuery{
		UserID:     userID,
		Scope:      selected,
		After:      after,
		FetchLimit: limit + 1,
	})
	if err != nil {
		return GoalPage{}, err
	}
	if len(rows) > limit+1 {
		return GoalPage{}, goalInvariantError("Goal query returned more rows than requested")
	}
	if err = validateGoalQueryRows(rows, selected); err != nil {
		return GoalPage{}, err
	}
	page := GoalPage{Items: []GoalView{}}
	if len(rows) > limit {
		last := rows[limit-1]
		next, encodeErr := useCases.encodeGoalCursor(selected, GoalListKeyset{
			Category: last.Category,
			SortTime: last.SortTime,
			GoalID:   last.View.ID,
		})
		if encodeErr != nil {
			return GoalPage{}, encodeErr
		}
		page.NextCursor = &next
		rows = rows[:limit]
	}
	for _, row := range rows {
		page.Items = append(page.Items, row.View)
	}
	return page, nil
}

func (useCases *GoalUseCases) GetGoal(ctx context.Context, userID, goalID string) (GoalView, error) {
	view, err := useCases.queries.QueryGoal(ctx, userID, goalID)
	if err != nil {
		return GoalView{}, err
	}
	if err = validateGoalCurrentWork(view); err != nil {
		return GoalView{}, err
	}
	return view, nil
}

type goalCursorPayload struct {
	Scope    string     `json:"scope"`
	Category *int16     `json:"category,omitempty"`
	Time     *time.Time `json:"time,omitempty"`
	Sequence *int32     `json:"sequence,omitempty"`
	ID       string     `json:"id,omitempty"`
}

func (useCases *GoalUseCases) encodeGoalCursor(scope GoalListScope, keyset GoalListKeyset) (string, error) {
	payload := goalCursorPayload{
		Scope:    string(scope),
		Category: &keyset.Category,
		Time:     &keyset.SortTime,
		ID:       keyset.GoalID,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, useCases.settings.CursorSigningKey)
	_, _ = mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(append(body, mac.Sum(nil)...)), nil
}

func (useCases *GoalUseCases) decodeGoalCursor(encoded string, scope GoalListScope) (*GoalListKeyset, error) {
	if strings.TrimSpace(encoded) == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) <= sha256.Size {
		return nil, ErrInvalidCursor
	}
	body, signature := raw[:len(raw)-sha256.Size], raw[len(raw)-sha256.Size:]
	mac := hmac.New(sha256.New, useCases.settings.CursorSigningKey)
	_, _ = mac.Write(body)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, ErrInvalidCursor
	}
	var payload goalCursorPayload
	if json.Unmarshal(body, &payload) != nil || payload.Scope != string(scope) || payload.Category == nil ||
		payload.Time == nil || payload.Time.IsZero() || payload.Sequence != nil || !isGoalCursorUUID(payload.ID) ||
		!goalCursorCategoryMatchesScope(*payload.Category, scope) {
		return nil, ErrInvalidCursor
	}
	return &GoalListKeyset{Category: *payload.Category, SortTime: *payload.Time, GoalID: payload.ID}, nil
}

func goalCursorCategoryMatchesScope(category int16, scope GoalListScope) bool {
	switch scope {
	case GoalListAll:
		return category == 0 || category == 1
	case GoalListProgressing:
		return category == 0
	case GoalListHistory:
		return category == 1
	default:
		return false
	}
}

func isGoalCursorUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' ||
		value[14] != '7' || !strings.ContainsRune("89ab", rune(value[19])) {
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

func validateGoalQueryRows(rows []GoalQueryRow, scope GoalListScope) error {
	for index, row := range rows {
		if row.View.ID == "" || row.SortTime.IsZero() || !goalCursorCategoryMatchesScope(row.Category, scope) {
			return goalInvariantError("Goal query row metadata is incomplete")
		}
		expectedCategory, err := goalCategory(row.View.Status)
		if err != nil || expectedCategory != row.Category {
			return goalInvariantError("Goal query row category does not match status")
		}
		if err = validateGoalCurrentWork(row.View); err != nil {
			return err
		}
		if index > 0 && !goalQueryRowFollows(rows[index-1], row) {
			return goalInvariantError("Goal query rows are not in stable order")
		}
	}
	return nil
}

func goalCategory(status goal.Status) (int16, error) {
	switch status {
	case goal.StatusActiveCycle, goal.StatusGoalReview:
		return 0, nil
	case goal.StatusAchieved, goal.StatusEnded:
		return 1, nil
	default:
		return 0, goalInvariantError("Goal status is invalid")
	}
}

func goalQueryRowFollows(previous, current GoalQueryRow) bool {
	if current.Category != previous.Category {
		return current.Category > previous.Category
	}
	if !current.SortTime.Equal(previous.SortTime) {
		return current.SortTime.Before(previous.SortTime)
	}
	return current.View.ID < previous.View.ID
}

func validateGoalCurrentWork(view GoalView) error {
	work := view.CurrentWork
	switch view.Status {
	case goal.StatusActiveCycle:
		if work == nil || work.Kind != "active_cycle" || work.CycleID == "" || work.CycleSequenceNumber <= 0 ||
			work.ReviewDraftID != "" || work.TriggerCycleID != "" || work.TriggerCycleSequenceNumber != 0 {
			return goalInvariantError("active Goal current work is invalid")
		}
	case goal.StatusGoalReview:
		if work == nil || work.Kind != "goal_review" || work.ReviewDraftID == "" || work.TriggerCycleID == "" ||
			work.TriggerCycleSequenceNumber <= 0 || work.CycleID != "" || work.CycleSequenceNumber != 0 {
			return goalInvariantError("review Goal current work is invalid")
		}
	case goal.StatusAchieved, goal.StatusEnded:
		if work != nil {
			return goalInvariantError("terminal Goal has current work")
		}
	default:
		return goalInvariantError("Goal status is invalid")
	}
	return nil
}

func (useCases *GoalUseCases) DeleteGoal(
	ctx context.Context,
	userID, goalID string,
	confirmed bool,
	expectedRevision int64,
	idempotencyKey string,
) error {
	_, err := useCases.DeleteGoalWithResult(ctx, userID, goalID, confirmed, expectedRevision, idempotencyKey)
	return err
}

func (useCases *GoalUseCases) DeleteGoalWithResult(
	ctx context.Context,
	userID, goalID string,
	confirmed bool,
	expectedRevision int64,
	idempotencyKey string,
) (result GoalDeleteResult, err error) {
	if !confirmed {
		return result, ErrDeleteConfirmation
	}
	now := useCases.clock.Now().UTC()
	requestHash := hashRequest(struct {
		GoalID    string `json:"goalId"`
		Confirmed bool   `json:"confirmed"`
		Revision  int64  `json:"revision"`
	}{goalID, confirmed, expectedRevision})

	err = useCases.uow.WithinGoalTransaction(ctx, func(tx GoalTx) error {
		if err := tx.LockUser(ctx, userID); err != nil {
			return err
		}
		receipt, err := tx.FindGoalDeleteReceipt(ctx, userID, idempotencyKey)
		if err != nil {
			return err
		}
		if receipt != nil {
			if receipt.GoalID != goalID || receipt.RequestHash != requestHash {
				return ErrIdempotencyKeyReused
			}
			if receipt.ExpiresAt.After(now) {
				result.Replayed = true
				return nil
			}
		}

		target, err := tx.LockGoalForDelete(ctx, userID, goalID)
		if err != nil {
			return err
		}
		result.SourceState = target.Status
		if target.Revision != expectedRevision {
			return ErrDeleteConflict
		}
		draftIDs, err := tx.LockGoalDraftIDs(ctx, userID, goalID)
		if err != nil {
			return err
		}
		if err = requireGoalIDOrder("Goal Draft", draftIDs); err != nil {
			return err
		}
		cycleIDs, err := tx.LockGoalCycleIDs(ctx, userID, goalID)
		if err != nil {
			return err
		}
		if err = requireGoalIDOrder("Cycle", cycleIDs); err != nil {
			return err
		}
		generations, err := tx.LockRunningGoalGenerations(ctx, userID, goalID)
		if err != nil {
			return err
		}
		if err = requireGoalGenerationOrder(generations); err != nil {
			return err
		}
		generationIDs := make([]string, len(generations))
		for index := range generations {
			generationIDs[index] = generations[index].ID
		}
		monthly, err := tx.SumLockedGoalReservationsByMonth(ctx, userID, goalID, generationIDs)
		if err != nil {
			return err
		}
		if err = requireGoalMonthlyReservationOrder(monthly); err != nil {
			return err
		}
		for _, reservation := range monthly {
			rows, releaseErr := tx.ReleaseGoalBudgetReservationCAS(ctx, reservation.MonthUtc, reservation.AmountUSD, now)
			if releaseErr != nil {
				return releaseErr
			}
			if releaseErr = requireGoalRows("release Goal Delete budget reservation", rows, 1); releaseErr != nil {
				return releaseErr
			}
		}
		for _, generation := range generations {
			rows, terminalErr := tx.TerminalizeGoalGenerationCAS(ctx, userID, goalID, generation, now)
			if terminalErr != nil {
				return terminalErr
			}
			if terminalErr = requireGoalRows("terminalize Goal Delete generation", rows, 1); terminalErr != nil {
				return terminalErr
			}
			rows, terminalErr = tx.FailRunningGoalUsageCAS(ctx, userID, goalID, generation.ID)
			if terminalErr != nil {
				return terminalErr
			}
			if terminalErr = requireGoalRows("terminalize Goal Delete usage", rows, 1); terminalErr != nil {
				return terminalErr
			}
		}
		usages, err := tx.LockGoalUsages(ctx, userID, goalID)
		if err != nil {
			return err
		}
		redactUsageIDs, deleteUsageIDs, err := partitionGoalDeleteUsages(usages, now)
		if err != nil {
			return err
		}
		if len(redactUsageIDs) > 0 {
			rows, redactErr := tx.RedactGoalUsagesCAS(ctx, userID, goalID, redactUsageIDs)
			if redactErr != nil {
				return redactErr
			}
			if redactErr = requireGoalRows("redact Goal Delete usage", rows, int64(len(redactUsageIDs))); redactErr != nil {
				return redactErr
			}
		}
		if len(deleteUsageIDs) > 0 {
			rows, deleteErr := tx.DeleteExpiredFinalizedGoalUsagesCAS(ctx, userID, goalID, deleteUsageIDs, now)
			if deleteErr != nil {
				return deleteErr
			}
			if deleteErr = requireGoalRows("delete expired Goal usage", rows, int64(len(deleteUsageIDs))); deleteErr != nil {
				return deleteErr
			}
		}
		rows, err := tx.DeleteGoalCAS(ctx, userID, goalID, expectedRevision)
		if err != nil {
			return err
		}
		if err = requireGoalRows("delete Goal", rows, 1); err != nil {
			return err
		}
		rows, err = tx.InsertGoalDeleteReceipt(ctx, GoalDeleteReceiptRecord{
			UserID: userID, IdempotencyKey: idempotencyKey, GoalID: goalID,
			RequestHash: requestHash, DeletedAt: now, ExpiresAt: now.Add(goalDeleteReceiptTTL),
		})
		if err != nil {
			return err
		}
		return requireGoalRows("insert Goal Delete receipt", rows, 1)
	})
	return result, err
}

func partitionGoalDeleteUsages(usages []GoalDeleteUsage, now time.Time) ([]string, []string, error) {
	seen := make(map[string]struct{}, len(usages))
	usageIDs := make([]string, len(usages))
	for index, usage := range usages {
		if usage.OperationID == "" || usage.QuotaRetainUntil.IsZero() {
			return nil, nil, goalInvariantError("Goal usage identity or retention deadline is missing")
		}
		if _, duplicate := seen[usage.OperationID]; duplicate {
			return nil, nil, goalInvariantError("Goal usage lock returned a duplicate operation")
		}
		seen[usage.OperationID] = struct{}{}
		usageIDs[index] = usage.OperationID
	}
	if !slices.IsSorted(usageIDs) {
		return nil, nil, goalInvariantError("Goal usages are not locked in UUID order")
	}

	redact := make([]string, 0, len(usages))
	deleted := make([]string, 0, len(usages))
	for _, usage := range usages {
		if now.Before(usage.QuotaRetainUntil) || usage.ProviderUsageFinalizedAt == nil {
			redact = append(redact, usage.OperationID)
			continue
		}
		deleted = append(deleted, usage.OperationID)
	}
	return redact, deleted, nil
}

func requireGoalIDOrder(kind string, ids []string) error {
	if !slices.IsSorted(ids) {
		return goalInvariantError(kind + " rows are not locked in UUID order")
	}
	for index := 1; index < len(ids); index++ {
		if ids[index] == ids[index-1] {
			return goalInvariantError(kind + " lock returned a duplicate row")
		}
	}
	return nil
}

func requireGoalGenerationOrder(items []GoalDeleteGeneration) error {
	ids := make([]string, len(items))
	for index := range items {
		ids[index] = items[index].ID
		if items[index].ID == "" || items[index].ReservedCostUSD == "" {
			return goalInvariantError("running Goal generation state is incomplete")
		}
	}
	return requireGoalIDOrder("AI Generation", ids)
}

func requireGoalMonthlyReservationOrder(items []MonthlyReservation) error {
	for index, item := range items {
		if item.MonthUtc.IsZero() || !validPositiveGoalDecimal(item.AmountUSD) {
			return goalInvariantError("Goal budget reservation state is incomplete")
		}
		if index > 0 && !item.MonthUtc.After(items[index-1].MonthUtc) {
			return goalInvariantError("Goal budget months are not locked in ascending order")
		}
	}
	return nil
}

func requireGoalRows(operation string, actual, expected int64) error {
	if actual == expected {
		return nil
	}
	return fmt.Errorf("%w: %s affected %d rows, want %d", ErrGoalPersistenceInvariant, operation, actual, expected)
}

func goalInvariantError(detail string) error {
	return fmt.Errorf("%w: %s", ErrGoalPersistenceInvariant, detail)
}

func validPositiveGoalDecimal(value string) bool {
	if strings.Contains(value, "/") {
		return false
	}
	parsed, ok := new(big.Rat).SetString(value)
	return ok && parsed.Sign() > 0
}
