import type { LanguageModel, ModelMessage, ToolResultPart, ToolSet } from "ai";
import { z } from "zod";
import type { OpaqueAgentValue } from "../../failure-adapters";
import type { ProjectSettledToolResult } from "../../agent-execution-host";

const searchResult = z.object({ matches: z.array(z.object({ name: z.string() })) });
const referenceNames = z.array(z.string());

function supportsToolSearch(model: LanguageModel): boolean {
  if (typeof model === "string" || !model.provider?.startsWith("anthropic.")) return false;
  return /^claude-(?:(?:opus|sonnet|haiku)-(?:4-[5-9]|[5-9](?:-|$))|(?:fable|mythos)-5)/.test(
    model.modelId,
  );
}

function matchedNames(value: OpaqueAgentValue, deferred: ToolSet): string[] {
  const parsed = searchResult.safeParse(value);
  if (!parsed.success) return [];
  return [...new Set(parsed.data.matches.map((match) => match.name))].filter(
    (name) => name !== "find_tools" && Object.hasOwn(deferred, name),
  );
}

function retainedNames(part: ToolResultPart, deferred: ToolSet): string[] {
  if (part.toolName !== "find_tools") return [];
  const retained = referenceNames.safeParse(part.providerOptions?.anthropic?.toolSearchReferences);
  if (retained.success) return retained.data.filter((name) => Object.hasOwn(deferred, name));
  return part.output.type === "json" ? matchedNames(part.output.value, deferred) : [];
}

function retainSearchResult(
  part: ToolResultPart,
  outcome: { readonly result: OpaqueAgentValue; readonly isError: boolean },
  deferred: ToolSet,
): ToolResultPart {
  if (part.toolName !== "find_tools" || outcome.isError) return part;
  const names = matchedNames(outcome.result, deferred);
  return {
    ...part,
    providerOptions: {
      ...part.providerOptions,
      anthropic: { ...part.providerOptions?.anthropic, toolSearchReferences: names },
    },
  };
}

function referenceSearchResult(part: ToolResultPart, names: string[]): ToolResultPart {
  if (names.length === 0) return part;
  const output = part.output;
  if (output.type !== "json" && output.type !== "text" && output.type !== "content") return part;
  return {
    ...part,
    output: {
      type: "content",
      // Anthropic expands these into tool definitions and rejects mixed content.
      value: names.map((toolName) => ({
        type: "custom" as const,
        providerOptions: { anthropic: { type: "tool-reference", toolName } },
      })),
    },
  };
}

function seedSelection(names: string[]): ModelMessage[] {
  if (names.length === 0) return [];
  const toolCallId = `lilac_tool_search_${crypto.randomUUID()}`;
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "find_tools",
          input: { query: `select:${names.join(",")}` },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "find_tools",
          output: { type: "json", value: { matches: names.map((name) => ({ name })) } },
          providerOptions: { anthropic: { toolSearchReferences: names } },
        },
      ],
    },
  ];
}

type ToolSearchContext = {
  model: LanguageModel;
  messages: ModelMessage[];
  tools: ToolSet;
  deferredTools?: ToolSet;
};

function retainLegacyReferences(message: ModelMessage, deferred: ToolSet): ModelMessage {
  if (message.role !== "tool") return message;
  const content = message.content.map((part) => {
    if (
      part.type !== "tool-result" ||
      part.toolName !== "find_tools" ||
      part.output.type !== "json" ||
      part.providerOptions?.anthropic?.toolSearchReferences !== undefined
    )
      return part;
    return retainSearchResult(part, { result: part.output.value, isError: false }, deferred);
  });
  return content.some((part, index) => part !== message.content[index])
    ? { ...message, content }
    : message;
}

export function seedAnthropicToolSearch(input: ToolSearchContext): ModelMessage[] {
  const deferred = input.deferredTools;
  if (!supportsToolSearch(input.model) || !input.tools.find_tools || !deferred)
    return input.messages;
  const messages = input.messages.map((message) => retainLegacyReferences(message, deferred));
  const canonicalMessages = messages.some((message, index) => message !== input.messages[index])
    ? messages
    : input.messages;
  const represented = new Set<string>();
  for (const message of canonicalMessages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      for (const name of retainedNames(part, deferred)) represented.add(name);
    }
  }
  const missing = Object.keys(input.tools)
    .filter(
      (name) => name !== "find_tools" && Object.hasOwn(deferred, name) && !represented.has(name),
    )
    .sort();
  if (missing.length === 0) return canonicalMessages;
  // Append after the existing prefix and retain the exchange in canonical history,
  // so later signed steps replay the restored selection at the same position.
  return [...canonicalMessages, ...seedSelection(missing)];
}

export function prepareAnthropicToolSearch(input: ToolSearchContext): {
  messages: ModelMessage[];
  tools: ToolSet;
  projectResult?: ProjectSettledToolResult;
} {
  const deferred = input.deferredTools;
  if (!supportsToolSearch(input.model) || !input.tools.find_tools || !deferred) return input;
  // Keep catalog declarations deferred after discovery too: changing this flag changes
  // the prefix to which Anthropic binds signed thinking.
  const tools: ToolSet = Object.fromEntries(
    Object.entries(input.tools).filter(
      ([name]) => name === "find_tools" || !Object.hasOwn(deferred, name),
    ),
  );
  for (const [name, definition] of Object.entries(deferred).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (name === "find_tools") continue;
    tools[name] = {
      ...definition,
      providerOptions: {
        ...definition.providerOptions,
        anthropic: { ...definition.providerOptions?.anthropic, deferLoading: true },
      },
    };
  }
  const projectMessage = (message: ModelMessage): ModelMessage => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const names = retainedNames(part, deferred);
        return referenceSearchResult(part, names);
      }),
    };
  };
  const messages = input.messages.map(projectMessage);
  return {
    tools,
    messages,
    projectResult: (part, outcome) => retainSearchResult(part, outcome, deferred),
  };
}
