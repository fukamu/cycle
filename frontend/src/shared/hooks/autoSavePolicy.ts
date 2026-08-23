import { APIError } from "../api/client";

export const autoSaveDebounceMs = 800;
export const browserDraftDebounceMs = 150;
export const maxAutoSaveRetries = 5;

const retryBackoffMs = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export function autoSaveRetryDelay(
  retryNumber: number,
  random: () => number = Math.random,
): number {
  const index = Math.max(0, retryNumber - 1);
  const baseDelay =
    index < retryBackoffMs.length ? retryBackoffMs[index]! : 30_000;
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.round(baseDelay * jitter);
}

export function isRetryableAutoSaveError(error: unknown): boolean {
  if (error instanceof APIError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}
