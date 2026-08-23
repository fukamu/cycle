import { z } from "zod";

import { requestJSON } from "./client";
import {
  aiResponseSchema,
  cyclePageSchema,
  cycleSchema,
  currentWorkSchema,
  draftSchema,
  goalRefineResponseSchema,
  goalPageSchema,
  goalSchema,
  homeSchema,
  reviewSchema,
  saveFrameSchema,
  type Frame,
} from "./schemas";

const draftEnvelope = z.object({ draft: draftSchema });
const reviewDraftEnvelope = z.object({ reviewDraft: draftSchema });
const adoptedDraftEnvelope = draftEnvelope.extend({
  replayed: z.boolean().optional(),
});
const adoptedReviewDraftEnvelope = reviewDraftEnvelope.extend({
  replayed: z.boolean().optional(),
});
const goalEnvelope = z.object({ goal: goalSchema });
const cycleEnvelope = z.object({ cycle: cycleSchema });
const startEnvelope = z.object({
  goal: goalSchema,
  cycle: cycleSchema,
  replayed: z.boolean().optional(),
});
const completeEnvelope = z.object({
  completedCycle: cycleSchema,
  goal: goalSchema,
  reviewDraft: draftSchema,
  replayed: z.boolean().optional(),
});
const commandReplayEnvelope = z.object({
  replayed: z.literal(true),
  operation: z.string(),
  resourceIds: z.object({
    goalId: z.string().uuid(),
    cycleId: z.string().uuid().optional(),
  }),
  currentGoalState: z.enum([
    "active_cycle",
    "goal_review",
    "achieved",
    "ended",
  ]),
  currentWorkspace: currentWorkSchema.nullable(),
});
const continueEnvelope = z.object({
  goal: goalSchema,
  versionCreated: z.boolean(),
  cycle: cycleSchema,
  replayed: z.boolean().optional(),
});
const terminateEnvelope = z.object({
  goal: goalSchema,
  canceledCycle: cycleSchema.nullable(),
  replayed: z.boolean().optional(),
});

export type CommandRequestOptions = {
  readonly operationId: string;
  readonly csrfToken: string;
};

export const getHome = () => requestJSON("/api/v1/home", homeSchema);
export const createGoalDraft = (initialBody: string, csrfToken: string) =>
  requestJSON("/api/v1/goal-drafts", draftEnvelope, {
    method: "POST",
    csrfToken,
    body: { initialBody },
  });
export const getGoalDraft = (draftId: string) =>
  requestJSON(`/api/v1/goal-drafts/${draftId}`, draftEnvelope);
export const saveGoalDraft = (
  draftId: string,
  body: string,
  expectedRevision: number,
  csrfToken: string,
) =>
  requestJSON(`/api/v1/goal-drafts/${draftId}`, draftEnvelope, {
    method: "PATCH",
    csrfToken,
    body: { body, expectedRevision },
  });
export const discardGoalDraft = (draftId: string, csrfToken: string) =>
  requestJSON(`/api/v1/goal-drafts/${draftId}`, z.undefined(), {
    method: "DELETE",
    csrfToken,
  });
export const refineGoalDraft = (
  draftId: string,
  expectedDraftRevision: number,
  options: CommandRequestOptions,
) =>
  requestJSON(
    `/api/v1/goal-drafts/${draftId}/refinements`,
    goalRefineResponseSchema,
    {
      method: "POST",
      csrfToken: options.csrfToken,
      idempotencyKey: options.operationId,
      body: { expectedDraftRevision },
    },
  );
export const adoptGoalDraft = (
  draftId: string,
  generationId: string,
  expectedDraftRevision: number,
  csrfToken: string,
) =>
  requestJSON(
    `/api/v1/goal-drafts/${draftId}/refinements/${generationId}/adopt`,
    adoptedDraftEnvelope,
    {
      method: "POST",
      csrfToken,
      body: { expectedDraftRevision },
    },
  );
export const startGoal = (
  draftId: string,
  expectedDraftRevision: number,
  options: CommandRequestOptions,
) =>
  requestJSON(`/api/v1/goal-drafts/${draftId}/start`, startEnvelope, {
    method: "POST",
    csrfToken: options.csrfToken,
    body: { operationId: options.operationId, expectedDraftRevision },
  });

