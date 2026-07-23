import path from "node:path";

import {
  buildSyntheticToolCallId,
  ToolExpansion,
  type ExpandedToolCall,
} from "@stanley2058/lilac-agent";
import { expandTilde } from "@stanley2058/lilac-fs";
import { asSchema, tool, type FlexibleSchema, type ToolSet } from "ai";
import { z } from "zod";

import { parsePatch } from "./apply-patch";
import { assertLocalCwd } from "./guardrails";

export const MAX_BATCH_CALLS = 8;

export const batchCallSchema = z.object({
  tool: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional().default({}),
});

export const batchInputSchema = z.object({
  tool_calls: z.array(batchCallSchema).min(1).max(MAX_BATCH_CALLS),
});

export type BatchCall = z.infer<typeof batchCallSchema>;
export type BatchInput = z.infer<typeof batchInputSchema>;

export type BatchToolSpec = {
  name: string;
  supportsBatch?: boolean;
  editTargets?: (
    input: unknown,
    context: { cwd: string },
  ) => Iterable<string> | Promise<Iterable<string>>;
};

type BatchErrorFormatters = {
  childValidation?: (params: {
    childIndex: number;
    toolName: string;
    parameters: Readonly<Record<string, unknown>>;
    error: unknown;
  }) => string;
  missingEditField?: (params: {
    childIndex: number;
    toolName: string;
    field: string;
    expectedType: string;
    parameters: Readonly<Record<string, unknown>>;
  }) => string;
};

function hasParseAsync(
  schema: unknown,
): schema is { parseAsync(value: unknown): Promise<unknown> } {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "parseAsync" in schema &&
    typeof schema.parseAsync === "function"
  );
}

function hasParse(schema: unknown): schema is { parse(value: unknown): unknown } {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "parse" in schema &&
    typeof schema.parse === "function"
  );
}

async function validateInput(toolSchema: unknown, input: unknown): Promise<unknown> {
  if (hasParseAsync(toolSchema)) return toolSchema.parseAsync(input);
  if (hasParse(toolSchema)) return toolSchema.parse(input);
  const schema = asSchema(toolSchema as FlexibleSchema<unknown> | undefined);
  const validation = await schema.validate?.(input);
  if (!validation) return input;
  if (!validation.success) throw validation.error;
  return validation.value;
}

function defaultPathKey(cwd: string, targetPath: string): string {
  assertLocalCwd(cwd);
  const base = path.resolve(expandTilde(cwd));
  const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(base, targetPath);
  return `file://${path.resolve(resolved)}`;
}

export function collectApplyPatchTouchedPaths(params: {
  patchText: string;
  cwd: string;
  resolvePathKey?: (cwd: string, targetPath: string) => string;
}): Set<string> {
  const resolvePathKey = params.resolvePathKey ?? defaultPathKey;
  const touched = new Set<string>();
  for (const hunk of parsePatch(params.patchText)) {
    touched.add(resolvePathKey(params.cwd, hunk.path));
    if (hunk.type === "update" && hunk.movePath) {
      touched.add(resolvePathKey(params.cwd, hunk.movePath));
    }
  }
  return touched;
}

export function collectEditFileTouchedPaths(params: {
  path: string;
  cwd: string;
  resolvePathKey?: (cwd: string, targetPath: string) => string;
}): Set<string> {
  return new Set([(params.resolvePathKey ?? defaultPathKey)(params.cwd, params.path)]);
}

function toolSetLookup(tools: ToolSet, name: string): { inputSchema?: unknown } | undefined {
  const candidate = tools[name];
  return candidate && typeof candidate === "object" ? candidate : undefined;
}

function enabledToolNames(
  tools: ToolSet,
  specs?: ReadonlyMap<string, BatchToolSpec>,
): [string, ...string[]] {
  const names = specs?.size
    ? [...specs.values()]
        .filter((spec) => spec.name !== "batch" && spec.supportsBatch !== false)
        .map((spec) => spec.name)
    : Object.keys(tools).filter((name) => name !== "batch");
  if (names.length === 0) {
    throw new Error("batch requires at least one enabled Level-1 tool that has not opted out");
  }
  return [names[0]!, ...names.slice(1)];
}

