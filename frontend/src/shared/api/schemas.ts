import { z } from "zod";

import { UUID_V7_PATTERN } from "../id/uuid";
import { isValidLocalDate } from "../date/localDate";
import { isValidCSRFToken } from "./csrfToken";
import { stableAPIErrorCodeSchema } from "./errorCodes";
import {
  CYCLE_SUMMARY_PREVIEW_MAX_CODE_POINTS,
  FRAME_TEXT_MAX_CODE_POINTS,
  GOAL_TEXT_MAX_CODE_POINTS,
  codePointCount,
  hasNoNUL,
  hasNonWhitespace,
  isWithinCodePointLimit,
  normalizeLineEndings,
} from "../text/semantics";

const uuid = z.string().regex(UUID_V7_PATTERN);
const instant = z.string().datetime({ offset: true });
const boundedTextSchema = (maximumCodePoints: number) =>
  z
    .string()
    .transform(normalizeLineEndings)
    .refine(hasNoNUL)
    .refine((value) => isWithinCodePointLimit(value, maximumCodePoints));
const goalTextSchema = boundedTextSchema(GOAL_TEXT_MAX_CODE_POINTS);
const frameTextSchema = boundedTextSchema(FRAME_TEXT_MAX_CODE_POINTS);
const cycleSummaryPreviewTextSchema = boundedTextSchema(
  CYCLE_SUMMARY_PREVIEW_MAX_CODE_POINTS,
);
const cycleFramePreviewSchema = z
  .object({
    text: cycleSummaryPreviewTextSchema,
    truncated: z.boolean(),
  })
  .superRefine((preview, context) => {
    if (
      preview.truncated &&
      codePointCount(preview.text) !== CYCLE_SUMMARY_PREVIEW_MAX_CODE_POINTS
    )
      context.addIssue({
        code: "custom",
        message: "A truncated Cycle preview must fill the bounded summary",
        path: ["text"],
      });
  });
const cycleLearningPreviewSchema = z.object({
  check: cycleFramePreviewSchema,
  action: cycleFramePreviewSchema,
});

export const frameSchema = z.enum(["plan", "do", "check", "action"]);
export type Frame = z.infer<typeof frameSchema>;
export const goalStatusSchema = z.enum([
  "active_cycle",
  "goal_review",
  "achieved",
  "ended",
]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export const sessionSchema = z.object({
  user: z.object({
    id: uuid,
    googleConnected: z.boolean(),
    googleEmail: z.string().min(1).nullable(),
  }),
  csrfToken: z.string().refine(isValidCSRFToken),
});
export type Session = z.infer<typeof sessionSchema>;

export const goalVersionSchema = z.object({
  id: uuid,
  versionNumber: z.number().int().positive(),
  body: goalTextSchema,
  createdAt: instant.optional(),
});
export type GoalVersion = z.infer<typeof goalVersionSchema>;

export const draftSchema = z.object({
  id: uuid,
  draftType: z.enum(["creation", "review"]),
  goalId: uuid.optional(),
  baseGoalVersionId: uuid.optional(),
  reviewCycleId: uuid.optional(),
  body: goalTextSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: instant,
});
export type GoalDraft = z.infer<typeof draftSchema>;

const frameRevisionsSchema = z.object({
  plan: z.number().int().nonnegative(),
  do: z.number().int().nonnegative(),
  check: z.number().int().nonnegative(),
  action: z.number().int().nonnegative(),
});

export const reviewDateSchema = z.string().refine(isValidLocalDate);
export type ReviewDate = z.infer<typeof reviewDateSchema>;

export const reviewScheduleSchema = z
  .object({
    reviewDate: reviewDateSchema.nullable(),
    reviewScheduleRevision: z.number().int().nonnegative(),
  })
  .superRefine((schedule, context) => {
    if (schedule.reviewDate !== null && schedule.reviewScheduleRevision === 0)
      context.addIssue({
        code: "custom",
        message: "A configured review date requires a positive revision",
        path: ["reviewScheduleRevision"],
      });
  });
export type ReviewSchedule = z.infer<typeof reviewScheduleSchema>;

const previousCompletedCycleActionSchema = z.object({
  cycleId: uuid,
  cycleSequenceNumber: z.number().int().positive(),
  goalVersionNumber: z.number().int().positive(),
  action: frameTextSchema.refine(hasNonWhitespace),
});

const cancellationReasonSchema = z.enum([
  "goal_achieved",
  "goal_ended",
  "replanned",
]);

const cycleSummaryCancellationReasonSchema = z.enum([
  "goal_achieved",
  "goal_ended",
  "replanned",
]);

export const cycleSchema = z
  .object({
    id: uuid,
    goalId: uuid.optional(),
    sequenceNumber: z.number().int().positive(),
    status: z.enum(["active", "completed", "canceled"]),
    goalVersion: goalVersionSchema,
    previousCompletedCycleAction: previousCompletedCycleActionSchema.nullable(),
    reviewDate: reviewDateSchema.nullable(),
    reviewScheduleRevision: z.number().int().nonnegative(),
    startedAt: instant,
    completedAt: instant.nullable(),
    canceledAt: instant.nullable(),
    cancellationReason: cancellationReasonSchema.nullable(),
    plan: frameTextSchema,
    do: frameTextSchema,
    check: frameTextSchema,
    action: frameTextSchema,
    contentRevision: z.number().int().nonnegative(),
    frameRevisions: frameRevisionsSchema,
  })
  .superRefine((cycle, context) => {
    if (cycle.reviewDate !== null && cycle.reviewScheduleRevision === 0)
      context.addIssue({
        code: "custom",
        message: "A configured review date requires a positive revision",
        path: ["reviewScheduleRevision"],
      });
  })
  .superRefine((cycle, context) => {
    const previous = cycle.previousCompletedCycleAction;
    const addInvariantIssue = (path: PropertyKey[]) =>
      context.addIssue({
        code: "custom",
        message: "Cycle response previous Action is inconsistent",
        path,
      });

    if (cycle.status !== "active" || cycle.sequenceNumber === 1) {
      if (previous !== null)
        addInvariantIssue(["previousCompletedCycleAction"]);
      return;
    }
    if (previous === null) return;
    if (previous.cycleId === cycle.id)
      addInvariantIssue(["previousCompletedCycleAction", "cycleId"]);
    if (previous.cycleSequenceNumber !== cycle.sequenceNumber - 1)
      addInvariantIssue([
        "previousCompletedCycleAction",
        "cycleSequenceNumber",
      ]);
    if (
      previous.goalVersionNumber > cycle.goalVersion.versionNumber ||
      previous.goalVersionNumber < cycle.goalVersion.versionNumber - 1
    )
      addInvariantIssue(["previousCompletedCycleAction", "goalVersionNumber"]);
  });
export type Cycle = z.infer<typeof cycleSchema>;

export const currentWorkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("active_cycle"),
    cycleId: uuid,
    cycleSequenceNumber: z.number().int().positive(),
    reviewSchedule: reviewScheduleSchema,
  }),
  z.object({
    kind: z.literal("goal_review"),
    reviewDraftId: uuid,
    triggerCycleId: uuid,
    triggerCycleSequenceNumber: z.number().int().positive(),
    reviewSchedule: z.never().optional(),
  }),
]);
export type CurrentWork = z.infer<typeof currentWorkSchema>;

