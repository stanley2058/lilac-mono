import { captureError } from "../shared/error-capture.js";
import { Result } from "better-result";
import { errorMessage } from "@stanley2058/lilac-utils";

import { MCP_OAUTH_CALLBACK_URL, type McpOAuthProviderService } from "./oauth-provider";

export type McpOAuthCallbackListenerStatus =
  | {
      readonly status: "listening";
      readonly hostname: string;
      readonly port: number;
    }
  | {
      readonly status: "unavailable";
      readonly hostname: string;
      readonly port: number;
      readonly error: string;
    };

export type McpOAuthCallbackControl = {
  start(): McpOAuthCallbackListenerStatus;
  getStatus(): McpOAuthCallbackListenerStatus;
};

export type McpOAuthCallbackServerFactory = (options: {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (request: Request) => Response | Promise<Response>;
}) => {
  readonly port?: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
};

export class McpOAuthCallbackService {
  private readonly providers: McpOAuthProviderService;
  private readonly callbackPath: string;
  private readonly listener: boolean;
  private readonly onAuthorized?: (serverId: string) => void;
  private readonly hostname: string;
  private readonly port: number;
  private readonly serverFactory: McpOAuthCallbackServerFactory;
  private server?: ReturnType<McpOAuthCallbackServerFactory>;
  private listenerStatus: McpOAuthCallbackListenerStatus;

  constructor(options: {
    readonly providers: McpOAuthProviderService;
    readonly callbackUrl?: string;
    /** False when another server, such as the native gateway, routes callbacks to handleRequest. */
    readonly listener?: boolean;
    /** Runs after a callback stores new tokens. */
    readonly onAuthorized?: (serverId: string) => void;
    readonly hostname?: string;
    readonly port?: number;
    readonly serverFactory?: McpOAuthCallbackServerFactory;
  }) {
    const callbackUrl = new URL(options.callbackUrl ?? MCP_OAUTH_CALLBACK_URL);
    this.providers = options.providers;
    this.callbackPath = callbackUrl.pathname;
    this.listener = options.listener ?? true;
    this.onAuthorized = options.onAuthorized;
    this.hostname = options.hostname ?? callbackUrl.hostname;
    this.port = options.port ?? urlPort(callbackUrl);
    this.serverFactory = options.serverFactory ?? ((serveOptions) => Bun.serve(serveOptions));
    this.listenerStatus = {
      status: "unavailable",
      hostname: this.hostname,
      port: this.port,
      error: "OAuth callback listener has not started",
    };
  }

  start(): McpOAuthCallbackListenerStatus {
    if (this.server) return this.listenerStatus;
    if (!this.listener) {
      this.listenerStatus = { status: "listening", hostname: this.hostname, port: this.port };
      return this.listenerStatus;
    }

    {
      const captured = Result.try({
        try: () => {
          this.server = this.serverFactory({
            hostname: this.hostname,
            port: this.port,
            fetch: (request) => this.handleRequest(request),
          });
          this.listenerStatus = {
            status: "listening",
            hostname: this.hostname,
            port: this.server.port ?? this.port,
          };
        },
        catch: captureError,
      });

      if (captured.isErr()) {
        const error = captured.error.cause;
        this.server = undefined;
        this.listenerStatus = {
          status: "unavailable",
          hostname: this.hostname,
          port: this.port,
          error: errorMessage(error),
        };
      }
    }

    return this.listenerStatus;
  }

  getStatus(): McpOAuthCallbackListenerStatus {
    return this.listenerStatus;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await Promise.resolve()
      .then(() => server?.stop(true))
      .finally(() => {
        this.listenerStatus = {
          status: "unavailable",
          hostname: this.hostname,
          port: this.port,
          error: "OAuth callback listener is stopped",
        };
      });
  }

