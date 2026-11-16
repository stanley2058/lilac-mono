import { z } from "zod";
import type { ToolResultOutput } from "@stanley2058/lilac-agent";
import { mapToolResultOutputToMcpResult } from "./claude-code-tools";
import { rethrowAgentPanic } from "@stanley2058/lilac-agent/failure-adapters";
import {
  query,
  type SDKUserMessage,
  type SDKMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { AssistantModelMessage, LanguageModelUsage, ModelMessage } from "ai";
import { Result } from "better-result";
import {
  claudeRuntime,
  claudeUsage,
  createClaudeInput,
  type ClaudeQuery,
} from "@stanley2058/lilac-utils/claude-sdk";
import { cloneMessage, upsertTextPart } from "@stanley2058/lilac-agent/agent-runtime-support";
import type {
  AiSdkModelCallInput,
  AiSdkModelCallResult,
} from "@stanley2058/lilac-agent/adapters/ai-sdk/model-call";

function reasoningOptions(
  reasoning: AiSdkModelCallInput["reasoning"],
): Pick<Options, "effort" | "thinking"> {
  if (reasoning === "none") return { thinking: { type: "disabled" } };
  if (reasoning === undefined || reasoning === "provider-default") return {};
  return { effort: reasoning === "minimal" ? "low" : reasoning };
}

function systemText(system: AiSdkModelCallInput["system"]): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((part) => part.content).join("\n\n");
  return system?.content ?? "";
}

function attachmentData(
  data:
    | Extract<Exclude<ModelMessage["content"], string>[number], { type: "file" }>["data"]
    | Extract<Exclude<ModelMessage["content"], string>[number], { type: "image" }>["image"],
) {
  if (data instanceof URL) return data.href;
  if (typeof data === "string" || data instanceof Uint8Array || data instanceof ArrayBuffer)
    return data;
  if ("type" in data && data.type === "data") return data.data;
  if ("type" in data && data.type === "url") return data.url.href;
  return undefined;
}

type UserContent = Exclude<SDKUserMessage["message"]["content"], string>;
const claudeToolContentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image"),
      source: z.object({
        type: z.literal("base64"),
        media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        data: z.string(),
      }),
    }),
  ]),
);

function decodeClaudeToolContent(value: unknown): ToolResultOutput | undefined {
  const parsed = claudeToolContentSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    type: "content",
    value: parsed.data.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image-data", data: part.source.data, mediaType: part.source.media_type },
    ),
  };
}

function restoreClaudeToolOutput(output: ToolResultOutput): ToolResultOutput {
  if (output.type !== "text" || !output.value.trimStart().startsWith("[")) return output;
  const decoded = Result.try({ try: () => JSON.parse(output.value), catch: () => undefined }).match(
    { ok: (value) => decodeClaudeToolContent(value), err: () => undefined },
  );
  if (decoded?.type !== "content" || !decoded.value.some((part) => part.type === "image-data"))
    return output;
  return decoded;
}

type HistoricalContentPart = Exclude<UserContent, string>[number];

function attachmentContentPart(
  data: Parameters<typeof attachmentData>[0],
  mediaType: string,
): HistoricalContentPart {
  const source = attachmentData(data);
  if (source === undefined) return { type: "text", text: `[Unavailable attachment: ${mediaType}]` };
  if (typeof source === "string" && /^https?:/u.test(source)) {
    return mediaType.startsWith("image/")
      ? { type: "image", source: { type: "url", url: source } }
      : { type: "text", text: `[Attachment: ${source}]` };
  }
  const base64 =
    typeof source === "string"
      ? source.replace(/^data:[^,]*,/u, "")
      : Buffer.from(source instanceof ArrayBuffer ? new Uint8Array(source) : source).toString(
          "base64",
        );
  if (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp"
  ) {
    return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
  }
  if (mediaType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
    };
  }
  return { type: "text", text: `[Attachment: ${mediaType}]` };
}

