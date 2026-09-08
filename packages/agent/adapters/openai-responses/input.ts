import { readToolLoadingDefinitions, portableToolLoadingMessages } from "./tool-search";
import type { AgentToolDefinition } from "../../agent-adapter";
import type { FilePart, ImagePart, ModelMessage, ToolResultPart } from "ai";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import type {
  ResponseInputContent,
  ResponseSteerInputItemList,
  ResponseInputItem,
  ResponseReasoningItem,
  FunctionTool,
  Tool,
} from "openai/resources/responses/responses";
import { captureResultOutcome } from "@stanley2058/lilac-utils/runtime-utils";
import { AgentAdapterFailure } from "../../agent-adapter";
import {
  captureAgentOperation,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "../../failure-adapters";
import type { OpenAIJson, OpenAIRequestCodec, OpenAIResponseRequest } from "./protocol";

type OpenAIInputItem = ResponseInputItem;
type ToolResultOutput = ToolResultPart["output"];
type Encoded<T> = ResultType<T, AgentAdapterFailure>;
type Options = NonNullable<ModelMessage["providerOptions"]>[string];
type EncodingPolicy = {
  nativeToolSearch?: boolean;
  store: boolean;
  hasConversation?: boolean;
  hasPreviousResponseId?: boolean;
  systemMode: "system" | "developer" | "remove";
  passThroughUnsupportedFiles?: boolean;
  outputSchemaToolNames?: readonly string[];
};
const defaultPolicy: EncodingPolicy = { store: false, systemMode: "system" };

function unsupported(message: string): Encoded<never> {
  return Result.err(new AgentAdapterFailure({ reason: "protocol", replaySafety: "safe", message }));
}

function jsonOperation(operation: () => OpaqueAgentValue): Encoded<OpenAIJson> {
  const captured = captureResultOutcome(captureAgentOperation(operation));
  if (!captured.ok) {
    rethrowAgentPanic(captured.error);
    return unsupported("OpenAI request contains invalid JSON data");
  }
  const parsed = z.json().safeParse(captured.value);
  if (!parsed.success) return unsupported("OpenAI request contains non-JSON data");
  return Result.ok(parsed.data);
}

function parseJson(value: string): Encoded<OpenAIJson> {
  return jsonOperation(() => JSON.parse(value));
}

function jsonText(value: OpaqueAgentValue): Encoded<string> {
  return jsonOperation(() => JSON.stringify(value)).andThen((encoded) =>
    typeof encoded === "string"
      ? Result.ok(encoded)
      : unsupported("OpenAI tool value cannot be serialized"),
  );
}

function metadata(options: ModelMessage["providerOptions"]): Options {
  return options?.openai ?? {};
}

function stringOption(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function imageDetail(options: Options): "auto" | "low" | "high" | "original" {
  const detail = options.imageDetail;
  return detail === "low" || detail === "high" || detail === "original" ? detail : "auto";
}

function cacheBreakpoint(
  options: ModelMessage["providerOptions"],
): ResponseInputContent["prompt_cache_breakpoint"] {
  const value = metadata(options).promptCacheBreakpoint;
  if (value == null || value === false) return undefined;
  if (typeof value === "object" && !Array.isArray(value) && value.mode === "explicit")
    return { mode: "explicit" };
  return undefined;
}

function referenceFile(
  id: string | undefined,
  image: boolean,
  options: Options,
): Encoded<ResponseInputContent> {
  if (!id) return unsupported("File reference has no OpenAI file id");
  return Result.ok(
    image
      ? { type: "input_image", file_id: id, detail: imageDetail(options) }
      : { type: "input_file", file_id: id },
  );
}

function imageMediaType(data: string): string | undefined {
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  const header = Buffer.from(data.slice(0, 24), "base64");
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return undefined;
}

function binaryFile(
  data: string | Uint8Array | ArrayBuffer,
  mediaType: string,
  filename: string | undefined,
  options: Options,
): Encoded<ResponseInputContent> {
  const image = mediaType === "image" || mediaType.startsWith("image/");
  if (typeof data === "string" && data.startsWith("file-"))
    return referenceFile(data, image, options);
  const bytes =
    typeof data === "string"
      ? data
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("base64");
  const resolvedMediaType =
    mediaType === "image" || mediaType === "image/*" ? imageMediaType(bytes) : mediaType;
  if (!resolvedMediaType && !bytes.startsWith("data:"))
    return unsupported("Image data requires a recognized format or explicit media type");
  const content = bytes.startsWith("data:") ? bytes : `data:${resolvedMediaType};base64,${bytes}`;
  if (image)
    return Result.ok({ type: "input_image", image_url: content, detail: imageDetail(options) });
  return Result.ok({
    type: "input_file",
    filename: filename ?? (mediaType === "application/pdf" ? "file.pdf" : "file"),
    file_data: content,
  });
}

function resource(part: FilePart | ImagePart): Encoded<ResponseInputContent> {
  const options = metadata(part.providerOptions);
  const mediaType = part.type === "image" ? (part.mediaType ?? "image") : part.mediaType;
  const filename = part.type === "file" ? part.filename : undefined;
  const image = part.type === "image" || mediaType === "image" || mediaType.startsWith("image/");
  const data = part.type === "image" ? part.image : part.data;
  if (typeof data === "string" || data instanceof Uint8Array || data instanceof ArrayBuffer)
    return binaryFile(data, mediaType, filename, options);
  if (data instanceof URL)
    return Result.ok(
      image
        ? { type: "input_image", image_url: data.href, detail: imageDetail(options) }
        : { type: "input_file", file_url: data.href },
    );
  if (!("type" in data)) return referenceFile(data.openai, image, options);
  if (data.type === "data" && "data" in data)
    return binaryFile(data.data, mediaType, filename, options);
  if (data.type === "url" && "url" in data)
    return Result.ok(
      image
        ? { type: "input_image", image_url: data.url.toString(), detail: imageDetail(options) }
        : { type: "input_file", file_url: data.url.toString() },
    );
  if (data.type === "reference" && "reference" in data)
    return referenceFile(data.reference.openai, image, options);
  return unsupported("Inline text file content is not supported by OpenAI Responses");
}

function userContent(
  part: Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number],
  policy: EncodingPolicy,
): Encoded<ResponseInputContent> {
  if (part.type === "text")
    return Result.ok({
      type: "input_text",
      text: part.text,
      prompt_cache_breakpoint: cacheBreakpoint(part.providerOptions),
    });
  return resource(part).andThen((item) => {
    if (
      item.type === "input_file" &&
      item.file_data !== undefined &&
      part.type === "file" &&
      part.mediaType !== "application/pdf" &&
      !policy.passThroughUnsupportedFiles
    )
      return unsupported(`Unsupported OpenAI user file media type: ${part.mediaType}`);
    return Result.ok({
      ...item,
      prompt_cache_breakpoint: cacheBreakpoint(part.providerOptions),
    });
  });
}

function encodeToolContent(
  part: Extract<ToolResultOutput, { type: "content" }>["value"][number],
): Encoded<ResponseInputContent> {
  switch (part.type) {
    case "text":
      return Result.ok({ type: "input_text", text: part.text });
    case "file":
      return resource(part);
    case "file-data":
      return binaryFile(part.data, part.mediaType, part.filename, metadata(part.providerOptions));
    case "image-data":
      return binaryFile(part.data, part.mediaType, undefined, metadata(part.providerOptions));
    case "file-url":
      return Result.ok({ type: "input_file", file_url: part.url });
    case "image-url":
      return Result.ok({
        type: "input_image",
        image_url: part.url,
        detail: imageDetail(metadata(part.providerOptions)),
      });
    case "file-id":
      return referenceFile(
        typeof part.fileId === "string" ? part.fileId : part.fileId.openai,
        false,
        metadata(part.providerOptions),
      );
    case "image-file-id":
      return referenceFile(
        typeof part.fileId === "string" ? part.fileId : part.fileId.openai,
        true,
        metadata(part.providerOptions),
      );
    case "file-reference":
      return referenceFile(part.providerReference.openai, false, metadata(part.providerOptions));
    case "image-file-reference":
      return referenceFile(part.providerReference.openai, true, metadata(part.providerOptions));
    default:
      return unsupported(`Unsupported OpenAI tool content: ${part.type}`);
  }
}

function toolContent(
  part: Extract<ToolResultOutput, { type: "content" }>["value"][number],
): Encoded<ResponseInputContent> {
  return encodeToolContent(part).map((item) => ({
    ...item,
    prompt_cache_breakpoint: cacheBreakpoint(part.providerOptions),
  }));
}

function toolOutput(
  output: ToolResultOutput,
  hasOutputSchema: boolean,
): Encoded<ResponseInputItem.FunctionCallOutput["output"]> {
  switch (output.type) {
    case "text":
    case "error-text":
      return hasOutputSchema ? jsonText(output.value) : Result.ok(output.value);
    case "json":
    case "error-json":
      return jsonText(output.value);
    case "execution-denied":
      return hasOutputSchema
        ? jsonText(output.reason ?? "Tool call execution denied.")
        : Result.ok(output.reason ?? "Tool call execution denied.");
    case "content":
      return Result.all(output.value.map(toolContent));
  }
}

function replayReasoning(
  item: Omit<ResponseReasoningItem, "id"> & { id?: string },
): ResponseReasoningItem {
  // Responses accepts encrypted reasoning without an id, although the SDK requires output ids on replay inputs.
  return item as ResponseReasoningItem;
}

function assistantText(text: string, options: Options): OpenAIInputItem {
  const id = stringOption(options, "itemId");
  const phase =
    options.phase === "commentary" || options.phase === "final_answer" ? options.phase : undefined;
  if (!id) return { role: "assistant", content: text, phase };
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
    phase,
  };
}

