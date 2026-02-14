import { createAppAuth } from "@octokit/auth-app";

import { env } from "@stanley2058/lilac-utils";

import { deriveApiBaseUrl, readGithubAppPrivateKeyPem, readGithubAppSecret } from "./github-app";
import { getGithubInstallationTokenOrThrow } from "./github-app-token";

type GithubApiCtx = {
  apiBaseUrl: string;
  token: string;
};

function headers(token: string, extra?: Record<string, string>): HeadersInit {
  return {
    "User-Agent": "lilac",
    Accept: "application/vnd.github+json, application/vnd.github.squirrel-girl-preview+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `token ${token}`,
    ...extra,
  };
}

async function ctx(): Promise<GithubApiCtx> {
  const t = await getGithubInstallationTokenOrThrow({ dataDir: env.dataDir });
  return { apiBaseUrl: t.apiBaseUrl, token: t.token };
}

async function githubFetchJson<T>(input: {
  apiBaseUrl: string;
  token: string;
  path: string;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const url = `${input.apiBaseUrl.replace(/\/$/u, "")}${input.path}`;
  const res = await fetch(url, {
    method: input.method ?? "GET",
    headers: headers(input.token, input.body ? { "Content-Type": "application/json" } : undefined),
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GitHub API error (${res.status} ${res.statusText}) at ${input.path}${text ? `: ${text}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

async function githubFetchNoBody(input: {
  apiBaseUrl: string;
  token: string;
  path: string;
  method: string;
}): Promise<void> {
  const url = `${input.apiBaseUrl.replace(/\/$/u, "")}${input.path}`;
  const res = await fetch(url, {
    method: input.method,
    headers: headers(input.token),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GitHub API error (${res.status} ${res.statusText}) at ${input.path}${text ? `: ${text}` : ""}`,
    );
  }
}

export async function addEyesReactionToIssue(input: {
  owner: string;
  repo: string;
  issueNumber: number;
}): Promise<number> {
  const c = await ctx();
  const out = await githubFetchJson<{ id: number }>({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/reactions`,
    method: "POST",
    body: { content: "eyes" },
  });
  return out.id;
}

export async function addEyesReactionToIssueComment(input: {
  owner: string;
  repo: string;
  commentId: number;
}): Promise<number> {
  const c = await ctx();
  const out = await githubFetchJson<{ id: number }>({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}/reactions`,
    method: "POST",
    body: { content: "eyes" },
  });
  return out.id;
}

export async function deleteIssueReactionById(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  reactionId: number;
}): Promise<void> {
  const c = await ctx();
  await githubFetchNoBody({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/reactions/${input.reactionId}`,
    method: "DELETE",
  });
}

export async function deleteIssueCommentReactionById(input: {
  owner: string;
  repo: string;
  commentId: number;
  reactionId: number;
}): Promise<void> {
  const c = await ctx();
  await githubFetchNoBody({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}/reactions/${input.reactionId}`,
    method: "DELETE",
  });
}

export async function createIssueComment(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}): Promise<{ id: number; html_url?: string }> {
  const c = await ctx();
  return await githubFetchJson<{ id: number; html_url?: string }>({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`,
    method: "POST",
    body: { body: input.body },
  });
}

export async function getIssueComment(input: {
  owner: string;
  repo: string;
  commentId: number;
}): Promise<{
  id: number;
  user?: { login?: string; id?: number };
  body?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
}> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}`,
  });
}

export async function editIssueComment(input: {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
}): Promise<void> {
  const c = await ctx();
  await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}`,
    method: "PATCH",
    body: { body: input.body },
  });
}

export async function deleteIssueComment(input: {
  owner: string;
  repo: string;
  commentId: number;
}): Promise<void> {
  const c = await ctx();
  await githubFetchNoBody({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}`,
    method: "DELETE",
  });
}

export async function getIssue(input: { owner: string; repo: string; number: number }): Promise<{
  title: string;
  body: string | null;
  html_url?: string;
  pull_request?: unknown;
  user?: { login?: string; id?: number };
  created_at?: string;
  updated_at?: string;
}> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.number}`,
  });
}

export async function listIssueComments(input: {
  owner: string;
  repo: string;
  number: number;
  limit: number;
}): Promise<
  Array<{
    id: number;
    user?: { login?: string; id?: number };
    body?: string;
    created_at?: string;
    updated_at?: string;
    html_url?: string;
  }>
> {
  const c = await ctx();
  const perPage = Math.min(Math.max(input.limit, 1), 100);
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.number}/comments?per_page=${perPage}`,
  });
}

export type GithubReaction = {
  id: number;
  content: string;
  user?: { login?: string; id?: number };
};

export async function createIssueReaction(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
}): Promise<{ id: number }> {
  const c = await ctx();
  return await githubFetchJson<{ id: number }>({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/reactions`,
    method: "POST",
    body: { content: input.content },
  });
}

export async function createIssueCommentReaction(input: {
  owner: string;
  repo: string;
  commentId: number;
  content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
}): Promise<{ id: number }> {
  const c = await ctx();
  return await githubFetchJson<{ id: number }>({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}/reactions`,
    method: "POST",
    body: { content: input.content },
  });
}

export async function listIssueReactions(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  limit: number;
}): Promise<GithubReaction[]> {
  const c = await ctx();
  const perPage = Math.min(Math.max(input.limit, 1), 100);
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/reactions?per_page=${perPage}`,
  });
}

export async function listIssueCommentReactions(input: {
  owner: string;
  repo: string;
  commentId: number;
  limit: number;
}): Promise<GithubReaction[]> {
  const c = await ctx();
  const perPage = Math.min(Math.max(input.limit, 1), 100);
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/issues/comments/${input.commentId}/reactions?per_page=${perPage}`,
  });
}

export async function getPullRequest(input: {
  owner: string;
  repo: string;
  number: number;
}): Promise<{
  title: string;
  body: string | null;
  html_url?: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}> {
  const c = await ctx();
  return await githubFetchJson({
    ...c,
    path: `/repos/${input.owner}/${input.repo}/pulls/${input.number}`,
  });
}

export async function getGithubAppSlugOrNull(): Promise<string | null> {
  const secret = await readGithubAppSecret(env.dataDir);
  if (!secret) return null;

  const apiBaseUrl = deriveApiBaseUrl({ host: secret.host, apiBaseUrl: secret.apiBaseUrl });
  const privateKey = await readGithubAppPrivateKeyPem(secret);

  const auth = createAppAuth({
    appId: secret.appId,
    privateKey,
    baseUrl: apiBaseUrl,
  });

  const jwt = await auth({ type: "app" });
  if (!jwt || typeof jwt.token !== "string" || jwt.token.length === 0) {
    return null;
  }

  const res = await fetch(`${apiBaseUrl.replace(/\/$/u, "")}/app`, {
    headers: {
      "User-Agent": "lilac",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${jwt.token}`,
    },
  });
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => null as unknown);
  if (!body || typeof body !== "object") return null;
  const slug = (body as Record<string, unknown>)["slug"];
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}
