import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponsesClientEvent,
  ResponsesServerEvent,
  ResponseSteerInput,
  ResponseSteerRequiredInput,
} from "openai/resources/responses/responses";
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
export type OpenAIInputItem = ResponseInputItem;
export type OpenAIResponseRequest = Omit<ResponsesClientEvent.ResponseCreate, "model" | "input"> & {
  model: string;
  input: ResponseInputItem[];
};
export type OpenAIResponse = {
  id: string;
  previousResponseId?: string;
  status: string;
  incompleteReason?: string;
  output: ResponseOutputItem[];
  usage?: LanguageModelUsage;
};
export type OpenAIProtocolEvent =
  | { type: "created"; response: OpenAIResponse }
  | { type: "finished"; response: OpenAIResponse }
  | { type: "output"; output: AgentOutput }
  | { type: "item-start"; item: ResponseOutputItem }
  | { type: "block-complete"; item: ResponseOutputItem; index: number }
  | { type: "item-complete"; item: ResponseOutputItem }
  | { type: "steer-accepted"; steerId: string; previousResponseId: string }
  | {
      type: "steer-pending";
      previousResponseId: string;
      steerId?: string;
      requiredInput: ResponseSteerRequiredInput[];
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
  decode(event: ResponsesServerEvent): ResultType<OpenAIProtocolEvent, AgentAdapterFailure>;
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
  ): Promise<ResultType<ResponseSteerInput, AgentAdapterFailure>>;
};
