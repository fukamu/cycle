import {
  activeCycleSchema,
  completedDetailSchema,
  completedListSchema,
  completeCycleSchema,
  saveFrameSchema,
  type Frame,
} from "./schemas";
import { requestJSON } from "./client";

export function getActiveCycle(signal?: AbortSignal) {
  return requestJSON("/api/v1/cycles/active", activeCycleSchema, { signal });
}

export function saveFrame(
  cycleId: string,
  frame: Frame,
  content: string,
  expectedFrameRevision: number,
  csrfToken: string,
  signal?: AbortSignal,
) {
  return requestJSON(
    `/api/v1/cycles/${cycleId}/frames/${frame}`,
    saveFrameSchema,
    {
      method: "PATCH",
      body: { content, expectedFrameRevision },
      csrfToken,
      signal,
    },
  );
}

export function completeCycle(
  cycleId: string,
  operationId: string,
  expectedContentRevision: number,
  csrfToken: string,
) {
  return requestJSON(
    `/api/v1/cycles/${cycleId}/complete`,
    completeCycleSchema,
    {
      method: "POST",
      body: { operationId, expectedContentRevision },
      csrfToken,
    },
  );
}

export function listCompletedCycles(
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const parameters = new URLSearchParams({ status: "completed", limit: "20" });
  if (cursor !== undefined) {
    parameters.set("cursor", cursor);
  }
  return requestJSON(
    `/api/v1/cycles?${parameters.toString()}`,
    completedListSchema,
    { signal },
  );
}

export function getCompletedCycle(cycleId: string, signal?: AbortSignal) {
  return requestJSON(`/api/v1/cycles/${cycleId}`, completedDetailSchema, {
    signal,
  });
}