function assistantMessage(
  message: Extract<ModelMessage, { role: "assistant" }>,
  policy: EncodingPolicy,
): Encoded<OpenAIInputItem[]> {
  if (typeof message.content === "string")
    return Result.ok([assistantText(message.content, metadata(message.providerOptions))]);
  const items: OpenAIInputItem[] = [];
  const reasoning = new Map<string, ResponseReasoningItem>();
  for (const part of message.content) {
    const options = metadata("providerOptions" in part ? part.providerOptions : undefined);
    const id = stringOption(options, "itemId");
    switch (part.type) {
      case "text": {
        if (policy.hasConversation && id) break;
        if (policy.store && id) {
          items.push({ type: "item_reference", id });
          break;
        }
        items.push(assistantText(part.text, { ...metadata(message.providerOptions), ...options }));
        break;
      }
      case "reasoning": {
        if ((policy.hasConversation || policy.hasPreviousResponseId) && id) break;
        if (id && reasoning.has(id)) {
          const previous = reasoning.get(id);
          if (previous && part.text)
            previous.summary.push({ type: "summary_text", text: part.text });
          if (previous && options.reasoningEncryptedContent != null)
            previous.encrypted_content = stringOption(options, "reasoningEncryptedContent");
          break;
        }
        if (policy.store && id) {
          items.push({ type: "item_reference", id });
          reasoning.set(id, { type: "reasoning", id, summary: [] });
          break;
        }
        if (!id && options.reasoningEncryptedContent == null) break;
        const item = replayReasoning({
          type: "reasoning",
          id,
          encrypted_content: stringOption(options, "reasoningEncryptedContent"),
          summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
        });
        items.push(item);
        if (id) reasoning.set(id, item);
        break;
      }
      case "tool-call": {
        if (policy.hasConversation && id) break;
        if (part.providerExecuted)
          return unsupported("Provider-executed tools require the AI SDK adapter");
        const encodedArguments = captureResultOutcome(jsonText(part.input ?? {}));
        if (!encodedArguments.ok) return Result.err(encodedArguments.error);
        const argumentsJson = encodedArguments.value;
        if (policy.nativeToolSearch && options.toolSearchCall === true) {
          const argumentsValue = captureResultOutcome(parseJson(argumentsJson));
          if (!argumentsValue.ok) return Result.err(argumentsValue.error);
          items.push({
            type: "tool_search_call",
            id,
            call_id: part.toolCallId,
            execution: "client",
            status: "completed",
            arguments: argumentsValue.value,
          });
          break;
        }
        items.push({
          type: "function_call",
          id,
          call_id: part.toolCallId,
          name: part.toolName,
          arguments: argumentsJson,
        });
        break;
      }
      case "tool-result": {
        if (policy.hasConversation) break;
        const encodedOutput = captureResultOutcome(
          toolOutput(part.output, policy.outputSchemaToolNames?.includes(part.toolName) ?? false),
        );
        if (!encodedOutput.ok) return Result.err(encodedOutput.error);
        const output = encodedOutput.value;
        items.push({ type: "function_call_output", call_id: part.toolCallId, output });
        break;
      }
      case "custom": {
        if (policy.hasConversation && id) break;
        if (part.kind !== "openai.compaction")
          return unsupported(`Unsupported OpenAI custom content: ${part.kind}`);
        if (policy.store && id) {
          items.push({ type: "item_reference", id });
          break;
        }
        if (typeof options.encryptedContent !== "string")
          return unsupported("Compaction item is missing encrypted content");
        items.push({ type: "compaction", id, encrypted_content: options.encryptedContent });
        break;
      }
      default:
        return unsupported(`Unsupported OpenAI assistant content: ${part.type}`);
    }
  }
  return Result.ok(
    items.filter((item) => item.type !== "reasoning" || item.encrypted_content != null),
  );
}

