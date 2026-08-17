import { useRef, type KeyboardEvent } from "react";

import type { Frame } from "../../../shared/api/schemas";
import { frameCopy, frameOrder } from "../copy";

type FrameTabsProps = {
  readonly selected: Frame;
  readonly onSelect: (frame: Frame) => void;
};

export function FrameTabs({ selected, onSelect }: FrameTabsProps) {
  const tabs = useRef(new Map<Frame, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, frame: Frame) => {
    const current = frameOrder.indexOf(frame);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % frameOrder.length;
    else if (event.key === "ArrowLeft")
      next = (current - 1 + frameOrder.length) % frameOrder.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = frameOrder.length - 1;
    else return;
    event.preventDefault();
    const nextFrame = frameOrder[next];
    if (nextFrame !== undefined) {
      onSelect(nextFrame);
      tabs.current.get(nextFrame)?.focus();
    }
  };

  return (
    <div className="frame-tabs" role="tablist" aria-label="PDCAフレーム">
      {frameOrder.map((frame) => (
        <button
          key={frame}
          ref={(element) => {
            if (element !== null) tabs.current.set(frame, element);
          }}
          type="button"
          role="tab"
          id={`tab-${frame}`}
          aria-controls={`panel-${frame}`}
          aria-selected={selected === frame}
          tabIndex={selected === frame ? 0 : -1}
          onClick={() => onSelect(frame)}
          onKeyDown={(event) => onKeyDown(event, frame)}
        >
          <span>{frameCopy[frame].short}</span>
          <small>{frameCopy[frame].name}</small>
        </button>
      ))}
    </div>
  );
}
