package ai

// OperationType identifies one of the three supported AI logical operations.
// It is intentionally typed so provider ports cannot dispatch on arbitrary
// strings while its canonical value can still be stored in PostgreSQL.
type OperationType string

const (
	OperationGoalRefine     OperationType = "goal_refine"
	OperationActionGenerate OperationType = "action_generate"
	OperationActionRefine   OperationType = "action_refine"
)

func (operation OperationType) Valid() bool {
	switch operation {
	case OperationGoalRefine, OperationActionGenerate, OperationActionRefine:
		return true
	default:
		return false
	}
}
