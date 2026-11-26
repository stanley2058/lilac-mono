import { randomUUID } from "node:crypto";
import { createLogger } from "@stanley2058/lilac-utils";
import { identitySchema, replayCheckpointSchema } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import { z } from "zod";

const logger = createLogger({ module: "surface:native:metrics" });
type Fields = Record<string, string | number | boolean | undefined>;
export type NativeMetricSink = (event: string, fields: Fields) => void;
const checkpointInput = z.object({
  threadId: identitySchema,
  checkpoint: replayCheckpointSchema.optional(),
});
const requestFrame = z.object({
  i: z.string(),
  t: z.number().optional(),
  p: z.object({ u: z.string(), b: z.object({ json: z.unknown() }).optional() }).optional(),
});
const replay = z.object({
  kind: z.enum(["unchanged", "delta", "window"]),
  checkpoint: replayCheckpointSchema,
});
const replayEnvelope = z.union([
  replay,
  z.object({ reply: replay }),
  z.object({ selectedThread: replay }),
]);
const responseFrame = z.object({
  i: z.string(),
  t: z.number().optional(),
  p: z
    .object({
      e: z.string().optional(),
      d: z.object({ json: z.unknown() }).optional(),
      b: z.object({ json: z.unknown() }).optional(),
    })
    .optional(),
});

function parseJson(value: string): unknown {
  return Result.try({
    try: (): unknown => JSON.parse(value),
    catch: () => new Error("Invalid metric frame"),
  }).match({ ok: (parsed) => parsed, err: () => undefined });
}

function decodeMetricRequest(message: string) {
  const frame = requestFrame.safeParse(parseJson(message));
  if (!frame.success) return undefined;
  const input = checkpointInput.safeParse(frame.data.p?.b?.json);
  return {
    id: frame.data.i,
    abort: frame.data.t === 4,
    threadId: input.success ? input.data.threadId : undefined,
    cached: input.success && input.data.checkpoint !== undefined,
  };
}

function decodeMetricResponse(message: string) {
  const frame = responseFrame.safeParse(parseJson(message));
  if (!frame.success) return undefined;
  const parsed = replayEnvelope.safeParse(frame.data.p?.d?.json ?? frame.data.p?.b?.json);
  const value = parsed.success ? parsed.data : undefined;
  const selected = value && "selectedThread" in value ? value.selectedThread : value;
  const reply = selected && "reply" in selected ? selected.reply : selected;
  return {
    id: frame.data.i,
    terminal: frame.data.p?.e === "done" || frame.data.p?.e === "error",
    unary: frame.data.t !== 3 && frame.data.p?.b !== undefined,
    reply,
  };
}

function byteLength(message: string | ArrayBufferLike | Uint8Array): number {
  return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
}

export function createNativeMetrics(
  emit: NativeMetricSink = (event, fields) => logger.debug(event, fields),
  now: () => number = () => performance.now(),
) {
  const commits = new Map<
    string,
    { revision: number; generation: number; requestId: string; at: number }
  >();
  function committed(
    threadId: string,
    revision: number,
    generation: number,
    requestId: string,
    at = now(),
  ) {
    const previous = commits.get(threadId);
    if (previous?.revision === revision && previous.generation === generation) return;
    commits.delete(threadId);
    commits.set(threadId, { revision, generation, requestId, at });
    if (commits.size > 1024) commits.delete(commits.keys().next().value!);
  }
  function connection() {
    const connectionId = randomUUID();
    const opened = now();
    const requests = new Map<string, { rpcId: string; threadId?: string; cached: boolean }>();
    let receivedBytes = 0;
    let sentBytes = 0;
    function received(message: string | Uint8Array) {
      const bytes = byteLength(message);
      receivedBytes += bytes;
      if (typeof message !== "string") return;
      const frame = decodeMetricRequest(message);
      if (!frame) return;
      if (frame.abort) {
        requests.delete(frame.id);
        return;
      }
      const request = { rpcId: randomUUID(), threadId: frame.threadId, cached: frame.cached };
      requests.set(frame.id, request);
      if (requests.size > 128) requests.delete(requests.keys().next().value!);
    }
    function sent(message: string | ArrayBufferLike | Uint8Array, result: number) {
      const enqueuedAt = now();
      const bytes = byteLength(message);
      if (result !== 0) sentBytes += bytes;
      if (typeof message !== "string") return;
      const frame = decodeMetricResponse(message);
      if (!frame) return;
      const request = requests.get(frame.id);
      if (!request) return;
      if (frame.terminal || frame.unary) requests.delete(frame.id);
      const reply = frame.reply;
      if (!reply || result === 0) return;
      const committed = request.threadId ? commits.get(request.threadId) : undefined;
      const matched =
        reply.kind !== "unchanged" &&
        committed?.revision === reply.checkpoint.projectionRevision &&
        committed.generation === reply.checkpoint.historyGeneration;
      emit("replay.enqueue", {
        connectionId,
        rpcId: request.rpcId,
        threadId: request.threadId,
        requestId: matched ? committed.requestId : undefined,
        bytes,
        kind: reply.kind,
        cacheReset: request.cached && reply.kind === "window",
        commitToSocketEnqueueMs: matched ? enqueuedAt - committed.at : undefined,
      });
      request.cached = true;
    }
    return {
      opened: () => emit("connection.open", { connectionId }),
      received,
      sent,
      pressure: (inflight: number) => emit("connection.limit", { connectionId, inflight }),
      closed: (code: number) =>
        emit("connection.close", {
          connectionId,
          code,
          receivedBytes,
          sentBytes,
          durationMs: now() - opened,
        }),
    };
  }
  return {
    committed,
    connection,
    bootstrap: (durationMs: number, status: number) =>
      emit("bootstrap.complete", { durationMs, status }),
    queue: (threadId: string, uploading: number, queued: number, admitted: number) =>
      emit("queue.pressure", { threadId, uploading, queued, admitted }),
    handoffFailure: (stage: "admission" | "projection", threadId: string, requestId: string) =>
      emit("handoff.failed", { stage, threadId, requestId }),
  };
}
export type NativeMetrics = ReturnType<typeof createNativeMetrics>;
