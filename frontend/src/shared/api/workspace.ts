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
  type ReviewDate,
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
const goalEnvelopeFor = (goalId: string) =>
  goalEnvelope.refine(({ goal }) => goal.id === goalId, {
    message: "Goal response does not match the requested Goal",
    path: ["goal", "id"],
  });
const cycleEnvelopeFor = (goalId: string, cycleId: string) =>
  cycleEnvelope.refine(
    ({ cycle }) =>
      cycle.id === cycleId &&
      (cycle.goalId === undefined || cycle.goalId === goalId),
    {
      message: "Cycle response does not match the requested Cycle",
      path: ["cycle", "id"],
    },
  );
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
const replanEnvelope = z.object({
  canceledCycle: cycleSchema,
  goal: goalSchema,
  cycle: cycleSchema,
  replayed: z.literal(true).optional(),
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

const sameGoalVersion = (
  left: z.infer<typeof cycleSchema>["goalVersion"],
  right: z.infer<typeof cycleSchema>["goalVersion"],
) =>
  left.id === right.id &&
  left.versionNumber === right.versionNumber &&
  left.body === right.body &&
  (left.createdAt === undefined || right.createdAt === undefined
    ? left.createdAt === right.createdAt
    : Date.parse(left.createdAt) === Date.parse(right.createdAt));

const goalWorkspaceIsCoherent = (goal: z.infer<typeof goalSchema>) => {
  switch (goal.status) {
    case "active_cycle":
      return (
        goal.terminalAt === null &&
        goal.currentWork?.kind === "active_cycle" &&
        goal.nextCycleSequenceNumber ===
          goal.currentWork.cycleSequenceNumber + 1
      );
    case "goal_review":
      return (
        goal.terminalAt === null &&
        goal.currentWork?.kind === "goal_review" &&
        goal.nextCycleSequenceNumber ===
          goal.currentWork.triggerCycleSequenceNumber + 1
      );
    case "achieved":
    case "ended":
      return goal.terminalAt !== null && goal.currentWork === null;
  }
};

const replanEnvelopeFor = (
  goalId: string,
  sourceCycleId: string,
  expectedGoalRevision: number,
  expectedContentRevision: number,
  expectedReviewScheduleRevision: number,
) =>
  replanEnvelope.superRefine((response, context) => {
    const { canceledCycle: source, goal, cycle: successor } = response;
    const addIssue = (path: PropertyKey[]) =>
      context.addIssue({
        code: "custom",
        message: "Cycle replan response is inconsistent",
        path,
      });

    if (goal.id !== goalId) addIssue(["goal", "id"]);
    if (source.id !== sourceCycleId) addIssue(["canceledCycle", "id"]);
    if (source.goalId !== undefined && source.goalId !== goalId)
      addIssue(["canceledCycle", "goalId"]);
    if (successor.goalId !== undefined && successor.goalId !== goalId)
      addIssue(["cycle", "goalId"]);
    if (
      source.status !== "canceled" ||
      source.completedAt !== null ||
      source.canceledAt === null ||
      source.cancellationReason !== "replanned"
    )
      addIssue(["canceledCycle", "status"]);
    if (source.contentRevision !== expectedContentRevision)
      addIssue(["canceledCycle", "contentRevision"]);
    if (source.reviewScheduleRevision !== expectedReviewScheduleRevision)
      addIssue(["canceledCycle", "reviewScheduleRevision"]);
    if (
      successor.id === source.id ||
      successor.sequenceNumber !== source.sequenceNumber + 1
    )
      addIssue(["cycle", "sequenceNumber"]);
    if (!sameGoalVersion(source.goalVersion, successor.goalVersion))
      addIssue(["cycle", "goalVersion"]);
    if (successor.previousCompletedCycleAction !== null)
      addIssue(["cycle", "previousCompletedCycleAction"]);
    if (
      source.canceledAt === null ||
      Date.parse(source.canceledAt) !== Date.parse(successor.startedAt)
    )
      addIssue(["cycle", "startedAt"]);

    switch (successor.status) {
      case "active":
        if (
          successor.completedAt !== null ||
          successor.canceledAt !== null ||
          successor.cancellationReason !== null
        )
          addIssue(["cycle", "status"]);
        break;
      case "completed":
        if (
          successor.completedAt === null ||
          successor.canceledAt !== null ||
          successor.cancellationReason !== null
        )
          addIssue(["cycle", "status"]);
        break;
      case "canceled":
        if (
          successor.completedAt !== null ||
          successor.canceledAt === null ||
          successor.cancellationReason === null
        )
          addIssue(["cycle", "status"]);
        break;
    }

    if (response.replayed === true) {
      if (
        goal.revision < expectedGoalRevision + 1 ||
        !goalWorkspaceIsCoherent(goal)
      )
        addIssue(["goal"]);
      if (successor.status === "active") {
        const currentWork = goal.currentWork;
        if (
          goal.status !== "active_cycle" ||
          goal.terminalAt !== null ||
          !sameGoalVersion(goal.currentVersion, successor.goalVersion) ||
          goal.nextCycleSequenceNumber !== successor.sequenceNumber + 1 ||
          currentWork?.kind !== "active_cycle" ||
          currentWork.cycleId !== successor.id ||
          currentWork.cycleSequenceNumber !== successor.sequenceNumber ||
          currentWork.reviewSchedule.reviewDate !== successor.reviewDate ||
          currentWork.reviewSchedule.reviewScheduleRevision !==
            successor.reviewScheduleRevision
        )
          addIssue(["goal", "currentWork"]);
      } else {
        const terminalIsCurrentActiveCycle =
          goal.currentWork?.kind === "active_cycle" &&
          goal.currentWork.cycleId === successor.id;
        const canceledOutcomeMismatch =
          successor.status === "canceled" &&
          ((successor.cancellationReason === "goal_achieved" &&
            goal.status !== "achieved") ||
            (successor.cancellationReason === "goal_ended" &&
              goal.status !== "ended"));
        const canceledReviewTrigger =
          successor.status === "canceled" &&
          goal.currentWork?.kind === "goal_review" &&
          goal.currentWork.triggerCycleId === successor.id;
        if (
          terminalIsCurrentActiveCycle ||
          canceledOutcomeMismatch ||
          canceledReviewTrigger
        )
          addIssue(["goal", "currentWork"]);
      }
      return;
    }

    if (
      successor.status !== "active" ||
      successor.reviewDate !== null ||
      successor.reviewScheduleRevision !== 0 ||
      successor.plan !== "" ||
      successor.do !== "" ||
      successor.check !== "" ||
      successor.action !== "" ||
      successor.contentRevision !== 0 ||
      Object.values(successor.frameRevisions).some((revision) => revision !== 0)
    )
      addIssue(["cycle"]);

    const currentWork = goal.currentWork;
    if (
      goal.status !== "active_cycle" ||
      goal.revision !== expectedGoalRevision + 1 ||
      goal.terminalAt !== null ||
      !sameGoalVersion(goal.currentVersion, successor.goalVersion) ||
      goal.nextCycleSequenceNumber !== successor.sequenceNumber + 1 ||
      currentWork?.kind !== "active_cycle" ||
      currentWork.cycleId !== successor.id ||
      currentWork.cycleSequenceNumber !== successor.sequenceNumber ||
      currentWork.reviewSchedule.reviewDate !== successor.reviewDate ||
      currentWork.reviewSchedule.reviewScheduleRevision !==
        successor.reviewScheduleRevision
    )
      addIssue(["goal"]);
  });
const reviewSchemaForGoal = (goalId: string) =>
  reviewSchema.refine(({ goal }) => goal.id === goalId, {
    message: "Goal Review response does not match the requested Goal",
    path: ["goal", "id"],
  });

type CommandRequestOptions = {
  readonly operationId: string;
  readonly csrfToken: string;
};

export type ReviewScheduleChange =
  | {
      readonly action: "set";
      readonly reviewDate: ReviewDate;
      readonly expectedReviewScheduleRevision: number;
    }
  | {
      readonly action: "clear";
      readonly expectedReviewScheduleRevision: number;
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
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}`,
    goalEnvelopeFor(goalId),
    { signal },
  );
export const getReview = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/review`,
    reviewSchemaForGoal(goalId),
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
) => {
  const common = {
    operationId: options.operationId,
    outcome,
    expectedGoalRevision,
    expectedState,
  };
  const body =
    expectedState === "active_cycle"
      ? {
          ...common,
          activeCycleId: active?.id,
          expectedCycleContentRevision: active?.revision,
        }
      : { ...common, confirmDiscardReviewDraft: true };
  return requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/termination`,
    terminateEnvelope,
    {
      method: "POST",
      csrfToken: options.csrfToken,
      body,
    },
  );
};
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
    cycleEnvelopeFor(goalId, cycleId),
    {
      signal,
    },
  );
export const changeReviewSchedule = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  cycleId: string,
  change: ReviewScheduleChange,
  csrfToken: string,
  signal?: AbortSignal,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/cycles/${cycleId}/review-schedule`,
    cycleEnvelopeFor(goalId, cycleId),
    {
      method: "PATCH",
      csrfToken,
      signal,
      body: change,
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

export const replanCycle = (
  lease: AuthenticatedRequestLease,
  goalId: string,
  cycleId: string,
  expectedGoalRevision: number,
  expectedContentRevision: number,
  expectedReviewScheduleRevision: number,
  options: CommandRequestOptions,
) =>
  requestAuthenticatedJSON(
    lease,
    `/api/v1/goals/${goalId}/cycles/${cycleId}/replan`,
    replanEnvelopeFor(
      goalId,
      cycleId,
      expectedGoalRevision,
      expectedContentRevision,
      expectedReviewScheduleRevision,
    ),
    {
      method: "POST",
      csrfToken: options.csrfToken,
      body: {
        operationId: options.operationId,
        expectedGoalRevision,
        expectedContentRevision,
        expectedReviewScheduleRevision,
        confirmed: true,
      },
    },
  );
