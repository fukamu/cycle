import { useCallback, useEffect, useRef, useState } from "react";

import { APIError } from "../../../shared/api/client";
import { saveFrame } from "../../../shared/api/cycles";
import type {
  ActiveCycle,
  Frame,
  SaveFrameResponse,
} from "../../../shared/api/schemas";
import {
  deleteDraft,
  putDraft,
  type DraftRecord,
} from "../draft/draftRepository";
import type { SaveState } from "../model/eligibility";

const apiDebounceMilliseconds = 800;
const draftDebounceMilliseconds = 150;
const maxAutomaticRetries = 5;

type PendingFrame = {
  readonly content: string;
  readonly baseFrameRevision: number;
};

type UseAutoSaveInput = {
  readonly userId: string;
  readonly cycle: ActiveCycle;
  readonly csrfToken: string;
  readonly initialDrafts: readonly DraftRecord[];
  readonly onSaved: (response: SaveFrameResponse) => void;
};

export type AutoSaveController = {
  readonly saveState: SaveState;
  readonly change: (frame: Frame, content: string) => void;
  readonly flush: () => void;
  readonly retry: () => void;
  readonly synchronizeFrame: (
    frame: Frame,
    content: string,
    frameRevision: number,
    contentRevision: number,
  ) => void;
};

