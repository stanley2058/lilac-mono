import { Result, TaggedError, type Result as ResultType } from "better-result";

import { readMcpConfigFile } from "./config-file";
import type { McpOAuthCallbackControl } from "./oauth-callback";
import type { McpOAuthProviderService, McpOAuthStartResult } from "./oauth-provider";

export class McpOAuthControlError extends TaggedError("McpOAuthControlError")<{
  readonly code: "not-found" | "unavailable";
  readonly message: string;
}> {}

/** Starts MCP OAuth for a server in the current configuration file. */
export type McpOAuthControl = {
  readonly callbackUrl: string;
  /** Aligns OAuth providers with the configuration file. An unreadable file leaves them as they are. */
  reconcile(): Promise<void>;
  authorize(serverId: string): Promise<ResultType<McpOAuthStartResult, McpOAuthControlError>>;
};

export function createMcpOAuthControl(options: {
  readonly configPath: string;
  readonly callbackUrl: string;
  readonly providers: Pick<
    McpOAuthProviderService,
    "reconcile" | "getProvider" | "startAuthorizationResult"
  >;
  readonly callback: Pick<McpOAuthCallbackControl, "start">;
  readonly readConfig?: typeof readMcpConfigFile;
}): McpOAuthControl {
  const readConfig = options.readConfig ?? readMcpConfigFile;
  async function reconcile(): Promise<void> {
    const read = await readConfig(options.configPath);
    read.match({
      ok: (snapshot) => options.providers.reconcile(snapshot.config),
      err: () => undefined,
    });
  }
  return {
    callbackUrl: options.callbackUrl,
    reconcile,
    async authorize(serverId) {
      const listener = options.callback.start();
      if (listener.status === "unavailable") {
        return Result.err(
          new McpOAuthControlError({
            code: "unavailable",
            message: `The OAuth callback listener is unavailable on ${listener.hostname}:${listener.port}: ${listener.error}`,
          }),
        );
      }
      await reconcile();
      if (!options.providers.getProvider(serverId)) {
        return Result.err(
          new McpOAuthControlError({
            code: "not-found",
            message: `Server ${JSON.stringify(serverId)} is not saved with OAuth`,
          }),
        );
      }
      const started = await options.providers.startAuthorizationResult(serverId);
      return started.mapError(
        (error) => new McpOAuthControlError({ code: "unavailable", message: error.message }),
      );
    },
  };
}
