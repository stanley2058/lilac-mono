import type { UIMessage } from "ai";
import { z } from "zod";

export const MINI_LILAC_PROTOCOL_VERSION = 1 as const;

export const MINI_LILAC_REASONING_LEVELS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const miniLilacReasoningSchema = z.enum(MINI_LILAC_REASONING_LEVELS);
export type MiniLilacReasoning = z.infer<typeof miniLilacReasoningSchema>;

const identifierSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });

export const miniLilacLanguageModelUsageSchema = z.strictObject({
  inputTokens: z.number().nonnegative().optional(),
  inputTokenDetails: z.strictObject({
    noCacheTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    cacheWriteTokens: z.number().nonnegative().optional(),
  }),
  outputTokens: z.number().nonnegative().optional(),
  outputTokenDetails: z.strictObject({
    textTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(),
  }),
  totalTokens: z.number().nonnegative().optional(),
  raw: z.record(z.string(), z.json()).optional(),
});
export type MiniLilacLanguageModelUsage = z.infer<typeof miniLilacLanguageModelUsageSchema>;

export const miniLilacUIMessageMetadataSchema = z.strictObject({
  createdAt: timestampSchema.optional(),
  model: identifierSchema.optional(),
  profile: identifierSchema.optional(),
  reasoning: miniLilacReasoningSchema.optional(),
  usage: miniLilacLanguageModelUsageSchema.optional(),
});
export type MiniLilacUIMessageMetadata = z.infer<typeof miniLilacUIMessageMetadataSchema>;

export const miniLilacProfileSummarySchema = z.object({
  id: identifierSchema,
  label: z.string().trim().min(1),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  subagentOnly: z.boolean(),
  workspaceWrites: z.boolean(),
});
export type MiniLilacProfileSummary = z.infer<typeof miniLilacProfileSummarySchema>;

export const miniLilacSkillSummarySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().trim().min(1).max(1_024),
  })
  .strict();
export type MiniLilacSkillSummary = z.infer<typeof miniLilacSkillSummarySchema>;
export const miniLilacSkillsSchema = z.array(miniLilacSkillSummarySchema);

export const miniLilacModelSummarySchema = z.object({
  id: identifierSchema,
  label: z.string().trim().min(1),
  provider: identifierSchema.optional(),
  isDefault: z.boolean().optional(),
  supportsReasoning: z.boolean(),
  reasoningLevels: z.array(miniLilacReasoningSchema).optional(),
  contextWindow: z.number().int().positive().optional(),
});
export type MiniLilacModelSummary = z.infer<typeof miniLilacModelSummarySchema>;

export const miniLilacSessionStatusSchema = z.enum(["idle", "streaming", "cancelling", "error"]);
export type MiniLilacSessionStatus = z.infer<typeof miniLilacSessionStatusSchema>;

export const miniLilacSessionSnapshotSchema = z
  .object({
    id: identifierSchema,
    activeRunId: identifierSchema.nullable(),
    status: miniLilacSessionStatusSchema,
    cwd: z.string().min(1),
    model: identifierSchema.nullable(),
    profile: identifierSchema.nullable(),
    reasoning: miniLilacReasoningSchema.nullable(),
    title: z.string().max(100).optional(),
    inputTokens: z.number().int().nonnegative().nullable().optional(),
    contextWindow: z.number().int().positive().nullable().optional(),
    queuedSteeringCount: z.number().int().nonnegative(),
    createdAt: timestampSchema.optional(),
    updatedAt: timestampSchema.optional(),
  })
  .strict();
export type MiniLilacSessionSnapshot = z.infer<typeof miniLilacSessionSnapshotSchema>;
export const miniLilacSessionsSchema = z.array(miniLilacSessionSnapshotSchema);

const sessionBindingCommandFields = {
  sessionId: identifierSchema,
  clientCommandId: identifierSchema,
};
const optionalSessionBindingFields = {
  model: identifierSchema.optional(),
  profile: identifierSchema.optional(),
  reasoning: miniLilacReasoningSchema.optional(),
};

