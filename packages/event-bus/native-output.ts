import { z } from "zod";

const id = z.string().min(1);
const position = z.number().int().nonnegative();

export const nativeOutputFrontierSchema = z.strictObject({ ordinal: position, position });
export type NativeOutputFrontier = z.output<typeof nativeOutputFrontierSchema>;

export const nativeOutputPayloadSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("model"),
    spec: id,
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
  }),
  z.strictObject({
    type: z.literal("resource"),
    stepId: id,
    position,
    resourceId: id,
    filename: id,
    mediaType: id,
    size: position,
  }),
  z.strictObject({
    type: z.literal("text"),
    partId: id,
    stepId: id,
    position,
    phase: z.enum(["commentary", "final_answer", "unspecified"]),
    text: z.string(),
    incomplete: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("activity"),
    activityId: id,
    stepId: id,
    position,
    kind: z.enum(["thinking", "tool"]),
    state: z.enum(["start", "complete", "failed"]),
    label: z.string().optional(),
    detail: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().int().optional(),
    file: z.strictObject({ path: id, mediaType: id }).optional(),
    durationMs: position.optional(),
  }),
  z.strictObject({
    type: z.literal("compaction"),
    compactionId: id,
    position,
    state: z.enum(["start", "complete", "failed"]),
    beforeCount: position.optional(),
    afterCount: position.optional(),
    boundary: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("reset"),
    previousAttemptId: id,
    stepId: id.optional(),
    retainThroughOrdinal: position.optional(),
  }),
  z.strictObject({
    type: z.literal("terminal"),
    state: z.enum(["complete", "failed", "canceled"]),
  }),
]);

export const nativeOutputEventSchema = z.strictObject({
  threadId: id,
  turnId: id,
  generation: position,
  requestId: id,
  attemptId: id,
  sequence: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  eventId: id,
  occurredAt: z.number().nonnegative(),
  payload: nativeOutputPayloadSchema,
});

export type NativeOutputPayload = z.output<typeof nativeOutputPayloadSchema>;
export type NativeOutputEvent = z.output<typeof nativeOutputEventSchema>;
