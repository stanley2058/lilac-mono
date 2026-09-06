import { Result, type Result as ResultType } from "better-result";
import {
  createCodexOAuthAuthorization,
  type CodexOAuthAuthorizationOptions,
} from "@stanley2058/lilac-utils/codex-provider-auth";
import type { OpenAIResponsesConnectionOptions } from "@stanley2058/lilac-utils/openai-responses-connection";
import { AgentAdapterFailure } from "../../agent-adapter";
import { captureAgentPromise, rethrowAgentPanic } from "../../failure-adapters";
import { resultOutcome } from "../../agent-runtime-support";

export function createCodexConnectionOptions(
  options: CodexOAuthAuthorizationOptions & {
    responsesTransport: "auto" | "websocket";
  },
): (
  signal: AbortSignal,
) => Promise<ResultType<OpenAIResponsesConnectionOptions, AgentAdapterFailure>> {
  const authorize = createCodexOAuthAuthorization(options);
  return async (signal) => {
    const authorization = resultOutcome(await captureAgentPromise(() => authorize(signal)));
    if (!authorization.ok) {
      rethrowAgentPanic(authorization.error);
      return Result.err(
        new AgentAdapterFailure({
          reason: "unavailable",
          replaySafety: "safe",
          message: "Codex OAuth authorization failed",
          cause: authorization.error,
        }),
      );
    }
    return Result.ok({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      requestUrl: new URL("https://chatgpt.com/backend-api/codex/responses"),
      websocketUrl: "wss://chatgpt.com/backend-api/codex/responses",
      headers: authorization.value,
      mode: options.responsesTransport,
    });
  };
}
