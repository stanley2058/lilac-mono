import {
  streamText,
  InvalidToolInputError,
  NoSuchToolError,
  type AssistantContent,
  type AssistantModelMessage,
  type Experimental_DownloadFunction as DownloadFunction,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolModelMessage,
  type ToolSet,
} from "ai";
import type { ModelReasoningEffort } from "@stanley2058/lilac-utils/core-config/types";
import {
  normalizeReplayMessages,
  normalizeToolCallInputValue,
} from "@stanley2058/lilac-utils/tool-call-input-normalization";
import {
  canonicalToolName,
  repairLegacyBatchInput,
  projectAiSdkTextStreamPart,
  extractToolCallsFromMessages,
} from "./support";
import {
  cloneMessage,
  resultOutcome,
  upsertTextPart,
  recoveryToolOutput,
  type AgentEvent,
  type TurnAbortReason,
  type TurnErrorPhase,
} from "../../agent-runtime-support";
import {
  type OpaqueAgentValue,
  captureAgentPromise,
  rethrowAgentPanic,
} from "../../failure-adapters";

export interface AiSdkModelCallInput {
  model: LanguageModel;
  system: Parameters<typeof streamText>[0]["instructions"];
  messages: ModelMessage[];
  tools?: ToolSet;
  reasoning?: ModelReasoningEffort;
  providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
  download?: DownloadFunction;
  maxRetries?: number;
  abortSignal?: AbortSignal;
  host: {
    emit(event: AgentEvent<ToolSet>): void;
    checkpointDraft(message: AssistantModelMessage): void;
    setStreamMessage(message: AssistantModelMessage | null): void;
    normalizeNewToolMessage(message: ToolModelMessage): Promise<ToolModelMessage>;
    normalizeNewAssistantMessage(message: AssistantModelMessage): Promise<AssistantModelMessage>;
    clearNormalizedToolCallIds(): void;
    markProviderTool(): void;
    markLocalToolDraft(toolCallId: string): void;
    onErrorPhase(phase: TurnErrorPhase): void;
    getAbortReason(): TurnAbortReason;
    abortModel(reason: TurnAbortReason): never;
    failModel(cause: OpaqueAgentValue, message: string): never;
  };
}

export interface AiSdkModelCallResult {
  finishReason: FinishReason;
  newMessages: ModelMessage[];
  toolCalls: ReturnType<typeof extractToolCallsFromMessages>;
  usage: LanguageModelUsage;
  totalUsage: LanguageModelUsage;
  modelInputMessages: ModelMessage[];
}