export function useAutoSave(input: UseAutoSaveInput): AutoSaveController {
  const matchingDrafts = input.initialDrafts.filter(
    (draft) =>
      draft.baseFrameRevision === input.cycle.frameRevisions[draft.frame],
  );
  const conflictingDraft = input.initialDrafts.find(
    (draft) =>
      draft.baseFrameRevision !== input.cycle.frameRevisions[draft.frame],
  );
  const queue = useRef(
    new Map<Frame, PendingFrame>(
      matchingDrafts.map((draft) => [draft.frame, draft]),
    ),
  );
  const revisions = useRef({ ...input.cycle.frameRevisions });
  const serverContents = useRef<Record<Frame, string>>({
    plan: input.cycle.plan,
    do: input.cycle.do,
    check: input.cycle.check,
    action: input.cycle.action,
  });
  const contentRevision = useRef(input.cycle.contentRevision);
  const inFlight = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const draftTimers = useRef(new Map<Frame, ReturnType<typeof setTimeout>>());
  const retryCount = useRef(0);
  const mounted = useRef(true);
  const pumpRef = useRef<() => Promise<void>>(async () => undefined);
  const [saveState, setSaveState] = useState<SaveState>(() => {
    if (conflictingDraft !== undefined) {
      return {
        kind: "failed",
        failedFrame: conflictingDraft.frame,
        dirtyFrames: [conflictingDraft.frame],
        errorCode: "CYCLE_REVISION_CONFLICT",
      };
    }
    return matchingDrafts.length === 0
      ? { kind: "saved" }
      : {
          kind: "dirty",
          dirtyFrames: matchingDrafts.map((draft) => draft.frame),
        };
  });

  const persistPendingDraft = useCallback(
    (frame: Frame, pending: PendingFrame) => {
      const currentTimer = draftTimers.current.get(frame);
      if (currentTimer !== undefined) {
        clearTimeout(currentTimer);
      }
      const timer = setTimeout(() => {
        void putDraft({
          userId: input.userId,
          cycleId: input.cycle.id,
          frame,
          content: pending.content,
          baseFrameRevision: pending.baseFrameRevision,
          updatedAt: new Date().toISOString(),
        });
        draftTimers.current.delete(frame);
      }, draftDebounceMilliseconds);
      draftTimers.current.set(frame, timer);
    },
    [input.cycle.id, input.userId],
  );

  const schedulePump = useCallback((delay = apiDebounceMilliseconds) => {
    if (debounceTimer.current !== undefined) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => void pumpRef.current(), delay);
  }, []);

  const pump = useCallback(async () => {
    if (inFlight.current || queue.current.size === 0) {
      if (!inFlight.current && queue.current.size === 0 && mounted.current) {
        setSaveState({ kind: "saved" });
      }
      return;
    }
    const next = queue.current.entries().next().value as
      | [Frame, PendingFrame]
      | undefined;
    if (next === undefined) {
      return;
    }
    const [frame, snapshot] = next;
    queue.current.delete(frame);
    inFlight.current = true;
    if (mounted.current) {
      setSaveState({
        kind: "saving",
        inFlightFrame: frame,
        dirtyFrames: [...queue.current.keys()],
      });
    }
    try {
      const response = await saveFrame(
        input.cycle.id,
        frame,
        snapshot.content,
        snapshot.baseFrameRevision,
        input.csrfToken,
      );
      revisions.current[frame] = response.frameRevision;
      contentRevision.current = response.contentRevision;
      serverContents.current[frame] = response.content;
      retryCount.current = 0;
      const newer = queue.current.get(frame);
      if (newer === undefined) {
        await deleteDraft(input.userId, input.cycle.id, frame);
      } else {
        const rebased = { ...newer, baseFrameRevision: response.frameRevision };
        queue.current.set(frame, rebased);
        persistPendingDraft(frame, rebased);
      }
      if (mounted.current) {
        input.onSaved(response);
      }
    } catch (error) {
      if (!queue.current.has(frame)) {
        queue.current.set(frame, snapshot);
      }
      const pending = queue.current.get(frame) ?? snapshot;
      persistPendingDraft(frame, pending);
      const errorCode =
        error instanceof APIError ? error.code : "NETWORK_ERROR";
      if (mounted.current) {
        setSaveState({
          kind: "failed",
          failedFrame: frame,
          dirtyFrames: [...queue.current.keys()],
          errorCode,
        });
      }
      if (isRetryable(error) && retryCount.current < maxAutomaticRetries) {
        retryCount.current += 1;
        retryTimer.current = setTimeout(
          () => void pumpRef.current(),
          retryDelay(retryCount.current),
        );
      }
      return;
    } finally {
      inFlight.current = false;
    }
    await pumpRef.current();
  }, [input, persistPendingDraft]);
  pumpRef.current = pump;

  useEffect(() => {
    mounted.current = true;
    const timers = draftTimers.current;
    if (matchingDrafts.length > 0) {
      schedulePump();
    }
    return () => {
      mounted.current = false;
      if (debounceTimer.current !== undefined)
        clearTimeout(debounceTimer.current);
      if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [matchingDrafts.length, schedulePump]);

  const change = useCallback(
    (frame: Frame, content: string) => {
      if (content === serverContents.current[frame] && !inFlight.current) {
        queue.current.delete(frame);
        void deleteDraft(input.userId, input.cycle.id, frame);
      } else {
        const pending = {
          content,
          baseFrameRevision: revisions.current[frame],
        };
        queue.current.set(frame, pending);
        persistPendingDraft(frame, pending);
      }
      retryCount.current = 0;
      setSaveState(
        queue.current.size === 0
          ? { kind: "saved" }
          : { kind: "dirty", dirtyFrames: [...queue.current.keys()] },
      );
      schedulePump();
    },
    [input.cycle.id, input.userId, persistPendingDraft, schedulePump],
  );

  const flush = useCallback(() => {
    if (debounceTimer.current !== undefined) {
      clearTimeout(debounceTimer.current);
    }
    void pumpRef.current();
  }, []);

  const retry = useCallback(() => {
    retryCount.current = 0;
    if (queue.current.size > 0) {
      setSaveState({ kind: "dirty", dirtyFrames: [...queue.current.keys()] });
      void pumpRef.current();
    }
  }, []);

  const synchronizeFrame = useCallback(
    (
      frame: Frame,
      content: string,
      frameRevision: number,
      nextContentRevision: number,
    ) => {
      revisions.current[frame] = frameRevision;
      contentRevision.current = nextContentRevision;
      serverContents.current[frame] = content;
      queue.current.delete(frame);
      void deleteDraft(input.userId, input.cycle.id, frame);
      setSaveState(
        queue.current.size === 0
          ? { kind: "saved" }
          : { kind: "dirty", dirtyFrames: [...queue.current.keys()] },
      );
    },
    [input.cycle.id, input.userId],
  );

  return { saveState, change, flush, retry, synchronizeFrame };
}

export function retryDelay(attempt: number, random = Math.random): number {
  const seconds = Math.min(30, 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + random() * 0.4;
  return Math.round(seconds * 1000 * jitter);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof APIError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}