function historicalToolResultParts(output: ToolResultOutput): HistoricalContentPart[] {
  const mapped = mapToolResultOutputToMcpResult(restoreClaudeToolOutput(output), false).match({
    ok: (value) => value.content,
    err: (error) => [{ type: "text" as const, text: error.message }],
  });
  return mapped.map((item): HistoricalContentPart => {
    if (item.type === "text") return { type: "text", text: item.text };
    if (
      item.type === "image" &&
      (item.mimeType === "image/png" ||
        item.mimeType === "image/jpeg" ||
        item.mimeType === "image/gif" ||
        item.mimeType === "image/webp")
    ) {
      return {
        type: "image",
        source: { type: "base64", media_type: item.mimeType, data: item.data },
      };
    }
    if (item.type === "resource" && "text" in item.resource) {
      return { type: "text", text: item.resource.text };
    }
    return { type: "text", text: `[Historical attachment: ${item.type}]` };
  });
}

function userContent(messages: readonly ModelMessage[]): UserContent {
  const content: UserContent = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      content.push({
        type: "text",
        text:
          message.role === "user"
            ? message.content
            : `[Historical ${message.role}]\n${message.content}`,
      });
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        content.push({
          type: "text",
          text: message.role === "user" ? part.text : `[Historical ${message.role}]\n${part.text}`,
        });
        continue;
      }
      if (part.type === "reasoning") continue;
      if (part.type === "file" || part.type === "image") {
        content.push(
          attachmentContentPart(
            part.type === "image" ? part.image : part.data,
            part.mediaType ?? "image/png",
          ),
        );
        continue;
      }
      if (part.type === "tool-result") {
        content.push(
          { type: "text", text: `[Historical result from ${part.toolName}, already completed]` },
          ...historicalToolResultParts(part.output),
        );
        continue;
      }
      content.push({
        type: "text",
        text: `[Historical tool activity, already completed]\n${JSON.stringify(part)}`,
      });
    }
  }
  return content.length ? content : [{ type: "text", text: "Continue." }];
}

