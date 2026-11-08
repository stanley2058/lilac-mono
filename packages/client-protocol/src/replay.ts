import { nativeQuestionSchema } from "./questions.ts";
import { conversationReferenceSchema } from "./references.ts";
import type { UIMessage } from "ai";
import { z } from "zod";

export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MAX_REPLAY_SLOTS = 128;
export const MAX_REPLAY_TEXT_LENGTH = 65_536;
export const MAX_REPLAY_BATCH_BYTES = 262_144;
const encoder = new TextEncoder();
export const identitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const runIdentitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_:-]+$/);

export const replayCheckpointSchema = z.strictObject({
  protocolVersion: z.literal(1),
  historyGeneration: revisionSchema,
  projectionRevision: revisionSchema,
  cursor: identitySchema,
});

export const messageMetadataSchema = z.strictObject({
  externalRunId: identitySchema.optional(),
  reference: conversationReferenceSchema.optional(),
  authorId: identitySchema.optional(),
  authorDisplayName: z.string().min(1).max(256).optional(),
  position: revisionSchema.optional(),
  createdAt: revisionSchema.optional(),
  phase: z.enum(["commentary", "final"]).optional(),
  incomplete: z.boolean().optional(),
  inputId: identitySchema.optional(),
  replyToMessageId: identitySchema.optional(),
  inputMode: z.enum(["prompt", "steer", "followup"]).optional(),
});
const workflowCountsSchema = {
  completed: revisionSchema,
  queued: revisionSchema,
  active: revisionSchema,
  waiting: revisionSchema,
  failed: revisionSchema,
  cancelled: revisionSchema,
  total: revisionSchema,
};
export const MAX_WORKFLOW_RESULT_LENGTH = 16_384;
export const actionsPartSchema = z.strictObject({
  type: z.literal("data-actions"),
  id: identitySchema,
  data: z.strictObject({
    requestId: z.string().min(1).max(512),
    revision: revisionSchema,
    actions: z
      .array(
        z.strictObject({
          actionId: z.string().min(1).max(512),
          label: z.string().min(1).max(256),
          style: z.enum(["primary", "secondary", "danger", "success"]),
          disabled: z.boolean().optional(),
        }),
      )
      .max(25),
  }),
});
export const workflowCardSchema = z.strictObject({
  name: z.string().min(1).max(256),
  description: z.string().max(1024),
  status: z.enum([
    "queued",
    "running",
    "blocked",
    "waiting",
    "waiting-reply",
    "paused",
    "needs-attention",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  startedAt: revisionSchema,
  endedAt: revisionSchema.optional(),
  progress: z.strictObject(workflowCountsSchema),
  phases: z
    .array(z.strictObject({ name: z.string().min(1).max(256), ...workflowCountsSchema }))
    .max(64),
  steps: z
    .array(
      z.strictObject({
        label: z.string().max(512).optional(),
        kind: z.enum(["agent", "wait"]),
        state: z.enum([
          "queued",
          "dispatched",
          "running",
          "blocked",
          "succeeded",
          "failed",
          "cancelled",
          "timed_out",
        ]),
      }),
    )
    .max(8),
  wait: z
    .strictObject({
      kind: z.enum(["reply", "sleep"]),
      prompt: z.string().max(512),
      dueAt: revisionSchema.optional(),
      deadlineAt: revisionSchema.optional(),
      replyToMessage: z.boolean(),
      elsewhere: z.boolean(),
    })
    .optional(),
  result: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.enum(["text", "json"]),
        text: z.string().max(MAX_WORKFLOW_RESULT_LENGTH),
        truncated: z.boolean(),
      }),
      z.strictObject({ kind: z.literal("stored") }),
    ])
    .optional(),
  reason: z.string().max(4096).optional(),
  agents: z.strictObject({ used: revisionSchema, active: revisionSchema, queued: revisionSchema }),
  nextRunAt: revisionSchema.optional(),
  sensitive: z.boolean(),
});
export const displayPartSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("data-question"),
    id: identitySchema,
    data: nativeQuestionSchema,
  }),
  z.strictObject({ type: z.literal("text"), text: z.string().max(MAX_REPLAY_TEXT_LENGTH) }),
  z.strictObject({
    type: z.literal("data-activity"),
    id: identitySchema,
    data: z.strictObject({
      kind: z.enum(["tool", "thinking", "workflow"]),
      label: z.string().max(256),
      state: z.enum(["running", "complete", "failed"]),
      detail: z.string().max(MAX_REPLAY_TEXT_LENGTH).optional(),
      output: z.string().max(MAX_REPLAY_TEXT_LENGTH).optional(),
      exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
      file: z
        .strictObject({
          path: z.string().min(1).max(4096),
          mediaType: z.string().min(1).max(256),
        })
        .optional(),
      durationMs: revisionSchema.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("data-resource"),
    id: identitySchema,
    data: z.strictObject({
      resourceId: identitySchema,
      name: z.string().max(512),
      mediaType: z.string().max(256),
      size: revisionSchema,
      state: z.enum(["pending", "ready", "failed", "canceled"]),
      progress: z.number().min(0).max(1).optional(),
      error: z.string().max(512).optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("data-compaction"),
    id: identitySchema,
    data: z.strictObject({
      state: z.enum(["running", "complete", "failed"]),
      beforeCount: revisionSchema.optional(),
      afterCount: revisionSchema.optional(),
    }),
  }),
  actionsPartSchema,
  z.strictObject({
    type: z.literal("data-reactions"),
    id: identitySchema,
    data: z.strictObject({
      items: z
        .array(
          z.strictObject({
            emoji: z.string().min(1).max(128),
            count: revisionSchema,
            reacted: z.boolean(),
            userNames: z.array(z.string()).max(5).optional(),
            overflowCount: revisionSchema.optional(),
          }),
        )
        .max(64),
    }),
  }),
  z.strictObject({
    type: z.literal("data-workflow"),
    id: identitySchema,
    data: workflowCardSchema,
  }),
  z.strictObject({
    type: z.literal("data-input-state"),
    id: identitySchema,
    data: z.strictObject({
      state: z.enum(["uploading", "queued", "admitted", "target-ended", "canceled", "failed"]),
      reason: z.string().max(512).optional(),
    }),
  }),
]);
export const displayMessageSchema = z.strictObject({
  id: identitySchema,
  role: z.enum(["user", "assistant", "system"]),
  metadata: messageMetadataSchema.optional(),
  parts: z.array(displayPartSchema).max(128),
}) satisfies z.ZodType<Pick<UIMessage, "id" | "role" | "parts" | "metadata">>;

export const readyTurnSlotSchema = z.strictObject({
  kind: z.literal("ready"),
  slotId: identitySchema,
  position: revisionSchema,
  turnId: identitySchema,
  messages: z.array(displayMessageSchema).max(128),
  state: z.enum(["pending", "running", "complete", "canceled", "failed"]).optional(),
  runId: runIdentitySchema.optional(),
  startedAt: revisionSchema.optional(),
  settledAt: revisionSchema.optional(),
  partsCursor: identitySchema.optional(),
});

export const deferredTurnSlotSchema = z
  .strictObject({
    kind: z.literal("deferred"),
    slotId: identitySchema,
    position: revisionSchema,
    endPosition: revisionSchema,
  })
  .refine((slot) => slot.endPosition > slot.position, {
    message: "A deferred slot must cover at least one turn position",
  });

export const failedTurnSlotSchema = z
  .strictObject({
    kind: z.literal("failed"),
    slotId: identitySchema,
    position: revisionSchema,
    endPosition: revisionSchema,
    message: z.string().min(1).max(512),
    retryable: z.literal(true),
  })
  .refine((slot) => slot.endPosition > slot.position, {
    message: "A failed slot must retain its unresolved turn range",
  });

export const turnSlotSchema = z.discriminatedUnion("kind", [
  readyTurnSlotSchema,
  deferredTurnSlotSchema,
  failedTurnSlotSchema,
]);

export const hydrationSchema = z
  .strictObject({
    historyGeneration: revisionSchema,
    projectionRevision: revisionSchema,
    slotId: identitySchema,
    slots: z.array(turnSlotSchema).min(1).max(MAX_REPLAY_SLOTS),
  })
  .refine(
    (hydration) => encoder.encode(JSON.stringify(hydration)).byteLength <= MAX_REPLAY_BATCH_BYTES,
    {
      message: "Hydration exceeds the batch byte budget",
    },
  );

export const liveUpdateSchema = z
  .strictObject({
    checkpoint: replayCheckpointSchema,
    changes: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("insert"),
            slot: readyTurnSlotSchema,
          }),
          z.strictObject({
            kind: z.literal("append-text"),
            turnId: identitySchema,
            position: revisionSchema,
            messageId: identitySchema,
            partIndex: revisionSchema,
            text: z.string().max(MAX_REPLAY_TEXT_LENGTH),
          }),
          z.strictObject({
            kind: z.literal("append-message"),
            turnId: identitySchema,
            position: revisionSchema,
            message: displayMessageSchema,
            beforeMessageId: identitySchema.optional(),
          }),
          z.strictObject({
            kind: z.literal("remove-message"),
            turnId: identitySchema,
            position: revisionSchema,
            messageId: identitySchema,
          }),
          z.strictObject({
            kind: z.literal("truncate-parts"),
            turnId: identitySchema,
            position: revisionSchema,
            messageId: identitySchema,
            length: revisionSchema,
          }),
          z.strictObject({
            kind: z.literal("message-meta"),
            turnId: identitySchema,
            position: revisionSchema,
            messageId: identitySchema,
            metadata: z.strictObject({
              phase: z.enum(["commentary", "final"]).optional(),
              incomplete: z.boolean().optional(),
            }),
          }),
          z.strictObject({
            kind: z.literal("set-part"),
            turnId: identitySchema,
            position: revisionSchema,
            messageId: identitySchema,
            partIndex: revisionSchema,
            part: displayPartSchema,
          }),
          z.strictObject({
            kind: z.literal("turn-state"),
            turnId: identitySchema,
            position: revisionSchema,
            state: z.enum(["pending", "running", "complete", "canceled", "failed"]),
            runId: runIdentitySchema.optional(),
            startedAt: revisionSchema.optional(),
            settledAt: revisionSchema.optional(),
          }),
          z.strictObject({
            kind: z.literal("remove"),
            turnId: identitySchema,
            position: revisionSchema,
          }),
        ]),
      )
      .max(128),
  })
  .refine((update) => encoder.encode(JSON.stringify(update)).byteLength <= MAX_REPLAY_BATCH_BYTES, {
    message: "Live update exceeds the batch byte budget",
  });

