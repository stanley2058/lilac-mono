import { deriveApiBaseUrl, type GithubAppSecret, readGithubAppSecret } from "./github-app";
import { getGithubInstallationTokenOrThrow } from "./github-app-token";
import { readGithubUserTokenSecret } from "./github-user-token";

export type GithubResolvedAuth = {
  source: "user" | "app";
  token: string;
  host?: string;
  apiBaseUrl: string;
  login?: string;
};

const VIEWER_LOGIN_TTL_MS = 5 * 60 * 1000;

const viewerLoginCache = new Map<string, { login: string; expiresAtMs: number }>();
const viewerLoginPending = new Map<string, Promise<string | null>>();

function tokenCacheKey(input: { apiBaseUrl: string; token: string }): string {
  return `${input.apiBaseUrl}|${input.token}`;
}

function parseLoginFromUserResponse(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const login = (raw as Record<string, unknown>)["login"];
  if (typeof login !== "string" || login.length === 0) return null;
  return login;
}

async function fetchViewerLoginFromGithub(input: {
  apiBaseUrl: string;
  token: string;
}): Promise<string | null> {
  const res = await fetch(`${input.apiBaseUrl.replace(/\/$/u, "")}/user`, {
    headers: {
      "User-Agent": "lilac",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `token ${input.token}`,
    },
  });

  if (!res.ok) return null;

  const body: unknown = await res.json().catch(() => null as unknown);
  return parseLoginFromUserResponse(body);
}

export async function getGithubViewerLoginOrNull(input: {
  apiBaseUrl: string;
  token: string;
}): Promise<string | null> {
  const key = tokenCacheKey(input);
  const now = Date.now();
  const cached = viewerLoginCache.get(key);
  if (cached && cached.expiresAtMs > now) {
    return cached.login;
  }

  const pending = viewerLoginPending.get(key);
  if (pending) {
    return await pending;
  }

  const request = (async () => {
    const login = await fetchViewerLoginFromGithub(input).catch(() => null);
    if (login) {
      viewerLoginCache.set(key, {
        login,
        expiresAtMs: now + VIEWER_LOGIN_TTL_MS,
      });
    }
    return login;
  })();

  viewerLoginPending.set(key, request);
  try {
    return await request;
  } finally {
    viewerLoginPending.delete(key);
  }
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
  const secret = await readGithubUserTokenSecret(params.dataDir);
  if (!secret) return null;

  return {
    source: "user",
    token: secret.token,
    host: secret.host,
    apiBaseUrl: resolveApiBaseUrlFromSecret({
      host: secret.host,
      apiBaseUrl: secret.apiBaseUrl,
    }),
    login: secret.login,
  };
}

export async function getGithubAppAuthOrNull(params: {
  dataDir: string;
}): Promise<GithubResolvedAuth | null> {
  const secret = await readGithubAppSecret(params.dataDir);
  if (!secret) return null;

  try {
    const token = await getGithubInstallationTokenOrThrow({ dataDir: params.dataDir });
    return toAppAuth(secret, token.token);
  } catch {
    return null;
  }
}

export async function getPreferredGithubAuthOrNull(params: {
  dataDir: string;
}): Promise<GithubResolvedAuth | null> {
  const user = await getGithubUserAuthOrNull(params);
  if (user) return user;
  return await getGithubAppAuthOrNull(params);
}

export async function getPreferredGithubAuthOrThrow(params: {
  dataDir: string;
}): Promise<GithubResolvedAuth> {
  const resolved = await getPreferredGithubAuthOrNull(params);
  if (resolved) return resolved;
  throw new Error(
    "GitHub auth not configured. Configure outbound user auth (onboarding.github_user_token mode=configure) or GitHub App auth (onboarding.github_app mode=configure).",
  );
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
  const user = await getGithubUserAuthOrNull({ dataDir: params.dataDir }).catch(() => null);
  const app = await getGithubAppAuthOrNull({ dataDir: params.dataDir }).catch(() => null);

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
