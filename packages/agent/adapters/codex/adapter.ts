import type { ToolSet } from "ai";
import { Result } from "better-result";
import { createCodexOAuthProvider } from "@stanley2058/lilac-utils/model-provider";
import type { ResponsesTransportMode } from "@stanley2058/lilac-utils/env";
import type { AgentAdapter, AgentExecution } from "../../agent-adapter";
import type { AgentExecutionHost } from "../../agent-execution-host";
import { resultOutcome } from "../../agent-runtime-support";
import { AiSdkAgentAdapter } from "../ai-sdk/adapter";
import type { AiSdkPiAgentOptions } from "../ai-sdk/support";
import { OpenAIResponsesAgentAdapter } from "../openai-responses/adapter";
import { openAIRequestCodec } from "../openai-responses/input";
import type { OpenAIRequestCodec } from "../openai-responses/protocol";
import { createResponsesTransport } from "../openai-responses/transport";
import { createCodexConnectionOptions } from "./connection";
import {
  createCodexWebSocketEventNormalizer,
  normalizeCodexWebSocketRequest,
  readCodexTurnState,
} from "./compatibility";

const codexTransport = createResponsesTransport({
  normalizeRequest: normalizeCodexWebSocketRequest,
  createEventNormalizer: createCodexWebSocketEventNormalizer,
  readTurnState: readCodexTurnState,
});
const resolveCodexConnection = createCodexConnectionOptions({ responsesTransport: "auto" });
const codexSseProvider = createCodexOAuthProvider({ responsesTransport: "sse" });

export const codexRequestCodec: OpenAIRequestCodec = {
  ...openAIRequestCodec,
  request(input) {
    return openAIRequestCodec.request({
      ...input,
      context: {
        ...input.context,
        tools: input.context.tools.map((tool) => ({ ...tool, strict: tool.strict ?? false })),
      },
      providerOptions: {
        ...input.providerOptions,
        openai: {
          ...input.providerOptions?.openai,
          store: false,
          conversation: undefined,
          previousResponseId: undefined,
        },
      },
    });
  },
  messages(messages, options) {
    return openAIRequestCodec.messages(messages, { ...options, store: false });
  },
};

export type CodexAgentAdapterSettings = {
  model: string;
  transport: ResponsesTransportMode;
  resolveConnection?: ReturnType<typeof createCodexConnectionOptions>;
  transportClient?: ReturnType<typeof createResponsesTransport>;
};

export class CodexAgentAdapter implements AgentAdapter<AgentExecutionHost> {
  private readonly delegate: AgentAdapter<AgentExecutionHost>;

  constructor(options: AiSdkPiAgentOptions<ToolSet>, settings: CodexAgentAdapterSettings) {
    const fallback = new AiSdkAgentAdapter({
      ...options,
      model: codexSseProvider.responses(settings.model),
    });
    if (settings.transport === "sse") {
      this.delegate = fallback;
      return;
    }
    const resolve = settings.resolveConnection ?? resolveCodexConnection;
    const transport = settings.transportClient ?? codexTransport;
    this.delegate = new OpenAIResponsesAgentAdapter({
      model: settings.model,
      transport: settings.transport,
      nativeSteering: false,
      requestCodec: codexRequestCodec,
      fallback,
      connect: async (signal) => {
        const connection = resultOutcome(await resolve(signal));
        if (!connection.ok) return Result.err(connection.error);
        return transport.connect({ ...connection.value, mode: settings.transport }, signal);
      },
    });
  }

  createExecution(
    context: Parameters<AgentAdapter<AgentExecutionHost>["createExecution"]>[0],
  ): AgentExecution {
    return this.delegate.createExecution(context);
  }
}
