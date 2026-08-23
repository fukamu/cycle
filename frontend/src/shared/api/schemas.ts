import { z } from "zod";

import { UUID_V7_PATTERN } from "../id/uuid";

const uuid = z.string().regex(UUID_V7_PATTERN);
const instant = z.string().datetime({ offset: true });

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
  csrfToken: z.string().min(1),
});
export type Session = z.infer<typeof sessionSchema>;

export const goalVersionSchema = z.object({
  id: uuid,
  versionNumber: z.number().int().positive(),
  body: z.string(),
  createdAt: instant.optional(),
});
export type GoalVersion = z.infer<typeof goalVersionSchema>;

export const draftSchema = z.object({
  id: uuid,
  draftType: z.enum(["creation", "review"]),
  goalId: uuid.optional(),
  baseGoalVersionId: uuid.optional(),
  reviewCycleId: uuid.optional(),
  body: z.string(),
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

export const cycleSchema = z.object({
  id: uuid,
  goalId: uuid.optional(),
  sequenceNumber: z.number().int().positive(),
  status: z.enum(["active", "completed", "canceled"]),
  goalVersion: goalVersionSchema,
  startedAt: instant,
  completedAt: instant.nullable(),
  canceledAt: instant.nullable(),
  cancellationReason: z
    .enum(["goal_achieved", "goal_ended", "goal_deleted"])
    .nullable(),
  plan: z.string(),
  do: z.string(),
  check: z.string(),
  action: z.string(),
  contentRevision: z.number().int().nonnegative(),
  frameRevisions: frameRevisionsSchema,
});
export type Cycle = z.infer<typeof cycleSchema>;

export const currentWorkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("active_cycle"),
    cycleId: uuid,
    cycleSequenceNumber: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("goal_review"),
    reviewDraftId: uuid,
    triggerCycleId: uuid,
    triggerCycleSequenceNumber: z.number().int().positive(),
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

export const reviewSchema = z.object({
  goal: goalSchema,
  reviewDraft: draftSchema,
  triggerCycle: cycleSchema,
});
export type GoalReview = z.infer<typeof reviewSchema>;
export const goalPageSchema = z.object({
  items: z.array(goalSchema),
  nextCursor: z.string().nullable(),
});
export type GoalPage = z.infer<typeof goalPageSchema>;

export const cycleSummarySchema = z.object({
  id: uuid,
  sequenceNumber: z.number().int().positive(),
  status: z.enum(["active", "completed", "canceled"]),
  startedAt: instant,
  completedAt: instant.nullable(),
  canceledAt: instant.nullable(),
  goalVersion: goalVersionSchema,
  planPreview: z.string(),
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
  content: z.string(),
  frameRevision: z.number().int().nonnegative(),
  contentRevision: z.number().int().nonnegative(),
  savedAt: instant,
});
export type SaveFrameResponse = z.infer<typeof saveFrameSchema>;

export const aiResponseSchema = z.object({
  generationId: uuid,
  sourceDraftRevision: z.number().int().nonnegative().optional(),
  sourceGoalRevision: z.number().int().nonnegative().optional(),
  suggestion: z.string().optional(),
  action: z.string().optional(),
  contentRevision: z.number().int().nonnegative().optional(),
  actionRevision: z.number().int().nonnegative().optional(),
  contextChanged: z.boolean(),
  replayed: z.boolean().optional(),
});
export type AIResponse = z.infer<typeof aiResponseSchema>;

export const goalRefineResponseSchema = aiResponseSchema.extend({
  sourceDraftRevision: z.number().int().nonnegative(),
  suggestion: z.string(),
});
export type GoalRefineResponse = z.infer<typeof goalRefineResponseSchema>;

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: uuid,
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export function parseAPIError(value: unknown) {
  return apiErrorSchema.safeParse(value);
}
