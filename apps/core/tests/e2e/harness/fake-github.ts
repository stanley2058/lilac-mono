import crypto from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withinRedisDeadline } from "../../../../../packages/event-bus/tests/helpers/isolated-redis";

/**
 * A stateful stand-in for the GitHub REST API and webhook sender. It serves only the endpoints
 * Core calls for webhook ingress and the GitHub relay, with response fields named as in GitHub's
 * REST reference, and records every call so scenarios can assert on traffic and credentials.
 */

export type GithubCall = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  /** The JSON the fake answered with, or undefined for an empty response. */
  response: unknown;
};

type GithubUser = {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_id: string;
  url: string;
  html_url: string;
  type: "User" | "Bot";
  site_admin: boolean;
};

type StoredIssue = {
  owner: string;
  repo: string;
  number: number;
  id: number;
  title: string;
  body: string | null;
  user: GithubUser;
  createdAt: string;
  pull?: { head: { ref: string; sha: string }; base: { ref: string; sha: string } };
};

type StoredComment = {
  id: number;
  issueKey: string;
  user: GithubUser;
  body: string;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
  viaApp: boolean;
};

type StoredReaction = {
  id: number;
  subject: string;
  user: GithubUser;
  content: string;
  createdAt: string;
};

const REACTIONS = new Set(["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"]);

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function nodeId(prefix: string, id: number): string {
  return `${prefix}_${Buffer.from(String(id)).toString("base64url")}`;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "x-github-media-type": "github.v3; format=json", ...headers },
  });
}

function notFound(): Response {
  return json(
    {
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest",
      status: "404",
    },
    404,
  );
}

export class FakeGithub {
  readonly appId = 424_242;
  readonly installationId = 71_000_001;
  readonly slug = "lilac-e2e";
  /** The installation token every token-authenticated call must carry. */
  readonly installationToken = `ghs_${crypto.randomBytes(18).toString("base64url")}`;
  readonly calls: GithubCall[] = [];
  /** Calls the fake could not route or authenticate; scenarios expect this to stay empty. */
  readonly unhandled: string[] = [];
  /** Collaborator permission per login; unknown logins read as `read`. */
  readonly permissions = new Map<string, string>();

  private readonly keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly users = new Map<string, GithubUser>();
  private readonly issues = new Map<string, StoredIssue>();
  private readonly comments = new Map<number, StoredComment>();
  private readonly reactions = new Map<number, StoredReaction>();
  private readonly listeners = new Set<() => void>();
  private nextId = 9_100_000;
  private server: ReturnType<typeof Bun.serve> | undefined;

  get url(): string {
    if (!this.server) throw new Error("Fake GitHub is not started");
    return this.server.url.href.replace(/\/$/u, "");
  }

  get botLogin(): string {
    return `${this.slug}[bot]`;
  }

  start(): this {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    return this;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
  }

