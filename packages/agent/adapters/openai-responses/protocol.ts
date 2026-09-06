import type { AssistantModelMessage, FinishReason, LanguageModelUsage, ModelMessage } from "ai";
import type { Result as ResultType } from "better-result";
import type {
  AgentAdapterFailure,
  AgentOutput,
  AgentPreparedContext,
  AgentToolRequest,
} from "../../agent-adapter";

export type OpenAIJson =
  | null
  | boolean
  | number
  | string
  | OpenAIJson[]
  | { [key: string]: OpenAIJson | undefined };
export type OpenAIInputItem = { [key: string]: OpenAIJson | undefined };
export type OpenAIResponseRequest = {
  type: "response.create";
  model: string;
  input: OpenAIInputItem[];
  [key: string]: OpenAIJson | undefined;
};
export type OpenAIResponse = {
  id: string;
  previousResponseId?: string;
  status: string;
  incompleteReason?: string;
  output: OpenAIInputItem[];
  usage?: LanguageModelUsage;
};
export type OpenAIProtocolEvent =
  | { type: "created"; response: OpenAIResponse }
  | { type: "finished"; response: OpenAIResponse }
  | { type: "output"; output: AgentOutput }
  | { type: "item-start"; item: OpenAIInputItem }
  | { type: "block-complete"; item: OpenAIInputItem; index: number }
  | { type: "item-complete"; item: OpenAIInputItem }
  | { type: "steer-accepted"; steerId: string; previousResponseId: string }
  | {
      type: "steer-pending";
      previousResponseId: string;
      steerId?: string;
      requiredInput: OpenAIInputItem[];
    }
  | { type: "steer-failed"; previousResponseId: string; steerId?: string; message: string }
  | {
      type: "error";
      message: string;
      details?: { code?: string | null; type?: string; param?: string | null; statusCode?: number };
      response?: OpenAIResponse;
    }
  | { type: "ignored" };
export type OpenAIProjectedResponse = {
  messages: ModelMessage[];
  assistant: AssistantModelMessage;
  calls: AgentToolRequest[];
  finishReason: FinishReason;
};
export type OpenAIResponseCodec = {
  decode(data: string): ResultType<OpenAIProtocolEvent, AgentAdapterFailure>;
  project(response: OpenAIResponse): ResultType<OpenAIProjectedResponse, AgentAdapterFailure>;
};
export type OpenAIRequestCodec = {
  request(input: {
    model: string;
    context: AgentPreparedContext;
    providerOptions?: ModelMessage["providerOptions"];
    reasoning?: string;
  }): Promise<ResultType<OpenAIResponseRequest, AgentAdapterFailure>>;
  messages(
    messages: readonly ModelMessage[],
    options?: { outputSchemaToolNames?: readonly string[] },
  ): Promise<ResultType<OpenAIInputItem[], AgentAdapterFailure>>;
  steer(
    messages: readonly ModelMessage[],
  ): Promise<ResultType<OpenAIInputItem[], AgentAdapterFailure>>;
};
