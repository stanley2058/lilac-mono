import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";
import {
  workerMemorySampleMessageSchema,
  workerMemoryWatchdogExceededMessageSchema,
} from "./worker-memory-watchdog";

export const threadMaterializerRepairKindSchema = z.enum(["content", "topology"]);

const workerRequestBaseSchema = z
  .object({
    id: z.string().min(1),
    searchDbPath: z.string().min(1),
    surfaceDbPath: z.string().min(1).optional(),
  })
  .strict();

export const threadMaterializerWorkerRequestSchema = z.union([
  workerRequestBaseSchema.extend({ type: z.literal("list-channels") }),
  workerRequestBaseSchema.extend({
    type: z.literal("repair-channel"),
    channelId: z.string().min(1),
    kind: z.literal("content"),
    messageIds: z.array(z.string().min(1)).min(1),
  }),
  workerRequestBaseSchema.extend({
    type: z.literal("repair-channel"),
    channelId: z.string().min(1),
    kind: z.literal("topology"),
  }),
]);

export type ThreadMaterializerWorkerRequest = z.infer<typeof threadMaterializerWorkerRequestSchema>;

export const threadMaterializerWorkerResponseSchema = z.union([
  z
    .object({
      id: z.string().min(1),
      ok: z.literal(true),
      type: z.literal("list-channels"),
      channelIds: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      ok: z.literal(true),
      type: z.literal("repair-channel"),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      ok: z.literal(false),
      error: z.string().min(1),
    })
    .strict(),
  workerMemorySampleMessageSchema,
  workerMemoryWatchdogExceededMessageSchema,
]);

export type ThreadMaterializerWorkerResponse = z.infer<
  typeof threadMaterializerWorkerResponseSchema
>;

export class ThreadMaterializerWorkerRequestDecodeError extends TaggedError(
  "ThreadMaterializerWorkerRequestDecodeError",
)<{ readonly message: string }> {}

export class ThreadMaterializerWorkerResponseDecodeError extends TaggedError(
  "ThreadMaterializerWorkerResponseDecodeError",
)<{ readonly message: string }> {}

export function decodeThreadMaterializerWorkerRequest(
  input: unknown,
): ResultType<ThreadMaterializerWorkerRequest, ThreadMaterializerWorkerRequestDecodeError> {
  const decoded = threadMaterializerWorkerRequestSchema.safeParse(input);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(
        new ThreadMaterializerWorkerRequestDecodeError({
          message: "Invalid conversation thread materializer worker request",
        }),
      );
}

export function decodeThreadMaterializerWorkerResponse(
  input: unknown,
): ResultType<ThreadMaterializerWorkerResponse, ThreadMaterializerWorkerResponseDecodeError> {
  const decoded = threadMaterializerWorkerResponseSchema.safeParse(input);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(
        new ThreadMaterializerWorkerResponseDecodeError({
          message: "Invalid conversation thread materializer worker response",
        }),
      );
}