  /** Writes the GitHub App credentials Core reads from `DATA_DIR/secret`. */
  async installApp(dataDir: string): Promise<void> {
    const secretDir = path.join(dataDir, "secret");
    await mkdir(secretDir, { recursive: true });
    const pemPath = path.join(secretDir, "github-app.private-key.pem");
    const jsonPath = path.join(secretDir, "github-app.json");
    await writeFile(
      pemPath,
      this.keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    await writeFile(
      jsonPath,
      JSON.stringify({
        type: "github_app",
        appId: this.appId,
        installationId: this.installationId,
        apiBaseUrl: this.url,
        privateKeyPath: pemPath,
      }),
    );
    await Promise.all([chmod(pemPath, 0o600), chmod(jsonPath, 0o600)]);
  }

  user(login: string): GithubUser {
    const existing = this.users.get(login);
    if (existing) return existing;
    const id = this.id();
    const bot = login.endsWith("[bot]");
    const created: GithubUser = {
      login,
      id,
      node_id: nodeId(bot ? "BOT" : "U", id),
      avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
      gravatar_id: "",
      url: `${this.url}/users/${encodeURIComponent(login)}`,
      html_url: bot ? `${this.url}/apps/${this.slug}` : `${this.url}/${login}`,
      type: bot ? "Bot" : "User",
      site_admin: false,
    };
    this.users.set(login, created);
    return created;
  }

  addIssue(input: {
    repo: string;
    number: number;
    title: string;
    body: string | null;
    author: string;
    pull?: { head: { ref: string; sha: string }; base: { ref: string; sha: string } };
  }): void {
    const [owner, repo] = input.repo.split("/") as [string, string];
    this.issues.set(input.repo + "#" + input.number, {
      owner,
      repo,
      number: input.number,
      id: this.id(),
      title: input.title,
      body: input.body,
      user: this.user(input.author),
      createdAt: timestamp(),
      ...(input.pull ? { pull: input.pull } : {}),
    });
  }

  /** Stores a human comment and returns the `issue_comment.created` webhook payload for it. */
  issueCommentCreated(input: {
    repo: string;
    number: number;
    author: string;
    body: string;
    association: string;
  }): { payload: Record<string, unknown>; comment: Record<string, unknown> } {
    const issue = this.issue(input.repo, input.number);
    const stored = this.storeComment(issue, this.user(input.author), input.body, {
      association: input.association,
      viaApp: false,
    });
    const comment = this.commentJson(stored);
    return {
      comment,
      payload: {
        action: "created",
        issue: this.issueJson(issue),
        comment,
        repository: this.repositoryJson(issue.owner, issue.repo),
        sender: this.user(input.author),
        installation: { id: this.installationId, node_id: nodeId("MDIz", this.installationId) },
      },
    };
  }

  /** The `pull_request.review_requested` webhook payload for a stored pull request. */
  reviewRequested(input: {
    repo: string;
    number: number;
    sender: string;
    reviewer: string;
  }): Record<string, unknown> {
    const issue = this.issue(input.repo, input.number);
    const pull = this.pullJson(issue);
    return {
      action: "review_requested",
      number: issue.number,
      pull_request: {
        ...pull,
        requested_reviewers: [this.user(input.reviewer)],
      },
      requested_reviewer: this.user(input.reviewer),
      repository: this.repositoryJson(issue.owner, issue.repo),
      sender: this.user(input.sender),
      installation: { id: this.installationId, node_id: nodeId("MDIz", this.installationId) },
    };
  }

  commentsOn(repo: string, number: number): StoredComment[] {
    const key = `${repo}#${number}`;
    return [...this.comments.values()].filter((comment) => comment.issueKey === key);
  }

  reactionsOn(subject: { comment: number } | { repo: string; issue: number }): StoredReaction[] {
    const key =
      "comment" in subject ? `comment:${subject.comment}` : `${subject.repo}#${subject.issue}`;
    return [...this.reactions.values()].filter((reaction) => reaction.subject === key);
  }

  /** Signs and posts a webhook delivery the way GitHub's hookshot does. */
  async deliver(input: {
    url: string;
    secret: string;
    event: string;
    payload: unknown;
    deliveryId?: string;
    /** Overrides the computed `X-Hub-Signature-256`; null omits it. */
    signature?: string | null;
  }): Promise<{ status: number; body: unknown }> {
    const raw = JSON.stringify(input.payload);
    const signature256 =
      input.signature === undefined
        ? `sha256=${crypto.createHmac("sha256", input.secret).update(raw).digest("hex")}`
        : input.signature;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/e2e0001",
      "x-github-event": input.event,
      "x-github-delivery": input.deliveryId ?? crypto.randomUUID(),
      "x-github-hook-id": "500000001",
      "x-github-hook-installation-target-type": "integration",
      "x-github-hook-installation-target-id": String(this.appId),
      "x-hub-signature": `sha1=${crypto.createHmac("sha1", input.secret).update(raw).digest("hex")}`,
    };
    if (signature256 !== null) headers["x-hub-signature-256"] = signature256;
    const response = await fetch(input.url, { method: "POST", headers, body: raw });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  }