export function createBatchTool(params: {
  cwd: string;
  getTools: () => ToolSet;
  getToolSpecs?: () => ReadonlyMap<string, BatchToolSpec>;
  editingMode?: "apply_patch" | "edit_file" | "none";
  maxCalls?: number;
  resolvePathKey?: (cwd: string, targetPath: string) => string;
  errorFormatters?: BatchErrorFormatters;
}): ToolSet {
  const maxCalls = Math.min(params.maxCalls ?? MAX_BATCH_CALLS, MAX_BATCH_CALLS);
  const specs = params.getToolSpecs?.();
  const allowedNames = enabledToolNames(params.getTools(), specs);
  const allowedNameSet = new Set(allowedNames);
  const inputSchema = z.object({
    tool_calls: z
      .array(
        z.object({
          tool: z.enum(allowedNames),
          parameters: z.record(z.string(), z.unknown()).optional().default({}),
        }),
      )
      .min(1)
      .max(maxCalls),
  });

  return {
    batch: tool({
      description: [
        "Expand multiple independent operations into ordinary tool calls that execute after this batch call.",
        "Supports every enabled Level-1 tool except batch; tools may explicitly opt out of batching.",
        "The batch result only confirms expansion. Each child returns its own normal tool result.",
        "Notes:",
        "- Child calls use the same parallel scheduler as provider-emitted tool calls.",
        "- Child failures do not stop sibling calls or change the accepted batch result.",
        "- Every child call must include all required parameters for its tool.",
        "- Do not emit empty parameters objects for tools with required fields.",
        "- If multiple edit calls with declared edit targets touch the same file path, the entire batch is rejected.",
        'Bad example: {"tool_calls":[{"tool":"read_file","parameters":{}},{"tool":"bash","parameters":{}}]}',
        'Good example: {"tool_calls":[{"tool":"read_file","parameters":{"path":"src/index.ts"}},{"tool":"bash","parameters":{"command":"bun test"}}]}',
      ].join("\n"),
      inputSchema,
      execute: async (input, options) => {
        if (input.tool_calls.length > maxCalls) {
          throw new Error(`Batch accepts at most ${maxCalls} tool calls.`);
        }
        const tools = params.getTools();
        const children = await Promise.all(
          input.tool_calls.map(async (call, index): Promise<ExpandedToolCall> => {
            const child = {
              toolCallId: buildSyntheticToolCallId({
                prefix: "batch_child",
                seed: `${options.toolCallId}:${index + 1}:${call.tool}`,
              }),
              toolName: call.tool,
              input: call.parameters,
            };
            const childTool = allowedNameSet.has(call.tool)
              ? toolSetLookup(tools, call.tool)
              : undefined;
            if (!childTool) {
              return { ...child, invalid: true, error: `Tool not available: ${call.tool}` };
            }
            try {
              return {
                ...child,
                input: await validateInput(childTool.inputSchema, call.parameters),
              };
            } catch (error: unknown) {
              const message = params.errorFormatters?.childValidation
                ? params.errorFormatters.childValidation({
                    childIndex: index + 1,
                    toolName: call.tool,
                    parameters: call.parameters,
                    error,
                  })
                : `batch child #${index + 1} (${call.tool}) input validation failed: ${error instanceof Error ? error.message : String(error)}`;
              return { ...child, invalid: true, error: message };
            }
          }),
        );

        const pathOwners = new Map<string, number>();
        const conflicts: string[] = [];
        for (let index = 0; index < children.length; index++) {
          const child = children[index]!;
          if (child.invalid) continue;
          const call = input.tool_calls[index]!;
          const spec = specs?.get(call.tool);
          const activeEditTool = params.editingMode === "none" ? undefined : params.editingMode;
          const isAdapterlessBuiltinEdit =
            !specs && (call.tool === "apply_patch" || call.tool === "edit_file");
          if (!spec?.editTargets && call.tool !== activeEditTool && !isAdapterlessBuiltinEdit)
            continue;
          const record =
            child.input && typeof child.input === "object" && !Array.isArray(child.input)
              ? (child.input as Record<string, unknown>)
              : {};
          const cwd = typeof record["cwd"] === "string" ? record["cwd"] : params.cwd;

          let touched: Iterable<string>;
          if (spec?.editTargets) {
            try {
              touched = await spec.editTargets(child.input, { cwd });
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(
                `batch rejected: could not resolve edit targets for child #${index + 1} (${call.tool}): ${message}`,
              );
            }
          } else if (call.tool === "apply_patch") {
            const patchText = record["patchText"];
            if (typeof patchText !== "string") {
              const message = params.errorFormatters?.missingEditField?.({
                childIndex: index + 1,
                toolName: call.tool,
                field: "patchText",
                expectedType: "string",
                parameters: record,
              });
              throw new Error(message ?? "batch apply_patch preflight requires string patchText");
            }
            touched = collectApplyPatchTouchedPaths({
              patchText,
              cwd,
              resolvePathKey: params.resolvePathKey,
            });
          } else {
            const editPath = record["path"];
            if (typeof editPath !== "string") {
              const message = params.errorFormatters?.missingEditField?.({
                childIndex: index + 1,
                toolName: call.tool,
                field: "path",
                expectedType: "string",
                parameters: record,
              });
              throw new Error(message ?? "batch edit_file preflight requires string path");
            }
            touched = collectEditFileTouchedPaths({
              path: editPath,
              cwd,
              resolvePathKey: params.resolvePathKey,
            });
          }

          for (const touchedPath of touched) {
            const owner = pathOwners.get(touchedPath);
            if (owner !== undefined && owner !== index) conflicts.push(touchedPath);
            else pathOwners.set(touchedPath, index);
          }
        }
        if (conflicts.length > 0) {
          const unique = [...new Set(conflicts)].slice(0, 25);
          const remaining = conflicts.length - unique.length;
          const lines = unique.map((entry) => `- ${entry}`);
          if (remaining > 0) lines.push(`- ... and ${remaining} more`);
          throw new Error(
            [
              "batch rejected: edit calls touch overlapping paths:",
              ...lines,
              "Tip: combine edits into a single edit call per file.",
            ].join("\n"),
          );
        }

        return new ToolExpansion(
          {
            ok: true,
            total: children.length,
            children: children.map((child) => ({
              toolCallId: child.toolCallId,
              tool: child.toolName,
            })),
          },
          children,
        );
      },
    }),
  };
}
