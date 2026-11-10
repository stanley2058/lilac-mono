import { captureError } from "../../shared/error-capture";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import {
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
  getGithubWebBaseUrl,
  GithubApiError,
} from "../../github/github-api";
import { githubReplyPrefix, parseGithubSessionId } from "../../github/github-ids";
import { markGithubAgentComment } from "../../github/github-comment-marker";
import {
  clearGithubAck,
  clearGithubRequest,
  getGithubAck,
  getGithubLatestRequestForSession,
  getGithubRequestMeta,
  type GithubAckState,
} from "../../github/github-state";
import type { SurfaceAdapter, SurfaceOperationError } from "../adapter";
import type { ContentOpts } from "../types";
import { resolveBuiltinSurfaceRequestMessageRef } from "../builtin-surface-protocols";
import { githubSurfaceProtocol } from "./github-surface-protocol";
import type {
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceRequestIngress,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
  WorkflowProgressOperationFailed,
  WorkflowProgressSendInput,
} from "../runtime-descriptor";
import {
  SurfaceIngressAcknowledgementCleanupFailed,
  workflowProgressOperationFailure,
} from "../runtime-descriptor";

type GithubWorkflowProgressOperation = "check-message" | "send" | "edit";
type GithubCheckMessageResult = Awaited<
  ReturnType<SurfaceWorkflowProgressPort<"github">["checkMessage"]>
>;
type GithubSendResult = Awaited<ReturnType<SurfaceWorkflowProgressPort<"github">["send"]>>;
type GithubEditResult = Awaited<ReturnType<SurfaceWorkflowProgressPort<"github">["edit"]>>;

// Bump when the declared workflow operation contract or failure policy changes.
export const GITHUB_WORKFLOW_PROGRESS_CONFIGURATION_REVISION = "github-workflow-progress-v1";

function githubWorkflowError(
  operation: GithubWorkflowProgressOperation,
  error: SurfaceOperationError,
): { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed } {
  return { kind: "failed", error: workflowProgressOperationFailure(operation, error) };
}

export type GithubWorkflowProgressApi = {
  readonly getGithubWebBaseUrl: typeof getGithubWebBaseUrl;
};

const DEFAULT_GITHUB_WORKFLOW_PROGRESS_API: GithubWorkflowProgressApi = { getGithubWebBaseUrl };

/** GitHub comments have no native reply target, so replies carry a permalink prefix instead. */
async function composeGithubWorkflowSendContent(
  input: WorkflowProgressSendInput,
  api: GithubWorkflowProgressApi,
): Promise<ContentOpts> {
  if (!input.replyToMessageId) return input.content;
  const prefix = githubReplyPrefix({
    sessionId: input.channelId,
    messageId: input.replyToMessageId,
    webBaseUrl: await api.getGithubWebBaseUrl(),
  });
  return { ...input.content, text: `${prefix}${input.content.text ?? ""}` };
}

export function createGithubWorkflowProgressPort(
  adapter: SurfaceAdapter,
  api: GithubWorkflowProgressApi = DEFAULT_GITHUB_WORKFLOW_PROGRESS_API,
): SurfaceWorkflowProgressPort<"github"> {
  return {
    configurationRevision: GITHUB_WORKFLOW_PROGRESS_CONFIGURATION_REVISION,
    checkMessage: async (target) => {
      const checked = await adapter.readMsg({
        platform: "github",
        channelId: target.channelId,
        messageId: target.messageId,
      });
      return checked.match<GithubCheckMessageResult>({
        err: (error) =>
          error._tag === "SurfaceMessageNotFound"
            ? Result.ok("missing")
            : Result.err(githubWorkflowError("check-message", error)),
        ok: (value) => Result.ok(value ? "found" : "missing"),
      });
    },
    send: async (input) => {
      const content = await composeGithubWorkflowSendContent(input, api);
      const sent = await adapter.sendMsg(
        { platform: "github", channelId: input.channelId },
        content,
        { silent: input.silent },
      );
      return sent.match<GithubSendResult>({
        err: (error) => {
          if (error._tag === "SurfaceOperationPartiallyCompleted") {
            return Result.err({
              kind: "created",
              ref: {
                platform: "github",
                channelId: error.created.channelId,
                messageId: error.created.messageId,
              },
            });
          }
          return Result.err(githubWorkflowError("send", error));
        },
        ok: (value) =>
          Result.ok({
            platform: "github",
            channelId: value.channelId,
            messageId: value.messageId,
          }),
      });
    },
    edit: async (target, content) => {
      const edited = await adapter.editMsg(
        {
          platform: "github",
          channelId: target.channelId,
          messageId: target.messageId,
        },
        {
          ...content,
          text: markGithubAgentComment(content.text ?? ""),
        },
      );
      return edited.match<GithubEditResult>({
        ok: () => Result.ok(undefined),
        err: (error) =>
          error._tag === "SurfaceMessageNotFound"
            ? Result.err({ kind: "not-found" })
            : Result.err(githubWorkflowError("edit", error)),
      });
    },
  };
}

export type GithubAcknowledgementApi = {
  readonly deleteIssueReactionById: typeof deleteIssueReactionById;
  readonly deleteIssueCommentReactionById: typeof deleteIssueCommentReactionById;
};

const DEFAULT_GITHUB_ACKNOWLEDGEMENT_API: GithubAcknowledgementApi = {
  deleteIssueReactionById,
  deleteIssueCommentReactionById,
};

class GithubAcknowledgementDeleteFailed extends TaggedError("GithubAcknowledgementDeleteFailed")<{
  readonly cause: unknown;
  readonly isNotFound: boolean;
  readonly message: string;
}> {}

export function preserveGithubRelayPolicyPanic(cause: unknown): void {
  if (Panic.is(cause)) throw cause;
}

