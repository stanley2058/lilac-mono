import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  FakeGithub,
  startE2E,
  unusedPort,
  type E2E,
  type GithubCall,
  type ModelMessage,
} from "./harness";

const SECRET = "e2e-webhook-secret";
const REPO = "acme/widgets";

let e2e: E2E;
let github: FakeGithub;
let webhookUrl: string;

beforeAll(async () => {
  github = new FakeGithub().start();
  const port = await unusedPort();
  webhookUrl = `http://127.0.0.1:${port}/hooks/github`;
  e2e = await startE2E({
    env: {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_WEBHOOK_PORT: String(port),
      GITHUB_WEBHOOK_PATH: "/hooks/github",
    },
    prepare: (layout) => github.installApp(layout.dataDir),
  });
}, 60_000);
afterAll(async () => {
  await e2e?.[Symbol.asyncDispose]();
  await github?.stop();
  expect(e2e?.model.unhandled ?? []).toEqual([]);
  expect(github?.unhandled ?? []).toEqual([]);
}, 60_000);

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const userText = (messages: ModelMessage[]) =>
  messages.flatMap((message) => (message.role === "user" ? [message.text] : [])).join("\n");
const isPost = (path: string) => (call: GithubCall) => call.method === "POST" && call.path === path;

/** Resolves once the run's reply is posted and its eyes acknowledgement is removed. */
async function answered(input: {
  issue: number;
  reactionPath: string;
  after?: number;
  label: string;
}): Promise<{ reaction: GithubCall; reply: GithubCall; removal: GithubCall }> {
  const since = (call: GithubCall) => github.calls.indexOf(call) >= (input.after ?? 0);
  const reaction = await github.waitFor(
    (call) => since(call) && isPost(input.reactionPath)(call),
    `${input.label} eyes reaction`,
  );
  const reply = await github.waitFor(
    (call) => since(call) && isPost(`/repos/${REPO}/issues/${input.issue}/comments`)(call),
    `${input.label} reply`,
  );
  const reactionId = (reaction.response as { id: number }).id;
  const removal = await github.waitFor(
    (call) =>
      since(call) &&
      call.method === "DELETE" &&
      call.path === `${input.reactionPath}/${reactionId}`,
    `${input.label} acknowledgement removal`,
  );
  return { reaction, reply, removal };
}

const JWT = /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u;

/** Every repository call carries the installation token minted for the App. */
function expectInstallationToken(calls: GithubCall[]) {
  const repository = calls.filter((call) => call.path.startsWith("/repos/"));
  expect(repository.length).toBeGreaterThan(0);
  expect(repository.map((call) => call.headers.authorization)).toEqual(
    repository.map(() => `token ${github.installationToken}`),
  );
}

test("Core resolves its bot login from the configured GitHub App at startup", () => {
  // The fake verifies the JWT's RS256 signature and issuer against the installed App key.
  expect(github.calls.map((call) => [call.method, call.path, call.status])).toEqual([
    ["GET", "/app", 200],
  ]);
  expect(github.calls[0]!.headers.authorization).toMatch(JWT);
});

test("a mention on an issue runs the agent and replies once on the issue", async () => {
  github.addIssue({
    repo: REPO,
    number: 7,
    title: "Widget crashes on resize",
    body: "Resizing the widget below 10px throws.",
    author: "octo-reporter",
  });
  const tag = e2e.model.script("gh-issue", (_request, model) => {
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: "echo widget-check-ok" } }] };
    const bash = model.json<{ stdout: string; exitCode: number }>("bash");
    expect(bash.exitCode).toBe(0);
    return { text: `Checked the widget: ${bash.stdout.trim()}` };
  });
  const { payload, comment } = github.issueCommentCreated({
    repo: REPO,
    number: 7,
    author: "octo-maintainer",
    association: "OWNER",
    body: `@${github.botLogin} ${tag} please look at this crash`,
  });
  const start = github.calls.length;
  expect(
    await github.deliver({ url: webhookUrl, secret: SECRET, event: "issue_comment", payload }),
  ).toEqual({ status: 200, body: { ok: true } });

  const reactionPath = `/repos/${REPO}/issues/comments/${comment.id}/reactions`;
  const { reaction, reply, removal } = await answered({ issue: 7, reactionPath, label: "issue" });

  expect(reaction.status).toBe(201);
  expect(reaction.body).toEqual({ content: "eyes" });
  expect(removal.status).toBe(204);
  expect(github.reactionsOn({ comment: Number(comment.id) })).toEqual([]);
  const traffic = github.calls.slice(start);
  expect(traffic.indexOf(reaction)).toBeLessThan(traffic.indexOf(reply));
  expect(traffic.indexOf(reply)).toBeLessThan(traffic.indexOf(removal));
  expectInstallationToken(traffic);

  // The agent sees the issue the API returned and the trigger, and runs its tool before replying.
  const requests = e2e.model.forScenario("gh-issue");
  expect(requests.map((entry) => entry.reply?.toolCalls?.[0]?.name ?? entry.reply?.text)).toEqual([
    "bash",
    "Checked the widget: widget-check-ok",
  ]);
  const prompt = userText(requests[0]!.request.messages);
  expect(prompt).toContain(`GitHub thread: ${github.url}/${REPO}/issues/7`);
  expect(prompt).toContain("Title: Widget crashes on resize");
  expect(prompt).toContain("Resizing the widget below 10px throws.");
  expect(prompt).toContain(`@octo-maintainer: ${tag} please look at this crash`);

  const body = (reply.body as { body: string }).body;
  expect(body.split("\n")[0]).toBe("<!-- lilac:agent-comment -->");
  expect(body).toContain(`In reply to ${String(comment.html_url)}:`);
  expect(occurrences(body, "Checked the widget: widget-check-ok")).toBe(1);
  expect(traffic.filter(isPost(`/repos/${REPO}/issues/7/comments`))).toHaveLength(1);
  expect(github.commentsOn(REPO, 7).map((stored) => stored.user.login)).toEqual([
    "octo-maintainer",
    github.botLogin,
  ]);
}, 60_000);