export const listGoals = (scope = "all", cursor?: string) => {
  const query = new URLSearchParams({ scope, limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return requestJSON(`/api/v1/goals?${query}`, goalPageSchema);
};
export const getGoal = (goalId: string) =>
  requestJSON(`/api/v1/goals/${goalId}`, goalEnvelope);
export const getReview = (goalId: string) =>
  requestJSON(`/api/v1/goals/${goalId}/review`, reviewSchema);
export const saveReview = (
  goalId: string,
  expectedReviewDraftId: string,
  body: string,
  expectedRevision: number,
  csrfToken: string,
) =>
  requestJSON(`/api/v1/goals/${goalId}/review`, reviewDraftEnvelope, {
    method: "PATCH",
    csrfToken,
    body: { body, expectedReviewDraftId, expectedRevision },
  });
export const refineReview = (
  goalId: string,
  expectedDraftRevision: number,
  expectedGoalRevision: number,
  options: CommandRequestOptions,
) =>
  requestJSON(
    `/api/v1/goals/${goalId}/review/refinements`,
    goalRefineResponseSchema,
    {
      method: "POST",
      csrfToken: options.csrfToken,
      idempotencyKey: options.operationId,
      body: { expectedDraftRevision, expectedGoalRevision },
    },
  );
export const adoptReview = (
  goalId: string,
  generationId: string,
  expectedDraftRevision: number,
  expectedGoalRevision: number,
  csrfToken: string,
) =>
  requestJSON(
    `/api/v1/goals/${goalId}/review/refinements/${generationId}/adopt`,
    adoptedReviewDraftEnvelope,
    {
      method: "POST",
      csrfToken,
      body: { expectedDraftRevision, expectedGoalRevision },
    },
  );
export const continueReview = (
  goalId: string,
  expectedGoalRevision: number,
  expectedDraftRevision: number,
  options: CommandRequestOptions,
) =>
  requestJSON(`/api/v1/goals/${goalId}/review/continue`, continueEnvelope, {
    method: "POST",
    csrfToken: options.csrfToken,
    body: {
      operationId: options.operationId,
      expectedGoalRevision,
      expectedDraftRevision,
    },
  });
export const terminateGoal = (
  goalId: string,
  outcome: "achieved" | "ended",
  expectedGoalRevision: number,
  expectedState: "active_cycle" | "goal_review",
  options: CommandRequestOptions,
  active?: { id: string; revision: number },
) =>
  requestJSON(`/api/v1/goals/${goalId}/termination`, terminateEnvelope, {
    method: "POST",
    csrfToken: options.csrfToken,
    body: {
      operationId: options.operationId,
      outcome,
      expectedGoalRevision,
      expectedState,
      activeCycleId: active?.id,
      expectedCycleContentRevision: active?.revision,
      confirmDiscardReviewDraft: expectedState === "goal_review",
    },
  });
export const deleteGoal = (
  goalId: string,
  expectedGoalRevision: number,
  options: CommandRequestOptions,
) =>
  requestJSON(`/api/v1/goals/${goalId}`, z.undefined(), {
    method: "DELETE",
    csrfToken: options.csrfToken,
    idempotencyKey: options.operationId,
    body: { confirmed: true, expectedGoalRevision },
  });

export const listCycles = (goalId: string, cursor?: string) => {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return requestJSON(
    `/api/v1/goals/${goalId}/cycles?${query}`,
    cyclePageSchema,
  );
};
export const getCycle = (goalId: string, cycleId: string) =>
  requestJSON(`/api/v1/goals/${goalId}/cycles/${cycleId}`, cycleEnvelope);
export const saveCycleFrame = (
  goalId: string,
  cycleId: string,
  frame: Frame,
  content: string,
  expectedFrameRevision: number,
  csrfToken: string,
) =>
  requestJSON(
    `/api/v1/goals/${goalId}/cycles/${cycleId}/frames/${frame}`,
    saveFrameSchema,
    {
      method: "PATCH",
      csrfToken,
      body: { content, expectedFrameRevision },
    },
  );
export const generateAction = (
  goalId: string,
  cycleId: string,
  expectedContentRevision: number,
  confirmReplace: boolean,
  options: CommandRequestOptions,
) =>
  requestJSON(
    `/api/v1/goals/${goalId}/cycles/${cycleId}/actions/generate`,
    aiResponseSchema,
    {
      method: "POST",
      csrfToken: options.csrfToken,
      idempotencyKey: options.operationId,
      body: { expectedContentRevision, confirmReplace },
    },
  );
export const refineAction = (
  goalId: string,
  cycleId: string,
  expectedContentRevision: number,
  options: CommandRequestOptions,
) =>
  requestJSON(
    `/api/v1/goals/${goalId}/cycles/${cycleId}/actions/refine`,
    aiResponseSchema,
    {
      method: "POST",
      csrfToken: options.csrfToken,
      idempotencyKey: options.operationId,
      body: { expectedContentRevision },
    },
  );
export const completeCycle = (
  goalId: string,
  cycleId: string,
  expectedGoalRevision: number,
  expectedContentRevision: number,
  options: CommandRequestOptions,
) =>
  requestJSON(
    `/api/v1/goals/${goalId}/cycles/${cycleId}/complete`,
    z.union([completeEnvelope, commandReplayEnvelope]),
    {
      method: "POST",
      csrfToken: options.csrfToken,
      body: {
        operationId: options.operationId,
        expectedGoalRevision,
        expectedContentRevision,
      },
    },
  );
