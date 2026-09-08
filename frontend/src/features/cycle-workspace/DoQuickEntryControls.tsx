import { useId, type PointerEvent as ReactPointerEvent } from "react";

import { cycleDoQuickEntryCopy } from "../../shared/copy/ja";

export type DoQuickEntryFeedback = {
  readonly kind: "status" | "error";
  readonly message: string;
};

export function DoQuickEntryControls({
  disabledReason,
  feedback,
  canUndo,
  onAdd,
  onAddPointerDown,
  onUndo,
}: {
  readonly disabledReason: string | undefined;
  readonly feedback: DoQuickEntryFeedback | undefined;
  readonly canUndo: boolean;
  readonly onAdd: () => void;
  readonly onAddPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  readonly onUndo: () => void;
}) {
  const descriptionId = useId();
  const statusId = useId();
  const describedBy = [
    descriptionId,
    disabledReason || feedback ? statusId : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="do-quick-entry">
      <div className="do-quick-entry__actions">
        <button
          className="button button--secondary do-quick-entry__add"
          type="button"
          aria-describedby={describedBy}
          aria-disabled={Boolean(disabledReason)}
          onPointerDown={onAddPointerDown}
          onClick={onAdd}
        >
          {cycleDoQuickEntryCopy.action}
        </button>
        {canUndo && (
          <button
            className="button button--secondary do-quick-entry__undo"
            type="button"
            onClick={onUndo}
          >
            {cycleDoQuickEntryCopy.undo}
          </button>
        )}
      </div>
      <p className="do-quick-entry__description" id={descriptionId}>
        {cycleDoQuickEntryCopy.description}
      </p>
      <p
        className={
          feedback?.kind === "error"
            ? "do-quick-entry__status do-quick-entry__status--error"
            : "do-quick-entry__status"
        }
        id={statusId}
        role={feedback?.kind === "error" ? "alert" : "status"}
        aria-live={feedback?.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {disabledReason ?? feedback?.message ?? ""}
      </p>
    </div>
  );
}
