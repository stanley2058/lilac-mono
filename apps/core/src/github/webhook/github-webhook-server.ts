import crypto from "node:crypto";
import Elysia from "elysia";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";
import { env, resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import type { ModelMessage } from "ai";

import {
  addEyesReactionToIssue,
  addEyesReactionToIssueComment,
  getGithubAppSlugOrNull,
  getGithubUserLoginOrNull,
  getIssue,
  getPullRequest,
  listIssueComments,
} from "../github-api";
import {
  clearGithubAck,
  getGithubLatestRequestForSession,
  getGithubAck,
  getGithubRequestMeta,
  setGithubAck,
  setGithubLatestRequestForSession,
  setGithubRequestMeta,
} from "../github-state";

type GithubWebhookOptions = {
  bus: LilacBus;
  subscriptionId: string;
};

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
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

  const userLogin = await getGithubUserLoginOrNull().catch(() => null);
  if (userLogin) {
    out.push(userLogin);
  }

  // Also derive the GitHub App bot login when possible.
  const slug = await getGithubAppSlugOrNull().catch(() => null);
  if (slug) {
    out.push(`${slug}[bot]`);
  }

  // De-dupe while preserving order.
  return [...new Set(out)];
}

function stripBotMentions(text: string, botLogins: readonly string[]): string {
  let out = text;
  for (const login of botLogins) {
    // Replace '@login' mentions with empty string.
    out = out.replaceAll(`@${login}`, "");
  }
  return out.trim();
}

function isLilacCommand(text: string): boolean {
  const t = text.trim();
  return t === "/lilac" || t.startsWith("/lilac ");
}

