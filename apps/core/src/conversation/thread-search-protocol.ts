import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

const filters = z.strictObject({
  surface: z.enum(["discord", "native"]).optional(),
  participantSurface: z.enum(["discord", "native"]).optional(),
  sessionId: z.string().optional(),
  participantId: z.string().optional(),
  participantIdsAny: z.array(z.string()).readonly().optional(),
  beforeTs: z.number().optional(),
  afterTs: z.number().optional(),
});
const allowlist = z.strictObject({
  channelIds: z.array(z.string()).readonly(),
  guildIds: z.array(z.string()).readonly(),
});
const scope = { filters: filters.optional(), allowlist: allowlist.optional() };
const hit = z.object({
  threadId: z.string(),
  channelId: z.string(),
  guildId: z.string().optional(),
  parentChannelId: z.string().optional(),
  kind: z.enum(["discord_thread", "inferred_channel_thread", "native_thread"]),
  sourceRevision: z.string().optional(),
  title: z.string(),
  brief: z.string(),
  topics: z.array(z.string()),
  retrievalHints: z.array(z.string()),
  aboutness: z.strictObject({
    domains: z.array(z.string()),
    situations: z.array(z.string()),
    complaintTargets: z.array(z.string()),
    entities: z.array(z.string()),
    userWouldAskForThisAs: z.array(z.string()),
  }),
  importance: z.enum(["low", "medium", "high"]),
  importanceReasons: z.array(z.string()),
  startTs: z.number(),
  endTs: z.number(),
  messageCount: z.number(),
  score: z.number(),
  lexicalScore: z.number(),
  semanticScore: z.number(),
  startMessageId: z.string(),
  endMessageId: z.string(),
  summarized: z.boolean(),
  stale: z.boolean(),
});
const operation = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("prepare"), ...scope }),
  z.strictObject({
    type: z.literal("semantic"),
    ...scope,
    embedding: z.instanceof(Float32Array),
    modelId: z.string(),
    dimensions: z.number().int().positive(),
    limit: z.number().optional(),
    eligibleThreadIds: z.array(z.string()).readonly().optional(),
  }),
  z.strictObject({
    type: z.literal("lexical"),
    ...scope,
    query: z.string(),
    limit: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal("any-term"),
    ...scope,
    text: z.string(),
    limit: z.number().optional(),
    excludeThreadIds: z.array(z.string()).readonly().optional(),
  }),
  z.strictObject({ type: z.literal("current"), ...scope, hits: z.array(hit).readonly() }),
  z.strictObject({ type: z.literal("corpus"), allowlist: allowlist.optional() }),
]);
const persistedError = z.strictObject({
  _tag: z.enum(["UnsupportedVersion", "MalformedSerialization", "CorruptPersistedFields"]),
  table: z.string(),
  field: z.string(),
  version: z.number(),
  recordId: z.string(),
  message: z.string(),
  issueCode: z.enum([
    "unsupported-version",
    "malformed-json",
    "invalid-row-version",
    "missing-required-field",
    "invalid-row-field",
    "invalid-string-array",
    "mixed-string-array",
    "invalid-aboutness",
    "invalid-importance",
    "invalid-transcript-row",
    "invalid-transcript-messages",
    "invalid-compaction-context",
    "invalid-provider-state",
    "invalid-surface-projection",
    "invalid-lineage-manifest",
    "digest-mismatch",
  ]),
});
const requestSchema = z.strictObject({
  id: z.string(),
  searchDbPath: z.string(),
  surfaceDbPath: z.string().optional(),
  nativeDbPath: z.string().optional(),
  botName: z.string().optional(),
  operation,
});
const responseSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: z.string(), type: z.literal("hits"), hits: z.array(hit) }),
  z.strictObject({ id: z.string(), type: z.literal("strings"), strings: z.array(z.string()) }),
  z.strictObject({ id: z.string(), type: z.literal("persisted-error"), error: persistedError }),
  z.strictObject({ id: z.string(), type: z.literal("failed"), message: z.string() }),
]);
export type ThreadSearchOperation = z.infer<typeof operation>;
export type ThreadSearchRequest = z.infer<typeof requestSchema>;
export type ThreadSearchResponse = z.infer<typeof responseSchema>;
export class ThreadSearchProtocolError extends TaggedError("ThreadSearchProtocolError")<{
  message: string;
}> {}
export function decodeThreadSearchRequest(
  event: MessageEvent<unknown>,
): ResultType<ThreadSearchRequest, ThreadSearchProtocolError> {
  const decoded = requestSchema.safeParse(event.data);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(
        new ThreadSearchProtocolError({ message: "Invalid thread search worker request" }),
      );
}
export function decodeThreadSearchResponse(
  event: MessageEvent<unknown>,
): ResultType<ThreadSearchResponse, ThreadSearchProtocolError> {
  const decoded = responseSchema.safeParse(event.data);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(
        new ThreadSearchProtocolError({ message: "Invalid thread search worker response" }),
      );
}