export const replayReplySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("unchanged"),
      checkpoint: replayCheckpointSchema,
    }),
    z
      .strictObject({
        kind: z.literal("delta"),
        checkpoint: replayCheckpointSchema,
        fromRevision: revisionSchema,
        changes: liveUpdateSchema.shape.changes,
      })
      .refine((reply) => reply.fromRevision < reply.checkpoint.projectionRevision, {
        message: "Delta must advance the projection revision",
      }),
    z.strictObject({
      kind: z.literal("window"),
      checkpoint: replayCheckpointSchema,
      slots: z.array(turnSlotSchema).max(MAX_REPLAY_SLOTS),
    }),
  ])
  .refine((reply) => encoder.encode(JSON.stringify(reply)).byteLength <= MAX_REPLAY_BATCH_BYTES, {
    message: "Replay reply exceeds the batch byte budget",
  });

export type ReplayCheckpoint = z.infer<typeof replayCheckpointSchema>;
export type DisplayMessage = z.infer<typeof displayMessageSchema>;
export type ReadyTurnSlot = z.infer<typeof readyTurnSlotSchema>;
export type TurnSlot = z.infer<typeof turnSlotSchema>;
export type ReplayReply = z.infer<typeof replayReplySchema>;
export type Hydration = z.infer<typeof hydrationSchema>;
export type LiveUpdate = z.infer<typeof liveUpdateSchema>;

export type DisplayPart = z.infer<typeof displayPartSchema>;
export type WorkflowCard = z.infer<typeof workflowCardSchema>;
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