export const miniLilacUpdateSessionBindingsRequestSchema = z.union([
  z.strictObject({
    ...sessionBindingCommandFields,
    ...optionalSessionBindingFields,
    model: identifierSchema,
  }),
  z.strictObject({
    ...sessionBindingCommandFields,
    ...optionalSessionBindingFields,
    profile: identifierSchema,
  }),
  z.strictObject({
    ...sessionBindingCommandFields,
    ...optionalSessionBindingFields,
    reasoning: miniLilacReasoningSchema,
  }),
]);
export type MiniLilacUpdateSessionBindingsRequest = z.infer<
  typeof miniLilacUpdateSessionBindingsRequestSchema
>;
type OptionalClientCommandId<T extends { clientCommandId: string }> = T extends unknown
  ? Omit<T, "clientCommandId"> & { readonly clientCommandId?: string }
  : never;
export type MiniLilacUpdateSessionBindingsInput =
  OptionalClientCommandId<MiniLilacUpdateSessionBindingsRequest>;

const commandFields = {
  sessionId: identifierSchema,
  runId: identifierSchema,
  clientCommandId: identifierSchema.optional(),
};

export const miniLilacInterruptQueuedSteeringRequestSchema = z.strictObject({
  ...commandFields,
  pendingSteerCommandIds: z.array(identifierSchema).max(100).default([]),
});
export type MiniLilacInterruptQueuedSteeringRequest = z.infer<
  typeof miniLilacInterruptQueuedSteeringRequestSchema
>;
export type MiniLilacInterruptQueuedSteeringInput = Omit<
  MiniLilacInterruptQueuedSteeringRequest,
  "pendingSteerCommandIds"
> & {
  readonly pendingSteerCommandIds?: readonly string[];
};

export const miniLilacCancelRequestSchema = z.object(commandFields);
export type MiniLilacCancelRequest = z.infer<typeof miniLilacCancelRequestSchema>;

export const miniLilacUndoRequestSchema = z.strictObject({
  sessionId: identifierSchema,
  clientCommandId: identifierSchema,
});
export type MiniLilacUndoRequest = z.infer<typeof miniLilacUndoRequestSchema>;
export type MiniLilacUndoInput = Omit<MiniLilacUndoRequest, "clientCommandId"> & {
  readonly clientCommandId?: string;
};

export const miniLilacCompactRequestSchema = z.strictObject({
  sessionId: identifierSchema,
  clientCommandId: identifierSchema,
});
export type MiniLilacCompactRequest = z.infer<typeof miniLilacCompactRequestSchema>;
export type MiniLilacCompactInput = Omit<MiniLilacCompactRequest, "clientCommandId"> & {
  readonly clientCommandId?: string;
};

const resultCommandIdField = {
  clientCommandId: identifierSchema.optional(),
};

export const miniLilacSteerResultSchema = z
  .object({
    ...resultCommandIdField,
    status: z.literal("queued"),
    steeringId: identifierSchema,
  })
  .strict();
export type MiniLilacSteerResult = z.infer<typeof miniLilacSteerResultSchema>;

export const miniLilacInterruptQueuedSteeringResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...resultCommandIdField,
    status: z.literal("interrupted"),
    steeringIds: z.array(identifierSchema),
  }),
  z.strictObject({ ...resultCommandIdField, status: z.literal("empty") }),
  z.strictObject({ ...resultCommandIdField, status: z.literal("inactive") }),
]);
export type MiniLilacInterruptQueuedSteeringResult = z.infer<
  typeof miniLilacInterruptQueuedSteeringResultSchema
>;

export const miniLilacCancelResultSchema = z
  .object({
    ...resultCommandIdField,
    status: z.enum(["cancelled", "inactive"]),
  })
  .strict();
export type MiniLilacCancelResult = z.infer<typeof miniLilacCancelResultSchema>;

