import { captureError } from "../../shared/error-capture";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  createIssueComment,
  createIssueCommentReaction,
  createIssueReaction,
  deleteIssueComment,
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
  editIssueComment,
  getGithubAppSlugOrNull,
  getGithubWebBaseUrl,
  getIssue,
  getIssueComment,
  getPreferredGithubActorLoginOrNull,
  GithubApiError,
  listIssueCommentReactions,
  listIssueComments,
  listIssueReactions,
  type GithubReaction,
} from "../../github/github-api";
import { GithubAuthFailed } from "../../github/github-auth";
import { markGithubAgentComment } from "../../github/github-comment-marker";
import {
  DEFAULT_GITHUB_WEB_BASE_URL,
  isGithubIssueTriggerId,
  parseGithubSessionId,
} from "../../github/github-ids";
import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfaceOperationPartiallyCompleted,
  SurfaceOperationUnsupported,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
  type StartOutputOpts,
  type SurfaceAdapter,
  type SurfaceOperation,
  type SurfaceOperationError,
  type SurfaceOperationResult,
  type SurfaceOutputStream,
  type SurfaceSendPreparationInput,
  type TypingIndicatorSubscription,
} from "../adapter";
import type {
  ContentOpts,
  GithubMsgRef,
  GithubSessionRef,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
  SurfaceSessionParticipantsResult,
} from "../types";
import { renderGithubActionContent } from "./github-actions";
import { GithubOutputStream } from "./output/github-output-stream";

type GithubReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

const GITHUB_REACTION_CONTENTS: readonly GithubReactionContent[] = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
];

const DEFAULT_GITHUB_ADAPTER_API = {
  getIssue,
  listIssueComments,
  createIssueComment,
  getIssueComment,
  editIssueComment,
  deleteIssueComment,
  createIssueReaction,
  createIssueCommentReaction,
  listIssueReactions,
  listIssueCommentReactions,
  deleteIssueReactionById,
  deleteIssueCommentReactionById,
  getGithubAppSlugOrNull,
  getGithubWebBaseUrl,
  getPreferredGithubActorLoginOrNull,
};

function continueResult<T, E, ROk, RErr>(
  result: ResultType<T, E>,
  branches: { ok: (value: T) => ROk; err: (error: E) => RErr },
): ROk | RErr {
  const continuation = result.match<() => ROk | RErr>({
    ok: (value) => () => branches.ok(value),
    err: (error) => () => branches.err(error),
  });
  return continuation();
}

export type GithubAdapterApi = Omit<
  typeof DEFAULT_GITHUB_ADAPTER_API,
  "getGithubWebBaseUrl" | "getPreferredGithubActorLoginOrNull"
> & {
  readonly getGithubWebBaseUrl?: typeof getGithubWebBaseUrl;
  readonly getPreferredGithubActorLoginOrNull?: typeof getPreferredGithubActorLoginOrNull;
};

function unsupported(operation: SurfaceOperation, message: string): SurfaceOperationError {
  return new SurfaceOperationUnsupported({ platform: "github", operation, message });
}

function invalidInput(
  operation: SurfaceOperation,
  field: string,
  message: string,
): SurfaceOperationError {
  return new SurfaceInvalidInput({ platform: "github", operation, field, message });
}

function githubSessionRefResult(
  operation: SurfaceOperation,
  sessionRef: SessionRef,
  refRole = "sessionRef",
): SurfaceOperationResult<GithubSessionRef> {
  if (sessionRef.platform === "github") return Result.ok(sessionRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "github",
      receivedPlatform: sessionRef.platform,
      message: `Expected a GitHub ${refRole}, received '${sessionRef.platform}'`,
    }),
  );
}

function githubMsgRefResult(
  operation: SurfaceOperation,
  msgRef: MsgRef,
  refRole = "msgRef",
): SurfaceOperationResult<GithubMsgRef> {
  if (msgRef.platform === "github") return Result.ok(msgRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "github",
      receivedPlatform: msgRef.platform,
      message: `Expected a GitHub ${refRole}, received '${msgRef.platform}'`,
    }),
  );
}