export async function executeClaudeSdkCall(
  input: AiSdkModelCallInput,
): Promise<AiSdkModelCallResult> {
  const runtime = claudeRuntime(input.model);
  if (!runtime)
    return input.host.failModel(
      new Error("Missing native Claude runtime"),
      "Missing native Claude runtime",
    );
  const {
    queryFactory = query,
    onStreamStart,
    onQueryControllerCreated,
    onSdkMessage,
    streamingInput: _streamingInput,
    ...settings
  } = runtime.settings;
  const prompt = createClaudeInput({
    type: "user",
    message: { role: "user", content: userContent(input.messages) },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
  });
  const abortController = new AbortController();
  const abort = () => abortController.abort(input.abortSignal?.reason);
  if (input.abortSignal?.aborted) abort();
  input.abortSignal?.addEventListener("abort", abort, { once: true });
  let run: ClaudeQuery | undefined;
  const messages: ModelMessage[] = [];
  const assistantPositions = new Map<string, number>();
  let queryOpen = false;
  const tools = new Map<string, string>();
  let draft: AssistantModelMessage & {
    content: Exclude<AssistantModelMessage["content"], string>;
  } = { role: "assistant", content: [] };
  let started = false;
  let blockId = "";
  const blocks = new Map<
    number,
    { id: string; kind: "text" | "thinking" | "tool"; name?: string }
  >();
  let usage: LanguageModelUsage | undefined;
  let finishReason: AiSdkModelCallResult["finishReason"] = "stop";
  const start = () => {
    if (started) return;
    started = true;
    input.host.setStreamMessage(draft);
    input.host.emit({ type: "message_start", message: cloneMessage(draft) });
  };
  const update = (
    event: import("@stanley2058/lilac-agent/agent-runtime-support").AgentAssistantMessageEvent,
  ) => {
    start();
    input.host.setStreamMessage(draft);
    input.host.emit({
      type: "message_update",
      message: cloneMessage(draft),
      assistantMessageEvent: event,
    });
  };
  const receive = async (message: SDKMessage) => {
    await onSdkMessage?.(message);
    if (message.type === "user") {
      if (message.uuid) prompt.acknowledge(message.uuid);
      if (typeof message.message.content === "string") return;
      for (const part of message.message.content) {
        if (part.type !== "tool_result") continue;
        const toolName = tools.get(part.tool_use_id);
        if (!toolName) continue;
        input.host.markProviderTool();
        const normalized = await input.host.normalizeNewToolMessage({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: part.tool_use_id,
              toolName,
              output: (part.is_error ? undefined : decodeClaudeToolContent(part.content)) ?? {
                type: part.is_error ? "error-text" : "text",
                value:
                  typeof part.content === "string"
                    ? part.content
                    : JSON.stringify(part.content ?? []),
              },
            },
          ],
        });
        messages.push(normalized);
        input.host.emit({ type: "message_start", message: normalized });
        input.host.emit({ type: "message_end", message: normalized });
      }
      return;
    }
    if (message.type === "assistant") {
      const content: typeof draft.content = [];
      for (const part of message.message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        if (part.type === "thinking") content.push({ type: "reasoning", text: part.thinking });
        if (part.type === "tool_use") {
          const name = part.name.replace(/^mcp__lilac__/u, "");
          tools.set(part.id, name);
          content.push({
            type: "tool-call",
            toolCallId: part.id,
            toolName: name,
            input: part.input,
            providerExecuted: true,
          });
        }
      }
      const normalized = await input.host.normalizeNewAssistantMessage({
        role: "assistant",
        content,
      });
      if (!started) input.host.emit({ type: "message_start", message: normalized });
      // SDK blocks share an API response ID; canonical history needs one assistant tool batch.
      const position = assistantPositions.get(message.message.id);
      const previous = position === undefined ? undefined : messages[position];
      const merged =
        previous?.role === "assistant" &&
        Array.isArray(previous.content) &&
        Array.isArray(normalized.content)
          ? { ...normalized, content: [...previous.content, ...normalized.content] }
          : normalized;
      if (position === undefined) {
        if (message.message.id) assistantPositions.set(message.message.id, messages.length);
        messages.push(merged);
      } else messages[position] = merged;
      input.host.emit({ type: "message_end", message: normalized });
      input.host.checkpointDraft(merged);
      draft = { role: "assistant", content: [] };
      started = false;
      return;
    }
    if (message.type === "result") {
      if (message.subtype !== "success")
        return input.host.failModel(
          new Error(message.errors.join("\n")),
          "Claude execution failed",
        );
      const native = claudeUsage(message.usage);
      usage = {
        inputTokens: native.inputTokens.total,
        outputTokens: native.outputTokens.total,
        totalTokens: (native.inputTokens.total ?? 0) + (native.outputTokens.total ?? 0),
        inputTokenDetails: {
          noCacheTokens: native.inputTokens.noCache,
          cacheReadTokens: native.inputTokens.cacheRead,
          cacheWriteTokens: native.inputTokens.cacheWrite,
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      };
      finishReason = message.stop_reason === "max_tokens" ? "length" : "stop";
      return;
    }
    if (message.type !== "stream_event") return;
    const event = message.event;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      blockId = `${message.uuid}:${event.index}`;
      if (block.type === "text") {
        blocks.set(event.index, { id: blockId, kind: "text" });
        update({ type: "text_start", id: blockId, raw: { type: "text-start", id: blockId } });
      } else if (block.type === "thinking") {
        blocks.set(event.index, { id: blockId, kind: "thinking" });
        update({
          type: "thinking_start",
          id: blockId,
          raw: { type: "reasoning-start", id: blockId },
        });
      } else if (block.type === "tool_use") {
        const name = block.name.replace(/^mcp__lilac__/u, "");
        blocks.set(event.index, { id: block.id, kind: "tool", name });
        update({
          type: "toolcall_start",
          toolCallId: block.id,
          toolName: name,
          raw: { type: "tool-input-start", id: block.id, toolName: name, providerExecuted: true },
        });
      }
      return;
    }
    if (event.type !== "content_block_delta" && event.type !== "content_block_stop") return;
    const block = blocks.get(event.index);
    if (!block) return;
    const id = block.id;
    if (event.type === "content_block_stop") {
      if (block.kind === "text") update({ type: "text_end", id, raw: { type: "text-end", id } });
      if (block.kind === "thinking")
        update({ type: "thinking_end", id, raw: { type: "reasoning-end", id } });
      if (block.kind === "tool")
        update({ type: "toolcall_end", toolCallId: id, raw: { type: "tool-input-end", id } });
      input.host.checkpointDraft(draft);
      return;
    }
    const delta = event.delta;
    if (delta.type === "text_delta") {
      upsertTextPart(draft.content, "text", delta.text);
      update({
        type: "text_delta",
        id,
        delta: delta.text,
        raw: { type: "text-delta", id, text: delta.text },
      });
    }
    if (delta.type === "thinking_delta") {
      upsertTextPart(draft.content, "reasoning", delta.thinking);
      update({
        type: "thinking_delta",
        id,
        delta: delta.thinking,
        raw: { type: "reasoning-delta", id, text: delta.thinking },
      });
    }
    if (delta.type === "input_json_delta")
      update({
        type: "toolcall_delta",
        toolCallId: id,
        delta: delta.partial_json,
        raw: { type: "tool-input-delta", id, delta: delta.partial_json },
      });
  };
  const result = await Result.tryPromise({
    try: async () => {
      const activeQuery = queryFactory({
        prompt,
        options: {
          ...settings,
          model: runtime.modelId,
          env: { ...process.env, ...settings.env },
          abortController,
          includePartialMessages: true,
          extraArgs: { ...settings.extraArgs, "replay-user-messages": null },
          ...reasoningOptions(input.reasoning),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            excludeDynamicSections: true,
            append: systemText(input.system),
          },
          settings: {
            includeGitInstructions: false,
            attribution: { commit: "", pr: "" },
            autoMemoryEnabled: false,
          },
        },
      });
      run = activeQuery;
      queryOpen = true;
      onStreamStart?.(prompt.injector);
      await onQueryControllerCreated?.({
        rawQuery: activeQuery,
        getContextUsage: () => activeQuery.getContextUsage(),
        interrupt: async () => {
          if (queryOpen) await activeQuery.interrupt();
        },
      });

      for await (const message of activeQuery) {
        await receive(message);
        if (message.type === "result" && !prompt.hasPending()) break;
      }
    },
    catch: (cause): {} | null | undefined => cause,
  });
  queryOpen = false;
  const cleanup = Result.try({
    try: () => run?.close(),
    catch: (cause): {} | null | undefined => cause,
  });
  const delivery = Result.try({
    try: () => prompt.finish(),
    catch: (cause): {} | null | undefined => cause,
  });
  input.abortSignal?.removeEventListener("abort", abort);
  input.host.setStreamMessage(null);
  input.host.clearNormalizedToolCallIds();
  const failure = result.match({ ok: () => null, err: (error) => ({ error }) });
  const cleanupFailure = cleanup.match({ ok: () => null, err: (error) => ({ error }) });
  const deliveryFailure = delivery.match({ ok: () => null, err: (error) => ({ error }) });
  if (failure) rethrowAgentPanic(failure.error);
  if (cleanupFailure) rethrowAgentPanic(cleanupFailure.error);
  if (deliveryFailure) rethrowAgentPanic(deliveryFailure.error);
  if (input.abortSignal?.aborted) return input.host.abortModel(input.host.getAbortReason());
  if (failure) return input.host.failModel(failure.error, "Claude SDK query failed");
  if (cleanupFailure)
    return input.host.failModel(cleanupFailure.error, "Claude SDK cleanup failed");
  if (deliveryFailure)
    return input.host.failModel(deliveryFailure.error, "Claude SDK input delivery failed");
  if (!usage)
    return input.host.failModel(
      new Error("Claude query ended without a result"),
      "Claude query ended without a result",
    );
  return {
    finishReason,
    newMessages: messages,
    toolCalls: [],
    usage,
    totalUsage: usage,
    modelInputMessages: input.messages.map(cloneMessage),
  };
}