export const goalSchema = z.object({
  id: uuid,
  status: goalStatusSchema,
  revision: z.number().int().nonnegative(),
  currentVersion: goalVersionSchema,
  currentWork: currentWorkSchema.nullable(),
  nextCycleSequenceNumber: z.number().int().positive(),
  cycleCount: z.number().int().nonnegative().optional(),
  createdAt: instant,
  terminalAt: instant.nullable(),
});
export type Goal = z.infer<typeof goalSchema>;

export const homeSchema = z.object({
  progressingGoals: z.array(goalSchema),
  creationDraft: draftSchema.nullable(),
  canCreateGoalDraft: z.boolean(),
  progressingGoalLimit: z.number().int().positive(),
  canStartProgressingGoal: z.boolean(),
});
export type Home = z.infer<typeof homeSchema>;

export const reviewSchema = z
  .object({
    goal: goalSchema,
    reviewDraft: draftSchema,
    triggerCycle: cycleSchema,
  })
  .superRefine(({ goal, reviewDraft, triggerCycle }, context) => {
    const addInvariantIssue = (path: PropertyKey[]) =>
      context.addIssue({
        code: "custom",
        message: "Goal Review response is inconsistent",
        path,
      });

    if (goal.status !== "goal_review") addInvariantIssue(["goal", "status"]);
    if (goal.terminalAt !== null) addInvariantIssue(["goal", "terminalAt"]);

    const currentWork = goal.currentWork;
    if (currentWork?.kind !== "goal_review") {
      addInvariantIssue(["goal", "currentWork"]);
    } else {
      if (currentWork.reviewDraftId !== reviewDraft.id)
        addInvariantIssue(["goal", "currentWork", "reviewDraftId"]);
      if (currentWork.triggerCycleId !== triggerCycle.id)
        addInvariantIssue(["goal", "currentWork", "triggerCycleId"]);
      if (
        currentWork.triggerCycleSequenceNumber !== triggerCycle.sequenceNumber
      )
        addInvariantIssue([
          "goal",
          "currentWork",
          "triggerCycleSequenceNumber",
        ]);
    }

    if (goal.nextCycleSequenceNumber !== triggerCycle.sequenceNumber + 1)
      addInvariantIssue(["goal", "nextCycleSequenceNumber"]);
    if (reviewDraft.draftType !== "review")
      addInvariantIssue(["reviewDraft", "draftType"]);
    if (reviewDraft.goalId !== goal.id)
      addInvariantIssue(["reviewDraft", "goalId"]);
    if (reviewDraft.baseGoalVersionId !== goal.currentVersion.id)
      addInvariantIssue(["reviewDraft", "baseGoalVersionId"]);
    if (reviewDraft.reviewCycleId !== triggerCycle.id)
      addInvariantIssue(["reviewDraft", "reviewCycleId"]);
    if (triggerCycle.goalId !== goal.id)
      addInvariantIssue(["triggerCycle", "goalId"]);
    if (triggerCycle.status !== "completed")
      addInvariantIssue(["triggerCycle", "status"]);
    if (triggerCycle.goalVersion.id !== goal.currentVersion.id)
      addInvariantIssue(["triggerCycle", "goalVersion", "id"]);
    if (triggerCycle.completedAt === null)
      addInvariantIssue(["triggerCycle", "completedAt"]);
    if (triggerCycle.canceledAt !== null)
      addInvariantIssue(["triggerCycle", "canceledAt"]);
    if (triggerCycle.cancellationReason !== null)
      addInvariantIssue(["triggerCycle", "cancellationReason"]);
  });