  async handleRequest(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed.\n", {
        status: 405,
        headers: { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const url = new URL(request.url);
    if (url.pathname !== this.callbackPath) return new Response("Not found.\n", { status: 404 });

    const codes = url.searchParams.getAll("code");
    const states = url.searchParams.getAll("state");
    const issuers = url.searchParams.getAll("iss");
    if (
      url.searchParams.has("error") ||
      codes.length !== 1 ||
      states.length !== 1 ||
      issuers.length > 1 ||
      !codes[0] ||
      !states[0]
    ) {
      return mcpOAuthCallbackResponse(request, { outcome: "invalid" });
    }

    const provider = this.providers.getProviderForState(states[0]);
    if (!provider) return mcpOAuthCallbackResponse(request, { outcome: "invalid" });

    const completed = await provider.completeAuthorizationResult(codes[0], states[0], issuers[0]);
    const serverId = provider.serverId;
    return completed.match({
      ok: () => {
        this.onAuthorized?.(serverId);
        return mcpOAuthCallbackResponse(request, { outcome: "completed", serverId });
      },
      err: () => mcpOAuthCallbackResponse(request, { outcome: "failed", serverId }),
    });
  }
}

export type McpOAuthCallbackOutcome =
  | { readonly outcome: "completed"; readonly serverId: string }
  | { readonly outcome: "failed"; readonly serverId: string }
  | { readonly outcome: "invalid" };

/**
 * The page a browser lands on after the OAuth provider redirects back. Other clients, such as
 * `curl` in the copy-and-paste fallback, keep the one-line text reply.
 */
export function mcpOAuthCallbackResponse(
  request: Request,
  result: McpOAuthCallbackOutcome,
): Response {
  const status = result.outcome === "completed" ? 200 : 400;
  const copy = callbackCopy(result);
  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("text/html"))
    return new Response(copy.text, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  return new Response(callbackPage(result, copy), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
      // The URL carries the authorization code.
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

type CallbackCopy = { text: string; title: string; heading: string; body: string };

function callbackCopy(result: McpOAuthCallbackOutcome): CallbackCopy {
  switch (result.outcome) {
    case "completed":
      return {
        text: "OAuth authorization completed.\n",
        title: "Signed in",
        heading: `Signed in to ${escapeHtml(result.serverId)}`,
        body: "Lilac is connecting to the server. You can close this tab.",
      };
    case "failed":
      return {
        text: "OAuth authorization failed.\n",
        title: "Sign-in failed",
        heading: `Could not sign in to ${escapeHtml(result.serverId)}`,
        body: "The server rejected the sign-in. Close this tab and start sign-in again in Lilac.",
      };
    case "invalid":
      return {
        text: "Invalid OAuth callback.\n",
        title: "Sign-in link expired",
        heading: "This sign-in link is no longer valid",
        body: "Links expire after 15 minutes or once used. Close this tab and start sign-in again in Lilac.",
      };
  }
}

function callbackPage(result: McpOAuthCallbackOutcome, copy: CallbackCopy): string {
  const ok = result.outcome === "completed";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${copy.title} · Lilac</title>
<style>
:root { color-scheme: light dark; --bg: #f7f6f9; --card: #ffffff; --fg: #1d1b22; --muted: #6b6774; --border: #e4e1ea; --ok: #2f8a5b; --bad: #c2413a; }
@media (prefers-color-scheme: dark) { :root { --bg: #16151a; --card: #1f1d24; --fg: #ecebef; --muted: #a29fab; --border: #322f38; --ok: #5cc18e; --bad: #ef7d74; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 420px; padding: 28px; border: 1px solid var(--border); border-radius: 16px; background: var(--card); }
.mark { display: flex; width: 36px; height: 36px; align-items: center; justify-content: center; margin-bottom: 16px; border-radius: 50%; color: var(--${ok ? "ok" : "bad"}); background: color-mix(in srgb, currentColor 14%, transparent); }
h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<div class="mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${ok ? '<path d="M20 6 9 17l-5-5"/>' : '<path d="M18 6 6 18M6 6l12 12"/>'}</svg></div>
<h1>${copy.heading}</h1>
<p>${copy.body}</p>
</main>
</body>
</html>
`;
}

function urlPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}