  /** Resolves once a recorded call satisfies the predicate. */
  async waitFor(
    predicate: (call: GithubCall) => boolean,
    label = "GitHub call",
    timeoutMs = 30_000,
  ): Promise<GithubCall> {
    const found = new Promise<GithubCall>((resolve) => {
      const check = () => {
        const match = this.calls.find(predicate);
        if (!match) return;
        this.listeners.delete(check);
        resolve(match);
      };
      this.listeners.add(check);
      check();
    });
    return withinRedisDeadline(found, label, timeoutMs).catch((error: Error) => {
      throw new Error(`${error.message}\nGitHub saw:\n${this.describe()}`);
    });
  }

  describe(): string {
    return this.calls
      .map(
        (call) =>
          `${call.method} ${call.path} -> ${call.status} ${JSON.stringify(call.body ?? null).slice(0, 160)}`,
      )
      .join("\n");
  }

  private id(): number {
    return this.nextId++;
  }

  private issue(repo: string, number: number): StoredIssue {
    const issue = this.issues.get(`${repo}#${number}`);
    if (!issue) throw new Error(`Fake GitHub has no issue ${repo}#${number}`);
    return issue;
  }

  private storeComment(
    issue: StoredIssue,
    user: GithubUser,
    body: string,
    options: { association: string; viaApp: boolean },
  ): StoredComment {
    const now = timestamp();
    const stored: StoredComment = {
      id: this.id(),
      issueKey: `${issue.owner}/${issue.repo}#${issue.number}`,
      user,
      body,
      authorAssociation: options.association,
      createdAt: now,
      updatedAt: now,
      viaApp: options.viaApp,
    };
    this.comments.set(stored.id, stored);
    return stored;
  }

  private appJson(): Record<string, unknown> {
    return {
      id: this.appId,
      slug: this.slug,
      client_id: "Iv1.e2e0000000000000",
      node_id: nodeId("A", this.appId),
      owner: this.user("acme"),
      name: "Lilac E2E",
      description: "",
      external_url: "https://example.invalid/lilac",
      html_url: `${this.url}/apps/${this.slug}`,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      permissions: { issues: "write", pull_requests: "write", metadata: "read" },
      events: ["issue_comment", "pull_request"],
    };
  }