function extractLilacCommandText(text: string): string {
  const t = text.trim();
  if (t === "/lilac") return "";
  if (!t.startsWith("/lilac ")) return t;
  return t.slice("/lilac ".length).trim();
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

export async function startGithubWebhookServer(options: GithubWebhookOptions): Promise<{
  stop(): Promise<void>;
}> {
  const logger = new Logger({
    module: "github:webhook",
    logLevel: resolveLogLevel(),
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
  logger.info("GitHub webhook server init", {
    port,
    path,
    botLogins,
  });

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
    seen.set(deliveryId, now + DEDUPE_TTL_MS);
    return false;
  }

  const app = new Elysia();

  app.post(path, async ({ request, set }) => {
    const event = request.headers.get("x-github-event") ?? "";
    const deliveryId = request.headers.get("x-github-delivery") ?? undefined;
    const sig256 = request.headers.get("x-hub-signature-256");

    const raw = new Uint8Array(await request.arrayBuffer());
    if (!verifyGithubWebhookSignature({ secret, signature256: sig256, rawBody: raw })) {
      set.status = 401;
      return { ok: false, error: "invalid signature" };
    }

    if (dedupe(deliveryId)) {
      return { ok: true, deduped: true };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      set.status = 400;
      return { ok: false, error: "invalid json" };
    }

    try {
      await handleEvent({ bus: options.bus, logger, event, payload, botLogins });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("webhook handler failed", { event, deliveryId }, e);
      set.status = 500;
      return { ok: false, error: msg };
    }

    return { ok: true };
  });

  const server = app.listen({ port });
  logger.info("GitHub webhook server started", { port, path });

  return {
    stop: async () => {
      try {
        server.stop();
      } catch {
        // ignore
      }
    },
  };
}

async function handleEvent(input: {
  bus: LilacBus;
  logger: Logger;
  event: string;
  payload: unknown;
  botLogins: readonly string[];
}) {
  const p = input.payload;
  if (!p || typeof p !== "object") return;
  const action = (p as Record<string, unknown>)["action"];
  const repo = (p as Record<string, unknown>)["repository"];
  const repoFullName =
    repo && typeof repo === "object"
      ? ((repo as Record<string, unknown>)["full_name"] as unknown)
      : undefined;

  if (typeof repoFullName !== "string" || repoFullName.length === 0) return;

  if (input.event === "issue_comment" && action === "created") {
    await onIssueCommentCreated({
      bus: input.bus,
      logger: input.logger,
      repoFullName,
      payload: p as Record<string, unknown>,
      botLogins: input.botLogins,
    });
    return;
  }

  if (input.event === "pull_request" && action === "review_requested") {
    await onReviewRequested({
      bus: input.bus,
      logger: input.logger,
      repoFullName,
      payload: p as Record<string, unknown>,
      botLogins: input.botLogins,
    });
    return;
  }

  if (input.event === "pull_request" && action === "synchronize") {
    await onPullRequestSynchronize({
      bus: input.bus,
      logger: input.logger,
      repoFullName,
      payload: p as Record<string, unknown>,
    });
    return;
  }
}

async function onIssueCommentCreated(input: {
  bus: LilacBus;
  logger: Logger;
  repoFullName: string;
  payload: Record<string, unknown>;
  botLogins: readonly string[];
}) {
  const issue = input.payload["issue"];
  const comment = input.payload["comment"];
  if (!issue || typeof issue !== "object") return;
  if (!comment || typeof comment !== "object") return;

  const issueNumber = (issue as Record<string, unknown>)["number"];
  const commentId = (comment as Record<string, unknown>)["id"];
  const body = (comment as Record<string, unknown>)["body"];
  const htmlUrl = (comment as Record<string, unknown>)["html_url"];
  const user = (comment as Record<string, unknown>)["user"];
  const author =
    user && typeof user === "object"
      ? ((user as Record<string, unknown>)["login"] as unknown)
      : undefined;

  if (typeof issueNumber !== "number" || typeof commentId !== "number") return;
  if (typeof body !== "string" || body.trim().length === 0) return;

  const shouldTrigger =
    isLilacCommand(body) || input.botLogins.some((login) => body.includes(`@${login}`));
  if (!shouldTrigger) return;

  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) return;

  const sessionId = `${input.repoFullName}#${issueNumber}`;
  const requestId = newGithubRequestId({
    sessionId,
    triggerId: String(commentId),
  });

  input.logger.info("github trigger: issue_comment", {
    repo: input.repoFullName,
    issueNumber,
    commentId,
    requestId,
  });

  // Ack quickly with 👀 (best-effort).
  try {
    const reactionId = await addEyesReactionToIssueComment({
      owner,
      repo,
      commentId,
    });
    setGithubAck(requestId, {
      target: { kind: "comment", commentId, issueNumber },
      reactionId,
    });
  } catch (e) {
    input.logger.warn("failed to add 👀 reaction", { requestId }, e);
  }

  const issueData = await getIssue({ owner, repo, number: issueNumber });
  const recent = await listIssueComments({ owner, repo, number: issueNumber, limit: 30 });

  const commandText = isLilacCommand(body)
    ? extractLilacCommandText(body)
    : stripBotMentions(body, input.botLogins);
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

  const messages: ModelMessage[] = [{ role: "user", content: prompt }];

  setGithubRequestMeta({
    requestId,
    sessionId,
    repoFullName: input.repoFullName,
    issueNumber,
    trigger: { kind: "comment", commentId, issueNumber },
    createdAtMs: Date.now(),
  });

  await input.bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
      queue: "prompt",
      messages,
      raw: {
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
  );
}

async function onReviewRequested(input: {
  bus: LilacBus;
  logger: Logger;
  repoFullName: string;
  payload: Record<string, unknown>;
  botLogins: readonly string[];
}) {
  const pr = input.payload["pull_request"];
  if (!pr || typeof pr !== "object") return;

  const requested = input.payload["requested_reviewer"];
  const requestedLogin =
    requested && typeof requested === "object"
      ? ((requested as Record<string, unknown>)["login"] as unknown)
      : undefined;
  if (typeof requestedLogin !== "string" || requestedLogin.length === 0) {
    // If this is a team review request, ignore for now.
    return;
  }

  if (input.botLogins.length > 0 && !input.botLogins.includes(requestedLogin)) {
    // Review request is for someone else.
    return;
  }

  const prNumber = (pr as Record<string, unknown>)["number"];
  const head = (pr as Record<string, unknown>)["head"];
  const headSha =
    head && typeof head === "object"
      ? ((head as Record<string, unknown>)["sha"] as unknown)
      : undefined;

  if (typeof prNumber !== "number" || typeof headSha !== "string" || !headSha) return;

  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) return;

  const sessionId = `${input.repoFullName}#${prNumber}`;
  const requestId = newGithubRequestId({
    sessionId,
    triggerId: String(prNumber),
    suffix: headSha.slice(0, 8),
  });

  input.logger.info("github trigger: review_requested", {
    repo: input.repoFullName,
    prNumber,
    requestedLogin,
    requestId,
  });

  // Ack quickly on the PR description (issue).
  try {
    const reactionId = await addEyesReactionToIssue({ owner, repo, issueNumber: prNumber });
    setGithubAck(requestId, {
      target: { kind: "issue", issueNumber: prNumber },
      reactionId,
    });
  } catch (e) {
    input.logger.warn("failed to add 👀 reaction", { requestId }, e);
  }

  const prData = await getPullRequest({ owner, repo, number: prNumber });

  const prompt = buildPrReviewPrompt({
    repoFullName: input.repoFullName,
    prNumber,
    prTitle: prData.title,
    prBody: prData.body ?? null,
    prUrl: prData.html_url,
    headSha: prData.head.sha,
  });

  const messages: ModelMessage[] = [{ role: "user", content: prompt }];

  setGithubLatestRequestForSession(sessionId, requestId);
  setGithubRequestMeta({
    requestId,
    sessionId,
    repoFullName: input.repoFullName,
    issueNumber: prNumber,
    trigger: { kind: "issue", issueNumber: prNumber },
    createdAtMs: Date.now(),
    pr: { prNumber, headSha: prData.head.sha, mode: "review" },
  });

  await input.bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
      queue: "prompt",
      messages,
      raw: {
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
  );
}

