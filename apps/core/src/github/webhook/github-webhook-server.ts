import { captureError } from "../../shared/error-capture.js";
import crypto from "node:crypto";
import Elysia from "elysia";
import type { BusMessageV2, LilacBus } from "@stanley2058/lilac-event-bus";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";
import { createLogger, env, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  addEyesReactionToIssue,
  addEyesReactionToIssueComment,
  getGithubAppSlugOrNull,
  getGithubUserLoginOrNull,
  getIssue,
  getPullRequest,
  listIssueComments,
  createIssueComment,
  hasGithubCollaboratorPermission,
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
} from "../github-api";
import {
  claimGithubAcknowledgement,
  getGithubLatestRequestForSession,
  getGithubRequestMeta,
  restoreGithubLatestRequestForSession,
  rollbackGithubAcknowledgementClaim,
  setGithubAck,
  setGithubLatestRequestForSession,
  setGithubRequestMeta,
  clearGithubRequest,
  clearGithubAck,
  getGithubAck,
} from "../github-state";
import { isMarkedGithubAgentComment, markGithubAgentComment } from "../github-comment-marker";
import { parseGithubWorkflowActionReply } from "../../surface/github/github-actions";
import { adaptEventPublishResultToHost } from "../../shared/event-bus-result";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";

export const githubWebhookApi = {
  addEyesReactionToIssue,
  addEyesReactionToIssueComment,
  getIssue,
  getPullRequest,
  listIssueComments,
  createIssueComment,
  hasGithubCollaboratorPermission,
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
};
type GithubWebhookApi = typeof githubWebhookApi;

type GithubWebhookOptions = {
  bus: LilacBus;
  subscriptionId: string;
  reportFatalError: (error: Error) => void;
};

const githubRepositorySchema = z.object({ full_name: z.string().min(1) });
const githubWebhookBasePayloadSchema = z.object({
  action: z.string().optional(),
  repository: githubRepositorySchema.optional(),
});
const githubIssueCommentPayloadSchema = z.object({
  action: z.literal("created"),
  repository: githubRepositorySchema,
  issue: z.object({ number: z.number().int().positive() }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string(),
    author_association: z.string().optional(),
    html_url: z.string().optional(),
    created_at: z.string().optional(),
    user: z.object({ login: z.string().min(1) }).optional(),
  }),
});
const githubReviewRequestedPayloadSchema = z.object({
  action: z.literal("review_requested"),
  repository: githubRepositorySchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string().min(1) }),
  }),
  requested_reviewer: z.object({ login: z.string().min(1) }).optional(),
  sender: z.object({ login: z.string().min(1) }).optional(),
});
const githubPullRequestSynchronizePayloadSchema = z.object({
  action: z.literal("synchronize"),
  repository: githubRepositorySchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string().min(1) }),
  }),
});

type ProjectedGithubWebhookEvent =
  | {
      readonly kind: "issue-comment-created";
      readonly payload: z.output<typeof githubIssueCommentPayloadSchema>;
    }
  | {
      readonly kind: "review-requested";
      readonly payload: z.output<typeof githubReviewRequestedPayloadSchema>;
    }
  | {
      readonly kind: "pull-request-synchronize";
      readonly payload: z.output<typeof githubPullRequestSynchronizePayloadSchema>;
    }
  | {
      readonly kind: "unsupported";
      readonly action?: string;
      readonly repoFullName?: string;
      readonly reason: "payload_invalid" | "unsupported_event";
    };

export class GithubWebhookOperationError extends TaggedError("GithubWebhookOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export function decodeGithubWebhookEvent(
  event: string,
  payload: unknown,
): ProjectedGithubWebhookEvent {
  const decoded = Result.try({
    try: (): ProjectedGithubWebhookEvent => {
      const base = githubWebhookBasePayloadSchema.safeParse(payload);
      const fallback = {
        kind: "unsupported",
        reason: base.success ? "unsupported_event" : "payload_invalid",
        ...(base.success && base.data.action ? { action: base.data.action } : {}),
        ...(base.success && base.data.repository
          ? { repoFullName: base.data.repository.full_name }
          : {}),
      } as const;

      if (!base.success) return fallback;
      if (event === "issue_comment" && base.data.action === "created") {
        const projected = githubIssueCommentPayloadSchema.safeParse(payload);
        return projected.success
          ? { kind: "issue-comment-created", payload: projected.data }
          : fallback;
      }
      if (event === "pull_request" && base.data.action === "review_requested") {
        const projected = githubReviewRequestedPayloadSchema.safeParse(payload);
        return projected.success ? { kind: "review-requested", payload: projected.data } : fallback;
      }
      if (event === "pull_request" && base.data.action === "synchronize") {
        const projected = githubPullRequestSynchronizePayloadSchema.safeParse(payload);
        return projected.success
          ? { kind: "pull-request-synchronize", payload: projected.data }
          : fallback;
      }
      return fallback;
    },
    catch: captureError,
  });
  return decoded.match<() => ProjectedGithubWebhookEvent>({
    ok: (value) => () => value,
    err:
      ({ cause }) =>
      () => {
        if (Panic.is(cause)) return adaptToolResultToHost(Result.err(cause));
        return { kind: "unsupported", reason: "payload_invalid" };
      },
  })();
}

