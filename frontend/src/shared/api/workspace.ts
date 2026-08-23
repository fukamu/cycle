import { z } from "zod";

import {
  requestAuthenticatedJSON,
  type AuthenticatedRequestLease,
} from "./client";
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

export const getHome = (
  lease: AuthenticatedRequestLease,
  signal?: AbortSignal,
) => requestAuthenticatedJSON(lease, "/api/v1/home", homeSchema, { signal });
export const createGoalDraft = (
  lease: AuthenticatedRequestLease,
  initialBody: string,
  csrfToken: string,
) =>
  requestAuthenticatedJSON(lease, "/api/v1/goal-drafts", draftEnvelope, {
    method: "POST",
    csrfToken,
    body: { initialBody },
  });
export const getGoalDraft = (
  lease: AuthenticatedRequestLease,
  draftId: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goal-drafts/${draftId}`,
    draftEnvelope,
    { signal },
  );
export const saveGoalDraft = (
  lease: AuthenticatedRequestLease,
  draftId: string,
  body: string,
  expectedRevision: number,
  csrfToken: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goal-drafts/${draftId}`,
    draftEnvelope,
    {
      method: "PATCH",
      csrfToken,
      signal,
      body: { body, expectedRevision },
    },
  );
export const discardGoalDraft = (
  lease: AuthenticatedRequestLease,
  draftId: string,
  csrfToken: string,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goal-drafts/${draftId}`,
    z.undefined(),
    {
      method: "DELETE",
      csrfToken,
    },
  );
export const refineGoalDraft = (
  lease: AuthenticatedRequestLease,
  draftId: string,
  expectedDraftRevision: number,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(
    lease,
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
  lease: AuthenticatedRequestLease,
  draftId: string,
  generationId: string,
  expectedDraftRevision: number,
  csrfToken: string,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goal-drafts/${draftId}/refinements/${generationId}/adopt`,
    adoptedDraftEnvelope,
    {
      method: "POST",
      csrfToken,
      body: { expectedDraftRevision },
    },
  );
export const startGoal = (
  lease: AuthenticatedRequestLease,
  draftId: string,
  expectedDraftRevision: number,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goal-drafts/${draftId}/start`,
    startEnvelope,
    {
      method: "POST",
      csrfToken: options.csrfToken,
      body: { operationId: options.operationId, expectedDraftRevision },
    },
  );

export const listGoals = (
  lease: AuthenticatedRequestLease,
  scope = "all",
  cursor?: string,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({ scope, limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return requestAuthenticatedJSON(
    lease,
    `/api/v1/goals?${query}`,
    goalPageSchema,
    { signal },
  );
};
export const getGoal = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(lease, `/api/v1/goals/${goalId}`, goalEnvelope, {
    signal,
  });
export const getReview = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/review`,
    reviewSchema,
    {
      signal,
    },
  );
export const saveReview = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  expectedReviewDraftId: string,
  body: string,
  expectedRevision: number,
  csrfToken: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/review`,
    reviewDraftEnvelope,
    {
      method: "PATCH",
      csrfToken,
      signal,
      body: { body, expectedReviewDraftId, expectedRevision },
    },
  );
export const refineReview = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  expectedDraftRevision: number,
  expectedGoalRevision: number,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(
    lease,
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
  lease: AuthenticatedRequestLease,
  goalId: string,
  generationId: string,
  expectedDraftRevision: number,
  expectedGoalRevision: number,
  csrfToken: string,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/review/refinements/${generationId}/adopt`,
    adoptedReviewDraftEnvelope,
    {
      method: "POST",
      csrfToken,
      body: { expectedDraftRevision, expectedGoalRevision },
    },
  );
export const continueReview = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  expectedGoalRevision: number,
  expectedDraftRevision: number,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/review/continue`,
    continueEnvelope,
    {
      method: "POST",
      csrfToken: options.csrfToken,
      body: {
        operationId: options.operationId,
        expectedGoalRevision,
        expectedDraftRevision,
      },
    },
  );
export const terminateGoal = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  outcome: "achieved" | "ended",
  expectedGoalRevision: number,
  expectedState: "active_cycle" | "goal_review",
  options: CommandRequestOptions,
  active?: { id: string; revision: number },
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/termination`,
    terminateEnvelope,
    {
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
    },
  );
export const deleteGoal = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  expectedGoalRevision: number,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(lease, `/api/v1/goals/${goalId}`, z.undefined(), {
    method: "DELETE",
    csrfToken: options.csrfToken,
    idempotencyKey: options.operationId,
    body: { confirmed: true, expectedGoalRevision },
  });

export const listCycles = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  cursor?: string,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/cycles?${query}`,
    cyclePageSchema,
    { signal },
  );
};
export const getCycle = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  cycleId: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/cycles/${cycleId}`,
    cycleEnvelope,
    {
      signal,
    },
  );
export const saveCycleFrame = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  cycleId: string,
  frame: Frame,
  content: string,
  expectedFrameRevision: number,
  csrfToken: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/cycles/${cycleId}/frames/${frame}`,
    saveFrameSchema,
    {
      method: "PATCH",
      csrfToken,
      signal,
      body: { content, expectedFrameRevision },
    },
  );
export const generateAction = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  cycleId: string,
  expectedContentRevision: number,
  confirmReplace: boolean,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(
    lease,
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
  lease: AuthenticatedRequestLease,
  goalId: string,
  cycleId: string,
  expectedContentRevision: number,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(
    lease,
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
  lease: AuthenticatedRequestLease,
  goalId: string,
  cycleId: string,
  expectedGoalRevision: number,
  expectedContentRevision: number,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(
    lease,
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
