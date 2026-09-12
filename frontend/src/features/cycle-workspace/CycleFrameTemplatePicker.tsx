import { useId, useState, type PointerEvent as ReactPointerEvent } from "react";

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
  const contentId = `${id}-content`;
  const statusId = `${id}-status`;
  const [expanded, setExpanded] = useState(false);
  const templates = cycleFrameTemplateCopy.templates[frame];
  const insertionDisabled = Boolean(disabledReason);
  const preventPointerFocus = (event: ReactPointerEvent<HTMLButtonElement>) =>
    event.preventDefault();

  return (
    <section
      className="frame-templates"
      aria-label={cycleFrameTemplateCopy.heading}
    >
      <h3 className="frame-templates__heading">
        <button
          className="frame-templates__toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{cycleFrameTemplateCopy.toggle}</span>
          <span className="frame-templates__toggle-icon" aria-hidden="true">
            {expanded ? "−" : "+"}
          </span>
        </button>
      </h3>
      <div
        className="frame-templates__content"
        id={contentId}
        hidden={!expanded}
      >
        <p className="frame-templates__guide">{cycleFrameTemplateCopy.guide}</p>
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
      </div>
    </section>
  );
}