async function captureGithubWebhookOperation<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<ResultType<T, GithubWebhookOperationError>> {
  {
    const captured = await Result.tryPromise({
      try: async () => {
        return Result.ok(await run());
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (Panic.is(cause)) throw cause;
      return Result.err(
        new GithubWebhookOperationError({
          operation,
          cause,
          message: `GitHub webhook ${operation} failed`,
        }),
      );
    }
    return captured.value;
  }
}

export async function superviseGithubWebhookHandler<T>(options: {
  readonly run: () => Promise<T>;
  readonly reportFatalError: (error: Error) => void;
}): Promise<ResultType<T, GithubWebhookOperationError>> {
  {
    const captured = await Result.tryPromise({
      try: async () => {
        return await captureGithubWebhookOperation("handler", options.run);
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (!Panic.is(cause)) throw cause;
      options.reportFatalError(cause);
      throw cause;
    }
    return captured.value;
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function verifyGithubWebhookSignature(input: {
  secret: string;
  signature256: string | null;
  rawBody: Uint8Array;
}): boolean {
  const sig = input.signature256;
  if (!sig) return false;
  const m = /^sha256=([0-9a-f]{64})$/.exec(sig);
  if (!m) return false;
  const expected = crypto.createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  return timingSafeEqualHex(expected, m[1]!);
}

async function resolveBotMentions(): Promise<string[]> {
  const out: string[] = [];
  const [userLogin, appSlug] = await Promise.allSettled([
    getGithubUserLoginOrNull(),
    getGithubAppSlugOrNull(),
  ]);
  if (userLogin.status === "fulfilled" && userLogin.value) out.push(userLogin.value);
  if (appSlug.status === "fulfilled" && appSlug.value) out.push(`${appSlug.value}[bot]`);

  // De-dupe while preserving order.
  return [...new Set(out)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function joinTriggerCommandText(
  firstLineRemainder: string,
  trailingLines: readonly string[],
): string {
  const parts: string[] = [];
  const head = firstLineRemainder.trim();
  if (head.length > 0) {
    parts.push(head);
  }
  const tail = trailingLines.join("\n").trim();
  if (tail.length > 0) {
    parts.push(tail);
  }
  return parts.join("\n");
}

type FenceMarker = "`" | "~";

function parseFenceMarker(trimmedStart: string): FenceMarker | null {
  if (trimmedStart.startsWith("```")) return "`";
  if (trimmedStart.startsWith("~~~")) return "~";
  return null;
}

export function parseIssueCommentTrigger(
  body: string,
  botLogins: readonly string[],
): string | null {
  const mentionPattern = botLogins.length
    ? new RegExp(`^@(?:${botLogins.map(escapeRegExp).join("|")})(?:(?:[,:]\\s*|\\s+)(.*))?$`, "iu")
    : null;
  const lines = body.split(/\r?\n/u);
  let activeFence: FenceMarker | null = null;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx] ?? "";
    const trimmedStart = rawLine.trimStart();

    const fenceMarker = parseFenceMarker(trimmedStart);
    if (fenceMarker) {
      if (activeFence === null) {
        activeFence = fenceMarker;
      } else if (activeFence === fenceMarker) {
        activeFence = null;
      }
      continue;
    }
    if (activeFence !== null) continue;
    if (trimmedStart.startsWith(">")) continue;

    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    if (trimmed === "/lilac" || trimmed.startsWith("/lilac ")) {
      const commandText = trimmed === "/lilac" ? "" : trimmed.slice("/lilac ".length);
      return joinTriggerCommandText(commandText, lines.slice(idx + 1));
    }

    const mentionTrigger = mentionPattern?.exec(trimmed);
    return mentionTrigger
      ? joinTriggerCommandText(mentionTrigger[1] ?? "", lines.slice(idx + 1))
      : null;
  }

  return null;
}

export function projectGithubAuthenticatedActor(
  userId: string | undefined,
):
  | { readonly authenticatedActor: { readonly platform: "github"; readonly userId: string } }
  | { readonly authenticatedActor?: never } {
  return typeof userId === "string" && userId.length > 0
    ? { authenticatedActor: { platform: "github" as const, userId } }
    : {};
}

function buildIssuePrompt(input: {
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string | null;
  issueUrl?: string;
  triggerUrl?: string;
  triggerAuthor?: string;
  triggerBody: string;
  recentComments: Array<{ author?: string; body?: string }>;
}): string {
  const body = input.issueBody?.trim() ? input.issueBody.trim() : "(no description)";
  const issueLink = input.issueUrl ?? `${input.repoFullName}#${input.issueNumber}`;
  const triggerLink = input.triggerUrl ? `\nTrigger: ${input.triggerUrl}` : "";

  const comments = input.recentComments
    .filter((c) => typeof c.body === "string" && c.body.trim().length > 0)
    .slice(-20)
    .map((c) => {
      const author = c.author ? `@${c.author}` : "(unknown)";
      const text = (c.body ?? "").trim();
      return `- ${author}: ${text}`;
    })
    .join("\n");

  return [
    `GitHub thread: ${issueLink}${triggerLink}`,
    "",
    `Title: ${input.issueTitle}`,
    "",
    "Description:",
    body,
    "",
    "Trigger message:",
    `@${input.triggerAuthor ?? "unknown"}: ${input.triggerBody}`,
    "",
    comments ? "Recent comments:" : "Recent comments: (none)",
    comments || "",
    "",
    "Reply in this thread with the final answer.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function buildPrReviewPrompt(input: {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  prUrl?: string;
  headSha: string;
}): string {
  const body = input.prBody?.trim() ? input.prBody.trim() : "(no description)";
  const link = input.prUrl ?? `${input.repoFullName}#${input.prNumber}`;

  return [
    `GitHub PR: ${link}`,
    "",
    `Title: ${input.prTitle}`,
    "",
    "Description:",
    body,
    "",
    `Head SHA (must stay stable for this review): ${input.headSha}`,
    "",
    "Task:",
    "- Review the PR. Use `bash` + `gh` as needed to inspect files, commits, and diff.",
    "- Decide whether the PR should be APPROVED or REQUEST_CHANGES.",
    "- Right before your final response, re-check the head SHA and then submit the review state via an explicit `bash` call using `gh pr review`.",
    "- If the head SHA changed, do not submit a review; explain it was superseded and a restart is required.",
    "",
    "Explicit steps (must follow):",
    `1) Re-check head SHA: gh pr view ${input.prNumber} --repo ${input.repoFullName} --json headRefOid --jq .headRefOid`,
    `2) If SHA != ${input.headSha}: stop and ask for restart (do NOT submit a review)`,
    "3) Else submit one of:",
    `   - Approve: gh pr review ${input.prNumber} --repo ${input.repoFullName} --approve --body "..."`,
    `   - Request changes: gh pr review ${input.prNumber} --repo ${input.repoFullName} --request-changes --body "..."`,
    "",
    "Output:",
    "- Post a single comment in the PR conversation with your review.",
  ].join("\n");
}

function safePreview(text: string, max = 4000): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n... (truncated)`;
}

function newGithubRequestId(input: {
  sessionId: string;
  triggerId: string;
  suffix?: string;
}): string {
  const base = `github:${input.sessionId}:${input.triggerId}`;
  return input.suffix ? `${base}:${input.suffix}` : base;
}

export function githubDeliveryId(deliveryId: string | undefined, operation: string): string {
  if (!deliveryId) return crypto.randomUUID();
  return `github-delivery:${crypto.createHash("sha256").update(deliveryId).digest("hex")}:${operation}`;
}

async function cleanupFailedGithubRequest(
  requestId: string,
  logger: Logger,
  api: GithubWebhookApi,
): Promise<void> {
  const meta = getGithubRequestMeta(requestId);
  const ack = getGithubAck(requestId);
  if (meta && ack) {
    const [owner, repo] = meta.repoFullName.split("/");
    if (owner && repo) {
      const deleted = await captureGithubWebhookOperation("remove failed acknowledgement", () =>
        ack.target.kind === "comment"
          ? api.deleteIssueCommentReactionById({
              owner,
              repo,
              commentId: ack.target.commentId,
              reactionId: ack.reactionId,
            })
          : api.deleteIssueReactionById({
              owner,
              repo,
              issueNumber: ack.target.issueNumber,
              reactionId: ack.reactionId,
            }),
      );
      deleted.match({
        ok: () => undefined,
        err: (error) =>
          logger.warn("failed to remove acknowledgement", formatTaggedErrorForLog(error)),
      });
    }
  }
  clearGithubAck(requestId);
  clearGithubRequest(requestId);
}

const githubSessionOperationTails = new Map<string, Promise<void>>();

async function runGithubSessionOperation<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = githubSessionOperationTails.get(sessionId);
  const gate = Promise.withResolvers<void>();
  githubSessionOperationTails.set(sessionId, gate.promise);
  if (previous) await previous;
  return await operation().finally(() => {
    gate.resolve();
    if (githubSessionOperationTails.get(sessionId) === gate.promise) {
      githubSessionOperationTails.delete(sessionId);
    }
  });
}

export async function startGithubWebhookServer(options: GithubWebhookOptions): Promise<{
  stop(): Promise<void>;
}> {
  const logger = createLogger({
    module: "github:webhook",
  });

  // Only start when configured.
  const secret = env.github.webhookSecret;
  const portRaw = env.github.webhookPort;
  const port = portRaw ? Number(portRaw) : 8787;
  const path = env.github.webhookPath;
  if (!secret) {
    logger.warn("GITHUB_WEBHOOK_SECRET missing; skipping GitHub webhook server");
    return { stop: async () => undefined };
  }

  const botLogins = await resolveBotMentions();
  logger.debug("GitHub webhook server init", {
    port,
    path,
    botLogins,
  });

  const app = createGithubWebhookApp({
    secret,
    path,
    logger,
    reportFatalError: options.reportFatalError,
    handle: (event, projected, deliveryId) =>
      handleEvent({ bus: options.bus, logger, event, projected, botLogins, deliveryId }),
  });

  const server = app.listen({ port, maxRequestBodySize: 2 * 1024 * 1024 });
  logger.info("GitHub webhook server started", { port, path });

  return {
    stop: async () => {
      await captureGithubWebhookOperation("server stop", async () => server.stop());
    },
  };
}

export function createGithubWebhookApp(options: {
  secret: string;
  path: string;
  logger: Logger;
  reportFatalError: (error: Error) => void;
  handle: (
    event: string,
    projected: ProjectedGithubWebhookEvent,
    deliveryId?: string,
  ) => Promise<unknown>;
}) {
  const { secret, path, logger } = options;
  const seen = new Map<string, number>();
  const DEDUPE_TTL_MS = 10 * 60 * 1000;

  function dedupe(deliveryId: string | undefined): boolean {
    if (!deliveryId) return false;
    const now = Date.now();
    for (const [k, exp] of seen) {
      if (exp <= now) seen.delete(k);
    }
    const exp = seen.get(deliveryId);
    if (exp && exp > now) return true;
    return false;
  }

  const queued = new WeakMap<
    Request,
    { event: string; deliveryId?: string; projected: ProjectedGithubWebhookEvent }
  >();
  const app = new Elysia();

  app.post(
    path,
    async ({ request, set }) => {
      const startedAt = Date.now();
      const event = request.headers.get("x-github-event") ?? "";
      const deliveryId = request.headers.get("x-github-delivery") ?? undefined;
      const sig256 = request.headers.get("x-hub-signature-256");

      const raw = new Uint8Array(await request.arrayBuffer());
      if (!verifyGithubWebhookSignature({ secret, signature256: sig256, rawBody: raw })) {
        logger.warn("github.webhook.rejected", {
          event,
          deliveryId,
          reason: "invalid_signature",
          statusCode: 401,
          durationMs: Date.now() - startedAt,
        });
        set.status = 401;
        return { ok: false, error: "invalid signature" };
      }

      if (dedupe(deliveryId)) {
        logger.info("github.webhook.deduped", {
          event,
          deliveryId,
          statusCode: 200,
          durationMs: Date.now() - startedAt,
        });
        return { ok: true, deduped: true };
      }

      const payload = await captureGithubWebhookOperation("decode JSON", async () =>
        JSON.parse(new TextDecoder().decode(raw)),
      );
      return payload.match<() => Promise<{ ok: boolean; error?: string }>>({
        err: () => async () => {
          logger.warn("github.webhook.rejected", {
            event,
            deliveryId,
            reason: "invalid_json",
            statusCode: 400,
            durationMs: Date.now() - startedAt,
          });
          set.status = 400;
          return { ok: false, error: "invalid json" };
        },
        ok: (payload) => async () => {
          queued.set(request, {
            event,
            deliveryId,
            projected: decodeGithubWebhookEvent(event, payload),
          });
          return { ok: true };
        },
      })();
    },
    {
      afterResponse: async ({ request }) => {
        const item = queued.get(request);
        if (!item) return;
        queued.delete(request);
        const handled = await superviseGithubWebhookHandler({
          reportFatalError: options.reportFatalError,
          run: () => options.handle(item.event, item.projected, item.deliveryId),
        });
        handled.match({
          ok: () => {
            if (item.deliveryId) seen.set(item.deliveryId, Date.now() + DEDUPE_TTL_MS);
            logger.info("github.webhook.handled", {
              event: item.event,
              deliveryId: item.deliveryId,
            });
          },
          err: (error) => logger.error("webhook handler failed", formatTaggedErrorForLog(error)),
        });
      },
    },
  );

  return app;
}

export async function handleEvent(input: {
  bus: LilacBus;
  logger: Logger;
  event: string;
  projected: ProjectedGithubWebhookEvent;
  deliveryId?: string;
  api?: GithubWebhookApi;
  botLogins: readonly string[];
}): Promise<{
  handled: boolean;
  reason?: string;
  action?: string;
  repoFullName?: string;
  requestId?: string;
}> {
  const projected = input.projected;
  switch (projected.kind) {
    case "issue-comment-created": {
      const repoFullName = projected.payload.repository.full_name;
      const requestId = await onIssueCommentCreated({
        bus: input.bus,
        api: input.api ?? githubWebhookApi,
        deliveryId: input.deliveryId,
        logger: input.logger,
        repoFullName,
        payload: projected.payload,
        botLogins: input.botLogins,
      });
      return {
        handled: Boolean(requestId),
        reason: requestId ? undefined : "issue_comment_not_triggered",
        action: "created",
        repoFullName,
        requestId: requestId ?? undefined,
      };
    }
    case "review-requested": {
      const repoFullName = projected.payload.repository.full_name;
      const requestId = await onReviewRequested({
        bus: input.bus,
        api: input.api ?? githubWebhookApi,
        deliveryId: input.deliveryId,
        logger: input.logger,
        repoFullName,
        payload: projected.payload,
        botLogins: input.botLogins,
      });
      return {
        handled: Boolean(requestId),
        reason: requestId ? undefined : "review_requested_not_for_bot",
        action: "review_requested",
        repoFullName,
        requestId: requestId ?? undefined,
      };
    }
    case "pull-request-synchronize": {
      const repoFullName = projected.payload.repository.full_name;
      const requestId = await onPullRequestSynchronize({
        bus: input.bus,
        api: input.api ?? githubWebhookApi,
        deliveryId: input.deliveryId,
        logger: input.logger,
        repoFullName,
        payload: projected.payload,
      });
      return {
        handled: Boolean(requestId),
        reason: requestId ? undefined : "synchronize_ignored",
        action: "synchronize",
        repoFullName,
        requestId: requestId ?? undefined,
      };
    }
    case "unsupported":
      input.logger.debug("github.webhook.ignored", {
        event: input.event,
        action: projected.action,
        repo: projected.repoFullName,
        reason: projected.reason,
      });
      return {
        handled: false,
        reason: projected.reason,
        action: projected.action,
        repoFullName: projected.repoFullName,
      };
  }
}

export async function isGithubCommenterTrusted(input: {
  association?: string;
  login?: string;
  checkPermission: (login: string) => Promise<boolean>;
}): Promise<boolean> {
  if (!input.login) return false;
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(input.association ?? "")) return true;
  return input.checkPermission(input.login);
}

export async function rejectGithubCommenterOnce(input: {
  login: string;
  listComments: (page: number) => Promise<Array<{ body?: string }>>;
  reply: (body: string) => Promise<unknown>;
}): Promise<void> {
  const body = markGithubAgentComment(
    `@${input.login}: Only repository collaborators can start Lilac requests.`,
  );
  for (let page = 1; ; page++) {
    const comments = await input.listComments(page);
    if (comments.some((comment) => comment.body === body)) return;
    if (comments.length < 100) break;
  }
  await input.reply(body);
}

async function onIssueCommentCreated(input: {
  bus: LilacBus;
  logger: Logger;
  repoFullName: string;
  deliveryId?: string;
  payload: z.output<typeof githubIssueCommentPayloadSchema>;
  botLogins: readonly string[];
  api: GithubWebhookApi;
}): Promise<string | null> {
  const author = input.payload.comment.user?.login;
  const issueNumber = input.payload.issue.number;
  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) return null;
  const candidate =
    parseIssueCommentTrigger(input.payload.comment.body, input.botLogins) !== null ||
    parseGithubWorkflowActionReply(input.payload.comment.body) !== null;
  if (!candidate || isMarkedGithubAgentComment(input.payload.comment.body)) return null;
  const trusted = await isGithubCommenterTrusted({
    association: input.payload.comment.author_association,
    login: author,
    checkPermission: (login) => input.api.hasGithubCollaboratorPermission({ owner, repo, login }),
  });
  if (!trusted) {
    const key = `${input.repoFullName}#${issueNumber}:rejection:${author ?? "unknown"}`;
    const rejected = await captureGithubWebhookOperation("reject untrusted commenter", () =>
      runGithubSessionOperation(key, () =>
        rejectGithubCommenterOnce({
          login: author ?? "unknown",
          listComments: (page) =>
            input.api.listIssueComments({ owner, repo, number: issueNumber, limit: 100, page }),
          reply: (body) => input.api.createIssueComment({ owner, repo, issueNumber, body }),
        }),
      ),
    );
    rejected.match({
      ok: () => undefined,
      err: (error) =>
        input.logger.warn("failed to reject commenter", formatTaggedErrorForLog(error)),
    });
    return null;
  }

  const actionPayload = input.payload;
  if (actionPayload.comment.user) {
    const workflowAction = parseGithubWorkflowActionReply(actionPayload.comment.body);
    if (workflowAction) {
      const sessionId = `${input.repoFullName}#${actionPayload.issue.number}`;
      const parsedTs = actionPayload.comment.created_at
        ? Date.parse(actionPayload.comment.created_at)
        : Number.NaN;
      adaptEventPublishResultToHost(
        await input.bus.publish(lilacEventTypes.EvtAdapterActionInvoked, {
          actionId: workflowAction.actionId,
          platform: "github",
          userId: actionPayload.comment.user.login,
          messageRef: {
            platform: "github",
            channelId: sessionId,
            messageId: workflowAction.messageId,
          },
          sourceMessageId: String(actionPayload.comment.id),
          ts: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
        }),
      );
      return `workflow-action:${actionPayload.comment.id}`;
    }
  }

  const commentId = input.payload.comment.id;
  const body = input.payload.comment.body;
  const htmlUrl = input.payload.comment.html_url;
  if (typeof body !== "string" || body.trim().length === 0) return null;

  if (isMarkedGithubAgentComment(body)) {
    input.logger.debug("github.webhook.ignored", {
      event: "issue_comment",
      action: "created",
      repo: input.repoFullName,
      issueNumber,
      commentId,
      author,
      reason: "agent_comment_marker",
    });
    return null;
  }

  const commandText = parseIssueCommentTrigger(body, input.botLogins);
  if (commandText === null) {
    input.logger.debug("github.webhook.ignored", {
      event: "issue_comment",
      action: "created",
      repo: input.repoFullName,
      issueNumber,
      commentId,
      reason: "not_a_trigger",
    });
    return null;
  }

  const sessionId = `${input.repoFullName}#${issueNumber}`;
  const requestId = newGithubRequestId({
    sessionId,
    triggerId: String(commentId),
  });

  const latestTransition = setGithubLatestRequestForSession(sessionId, requestId);
  let published = false;
  setGithubRequestMeta({
    requestId,
    sessionId,
    repoFullName: input.repoFullName,
    issueNumber,
    trigger: { kind: "comment", commentId, issueNumber },
    createdAtMs: Date.now(),
    actorLogin: author,
  });
  return await (async () => {
    input.logger.info("github trigger: issue_comment", {
      repo: input.repoFullName,
      issueNumber,
      commentId,
      requestId,
    });

    // Ack quickly with 👀 (best-effort).
    const ack = await captureGithubWebhookOperation("issue comment acknowledgement", () =>
      input.api.addEyesReactionToIssueComment({
        owner,
        repo,
        commentId,
      }),
    );
    ack.match({
      ok: (reactionId) => {
        setGithubAck(requestId, {
          target: { kind: "comment", commentId, issueNumber },
          reactionId,
        });
      },
      err: (error) => {
        input.logger.warn("failed to add eyes reaction", formatTaggedErrorForLog(error));
      },
    });

    const issueData = await input.api.getIssue({ owner, repo, number: issueNumber });
    const recent = await input.api.listIssueComments({
      owner,
      repo,
      number: issueNumber,
      limit: 30,
      page: Math.max(1, Math.ceil((issueData.comments ?? 0) / 30)),
    });

    const triggerText = commandText.trim().length > 0 ? commandText : body;

    const prompt = buildIssuePrompt({
      repoFullName: input.repoFullName,
      issueNumber,
      issueTitle: issueData.title,
      issueBody: issueData.body ?? null,
      issueUrl: issueData.html_url,
      triggerUrl: typeof htmlUrl === "string" ? htmlUrl : undefined,
      triggerAuthor: typeof author === "string" ? author : undefined,
      triggerBody: safePreview(triggerText),
      recentComments: recent.map((c) => ({
        author: typeof c.user?.login === "string" ? c.user.login : undefined,
        body: typeof c.body === "string" ? safePreview(c.body, 1000) : undefined,
      })),
    });

    const messages: BusMessageV2[] = [{ role: "user", content: prompt }];

    setGithubRequestMeta({
      requestId,
      sessionId,
      repoFullName: input.repoFullName,
      issueNumber,
      trigger: { kind: "comment", commentId, issueNumber },
      createdAtMs: Date.now(),
      actorLogin: author,
    });

    adaptEventPublishResultToHost(
      await input.bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          requestDeliveryId: githubDeliveryId(input.deliveryId, "prompt"),
          queue: "prompt",
          messages,
          raw: {
            ...projectGithubAuthenticatedActor(typeof author === "string" ? author : undefined),
            github: {
              repoFullName: input.repoFullName,
              issueNumber,
              trigger: { kind: "comment", commentId },
            },
          },
        },
        {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
        },
      ),
    );

    published = true;
    return requestId;
  })().finally(async () => {
    if (published) return;
    restoreGithubLatestRequestForSession(latestTransition);
    await cleanupFailedGithubRequest(requestId, input.logger, input.api);
  });
}

async function onReviewRequested(input: {
  bus: LilacBus;
  logger: Logger;
  repoFullName: string;
  deliveryId?: string;
  payload: z.output<typeof githubReviewRequestedPayloadSchema>;
  botLogins: readonly string[];
  api: GithubWebhookApi;
}): Promise<string | null> {
  const requestedLogin = input.payload.requested_reviewer?.login;
  if (!requestedLogin) {
    // If this is a team review request, ignore for now.
    return null;
  }
  const senderLogin = input.payload.sender?.login;

  if (input.botLogins.length > 0 && !input.botLogins.includes(requestedLogin)) {
    // Review request is for someone else.
    input.logger.debug("github.webhook.ignored", {
      event: "pull_request",
      action: "review_requested",
      repo: input.repoFullName,
      requestedLogin,
      reason: "review_requested_for_different_actor",
    });
    return null;
  }

  const prNumber = input.payload.pull_request.number;
  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) return null;

  const sessionId = `${input.repoFullName}#${prNumber}`;
  return runGithubSessionOperation(sessionId, async () => {
    const requestId = newGithubRequestId({
      sessionId,
      triggerId: String(prNumber),
      suffix: input.deliveryId ?? crypto.randomUUID(),
    });
    const previousRequestId = getGithubLatestRequestForSession(sessionId);
    const acknowledgementClaim = claimGithubAcknowledgement(previousRequestId, requestId);
    const latestTransition = setGithubLatestRequestForSession(sessionId, requestId);
    let startupCompleted = false;
    setGithubRequestMeta({
      requestId,
      sessionId,
      repoFullName: input.repoFullName,
      issueNumber: prNumber,
      trigger: { kind: "issue", issueNumber: prNumber },
      createdAtMs: Date.now(),
      actorLogin: senderLogin,
      pr: { prNumber, headSha: input.payload.pull_request.head.sha, mode: "review" },
    });

    return await (async () => {
      input.logger.info("github trigger: review_requested", {
        repo: input.repoFullName,
        prNumber,
        requestedLogin,
        requestId,
      });

      // Ack quickly on the PR description (issue).
      if (acknowledgementClaim.kind === "unclaimed") {
        const ack = await captureGithubWebhookOperation("review acknowledgement", () =>
          input.api.addEyesReactionToIssue({ owner, repo, issueNumber: prNumber }),
        );
        ack.match({
          ok: (reactionId) => {
            setGithubAck(requestId, {
              target: { kind: "issue", issueNumber: prNumber },
              reactionId,
            });
          },
          err: (error) => {
            input.logger.warn("failed to add eyes reaction", formatTaggedErrorForLog(error));
          },
        });
      }

      const prData = await input.api.getPullRequest({ owner, repo, number: prNumber });
      const prompt = buildPrReviewPrompt({
        repoFullName: input.repoFullName,
        prNumber,
        prTitle: prData.title,
        prBody: prData.body ?? null,
        prUrl: prData.html_url,
        headSha: prData.head.sha,
      });
      const messages: BusMessageV2[] = [{ role: "user", content: prompt }];

      setGithubRequestMeta({
        requestId,
        sessionId,
        repoFullName: input.repoFullName,
        issueNumber: prNumber,
        trigger: { kind: "issue", issueNumber: prNumber },
        createdAtMs: Date.now(),
        actorLogin: senderLogin,
        pr: { prNumber, headSha: prData.head.sha, mode: "review" },
      });

      adaptEventPublishResultToHost(
        await input.bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: githubDeliveryId(input.deliveryId, "prompt"),
            queue: "prompt",
            messages,
            raw: {
              ...projectGithubAuthenticatedActor(
                typeof senderLogin === "string" ? senderLogin : undefined,
              ),
              github: {
                repoFullName: input.repoFullName,
                prNumber,
                headSha: prData.head.sha,
                trigger: { kind: "issue", issueNumber: prNumber },
                mode: "review",
              },
            },
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: "github",
            },
          },
        ),
      );

      startupCompleted = true;
      return requestId;
    })().finally(async () => {
      if (!startupCompleted) {
        rollbackGithubAcknowledgementClaim(acknowledgementClaim);
        restoreGithubLatestRequestForSession(latestTransition);
        await cleanupFailedGithubRequest(requestId, input.logger, input.api);
      }
    });
  });
}