export async function executeAiSdkModelCall(
  input: AiSdkModelCallInput,
): Promise<AiSdkModelCallResult> {
  const result = streamText({
    model: input.model,
    instructions: input.system,
    messages: input.messages,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    experimental_repairToolCall: async ({ toolCall, tools, error }) => {
      if (NoSuchToolError.isInstance(error)) {
        const toolName = canonicalToolName(toolCall.toolName);
        return toolName !== toolCall.toolName && tools[toolName] ? { ...toolCall, toolName } : null;
      }
      if (InvalidToolInputError.isInstance(error) && toolCall.toolName === "batch") {
        const input = repairLegacyBatchInput(toolCall.input, tools);
        return input === null ? null : { ...toolCall, input };
      }
      return null;
    },
    reasoning: input.reasoning,
    providerOptions: input.providerOptions,
    experimental_download: input.download,
    ...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
    abortSignal: input.abortSignal,
    onError: () => {},
  });

  let assistantStarted = false;
  let partialAssistant: Omit<AssistantModelMessage, "content"> & {
    content: Exclude<AssistantContent, string>;
  } = {
    role: "assistant",
    content: [],
  };
  // Tool calls observed in `stream` may still have raw/unvalidated JSON.
  // They are useful for UI events, but we must execute tools only from the
  // finalized `response.messages` (post-parse + schema validation).

  let aborted = false;

  for await (const externalPart of result.stream) {
    const projectedPart = projectAiSdkTextStreamPart(externalPart);
    if (projectedPart.kind === "unsupported") continue;
    if (projectedPart.kind === "abort") {
      aborted = true;
      break;
    }
    if (input.abortSignal?.aborted) {
      aborted = true;
      break;
    }
    if (projectedPart.kind === "start-step") {
      continue;
    }

    if (
      !assistantStarted &&
      (projectedPart.kind === "text-start" ||
        projectedPart.kind === "text-delta" ||
        projectedPart.kind === "reasoning-start" ||
        projectedPart.kind === "reasoning-delta" ||
        projectedPart.kind === "tool-input-start" ||
        projectedPart.kind === "tool-input-delta" ||
        projectedPart.kind === "tool-call" ||
        projectedPart.kind === "custom" ||
        projectedPart.kind === "source" ||
        projectedPart.kind === "file" ||
        projectedPart.kind === "reasoning-file")
    ) {
      assistantStarted = true;
      input.host.setStreamMessage(partialAssistant);
      input.host.emit({
        type: "message_start",
        message: cloneMessage(partialAssistant),
      });
    }

    switch (projectedPart.kind) {
      case "text-start": {
        const part = projectedPart.raw;
        // Some providers omit the preceding block's explicit end event. A new
        // block still makes the accumulated prefix a completed boundary.
        input.host.checkpointDraft(partialAssistant);
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "text_start",
            id: part.id,
            raw: {
              type: part.type,
              id: part.id,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "text-delta": {
        const part = projectedPart.raw;
        if (partialAssistant.content.at(-1)?.type === "reasoning") {
          input.host.checkpointDraft(partialAssistant);
        }
        upsertTextPart(partialAssistant.content, "text", part.text);
        input.host.setStreamMessage(partialAssistant);
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "text_delta",
            id: part.id,
            delta: part.text,
            raw: {
              type: part.type,
              id: part.id,
              text: part.text,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "text-end": {
        const part = projectedPart.raw;
        if (input.abortSignal?.aborted) break;
        input.host.checkpointDraft(partialAssistant);
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "text_end",
            id: part.id,
            raw: {
              type: part.type,
              id: part.id,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "reasoning-start": {
        const part = projectedPart.raw;
        input.host.checkpointDraft(partialAssistant);
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "thinking_start",
            id: part.id,
            raw: {
              type: part.type,
              id: part.id,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "reasoning-delta": {
        const part = projectedPart.raw;
        if (partialAssistant.content.at(-1)?.type === "text") {
          input.host.checkpointDraft(partialAssistant);
        }
        upsertTextPart(partialAssistant.content, "reasoning", part.text);
        input.host.setStreamMessage(partialAssistant);
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "thinking_delta",
            id: part.id,
            delta: part.text,
            raw: {
              type: part.type,
              id: part.id,
              text: part.text,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "reasoning-end": {
        const part = projectedPart.raw;
        if (input.abortSignal?.aborted) break;
        input.host.checkpointDraft(partialAssistant);
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "thinking_end",
            id: part.id,
            raw: {
              type: part.type,
              id: part.id,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "tool-input-start": {
        const part = projectedPart.raw;
        input.host.checkpointDraft(partialAssistant);
        if (part.providerExecuted === true) {
          input.host.markProviderTool();
        } else {
          input.host.markLocalToolDraft(part.id);
        }
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "toolcall_start",
            toolCallId: part.id,
            toolName: part.toolName,
            raw: {
              type: part.type,
              id: part.id,
              toolName: part.toolName,
              ...(part.toolMetadata === undefined ? {} : { toolMetadata: part.toolMetadata }),
              ...(part.providerExecuted === undefined
                ? {}
                : { providerExecuted: part.providerExecuted }),
              ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
              ...(part.title === undefined ? {} : { title: part.title }),
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "tool-input-delta": {
        const part = projectedPart.raw;
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "toolcall_delta",
            toolCallId: part.id,
            delta: part.delta,
            raw: {
              type: part.type,
              id: part.id,
              delta: part.delta,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "tool-input-end": {
        const part = projectedPart.raw;
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "toolcall_end",
            toolCallId: part.id,
            raw: {
              type: part.type,
              id: part.id,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "custom": {
        const part = projectedPart.raw;
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "custom",
            raw: {
              type: part.type,
              kind: part.kind,
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "source": {
        const part = projectedPart.raw;
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "source",
            raw: {
              type: part.type,
              id: part.id,
              ...(part.sourceType === "url"
                ? {
                    sourceType: "url" as const,
                    url: part.url,
                    ...(part.title === undefined ? {} : { title: part.title }),
                  }
                : {
                    sourceType: "document" as const,
                    mediaType: part.mediaType,
                    title: part.title,
                    ...(part.filename === undefined ? {} : { filename: part.filename }),
                  }),
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "file": {
        const part = projectedPart.raw;
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "file",
            raw: {
              type: part.type,
              file: {
                base64: part.file.base64,
                uint8Array: new Uint8Array(part.file.uint8Array),
                mediaType: part.file.mediaType,
              },
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "reasoning-file": {
        const part = projectedPart.raw;
        input.host.emit({
          type: "message_update",
          message: cloneMessage(partialAssistant),
          assistantMessageEvent: {
            type: "reasoning_file",
            raw: {
              type: part.type,
              file: {
                base64: part.file.base64,
                uint8Array: new Uint8Array(part.file.uint8Array),
                mediaType: part.file.mediaType,
              },
              ...(part.providerMetadata === undefined
                ? {}
                : { providerMetadata: part.providerMetadata }),
            },
          },
        });
        break;
      }
      case "tool-call": {
        const part = projectedPart.raw;
        if (input.abortSignal?.aborted) break;
        input.host.checkpointDraft(partialAssistant);
        const { toolCallId, toolName, input: toolInput } = part;
        if (part.providerExecuted === true) {
          input.host.markProviderTool();
        } else {
          input.host.markLocalToolDraft(toolCallId);
        }
        partialAssistant.content.push({
          type: "tool-call",
          toolCallId,
          toolName,
          input: normalizeToolCallInputValue(toolInput),
          providerExecuted: part.providerExecuted,
        });
        input.host.setStreamMessage(partialAssistant);
        break;
      }
      case "tool-result": {
        const part = projectedPart.raw;
        if (input.abortSignal?.aborted) break;
        if (part.providerExecuted === true) {
          input.host.markProviderTool();
          partialAssistant.content.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: recoveryToolOutput(part.output),
          });
          input.host.setStreamMessage(partialAssistant);
          input.host.checkpointDraft(partialAssistant);
        }
        break;
      }
      case "tool-error": {
        const part = projectedPart.raw;
        if (input.abortSignal?.aborted) break;
        if (part.providerExecuted === true) {
          input.host.markProviderTool();
          partialAssistant.content.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: { type: "error-text", value: String(part.error) },
          });
          input.host.setStreamMessage(partialAssistant);
          input.host.checkpointDraft(partialAssistant);
        }
        break;
      }
      case "tool-output-denied": {
        const part = projectedPart.raw;
        if (input.abortSignal?.aborted) break;
        if (part.providerExecuted === true) {
          input.host.markProviderTool();
          partialAssistant.content.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: { type: "execution-denied", reason: "Tool output was denied." },
          });
          input.host.setStreamMessage(partialAssistant);
          input.host.checkpointDraft(partialAssistant);
        }
        break;
      }
      case "tool-approval-response": {
        const part = projectedPart.raw;
        if (part.providerExecuted === true) {
          input.host.markProviderTool();
        }
        break;
      }
      case "tool-approval-request": {
        const part = projectedPart.raw;
        if (part.toolCall.providerExecuted === true) {
          input.host.markProviderTool();
        }
        break;
      }
      case "error": {
        const part = projectedPart.raw;
        input.host.failModel(part.error, "AI SDK model stream failed");
      }
    }
  }

  if (aborted) {
    if (assistantStarted) {
      input.host.emit({
        type: "message_end",
        message: cloneMessage(partialAssistant),
      });
    }
    input.host.setStreamMessage(null);

    const reason: TurnAbortReason = input.host.getAbortReason();

    input.host.abortModel(reason);
  }

  const responseAttempt = resultOutcome(
    await captureAgentPromise(async () => ({
      response: await result.response,
      finishReason: await result.finishReason,
      usage: await result.usage,
      totalUsage: await result.totalUsage,
      warnings: await result.warnings,
    })),
  );
  if (!responseAttempt.ok) {
    const e = responseAttempt.error;
    rethrowAgentPanic(e);
    if (input.abortSignal?.aborted) {
      if (assistantStarted) {
        input.host.emit({
          type: "message_end",
          message: cloneMessage(partialAssistant),
        });
      }
      input.host.setStreamMessage(null);

      const reason: TurnAbortReason = input.host.getAbortReason();

      input.host.abortModel(reason);
    }
    input.host.failModel(e, "AI SDK model response failed");
  }
  const { response, finishReason, usage, totalUsage, warnings } = responseAttempt.value;
  input.host.onErrorPhase("post-model");

  if (warnings && warnings.length > 0) {
    input.host.emit({
      type: "turn_warnings",
      warnings,
    });
  }

  const newMessages: ModelMessage[] = [];
  for (const message of normalizeReplayMessages(response.messages)) {
    if (message.role === "tool") {
      newMessages.push(await input.host.normalizeNewToolMessage(message));
    } else if (message.role === "assistant") {
      newMessages.push(await input.host.normalizeNewAssistantMessage(message));
    } else {
      newMessages.push(message);
    }
  }
  input.host.clearNormalizedToolCallIds();
  const toolCalls = extractToolCallsFromMessages(newMessages);

  // Emit message_end for assistant message (first assistant in response.messages)
  const assistantMessage = newMessages.find((m) => m.role === "assistant");
  if (assistantStarted) {
    if (assistantMessage) {
      input.host.emit({
        type: "message_end",
        message: cloneMessage(assistantMessage),
      });
    } else {
      input.host.emit({
        type: "message_end",
        message: cloneMessage(partialAssistant),
      });
    }
  }
  input.host.setStreamMessage(null);

  // If provider-executed tools produced tool messages, emit them too.
  for (const m of newMessages) {
    if (m.role === "tool") {
      input.host.emit({ type: "message_start", message: cloneMessage(m) });
      input.host.emit({ type: "message_end", message: cloneMessage(m) });
    }
  }

  return {
    finishReason,
    newMessages,
    toolCalls,
    usage,
    totalUsage,
    modelInputMessages: input.messages.map(cloneMessage),
  };
}