function githubNestedMsgRefResult(input: {
  readonly operation: SurfaceOperation;
  readonly sessionRef: GithubSessionRef;
  readonly msgRef: MsgRef;
  readonly refRole: string;
}): SurfaceOperationResult<GithubMsgRef> {
  const ref = githubMsgRefResult(input.operation, input.msgRef, input.refRole);
  return ref.andThen((value) =>
    value.channelId === input.sessionRef.channelId
      ? Result.ok(value)
      : Result.err(
          new SurfaceSessionMismatch({
            operation: input.operation,
            refRole: input.refRole,
            expectedSessionId: input.sessionRef.channelId,
            receivedSessionId: value.channelId,
            message: `GitHub ${input.refRole} belongs to session '${value.channelId}'`,
          }),
        ),
  );
}

function parseGithubThreadResult(
  operation: SurfaceOperation,
  sessionRef: GithubSessionRef,
): SurfaceOperationResult<ReturnType<typeof parseGithubSessionId>> {
  {
    const attempt = Result.try({
      try: () => {
        return Result.ok(parseGithubSessionId(sessionRef.channelId));
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      if (Panic.is(cause)) throw cause;
      return Result.err(
        invalidInput(
          operation,
          "sessionRef.channelId",
          `Invalid GitHub session id '${sessionRef.channelId}'`,
        ),
      );
    }
    return attempt.value;
  }
}

type PreparedGithubSend = {
  readonly ref: GithubSessionRef;
  readonly text: string;
  readonly thread: ReturnType<typeof parseGithubSessionId>;
};

function prepareGithubSendResult(
  sessionRef: SessionRef,
  input: SurfaceSendPreparationInput,
  opts?: SendOpts,
): SurfaceOperationResult<PreparedGithubSend> {
  const refResult = githubSessionRefResult("send-message", sessionRef);
  return continueResult(refResult, {
    err: (error) => Result.err(error),
    ok: (ref) => {
      if (opts?.replyTo) {
        const reply = githubNestedMsgRefResult({
          operation: "send-message",
          sessionRef: ref,
          msgRef: opts.replyTo,
          refRole: "replyTo",
        });
        return continueResult(reply, {
          err: (error) => Result.err(error),
          ok: () =>
            Result.err(
              unsupported("send-message", "GitHub message replies are not supported by sendMsg"),
            ),
        });
      }
      if (input.attachmentCount > 0) {
        return Result.err(
          unsupported("send-message", "GitHub message attachments are not supported"),
        );
      }
      const text = input.text ?? "";
      if (!text.trim()) {
        return Result.err(invalidInput("send-message", "content.text", "Message text is required"));
      }
      const threadResult = parseGithubThreadResult("send-message", ref);
      return continueResult(threadResult, {
        err: (error) => Result.err(error),
        ok: (thread) => Result.ok({ ref, text, thread }),
      });
    },
  });
}

function githubCommentIdResult(
  operation: SurfaceOperation,
  messageId: string,
): SurfaceOperationResult<number> {
  if (!/^[1-9]\d*$/u.test(messageId)) {
    return Result.err(
      invalidInput(operation, "messageId", `Invalid GitHub commentId '${messageId}'`),
    );
  }
  const commentId = Number(messageId);
  if (Number.isSafeInteger(commentId) && commentId > 0) return Result.ok(commentId);
  return Result.err(
    invalidInput(operation, "messageId", `Invalid GitHub commentId '${messageId}'`),
  );
}

export function classifyGithubSurfaceError(
  operation: SurfaceOperation,
  cause: unknown,
): SurfaceOperationError | null {
  if (cause instanceof GithubAuthFailed) {
    return new SurfaceUnavailable({
      platform: "github",
      operation,
      message: cause.message,
    });
  }
  if (!(cause instanceof GithubApiError)) return null;
  if (cause.status === 404) {
    return new SurfaceMessageNotFound({ platform: "github", operation, message: cause.message });
  }
  if (cause.status === 429 || cause.rateLimit) {
    return new SurfaceRateLimited({
      platform: "github",
      operation,
      ...(cause.rateLimit?.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: cause.rateLimit.retryAfterMs }),
      message: cause.message,
    });
  }
  if (cause.status === 401 || cause.status === 403) {
    return new SurfacePermissionDenied({ platform: "github", operation, message: cause.message });
  }
  if (cause.status === 400 || cause.status === 422) {
    return invalidInput(operation, "request", cause.message);
  }
  if (cause.status >= 500) {
    return new SurfaceUnavailable({ platform: "github", operation, message: cause.message });
  }
  return null;
}

async function captureGithubOperation<T>(
  operation: SurfaceOperation,
  effect: () => Promise<T>,
): Promise<SurfaceOperationResult<T>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        return Result.ok(await effect());
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      if (Panic.is(cause)) throw cause;
      const classified = classifyGithubSurfaceError(operation, cause);
      if (classified) return Result.err(classified);
      throw cause;
    }
    return attempt.value;
  }
}