function encodeMessages(
  messages: readonly ModelMessage[],
  policy: EncodingPolicy,
): Encoded<OpenAIInputItem[]> {
  const items: OpenAIInputItem[] = [];
  for (const message of policy.nativeToolSearch
    ? messages
    : portableToolLoadingMessages(messages)) {
    if (policy.nativeToolSearch) {
      const seed = captureResultOutcome(
        readToolLoadingDefinitions(message.providerOptions, "toolSearchSeed"),
      );
      if (!seed.ok) return Result.err(seed.error);
      if (seed.value) {
        const definitions = captureResultOutcome(encodeToolDefinitions(seed.value));
        if (!definitions.ok) return Result.err(definitions.error);
        items.push({ type: "additional_tools", role: "developer", tools: definitions.value });
      }
    }
    switch (message.role) {
      case "system": {
        if (policy.systemMode !== "remove")
          items.push({
            role: policy.systemMode,
            content:
              cacheBreakpoint(message.providerOptions) == null
                ? message.content
                : [
                    {
                      type: "input_text",
                      text: message.content,
                      prompt_cache_breakpoint: cacheBreakpoint(message.providerOptions),
                    },
                  ],
          });
        break;
      }
      case "user": {
        const encodedContent = captureResultOutcome(
          typeof message.content === "string"
            ? Result.ok<ResponseInputContent[]>([{ type: "input_text", text: message.content }])
            : Result.all(message.content.map((part) => userContent(part, policy))),
        );
        if (!encodedContent.ok) return Result.err(encodedContent.error);
        const content = encodedContent.value;
        items.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const assistant = captureResultOutcome(assistantMessage(message, policy));
        if (!assistant.ok) return Result.err(assistant.error);
        items.push(...assistant.value);
        break;
      }
      case "tool": {
        for (const part of message.content) {
          if (part.type !== "tool-result")
            return unsupported("Provider approval messages require the AI SDK adapter");
          if (policy.nativeToolSearch) {
            const loaded = captureResultOutcome(
              readToolLoadingDefinitions(part.providerOptions, "toolSearchTools"),
            );
            if (!loaded.ok) return Result.err(loaded.error);
            if (loaded.value) {
              const definitions = captureResultOutcome(encodeToolDefinitions(loaded.value));
              if (!definitions.ok) return Result.err(definitions.error);
              items.push({
                type: "tool_search_output",
                call_id: part.toolCallId,
                execution: "client",
                status: "completed",
                tools: definitions.value.map((tool) => ({ ...tool, defer_loading: true })),
              });
              continue;
            }
          }
          const encodedOutput = captureResultOutcome(
            toolOutput(part.output, policy.outputSchemaToolNames?.includes(part.toolName) ?? false),
          );
          if (!encodedOutput.ok) return Result.err(encodedOutput.error);
          const output = encodedOutput.value;
          items.push({ type: "function_call_output", call_id: part.toolCallId, output });
        }
        break;
      }
    }
  }
  return Result.ok(items);
}