export async function deleteGithubAcknowledgement(
  input: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly ack: GithubAckState;
  },
  api: GithubAcknowledgementApi,
): Promise<ResultType<void, GithubAcknowledgementDeleteFailed>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        const meta = getGithubRequestMeta(input.requestId);
        const thread = (() => {
          if (meta?.repoFullName) {
            const [owner, repo] = meta.repoFullName.split("/");
            if (owner && repo) return { owner, repo };
          }
          return parseGithubSessionId(input.sessionId);
        })();
        if (input.ack.target.kind === "issue") {
          await api.deleteIssueReactionById({
            owner: thread.owner,
            repo: thread.repo,
            issueNumber: input.ack.target.issueNumber,
            reactionId: input.ack.reactionId,
          });
        } else {
          await api.deleteIssueCommentReactionById({
            owner: thread.owner,
            repo: thread.repo,
            commentId: input.ack.target.commentId,
            reactionId: input.ack.reactionId,
          });
        }
        return Result.ok(undefined);
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      preserveGithubRelayPolicyPanic(cause);
      return Result.err(
        new GithubAcknowledgementDeleteFailed({
          cause,
          isNotFound: cause instanceof GithubApiError && cause.status === 404,
          message: "Failed to delete GitHub acknowledgement reaction",
        }),
      );
    }
    return attempt.value;
  }
}

async function clearGithubIngressAcknowledgement(
  input: {
    readonly requestId: string;
    readonly sessionId: string;
  },
  api: GithubAcknowledgementApi,
): Promise<ResultType<void, SurfaceIngressAcknowledgementCleanupFailed>> {
  const ack = getGithubAck(input.requestId);
  if (!ack) {
    clearGithubRequest(input.requestId);
    return Result.ok(undefined);
  }

  const deleted = await deleteGithubAcknowledgement(
    {
      requestId: input.requestId,
      sessionId: input.sessionId,
      ack,
    },
    api,
  ).finally(() => {
    clearGithubAck(input.requestId);
    clearGithubRequest(input.requestId);
  });

  return deleted.match<ResultType<void, SurfaceIngressAcknowledgementCleanupFailed>>({
    ok: () => Result.ok(undefined),
    err: (error) =>
      error.isNotFound
        ? Result.ok(undefined)
        : Result.err(
            new SurfaceIngressAcknowledgementCleanupFailed({
              cause: formatTaggedErrorForLog(error),
              message: "Failed to clear surface ingress acknowledgement",
            }),
          ),
  });
}

export function createGithubRelayPolicy(
  input: {
    readonly acknowledgementApi?: GithubAcknowledgementApi;
  } = {},
): SurfaceRelayPolicy<"github"> {
  const acknowledgementApi = input.acknowledgementApi ?? DEFAULT_GITHUB_ACKNOWLEDGEMENT_API;
  return {
    refs: {
      createSessionRef: githubSurfaceProtocol.refs.createSessionRef,
      resolveInitialReplyTarget: ({ requestId, sessionId }) =>
        resolveBuiltinSurfaceRequestMessageRef({
          protocol: githubSurfaceProtocol,
          requestId,
          sessionRef: githubSurfaceProtocol.refs.createSessionRef(sessionId),
        }),
      decodeReanchorTarget: githubSurfaceProtocol.refs.decodeMessageRef,
    },
    finalization: {
      isFinalResponseSuperseded: ({ requestId, sessionId }) => {
        const latest = getGithubLatestRequestForSession(sessionId);
        return (
          getGithubRequestMeta(requestId)?.superseded === true ||
          (latest !== undefined && latest !== requestId)
        );
      },
      clearIngressAcknowledgement: (finalizationInput) =>
        clearGithubIngressAcknowledgement(finalizationInput, acknowledgementApi),
    },
  };
}

export function createGithubSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly createRelay?: (guardedAdapter: SurfaceAdapter) => SurfaceRelayDescriptor<"github">;
}): SurfaceRuntimeDescriptor<"github"> {
  return {
    protocol: githubSurfaceProtocol,
    adapter: input.adapter,
    ...(input.requestIngress ? { requestIngress: input.requestIngress } : {}),
    ...(input.createRelay ? { createRelay: input.createRelay } : {}),
    createWorkflowProgress: createGithubWorkflowProgressPort,
  };
}

type GithubSurfaceRuntimeCompositionLogger = {
  info(message: string, context: Readonly<Record<string, string>>): void;
  warn(message: string, context: Readonly<Record<string, string>>): void;
};

export function createConfiguredGithubSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly webhookSecret: string | undefined;
  readonly appCredentialsAvailable: boolean;
  readonly requestIngress: SurfaceRequestIngress;
  readonly createRelay: (guardedAdapter: SurfaceAdapter) => SurfaceRelayDescriptor<"github">;
  readonly logger: GithubSurfaceRuntimeCompositionLogger;
}): SurfaceRuntimeDescriptor<"github"> {
  const requestIngressAvailable = Boolean(input.webhookSecret) && input.appCredentialsAvailable;
  if (!requestIngressAvailable) {
    input.logger.warn("GitHub webhook ingress unavailable", {
      subsystem: "request-ingress",
      reason: input.webhookSecret ? "app-credentials-missing" : "webhook-secret-missing",
    });
  }
  if (!input.appCredentialsAvailable) {
    input.logger.info("GitHub output relay unavailable", {
      subsystem: "output-relay",
      reason: "app-credentials-missing",
    });
  }
  return createGithubSurfaceRuntimeDescriptor({
    adapter: input.adapter,
    ...(requestIngressAvailable ? { requestIngress: input.requestIngress } : {}),
    ...(input.appCredentialsAvailable ? { createRelay: input.createRelay } : {}),
  });
}
