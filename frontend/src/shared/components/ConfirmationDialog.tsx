import { useEffect, useId, useRef, type ReactNode } from "react";

type ConfirmationDialogProps = {
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly confirmTone?: "default" | "danger";
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

export function ConfirmationDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "キャンセル",
  confirmTone = "default",
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    try {
      element.showModal();
    } catch {
      // jsdom and older embedded browsers may not implement showModal.
      element.setAttribute("open", "");
    }
    return () => {
      if (!element.open) return;
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="confirmation-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="confirmation-dialog__content">
        <h2 id={titleId}>{title}</h2>
        <div id={descriptionId} className="confirmation-dialog__description">
          {children}
        </div>
        <div className="button-row confirmation-dialog__actions">
          <button
            className="button button--secondary"
            type="button"
            autoFocus
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className={
              confirmTone === "danger"
                ? "button button--danger"
                : "button button--primary"
            }
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