function githubReactionContentResult(
  operation: SurfaceOperation,
  reaction: string,
): SurfaceOperationResult<GithubReactionContent> {
  const raw = reaction.trim();
  const alias = raw.startsWith(":") && raw.endsWith(":") ? raw.slice(1, -1) : raw;
  const normalized = alias.trim().toLowerCase();
  const aliases: Readonly<Record<string, GithubReactionContent>> = {
    "+1": "+1",
    "-1": "-1",
    "👍": "+1",
    "👎": "-1",
    "😄": "laugh",
    "😕": "confused",
    "❤️": "heart",
    "🎉": "hooray",
    "🚀": "rocket",
    "👀": "eyes",
    thumbsup: "+1",
    thumbs_up: "+1",
    like: "+1",
    thumbsdown: "-1",
    thumbs_down: "-1",
    dislike: "-1",
    smile: "laugh",
    grin: "laugh",
    confusion: "confused",
    thinking: "confused",
    love: "heart",
    tada: "hooray",
    party: "hooray",
  };
  const content = aliases[raw] ?? aliases[normalized];
  if (content) return Result.ok(content);
  switch (normalized) {
    case "+1":
    case "-1":
    case "laugh":
    case "confused":
    case "heart":
    case "hooray":
    case "rocket":
    case "eyes":
      return Result.ok(normalized);
  }
  return Result.err(
    invalidInput(
      operation,
      "reaction",
      `Unsupported GitHub reaction '${reaction}'. Supported: ${GITHUB_REACTION_CONTENTS.join(", ")}, or emoji equivalents like 👍 👀 🚀`,
    ),
  );
}

function githubReactionEmoji(content: string): string {
  switch (content) {
    case "+1":
      return "👍";
    case "-1":
      return "👎";
    case "laugh":
      return "😄";
    case "confused":
      return "😕";
    case "heart":
      return "❤️";
    case "hooray":
      return "🎉";
    case "rocket":
      return "🚀";
    case "eyes":
      return "👀";
    default:
      return content;
  }
}

function parseGithubTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toGithubMessage(input: {
  readonly ref: GithubMsgRef;
  readonly session: GithubSessionRef;
  readonly body: string;
  readonly user?: { readonly login?: string; readonly id?: number };
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly raw: unknown;
}): SurfaceMessage {
  const login = input.user?.login;
  const id = input.user?.id;
  return {
    ref: input.ref,
    session: input.session,
    userId: id !== undefined ? String(id) : (login ?? "unknown"),
    ...(login ? { userName: login } : {}),
    text: input.body,
    ts: parseGithubTimestamp(input.createdAt),
    editedTs: parseGithubTimestamp(input.updatedAt),
    raw: input.raw,
  };
}

export class GithubAdapter implements SurfaceAdapter {
  private readonly api: GithubAdapterApi;

