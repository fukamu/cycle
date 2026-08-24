package postgres

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

func cyclePersistenceError(message string) error {
	return fmt.Errorf("%w: %s", workspace.ErrCyclePersistenceInvariant, message)
}

func finiteCycleTimestamp(value pgtype.Timestamptz) (time.Time, bool) {
	if !value.Valid || value.InfinityModifier != pgtype.Finite {
		return time.Time{}, false
	}
	return value.Time.UTC(), true
}

func nullableFiniteCycleTimestamp(value pgtype.Timestamptz) (*time.Time, bool) {
	if !value.Valid {
		return nil, true
	}
	if value.InfinityModifier != pgtype.Finite {
		return nil, false
	}
	timestamp := value.Time.UTC()
	return &timestamp, true
}

func cycleLifecycleFromSQLC(
	statusValue string,
	completedValue, canceledValue pgtype.Timestamptz,
) (cycle.Status, *time.Time, *time.Time, error) {
	completedAt, completedValid := nullableFiniteCycleTimestamp(completedValue)
	canceledAt, canceledValid := nullableFiniteCycleTimestamp(canceledValue)
	if !completedValid || !canceledValid {
		return "", nil, nil, cyclePersistenceError("Cycle terminal timestamp is non-finite")
	}

	status := cycle.Status(statusValue)
	switch status {
	case cycle.StatusActive:
		if completedAt != nil || canceledAt != nil {
			return "", nil, nil, cyclePersistenceError("active Cycle has terminal timestamps")
		}
	case cycle.StatusCompleted:
		if completedAt == nil || canceledAt != nil {
			return "", nil, nil, cyclePersistenceError("completed Cycle timestamp tuple is invalid")
		}
	case cycle.StatusCanceled:
		if completedAt != nil || canceledAt == nil {
			return "", nil, nil, cyclePersistenceError("canceled Cycle timestamp tuple is invalid")
		}
	default:
		return "", nil, nil, cyclePersistenceError("Cycle status is invalid")
	}
	return status, completedAt, canceledAt, nil
}

func cycleCancellationReasonFromSQLC(
	status cycle.Status,
	value *string,
) (*cycle.CancellationReason, error) {
	if status != cycle.StatusCanceled {
		if value != nil {
			return nil, cyclePersistenceError("non-canceled Cycle has a cancellation reason")
		}
		return nil, nil
	}
	if value == nil {
		return nil, cyclePersistenceError("canceled Cycle has no cancellation reason")
	}
	reason := cycle.CancellationReason(*value)
	if reason != cycle.CancellationGoalAchieved && reason != cycle.CancellationGoalEnded {
		return nil, cyclePersistenceError("Cycle cancellation reason is invalid")
	}
	return &reason, nil
}

func cycleGoalVersionViewFromSQLC(
	id pgtype.UUID,
	versionNumber *int32,
	body *string,
	createdValue pgtype.Timestamptz,
) (workspace.GoalVersionView, error) {
	createdAt, createdValid := finiteCycleTimestamp(createdValue)
	versionID := uuidString(id)
	if versionID == "" || versionNumber == nil || *versionNumber <= 0 || body == nil || *body == "" || !createdValid {
		return workspace.GoalVersionView{}, cyclePersistenceError("Cycle Goal Version is missing or invalid")
	}
	return workspace.GoalVersionView{
		ID:            versionID,
		VersionNumber: *versionNumber,
		Body:          *body,
		CreatedAt:     createdAt,
	}, nil
}

func cycleSummaryFromReadRow(row *db.ListCycleSummariesRow) (workspace.CycleSummary, error) {
	if row == nil {
		return workspace.CycleSummary{}, cyclePersistenceError("Cycle summary row is nil")
	}
	cycleID := uuidString(row.CycleID)
	startedAt, startedValid := finiteCycleTimestamp(row.StartedAt)
	status, completedAt, canceledAt, err := cycleLifecycleFromSQLC(row.Status, row.CompletedAt, row.CanceledAt)
	if err != nil {
		return workspace.CycleSummary{}, err
	}
	version, err := cycleGoalVersionViewFromSQLC(
		row.GoalVersionID,
		row.GoalVersionNumber,
		row.GoalVersionBody,
		row.GoalVersionCreatedAt,
	)
	if err != nil {
		return workspace.CycleSummary{}, err
	}
	if cycleID == "" || row.SequenceNumber <= 0 || !startedValid {
		return workspace.CycleSummary{}, cyclePersistenceError("Cycle summary identity or start timestamp is invalid")
	}
	return workspace.CycleSummary{
		ID:             cycleID,
		SequenceNumber: row.SequenceNumber,
		Status:         status,
		StartedAt:      startedAt,
		CompletedAt:    completedAt,
		CanceledAt:     canceledAt,
		GoalVersion:    version,
		PlanPreview:    row.PlanPreview,
	}, nil
}