const directOptions: Record<string, keyof OpenAIResponseRequest> = {
  conversation: "conversation",
  maxToolCalls: "max_tool_calls",
  metadata: "metadata",
  parallelToolCalls: "parallel_tool_calls",
  previousResponseId: "previous_response_id",
  store: "store",
  user: "user",
  instructions: "instructions",
  serviceTier: "service_tier",
  include: "include",
  promptCacheKey: "prompt_cache_key",
  promptCacheOptions: "prompt_cache_options",
  promptCacheRetention: "prompt_cache_retention",
  safetyIdentifier: "safety_identifier",
  truncation: "truncation",
};
const localOptions = new Set([
  "reasoningEffort",
  "reasoningSummary",
  "reasoningMode",
  "reasoningContext",
  "textVerbosity",
  "logprobs",
  "contextManagement",
  "allowedTools",
  "systemMessageMode",
  "forceReasoning",
  "passThroughUnsupportedFiles",
  "compactionTrigger",
  "strictJsonSchema",
]);

function defaultSystemMode(
  model: string,
  forceReasoning: OpenAIJson | undefined,
): "system" | "developer" {
  if (forceReasoning === true || /^o\d+(?:-|$)/.test(model)) return "developer";
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(model);
  if (!gpt || Number(gpt[1]) < 5) return "system";
  if (gpt[2] === undefined && gpt[3]?.startsWith("chat")) return "system";
  return "developer";
}