  private repositoryJson(owner: string, repo: string): Record<string, unknown> {
    const id =
      [...`${owner}/${repo}`].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) % 1e9;
    const url = `${this.url}/repos/${owner}/${repo}`;
    return {
      id,
      node_id: nodeId("R", id),
      name: repo,
      full_name: `${owner}/${repo}`,
      private: false,
      owner: this.user(owner),
      html_url: `${this.url}/${owner}/${repo}`,
      description: null,
      fork: false,
      url,
      issues_url: `${url}/issues{/number}`,
      pulls_url: `${url}/pulls{/number}`,
      default_branch: "main",
      visibility: "public",
    };
  }

  private issueJson(issue: StoredIssue): Record<string, unknown> {
    const url = `${this.url}/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;
    const web = `${this.url}/${issue.owner}/${issue.repo}`;
    return {
      url,
      repository_url: `${this.url}/repos/${issue.owner}/${issue.repo}`,
      comments_url: `${url}/comments`,
      html_url: issue.pull ? `${web}/pull/${issue.number}` : `${web}/issues/${issue.number}`,
      id: issue.id,
      node_id: nodeId(issue.pull ? "PR" : "I", issue.id),
      number: issue.number,
      title: issue.title,
      user: issue.user,
      labels: [],
      state: "open",
      locked: false,
      assignee: null,
      assignees: [],
      milestone: null,
      comments: this.commentsOn(`${issue.owner}/${issue.repo}`, issue.number).length,
      created_at: issue.createdAt,
      updated_at: issue.createdAt,
      closed_at: null,
      author_association: "OWNER",
      active_lock_reason: null,
      body: issue.body,
      state_reason: null,
      performed_via_github_app: null,
      ...(issue.pull
        ? {
            pull_request: {
              url: `${this.url}/repos/${issue.owner}/${issue.repo}/pulls/${issue.number}`,
              html_url: `${web}/pull/${issue.number}`,
              diff_url: `${web}/pull/${issue.number}.diff`,
              patch_url: `${web}/pull/${issue.number}.patch`,
              merged_at: null,
            },
          }
        : {}),
    };
  }

  private pullJson(issue: StoredIssue): Record<string, unknown> {
    if (!issue.pull) throw new Error(`${issue.owner}/${issue.repo}#${issue.number} is not a PR`);
    const url = `${this.url}/repos/${issue.owner}/${issue.repo}/pulls/${issue.number}`;
    const web = `${this.url}/${issue.owner}/${issue.repo}/pull/${issue.number}`;
    const branch = (ref: { ref: string; sha: string }) => ({
      label: `${issue.owner}:${ref.ref}`,
      ref: ref.ref,
      sha: ref.sha,
      user: this.user(issue.owner),
      repo: this.repositoryJson(issue.owner, issue.repo),
    });
    return {
      url,
      id: issue.id,
      node_id: nodeId("PR", issue.id),
      html_url: web,
      diff_url: `${web}.diff`,
      patch_url: `${web}.patch`,
      issue_url: `${this.url}/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`,
      number: issue.number,
      state: "open",
      locked: false,
      title: issue.title,
      user: issue.user,
      body: issue.body,
      created_at: issue.createdAt,
      updated_at: issue.createdAt,
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      assignees: [],
      requested_reviewers: [],
      labels: [],
      draft: false,
      head: branch(issue.pull.head),
      base: branch(issue.pull.base),
      author_association: "OWNER",
      merged: false,
      mergeable: true,
      comments: this.commentsOn(`${issue.owner}/${issue.repo}`, issue.number).length,
      review_comments: 0,
      commits: 1,
      additions: 3,
      deletions: 1,
      changed_files: 1,
    };
  }

  private commentJson(comment: StoredComment): Record<string, unknown> {
    const issue = this.issues.get(comment.issueKey)!;
    const repoUrl = `${this.url}/repos/${issue.owner}/${issue.repo}`;
    const htmlBase = this.issueJson(issue).html_url as string;
    return {
      url: `${repoUrl}/issues/comments/${comment.id}`,
      html_url: `${htmlBase}#issuecomment-${comment.id}`,
      issue_url: `${repoUrl}/issues/${issue.number}`,
      id: comment.id,
      node_id: nodeId("IC", comment.id),
      user: comment.user,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      author_association: comment.authorAssociation,
      body: comment.body,
      performed_via_github_app: comment.viaApp ? this.appJson() : null,
    };
  }

  private reactionJson(reaction: StoredReaction): Record<string, unknown> {
    return {
      id: reaction.id,
      node_id: nodeId("REA", reaction.id),
      user: reaction.user,
      content: reaction.content,
      created_at: reaction.createdAt,
    };
  }

  /** Verifies the App JWT that `@octokit/auth-app` signs with the configured private key. */
  private validAppJwt(authorization: string | null): boolean {
    const token = /^bearer (.+)$/iu.exec(authorization ?? "")?.[1];
    const [header, payload, signature] = token?.split(".") ?? [];
    if (!header || !payload || !signature) return false;
    const verified = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      this.keys.publicKey,
      Buffer.from(signature, "base64url"),
    );
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      iss?: unknown;
      exp?: number;
    };
    return (
      verified && String(claims.iss) === String(this.appId) && (claims.exp ?? 0) * 1000 > Date.now()
    );
  }

  private validInstallationToken(authorization: string | null): boolean {
    return /^(?:token|bearer) (.+)$/iu.exec(authorization ?? "")?.[1] === this.installationToken;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    const response = this.routeOrFail(request.method, url, request.headers, body);
    this.calls.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(request.headers),
      body,
      status: response.status,
      response: response.body ? ((await response.clone().json()) as unknown) : undefined,
    });
    for (const listener of this.listeners) listener();
    return response;
  }

  private routeOrFail(method: string, url: URL, headers: Headers, body: unknown): Response {
    try {
      return this.route(method, url.pathname, url.searchParams, headers, body);
    } catch (error) {
      this.unhandled.push(`failed ${method} ${url.pathname}: ${String(error)}`);
      return json({ message: "Server Error" }, 500);
    }
  }

  private route(
    method: string,
    pathname: string,
    query: URLSearchParams,
    headers: Headers,
    body: unknown,
  ): Response {
    const authorization = headers.get("authorization");
    if (pathname === "/app" || pathname.startsWith("/app/")) {
      if (!this.validAppJwt(authorization)) return this.unauthorized(method, pathname);
      if (method === "GET" && pathname === "/app") return json(this.appJson());
      if (
        method === "POST" &&
        pathname === `/app/installations/${this.installationId}/access_tokens`
      )
        return json(
          {
            token: this.installationToken,
            expires_at: new Date(Date.now() + 60 * 60 * 1000)
              .toISOString()
              .replace(/\.\d{3}Z$/u, "Z"),
            permissions: { issues: "write", pull_requests: "write", metadata: "read" },
            repository_selection: "all",
          },
          201,
        );
      return this.unrouted(method, pathname);
    }
    if (!this.validInstallationToken(authorization)) return this.unauthorized(method, pathname);
    const match = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/u.exec(pathname);
    if (!match) return this.unrouted(method, pathname);
    const repo = `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
    return this.routeRepo(method, repo, match[3]!, query, body);
  }

  private routeRepo(
    method: string,
    repo: string,
    rest: string,
    query: URLSearchParams,
    body: unknown,
  ): Response {
    const bot = this.user(this.botLogin);
    const issueAt = (number: string) => this.issues.get(`${repo}#${number}`);
    const routes: [string, RegExp, (parts: string[]) => Response][] = [
      [
        "POST",
        /^issues\/comments\/(\d+)\/reactions$/u,
        ([id]) => this.react(`comment:${id}`, this.comments.has(Number(id)), body, bot),
      ],
      [
        "POST",
        /^issues\/(\d+)\/reactions$/u,
        ([number]) => this.react(`${repo}#${number}`, Boolean(issueAt(number!)), body, bot),
      ],
      [
        "DELETE",
        /^issues\/comments\/(\d+)\/reactions\/(\d+)$/u,
        ([id, reaction]) => this.unreact(`comment:${id}`, Number(reaction)),
      ],
      [
        "DELETE",
        /^issues\/(\d+)\/reactions\/(\d+)$/u,
        ([number, reaction]) => this.unreact(`${repo}#${number}`, Number(reaction)),
      ],
      [
        "GET",
        /^issues\/(\d+)\/comments$/u,
        ([number]) => this.listComments(issueAt(number!), query),
      ],
      [
        "POST",
        /^issues\/(\d+)\/comments$/u,
        ([number]) => this.createComment(issueAt(number!), body, bot),
      ],
      ["GET", /^issues\/comments\/(\d+)$/u, ([id]) => this.commentById("GET", Number(id), body)],
      [
        "PATCH",
        /^issues\/comments\/(\d+)$/u,
        ([id]) => this.commentById("PATCH", Number(id), body),
      ],
      [
        "DELETE",
        /^issues\/comments\/(\d+)$/u,
        ([id]) => this.commentById("DELETE", Number(id), body),
      ],
      [
        "GET",
        /^issues\/(\d+)$/u,
        ([number]) => {
          const issue = issueAt(number!);
          return issue ? json(this.issueJson(issue)) : notFound();
        },
      ],
      [
        "GET",
        /^pulls\/(\d+)$/u,
        ([number]) => {
          const issue = issueAt(number!);
          return issue?.pull ? json(this.pullJson(issue)) : notFound();
        },
      ],
      [
        "GET",
        /^collaborators\/([^/]+)\/permission$/u,
        ([login]) => {
          const user = this.user(decodeURIComponent(login!));
          const permission = this.permissions.get(user.login) ?? "read";
          return json({ permission, role_name: permission, user });
        },
      ],
    ];
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const parts = pattern.exec(rest);
      if (parts) return handler(parts.slice(1));
    }
    return this.unrouted(method, `/repos/${repo}/${rest}`);
  }

  private listComments(issue: StoredIssue | undefined, query: URLSearchParams): Response {
    if (!issue) return notFound();
    const perPage = Math.min(Number(query.get("per_page") ?? 30), 100);
    const page = Math.max(Number(query.get("page") ?? 1), 1);
    return json(
      this.commentsOn(`${issue.owner}/${issue.repo}`, issue.number)
        .slice((page - 1) * perPage, page * perPage)
        .map((comment) => this.commentJson(comment)),
    );
  }

  private createComment(issue: StoredIssue | undefined, body: unknown, bot: GithubUser): Response {
    if (!issue) return notFound();
    const text = (body as { body?: unknown } | undefined)?.body;
    if (typeof text !== "string") return this.invalid("body");
    const stored = this.storeComment(issue, bot, text, { association: "NONE", viaApp: true });
    const created = this.commentJson(stored);
    return json(created, 201, { location: String(created.url) });
  }

  private commentById(method: string, id: number, body: unknown): Response {
    const comment = this.comments.get(id);
    if (!comment) return notFound();
    switch (method) {
      case "GET":
        return json(this.commentJson(comment));
      case "PATCH": {
        const text = (body as { body?: unknown } | undefined)?.body;
        if (typeof text !== "string") return this.invalid("body");
        comment.body = text;
        comment.updatedAt = timestamp();
        return json(this.commentJson(comment));
      }
      case "DELETE":
        this.comments.delete(id);
        return new Response(null, { status: 204 });
      default:
        return this.unrouted(method, `/issues/comments/${id}`);
    }
  }

  /** GitHub answers 200 with the existing reaction when the same user already reacted. */
  private react(subject: string, exists: boolean, body: unknown, user: GithubUser): Response {
    if (!exists) return notFound();
    const content = (body as { content?: unknown } | undefined)?.content;
    if (typeof content !== "string" || !REACTIONS.has(content)) return this.invalid("content");
    const existing = [...this.reactions.values()].find(
      (reaction) =>
        reaction.subject === subject &&
        reaction.user.id === user.id &&
        reaction.content === content,
    );
    if (existing) return json(this.reactionJson(existing));
    const reaction: StoredReaction = {
      id: this.id(),
      subject,
      user,
      content,
      createdAt: timestamp(),
    };
    this.reactions.set(reaction.id, reaction);
    return json(this.reactionJson(reaction), 201);
  }

  private unreact(subject: string, id: number): Response {
    if (this.reactions.get(id)?.subject !== subject) return notFound();
    this.reactions.delete(id);
    return new Response(null, { status: 204 });
  }

  private invalid(field: string): Response {
    return json(
      {
        message: "Validation Failed",
        errors: [{ resource: "Request", field, code: "invalid" }],
        documentation_url: "https://docs.github.com/rest",
        status: "422",
      },
      422,
    );
  }

  private unauthorized(method: string, pathname: string): Response {
    this.unhandled.push(`unauthorized ${method} ${pathname}`);
    return json(
      {
        message: "Bad credentials",
        documentation_url: "https://docs.github.com/rest",
        status: "401",
      },
      401,
    );
  }

  private unrouted(method: string, pathname: string): Response {
    this.unhandled.push(`unrouted ${method} ${pathname}`);
    return notFound();
  }
}
