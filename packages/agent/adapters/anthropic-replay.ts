import type { ModelMessage, ToolResultPart } from "ai";

function portableOptions(options: ModelMessage["providerOptions"]) {
  if (!options?.anthropic) return options;
  const { anthropic: _anthropic, ...remaining } = options;
  return remaining;
}

function portableToolResult(part: ToolResultPart): ToolResultPart {
  if (part.output.type !== "content")
    return {
      ...part,
      providerOptions: portableOptions(part.providerOptions),
      output: { ...part.output, providerOptions: portableOptions(part.output.providerOptions) },
    };
  return {
    ...part,
    providerOptions: portableOptions(part.providerOptions),
    output: {
      type: "content",
      value: part.output.value
        .filter((item) => !(item.type === "custom" && item.providerOptions?.anthropic))
        .map((item) => ({ ...item, providerOptions: portableOptions(item.providerOptions) })),
    },
  };
}

// Anthropic replay blocks are meaningful only to Anthropic. Keep canonical history intact.
export function withoutAnthropicReplay(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    const providerOptions = portableOptions(message.providerOptions);
    if (message.role === "system" || typeof message.content === "string")
      return [{ ...message, providerOptions }];
    if (message.role === "tool")
      return [
        {
          ...message,
          providerOptions,
          content: message.content.map((part) =>
            part.type === "tool-result" ? portableToolResult(part) : part,
          ),
        },
      ];
    if (message.role === "assistant") {
      const content = message.content
        .filter((part) => !(part.type === "custom" && part.kind.startsWith("anthropic.")))
        .map((part) => {
          if (part.type === "tool-result") return portableToolResult(part);
          if (!("providerOptions" in part)) return part;
          return { ...part, providerOptions: portableOptions(part.providerOptions) };
        });
      return content.length || providerOptions?.openai?.toolSearchSeed
        ? [{ ...message, providerOptions, content }]
        : [];
    }
    return [
      {
        ...message,
        providerOptions,
        content: message.content.map((part) => ({
          ...part,
          providerOptions: portableOptions(part.providerOptions),
        })),
      },
    ];
  });
}