const compactResultFields = {
  clientCommandId: identifierSchema,
  messageCountBefore: z.number().int().nonnegative(),
  messageCountAfter: z.number().int().nonnegative(),
  estimatedInputTokensBefore: z.number().int().nonnegative().optional(),
  estimatedInputTokensAfter: z.number().int().nonnegative().optional(),
};

export const miniLilacCompactResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("compacted"), ...compactResultFields }),
  z.strictObject({ status: z.literal("empty"), ...compactResultFields }),
  z.strictObject({ status: z.literal("noop"), ...compactResultFields }),
]);
export type MiniLilacCompactResult = z.infer<typeof miniLilacCompactResultSchema>;

export const miniLilacControlResultSchema = z.union([
  miniLilacSteerResultSchema,
  miniLilacInterruptQueuedSteeringResultSchema,
  miniLilacCancelResultSchema,
]);
export type MiniLilacControlResult = z.infer<typeof miniLilacControlResultSchema>;

export const miniLilacChatRequestExtrasSchema = z.object({
  cwd: z.string().min(1).optional(),
  model: identifierSchema.optional(),
  profile: identifierSchema.optional(),
  reasoning: miniLilacReasoningSchema.optional(),
  clientCommandId: identifierSchema.optional(),
});
export type MiniLilacChatRequestExtras = z.infer<typeof miniLilacChatRequestExtrasSchema>;

export const miniLilacTranscriptResetSchema = z
  .object({
    reason: z.enum(["cancel", "interrupt"]),
  })
  .strict();
export type MiniLilacTranscriptReset = z.infer<typeof miniLilacTranscriptResetSchema>;

export const miniLilacSubagentStatusSchema = z
  .object({
    toolCallId: identifierSchema,
    runId: identifierSchema,
    sessionId: identifierSchema.optional(),
    sessionName: identifierSchema.optional(),
    profile: identifierSchema,
    prompt: z.string().min(1),
    mode: z.enum(["sync", "deferred"]),
    state: z.enum(["running", "completed", "cancelled", "error"]),
    toolCount: z.number().int().nonnegative(),
    activity: z.string().optional(),
    text: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export type MiniLilacSubagentStatus = z.infer<typeof miniLilacSubagentStatusSchema>;

const miniLilacCompactionMetricsSchema = {
  status: z.enum(["completed", "failed"]),
  messageCountBefore: z.number().int().nonnegative(),
  messageCountAfter: z.number().int().nonnegative().optional(),
  estimatedInputTokensBefore: z.number().int().nonnegative().optional(),
  estimatedInputTokensAfter: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
} as const;

export const miniLilacCompactionEventSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("automatic"),
      reason: z.enum(["threshold", "overflow"]),
      ...miniLilacCompactionMetricsSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("manual"),
      reason: z.literal("manual"),
      ...miniLilacCompactionMetricsSchema,
    })
    .strict(),
]);
export type MiniLilacCompactionEvent = z.infer<typeof miniLilacCompactionEventSchema>;

export const miniLilacStreamCursorSchema = z
  .object({
    runId: identifierSchema,
    seq: z.number().int().positive(),
  })
  .strict();
export type MiniLilacStreamCursor = z.infer<typeof miniLilacStreamCursorSchema>;

const reconnectSequenceSchema = z
  .string()
  .regex(/^\d+$/, "must be a nonnegative integer")
  .transform(Number)
  .pipe(z.number().int().nonnegative().finite());

export const miniLilacReconnectQuerySchema = z.union([
  z.strictObject({}),
  z.strictObject({
    runId: identifierSchema,
    after: reconnectSequenceSchema,
  }),
]);
export type MiniLilacReconnectQuery = z.infer<typeof miniLilacReconnectQuerySchema>;

export const miniLilacStreamCursorChunkSchema = z
  .object({
    type: z.literal("data-streamCursor"),
    id: identifierSchema.optional(),
    data: miniLilacStreamCursorSchema,
    transient: z.literal(true),
  })
  .strict();
