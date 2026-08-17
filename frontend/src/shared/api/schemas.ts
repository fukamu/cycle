import { z } from "zod";

const uuidSchema = z.string().uuid();
const instantSchema = z.string().datetime({ offset: true });

export const frameSchema = z.enum(["plan", "do", "check", "action"]);
export type Frame = z.infer<typeof frameSchema>;

export const sessionSchema = z.object({
  user: z.object({
    id: uuidSchema,
    googleConnected: z.boolean(),
  }),
  csrfToken: z.string().min(1),
  activeCycleId: uuidSchema,
});
export type Session = z.infer<typeof sessionSchema>;

export const activeCycleSchema = z.object({
  cycle: z.object({
    id: uuidSchema,
    sequenceNumber: z.number().int().positive(),
    status: z.literal("active"),
    startedAt: instantSchema,
    completedAt: z.null(),
    plan: z.string(),
    do: z.string(),
    check: z.string(),
    action: z.string(),
    contentRevision: z.number().int().nonnegative(),
    frameRevisions: z.object({
      plan: z.number().int().nonnegative(),
      do: z.number().int().nonnegative(),
      check: z.number().int().nonnegative(),
      action: z.number().int().nonnegative(),
    }),
    actionUserModifiedAfterAI: z.boolean(),
  }),
});
export type ActiveCycle = z.infer<typeof activeCycleSchema>["cycle"];

export const saveFrameSchema = z.object({
  cycleId: uuidSchema,
  frame: frameSchema,
  content: z.string(),
  frameRevision: z.number().int().nonnegative(),
  contentRevision: z.number().int().nonnegative(),
  savedAt: instantSchema,
});
export type SaveFrameResponse = z.infer<typeof saveFrameSchema>;

export const aiActionSchema = z.object({
  generationId: uuidSchema,
  action: z.string().min(1).max(2000),
  contentRevision: z.number().int().nonnegative(),
  actionRevision: z.number().int().nonnegative(),
  contextChanged: z.boolean(),
});
export type AIActionResponse = z.infer<typeof aiActionSchema>;

const completedSummarySchema = z.object({
  id: uuidSchema,
  sequenceNumber: z.number().int().positive(),
  startedAt: instantSchema,
  completedAt: instantSchema,
  planPreview: z.string(),
});

export const completedListSchema = z.object({
  items: z.array(completedSummarySchema),
  nextCursor: z.string().nullable(),
});
export type CompletedList = z.infer<typeof completedListSchema>;

export const completedDetailSchema = z.object({
  cycle: z.object({
    id: uuidSchema,
    sequenceNumber: z.number().int().positive(),
    status: z.literal("completed"),
    startedAt: instantSchema,
    completedAt: instantSchema,
    plan: z.string(),
    do: z.string(),
    check: z.string(),
    action: z.string(),
  }),
});
export type CompletedCycle = z.infer<typeof completedDetailSchema>["cycle"];

export const completeCycleSchema = z.object({
  completedCycle: z.object({
    id: uuidSchema,
    sequenceNumber: z.number().int().positive(),
    completedAt: instantSchema,
  }),
  nextCycle: activeCycleSchema.shape.cycle,
});
export type CompleteCycleResponse = z.infer<typeof completeCycleSchema>;

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export function parseAPIError(value: unknown) {
  return apiErrorSchema.safeParse(value);
}
