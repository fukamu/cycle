package postgres

import (
	"context"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

var _ workspace.GoalQueryRepository = (*WorkspaceStore)(nil)

func (store *WorkspaceStore) QueryGoalRows(
	ctx context.Context,
	query workspace.GoalListQuery,
) ([]workspace.GoalQueryRow, error) {
	var cursorCategory any
	var cursorTime any
	var cursorID any
	if query.After != nil {
		cursorCategory = query.After.Category
		cursorTime = query.After.SortTime
		cursorID = mustUUID(query.After.GoalID)
	}
	rows, err := store.pool.Query(ctx, goalViewQuery+`
WHERE g.user_id=$1
AND ($2='all' OR ($2='progressing' AND g.status IN ('active_cycle','goal_review')) OR ($2='history' AND g.status IN ('achieved','ended')))
AND ($3::smallint IS NULL
  OR CASE WHEN g.status IN ('active_cycle','goal_review') THEN 0 ELSE 1 END > $3
  OR (CASE WHEN g.status IN ('active_cycle','goal_review') THEN 0 ELSE 1 END = $3
    AND (CASE WHEN g.status IN ('active_cycle','goal_review') THEN g.updated_at ELSE g.terminal_at END,g.id)<($4,$5::uuid)))
ORDER BY category ASC,sort_time DESC,g.id DESC LIMIT $6`,
		mustUUID(query.UserID),
		string(query.Scope),
		cursorCategory,
		cursorTime,
		cursorID,
		query.FetchLimit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := []workspace.GoalQueryRow{}
	for rows.Next() {
		item, scanErr := scanGoalView(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		found = append(found, workspace.GoalQueryRow{
			View:     item.View,
			Category: item.Category,
			SortTime: item.SortTime,
		})
	}
	return found, rows.Err()
}

func (store *WorkspaceStore) QueryGoal(ctx context.Context, userID, goalID string) (workspace.GoalView, error) {
	return getGoalView(ctx, store.pool, userID, goalID)
}
