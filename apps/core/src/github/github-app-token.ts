import { createAppAuth } from "@octokit/auth-app";

import {
  deriveApiBaseUrl,
  readGithubAppPrivateKeyPem,
  readGithubAppSecret,
  type GithubAppSecret,
} from "./github-app";

type InstallationToken = {
  token: string;
  expiresAtMs: number;
  host?: string;
  apiBaseUrl: string;
  fingerprint: string;
};

let cached: InstallationToken | null = null;
let pending: Promise<InstallationToken> | null = null;

function fingerprintSecret(secret: GithubAppSecret): string {
  return [
    secret.appId,
    secret.installationId,
    secret.host ?? "",
    secret.apiBaseUrl ?? "",
    secret.privateKeyPath,
  ].join("|");
}

function parseExpiresAtMs(expiresAt: unknown): number {
  if (typeof expiresAt !== "string" || expiresAt.length === 0) {
    throw new Error("GitHub App token missing expiresAt");
  }
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) {
    throw new Error(`GitHub App token has invalid expiresAt: ${expiresAt}`);
  }
  return ms;
}

export async function getGithubInstallationTokenOrThrow(params: { dataDir: string }): Promise<{
  token: string;
  expiresAtMs: number;
  host?: string;
  apiBaseUrl: string;
}> {
  const secret = await readGithubAppSecret(params.dataDir);
  if (!secret) {
    throw new Error("GitHub App not configured (run onboarding.github_app mode=configure)");
  }

  const apiBaseUrl = deriveApiBaseUrl({
    host: secret.host,
    apiBaseUrl: secret.apiBaseUrl,
  });
  const fp = fingerprintSecret(secret);

  const now = Date.now();
  if (
    cached &&
    cached.fingerprint === fp &&
    cached.apiBaseUrl === apiBaseUrl &&
    cached.expiresAtMs - now > 60_000
  ) {
    return {
      token: cached.token,
      expiresAtMs: cached.expiresAtMs,
      host: cached.host,
      apiBaseUrl: cached.apiBaseUrl,
    };
  }

  if (pending) {
    const t = await pending;
    return {
      token: t.token,
      expiresAtMs: t.expiresAtMs,
      host: t.host,
      apiBaseUrl: t.apiBaseUrl,
    };
  }

  pending = (async () => {
    const privateKey = await readGithubAppPrivateKeyPem(secret);
    const auth = createAppAuth({
      appId: secret.appId,
      privateKey,
      installationId: secret.installationId,
      baseUrl: apiBaseUrl,
    });

    const res = await auth({ type: "installation" });
    const token = res.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("Failed to mint GitHub App installation token");
    }

    const t: InstallationToken = {
      token,
      expiresAtMs: parseExpiresAtMs(res.expiresAt),
      host: secret.host,
      apiBaseUrl,
      fingerprint: fp,
    };
    cached = t;
    return t;
  })();

  try {
    const t = await pending;
    return {
      token: t.token,
      expiresAtMs: t.expiresAtMs,
      host: t.host,
      apiBaseUrl: t.apiBaseUrl,
    };
  } finally {
    pending = null;
  }
}

export async function getGithubEnvForBash(params: { dataDir: string }): Promise<
  | {
      GH_TOKEN: string;
      GITHUB_TOKEN: string;
      GH_HOST?: string;
    }
  | {}
> {
  try {
    const t = await getGithubInstallationTokenOrThrow({ dataDir: params.dataDir });
    return {
      GH_TOKEN: t.token,
      GITHUB_TOKEN: t.token,
      ...(t.host ? { GH_HOST: t.host } : {}),
    };
  } catch {
    // If not configured or misconfigured, do not block bash.
    return {};
  }
}
