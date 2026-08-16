import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { completeCycle } from "../../../shared/api/cycles";
import type {
  ActiveCycle,
  AIActionResponse,
  Frame,
} from "../../../shared/api/schemas";
import { formatActivePeriod } from "../../../shared/date/format";
import { useAIProcessing } from "../../ai/aiProcessingContext";
import { frameCopy } from "../copy";
import type { DraftRecord } from "../draft/draftRepository";
import { useAutoSave } from "../hooks/useAutoSave";
import {
  canComplete,
  canGenerate,
  canRefine,
  codePointCount,
  disabledReason,
  isNonBlank,
  type AIState,
  type FrameValues,
} from "../model/eligibility";
import {
  readFrameSelection,
  writeFrameSelection,
} from "../navigation/frameSelectionRepository";
import { FrameTabs } from "./FrameTabs";
import { SaveStatus } from "./SaveStatus";

type CycleEditorProps = {
  readonly cycle: ActiveCycle;
  readonly userId: string;
  readonly csrfToken: string;
  readonly drafts: readonly DraftRecord[];
};

export function CycleEditor({
  cycle,
  userId,
  csrfToken,
  drafts,
}: CycleEditorProps) {
  const queryClient = useQueryClient();
  const [selectedFrame, setSelectedFrame] = useState<Frame>(() =>
    readFrameSelection(cycle.id),
  );
  const ai = useAIProcessing();
  const aiState: AIState = ai.state;
  const defaultValues = useMemo<FrameValues>(() => {
    const values: Record<Frame, string> = {
      plan: cycle.plan,
      do: cycle.do,
      check: cycle.check,
      action: cycle.action,
    };
    for (const draft of drafts) values[draft.frame] = draft.content;
    return values;
  }, [cycle, drafts]);
  const { control, setValue } = useForm<FrameValues>({ defaultValues });
  const watchedValues = useWatch({ control });
  const values: FrameValues = {
    plan: watchedValues.plan ?? defaultValues.plan,
    do: watchedValues.do ?? defaultValues.do,
    check: watchedValues.check ?? defaultValues.check,
    action: watchedValues.action ?? defaultValues.action,
  };
  const autoSave = useAutoSave({
    userId,
    cycle,
    csrfToken,
    initialDrafts: drafts,
    onSaved: (response) => {
      queryClient.setQueryData(
        ["active-cycle"],
        (current: { cycle: ActiveCycle } | undefined) => {
          if (current === undefined) return current;
          return {
            cycle: {
              ...current.cycle,
              [response.frame]: response.content,
              contentRevision: response.contentRevision,
              frameRevisions: {
                ...current.cycle.frameRevisions,
                [response.frame]: response.frameRevision,
              },
            },
          };
        },
      );
    },
  });
  const completeMutation = useMutation({
    mutationFn: () =>
      completeCycle(
        cycle.id,
        crypto.randomUUID(),
        cycle.contentRevision,
        csrfToken,
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(["active-cycle"], { cycle: result.nextCycle });
      void queryClient.invalidateQueries({ queryKey: ["completed-cycles"] });
    },
  });
  const copy = frameCopy[selectedFrame];
  const reason = disabledReason(values, autoSave.saveState, aiState);

  const selectFrame = (frame: Frame) => {
    autoSave.flush();
    setSelectedFrame(frame);
    writeFrameSelection(cycle.id, frame);
  };
  const complete = () => {
    if (!window.confirm("このサイクルを完了し、次のサイクルへ進みますか？"))
      return;
    completeMutation.mutate();
  };
  const applyAIResult = (result: AIActionResponse) => {
    setValue("action", result.action, { shouldDirty: false });
    autoSave.synchronizeFrame(
      "action",
      result.action,
      result.actionRevision,
      result.contentRevision,
    );
    queryClient.setQueryData(
      ["active-cycle"],
      (current: { cycle: ActiveCycle } | undefined) => {
        if (current === undefined) return current;
        return {
          cycle: {
            ...current.cycle,
            action: result.action,
            contentRevision: result.contentRevision,
            frameRevisions: {
              ...current.cycle.frameRevisions,
              action: result.actionRevision,
            },
            actionUserModifiedAfterAI: false,
          },
        };
      },
    );
  };
  const generate = async () => {
    const replacing = isNonBlank(values.action);
    if (
      replacing &&
      !window.confirm(
        cycle.actionUserModifiedAfterAI
          ? "自分で編集した現在のAを、AI生成結果で置き換えますか？"
          : "現在のAをAI生成結果で置き換えますか？",
      )
    ) {
      return;
    }
    try {
      applyAIResult(await ai.generate(cycle.contentRevision, replacing));
    } catch {
      // The provider keeps the existing A and exposes a user-facing error.
    }
  };
  const refine = async () => {
    try {
      applyAIResult(await ai.refine(cycle.contentRevision));
    } catch {
      // The provider keeps the existing A and exposes a user-facing error.
    }
  };

  return (
    <main className="page editor-page">
      <section className="cycle-heading" aria-label="現在のサイクル">
        <p className="eyebrow">CURRENT CYCLE</p>
        <div>
          <h1>Cycle {cycle.sequenceNumber}</h1>
          <p>{formatActivePeriod(cycle.startedAt)}</p>
        </div>
      </section>

      <section
        className="editor-card"
        id={`panel-${selectedFrame}`}
        role="tabpanel"
        aria-labelledby={`tab-${selectedFrame}`}
      >
        <div className="frame-title">
          <span>{copy.short}</span>
          <h2>{copy.name}</h2>
        </div>
        <p className="frame-guide" id={`guide-${selectedFrame}`}>
          {copy.guide}
        </p>
        <Controller
          key={selectedFrame}
          control={control}
          name={selectedFrame}
          render={({ field }) => (
            <textarea
              {...field}
              aria-label={`${copy.short} — ${copy.name}`}
              aria-describedby={`guide-${selectedFrame} count-${selectedFrame}`}
              placeholder={copy.placeholder}
              rows={12}
              readOnly={selectedFrame === "action" && aiState.kind !== "idle"}
              onChange={(event) => {
                if (codePointCount(event.target.value) > 2000) return;
                field.onChange(event);
                autoSave.change(selectedFrame, event.target.value);
              }}
              onBlur={() => {
                field.onBlur();
                autoSave.flush();
              }}
            />
          )}
        />
        <div className="editor-meta">
          <SaveStatus state={autoSave.saveState} onRetry={autoSave.retry} />
          <span id={`count-${selectedFrame}`}>
            {codePointCount(values[selectedFrame])} / 2,000
          </span>
        </div>

        {selectedFrame === "action" && (
          <div className="action-controls">
            <button
              type="button"
              className="secondary-button"
              disabled={!canGenerate(values, autoSave.saveState, aiState)}
              onClick={() => void generate()}
            >
              {aiState.kind === "generating"
                ? "生成しています…"
                : "アクションを生成"}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!canRefine(values, autoSave.saveState, aiState)}
              onClick={() => void refine()}
            >
              {aiState.kind === "refining" ? "推敲しています…" : "AIで推敲"}
            </button>
            {aiState.kind !== "idle" && (
              <p className="ai-status" aria-live="polite">
                AIがAを準備しています。P/D/Cは引き続き編集できます。
              </p>
            )}
            {ai.contextChanged && (
              <p className="ai-notice" aria-live="polite">
                P/D/C
                がアクション生成開始後に変更されています。必要に応じて再生成してください。
              </p>
            )}
            {ai.errorMessage !== null && (
              <p className="inline-error" role="alert">
                {ai.errorMessage}
              </p>
            )}
            {reason !== null && <p className="disabled-reason">{reason}</p>}
            <button
              type="button"
              className="primary-button"
              disabled={
                !canComplete(values, autoSave.saveState, aiState) ||
                completeMutation.isPending
              }
              onClick={complete}
            >
              {completeMutation.isPending
                ? "次のサイクルを準備中…"
                : "次サイクルへ"}
            </button>
            {completeMutation.isError && (
              <p className="inline-error" role="alert">
                サイクルを完了できませんでした。入力は保持されています。
              </p>
            )}
          </div>
        )}
      </section>
      <FrameTabs selected={selectedFrame} onSelect={selectFrame} />
    </main>
  );
}