func cycleViewFromReadRow(row *db.GetCycleViewRow) (workspace.CycleView, error) {
	if row == nil {
		return workspace.CycleView{}, cyclePersistenceError("Cycle view row is nil")
	}
	cycleID := uuidString(row.CycleID)
	goalID := uuidString(row.GoalID)
	startedAt, startedValid := finiteCycleTimestamp(row.StartedAt)
	status, completedAt, canceledAt, err := cycleLifecycleFromSQLC(row.Status, row.CompletedAt, row.CanceledAt)
	if err != nil {
		return workspace.CycleView{}, err
	}
	cancellationReason, err := cycleCancellationReasonFromSQLC(status, row.CancellationReason)
	if err != nil {
		return workspace.CycleView{}, err
	}
	version, err := cycleGoalVersionViewFromSQLC(
		row.GoalVersionID,
		row.GoalVersionNumber,
		row.GoalVersionBody,
		row.GoalVersionCreatedAt,
	)
	if err != nil {
		return workspace.CycleView{}, err
	}
	if cycleID == "" || goalID == "" || row.SequenceNumber <= 0 || !startedValid ||
		row.ContentRevision < 0 || row.PlanRevision < 0 || row.DoRevision < 0 ||
		row.CheckRevision < 0 || row.ActionRevision < 0 {
		return workspace.CycleView{}, cyclePersistenceError("Cycle view identity, start timestamp, or revision is invalid")
	}
	return workspace.CycleView{
		ID:                 cycleID,
		GoalID:             goalID,
		SequenceNumber:     row.SequenceNumber,
		Status:             status,
		GoalVersion:        version,
		StartedAt:          startedAt,
		CompletedAt:        completedAt,
		CanceledAt:         canceledAt,
		CancellationReason: cancellationReason,
		Plan:               row.Plan,
		Do:                 row.DoText,
		Check:              row.CheckText,
		Action:             row.Action,
		ContentRevision:    row.ContentRevision,
		FrameRevisions: workspace.FrameRevisions{
			Plan:   row.PlanRevision,
			Do:     row.DoRevision,
			Check:  row.CheckRevision,
			Action: row.ActionRevision,
		},
	}, nil
}

func cycleFromSQLC(row *db.PdcaCycle) (cycle.PDCACycle, error) {
	if row == nil {
		return cycle.PDCACycle{}, cyclePersistenceError("locked Cycle row is nil")
	}
	id := uuidString(row.ID)
	userID := uuidString(row.UserID)
	goalID := uuidString(row.GoalID)
	goalVersionID := uuidString(row.GoalVersionID)
	startOperationID := uuidString(row.StartOperationID)
	startedAt, startedValid := finiteCycleTimestamp(row.StartedAt)
	createdAt, createdValid := finiteCycleTimestamp(row.CreatedAt)
	updatedAt, updatedValid := finiteCycleTimestamp(row.UpdatedAt)
	status, completedAt, canceledAt, err := cycleLifecycleFromSQLC(row.Status, row.CompletedAt, row.CanceledAt)
	if err != nil {
		return cycle.PDCACycle{}, err
	}
	cancellationReason, err := cycleCancellationReasonFromSQLC(status, row.CancellationReason)
	if err != nil {
		return cycle.PDCACycle{}, err
	}
	if id == "" || userID == "" || goalID == "" || goalVersionID == "" || startOperationID == "" ||
		row.StartRequestHash == "" || row.SequenceNumber <= 0 || !startedValid || !createdValid || !updatedValid ||
		row.ContentRevision < 0 || row.PlanRevision < 0 || row.DoRevision < 0 ||
		row.CheckRevision < 0 || row.ActionRevision < 0 {
		return cycle.PDCACycle{}, cyclePersistenceError("locked Cycle required state is missing or invalid")
	}
	if row.ActionLastAiAppliedContentRevision != nil &&
		(*row.ActionLastAiAppliedContentRevision <= 0 || *row.ActionLastAiAppliedContentRevision > row.ContentRevision) {
		return cycle.PDCACycle{}, cyclePersistenceError("locked Cycle AI revision is invalid")
	}

	var completionOperationID *string
	var completionRequestHash *string
	switch status {
	case cycle.StatusCompleted:
		operationID := uuidString(row.CompletionOperationID)
		if operationID == "" || row.CompletionRequestHash == nil || *row.CompletionRequestHash == "" {
			return cycle.PDCACycle{}, cyclePersistenceError("completed Cycle operation metadata is incomplete")
		}
		completionOperationID = &operationID
		requestHash := *row.CompletionRequestHash
		completionRequestHash = &requestHash
	default:
		if row.CompletionOperationID.Valid || row.CompletionRequestHash != nil {
			return cycle.PDCACycle{}, cyclePersistenceError("non-completed Cycle has completion metadata")
		}
	}

	return cycle.PDCACycle{
		ID:                 id,
		UserID:             userID,
		GoalID:             goalID,
		GoalVersionID:      goalVersionID,
		SequenceNumber:     row.SequenceNumber,
		Status:             status,
		StartedAt:          startedAt,
		CompletedAt:        completedAt,
		CanceledAt:         canceledAt,
		CancellationReason: cancellationReason,
		Plan:               row.Plan,
		Do:                 row.DoText,
		Check:              row.CheckText,
		Action:             row.Action,
		Revisions: cycle.Revisions{
			Content: row.ContentRevision,
			Plan:    row.PlanRevision,
			Do:      row.DoRevision,
			Check:   row.CheckRevision,
			Action:  row.ActionRevision,
		},
		ActionLastAIRevision:  row.ActionLastAiAppliedContentRevision,
		ActionModifiedAfterAI: row.ActionUserModifiedAfterAi,
		StartOperationID:      startOperationID,
		StartRequestHash:      row.StartRequestHash,
		CompletionOperationID: completionOperationID,
		CompletionRequestHash: completionRequestHash,
		CreatedAt:             createdAt,
		UpdatedAt:             updatedAt,
	}, nil
}

