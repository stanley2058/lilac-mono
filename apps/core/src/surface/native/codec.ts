import {
  modelReasoningSchema,
  nativeDeploymentSettingsSchema,
  displayMessageSchema,
  displayPartSchema,
  readyTurnSlotSchema,
  liveUpdateSchema,
} from "@stanley2058/lilac-client-protocol";
import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  type PersistedDataError,
} from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import { blobRefV1Schema } from "@stanley2058/lilac-blob-storage";
import { workflowResolvedModelRequestSchema } from "../../workflow/workflow-request-authority";
import { nativeOutputProjectionStateSchema } from "./output-projection-codec";

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
export const nativeUserSchema = z.strictObject({
  discordUserId: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .optional(),
  id,
  providerId: id,
  displayName: z.string().max(256),
  providerAvatarUrl: z.url().max(2048).optional(),
  avatar: z
    .strictObject({
      blob: blobRefV1Schema,
      mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    })
    .optional(),
  role: z.enum(["owner", "participant", "service"]),
  toolMode: z.enum(["restricted", "full"]),
});
export const nativeThreadRecordSchema = z.strictObject({
  kind: z.literal("dm").optional(),
  id,
  title: z.string().max(512),
  titleGeneration: z
    .strictObject({
      phase: z.enum(["initial", "refine"]),
      inputId: id.optional(),
    })
    .optional(),
  ephemeral: z.strictObject({ sessionId: z.uuid(), lastSeenAt: revision }).optional(),
  starterId: id,
  archived: z.boolean(),
  deleted: z.boolean(),
  createdAt: revision,
  updatedAt: revision,
  revision,
  historyGeneration: revision,
  nextPosition: revision,
  modelId: z.string().min(1).max(512).optional(),
  reasoning: modelReasoningSchema.optional(),
  activeRunId: id.optional(),
  mutationPending: z.boolean(),
});
export const nativeInputRecordSchema = z.strictObject({
  id,
  commandId: id,
  threadId: id,
  authorId: id,
  initiatingUserId: id,
  deviceId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  requestId: id,
  deliveryId: id,
  messageId: id,
  turnId: id.optional(),
  position: revision,
  historyGeneration: revision,
  questionReply: z.strictObject({ messageId: id, token: z.string().min(1).max(128) }).optional(),
  text: z.string(),
  mode: z.enum(["prompt", "steer", "followup"]),
  runId: id.optional(),
  state: z.enum(["uploading", "queued", "admitted", "target-ended", "canceled", "failed"]),
  attachmentIds: z.array(id),
  skillIds: z.array(z.string().min(1).max(512)),
  modelId: z.string().min(1).max(512).optional(),
  reasoning: modelReasoningSchema.optional(),
  command: z.strictObject({ id: z.string(), arguments: z.string() }).optional(),
  createdAt: revision,
  completedAt: revision.optional(),
  canonicalHistoryStartRequestId: id.optional(),
  attemptId: id.optional(),
  previousAttemptId: id.optional(),
  resolvedModelRequest: workflowResolvedModelRequestSchema.optional(),
  pinnedToolMode: z.enum(["restricted", "full"]).optional(),
});
export const nativeUploadRecordSchema = z.strictObject({
  id,
  threadId: id,
  ownerId: id,
  historyGeneration: revision,
  state: z.enum(["pending", "ready", "failed", "canceled"]),
  filename: z.string().max(1024),
  mediaType: z.string().max(256),
  size: revision,
  resourceUri: z.string().optional(),
  createdAt: revision,
  attempt: revision,
  revision,
  published: z.boolean(),
});
export const nativeHtmlPreviewRecordSchema = z.strictObject({
  id,
  threadId: id,
  turnId: id,
  path: z.string().min(1).max(4096),
  uploadId: id.optional(),
  error: z.string().max(1024).optional(),
});
const mutationResultSchema = z.strictObject({
  threadId: id,
  inputId: id.optional(),
  uploadId: id.optional(),
  turnId: id.optional(),
  text: z.string().optional(),
  historyGeneration: revision.optional(),
});
const commandSchema = z.strictObject({
  id,
  actorId: id,
  fingerprint: z.string(),
  result: mutationResultSchema,
});
export const nativeAgentStreamRecordSchema = z.strictObject({
  model: z.string().optional(),
  reasoning: modelReasoningSchema.optional(),
  taskTitle: z.string().max(80).optional(),
  titlePrompt: z.string().max(8000).optional(),
  id,
  state: z.enum(["running", "complete", "failed", "canceled"]).default("running"),
  title: z.string().max(256).default("Thinking…"),
  parentThreadId: id,
  parentRequestId: z.string().min(1),
  runId: z.string().min(1),
  requestId: z.string().min(1),
  turnId: id,
  attemptId: id.optional(),
  previousAttemptId: id.optional(),
  historyGeneration: revision,
  revision,
  updatedAt: revision,
  deleted: z.boolean(),
  mutationPending: z.boolean(),
});
// Records written before gap-based DM context carry `dmContextMaxAgeMs`. Its age semantics do not
// map onto a session gap, so decoding drops it and the gap settings take their defaults.
const storedDeploymentSettingsSchema = nativeDeploymentSettingsSchema
  .extend({ dmContextMaxAgeMs: z.number().int().positive().optional() })
  .transform(({ dmContextMaxAgeMs: _legacy, ...settings }) => settings);