function systemPromptMessages(
  system: Parameters<OpenAIRequestCodec["request"]>[0]["context"]["system"],
): ModelMessage[] {
  if (typeof system === "string") return system ? [{ role: "system", content: system }] : [];
  if ("role" in system) return [system];
  return [...system];
}

function reasoningSummary(
  options: Options,
  effort: OpenAIJson | undefined,
): OpenAIJson | undefined {
  if (options.reasoningSummary !== undefined) return options.reasoningSummary;
  if (effort != null && effort !== "none") return "detailed";
  return undefined;
}

function assignRequestOption<K extends keyof OpenAIResponseRequest>(
  request: OpenAIResponseRequest,
  key: K,
  value: OpenAIJson,
): void {
  request[key] = value as OpenAIResponseRequest[K];
}

function encodeToolDefinitions(
  definitions: readonly AgentToolDefinition[],
): Encoded<FunctionTool[]> {
  const tools: FunctionTool[] = [];
  for (const tool of definitions) {
    const encodedParameters = captureResultOutcome(parseJson(tool.inputSchemaJson));
    if (!encodedParameters.ok) return Result.err(encodedParameters.error);
    const parameters = encodedParameters.value;
    if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters))
      return unsupported("OpenAI tool parameters must be a JSON schema object");
    const encodedOutputSchema = captureResultOutcome(
      tool.outputSchemaJson === undefined ? Result.ok(undefined) : parseJson(tool.outputSchemaJson),
    );
    if (!encodedOutputSchema.ok) return Result.err(encodedOutputSchema.error);
    const outputSchema = encodedOutputSchema.value;
    if (
      outputSchema !== undefined &&
      (outputSchema === null || typeof outputSchema !== "object" || Array.isArray(outputSchema))
    )
      return unsupported("OpenAI tool output must be a JSON schema object");
    const toolOptions = metadata(tool.providerOptions);
    tools.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
      strict: tool.strict ?? null,
      ...(outputSchema === undefined ? {} : { output_schema: outputSchema }),
      ...(toolOptions.deferLoading === undefined
        ? {}
        : { defer_loading: toolOptions.deferLoading === true }),
      ...(toolOptions.allowedCallers === undefined
        ? {}
        : { allowed_callers: toolOptions.allowedCallers as FunctionTool["allowed_callers"] }),
    });
  }
  return Result.ok(tools);
}