  constructor(input: { readonly api?: GithubAdapterApi } = {}) {
    this.api = input.api ?? DEFAULT_GITHUB_ADAPTER_API;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "github", userId: "github", userName: "github" };
  }

  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    return Result.err(
      unsupported(
        "list-sessions",
        "GitHub session discovery is not supported; use GitHub issue/PR discovery",
      ),
    );
  }

  async listSessionParticipants(
    sessionRef: SessionRef,
    _opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>> {
    const ref = githubSessionRefResult("list-session-participants", sessionRef);
    return ref.andThen(() =>
      Result.err(
        unsupported(
          "list-session-participants",
          "GitHub session participant listing is not supported",
        ),
      ),
    );
  }

  private async resolveWebBaseUrl(): Promise<string> {
    return this.api.getGithubWebBaseUrl
      ? await this.api.getGithubWebBaseUrl()
      : DEFAULT_GITHUB_WEB_BASE_URL;
  }

  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
    const refResult = githubSessionRefResult("start-output", sessionRef);
    return continueResult(refResult, {
      err: (error) => Result.err(error),
      ok: (ref) => {
        const nestedRefs = opts?.replyTo
          ? [
              githubNestedMsgRefResult({
                operation: "start-output",
                sessionRef: ref,
                msgRef: opts.replyTo,
                refRole: "replyTo",
              }),
            ]
          : [];
        return continueResult(Result.all(nestedRefs), {
          err: (error) => Result.err(error),
          ok: () => {
            const threadResult = parseGithubThreadResult("start-output", ref);
            return continueResult(threadResult, {
              err: (error) => Result.err(error),
              ok: (thread) =>
                Result.ok(
                  new GithubOutputStream(
                    ref,
                    {
                      createComment: async (body) => {
                        const created = await captureGithubOperation("finish-output", () =>
                          this.api.createIssueComment({
                            owner: thread.owner,
                            repo: thread.repo,
                            issueNumber: thread.number,
                            body,
                          }),
                        );
                        return created.map((value) => ({ id: value.id }));
                      },
                      resolveWebBaseUrl: () => this.resolveWebBaseUrl(),
                    },
                    opts?.replyTo ? { replyTo: opts.replyTo } : undefined,
                  ),
                ),
            });
          },
        });
      },
    });
  }

  async startTyping(
    sessionRef: SessionRef,
  ): Promise<SurfaceOperationResult<TypingIndicatorSubscription>> {
    const ref = githubSessionRefResult("start-typing", sessionRef);
    return ref.andThen(() =>
      Result.err(unsupported("start-typing", "GitHub typing indicators are not supported")),
    );
  }

  async prepareSendMsg(
    sessionRef: SessionRef,
    input: SurfaceSendPreparationInput,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<void>> {
    const prepared = prepareGithubSendResult(sessionRef, input, opts);
    return prepared.map(() => undefined);
  }

  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    const prepared = prepareGithubSendResult(
      sessionRef,
      {
        text: content.text,
        attachmentCount: content.attachments?.length ?? 0,
        actionCount: content.actions?.length ?? 0,
      },
      opts,
    );
    if (prepared.isErr()) return Result.err(prepared.error);
    const preparedValue = prepared.value;
    const createdResult = await captureGithubOperation("send-message", () =>
      this.api.createIssueComment({
        owner: preparedValue.thread.owner,
        repo: preparedValue.thread.repo,
        issueNumber: preparedValue.thread.number,
        body: markGithubAgentComment(preparedValue.text),
      }),
    );
    if (createdResult.isErr()) return Result.err(createdResult.error);
    const created = createdResult.value;
    const createdRef: GithubMsgRef = {
      platform: "github",
      channelId: preparedValue.ref.channelId,
      messageId: String(created.id),
    };
    if (!content.actions || content.actions.length === 0) return Result.ok(createdRef);
    const edited = await captureGithubOperation("send-message", () =>
      this.api.editIssueComment({
        owner: preparedValue.thread.owner,
        repo: preparedValue.thread.repo,
        commentId: created.id,
        body: markGithubAgentComment(
          renderGithubActionContent({
            text: preparedValue.text,
            messageId: createdRef.messageId,
            actions: content.actions ?? [],
          }),
        ),
      }),
    );
    return continueResult(edited, {
      err: () =>
        Result.err(
          new SurfaceOperationPartiallyCompleted({
            platform: "github",
            operation: "send-message",
            created: createdRef,
            message: `GitHub comment ${createdRef.messageId} was created but its action edit failed`,
          }),
        ),
      ok: () => Result.ok(createdRef),
    });
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    const refResult = githubMsgRefResult("read-message", msgRef);
    if (refResult.isErr()) return Result.err(refResult.error);
    const ref = refResult.value;
    const session: GithubSessionRef = { platform: "github", channelId: ref.channelId };
    const threadResult = parseGithubThreadResult("read-message", session);
    if (threadResult.isErr()) return Result.err(threadResult.error);
    const thread = threadResult.value;
    if (isGithubIssueTriggerId({ sessionId: ref.channelId, triggerId: ref.messageId })) {
      const issueResult = await captureGithubOperation("read-message", () =>
        this.api.getIssue({
          owner: thread.owner,
          repo: thread.repo,
          number: thread.number,
        }),
      );
      return continueResult(issueResult, {
        err: (error) => Result.err(error),
        ok: (issue) =>
          Result.ok(
            toGithubMessage({
              ref: { ...ref, messageId: String(thread.number) },
              session,
              body: `Title: ${issue.title}\n\n${issue.body ?? ""}`.trim(),
              user: issue.user,
              createdAt: issue.created_at,
              updatedAt: issue.updated_at,
              raw: { title: issue.title, htmlUrl: issue.html_url },
            }),
          ),
      });
    }
    const commentIdResult = githubCommentIdResult("read-message", ref.messageId);
    if (commentIdResult.isErr()) return Result.err(commentIdResult.error);
    const commentId = commentIdResult.value;
    const commentResult = await captureGithubOperation("read-message", () =>
      this.api.getIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        commentId,
      }),
    );
    return continueResult(commentResult, {
      err: (error) => Result.err(error),
      ok: (comment) =>
        Result.ok(
          toGithubMessage({
            ref: { ...ref, messageId: String(comment.id) },
            session,
            body: comment.body ?? "",
            user: comment.user,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
            raw: { htmlUrl: comment.html_url },
          }),
        ),
    });
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = githubSessionRefResult("list-messages", sessionRef);
    if (ref.isErr()) return Result.err(ref.error);
    const value = ref.value;
    return this.listGithubMessages("list-messages", value, opts);
  }

  private async listGithubMessages(
    operation: SurfaceOperation,
    sessionRef: GithubSessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    if (opts?.beforeMessageId || opts?.afterMessageId) {
      return Result.err(
        unsupported(operation, "GitHub message listing does not support cursor options"),
      );
    }
    const thread = parseGithubThreadResult(operation, sessionRef);
    if (thread.isErr()) return Result.err(thread.error);
    const threadValue = thread.value;
    const comments = await captureGithubOperation(operation, () =>
      this.api.listIssueComments({
        owner: threadValue.owner,
        repo: threadValue.repo,
        number: threadValue.number,
        limit: Math.min(Math.max(opts?.limit ?? 50, 1), 100),
        page: opts?.page,
      }),
    );
    return comments.map((values) =>
      values.map((comment) =>
        toGithubMessage({
          ref: {
            platform: "github",
            channelId: sessionRef.channelId,
            messageId: String(comment.id),
          },
          session: sessionRef,
          body: comment.body ?? "",
          user: comment.user,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
          raw: { htmlUrl: comment.html_url },
        }),
      ),
    );
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<SurfaceOperationResult<void>> {
    const refResult = githubMsgRefResult("edit-message", msgRef);
    if (refResult.isErr()) return Result.err(refResult.error);
    const ref = refResult.value;
    if ((content.attachments?.length ?? 0) > 0) {
      return Result.err(
        unsupported("edit-message", "GitHub comment attachment edits are not supported"),
      );
    }
    if (isGithubIssueTriggerId({ sessionId: ref.channelId, triggerId: ref.messageId })) {
      return Result.err(
        unsupported("edit-message", "Editing GitHub issue or PR bodies is not supported"),
      );
    }
    const body = content.text ?? "";
    if (!body.trim()) {
      return Result.err(invalidInput("edit-message", "content.text", "Message text is required"));
    }
    const session: GithubSessionRef = { platform: "github", channelId: ref.channelId };
    const validated = Result.all([
      parseGithubThreadResult("edit-message", session),
      githubCommentIdResult("edit-message", ref.messageId),
    ]);
    const rendered = content.actions
      ? renderGithubActionContent({
          text: body,
          messageId: ref.messageId,
          actions: content.actions,
        })
      : body;
    const continueValidated = validated.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok:
        ([thread, commentId]) =>
        () =>
          captureGithubOperation("edit-message", () =>
            this.api.editIssueComment({
              owner: thread.owner,
              repo: thread.repo,
              commentId,
              body: rendered,
            }),
          ),
    });
    return continueValidated();
  }

  async deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
    const refResult = githubMsgRefResult("delete-message", msgRef);
    if (refResult.isErr()) return Result.err(refResult.error);
    const ref = refResult.value;
    if (isGithubIssueTriggerId({ sessionId: ref.channelId, triggerId: ref.messageId })) {
      return Result.err(
        unsupported("delete-message", "Deleting GitHub issue or PR bodies is not supported"),
      );
    }
    const session: GithubSessionRef = { platform: "github", channelId: ref.channelId };
    const validated = Result.all([
      parseGithubThreadResult("delete-message", session),
      githubCommentIdResult("delete-message", ref.messageId),
    ]);
    const continueValidated = validated.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok:
        ([thread, commentId]) =>
        () =>
          captureGithubOperation("delete-message", () =>
            this.api.deleteIssueComment({
              owner: thread.owner,
              repo: thread.repo,
              commentId,
            }),
          ),
    });
    return continueValidated();
  }

  async getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = githubMsgRefResult("get-reply-context", msgRef);
    const continueContext = ref.match<() => Promise<SurfaceOperationResult<SurfaceMessage[]>>>({
      err: (error) => async () => Result.err(error),
      ok: (value) => () =>
        this.listGithubMessages(
          "get-reply-context",
          { platform: "github", channelId: value.channelId },
          opts,
        ),
    });
    return continueContext();
  }

  async planReplyChain(msgRef: MsgRef): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const ref = githubMsgRefResult("plan-reply-chain", msgRef);
    return ref.andThen(() =>
      Result.err(unsupported("plan-reply-chain", "GitHub reply-chain planning is not supported")),
    );
  }

  async planMergeBlockEndingAt(msgRef: MsgRef): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const ref = githubMsgRefResult("plan-merge-block", msgRef);
    return ref.andThen(() =>
      Result.err(unsupported("plan-merge-block", "GitHub merge-block planning is not supported")),
    );
  }

  private async listGithubReactions(
    operation: SurfaceOperation,
    ref: GithubMsgRef,
  ): Promise<SurfaceOperationResult<GithubReaction[]>> {
    const session: GithubSessionRef = { platform: "github", channelId: ref.channelId };
    const threadResult = parseGithubThreadResult(operation, session);
    const collectPages = async (
      listPage: (page: number) => Promise<GithubReaction[]>,
      page = 1,
      reactions: GithubReaction[] = [],
    ): Promise<SurfaceOperationResult<GithubReaction[]>> => {
      const currentResult = await captureGithubOperation(operation, () => listPage(page));
      if (currentResult.isErr()) return Result.err(currentResult.error);
      const current = currentResult.value;
      reactions.push(...current);
      return current.length < 100
        ? Result.ok(reactions)
        : collectPages(listPage, page + 1, reactions);
    };
    if (threadResult.isErr()) return Result.err(threadResult.error);
    const thread = threadResult.value;
    if (isGithubIssueTriggerId({ sessionId: ref.channelId, triggerId: ref.messageId })) {
      return collectPages((page) =>
        this.api.listIssueReactions({
          owner: thread.owner,
          repo: thread.repo,
          issueNumber: thread.number,
          limit: 100,
          page,
        }),
      );
    }
    const commentIdResult = githubCommentIdResult(operation, ref.messageId);
    const continueComment = commentIdResult.match<
      () => Promise<SurfaceOperationResult<GithubReaction[]>>
    >({
      err: (error) => async () => Result.err(error),
      ok: (commentId) => () =>
        collectPages((page) =>
          this.api.listIssueCommentReactions({
            owner: thread.owner,
            repo: thread.repo,
            commentId,
            limit: 100,
            page,
          }),
        ),
    });
    return continueComment();
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const refResult = githubMsgRefResult("add-reaction", msgRef);
    const validated = refResult.andThen((ref) => {
      const contentResult = githubReactionContentResult("add-reaction", reaction);
      return contentResult.andThen((content) => {
        const session: GithubSessionRef = { platform: "github", channelId: ref.channelId };
        return parseGithubThreadResult("add-reaction", session).map((thread) => ({
          ref,
          content,
          thread,
        }));
      });
    });
    const continueAdd = validated.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok:
        ({ ref, content, thread }) =>
        async () => {
          if (isGithubIssueTriggerId({ sessionId: ref.channelId, triggerId: ref.messageId })) {
            const created = await captureGithubOperation("add-reaction", () =>
              this.api.createIssueReaction({
                owner: thread.owner,
                repo: thread.repo,
                issueNumber: thread.number,
                content,
              }),
            );
            return created.map(() => undefined);
          }
          const commentIdResult = githubCommentIdResult("add-reaction", ref.messageId);
          if (commentIdResult.isErr()) return Result.err(commentIdResult.error);
          const commentId = commentIdResult.value;
          const created = await captureGithubOperation("add-reaction", () =>
            this.api.createIssueCommentReaction({
              owner: thread.owner,
              repo: thread.repo,
              commentId,
              content,
            }),
          );
          return created.map(() => undefined);
        },
    });
    return continueAdd();
  }

  async removeReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const refResult = githubMsgRefResult("remove-reaction", msgRef);
    const validated = refResult.andThen((ref) => {
      const contentResult = githubReactionContentResult("remove-reaction", reaction);
      return contentResult.andThen((content) => {
        const session: GithubSessionRef = { platform: "github", channelId: ref.channelId };
        return parseGithubThreadResult("remove-reaction", session).map((thread) => ({
          ref,
          content,
          thread,
        }));
      });
    });
    const deleteAll = async (
      reactions: readonly GithubReaction[],
      remove: (reaction: GithubReaction) => Promise<void>,
      index = 0,
    ): Promise<SurfaceOperationResult<void>> => {
      const item = reactions[index];
      if (!item) return Result.ok(undefined);
      const deleted = await captureGithubOperation("remove-reaction", () => remove(item));
      if (deleted.isErr()) return Result.err(deleted.error);
      return deleteAll(reactions, remove, index + 1);
    };
    const continueRemove = validated.match<() => Promise<SurfaceOperationResult<void>>>({
      err: (error) => async () => Result.err(error),
      ok:
        ({ ref, content, thread }) =>
        async () => {
          const actorResult = await captureGithubOperation("remove-reaction", async () => {
            const preferred = this.api.getPreferredGithubActorLoginOrNull
              ? await this.api.getPreferredGithubActorLoginOrNull()
              : null;
            if (preferred) return preferred;
            const slug = await this.api.getGithubAppSlugOrNull();
            return slug ? `${slug}[bot]` : null;
          });
          if (actorResult.isErr()) return Result.err(actorResult.error);
          const actor = actorResult.value;
          if (!actor) {
            return Result.err(
              new SurfaceUnavailable({
                platform: "github",
                operation: "remove-reaction",
                message: "Unable to resolve the outbound GitHub actor login",
              }),
            );
          }
          const reactionsResult = await this.listGithubReactions("remove-reaction", ref);
          if (reactionsResult.isErr()) return Result.err(reactionsResult.error);
          const reactions = reactionsResult.value;
          const mine = reactions.filter(
            (item) => item.content === content && item.user?.login === actor,
          );
          if (isGithubIssueTriggerId({ sessionId: ref.channelId, triggerId: ref.messageId })) {
            return deleteAll(mine, (item) =>
              this.api.deleteIssueReactionById({
                owner: thread.owner,
                repo: thread.repo,
                issueNumber: thread.number,
                reactionId: item.id,
              }),
            );
          }
          const commentIdResult = githubCommentIdResult("remove-reaction", ref.messageId);
          if (commentIdResult.isErr()) return Result.err(commentIdResult.error);
          const commentId = commentIdResult.value;
          return deleteAll(mine, (item) =>
            this.api.deleteIssueCommentReactionById({
              owner: thread.owner,
              repo: thread.repo,
              commentId,
              reactionId: item.id,
            }),
          );
        },
    });
    return continueRemove();
  }

  async listReactions(msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    const detailed = await this.listGithubReactionDetails("list-reactions", msgRef);
    return detailed.map((value) => value.map((item) => item.emoji));
  }

  async listReactionDetails(
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    return await this.listGithubReactionDetails("list-reaction-details", msgRef);
  }

  private async listGithubReactionDetails(
    operation: "list-reactions" | "list-reaction-details",
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    const refResult = githubMsgRefResult(operation, msgRef);
    if (refResult.isErr()) return Result.err(refResult.error);
    const ref = refResult.value;
    const reactionsResult = await this.listGithubReactions(operation, ref);
    return continueResult(reactionsResult, {
      err: (error) => Result.err(error),
      ok: (reactions) => {
        const byContent = new Map<
          string,
          { count: number; users: Array<{ userId: string; userName?: string }> }
        >();
        for (const reaction of reactions) {
          const entry = byContent.get(reaction.content) ?? { count: 0, users: [] };
          entry.count += 1;
          const login = reaction.user?.login;
          const id = reaction.user?.id;
          if (login || id !== undefined) {
            const userId = id !== undefined ? String(id) : login;
            if (userId && !entry.users.some((user) => user.userId === userId)) {
              entry.users.push({ userId, ...(login ? { userName: login } : {}) });
            }
          }
          byContent.set(reaction.content, entry);
        }
        return Result.ok(
          Array.from(byContent.entries()).map(([content, entry]) => ({
            emoji: githubReactionEmoji(content),
            count: entry.count,
            users: entry.users,
          })),
        );
      },
    });
  }

  async getUnRead(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const ref = githubSessionRefResult("get-unread", sessionRef);
    return ref.andThen(() =>
      Result.err(unsupported("get-unread", "GitHub unread tracking is not supported")),
    );
  }

  async markRead(
    sessionRef: SessionRef,
    upToMsgRef?: MsgRef,
  ): Promise<SurfaceOperationResult<void>> {
    const refResult = githubSessionRefResult("mark-read", sessionRef);
    return continueResult(refResult, {
      err: (error) => Result.err(error),
      ok: (ref) => {
        if (!upToMsgRef) {
          return Result.err(
            unsupported("mark-read", "GitHub read-state tracking is not supported"),
          );
        }
        const upToResult = githubNestedMsgRefResult({
          operation: "mark-read",
          sessionRef: ref,
          msgRef: upToMsgRef,
          refRole: "upToMsgRef",
        });
        return continueResult(upToResult, {
          err: (error) => Result.err(error),
          ok: () =>
            Result.err(unsupported("mark-read", "GitHub read-state tracking is not supported")),
        });
      },
    });
  }
}
