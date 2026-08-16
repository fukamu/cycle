import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { completeCycle } from "../../../shared/api/cycles";
import type { ActiveCycle, Frame } from "../../../shared/api/schemas";
import { formatActivePeriod } from "../../../shared/date/format";
import { frameCopy } from "../copy";
import type { DraftRecord } from "../draft/draftRepository";
import { useAutoSave } from "../hooks/useAutoSave";
import {
  canComplete,
  codePointCount,
  disabledReason,
  type AIState,
  type FrameValues,
} from "../model/eligibility";
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
  const [selectedFrame, setSelectedFrame] = useState<Frame>("plan");
  const [aiState] = useState<AIState>({ kind: "idle" });
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
  const { control } = useForm<FrameValues>({ defaultValues });
  const watchedValues = useWatch({ control });
  const values: FrameValues = {
    plan: watchedValues.plan ?? "",
    do: watchedValues.do ?? "",
    check: watchedValues.check ?? "",
    action: watchedValues.action ?? "",
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
  };
  const complete = () => {
    if (!window.confirm("このサイクルを完了し、次のサイクルへ進みますか？"))
      return;
    completeMutation.mutate();
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
          control={control}
          name={selectedFrame}
          render={({ field }) => (
            <textarea
              {...field}
              key={selectedFrame}
              aria-label={`${copy.short} — ${copy.name}`}
              aria-describedby={`guide-${selectedFrame} count-${selectedFrame}`}
              placeholder={copy.placeholder}
              rows={12}
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
              disabled
              title="AI機能を接続中です"
            >
              アクションを生成
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled
              title="AI機能を接続中です"
            >
              AIで推敲
            </button>
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
