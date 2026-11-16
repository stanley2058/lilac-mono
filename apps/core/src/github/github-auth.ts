import { captureError } from "../shared/error-capture.js";
import { z } from "zod";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { deriveApiBaseUrl, type GithubAppSecret, readGithubAppSecretResult } from "./github-app";
import { getGithubInstallationTokenResult } from "./github-app-token";
import { readGithubUserTokenSecretResult } from "./github-user-token";

export type GithubResolvedAuth = {
  source: "user" | "app";
  token: string;
  host?: string;
  apiBaseUrl: string;
  login?: string;
};

const VIEWER_LOGIN_TTL_MS = 5 * 60 * 1000;

const viewerLoginCache = new Map<string, { login: string; expiresAtMs: number }>();
const viewerLoginPending = new Map<string, Promise<ResultType<string, GithubAuthFailed>>>();
const githubViewerSchema = z.object({ login: z.string().min(1) });

export class GithubAuthFailed extends TaggedError("GithubAuthFailed")<{
  readonly operation: "read-user" | "read-app" | "mint-app-token" | "viewer" | "resolve";
  readonly cause?: unknown;
  readonly message: string;
}> {}

async function captureGithubAuthExternal<T>(
  operation: GithubAuthFailed["operation"],
  message: string,
  run: () => Promise<T>,
): Promise<ResultType<T, GithubAuthFailed>> {
  const captured = (
    await Result.tryPromise({
      try: run,
      catch: captureError,
    })
  ).match<
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "failure"; readonly failure: Error }
  >({
    ok: (value) => ({ kind: "success", value }),
    err: ({ cause }) => ({ kind: "failure", failure: cause }),
  });
  if (captured.kind === "success") return Result.ok(captured.value);
  const cause = captured.failure;
  if (Panic.is(cause)) throw cause;
  return Result.err(new GithubAuthFailed({ operation, cause, message }));
}

function tokenCacheKey(input: { apiBaseUrl: string; token: string }): string {
  return `${input.apiBaseUrl}|${input.token}`;
}

async function fetchViewerLoginFromGithub(input: {
  apiBaseUrl: string;
  token: string;
}): Promise<ResultType<string, GithubAuthFailed>> {
  const path = "/user";
  const response = await captureGithubAuthExternal(
    "viewer",
    "GitHub authenticated user request failed",
    () =>
      fetch(`${input.apiBaseUrl.replace(/\/$/u, "")}/user`, {
        headers: {
          "User-Agent": "lilac",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `token ${input.token}`,
        },
      }),
  );
  if (response.isErr()) return Result.err(response.error);
  const res = response.value;
  if (!res.ok) {
    const body = await captureGithubAuthExternal(
      "viewer",
      "GitHub authenticated user error response was unreadable",
      () => res.text(),
    );
    const continueErrorBody = body.match<() => ResultType<string, GithubAuthFailed>>({
      err: (error) => () =>
        Result.err(
          new GithubAuthFailed({
            operation: "viewer",
            cause: error,
            message: `GitHub API error (${res.status} ${res.statusText}) at ${path}`,
          }),
        ),
      ok: (value) => () =>
        Result.err(
          new GithubAuthFailed({
            operation: "viewer",
            message: `GitHub API error (${res.status} ${res.statusText}) at ${path}${value ? `: ${value}` : ""}`,
          }),
        ),
    });
    return continueErrorBody();
  }

  const body = await captureGithubAuthExternal(
    "viewer",
    "GitHub authenticated user response was unreadable",
    async (): Promise<unknown> => await res.json(),
  );
  if (body.isErr()) return Result.err(body.error);
  const value = body.value;
  const parsed = githubViewerSchema.safeParse(value);
  if (!parsed.success) {
    return Result.err(
      new GithubAuthFailed({
        operation: "viewer",
        cause: parsed.error,
        message: "GitHub API returned an invalid authenticated user response at /user",
      }),
    );
  }
  return Result.ok(parsed.data.login);
}

export async function getGithubViewerLoginResult(input: {
  apiBaseUrl: string;
  token: string;
}): Promise<ResultType<string, GithubAuthFailed>> {
  const key = tokenCacheKey(input);
  const now = Date.now();
  const cached = viewerLoginCache.get(key);
  if (cached && cached.expiresAtMs > now) return Result.ok(cached.login);

  const pending = viewerLoginPending.get(key);
  if (pending) return await pending;

  const request = (async () => {
    const login = await fetchViewerLoginFromGithub(input);
    return login.map((value) => {
      viewerLoginCache.set(key, {
        login: value,
        expiresAtMs: Date.now() + VIEWER_LOGIN_TTL_MS,
      });
      return value;
    });
  })();
  viewerLoginPending.set(key, request);
  return await request.finally(() => {
    viewerLoginPending.delete(key);
  });
}

export async function getGithubViewerLoginOrThrow(input: {
  apiBaseUrl: string;
  token: string;
}): Promise<string> {
  const resolved = await getGithubViewerLoginResult(input);
  return resolved.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}

export async function getGithubViewerLoginOrNull(input: {
  apiBaseUrl: string;
  token: string;
}): Promise<string | null> {
  const resolved = await getGithubViewerLoginResult(input);
  return resolved.match({ ok: (value) => value, err: () => null });
}

