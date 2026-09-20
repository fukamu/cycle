import type { Cycle, Frame } from "../../shared/api/schemas";
import { ConfirmationDialog } from "../../shared/components/ConfirmationDialog";
import { cycleReplanCopy } from "../../shared/copy/ja";
import { CycleCompletionSummary } from "./CycleCompletionSummary";

export type WorkspaceConfirmation =
  | { readonly kind: "replace-action" }
  | { readonly kind: "complete-cycle" }
  | { readonly kind: "replan" }
  | { readonly kind: "replan-discard"; readonly cleanupFailed?: boolean }
  | { readonly kind: "replan-retry" }
  | { readonly kind: "terminate"; readonly outcome: "achieved" | "ended" }
  | { readonly kind: "delete" };

export function CycleWorkspaceConfirmations({
  confirmation,
  cycle,
  values,
  onCancelReplan,
  onComplete,
  onDelete,
  onDismiss,
  onEditCompletionFrame,
  onReplaceAction,
  onReplan,
  onTerminate,
}: {
  readonly confirmation: WorkspaceConfirmation | undefined;
  readonly cycle: Cycle;
  readonly values: Readonly<Record<Frame, string>>;
  readonly onCancelReplan: () => void;
  readonly onComplete: () => Promise<void>;
  readonly onDelete: () => Promise<void>;
  readonly onDismiss: () => void;
  readonly onEditCompletionFrame: (frame: Frame) => void;
  readonly onReplaceAction: () => Promise<void>;
  readonly onReplan: (discardLocalDrafts: boolean) => Promise<void>;
  readonly onTerminate: (outcome: "achieved" | "ended") => Promise<void>;
}) {
  return (
    <>
      {confirmation?.kind === "replace-action" && (
        <ConfirmationDialog
          title="現在のAを置き換えますか？"
          confirmLabel="AIで置き換える"
          onCancel={onDismiss}
          onConfirm={() => {
            onDismiss();
            void onReplaceAction();
          }}
        >
          <p>現在のAをAI生成結果で置き換えます。</p>
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "complete-cycle" && (
        <ConfirmationDialog
          title="サイクルを完了する前に確認"
          confirmLabel="サイクルを完了"
          size="wide"
          describeContent={false}
          onCancel={onDismiss}
          onConfirm={() => {
            onDismiss();
            void onComplete();
          }}
        >
          <CycleCompletionSummary
            goalVersionNumber={cycle.goalVersion.versionNumber}
            cycleSequenceNumber={cycle.sequenceNumber}
            goalBody={cycle.goalVersion.body}
            values={values}
            onEdit={onEditCompletionFrame}
          />
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "replan" && (
        <ConfirmationDialog
          title={cycleReplanCopy.confirm.title}
          confirmLabel={cycleReplanCopy.confirm.action}
          onCancel={onCancelReplan}
          onConfirm={() => {
            onDismiss();
            void onReplan(false);
          }}
        >
          <p>{cycleReplanCopy.confirm.history}</p>
          <p>{cycleReplanCopy.confirm.successor}</p>
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "replan-discard" && (
        <ConfirmationDialog
          title={cycleReplanCopy.discard.title}
          confirmLabel={cycleReplanCopy.discard.action}
          confirmTone="danger"
          onCancel={onCancelReplan}
          onConfirm={() => {
            onDismiss();
            void onReplan(true);
          }}
        >
          <p>{cycleReplanCopy.discard.warning}</p>
          <p>{cycleReplanCopy.discard.retained}</p>
          {confirmation.cleanupFailed && (
            <p className="inline-error" role="alert">
              {cycleReplanCopy.discard.cleanupFailed}
            </p>
          )}
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "replan-retry" && (
        <ConfirmationDialog
          title={cycleReplanCopy.retry.title}
          confirmLabel={cycleReplanCopy.retry.action}
          cancelDisabled
          onCancel={() => undefined}
          onConfirm={() => {
            onDismiss();
            void onReplan(false);
          }}
        >
          <p>{cycleReplanCopy.retry.explanation}</p>
          <p>{cycleReplanCopy.retry.frozen}</p>
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "terminate" && (
        <ConfirmationDialog
          title={`目標を${
            confirmation.outcome === "achieved" ? "達成として終了" : "終了"
          }しますか？`}
          confirmLabel={
            confirmation.outcome === "achieved" ? "目標を達成" : "目標を終了"
          }
          confirmTone="danger"
          onCancel={onDismiss}
          onConfirm={() => {
            const { outcome } = confirmation;
            onDismiss();
            void onTerminate(outcome);
          }}
        >
          <p>現在のCycleはCanceledの読み取り専用履歴として残ります。</p>
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "delete" && (
        <ConfirmationDialog
          title="目標を削除しますか？"
          confirmLabel="目標を削除"
          confirmTone="danger"
          onCancel={onDismiss}
          onConfirm={() => {
            onDismiss();
            void onDelete();
          }}
        >
          <p>
            この目標とすべてのCycle履歴を完全に削除します。この操作は取り消せません。
          </p>
        </ConfirmationDialog>
      )}
    </>
  );
}