test("a review request on a pull request gives the agent the PR the API returned", async () => {
  const head = { ref: "fix/resize-guard", sha: "4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b" };
  const tag = e2e.model.script("gh-review", () => ({ text: "Reviewed: the guard looks right." }));
  github.addIssue({
    repo: REPO,
    number: 12,
    title: "Add a resize guard",
    body: `Clamp the widget size before layout. ${tag}`,
    author: "octo-contributor",
    pull: { head, base: { ref: "main", sha: "0123456789abcdef0123456789abcdef01234567" } },
  });
  const start = github.calls.length;
  const payload = github.reviewRequested({
    repo: REPO,
    number: 12,
    sender: "octo-maintainer",
    reviewer: github.botLogin,
  });
  expect(
    await github.deliver({ url: webhookUrl, secret: SECRET, event: "pull_request", payload }),
  ).toEqual({ status: 200, body: { ok: true } });

  const reactionPath = `/repos/${REPO}/issues/12/reactions`;
  const { reply } = await answered({ issue: 12, reactionPath, after: start, label: "review" });
  const traffic = github.calls.slice(start);
  expect(
    traffic.some((call) => call.method === "GET" && call.path === `/repos/${REPO}/pulls/12`),
  ).toBe(true);
  expectInstallationToken(traffic);

  const [request] = e2e.model.forScenario("gh-review");
  const prompt = userText(request!.request.messages);
  expect(prompt).toContain(`GitHub PR: ${github.url}/${REPO}/pull/12`);
  expect(prompt).toContain("Title: Add a resize guard");
  expect(prompt).toContain("Clamp the widget size before layout.");
  expect(prompt).toContain(`Head SHA (must stay stable for this review): ${head.sha}`);
  expect(prompt).toContain(`gh pr view 12 --repo ${REPO}`);
  // A review request targets the PR body, so the permalink prefix has no comment anchor.
  expect((reply.body as { body: string }).body).toBe(
    `<!-- lilac:agent-comment -->\nIn reply to ${github.url}/${REPO}/issues/12:\n\nReviewed: the guard looks right.`,
  );
}, 60_000);

test("a webhook without a valid signature is rejected and starts no run", async () => {
  github.addIssue({
    repo: REPO,
    number: 21,
    title: "Forged request",
    body: null,
    author: "octo-reporter",
  });
  const tag = e2e.model.script("gh-forged", () => ({ text: "Answered the signed delivery." }));
  const { payload, comment } = github.issueCommentCreated({
    repo: REPO,
    number: 21,
    author: "octo-maintainer",
    association: "OWNER",
    body: `@${github.botLogin} ${tag} run this`,
  });
  const start = github.calls.length;
  for (const forged of [
    { secret: "not-the-secret" },
    { secret: SECRET, signature: null },
    { secret: SECRET, signature: `sha256=${"0".repeat(64)}` },
    { secret: SECRET, signature: "sha1=deadbeef" },
  ])
    expect(
      await github.deliver({ url: webhookUrl, event: "issue_comment", payload, ...forged }),
    ).toEqual({ status: 401, body: { ok: false, error: "invalid signature" } });
  // Rejection happens before the delivery is queued, so Core never reached GitHub.
  expect(github.calls.slice(start)).toEqual([]);

  // The same payload, correctly signed, runs exactly once.
  expect(
    await github.deliver({ url: webhookUrl, secret: SECRET, event: "issue_comment", payload }),
  ).toEqual({ status: 200, body: { ok: true } });
  const reactionPath = `/repos/${REPO}/issues/comments/${comment.id}/reactions`;
  await answered({ issue: 21, reactionPath, after: start, label: "signed" });
  expect(e2e.model.forScenario("gh-forged")).toHaveLength(1);
  expect(github.calls.slice(start).filter(isPost(reactionPath))).toHaveLength(1);
}, 60_000);