export const nativeSendGroupSchema = z.strictObject({
  id,
  requestId: id,
  deliveryId: id.optional(),
  transcriptRequestId: id.optional(),
  actorId: id,
  threadId: id,
  historyGeneration: revision,
  settled: z.boolean(),
  delivered: z.boolean(),
  messages: z.array(z.strictObject({ message: displayMessageSchema, silent: z.boolean() })),
});
export type NativeSendGroup = z.infer<typeof nativeSendGroupSchema>;

export const nativeRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("send-group"), value: nativeSendGroupSchema }),
  z.strictObject({
    kind: z.literal("deployment"),
    value: z.strictObject({ settings: storedDeploymentSettingsSchema, revision }),
  }),
  z.strictObject({ kind: z.literal("user"), value: nativeUserSchema }),
  z.strictObject({ kind: z.literal("thread"), value: nativeThreadRecordSchema }),
  z.strictObject({ kind: z.literal("agent-stream"), value: nativeAgentStreamRecordSchema }),
  z.strictObject({
    kind: z.literal("turn"),
    value: readyTurnSlotSchema.extend({
      messages: z.array(displayMessageSchema.extend({ parts: z.array(displayPartSchema) })),
    }),
    projection: nativeOutputProjectionStateSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("input"), value: nativeInputRecordSchema }),
  z.strictObject({ kind: z.literal("upload"), value: nativeUploadRecordSchema }),
  z.strictObject({ kind: z.literal("command"), value: commandSchema }),
  z.strictObject({ kind: z.literal("replay"), value: liveUpdateSchema }),
  z.strictObject({ kind: z.literal("message"), value: displayMessageSchema }),
  z.strictObject({
    kind: z.literal("path"),
    value: z.strictObject({ id, threadId: id, path: z.string(), cwd: z.string().optional() }),
  }),
  z.strictObject({ kind: z.literal("html-preview"), value: nativeHtmlPreviewRecordSchema }),
]);
export type NativeUser = z.infer<typeof nativeUserSchema>;
export type NativeThreadRecord = z.infer<typeof nativeThreadRecordSchema>;
export type NativeAgentStreamRecord = z.infer<typeof nativeAgentStreamRecordSchema>;
export type NativeInputRecord = z.infer<typeof nativeInputRecordSchema>;
export type NativeUploadRecord = z.infer<typeof nativeUploadRecordSchema>;
export type NativeHtmlPreviewRecord = z.infer<typeof nativeHtmlPreviewRecordSchema>;
export type NativeRecord = z.infer<typeof nativeRecordSchema>;
export type NativeMutationResult = z.infer<typeof mutationResultSchema>;
export type NativePersistedRow = {
  readonly format_version: number;
  readonly data_json: string | null;
};

export function decodeNativeRecord(
  row: NativePersistedRow,
): ResultType<{ value: NativeRecord; provenance: "current" }, PersistedDataError> {
  const context = {
    table: "native_records",
    field: "data_json",
    version: row.format_version,
    recordId: "native-record",
    message: "Native persisted record is invalid",
  };
  if (row.format_version !== 1)
    return Result.err(new UnsupportedVersion({ ...context, issueCode: "unsupported-version" }));
  if (row.data_json === null)
    return Result.err(
      new CorruptPersistedFields({ ...context, issueCode: "missing-required-field" }),
    );
  const dataJson = row.data_json;
  const parsed = Result.try({
    try: (): unknown => JSON.parse(dataJson),
    catch: () => new MalformedSerialization({ ...context, issueCode: "malformed-json" }),
  });
  return parsed.andThen((value) => {
    const decoded = nativeRecordSchema.safeParse(value);
    if (!decoded.success)
      return Result.err(new CorruptPersistedFields({ ...context, issueCode: "invalid-row-field" }));
    return Result.ok({ value: decoded.data, provenance: "current" as const });
  });
}
const current = {
  format_version: 1,
  data_json: JSON.stringify({
    kind: "user",
    value: {
      id: "owner",
      providerId: "local",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    },
  }),
};
export const nativeRecordCodecCases = {
  current: { input: current, outcome: "ok", provenance: "current" },
  legacy: {
    input: { ...current, format_version: 0 },
    outcome: "error",
    errorTag: "UnsupportedVersion",
    issueCode: "unsupported-version",
  },
  "missing-defaulted": {
    input: { ...current, data_json: null },
    outcome: "error",
    errorTag: "CorruptPersistedFields",
    issueCode: "missing-required-field",
  },
  "unsupported-version": {
    input: { ...current, format_version: 2 },
    outcome: "error",
    errorTag: "UnsupportedVersion",
    issueCode: "unsupported-version",
  },
  "malformed-serialization": {
    input: { ...current, data_json: "{" },
    outcome: "error",
    errorTag: "MalformedSerialization",
    issueCode: "malformed-json",
  },
  "corrupt-fields": {
    input: { ...current, data_json: '{"kind":"user","value":{}}' },
    outcome: "error",
    errorTag: "CorruptPersistedFields",
    issueCode: "invalid-row-field",
  },
} as const;
