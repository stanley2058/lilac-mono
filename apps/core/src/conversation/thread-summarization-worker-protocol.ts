import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";
import {
  workerMemorySampleMessageSchema,
  workerMemoryWatchdogExceededMessageSchema,
  type WorkerMemoryWatchdogEvent,
} from "./worker-memory-watchdog";

const nonemptyStringSchema = z.string().min(1);
const countSchema = z.number().int().nonnegative();
const discordMessageRefSchema = z.strictObject({
  surface: z.enum(["discord", "native"]).optional(),
  channelId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});
const discordAttachmentSchema = z.strictObject({
  data: z.instanceof(Uint8Array).optional(),
  id: nonemptyStringSchema.optional(),
  url: z.url(),
  filename: nonemptyStringSchema.optional(),
  mimeType: nonemptyStringSchema.optional(),
  size: countSchema.optional(),
});

const threadSummarizationInputSchema = z.strictObject({
  jobId: nonemptyStringSchema.optional(),
  trigger: z.enum(["manual", "periodic"]).optional(),
  dryRun: z.boolean().optional(),
  wait: z.boolean().optional(),
  force: z.boolean().optional(),
  clear: z.boolean().optional(),
  limit: z.number().optional(),
  threadId: nonemptyStringSchema.optional(),
  beforeTs: z.number().optional(),
  afterTs: z.number().optional(),
  now: z.number().optional(),
});

const eligibilityReasonCountsSchema = z.strictObject({
  forced: countSchema.optional(),
  "never-summarized": countSchema.optional(),
  "content-changed": countSchema.optional(),
  "summary-version": countSchema.optional(),
  "embedding-missing": countSchema.optional(),
  "embedding-outdated": countSchema.optional(),
  "embedding-version": countSchema.optional(),
  "embedding-model": countSchema.optional(),
});

export const threadSummarizationResultSchema = z.strictObject({
  dryRun: z.boolean(),
  refreshed: z.strictObject({
    channels: countSchema,
    threads: countSchema,
    messages: countSchema,
  }),
  eligible: countSchema,
  eligibleTotal: countSchema,
  eligibility: z.strictObject({
    summary: countSchema,
    embeddingOnly: countSchema,
    reasons: eligibilityReasonCountsSchema,
  }),
  cleared: countSchema,
  summarized: countSchema,
  failed: countSchema,
  failures: z.array(
    z.strictObject({ threadId: nonemptyStringSchema, error: nonemptyStringSchema }),
  ),
  threadIds: z.array(nonemptyStringSchema),
  jobId: nonemptyStringSchema.optional(),
  status: z.enum(["queued", "completed"]).optional(),
});

export type ThreadSummarizationResult = z.infer<typeof threadSummarizationResultSchema>;

export const threadSummarizationWorkerRequestSchema = z.strictObject({
  id: nonemptyStringSchema,
  input: threadSummarizationInputSchema,
  searchDbPath: nonemptyStringSchema,
  surfaceDbPath: nonemptyStringSchema.optional(),
  nativeDbPath: nonemptyStringSchema.optional(),
});

export type ThreadSummarizationWorkerRequest = z.infer<
  typeof threadSummarizationWorkerRequestSchema
>;

export const threadSummarizationWorkerResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    id: nonemptyStringSchema,
    ok: z.literal(true),
    result: threadSummarizationResultSchema,
  }),
  z.strictObject({
    id: nonemptyStringSchema,
    ok: z.literal(false),
    error: nonemptyStringSchema,
  }),
]);

export type ThreadSummarizationWorkerResponse = z.infer<
  typeof threadSummarizationWorkerResponseSchema
>;

export const threadSummarizationHydrationRequestSchema = z.strictObject({
  type: z.literal("hydrate-discord-attachments"),
  id: nonemptyStringSchema,
  refs: z.array(discordMessageRefSchema).min(1).max(200),
});

