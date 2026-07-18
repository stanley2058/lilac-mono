const TOOL_EXPANSION_BRAND = Symbol("lilac.tool-expansion");

export type ExpandedToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  error?: unknown;
};

export class ToolExpansion {
  readonly [TOOL_EXPANSION_BRAND] = true;

  constructor(
    readonly result: unknown,
    readonly children: readonly ExpandedToolCall[],
  ) {}
}

export function isToolExpansion(value: unknown): value is ToolExpansion {
  return value instanceof ToolExpansion && value[TOOL_EXPANSION_BRAND] === true;
}
