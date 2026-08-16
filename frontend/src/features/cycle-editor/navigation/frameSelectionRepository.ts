import type { Frame } from "../../../shared/api/schemas";

const storageKey = "pdcai:selected-frame:v1";
const defaultFrame: Frame = "plan";
const frames: readonly Frame[] = ["plan", "do", "check", "action"];

type StoredFrameSelection = {
  readonly cycleId: string;
  readonly frame: Frame;
};

export function readFrameSelection(cycleId: string): Frame {
  try {
    const serialized = window.localStorage.getItem(storageKey);
    if (serialized === null) return defaultFrame;

    const value = JSON.parse(serialized) as Partial<StoredFrameSelection>;
    if (value.cycleId === cycleId && isFrame(value.frame)) {
      return value.frame;
    }

    window.localStorage.removeItem(storageKey);
  } catch {
    // Storage can be unavailable or contain data from an older implementation.
  }
  return defaultFrame;
}

export function writeFrameSelection(cycleId: string, frame: Frame): void {
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ cycleId, frame } satisfies StoredFrameSelection),
    );
  } catch {
    // Tab navigation must continue even when browser storage is unavailable.
  }
}

function isFrame(value: unknown): value is Frame {
  return frames.some((frame) => frame === value);
}
