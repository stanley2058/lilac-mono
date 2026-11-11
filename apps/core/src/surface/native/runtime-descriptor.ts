import type { SurfaceQuestionPort } from "../question";
import { Result } from "better-result";

import type { SurfaceAdapter, SurfaceOperationResult } from "../adapter";
import {
  workflowProgressOperationFailure,
  type SurfaceRequestIngress,
  type SurfaceRuntimeDescriptor,
  type SurfaceRuntimeHealthPort,
  type SurfaceWorkflowProgressPort,
} from "../runtime-descriptor";
import type { SurfaceThreadControlPort } from "../thread-control";
import type { NativeSurfaceAdapter } from "./adapter";
import { nativeSurfaceProtocol } from "./native-protocol";

export type NativeWorkflowAdapterResolver = (
  threadId: string,
) => SurfaceOperationResult<NativeSurfaceAdapter>;

export function createNativeWorkflowProgressPort(
  resolveAdapter: NativeWorkflowAdapterResolver,
): SurfaceWorkflowProgressPort<"native"> {
  return {
    configurationRevision: "native-workflow-progress-v1",
    checkMessage: async (target) => {
      const checked = await Result.gen(async function* () {
        const adapter = yield* resolveAdapter(target.channelId);
        return await adapter.readMsg({ platform: "native", ...target });
      });
      return checked.match<
        Awaited<ReturnType<SurfaceWorkflowProgressPort<"native">["checkMessage"]>>
      >({
        ok: (message) => Result.ok(message ? ("found" as const) : ("missing" as const)),
        err: (error) =>
          error._tag === "SurfaceMessageNotFound"
            ? Result.ok("missing" as const)
            : Result.err({
                kind: "failed" as const,
                error: workflowProgressOperationFailure("check-message", error),
              }),
      });
    },
    send: async (input) => {
      const sent = await Result.gen(async function* () {
        const adapter = yield* resolveAdapter(input.channelId);
        return await adapter.sendMsg(
          { platform: "native", channelId: input.channelId },
          input.content,
          {
            silent: input.silent,
            ...(input.replyToMessageId
              ? {
                  replyTo: {
                    platform: "native" as const,
                    channelId: input.channelId,
                    messageId: input.replyToMessageId,
                  },
                }
              : {}),
          },
        );
      });
      return sent.match<Awaited<ReturnType<SurfaceWorkflowProgressPort<"native">["send"]>>>({
        ok: (ref) =>
          Result.ok({
            platform: "native" as const,
            channelId: ref.channelId,
            messageId: ref.messageId,
          }),
        err: (error) =>
          error._tag === "SurfaceOperationPartiallyCompleted"
            ? Result.err({
                kind: "created" as const,
                ref: {
                  platform: "native" as const,
                  channelId: error.created.channelId,
                  messageId: error.created.messageId,
                },
              })
            : Result.err({
                kind: "failed" as const,
                error: workflowProgressOperationFailure("send", error),
              }),
      });
    },
    edit: async (target, content) => {
      const edited = await Result.gen(async function* () {
        const adapter = yield* resolveAdapter(target.channelId);
        return await adapter.editMsg({ platform: "native", ...target }, content);
      });
      return edited.match<Awaited<ReturnType<SurfaceWorkflowProgressPort<"native">["edit"]>>>({
        ok: () => Result.ok(undefined),
        err: (error) =>
          error._tag === "SurfaceMessageNotFound"
            ? Result.err({ kind: "not-found" as const })
            : Result.err({
                kind: "failed" as const,
                error: workflowProgressOperationFailure("edit", error),
              }),
      });
    },
  };
}

export function createNativeSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly question?: SurfaceQuestionPort<"native">;
  readonly threadControl?: SurfaceThreadControlPort;
  readonly resolveWorkflowAdapter: NativeWorkflowAdapterResolver;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly health?: SurfaceRuntimeHealthPort;
}): SurfaceRuntimeDescriptor<"native"> {
  return {
    protocol: nativeSurfaceProtocol,
    adapter: input.adapter,
    ...(input.question ? { createQuestion: () => input.question! } : {}),
    ...(input.threadControl ? { createThreadControl: () => input.threadControl! } : {}),
    createWorkflowProgress: () => createNativeWorkflowProgressPort(input.resolveWorkflowAdapter),
    ...(input.requestIngress ? { requestIngress: input.requestIngress } : {}),
    ...(input.health ? { health: input.health } : {}),
  };
}