export type GoalReview = z.infer<typeof reviewSchema>;
export const goalPageSchema = z.object({
  items: z.array(goalSchema),
  nextCursor: z.string().nullable(),
});
export type GoalPage = z.infer<typeof goalPageSchema>;

export const cycleSummarySchema = z
  .object({
    id: uuid,
    sequenceNumber: z.number().int().positive(),
    status: z.enum(["active", "completed", "canceled"]),
    startedAt: instant,
    completedAt: instant.nullable(),
    canceledAt: instant.nullable(),
    cancellationReason: cycleSummaryCancellationReasonSchema.nullable(),
    goalVersion: goalVersionSchema,
    planPreview: cycleSummaryPreviewTextSchema,
    learningPreview: cycleLearningPreviewSchema.nullable(),
  })
  .superRefine((cycle, context) => {
    const consistent =
      cycle.status === "active"
        ? cycle.completedAt === null &&
          cycle.canceledAt === null &&
          cycle.cancellationReason === null
        : cycle.status === "completed"
          ? cycle.completedAt !== null &&
            cycle.canceledAt === null &&
            cycle.cancellationReason === null
          : cycle.completedAt === null &&
            cycle.canceledAt !== null &&
            cycle.cancellationReason !== null;
    if (!consistent)
      context.addIssue({
        code: "custom",
        message: "Cycle summary status is inconsistent",
        path: ["status"],
      });
    const learningPreviewConsistent =
      cycle.status === "active"
        ? cycle.learningPreview === null
        : cycle.learningPreview !== null;
    if (!learningPreviewConsistent)
      context.addIssue({
        code: "custom",
        message: "Cycle summary learning preview is inconsistent",
        path: ["learningPreview"],
      });
  });
export type CycleSummary = z.infer<typeof cycleSummarySchema>;
export const cyclePageSchema = z.object({
  items: z.array(cycleSummarySchema),
  nextCursor: z.string().nullable(),
});
export type CyclePage = z.infer<typeof cyclePageSchema>;

export const saveFrameSchema = z.object({
  cycleId: uuid,
  frame: frameSchema,
  content: frameTextSchema,
  frameRevision: z.number().int().nonnegative(),
  contentRevision: z.number().int().nonnegative(),
  savedAt: instant,
});
export type SaveFrameResponse = z.infer<typeof saveFrameSchema>;

export const aiResponseSchema = z.object({
  generationId: uuid,
  sourceDraftRevision: z.number().int().nonnegative().optional(),
  sourceGoalRevision: z.number().int().nonnegative().optional(),
  suggestion: goalTextSchema.optional(),
  action: frameTextSchema.optional(),
  contentRevision: z.number().int().nonnegative().optional(),
  actionRevision: z.number().int().nonnegative().optional(),
  contextChanged: z.boolean(),
  replayed: z.boolean().optional(),
});
export type AIResponse = z.infer<typeof aiResponseSchema>;

export const goalRefineResponseSchema = aiResponseSchema.extend({
  sourceDraftRevision: z.number().int().nonnegative(),
  suggestion: goalTextSchema,
});
export type GoalRefineResponse = z.infer<typeof goalRefineResponseSchema>;

const apiErrorSchema = z.object({
  error: z.object({
    code: stableAPIErrorCodeSchema,
    message: z.string(),
    requestId: uuid,
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export function parseAPIError(value: unknown) {
  return apiErrorSchema.safeParse(value);
}