export type MiniLilacStreamCursorChunk = z.infer<typeof miniLilacStreamCursorChunkSchema>;

export const miniLilacTodoSchema = z.strictObject({
  content: z.string().max(500),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["high", "medium", "low"]),
});
export type MiniLilacTodo = z.infer<typeof miniLilacTodoSchema>;

const MAX_TODO_STATE_BYTES = 32 * 1_024;

export const miniLilacTodosSchema = z
  .array(miniLilacTodoSchema)
  .max(50)
  .superRefine((todos, context) => {
    if (todos.filter((todo) => todo.status === "in_progress").length > 1) {
      context.addIssue({
        code: "custom",
        message: "Todo list may contain at most one in-progress todo",
      });
    }
  });

export const miniLilacTodoStateSchema = z
  .strictObject({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    todos: miniLilacTodosSchema,
  })
  .superRefine((state, context) => {
    // Explicit field ordering keeps the byte limit independent of input object key order.
    const serialized = JSON.stringify({
      // Reserve the maximum revision width so a schema-valid list stays writable at every revision.
      revision: Number.MAX_SAFE_INTEGER,
      todos: state.todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
      })),
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_TODO_STATE_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Serialized todo state may not exceed ${MAX_TODO_STATE_BYTES} bytes`,
      });
    }
  });
export type MiniLilacTodoState = z.infer<typeof miniLilacTodoStateSchema>;

export const miniLilacTodoChunkSchema = z.strictObject({
  type: z.literal("data-todos"),
  id: identifierSchema.optional(),
  data: miniLilacTodoStateSchema,
  transient: z.literal(true),
});
export type MiniLilacTodoChunk = z.infer<typeof miniLilacTodoChunkSchema>;

export type MiniLilacUIMessageDataParts = {
  session: MiniLilacSessionSnapshot;
  control: MiniLilacControlResult;
  transcriptReset: MiniLilacTranscriptReset;
  subagentStatus: MiniLilacSubagentStatus;
  compaction: MiniLilacCompactionEvent;
  streamCursor: MiniLilacStreamCursor;
  todos: MiniLilacTodoState;
};

export const miniLilacUIMessageDataPartSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("data-session"),
    id: identifierSchema.optional(),
    data: miniLilacSessionSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("data-control"),
    id: identifierSchema.optional(),
    data: miniLilacControlResultSchema,
  }),
  z.strictObject({
    type: z.literal("data-transcriptReset"),
    id: identifierSchema.optional(),
    data: miniLilacTranscriptResetSchema,
  }),
  z.strictObject({
    type: z.literal("data-subagentStatus"),
    id: identifierSchema.optional(),
    data: miniLilacSubagentStatusSchema,
  }),
  z.strictObject({
    type: z.literal("data-compaction"),
    id: identifierSchema.optional(),
    data: miniLilacCompactionEventSchema,
  }),
]);
export type MiniLilacUIMessageDataPart = z.infer<typeof miniLilacUIMessageDataPartSchema>;

export const miniLilacProviderMetadataSchema = z.record(z.string(), z.record(z.string(), z.json()));
const providerReferenceSchema = z.record(z.string(), z.string());
const jsonObjectSchema = z.record(z.string(), z.json().optional());
const standardPartMetadataFields = {
  providerMetadata: miniLilacProviderMetadataSchema.optional(),
};

const textPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  state: z.enum(["streaming", "done"]).optional(),
  ...standardPartMetadataFields,
});

const reasoningPartSchema = z.strictObject({
  type: z.literal("reasoning"),
  text: z.string(),
  state: z.enum(["streaming", "done"]).optional(),
  ...standardPartMetadataFields,
});

const filePartSchema = z.strictObject({
  type: z.literal("file"),
  mediaType: z.string(),
  filename: z.string().optional(),
  url: z.string(),
  providerReference: providerReferenceSchema.optional(),
  ...standardPartMetadataFields,
});

const sourceUrlPartSchema = z.strictObject({
  type: z.literal("source-url"),
  sourceId: z.string(),
  url: z.string(),
  title: z.string().optional(),
  ...standardPartMetadataFields,
});

const sourceDocumentPartSchema = z.strictObject({
  type: z.literal("source-document"),
  sourceId: z.string(),
  mediaType: z.string(),
  title: z.string(),
  filename: z.string().optional(),
  ...standardPartMetadataFields,
});

const reasoningFilePartSchema = z.strictObject({
  type: z.literal("reasoning-file"),
  mediaType: z.string(),
  url: z.string(),
  ...standardPartMetadataFields,
});

const customPartSchema = z.strictObject({
  type: z.literal("custom"),
  kind: z.custom<`${string}.${string}`>(
    (value): value is `${string}.${string}` => typeof value === "string" && value.includes("."),
  ),
  ...standardPartMetadataFields,
});

const toolTypeSchema = z.custom<`tool-${string}`>(
  (value): value is `tool-${string}` =>
    typeof value === "string" && value.startsWith("tool-") && value.length > "tool-".length,
);

const toolPartBaseFields = {
  toolCallId: z.string(),
  title: z.string().optional(),
  toolMetadata: jsonObjectSchema.optional(),
  providerExecuted: z.boolean().optional(),
};

const toolApprovalMetadataFields = {
  isAutomatic: z.boolean().optional(),
  signature: z.string().optional(),
};

function createToolPartSchema<TypeFields extends Record<string, z.ZodType>>(
  typeFields: TypeFields,
) {
  const commonFields = { ...typeFields, ...toolPartBaseFields };
  return z.discriminatedUnion("state", [
    z.strictObject({
      ...commonFields,
      state: z.literal("input-streaming"),
      input: z.unknown().optional(),
      rawInput: z.never().optional(),
      output: z.never().optional(),
      errorText: z.never().optional(),
      preliminary: z.never().optional(),
      callProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      approval: z.never().optional(),
    }),
    z.strictObject({
      ...commonFields,
      state: z.literal("input-available"),
      input: z.unknown(),
      rawInput: z.never().optional(),
      output: z.never().optional(),
      errorText: z.never().optional(),
      preliminary: z.never().optional(),
      callProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      approval: z.never().optional(),
    }),
    z.strictObject({
      ...commonFields,
      state: z.literal("approval-requested"),
      input: z.unknown(),
      rawInput: z.never().optional(),
      output: z.never().optional(),
      errorText: z.never().optional(),
      preliminary: z.never().optional(),
      callProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      approval: z.strictObject({
        id: z.string(),
        approved: z.never().optional(),
        reason: z.never().optional(),
        ...toolApprovalMetadataFields,
      }),
    }),
    z.strictObject({
      ...commonFields,
      state: z.literal("approval-responded"),
      input: z.unknown(),
      rawInput: z.never().optional(),
      output: z.never().optional(),
      errorText: z.never().optional(),
      preliminary: z.never().optional(),
      callProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      approval: z.strictObject({
        id: z.string(),
        approved: z.boolean(),
        reason: z.string().optional(),
        ...toolApprovalMetadataFields,
      }),
    }),
    z.strictObject({
      ...commonFields,
      state: z.literal("output-available"),
      input: z.unknown(),
      rawInput: z.never().optional(),
      output: z.unknown(),
      errorText: z.never().optional(),
      callProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      resultProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      preliminary: z.boolean().optional(),
      approval: z
        .strictObject({
          id: z.string(),
          approved: z.literal(true),
          reason: z.string().optional(),
          ...toolApprovalMetadataFields,
        })
        .optional(),
    }),
    z.strictObject({
      ...commonFields,
      state: z.literal("output-error"),
      input: z.unknown(),
      rawInput: z.unknown().optional(),
      output: z.never().optional(),
      errorText: z.string(),
      callProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      resultProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      preliminary: z.boolean().optional(),
      approval: z
        .strictObject({
          id: z.string(),
          approved: z.literal(true),
          reason: z.string().optional(),
          ...toolApprovalMetadataFields,
        })
        .optional(),
    }),
    z.strictObject({
      ...commonFields,
      state: z.literal("output-denied"),
      input: z.unknown(),
      rawInput: z.never().optional(),
      output: z.never().optional(),
      errorText: z.never().optional(),
      preliminary: z.never().optional(),
      callProviderMetadata: miniLilacProviderMetadataSchema.optional(),
      approval: z.strictObject({
        id: z.string(),
        approved: z.literal(false),
        reason: z.string().optional(),
        ...toolApprovalMetadataFields,
      }),
    }),
  ]);
}

const toolPartSchema = createToolPartSchema({ type: toolTypeSchema });
const dynamicToolPartSchema = createToolPartSchema({
  type: z.literal("dynamic-tool"),
  toolName: z.string(),
});

const standardUIMessagePartSchema = z.union([
  textPartSchema,
  reasoningPartSchema,
  filePartSchema,
  sourceUrlPartSchema,
  sourceDocumentPartSchema,
  reasoningFilePartSchema,
  customPartSchema,
  z.strictObject({ type: z.literal("step-start") }),
  toolPartSchema,
  dynamicToolPartSchema,
]);

export const miniLilacUIMessageSchema = z.strictObject({
  id: identifierSchema,
  role: z.enum(["system", "user", "assistant"]),
  metadata: miniLilacUIMessageMetadataSchema.optional(),
  parts: z
    .array(z.union([standardUIMessagePartSchema, miniLilacUIMessageDataPartSchema]))
    .nonempty(),
}) satisfies z.ZodType<UIMessage<MiniLilacUIMessageMetadata, MiniLilacUIMessageDataParts>>;
export type MiniLilacUIMessage = z.infer<typeof miniLilacUIMessageSchema>;

export const miniLilacUserUIMessageSchema = miniLilacUIMessageSchema.extend({
  role: z.literal("user"),
});
export type MiniLilacUserUIMessage = z.infer<typeof miniLilacUserUIMessageSchema>;

export const miniLilacSteeringChunkSchema = z.strictObject({
  type: z.literal("data-steering"),
  id: identifierSchema.optional(),
  data: miniLilacUserUIMessageSchema,
});
export type MiniLilacSteeringChunk = z.infer<typeof miniLilacSteeringChunkSchema>;

export const miniLilacSteeringCommittedChunkSchema = z.strictObject({
  type: z.literal("data-steeringCommitted"),
  id: identifierSchema.optional(),
  data: miniLilacUserUIMessageSchema,
});
export type MiniLilacSteeringCommittedChunk = z.infer<typeof miniLilacSteeringCommittedChunkSchema>;

export const miniLilacUndoResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("undone"),
    clientCommandId: identifierSchema,
    message: miniLilacUserUIMessageSchema,
  }),
  z.strictObject({
    status: z.literal("empty"),
    clientCommandId: identifierSchema,
  }),
]);
export type MiniLilacUndoResult = z.infer<typeof miniLilacUndoResultSchema>;

export const miniLilacSteerRequestSchema = z.strictObject({
  ...commandFields,
  message: miniLilacUserUIMessageSchema,
});
export type MiniLilacSteerRequest = z.infer<typeof miniLilacSteerRequestSchema>;

export const miniLilacMessagesSchema = z.array(miniLilacUIMessageSchema);
export const miniLilacSessionResumeSchema = z.strictObject({
  snapshot: miniLilacSessionSnapshotSchema,
  messages: miniLilacMessagesSchema,
  todos: miniLilacTodoStateSchema,
  replayCursor: z
    .strictObject({
      runId: identifierSchema,
      afterSeq: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type MiniLilacSessionResume = z.infer<typeof miniLilacSessionResumeSchema>;
export const miniLilacModelsSchema = z.array(miniLilacModelSummarySchema);
export const miniLilacProfilesSchema = z.array(miniLilacProfileSummarySchema);
