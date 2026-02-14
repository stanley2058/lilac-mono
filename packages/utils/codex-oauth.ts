import path from "node:path";
import { env } from "./env";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_PORT = 1455;
export const CODEX_OAUTH_REDIRECT_URI = `http://localhost:${CODEX_OAUTH_PORT}/auth/callback`;

export type CodexOAuthTokens = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number; // epoch ms
  accountId?: string;
  idToken?: string;
};

const STORAGE_PATH = path.join(env.dataDir, "secret", "codex.json");

export const OAUTH_DUMMY_KEY = "lilac-codex-oauth-dummy-key";

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = claims["chatgpt_account_id"];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const authObj = auth as Record<string, unknown>;
    const nested = authObj["chatgpt_account_id"];
    if (typeof nested === "string" && nested.length > 0) return nested;
  }

  const orgs = claims["organizations"];
  if (Array.isArray(orgs) && orgs.length > 0) {
    const first = orgs[0];
    if (first && typeof first === "object") {
      const firstObj = first as Record<string, unknown>;
      const id = firstObj["id"];
      if (typeof id === "string" && id.length > 0) return id;
    }
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

async function ensureSecretDir(): Promise<void> {
  const dir = path.dirname(STORAGE_PATH);
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
}

export async function readCodexTokens(): Promise<CodexOAuthTokens | null> {
  const file = Bun.file(STORAGE_PATH);
  if (!(await file.exists())) return null;

  const raw = await file.json().catch(() => null as unknown);
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  if (obj.type !== "oauth") return null;
  if (typeof obj.access !== "string") return null;
  if (typeof obj.refresh !== "string") return null;
  if (typeof obj.expires !== "number") return null;

  return {
    type: "oauth",
    access: obj.access,
    refresh: obj.refresh,
    expires: obj.expires,
    accountId: typeof obj.accountId === "string" ? obj.accountId : undefined,
    idToken: typeof obj.idToken === "string" ? obj.idToken : undefined,
  };
}

export async function writeCodexTokens(tokens: CodexOAuthTokens): Promise<void> {
  await ensureSecretDir();
  const json = JSON.stringify(tokens, null, 2);
  await Bun.write(STORAGE_PATH, json);
  try {
    // Best-effort chmod; if it fails (e.g. on Windows), ignore.
    const fs = await import("fs/promises");
    await fs.chmod(STORAGE_PATH, 0o600);
  } catch {}
}

export async function clearCodexTokens(): Promise<void> {
  const file = Bun.file(STORAGE_PATH);
  if (!(await file.exists())) return;
  await ensureSecretDir();
  await Bun.write(STORAGE_PATH, JSON.stringify({}, null, 2));
}

export type PkceCodes = {
  verifier: string;
  challenge: string;
};

export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => chars[b % chars.length]!)
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

export type TokenResponse = {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

export async function exchangeCodeForTokens(options: {
  code: string;
  redirectUri: string;
  pkce: PkceCodes;
}): Promise<TokenResponse> {
  const response = await fetch(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: options.pkce.verifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return (await response.json()) as TokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  return (await response.json()) as TokenResponse;
}

export function getCodexAuthStoragePath(): string {
  return STORAGE_PATH;
}