test("a redelivered webhook does not start a second run", async () => {
  github.addIssue({
    repo: REPO,
    number: 33,
    title: "Redelivered request",
    body: null,
    author: "octo-reporter",
  });
  const tag = e2e.model.script("gh-redeliver", () => ({ text: "Answered once." }));
  const { payload, comment } = github.issueCommentCreated({
    repo: REPO,
    number: 33,
    author: "octo-maintainer",
    association: "OWNER",
    body: `@${github.botLogin} ${tag} answer once`,
  });
  const deliveryId = crypto.randomUUID();
  const delivery = { url: webhookUrl, secret: SECRET, event: "issue_comment", payload, deliveryId };
  const start = github.calls.length;
  expect(await github.deliver(delivery)).toEqual({ status: 200, body: { ok: true } });
  const reactionPath = `/repos/${REPO}/issues/comments/${comment.id}/reactions`;
  await answered({ issue: 33, reactionPath, after: start, label: "first delivery" });

  const handled = github.calls.length;
  expect(await github.deliver(delivery)).toEqual({
    status: 200,
    body: { ok: true, deduped: true },
  });
  // A deduplicated delivery is acknowledged without being queued, so Core makes no GitHub calls.
  expect(github.calls.slice(handled)).toEqual([]);
  expect(e2e.model.forScenario("gh-redeliver")).toHaveLength(1);
  expect(
    github.commentsOn(REPO, 33).filter((stored) => stored.user.login === github.botLogin),
  ).toHaveLength(1);
}, 60_000);

test("Core mints one installation token and reuses it for every repository call", () => {
  const mints = github.calls.filter((call) => call.path.startsWith("/app/"));
  expect(mints.map((call) => [call.method, call.path, call.status])).toEqual([
    ["POST", `/app/installations/${github.installationId}/access_tokens`, 201],
  ]);
  expect(mints[0]!.headers.authorization).toMatch(JWT);
  expectInstallationToken(github.calls);
});

// GitHub's "Redeliver" button resends a delivery with the same id, after the request completed and
// its delivery record was deleted. Runs last because it restarts Core.
test("a webhook redelivered after Core restarts does not start a second run", async () => {
  github.addIssue({
    repo: REPO,
    number: 44,
    title: "Redelivered after restart",
    body: null,
    author: "octo-reporter",
  });
  const tag = e2e.model.script("gh-restart", () => ({ text: "Answered before the restart." }));
  const barrierTag = e2e.model.script("gh-restart-barrier", () => ({
    text: "Barrier answered.",
  }));
  const first = github.issueCommentCreated({
    repo: REPO,
    number: 44,
    author: "octo-maintainer",
    association: "OWNER",
    body: `@${github.botLogin} ${tag} answer once`,
  });
  const delivery = {
    url: webhookUrl,
    secret: SECRET,
    event: "issue_comment",
    payload: first.payload,
    deliveryId: crypto.randomUUID(),
  };
  const start = github.calls.length;
  expect(await github.deliver(delivery)).toEqual({ status: 200, body: { ok: true } });
  const reactionPath = `/repos/${REPO}/issues/comments/${first.comment.id}/reactions`;
  await answered({ issue: 44, reactionPath, after: start, label: "first delivery" });

  await e2e.restart();
  const restarted = github.calls.length;
  const redelivered = await github.deliver(delivery);
  expect(redelivered.status).toBe(200);
  // A handler that accepted the redelivery reads the thread before publishing its request.
  if ((redelivered.body as { deduped?: boolean }).deduped !== true)
    await github.waitFor(
      (call) =>
        github.calls.indexOf(call) >= restarted &&
        call.method === "GET" &&
        call.path === `/repos/${REPO}/issues/44/comments`,
      "redelivery handled",
    );
  // Runs in one thread are serialized, so a duplicate run would reach the model before this one.
  const barrier = github.issueCommentCreated({
    repo: REPO,
    number: 44,
    author: "octo-maintainer",
    association: "OWNER",
    body: `@${github.botLogin} ${barrierTag} are you there?`,
  });
  const barrierStart = github.calls.length;
  await github.deliver({
    url: webhookUrl,
    secret: SECRET,
    event: "issue_comment",
    payload: barrier.payload,
  });
  await answered({
    issue: 44,
    reactionPath: `/repos/${REPO}/issues/comments/${barrier.comment.id}/reactions`,
    after: barrierStart,
    label: "barrier",
  });
  expect(e2e.model.forScenario("gh-restart")).toHaveLength(1);
  expect(
    github
      .commentsOn(REPO, 44)
      .filter((stored) => stored.body.includes("Answered before the restart.")),
  ).toHaveLength(1);
}, 90_000);
