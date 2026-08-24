package postgres

import (
	"context"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

var _ workspace.GoalQueryRepository = (*WorkspaceStore)(nil)

func (store *WorkspaceStore) QueryGoalRows(
	ctx context.Context,
	query workspace.GoalListQuery,
) ([]workspace.GoalQueryRow, error) {
	params := db.ListGoalViewsParams{
		UserID:     mustUUID(query.UserID),
		Scope:      string(query.Scope),
		FetchLimit: int32(query.FetchLimit),
	}
	if query.After != nil {
		category := query.After.Category
		params.AfterCategory = &category
		params.AfterSortTime = timestamptz(query.After.SortTime)
		params.AfterGoalID = mustUUID(query.After.GoalID)
	}
	rows, err := store.queries.ListGoalViews(ctx, params)
	if err != nil {
		return nil, err
	}
	found := make([]workspace.GoalQueryRow, 0, len(rows))
	for _, row := range rows {
		item, mapErr := goalViewFromListRow(row)
		if mapErr != nil {
			return nil, mapErr
		}
		found = append(found, workspace.GoalQueryRow{
			View:     item.View,
			Category: item.Category,
			SortTime: item.SortTime,
		})
	}
	return found, nil
}

func (store *WorkspaceStore) QueryGoal(ctx context.Context, userID, goalID string) (workspace.GoalView, error) {
	return getGoalView(ctx, store.pool, userID, goalID)
}