async function onPullRequestSynchronize(input: {
  bus: LilacBus;
  logger: Logger;
  repoFullName: string;
  payload: Record<string, unknown>;
}) {
  const pr = input.payload["pull_request"];
  if (!pr || typeof pr !== "object") return;
  const prNumber = (pr as Record<string, unknown>)["number"];
  const head = (pr as Record<string, unknown>)["head"];
  const headSha =
    head && typeof head === "object"
      ? ((head as Record<string, unknown>)["sha"] as unknown)
      : undefined;
  if (typeof prNumber !== "number" || typeof headSha !== "string" || !headSha) return;

  const sessionId = `${input.repoFullName}#${prNumber}`;
  const latest = getGithubLatestRequestForSession(sessionId);
  if (!latest) return;
  const meta = getGithubRequestMeta(latest);
  if (!meta?.pr || meta.pr.mode !== "review") return;

  const ageMs = Date.now() - meta.createdAtMs;
  if (ageMs > 30 * 60 * 1000) {
    // Avoid surprise reruns long after a review completed.
    return;
  }

  if (meta.pr.headSha === headSha) return;

  input.logger.info("github pr updated mid-review; restarting", {
    repo: input.repoFullName,
    prNumber,
    prevSha: meta.pr.headSha,
    nextSha: headSha,
    prevRequestId: meta.requestId,
  });

  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) return;

  const requestId = newGithubRequestId({
    sessionId,
    triggerId: String(prNumber),
    suffix: headSha.slice(0, 8),
  });

  const prevAck = getGithubAck(meta.requestId);
  if (prevAck) {
    setGithubAck(requestId, prevAck);
    clearGithubAck(meta.requestId);
  }

  // Immediately treat the new request as the latest to suppress any stale output.
  setGithubLatestRequestForSession(sessionId, requestId);

  // Cancel the in-flight request to unblock the session queue ASAP.
  // This message is only applied if the request is currently active.
  await input.bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
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
  );

  // Keep the 👀 reaction as the "in progress" indicator.
  // Fetch updated PR info for better prompt stability.
  const prData = await getPullRequest({ owner, repo, number: prNumber });
  const prompt = buildPrReviewPrompt({
    repoFullName: input.repoFullName,
    prNumber,
    prTitle: prData.title,
    prBody: prData.body ?? null,
    prUrl: prData.html_url,
    headSha: prData.head.sha,
  });

  const messages: ModelMessage[] = [{ role: "user", content: prompt }];

  setGithubLatestRequestForSession(sessionId, requestId);
  setGithubRequestMeta({
    requestId,
    sessionId,
    repoFullName: input.repoFullName,
    issueNumber: prNumber,
    trigger: { kind: "issue", issueNumber: prNumber },
    createdAtMs: Date.now(),
    pr: { prNumber, headSha: prData.head.sha, mode: "review" },
  });

  await input.bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
      queue: "prompt",
      messages,
      raw: {
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
  );
}
