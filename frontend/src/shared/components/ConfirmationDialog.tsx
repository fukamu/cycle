import { useEffect, useId, useRef, type ReactNode } from "react";

type ConfirmationDialogProps = {
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly cancelDisabled?: boolean;
  readonly confirmTone?: "default" | "danger";
  readonly size?: "default" | "wide";
  readonly describeContent?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

export function ConfirmationDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "キャンセル",
  cancelDisabled = false,
  confirmTone = "default",
  size = "default",
  describeContent = true,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    const triggerElement = trigger.current;
    if (!element) return;
    try {
      element.showModal();
    } catch {
      // jsdom and older embedded browsers may not implement showModal.
      element.setAttribute("open", "");
    }
    const initialFocus = cancelButton.current?.disabled
      ? confirmButton.current
      : cancelButton.current;
    initialFocus?.focus();
    return () => {
      if (element.open) {
        if (typeof element.close === "function") element.close();
        else element.removeAttribute("open");
      }
      if (triggerElement?.isConnected) triggerElement.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={`confirmation-dialog confirmation-dialog--${size}`}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describeContent ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!cancelDisabled) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !cancelDisabled) onCancel();
      }}
    >
      <div className="confirmation-dialog__content">
        <h2 id={titleId}>{title}</h2>
        <div
          id={describeContent ? descriptionId : undefined}
          className="confirmation-dialog__description"
        >
          {children}
        </div>
        <div className="button-row confirmation-dialog__actions">
          <button
            ref={cancelButton}
            className="button button--secondary"
            type="button"
            disabled={cancelDisabled}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmButton}
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
