import type { Frame } from "../../../shared/api/schemas";
import {
  codePointCount as countCodePoints,
  hasNonWhitespace,
} from "../../../shared/text/semantics";

export type SaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "dirty"; readonly dirtyFrames: readonly Frame[] }
  | {
      readonly kind: "saving";
      readonly inFlightFrame: Frame;
      readonly dirtyFrames: readonly Frame[];
    }
  | {
      readonly kind: "failed";
      readonly failedFrame: Frame;
      readonly dirtyFrames: readonly Frame[];
      readonly errorCode: string;
    };

export type AIState =
  | { readonly kind: "idle" }
  | { readonly kind: "generating"; readonly generationId?: string }
  | { readonly kind: "refining"; readonly generationId?: string };

export type FrameValues = Readonly<Record<Frame, string>>;

export function codePointCount(value: string): number {
  return countCodePoints(value);
}

export function isNonBlank(value: string): boolean {
  return hasNonWhitespace(value);
}

export function canGenerate(
  values: FrameValues,
  saveState: SaveState,
  aiState: AIState,
): boolean {
  return (
    [values.plan, values.do, values.check].every(isNonBlank) &&
    saveState.kind === "saved" &&
    aiState.kind === "idle"
  );
}

export function canRefine(
  values: FrameValues,
  saveState: SaveState,
  aiState: AIState,
): boolean {
  return canGenerate(values, saveState, aiState) && isNonBlank(values.action);
}

export function canComplete(
  values: FrameValues,
  saveState: SaveState,
  aiState: AIState,
): boolean {
  return canRefine(values, saveState, aiState);
}

export function disabledReason(
  values: FrameValues,
  saveState: SaveState,
  aiState: AIState,
): string | null {
  if (![values.plan, values.do, values.check].every(isNonBlank)) {
    return "P/D/Cを入力してください。";
  }
  if (saveState.kind !== "saved") {
    return saveState.kind === "failed"
      ? "保存に失敗しています。再試行してください。"
      : "保存が完了するまでお待ちください。";
  }
  if (aiState.kind !== "idle") {
    return "AI処理が完了するまでお待ちください。";
  }
  if (!isNonBlank(values.action)) {
    return "Aを入力してください。";
  }
  return null;
}
