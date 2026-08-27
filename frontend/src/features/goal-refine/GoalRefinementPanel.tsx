import type { AutoSaveState } from "../../shared/autosave/autoSaveCoordinator";
import { isGoalSuggestionStale } from "./suggestionState";
import type { GoalRefinementState } from "./useGoalRefinement";

export function GoalRefinementPanel({
  id,
  state,
  currentBody,
  saveState,
  pending,
  failureMessage,
  onDismiss,
  onAdopt,
}: {
  readonly id: string;
  readonly state: GoalRefinementState;
  readonly currentBody: string;
  readonly saveState: AutoSaveState;
  readonly pending: boolean;
  readonly failureMessage: string;
  readonly onDismiss: () => void;
  readonly onAdopt: () => void;
}) {
  if (state.kind === "failed") {
    return (
      <p className="inline-error" role="alert">
        {failureMessage}
      </p>
    );
  }
  if (state.kind !== "suggested") return null;

  const stale = isGoalSuggestionStale(currentBody, state.sourceBody, saveState);
  const titleId = `${id}-suggestion-title`;
  return (
    <section className="suggestion-panel" aria-labelledby={titleId}>
      <h2 className="eyebrow" id={titleId}>
        AIからの提案
      </h2>
      <p className="suggestion-text" role="status">
        {state.response.suggestion}
      </p>
      {stale && (
        <p className="inline-error" role="alert">
          提案後に下書きが変更されたため、この提案は採用できません。
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          className="button button--secondary"
          onClick={onDismiss}
        >
          元の目標を維持
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={stale || pending}
          onClick={onAdopt}
        >
          提案を採用
        </button>
      </div>
    </section>
  );
}