async function onPullRequestSynchronize(input: {
  bus: LilacBus;
  logger: Logger;
  repoFullName: string;
  deliveryId?: string;
  payload: z.output<typeof githubPullRequestSynchronizePayloadSchema>;
  api: GithubWebhookApi;
}): Promise<string | null> {
  const prNumber = input.payload.pull_request.number;
  const headSha = input.payload.pull_request.head.sha;

  const sessionId = `${input.repoFullName}#${prNumber}`;
  return runGithubSessionOperation(sessionId, async () => {
    const latest = getGithubLatestRequestForSession(sessionId);
    if (!latest) return null;
    const meta = getGithubRequestMeta(latest);
    if (!meta?.pr || meta.pr.mode !== "review") return null;

    const ageMs = Date.now() - meta.createdAtMs;
    if (ageMs > 30 * 60 * 1000) {
      // Avoid surprise reruns long after a review completed.
      return null;
    }

    if (meta.pr.headSha === headSha) return null;

    input.logger.info("github pr updated mid-review; restarting", {
      repo: input.repoFullName,
      prNumber,
      prevSha: meta.pr.headSha,
      nextSha: headSha,
      prevRequestId: meta.requestId,
    });

    const [owner, repo] = input.repoFullName.split("/");
    if (!owner || !repo) return null;

    const requestId = newGithubRequestId({
      sessionId,
      triggerId: String(prNumber),
      suffix: input.deliveryId ?? crypto.randomUUID(),
    });

    const prData = await input.api.getPullRequest({ owner, repo, number: prNumber });
    const prompt = buildPrReviewPrompt({
      repoFullName: input.repoFullName,
      prNumber,
      prTitle: prData.title,
      prBody: prData.body ?? null,
      prUrl: prData.html_url,
      headSha: prData.head.sha,
    });

    const messages: BusMessageV2[] = [{ role: "user", content: prompt }];

    const acknowledgementClaim = claimGithubAcknowledgement(meta.requestId, requestId);

    // Immediately treat the new request as the latest to suppress any stale output.
    const latestTransition = setGithubLatestRequestForSession(sessionId, requestId);
    let replacementPublished = false;

    return await (async () => {
      setGithubRequestMeta({
        requestId,
        sessionId,
        repoFullName: input.repoFullName,
        issueNumber: prNumber,
        trigger: { kind: "issue", issueNumber: prNumber },
        createdAtMs: Date.now(),
        actorLogin: meta.actorLogin,
        pr: { prNumber, headSha: prData.head.sha, mode: "review" },
      });

      adaptEventPublishResultToHost(
        await input.bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: githubDeliveryId(input.deliveryId, "prompt"),
            queue: "prompt",
            messages,
            raw: {
              ...projectGithubAuthenticatedActor(meta.actorLogin),
              github: {
                repoFullName: input.repoFullName,
                prNumber,
                headSha: prData.head.sha,
                trigger: { kind: "issue", issueNumber: prNumber },
                mode: "review",
                restartedFrom: meta.requestId,
              },
            },
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: "github",
            },
          },
        ),
      );

      // Once the replacement is durable, retaining its ownership is safer than reviving stale output.
      replacementPublished = true;

      // This interrupt is only applied if the old request is still active.
      adaptEventPublishResultToHost(
        await input.bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: githubDeliveryId(input.deliveryId, "interrupt"),
            queue: "interrupt",
            messages: [
              {
                role: "user",
                content:
                  "Branch updated (new commits pushed). Cancel the current review immediately and stop producing output.",
              },
            ],
            raw: { cancel: true, requiresActive: true },
          },
          {
            headers: {
              request_id: meta.requestId,
              session_id: sessionId,
              request_client: "github",
            },
          },
        ),
      );

      return requestId;
    })().finally(async () => {
      if (!replacementPublished) {
        rollbackGithubAcknowledgementClaim(acknowledgementClaim);
        restoreGithubLatestRequestForSession(latestTransition);
        await cleanupFailedGithubRequest(requestId, input.logger, input.api);
      }
    });
  });
}
