import type { ModelMessage, ToolResultPart } from "ai";
import type { OpaqueAgentValue } from "../../failure-adapters";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import {
  AgentAdapterFailure,
  type AgentPreparedContext,
  type AgentToolDefinition,
  type AgentToolResult,
} from "../../agent-adapter";

const definitionSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  inputSchemaJson: z.string(),
  strict: z.boolean().optional(),
  providerOptions: z.record(z.string(), z.record(z.string(), z.json())).optional(),
  outputSchemaJson: z.string().optional(),
});
const definitionsSchema = z.array(definitionSchema);
const matchesSchema = z.object({ matches: z.array(z.object({ name: z.string() })) });

function invalid(message: string): AgentAdapterFailure {
  return new AgentAdapterFailure({ reason: "protocol", replaySafety: "safe", message });
}

export function readToolLoadingDefinitions(
  options: ModelMessage["providerOptions"],
  key: "toolSearchTools" | "toolSearchSeed",
): ResultType<AgentToolDefinition[] | undefined, AgentAdapterFailure> {
  const value = options?.openai?.[key];
  if (value === undefined) return Result.ok(undefined);
  const parsed = definitionsSchema.safeParse(value);
  if (!parsed.success) return Result.err(invalid("Invalid native tool-loading metadata"));
  return Result.ok(parsed.data);
}

function definitionMetadata(definitions: readonly AgentToolDefinition[]) {
  return definitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchemaJson: tool.inputSchemaJson,
    strict: tool.strict ?? false,
    ...(tool.providerOptions === undefined ? {} : { providerOptions: tool.providerOptions }),
    ...(tool.outputSchemaJson === undefined ? {} : { outputSchemaJson: tool.outputSchemaJson }),
  }));
}

export function prepareToolLoadingContext(
  context: AgentPreparedContext,
): ResultType<AgentPreparedContext, AgentAdapterFailure> {
  const hasCompaction = context.messages.some(
    (message) =>
      message.role === "assistant" &&
      typeof message.content !== "string" &&
      message.content.some((part) => part.type === "custom" && part.kind === "openai.compaction"),
  );
  if (
    hasCompaction ||
    !context.deferredTools?.length ||
    !context.tools.some((tool) => tool.name === "find_tools")
  )
    return Result.ok(context);
  return seedToolLoadingContext({ ...context, nativeToolSearch: true });
}

export function seedToolLoadingContext(
  context: AgentPreparedContext,
): ResultType<AgentPreparedContext, AgentAdapterFailure> {
  return Result.gen(function* () {
    const represented = new Set<string>();
    for (const message of context.messages) {
      const seed = yield* readToolLoadingDefinitions(message.providerOptions, "toolSearchSeed");
      for (const tool of seed ?? []) represented.add(tool.name);
      if (message.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const loaded = yield* readToolLoadingDefinitions(part.providerOptions, "toolSearchTools");
        for (const tool of loaded ?? []) represented.add(tool.name);
      }
    }
    const deferredNames = new Set(context.deferredTools?.map((tool) => tool.name));
    const missing = context.tools.filter(
      (tool) => deferredNames.has(tool.name) && !represented.has(tool.name),
    );
    if (missing.length === 0) return Result.ok(context);
    const previousSeed = yield* readToolLoadingDefinitions(
      context.messages[0]?.providerOptions,
      "toolSearchSeed",
    );
    const seed = definitionMetadata([...(previousSeed ?? []), ...missing]);
    const annotate = (messages: readonly ModelMessage[]): ModelMessage[] =>
      messages.map((message, index) =>
        index === 0
          ? {
              ...message,
              providerOptions: {
                ...message.providerOptions,
                openai: { ...message.providerOptions?.openai, toolSearchSeed: seed },
              },
            }
          : message,
      );
    return Result.ok({
      ...context,
      messages: annotate(context.messages),
      canonicalMessages: annotate(context.canonicalMessages),
    });
  });
}

function searchResultValue(
  output: ToolResultPart["output"],
  outcome?: { readonly result: OpaqueAgentValue; readonly isError: boolean },
): OpaqueAgentValue {
  if (outcome) return outcome.isError ? undefined : outcome.result;
  if (output.type === "json") return output.value;
  return undefined;
}

export function loadSearchResult(
  result: AgentToolResult,
  catalog: readonly AgentToolDefinition[],
  outcome?: { readonly result: OpaqueAgentValue; readonly isError: boolean },
): ResultType<AgentToolResult, AgentAdapterFailure> {
  return Result.gen(function* () {
    const content = [];
    for (const part of result.message.content) {
      if (part.type !== "tool-result") {
        content.push(part);
        continue;
      }
      const definitions: AgentToolDefinition[] = [];
      const searchValue = searchResultValue(part.output, outcome);
      if (searchValue !== undefined) {
        const parsed = matchesSchema.safeParse(searchValue);
        if (!parsed.success) return Result.err(invalid("Invalid tool-search result"));
        for (const match of parsed.data.matches) {
          const tool = catalog.find((entry) => entry.name === match.name);
          if (!tool) return Result.err(invalid("Tool search selected an unavailable definition"));
          definitions.push(tool);
        }
      }
      content.push({
        ...part,
        providerOptions: {
          ...part.providerOptions,
          openai: {
            ...part.providerOptions?.openai,
            toolSearchTools: definitionMetadata(definitions),
          },
        },
      });
    }
    return Result.ok({ ...result, message: { ...result.message, content } });
  });
}

export function supportsNativeToolSearch(
  model: string,
  options: ModelMessage["providerOptions"],
): boolean {
  const settings = options?.openai;
  return (
    /^(gpt-5\.[456](?:-|$)|gpt-6-astra(?:-|$))/.test(model) &&
    !settings?.contextManagement &&
    !settings?.compactionTrigger &&
    !settings?.conversation &&
    !settings?.previousResponseId &&
    !settings?.allowedTools &&
    !settings?.toolChoice
  );
}

function portableOptions(
  options: ModelMessage["providerOptions"],
): ModelMessage["providerOptions"] {
  const openai = options?.openai;
  if (
    !openai ||
    (openai.toolSearchSeed === undefined &&
      openai.toolSearchTools === undefined &&
      openai.toolSearchCall === undefined)
  )
    return options;
  const filtered = Object.fromEntries(
    Object.entries(openai).filter(
      ([key]) =>
        key !== "toolSearchSeed" &&
        key !== "toolSearchTools" &&
        key !== "toolSearchCall" &&
        !(key === "itemId" && openai.toolSearchCall === true),
    ),
  );
  return { ...options, openai: filtered };
}

export function portableToolLoadingMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    const providerOptions = portableOptions(message.providerOptions);
    if (message.role === "assistant" && typeof message.content !== "string")
      return {
        ...message,
        providerOptions,
        content: message.content.map((part) =>
          "providerOptions" in part
            ? { ...part, providerOptions: portableOptions(part.providerOptions) }
            : part,
        ),
      };
    if (message.role === "tool")
      return {
        ...message,
        providerOptions,
        content: message.content.map((part) =>
          part.type === "tool-result"
            ? { ...part, providerOptions: portableOptions(part.providerOptions) }
            : part,
        ),
      };
    return { ...message, providerOptions };
  });
}
