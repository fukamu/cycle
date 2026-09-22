package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/infrastructure/contentcrypto"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

var _ workspace.CycleQueryRepository = (*WorkspaceStore)(nil)

func (store *WorkspaceStore) QueryCycleRows(
	ctx context.Context,
	query workspace.CycleListQuery,
) (found []workspace.CycleSummary, err error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)
	queries := store.queries.WithTx(tx)

	goalExists, err := queries.OwnedGoalExistsForCycleRead(ctx, db.OwnedGoalExistsForCycleReadParams{
		GoalID: mustUUID(query.GoalID),
		UserID: mustUUID(query.UserID),
	})
	if err != nil {
		return nil, err
	}
	if !goalExists {
		return nil, workspace.ErrGoalNotFound
	}

	var afterSequence *int32
	var afterCycleID pgtype.UUID
	if query.After != nil {
		afterSequence = &query.After.SequenceNumber
		afterCycleID = mustUUID(query.After.CycleID)
	}
	rows, err := queries.ListCycleSummaries(ctx, db.ListCycleSummariesParams{
		UserID:              mustUUID(query.UserID),
		GoalID:              mustUUID(query.GoalID),
		AfterSequenceNumber: afterSequence,
		AfterCycleID:        afterCycleID,
		FetchLimit:          int32(query.FetchLimit),
	})
	if err != nil {
		return nil, err
	}
	found = make([]workspace.CycleSummary, 0, len(rows))
	content := contentBoundary{service: store.content}
	for _, row := range rows {
		if err = decodeCycleSummaryRow(ctx, content, query.UserID, row); err != nil {
			return nil, err
		}
		item, mapErr := cycleSummaryFromReadRow(row)
		if mapErr != nil {
			return nil, mapErr
		}
		found = append(found, item)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return found, nil
}

func (store *WorkspaceStore) QueryCycle(
	ctx context.Context,
	userID, goalID, cycleID string,
) (view workspace.CycleView, err error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return workspace.CycleView{}, err
	}
	defer rollback(ctx, tx)
	queries := store.queries.WithTx(tx)

	goalExists, err := queries.OwnedGoalExistsForCycleRead(ctx, db.OwnedGoalExistsForCycleReadParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if err != nil {
		return workspace.CycleView{}, err
	}
	if !goalExists {
		return workspace.CycleView{}, workspace.ErrGoalNotFound
	}
	view, err = queryCycleView(ctx, tx, contentBoundary{service: store.content}, userID, goalID, cycleID)
	if err != nil {
		return workspace.CycleView{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.CycleView{}, err
	}
	return view, nil
}

func queryCycleView(
	ctx context.Context,
	query db.DBTX,
	content contentBoundary,
	userID, goalID, cycleID string,
) (workspace.CycleView, error) {
	row, err := db.New(query).GetCycleView(ctx, db.GetCycleViewParams{
		CycleID: mustUUID(cycleID),
		GoalID:  mustUUID(goalID),
		UserID:  mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.CycleView{}, workspace.ErrCycleNotFound
	}
	if err != nil {
		return workspace.CycleView{}, err
	}
	if err = decodeCycleViewRow(ctx, content, userID, row); err != nil {
		return workspace.CycleView{}, err
	}
	return cycleViewFromReadRow(row)
}

func decodeCycleSummaryRow(
	ctx context.Context,
	content contentBoundary,
	userID string,
	row *db.ListCycleSummariesRow,
) error {
	if err := content.decodeGoalVersion(
		ctx, userID, uuidString(row.GoalVersionID),
		&row.GoalVersionBody, &row.GoalVersionSuccessSignal,
	); err != nil {
		return err
	}
	cycleID := uuidString(row.CycleID)
	if contentcrypto.IsEncryptedStorage(row.PlanPreview) {
		plain, err := content.decode(ctx, userID, "pdca_cycles", cycleID, "plan", row.PlanPreview)
		if err != nil {
			return err
		}
		row.PlanPreview, _ = cycleSummaryPreview(plain, true)
	}
	if contentcrypto.IsEncryptedStorage(row.CheckPreview) {
		plain, err := content.decode(ctx, userID, "pdca_cycles", cycleID, "check_text", row.CheckPreview)
		if err != nil {
			return err
		}
		row.CheckPreview, row.CheckPreviewTruncated = cycleSummaryPreview(plain, false)
	}
	if contentcrypto.IsEncryptedStorage(row.ActionPreview) {
		plain, err := content.decode(ctx, userID, "pdca_cycles", cycleID, "action", row.ActionPreview)
		if err != nil {
			return err
		}
		row.ActionPreview, row.ActionPreviewTruncated = cycleSummaryPreview(plain, false)
	}
	return nil
}

func decodeCycleViewRow(
	ctx context.Context,
	content contentBoundary,
	userID string,
	row *db.GetCycleViewRow,
) error {
	cycleID := uuidString(row.CycleID)
	fields := []struct {
		name  string
		value *string
	}{
		{name: "plan", value: &row.Plan},
		{name: "do_text", value: &row.DoText},
		{name: "check_text", value: &row.CheckText},
		{name: "action", value: &row.Action},
	}
	for _, field := range fields {
		decoded, err := content.decode(ctx, userID, "pdca_cycles", cycleID, field.name, *field.value)
		if err != nil {
			return err
		}
		*field.value = decoded
	}
	if err := content.decodeGoalVersion(
		ctx, userID, uuidString(row.GoalVersionID),
		&row.GoalVersionBody, &row.GoalVersionSuccessSignal,
	); err != nil {
		return err
	}
	if row.PreviousCycleAction != "" {
		decoded, err := content.decode(
			ctx, userID, "pdca_cycles", uuidString(row.PreviousCycleID), "action", row.PreviousCycleAction,
		)
		if err != nil {
			return err
		}
		row.PreviousCycleAction = decoded
	}
	return nil
}

func cycleSummaryPreview(value string, ellipsis bool) (string, bool) {
	runes := []rune(value)
	maximum := workspace.CycleSummaryPreviewMaxCodePoints
	if len(runes) <= maximum {
		return value, false
	}
	if ellipsis {
		return string(runes[:maximum-1]) + "…", true
	}
	return string(runes[:maximum]), true
}
