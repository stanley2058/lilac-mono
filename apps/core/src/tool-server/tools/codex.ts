import type { ServerTool } from "../types";
import { z } from "zod";
import { zodObjectToCliLines } from "./zod-cli";
import {
  buildAuthorizeUrl,
  CODEX_OAUTH_PORT,
  CODEX_OAUTH_REDIRECT_URI,
  exchangeCodeForTokens,
  extractAccountId,
  generatePKCE,
  generateState,
  getCodexAuthStoragePath,
  writeCodexTokens,
  clearCodexTokens,
} from "@stanley2058/lilac-utils";

const loginInputSchema = z
  .object({
    mode: z
      .enum(["start", "exchange"])
      .describe(
        "start: returns a URL to open in a browser; exchange: manually paste callback URL/code.",
      ),

    // Used for exchange mode.
    callbackUrl: z
      .string()
      .optional()
      .describe(
        "Callback URL from the browser (e.g. http://localhost:1455/auth/callback?code=...&state=...).",
      ),

    code: z
      .string()
      .optional()
      .describe("Authorization code (if you extracted it manually)."),

    state: z
      .string()
      .optional()
      .describe("State value (if you extracted it manually)."),

    // These are required if the user is doing a full manual exchange.
    pkceVerifier: z
      .string()
      .optional()
      .describe("PKCE code verifier (from the start step)."),
  })
  .superRefine((input, ctx) => {
    if (input.mode === "start") return;

    // exchange mode:
    const hasCallbackUrl = typeof input.callbackUrl === "string";
    const hasCode = typeof input.code === "string";

    if (!hasCallbackUrl && !hasCode) {
      ctx.addIssue({
        code: "custom",
        message: "exchange mode requires either callbackUrl or code.",
      });
    }

    if (!input.pkceVerifier) {
      ctx.addIssue({
        code: "custom",
        path: ["pkceVerifier"],
        message: "exchange mode requires pkceVerifier from the start step.",
      });
    }

    // state is recommended: used to protect against CSRF.
  });

const statusInputSchema = z.object({});
const logoutInputSchema = z.object({});

type PendingOAuth = {
  pkceVerifier: string;
  pkceChallenge: string;
  state: string;
  startedAt: number;
};

let pending: PendingOAuth | null = null;
let oauthServer: ReturnType<typeof Bun.serve> | null = null;