function encodeRequest(
  input: Parameters<OpenAIRequestCodec["request"]>[0],
): Encoded<OpenAIResponseRequest> {
  const options = input.providerOptions?.openai ?? {};
  for (const name of Object.keys(options)) {
    if (!directOptions[name] && !localOptions.has(name))
      return unsupported(`Unsupported OpenAI request option: ${name}`);
  }
  const systemMode =
    options.systemMessageMode ?? defaultSystemMode(input.model, options.forceReasoning);
  if (systemMode !== "system" && systemMode !== "developer" && systemMode !== "remove")
    return unsupported("Invalid OpenAI system message mode");
  const systemMessages = systemPromptMessages(input.context.system);
  const encodedMessages = captureResultOutcome(
    encodeMessages([...systemMessages, ...input.context.messages], {
      nativeToolSearch: input.context.nativeToolSearch,
      store: options.store !== false,
      hasConversation: options.conversation != null,
      hasPreviousResponseId: options.previousResponseId != null,
      systemMode,
      passThroughUnsupportedFiles: options.passThroughUnsupportedFiles === true,
      outputSchemaToolNames: input.context.tools
        .filter((tool) => tool.outputSchemaJson !== undefined)
        .map((tool) => tool.name),
    }),
  );
  if (!encodedMessages.ok) return Result.err(encodedMessages.error);
  const messages = encodedMessages.value;
  const request: OpenAIResponseRequest = {
    type: "response.create",
    model: input.model,
    input: messages,
  };
  for (const [name, wireName] of Object.entries(directOptions))
    if (options[name] !== undefined) assignRequestOption(request, wireName, options[name]);
  const deferred = new Set(
    input.context.nativeToolSearch ? input.context.deferredTools?.map((tool) => tool.name) : [],
  );
  const encodedTools = captureResultOutcome(
    encodeToolDefinitions(input.context.tools.filter((tool) => !deferred.has(tool.name))),
  );
  if (!encodedTools.ok) return Result.err(encodedTools.error);
  const tools: Tool[] = encodedTools.value.map((tool) =>
    input.context.nativeToolSearch && tool.name === "find_tools"
      ? {
          type: "tool_search",
          execution: "client",
          description: tool.description,
          parameters: tool.parameters,
        }
      : tool,
  );
  if (tools.length) request.tools = tools;
  if (options.compactionTrigger === true) request.input.push({ type: "compaction_trigger" });
  const effort = options.reasoningEffort ?? input.reasoning;
  if (
    options.forceReasoning !== false &&
    (effort != null ||
      options.reasoningSummary != null ||
      options.reasoningMode != null ||
      options.reasoningContext != null)
  )
    request.reasoning = {
      effort: effort as NonNullable<OpenAIResponseRequest["reasoning"]>["effort"],
      summary: reasoningSummary(options, effort) as NonNullable<
        OpenAIResponseRequest["reasoning"]
      >["summary"],
      mode: options.reasoningMode as NonNullable<OpenAIResponseRequest["reasoning"]>["mode"],
      context: options.reasoningContext as NonNullable<
        OpenAIResponseRequest["reasoning"]
      >["context"],
    };
  if (options.textVerbosity != null)
    request.text = {
      verbosity: options.textVerbosity as NonNullable<OpenAIResponseRequest["text"]>["verbosity"],
    };
  const includes = z.array(z.string()).safeParse(options.include ?? []);
  if (!includes.success) return unsupported("Invalid OpenAI include option");
  const include = [...includes.data];
  if (options.store === false && !include.includes("reasoning.encrypted_content"))
    include.push("reasoning.encrypted_content");
  if (options.logprobs) {
    if (options.logprobs === true) request.top_logprobs = 20;
    if (typeof options.logprobs === "number") request.top_logprobs = options.logprobs;
    if (!include.includes("message.output_text.logprobs"))
      include.push("message.output_text.logprobs");
  }
  if (include.length) request.include = include as OpenAIResponseRequest["include"];
  if (options.contextManagement != null) {
    const contexts = z
      .array(z.object({ type: z.literal("compaction"), compactThreshold: z.number().optional() }))
      .safeParse(options.contextManagement);
    if (!contexts.success) return unsupported("Invalid OpenAI context management option");
    request.context_management = contexts.data.map((context) => ({
      type: context.type,
      compact_threshold: context.compactThreshold,
    }));
  }
  if (options.allowedTools != null) {
    const allowed = z
      .object({ mode: z.enum(["auto", "required"]).optional(), toolNames: z.array(z.string()) })
      .safeParse(options.allowedTools);
    if (!allowed.success) return unsupported("Invalid OpenAI allowed tools option");
    request.tool_choice = {
      type: "allowed_tools",
      mode: allowed.data.mode ?? "auto",
      tools: allowed.data.toolNames.map((name) => ({ type: "function", name })),
    };
  }
  return Result.ok(request);
}

export const openAIRequestCodec: OpenAIRequestCodec = {
  async request(input) {
    return encodeRequest(input);
  },
  async messages(messages, options) {
    return encodeMessages(messages, {
      ...defaultPolicy,
      nativeToolSearch: options?.nativeToolSearch,
      store: options?.store ?? defaultPolicy.store,
      outputSchemaToolNames: options?.outputSchemaToolNames,
    });
  },
  async steer(messages) {
    if (messages.length === 0 || messages.some((message) => message.role !== "user"))
      return unsupported("OpenAI steering requires one or more user messages");
    return Result.all(
      messages.map((message): Encoded<ResponseSteerInputItemList.Message> => {
        if (message.role !== "user") return unsupported("OpenAI steering requires user messages");
        if (typeof message.content === "string")
          return Result.ok({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: message.content }],
          });
        return Result.all(message.content.map((part) => userContent(part, defaultPolicy))).map(
          (content) => ({ type: "message", role: "user", content }),
        );
      }),
    );
  },
};
