import {
  clearCodexTokens,
  getCodexAuthStoragePath,
  readCodexTokens,
  startCodexOAuthLogin,
  type CodexOAuthLogin,
} from "@stanley2058/lilac-utils";
import { z } from "zod";

import type { ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";

const loginInputSchema = z
  .object({
    mode: z
      .enum(["start", "exchange"])
      .describe(
        "start: returns a URL to open in a browser; exchange: manually paste callback URL/code.",
      ),
    callbackUrl: z
      .string()
      .optional()
      .describe(
        "Callback URL from the browser (e.g. http://localhost:1455/auth/callback?code=...&state=...).",
      ),
    code: z.string().optional().describe("Authorization code (if you extracted it manually)."),
    state: z.string().optional().describe("State value (if you extracted it manually)."),
    pkceVerifier: z.string().optional().describe("PKCE code verifier (from the start step)."),
  })
  .superRefine((input, context) => {
    if (input.mode === "start") return;
    if (!input.callbackUrl && !input.code) {
      context.addIssue({
        code: "custom",
        message: "exchange mode requires either callbackUrl or code.",
      });
    }
    if (input.code && !input.callbackUrl && !input.state) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "exchange mode with a manual code requires state from the start step.",
      });
    }
    if (!input.pkceVerifier) {
      context.addIssue({
        code: "custom",
        path: ["pkceVerifier"],
        message: "exchange mode requires pkceVerifier from the start step.",
      });
    }
  });

const statusInputSchema = z.object({});
const logoutInputSchema = z.object({});

let pending: CodexOAuthLogin | null = null;
let pendingGeneration = 0;
let pendingTransition = Promise.resolve();

async function runPendingTransition<T>(operation: () => Promise<T>): Promise<T> {
  const previous = pendingTransition;
  let release = () => {};
  pendingTransition = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export type CodexDependencies = {
  startLogin: typeof startCodexOAuthLogin;
  readTokens: typeof readCodexTokens;
  clearTokens: typeof clearCodexTokens;
  storagePath: typeof getCodexAuthStoragePath;
};

const defaultDependencies: CodexDependencies = {
  startLogin: startCodexOAuthLogin,
  readTokens: readCodexTokens,
  clearTokens: clearCodexTokens,
  storagePath: getCodexAuthStoragePath,
};

export class Codex implements ServerTool {
  id = "codex";

  constructor(private readonly dependencies: CodexDependencies = defaultDependencies) {}

  async init(): Promise<void> {}

  async destroy(): Promise<void> {
    pendingGeneration += 1;
    await runPendingTransition(async () => {
      const login = pending;
      pending = null;
      await login?.close();
    });
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
        hidden: true,
      },
      {
        callableId: "codex.status",
        name: "Codex Status",
        description: "Show whether Codex OAuth tokens are configured.",
        shortInput: [],
        input: zodObjectToCliLines(statusInputSchema),
        hidden: true,
      },
      {
        callableId: "codex.logout",
        name: "Codex Logout",
        description: "Clear stored Codex OAuth tokens.",
        shortInput: [],
        input: zodObjectToCliLines(logoutInputSchema),
        hidden: true,
      },
    ];
  }

  async call(callableId: string, input: Record<string, unknown>): Promise<unknown> {
    if (callableId === "codex.login") {
      const payload = loginInputSchema.parse(input);
      if (payload.mode === "start") {
        const generation = ++pendingGeneration;
        return runPendingTransition(async () => {
          if (generation !== pendingGeneration) {
            throw new Error("Codex OAuth login was superseded");
          }
          const previous = pending;
          pending = null;
          await previous?.close();
          if (generation !== pendingGeneration) {
            throw new Error("Codex OAuth login was superseded");
          }

          const login = await this.dependencies.startLogin({ callbackServer: "optional" });
          if (generation !== pendingGeneration) {
            await login.close();
            throw new Error("Codex OAuth login was superseded");
          }
          pending = login;
          void login.result.then(
            () => {
              if (pending === login) pending = null;
            },
            () => {
              if (pending === login) pending = null;
            },
          );
          return {
            step: "start" as const,
            authorizeUrl: login.authorizeUrl,
            redirectUri: login.redirectUri,
            port: login.port,
            state: login.state,
            pkceVerifier: login.pkce.verifier,
            storagePath: login.storagePath,
            instructions: [
              "1) Open authorizeUrl in your browser.",
              "2) Sign in and approve.",
              "3) The localhost callback exchanges and stores tokens automatically. If it cannot connect, run codex.login mode=exchange with callbackUrl and pkceVerifier. A manually extracted code also requires state.",
            ].join("\n"),
          };
        });
      }

      if (!pending) {
        throw new Error(
          "Missing PKCE challenge. Re-run codex.login mode=start before manual exchange.",
        );
      }
      const login = pending;
      const result = await login.exchange(payload);
      if (pending === login) pending = null;
      return { step: "exchange" as const, ...result };
    }

    if (callableId === "codex.status") {
      statusInputSchema.parse(input);
      const tokens = await this.dependencies.readTokens();
      return {
        configured: tokens !== null,
        storagePath: this.dependencies.storagePath(),
        expires: tokens?.expires,
        accountId: tokens?.accountId,
      };
    }

    if (callableId === "codex.logout") {
      logoutInputSchema.parse(input);
      pendingGeneration += 1;
      return runPendingTransition(async () => {
        const login = pending;
        pending = null;
        await login?.close();
        await this.dependencies.clearTokens();
        return { ok: true as const, storagePath: this.dependencies.storagePath() };
      });
    }

    throw new Error("Invalid callable ID");
  }
}
