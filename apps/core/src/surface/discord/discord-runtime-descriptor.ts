import type { CoreConfig } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import type { SurfaceAdapter, SurfaceOperationError } from "../adapter";
import { resolveBuiltinSurfaceRequestMessageRef } from "../builtin-surface-protocols";
import { discordSurfaceProtocol } from "./discord-surface-protocol";
import type {
  SurfaceAdapterIngress,
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceRuntimeHealthPort,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
  WorkflowProgressOperationFailed,
} from "../runtime-descriptor";
import { workflowProgressOperationFailure } from "../runtime-descriptor";
import {
  createDiscordQuestionPort,
  type DiscordQuestionAnswerSource,
} from "./discord-question-port";
import { createDiscordThreadControl } from "./discord-thread-control";

type DiscordWorkflowProgressOperation = "check-message" | "send" | "edit";
type DiscordCheckMessageResult = Awaited<
  ReturnType<SurfaceWorkflowProgressPort<"discord">["checkMessage"]>
>;
type DiscordSendResult = Awaited<ReturnType<SurfaceWorkflowProgressPort<"discord">["send"]>>;
type DiscordEditResult = Awaited<ReturnType<SurfaceWorkflowProgressPort<"discord">["edit"]>>;

// Bump when the declared workflow operation contract or failure policy changes.
export const DISCORD_WORKFLOW_PROGRESS_CONFIGURATION_REVISION = "discord-workflow-progress-v1";

function discordWorkflowError(
  operation: DiscordWorkflowProgressOperation,
  error: SurfaceOperationError,
): { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed } {
  return { kind: "failed", error: workflowProgressOperationFailure(operation, error) };
}

export function createDiscordWorkflowProgressPort(
  adapter: SurfaceAdapter,
): SurfaceWorkflowProgressPort<"discord"> {
  return {
    configurationRevision: DISCORD_WORKFLOW_PROGRESS_CONFIGURATION_REVISION,
    checkMessage: async (target) => {
      const checked = await adapter.readMsg({
        platform: "discord",
        channelId: target.channelId,
        messageId: target.messageId,
      });
      return checked.match<DiscordCheckMessageResult>({
        err: (error) =>
          error._tag === "SurfaceMessageNotFound"
            ? Result.ok("missing")
            : Result.err(discordWorkflowError("check-message", error)),
        ok: (value) => Result.ok(value ? "found" : "missing"),
      });
    },
    send: async (input) => {
      const sent = await adapter.sendMsg(
        { platform: "discord", channelId: input.channelId },
        input.content,
        input.replyToMessageId
          ? {
              replyTo: {
                platform: "discord",
                channelId: input.channelId,
                messageId: input.replyToMessageId,
              },
              silent: input.silent,
            }
          : { silent: input.silent },
      );
      return sent.match<DiscordSendResult>({
        err: (error) => {
          if (error._tag === "SurfaceOperationPartiallyCompleted") {
            const created = error.created;
            if (created.platform === "discord") {
              return Result.err({
                kind: "created",
                ref: {
                  platform: "discord",
                  channelId: created.channelId,
                  messageId: created.messageId,
                },
              });
            }
          }
          return Result.err(discordWorkflowError("send", error));
        },
        ok: (value) =>
          Result.ok({
            platform: "discord",
            channelId: value.channelId,
            messageId: value.messageId,
          }),
      });
    },
    edit: async (target, content) => {
      const edited = await adapter.editMsg(
        {
          platform: "discord",
          channelId: target.channelId,
          messageId: target.messageId,
        },
        content,
      );
      return edited.match<DiscordEditResult>({
        ok: () => Result.ok(undefined),
        err: (error) =>
          error._tag === "SurfaceMessageNotFound"
            ? Result.err({ kind: "not-found" })
            : Result.err(discordWorkflowError("edit", error)),
      });
    },
  };
}

async function adaptDiscordSkippedOutputCleanupResultToHost(
  adapter: SurfaceAdapter,
  ref: Parameters<SurfaceAdapter["deleteMsg"]>[0],
): Promise<void> {
  const deleted = await adapter.deleteMsg(ref);
  deleted.match<() => void>({
    ok: () => () => undefined,
    err: (error) => () => {
      throw error;
    },
  })();
}

export function createDiscordRelayPolicy(adapter: SurfaceAdapter): SurfaceRelayPolicy<"discord"> {
  return {
    refs: {
      createSessionRef: discordSurfaceProtocol.refs.createSessionRef,
      resolveInitialReplyTarget: ({ requestId, sessionId }) =>
        resolveBuiltinSurfaceRequestMessageRef({
          protocol: discordSurfaceProtocol,
          requestId,
          sessionRef: discordSurfaceProtocol.refs.createSessionRef(sessionId),
        }),
      decodeReanchorTarget: discordSurfaceProtocol.refs.decodeMessageRef,
    },
    finalization: {
      cleanupSkippedOutput: async ({ ref }) =>
        adaptDiscordSkippedOutputCleanupResultToHost(adapter, ref),
    },
  };
}

export function createDiscordSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly questionAnswers?: DiscordQuestionAnswerSource;
  readonly adapterIngress: SurfaceAdapterIngress<"discord">;
  readonly health?: SurfaceRuntimeHealthPort;
  readonly createRelay: (guardedAdapter: SurfaceAdapter) => SurfaceRelayDescriptor<"discord">;
  readonly getConfig: () => Promise<CoreConfig>;
}): SurfaceRuntimeDescriptor<"discord"> {
  const questionAnswers = input.questionAnswers;
  return {
    protocol: discordSurfaceProtocol,
    adapter: input.adapter,
    adapterIngress: input.adapterIngress,
    ...(input.health ? { health: input.health } : {}),
    createRelay: input.createRelay,
    createWorkflowProgress: createDiscordWorkflowProgressPort,
    createThreadControl: (guardedAdapter: SurfaceAdapter) =>
      createDiscordThreadControl({ adapter: guardedAdapter, getConfig: input.getConfig }),
    ...(questionAnswers
      ? {
          createQuestion: (guardedAdapter: SurfaceAdapter) =>
            createDiscordQuestionPort({ adapter: guardedAdapter, answers: questionAnswers }),
        }
      : {}),
  };
}
