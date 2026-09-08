import type { Cycle, Frame } from "../api/schemas";
import { isUUIDv7 } from "../id/uuid";

const selectedFramePreferencePrefix = "fukamu-cycle-selected-frame-v1:";
const frames: readonly Frame[] = ["plan", "do", "check", "action"];

export type SelectedFramePreferenceStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

function getStorage(
  storage?: SelectedFramePreferenceStorage,
): SelectedFramePreferenceStorage | undefined {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

function isFrame(value: unknown): value is Frame {
  return typeof value === "string" && frames.includes(value as Frame);
}

function preferenceKey(cycleId: string): string {
  return selectedFramePreferencePrefix + cycleId;
}

export function readSelectedCycleFrame(
  cycleId: string,
  status: Cycle["status"],
  storage?: SelectedFramePreferenceStorage,
): Frame {
  if (!isUUIDv7(cycleId)) return "plan";
  if (status !== "active") {
    forgetSelectedCycleFrame(cycleId, storage);
    return "plan";
  }
  try {
    const frame = getStorage(storage)?.getItem(preferenceKey(cycleId));
    return isFrame(frame) ? frame : "plan";
  } catch {
    return "plan";
  }
}

export function rememberSelectedCycleFrame(
  cycleId: string,
  frame: Frame,
  storage?: SelectedFramePreferenceStorage,
): void {
  if (!isUUIDv7(cycleId)) return;
  try {
    getStorage(storage)?.setItem(preferenceKey(cycleId), frame);
  } catch {
    // This preference must never prevent Frame navigation.
  }
}

export function forgetSelectedCycleFrame(
  cycleId: string,
  storage?: SelectedFramePreferenceStorage,
): void {
  if (!isUUIDv7(cycleId)) return;
  try {
    getStorage(storage)?.removeItem(preferenceKey(cycleId));
  } catch {
    // Unavailable storage must not block a committed lifecycle transition.
  }
}

export function forgetSelectedCycleFrameFromWorkspacePath(
  pathname: string,
  storage?: SelectedFramePreferenceStorage,
): void {
  const match = /^\/goals\/[^/]+\/cycles\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1]) forgetSelectedCycleFrame(match[1], storage);
}

export function clearSelectedCycleFrames(
  storage?: SelectedFramePreferenceStorage,
): void {
  removeSelectedCycleFrameKeys(() => true, storage);
}

export function reconcileSelectedCycleFrames(
  activeCycleIds: Iterable<string>,
  storage?: SelectedFramePreferenceStorage,
): void {
  const active = new Set([...activeCycleIds].filter(isUUIDv7));
  removeSelectedCycleFrameKeys((key) => {
    const cycleId = key.slice(selectedFramePreferencePrefix.length);
    return !isUUIDv7(cycleId) || !active.has(cycleId);
  }, storage);
}

function removeSelectedCycleFrameKeys(
  shouldRemove: (key: string) => boolean,
  storage?: SelectedFramePreferenceStorage,
): void {
  try {
    const target = getStorage(storage);
    if (!target) return;
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key?.startsWith(selectedFramePreferencePrefix)) keys.push(key);
    }
    for (const key of keys) {
      if (!shouldRemove(key)) continue;
      try {
        target.removeItem(key);
      } catch {
        // Continue removing other keys when one storage operation fails.
      }
    }
  } catch {
    // Enumeration failure leaves preferences unused or reconciled later.
  }
}