function resolveApiBaseUrlFromSecret(input: { host?: string; apiBaseUrl?: string }): string {
  return deriveApiBaseUrl({
    host: input.host,
    apiBaseUrl: input.apiBaseUrl,
  });
}

function toAppAuth(secret: GithubAppSecret, token: string): GithubResolvedAuth {
  return {
    source: "app",
    token,
    host: secret.host,
    apiBaseUrl: resolveApiBaseUrlFromSecret({
      host: secret.host,
      apiBaseUrl: secret.apiBaseUrl,
    }),
  };
}

export async function getGithubUserAuthOrNull(params: {
  dataDir: string;
}): Promise<GithubResolvedAuth | null> {
  const resolved = await getGithubUserAuthResult(params);
  return resolved.match({ ok: (value) => value, err: () => null });
}

export async function getGithubUserAuthResult(params: {
  dataDir: string;
}): Promise<ResultType<GithubResolvedAuth | null, GithubAuthFailed>> {
  const loaded = await readGithubUserTokenSecretResult(params.dataDir);
  return loaded
    .mapError(
      (error) =>
        new GithubAuthFailed({
          operation: "read-user",
          cause: error,
          message: error.message,
        }),
    )
    .map((secret) =>
      secret
        ? {
            source: "user" as const,
            token: secret.token,
            host: secret.host,
            apiBaseUrl: resolveApiBaseUrlFromSecret({
              host: secret.host,
              apiBaseUrl: secret.apiBaseUrl,
            }),
            login: secret.login,
          }
        : null,
    );
}

export async function getGithubAppAuthOrNull(params: {
  dataDir: string;
}): Promise<GithubResolvedAuth | null> {
  const resolved = await getGithubAppAuthResult(params);
  return resolved.match({ ok: (value) => value, err: () => null });
}

export async function getGithubAppAuthResult(params: {
  dataDir: string;
}): Promise<ResultType<GithubResolvedAuth | null, GithubAuthFailed>> {
  const loaded = await readGithubAppSecretResult(params.dataDir);
  if (loaded.isErr()) {
    return Result.err(
      new GithubAuthFailed({
        operation: "read-app",
        cause: loaded.error,
        message: loaded.error.message,
      }),
    );
  }
  const secret = loaded.value;
  if (!secret) return Result.ok(null);
  const token = await getGithubInstallationTokenResult({ dataDir: params.dataDir });
  if (token.isErr()) {
    return Result.err(
      new GithubAuthFailed({
        operation: "mint-app-token",
        cause: token.error,
        message: token.error.message,
      }),
    );
  }
  return Result.ok(toAppAuth(secret, token.value.token));
}

export async function getPreferredGithubAuthResult(params: {
  dataDir: string;
}): Promise<ResultType<GithubResolvedAuth | null, GithubAuthFailed>> {
  const user = await getGithubUserAuthResult(params);
  if (user.isErr()) return Result.err(user.error);
  const value = user.value;
  return value ? Result.ok(value) : await getGithubAppAuthResult(params);
}

export async function getPreferredGithubAuthOrNull(params: {
  dataDir: string;
}): Promise<GithubResolvedAuth | null> {
  const resolved = await getPreferredGithubAuthResult(params);
  return resolved.match({ ok: (value) => value, err: () => null });
}

export async function getPreferredGithubAuthOrThrow(params: {
  dataDir: string;
}): Promise<GithubResolvedAuth> {
  const resolved = await getPreferredGithubAuthResult(params);
  return resolved.match({
    err: (error) => () => {
      throw error;
    },
    ok: (value) => () => {
      if (value) return value;
      throw new GithubAuthFailed({
        operation: "resolve",
        message:
          "GitHub auth not configured. Configure outbound user auth (onboarding.github_user_token mode=configure) or GitHub App auth (onboarding.github_app mode=configure).",
      });
    },
  })();
}

export async function getGithubUserLoginOrNull(params: {
  dataDir: string;
}): Promise<string | null> {
  const user = await getGithubUserAuthOrNull(params);
  if (!user) return null;

  if (user.login && user.login.length > 0) {
    return user.login;
  }

  return await getGithubViewerLoginOrNull({
    apiBaseUrl: user.apiBaseUrl,
    token: user.token,
  });
}

export async function getGithubEnvForBash(params: {
  dataDir: string;
}): Promise<Record<string, string>> {
  const userResult = await getGithubUserAuthResult({ dataDir: params.dataDir });
  const appResult = await getGithubAppAuthResult({ dataDir: params.dataDir });
  const user = userResult.match({ ok: (value) => value, err: () => null });
  const app = appResult.match({ ok: (value) => value, err: () => null });

  const preferred = user ?? app;
  if (!preferred) return {};

  const out: Record<string, string> = {
    GH_TOKEN: preferred.token,
    GITHUB_TOKEN: preferred.token,
  };

  if (preferred.host) {
    out.GH_HOST = preferred.host;
  }

  if (user) {
    out.LILAC_GITHUB_USER_TOKEN = user.token;
    if (user.host) {
      out.LILAC_GITHUB_USER_HOST = user.host;
    }
  }

  if (app) {
    out.LILAC_GITHUB_APP_TOKEN = app.token;
    if (app.host) {
      out.LILAC_GITHUB_APP_HOST = app.host;
    }
  }

  return out;
}