func completeCycleReceiptFromSQLC(
	row *db.FindCompleteCycleReceiptRow,
) (*workspace.CompleteCycleReceipt, error) {
	if row == nil {
		return nil, cyclePersistenceError("Complete Cycle receipt row is nil")
	}
	goalID := uuidString(row.GoalID)
	cycleID := uuidString(row.CycleID)
	if goalID == "" || cycleID == "" || row.RequestHash == nil || *row.RequestHash == "" {
		return nil, cyclePersistenceError("Complete Cycle receipt is incomplete")
	}
	return &workspace.CompleteCycleReceipt{
		GoalID:      goalID,
		CycleID:     cycleID,
		RequestHash: *row.RequestHash,
	}, nil
}

func startReplayFromSQLC(row *db.FindStartReplayRow) (*workspace.StartReplayState, error) {
	if row == nil {
		return nil, cyclePersistenceError("Start replay row is nil")
	}
	goalID := uuidString(row.GoalID)
	cycleID := uuidString(row.CycleID)
	if goalID == "" || cycleID == "" || row.RequestHash == "" {
		return nil, cyclePersistenceError("Start replay is incomplete")
	}
	return &workspace.StartReplayState{
		GoalID:      goalID,
		CycleID:     cycleID,
		RequestHash: row.RequestHash,
	}, nil
}

func continueReviewReceiptFromSQLC(
	row *db.FindContinueReviewReceiptRow,
) (*workspace.ContinueReviewReceipt, error) {
	if row == nil {
		return nil, cyclePersistenceError("Continue Review receipt row is nil")
	}
	goalID := uuidString(row.GoalID)
	cycleID := uuidString(row.CycleID)
	if goalID == "" || cycleID == "" || row.RequestHash == "" {
		return nil, cyclePersistenceError("Continue Review receipt is incomplete")
	}
	return &workspace.ContinueReviewReceipt{
		GoalID:         goalID,
		CycleID:        cycleID,
		RequestHash:    row.RequestHash,
		VersionCreated: row.VersionCreated,
	}, nil
}

func aiContextCycleFromSQLC(row *db.ListAIContextCyclesRow) (workspace.AIContextCycle, error) {
	if row == nil {
		return workspace.AIContextCycle{}, cyclePersistenceError("AI context Cycle row is nil")
	}
	cycleID := uuidString(row.CycleID)
	goalID := uuidString(row.GoalID)
	status := cycle.Status(row.Status)
	if cycleID == "" || goalID == "" || row.SequenceNumber <= 0 || row.GoalBody == "" ||
		(status != cycle.StatusCompleted && status != cycle.StatusCanceled) {
		return workspace.AIContextCycle{}, cyclePersistenceError("AI context Cycle state is invalid")
	}
	return workspace.AIContextCycle{
		ID:             cycleID,
		GoalID:         goalID,
		SequenceNumber: row.SequenceNumber,
		Status:         status,
		GoalBody:       row.GoalBody,
		Plan:           row.Plan,
		Do:             row.DoText,
		Check:          row.CheckText,
		Action:         row.Action,
	}, nil
}

func cycleIDsFromSQLC(rows []pgtype.UUID) ([]string, error) {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		id := uuidString(row)
		if id == "" {
			return nil, cyclePersistenceError("locked Cycle identity is invalid")
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func nullableCycleUUID(value string) pgtype.UUID {
	if value == "" {
		return pgtype.UUID{}
	}
	return mustUUID(value)
}
