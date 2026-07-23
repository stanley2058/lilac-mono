import { chmod, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { env } from "./env";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_PORT = 1455;
export const CODEX_OAUTH_REDIRECT_URI = `http://localhost:${CODEX_OAUTH_PORT}/auth/callback`;

const codexOAuthTokensSchema = z
  .object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number(),
    accountId: z.string().min(1).optional(),
    idToken: z.string().min(1).optional(),
  })
  .strict();

const authorizationCodeTokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});

const refreshTokenResponseSchema = z.object({
  id_token: z.string().min(1).optional(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});

const jwtClaimsSchema = z.record(z.string(), z.unknown());

export type CodexOAuthTokens = z.infer<typeof codexOAuthTokensSchema>;
export type AuthorizationCodeTokenResponse = z.infer<typeof authorizationCodeTokenResponseSchema>;
export type RefreshTokenResponse = z.infer<typeof refreshTokenResponseSchema>;

const STORAGE_PATH = path.join(env.dataDir, "secret", "codex.json");

export const OAUTH_DUMMY_KEY = "lilac-codex-oauth-dummy-key";

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    return jwtClaimsSchema.safeParse(parsed).data;
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = claims["chatgpt_account_id"];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const parsed = jwtClaimsSchema.safeParse(auth);
    const nested = parsed.success ? parsed.data["chatgpt_account_id"] : undefined;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }

  const orgs = claims["organizations"];
  if (Array.isArray(orgs) && orgs.length > 0) {
    const parsed = jwtClaimsSchema.safeParse(orgs[0]);
    const id = parsed.success ? parsed.data.id : undefined;
    if (typeof id === "string" && id.length > 0) return id;
  }

  return undefined;
}

export function extractAccountId(tokens: {
  id_token?: string;
  access_token?: string;
}): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    if (claims) {
      const id = extractAccountIdFromClaims(claims);
      if (id) return id;
    }
  }

  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    if (claims) return extractAccountIdFromClaims(claims);
  }

  return undefined;
}

