import { useId, type PointerEvent as ReactPointerEvent } from "react";

import {
  cycleFrameTemplateCopy,
  type CycleFrameTemplate,
} from "../../shared/copy/ja";

export type TemplateFrame = "plan" | "do";

export function CycleFrameTemplatePicker({
  frame,
  disabledReason,
  canUndo,
  onInsert,
  onUndo,
}: {
  readonly frame: TemplateFrame;
  readonly disabledReason: string | undefined;
  readonly canUndo: boolean;
  readonly onInsert: (template: CycleFrameTemplate) => void;
  readonly onUndo: () => void;
}) {
  const id = useId();
  const headingId = `${id}-heading`;
  const statusId = `${id}-status`;
  const templates = cycleFrameTemplateCopy.templates[frame];
  const insertionDisabled = Boolean(disabledReason);
  const preventPointerFocus = (event: ReactPointerEvent<HTMLButtonElement>) =>
    event.preventDefault();

  return (
    <section className="frame-templates" aria-labelledby={headingId}>
      <div className="frame-templates__intro">
        <h3 id={headingId}>{cycleFrameTemplateCopy.heading}</h3>
        <p>{cycleFrameTemplateCopy.guide}</p>
      </div>
      <div className="frame-templates__list">
        {templates.map((template) => {
          const purposeId = `${id}-${template.id}-purpose`;
          const previewId = `${id}-${template.id}-preview`;
          const describedBy = [
            purposeId,
            previewId,
            insertionDisabled ? statusId : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          const action = cycleFrameTemplateCopy.insert(template.name);
          return (
            <article className="frame-template" key={template.id}>
              <h4>{template.name}</h4>
              <p className="frame-template__purpose" id={purposeId}>
                {template.purpose}
              </p>
              <div className="frame-template__preview">
                <span>{cycleFrameTemplateCopy.previewLabel}</span>
                <p id={previewId}>{template.content}</p>
              </div>
              <button
                className="button button--secondary frame-template__insert"
                type="button"
                aria-describedby={describedBy}
                aria-disabled={insertionDisabled}
                onPointerDown={preventPointerFocus}
                onClick={() => {
                  if (insertionDisabled) return;
                  onInsert(template);
                }}
              >
                {action}
              </button>
            </article>
          );
        })}
      </div>
      {canUndo && (
        <button
          className="button button--secondary frame-templates__undo"
          type="button"
          onPointerDown={preventPointerFocus}
          onClick={onUndo}
        >
          {cycleFrameTemplateCopy.undo}
        </button>
      )}
      <p
        className="frame-templates__status"
        id={statusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {disabledReason ?? ""}
      </p>
    </section>
  );
}