function parseCallbackPayload(input: {
  callbackUrl?: string;
  code?: string;
  state?: string;
}): {
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
        errorDescription:
          url.searchParams.get("error_description") ?? undefined,
      };
    } catch {
      // fall through
    }
  }

  return { code: input.code, state: input.state };
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>Lilac - Codex Authorization Successful</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#0f1216; color:#e8eef4; }
      .container { text-align:center; padding:2rem; }
      p { color:#a9b4bf; }
      .dim { color:#7f8b96; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this tab and return to Lilac.</p>
      <p class="dim">If the CLI didn\'t pick this up automatically, copy the URL from the address bar and run codex.login with mode=exchange.</p>
    </div>
    <script>setTimeout(() => window.close(), 2000)</script>
  </body>
</html>`;

const htmlError = (error: string) => `<!doctype html>
<html>
  <head>
    <title>Lilac - Codex Authorization Failed</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#0f1216; color:#e8eef4; }
      .container { text-align:center; padding:2rem; }
      .error { margin-top: 1rem; padding: 1rem; border-radius: 8px; background: #27161a; color: #ffd0d7; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`;

function startOAuthServer() {
  if (oauthServer) return;

  oauthServer = Bun.serve({
    port: CODEX_OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (state && pending && state !== pending.state) {
          return new Response(htmlError("Invalid state"), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (error) {
          return new Response(htmlError(errorDescription || error), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!code) {
          return new Response(htmlError("Missing authorization code"), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        // Prefer auto-exchange when we have pending PKCE material.
        // If this fails for any reason, the user can still complete the flow manually.
        if (pending && pending.pkceVerifier && pending.pkceChallenge) {
          const verifier = pending.pkceVerifier;
          const challenge = pending.pkceChallenge;
          const redirectUri = CODEX_OAUTH_REDIRECT_URI;
          exchangeCodeForTokens({
            code,
            redirectUri,
            pkce: { verifier, challenge },
          })
            .then(async (tokens) => {
              const accountId = extractAccountId({
                id_token: tokens.id_token,
                access_token: tokens.access_token,
              });

              const expires = Date.now() + (tokens.expires_in ?? 3600) * 1000;
              await writeCodexTokens({
                type: "oauth",
                access: tokens.access_token,
                refresh: tokens.refresh_token,
                expires,
                accountId,
                idToken: tokens.id_token,
              });

              pending = null;
              stopOAuthServer();
            })
            .catch(() => {
              // If anything goes wrong (network, token exchange), user can still
              // complete via manual paste.
            });
        }

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.pathname === "/cancel") {
        pending = null;
        return new Response("Login cancelled", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    },
  });
}

function stopOAuthServer() {
  oauthServer?.stop();
  oauthServer = null;
}

export class Codex implements ServerTool {
  id = "codex";

  async init(): Promise<void> {}
  async destroy(): Promise<void> {
    stopOAuthServer();
    pending = null;
  }

  async list() {
    return [
      {
        callableId: "codex.login",
        name: "Codex Login",
        description: [
          "Authenticate to OpenAI Codex via ChatGPT OAuth.",
          "Use mode=start to get a browser URL. If the localhost callback doesn't work, use mode=exchange and paste the callback URL.",
        ].join("\n"),
        shortInput: zodObjectToCliLines(loginInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(loginInputSchema),
      },
      {
        callableId: "codex.status",
        name: "Codex Status",
        description: "Show whether Codex OAuth tokens are configured.",
        shortInput: [],
        input: zodObjectToCliLines(statusInputSchema),
      },
      {
        callableId: "codex.logout",
        name: "Codex Logout",
        description: "Clear stored Codex OAuth tokens.",
        shortInput: [],
        input: zodObjectToCliLines(logoutInputSchema),
      },
    ];
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (callableId === "codex.login") {
      const payload = loginInputSchema.parse(input);

      if (payload.mode === "start") {
        const pkce = await generatePKCE();
        const state = generateState();

        pending = {
          pkceVerifier: pkce.verifier,
          pkceChallenge: pkce.challenge,
          state,
          startedAt: Date.now(),
        };

        // If you need to complete login manually later, keep these values.

        // Try to run the localhost callback server. If it fails to bind,
        // the flow still works via manual paste (`mode=exchange`).
        try {
          startOAuthServer();
        } catch {
          // ignore
        }

        const url = buildAuthorizeUrl({
          redirectUri: CODEX_OAUTH_REDIRECT_URI,
          pkce,
          state,
        });

        return {
          step: "start" as const,
          authorizeUrl: url,
          redirectUri: CODEX_OAUTH_REDIRECT_URI,
          port: CODEX_OAUTH_PORT,
          state,
          pkceVerifier: pkce.verifier,
          storagePath: getCodexAuthStoragePath(),
          instructions: [
            "1) Open authorizeUrl in your browser.",
            "2) Sign in and approve.",
            "3) If the browser reaches a localhost callback, you can ignore it and just run codex.login mode=exchange with callbackUrl.",
          ].join("\n"),
        };
      }

      // exchange
      const parsed = parseCallbackPayload(payload);
      if (parsed.error) {
        const msg = parsed.errorDescription || parsed.error;
        throw new Error(`OAuth error: ${msg}`);
      }

      const code = parsed.code;
      if (!code) {
        throw new Error("Missing authorization code");
      }

      const state = parsed.state;
      if (pending && state && state !== pending.state) {
        throw new Error(
          "Invalid state - potential CSRF or mismatched start step",
        );
      }

      const pkceVerifier = payload.pkceVerifier ?? pending?.pkceVerifier;
      if (!pkceVerifier) {
        throw new Error("Missing pkceVerifier");
      }

      const pkceChallenge = pending?.pkceChallenge;
      if (!pkceChallenge) {
        throw new Error(
          "Missing PKCE challenge. If you started the flow in a previous process, re-run codex.login mode=start (or let the browser callback do auto-exchange).",
        );
      }

      // Exchange code for tokens.
      const tokens = await exchangeCodeForTokens({
        code,
        redirectUri: CODEX_OAUTH_REDIRECT_URI,
        pkce: { verifier: pkceVerifier, challenge: pkceChallenge },
      });

      const accountId = extractAccountId({
        id_token: tokens.id_token,
        access_token: tokens.access_token,
      });

      const expires = Date.now() + (tokens.expires_in ?? 3600) * 1000;
      await writeCodexTokens({
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires,
        accountId,
        idToken: tokens.id_token,
      });

      pending = null;
      stopOAuthServer();

      return {
        step: "exchange" as const,
        ok: true as const,
        accountId,
        expires,
        storagePath: getCodexAuthStoragePath(),
      };
    }

    if (callableId === "codex.status") {
      statusInputSchema.parse(input);
      const file = Bun.file(getCodexAuthStoragePath());
      const exists = await file.exists();
      if (!exists) {
        return {
          configured: false as const,
          storagePath: getCodexAuthStoragePath(),
        };
      }

      const raw = await file.json().catch(() => null as unknown);
      if (!raw || typeof raw !== "object") {
        return {
          configured: false as const,
          storagePath: getCodexAuthStoragePath(),
          error: "invalid token file",
        };
      }

      const obj = raw as Record<string, unknown>;
      return {
        configured: obj.type === "oauth" && typeof obj.refresh === "string",
        storagePath: getCodexAuthStoragePath(),
        expires: typeof obj.expires === "number" ? obj.expires : undefined,
        accountId:
          typeof obj.accountId === "string" ? obj.accountId : undefined,
      };
    }

    if (callableId === "codex.logout") {
      logoutInputSchema.parse(input);
      await clearCodexTokens();
      pending = null;
      stopOAuthServer();
      return { ok: true as const, storagePath: getCodexAuthStoragePath() };
    }

    throw new Error("Invalid callable ID");
  }
}