async function ensureSecretDir(storagePath: string): Promise<void> {
  const directory = path.dirname(storagePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function writeSecretFile(storagePath: string, contents: string): Promise<void> {
  const directory = path.dirname(storagePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(storagePath)}.${crypto.randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  let directoryHandle: FileHandle | undefined;
  let needsCleanup = false;
  try {
    await ensureSecretDir(storagePath);
    handle = await open(temporaryPath, "wx", 0o600);
    needsCleanup = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") directoryHandle = await open(directory, "r");
    await rename(temporaryPath, storagePath);
    needsCleanup = false;
    if (process.platform !== "win32") await chmod(storagePath, 0o600);
    await directoryHandle?.sync();
    await directoryHandle?.close();
    directoryHandle = undefined;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (directoryHandle) {
      try {
        await directoryHandle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (needsCleanup) {
      try {
        await unlink(temporaryPath);
      } catch (unlinkError) {
        cleanupErrors.push(unlinkError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Failed to write Codex OAuth tokens to '${storagePath}' and clean up resources`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write Codex OAuth tokens to '${storagePath}': ${message}`, {
      cause: error,
    });
  }
}

export async function readCodexTokens(
  storagePath: string = STORAGE_PATH,
): Promise<CodexOAuthTokens | null> {
  const file = Bun.file(storagePath);
  if (!(await file.exists())) return null;

  const raw = await file.json().catch(() => null as unknown);
  return codexOAuthTokensSchema.safeParse(raw).data ?? null;
}

export async function writeCodexTokens(
  tokens: CodexOAuthTokens,
  storagePath: string = STORAGE_PATH,
): Promise<void> {
  const validated = codexOAuthTokensSchema.parse(tokens);
  await writeSecretFile(storagePath, `${JSON.stringify(validated, null, 2)}\n`);
}

export async function clearCodexTokens(storagePath: string = STORAGE_PATH): Promise<void> {
  const file = Bun.file(storagePath);
  if (!(await file.exists())) return;
  await writeSecretFile(storagePath, "{}\n");
}

export type PkceCodes = {
  verifier: string;
  challenge: string;
};

export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(hash) };
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((byte) => chars[byte % chars.length]!)
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64url");
}

export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export function buildAuthorizeUrl(options: {
  redirectUri: string;
  pkce: PkceCodes;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: options.redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: options.pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: options.state,
    originator: "lilac",
  });

  return `${CODEX_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

export type CodexOAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function exchangeCodeForTokens(options: {
  code: string;
  redirectUri: string;
  pkce: PkceCodes;
  fetch?: CodexOAuthFetch;
  signal?: AbortSignal;
}): Promise<AuthorizationCodeTokenResponse> {
  const response = await (options.fetch ?? fetch)(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: options.pkce.verifier,
    }).toString(),
    signal: options.signal,
  });

  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
  return authorizationCodeTokenResponseSchema.parse(await response.json());
}

export async function refreshAccessToken(
  refreshToken: string,
  fetchFn: CodexOAuthFetch = fetch,
): Promise<RefreshTokenResponse> {
  const response = await fetchFn(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  return refreshTokenResponseSchema.parse(await response.json());
}

export type CodexOAuthCallbackPayload = {
  callbackUrl?: string;
  code?: string;
  state?: string;
  pkceVerifier?: string;
};

export function parseCodexOAuthCallback(input: CodexOAuthCallbackPayload): {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
} {
  if (input.callbackUrl) {
    try {
      const url = new URL(input.callbackUrl);
      return {
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription: url.searchParams.get("error_description") ?? undefined,
      };
    } catch {
      // Fall back to explicit fields for manual exchange.
    }
  }
  return { code: input.code, state: input.state };
}

export type CodexOAuthLoginResult = {
  ok: true;
  accountId?: string;
  expires: number;
  storagePath: string;
};

export type CodexOAuthLogin = {
  authorizeUrl: string;
  redirectUri: string;
  port: number;
  state: string;
  pkce: PkceCodes;
  storagePath: string;
  result: Promise<CodexOAuthLoginResult>;
  exchange(input: CodexOAuthCallbackPayload): Promise<CodexOAuthLoginResult>;
  close(): Promise<void>;
};

export type StartCodexOAuthLoginOptions = {
  port?: number;
  callbackServer?: "required" | "optional" | "disabled";
  fetch?: CodexOAuthFetch;
  writeTokens?: (tokens: CodexOAuthTokens) => Promise<void>;
  storagePath?: string;
  now?: () => number;
};

const HTML_SUCCESS = `<!doctype html><html><head><title>Lilac - Codex Authorization Successful</title></head><body><h1>Authorization Successful</h1><p>You can close this tab and return to Lilac.</p></body></html>`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlError(error: string): string {
  return `<!doctype html><html><head><title>Lilac - Codex Authorization Failed</title></head><body><h1>Authorization Failed</h1><p>${escapeHtml(error)}</p></body></html>`;
}

export async function startCodexOAuthLogin(
  options: StartCodexOAuthLoginOptions = {},
): Promise<CodexOAuthLogin> {
  const pkce = await generatePKCE();
  const state = generateState();
  const callbackServer = options.callbackServer ?? "required";
  const storagePath = options.storagePath ?? getCodexAuthStoragePath();
  const now = options.now ?? Date.now;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let redirectUri = `http://localhost:${options.port ?? CODEX_OAUTH_PORT}/auth/callback`;
  let settled = false;
  let closed = false;
  let activeExchange: Promise<CodexOAuthLoginResult> | null = null;
  let closePromise: Promise<void> | null = null;
  const exchangeController = new AbortController();
  let resolveResult: (result: CodexOAuthLoginResult) => void = () => {};
  let rejectResult: (error: unknown) => void = () => {};
  const result = new Promise<CodexOAuthLoginResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Core can use manual exchange without awaiting the automatic callback result.
  void result.catch(() => {});

  const stopServer = () => {
    server?.stop();
    server = undefined;
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    stopServer();
    rejectResult(error);
  };

  const runExchange = async (input: CodexOAuthCallbackPayload): Promise<CodexOAuthLoginResult> => {
    if (closed) throw new Error("Codex OAuth login closed");
    const parsed = parseCodexOAuthCallback(input);
    if (parsed.state !== state) {
      throw new Error("Invalid state - potential CSRF or mismatched start step");
    }
    if (parsed.error) throw new Error(`OAuth error: ${parsed.errorDescription || parsed.error}`);
    if (!parsed.code) throw new Error("Missing authorization code");

    const tokens = await exchangeCodeForTokens({
      code: parsed.code,
      redirectUri,
      pkce: { verifier: input.pkceVerifier ?? pkce.verifier, challenge: pkce.challenge },
      fetch: options.fetch,
      signal: exchangeController.signal,
    });
    if (closed) throw new Error("Codex OAuth login closed");
    const accountId = extractAccountId(tokens);
    const expires = now() + (tokens.expires_in ?? 3600) * 1000;
    if (closed) throw new Error("Codex OAuth login closed");
    await (options.writeTokens ?? ((tokens) => writeCodexTokens(tokens, storagePath)))({
      type: "oauth",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
      accountId,
      idToken: tokens.id_token,
    });
    if (closed) throw new Error("Codex OAuth login closed");
    const completed = { ok: true as const, accountId, expires, storagePath };
    if (!settled) {
      settled = true;
      stopServer();
      resolveResult(completed);
    }
    return completed;
  };

  const exchange = (input: CodexOAuthCallbackPayload): Promise<CodexOAuthLoginResult> => {
    if (closed) return Promise.reject(new Error("Codex OAuth login closed"));
    if (settled) return Promise.reject(new Error("Codex OAuth login already completed"));
    if (activeExchange) {
      return Promise.reject(new Error("Codex OAuth token exchange already in progress"));
    }

    const currentExchange = runExchange(input);
    activeExchange = currentExchange;
    const clearActiveExchange = () => {
      if (activeExchange === currentExchange) activeExchange = null;
    };
    void currentExchange.then(clearActiveExchange, clearActiveExchange);
    return currentExchange;
  };

  if (callbackServer !== "disabled") {
    try {
      server = Bun.serve({
        hostname: "localhost",
        port: options.port ?? CODEX_OAUTH_PORT,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 });

          const callbackState = url.searchParams.get("state");
          if (callbackState !== state) {
            const error = new Error("Invalid state - potential CSRF or mismatched start step");
            return new Response(htmlError(error.message), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }

          try {
            await exchange({ callbackUrl: request.url });
            return new Response(HTML_SUCCESS, { headers: { "Content-Type": "text/html" } });
          } catch (error) {
            if (!activeExchange) fail(error);
            const message = error instanceof Error ? error.message : String(error);
            return new Response(htmlError(message), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }
        },
      });
      redirectUri = `http://localhost:${server.port}/auth/callback`;
    } catch (error) {
      if (callbackServer === "required") throw error;
    }
  }

  const port = server?.port ?? options.port ?? CODEX_OAUTH_PORT;
  return {
    authorizeUrl: buildAuthorizeUrl({ redirectUri, pkce, state }),
    redirectUri,
    port,
    state,
    pkce,
    storagePath,
    result,
    exchange,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      exchangeController.abort();
      if (!settled) {
        settled = true;
        rejectResult(new Error("Codex OAuth login closed"));
      }
      stopServer();
      const exchangeToWaitFor = activeExchange;
      closePromise = (async () => {
        if (!exchangeToWaitFor) return;
        try {
          await exchangeToWaitFor;
        } catch {
          // Closing intentionally aborts or invalidates the active exchange.
        }
      })();
      return closePromise;
    },
  };
}

export function getCodexAuthStoragePath(): string {
  return STORAGE_PATH;
}
