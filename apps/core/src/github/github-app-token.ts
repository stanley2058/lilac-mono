import { captureError } from "../shared/error-capture.js";
import { createAppAuth } from "@octokit/auth-app";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  deriveApiBaseUrl,
  readGithubAppPrivateKeyPemResult,
  readGithubAppSecretResult,
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
export class GithubAppTokenUnavailable extends TaggedError("GithubAppTokenUnavailable")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class GithubAppTokenMintFailed extends TaggedError("GithubAppTokenMintFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type GithubAppTokenError = GithubAppTokenUnavailable | GithubAppTokenMintFailed;

let pending: Promise<ResultType<InstallationToken, GithubAppTokenError>> | null = null;

async function captureGithubAppAuth<T>(
  run: () => Promise<T>,
): Promise<ResultType<T, GithubAppTokenMintFailed>> {
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
  return Result.err(
    new GithubAppTokenMintFailed({
      cause,
      message: "Failed to mint GitHub App installation token",
    }),
  );
}

const githubInstallationTokenSchema = z.object({ token: z.string(), expires_at: z.string() });

// `createAppAuth` has no `baseUrl` option and always mints installation tokens at api.github.com,
// so only the app JWT comes from it and the exchange targets the configured API base URL.
async function mintInstallationToken(input: {
  apiBaseUrl: string;
  appId: number;
  installationId: number;
  privateKey: string;
}): Promise<ResultType<{ token: string; expiresAt: string }, GithubAppTokenMintFailed>> {
  const path = `/app/installations/${input.installationId}/access_tokens`;
  const failed = (message: string) =>
    new GithubAppTokenMintFailed({ cause: new Error(message), message });
  const response = await captureGithubAppAuth(async () => {
    const jwt = await createAppAuth({ appId: input.appId, privateKey: input.privateKey })({
      type: "app",
    });
    return await fetch(`${input.apiBaseUrl.replace(/\/$/u, "")}${path}`, {
      method: "POST",
      headers: {
        "User-Agent": "lilac",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${jwt.token}`,
      },
    });
  });
  const continueResponse = response.match<
    () => Promise<ResultType<{ token: string; expiresAt: string }, GithubAppTokenMintFailed>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (res) => async () => {
      if (!res.ok) {
        return Result.err(failed(`GitHub API error (${res.status} ${res.statusText}) at ${path}`));
      }
      const body = await captureGithubAppAuth(async (): Promise<unknown> => await res.json());
      return body.andThen((value) => {
        const decoded = githubInstallationTokenSchema.safeParse(value);
        return decoded.success
          ? Result.ok({ token: decoded.data.token, expiresAt: decoded.data.expires_at })
          : Result.err(failed(`GitHub API returned an invalid installation token at ${path}`));
      });
    },
  });
  return await continueResponse();
}

function fingerprintSecret(secret: GithubAppSecret): string {
  return [
    secret.appId,
    secret.installationId,
    secret.host ?? "",
    secret.apiBaseUrl ?? "",
    secret.privateKeyPath,
  ].join("|");
}

function parseExpiresAtMs(
  expiresAt: string | undefined,
): ResultType<number, GithubAppTokenMintFailed> {
  if (!expiresAt) {
    return Result.err(
      new GithubAppTokenMintFailed({
        cause: new Error("GitHub App token missing expiresAt"),
        message: "GitHub App token missing expiresAt",
      }),
    );
  }
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) {
    return Result.err(
      new GithubAppTokenMintFailed({
        cause: new Error("GitHub App token has invalid expiresAt"),
        message: `GitHub App token has invalid expiresAt: ${expiresAt}`,
      }),
    );
  }
  return Result.ok(ms);
}

export async function getGithubInstallationTokenResult(params: {
  dataDir: string;
}): Promise<ResultType<Omit<InstallationToken, "fingerprint">, GithubAppTokenError>> {
  const secretResult = await readGithubAppSecretResult(params.dataDir);
  return secretResult.match<
    () => Promise<ResultType<Omit<InstallationToken, "fingerprint">, GithubAppTokenError>>
  >({
    err: (error) => async () =>
      Result.err(
        new GithubAppTokenUnavailable({
          cause: error,
          message: error.message,
        }),
      ),
    ok: (secret) => async () => {
      if (!secret) {
        return Result.err(
          new GithubAppTokenUnavailable({
            message: "GitHub App not configured (run onboarding.github_app mode=configure)",
          }),
        );
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
        return Result.ok({
          token: cached.token,
          expiresAtMs: cached.expiresAtMs,
          host: cached.host,
          apiBaseUrl: cached.apiBaseUrl,
        });
      }

      if (pending) {
        const resolved = await pending;
        return resolved.map(({ token, expiresAtMs, host, apiBaseUrl }) => ({
          token,
          expiresAtMs,
          host,
          apiBaseUrl,
        }));
      }

      pending = (async () => {
        const privateKeyResult = await readGithubAppPrivateKeyPemResult(secret);
        const continuePrivateKey = privateKeyResult.match<
          () => Promise<ResultType<InstallationToken, GithubAppTokenError>>
        >({
          err: (error) => async () =>
            Result.err(new GithubAppTokenMintFailed({ cause: error, message: error.message })),
          ok: (privateKey) => async () => {
            const response = await mintInstallationToken({
              apiBaseUrl,
              appId: secret.appId,
              installationId: secret.installationId,
              privateKey,
            });
            const continueResponse = response.match<
              () => ResultType<InstallationToken, GithubAppTokenError>
            >({
              err: (error) => () => Result.err(error),
              ok: (res) => () => {
                const token = res.token;
                if (typeof token !== "string" || token.length === 0) {
                  return Result.err(
                    new GithubAppTokenMintFailed({
                      cause: new Error("GitHub App installation token missing"),
                      message: "Failed to mint GitHub App installation token",
                    }),
                  );
                }
                const expiresAt = parseExpiresAtMs(res.expiresAt);
                const continueExpiresAt = expiresAt.match<
                  () => ResultType<InstallationToken, GithubAppTokenError>
                >({
                  err: (error) => () => Result.err(error),
                  ok: (expiresAtMs) => () => {
                    const value: InstallationToken = {
                      token,
                      expiresAtMs,
                      host: secret.host,
                      apiBaseUrl,
                      fingerprint: fp,
                    };
                    cached = value;
                    return Result.ok(value);
                  },
                });
                return continueExpiresAt();
              },
            });
            return continueResponse();
          },
        });
        return await continuePrivateKey();
      })();

      const pendingToken = pending;
      const resolved = await pendingToken.finally(() => {
        pending = null;
      });
      return resolved.map(({ token, expiresAtMs, host, apiBaseUrl }) => ({
        token,
        expiresAtMs,
        host,
        apiBaseUrl,
      }));
    },
  })();
}

export async function getGithubInstallationTokenOrThrow(params: { dataDir: string }): Promise<{
  token: string;
  expiresAtMs: number;
  host?: string;
  apiBaseUrl: string;
}> {
  const token = await getGithubInstallationTokenResult(params);
  return token.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}