export const threadSummarizationHydrationResponseSchema = z.strictObject({
  type: z.literal("hydrate-discord-attachments-result"),
  id: nonemptyStringSchema,
  results: z.array(
    z.discriminatedUnion("ok", [
      z.strictObject({
        ref: discordMessageRefSchema,
        ok: z.literal(true),
        attachments: z.array(discordAttachmentSchema),
      }),
      z.strictObject({
        ref: discordMessageRefSchema,
        ok: z.literal(false),
        error: nonemptyStringSchema,
      }),
    ]),
  ),
});

export type ThreadSummarizationHydrationRequest = z.infer<
  typeof threadSummarizationHydrationRequestSchema
>;
export type ThreadSummarizationHydrationResponse = z.infer<
  typeof threadSummarizationHydrationResponseSchema
>;
export type ThreadSummarizationParentMessage =
  | ThreadSummarizationWorkerRequest
  | ThreadSummarizationHydrationResponse;
export type ThreadSummarizationWorkerMessage =
  | ThreadSummarizationWorkerResponse
  | ThreadSummarizationHydrationRequest
  | WorkerMemoryWatchdogEvent;

export class ThreadSummarizationWorkerRequestDecodeError extends TaggedError(
  "ThreadSummarizationWorkerRequestDecodeError",
)<{
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class ThreadSummarizationWorkerResponseDecodeError extends TaggedError(
  "ThreadSummarizationWorkerResponseDecodeError",
)<{
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class ThreadSummarizationParentMessageDecodeError extends TaggedError(
  "ThreadSummarizationParentMessageDecodeError",
)<{ readonly issues: readonly string[]; readonly message: string }> {}

export class ThreadSummarizationWorkerMessageDecodeError extends TaggedError(
  "ThreadSummarizationWorkerMessageDecodeError",
)<{ readonly issues: readonly string[]; readonly message: string }> {}

function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}

export function decodeThreadSummarizationWorkerRequest(
  input: unknown,
): ResultType<ThreadSummarizationWorkerRequest, ThreadSummarizationWorkerRequestDecodeError> {
  const parsed = threadSummarizationWorkerRequestSchema.safeParse(input);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new ThreadSummarizationWorkerRequestDecodeError({
      issues: formatIssues(parsed.error),
      message: "Invalid conversation thread summarization worker request",
    }),
  );
}

export function decodeThreadSummarizationWorkerResponse(
  input: unknown,
): ResultType<ThreadSummarizationWorkerResponse, ThreadSummarizationWorkerResponseDecodeError> {
  const parsed = threadSummarizationWorkerResponseSchema.safeParse(input);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new ThreadSummarizationWorkerResponseDecodeError({
      issues: formatIssues(parsed.error),
      message: "Invalid conversation thread summarization worker response",
    }),
  );
}

export function decodeThreadSummarizationParentMessage(
  input: unknown,
): ResultType<ThreadSummarizationParentMessage, ThreadSummarizationParentMessageDecodeError> {
  const parsed = z
    .union([threadSummarizationWorkerRequestSchema, threadSummarizationHydrationResponseSchema])
    .safeParse(input);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new ThreadSummarizationParentMessageDecodeError({
      issues: formatIssues(parsed.error),
      message: "Invalid conversation thread summarization parent message",
    }),
  );
}

export function decodeThreadSummarizationWorkerMessage(
  input: unknown,
): ResultType<ThreadSummarizationWorkerMessage, ThreadSummarizationWorkerMessageDecodeError> {
  const parsed = z
    .union([
      threadSummarizationWorkerResponseSchema,
      threadSummarizationHydrationRequestSchema,
      workerMemorySampleMessageSchema,
      workerMemoryWatchdogExceededMessageSchema,
    ])
    .safeParse(input);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new ThreadSummarizationWorkerMessageDecodeError({
      issues: formatIssues(parsed.error),
      message: "Invalid conversation thread summarization worker message",
    }),
  );
}
