import path from "node:path";

import {
  buildSyntheticToolCallId,
  ToolExpansion,
  type ExpandedToolCall,
} from "@stanley2058/lilac-agent";
import { expandTilde } from "@stanley2058/lilac-fs";
import { asSchema, jsonSchema, tool, type FlexibleSchema, type ToolSet } from "ai";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { parsePatchResult } from "./apply-patch";
import { validateLocalCwd } from "./guardrails";
import { adaptCodingToolResultToHost } from "./host-compatibility";

const MAX_BATCH_CALLS = 8;

export const batchCallSchema = z.object({
  tool: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional().default({}),
});

export const batchInputSchema = z.object({
  tool_calls: z.array(batchCallSchema).min(1).max(MAX_BATCH_CALLS),
});

export type BatchCall = z.infer<typeof batchCallSchema>;
export type BatchInput = z.infer<typeof batchInputSchema>;

export class BatchRejected extends TaggedError("BatchRejected")<{
  readonly message: string;
}> {}

export class BatchChildValidationFailed extends TaggedError("BatchChildValidationFailed")<{
  readonly message: string;
}> {}

export interface BatchToolSpec<TInput = unknown> {
  readonly name: string;
  readonly supportsBatch?: boolean;
  readonly editTargets?: (
    input: TInput,
    context: { cwd: string },
  ) => Iterable<string> | Promise<Iterable<string>>;
}

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

const batchEditInputProjectionSchema = z.object({
  cwd: z.string().optional(),
  patchText: z.string().optional(),
  path: z.string().optional(),
});

type CapturedBatchExternal<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "failure"; readonly message: string }
  | { readonly kind: "panic"; readonly panic: Panic };

function captureBatchExternal<T>(
  effect: () => T | PromiseLike<T>,
  fallbackMessage: string,
): Promise<CapturedBatchExternal<T>> {
  return Result.tryPromise({
    try: async () => await effect(),
    catch: (cause) => {
      return () => {
        const inspectedPanic = Result.try({
          try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
          catch: () => undefined,
        });
        const panic = inspectedPanic.match({ ok: (value) => value, err: () => undefined });
        if (panic) return { kind: "panic" as const, panic };
        switch (typeof cause) {
          case "string":
            return { kind: "failure" as const, message: cause };
          case "bigint":
          case "boolean":
          case "number":
          case "symbol":
          case "undefined":
            return { kind: "failure" as const, message: String(cause) };
          case "function":
          case "object":
            return Result.try({
              try: () => (cause instanceof Error ? cause.message : fallbackMessage),
              catch: () => fallbackMessage,
            }).match({
              ok: (message) => ({ kind: "failure" as const, message }),
              err: () => ({ kind: "failure" as const, message: fallbackMessage }),
            });
        }
      };
    },
  }).then((captured) =>
    captured
      .mapError((settle) => settle())
      .match<CapturedBatchExternal<T>>({
        ok: (value) => ({ kind: "completed", value }),
        err: (failure) => failure,
      }),
  );
}

function decodeBatchEditInput(
  child: ExpandedToolCall,
): z.output<typeof batchEditInputProjectionSchema> {
  const projected = batchEditInputProjectionSchema.safeParse(child.input);
  return projected.success ? projected.data : {};
}

async function resolveBatchEditTargets<TToolSpec extends BatchToolSpec>(params: {
  spec: TToolSpec;
  child: ExpandedToolCall;
  cwd: string;
  resolveEditTargets?: (
    spec: TToolSpec,
    input: unknown,
    context: { cwd: string },
  ) => Promise<Iterable<string>>;
}): Promise<ResultType<Iterable<string>, BatchChildValidationFailed>> {
  const resolved = await captureBatchExternal(
    () =>
      params.resolveEditTargets
        ? params.resolveEditTargets(params.spec, params.child.input, { cwd: params.cwd })
        : params.spec.editTargets!(params.child.input, { cwd: params.cwd }),
    "Batch edit-target resolution failed",
  );
  if (resolved.kind === "panic") throw resolved.panic;
  if (resolved.kind === "failure") {
    return Result.err(new BatchChildValidationFailed({ message: resolved.message }));
  }
  return Result.ok(resolved.value);
}

async function validateInput(
  toolSchema: FlexibleSchema<unknown> | undefined,
  input: unknown,
  child: ExpandedToolCall,
): Promise<ResultType<ExpandedToolCall, BatchChildValidationFailed>> {
  const schema = asSchema(toolSchema);
  const captured = await captureBatchExternal(
    () => schema.validate?.(input),
    "Batch child input validation failed",
  );
  if (captured.kind === "panic") throw captured.panic;
  if (captured.kind === "failure") {
    return Result.err(new BatchChildValidationFailed({ message: captured.message }));
  }
  const validation = captured.value;
  if (!validation) return Result.ok(child);
  if (!validation.success) {
    return Result.err(new BatchChildValidationFailed({ message: validation.error.message }));
  }
  return Result.ok({ ...child, input: validation.value });
}

function defaultPathKey(cwd: string, targetPath: string): string {
  const base = path.resolve(expandTilde(cwd));
  const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(base, targetPath);
  return `file://${path.resolve(resolved)}`;
}

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

export function collectApplyPatchTouchedPathsResult(params: {
  patchText: string;
  cwd: string;
  resolvePathKey?: (cwd: string, targetPath: string) => string;
}): ResultType<Set<string>, BatchRejected> {
  const resolvePathKey = params.resolvePathKey ?? defaultPathKey;
  if (!params.resolvePathKey) {
    const cwd = resultOutcome(validateLocalCwd(params.cwd));
    if (!cwd.ok) return Result.err(new BatchRejected({ message: cwd.error.message }));
  }
  const parsed = resultOutcome(parsePatchResult(params.patchText));
  if (!parsed.ok) return Result.err(new BatchRejected({ message: parsed.error.message }));
  const touched = new Set<string>();
  for (const hunk of parsed.value) {
    touched.add(resolvePathKey(params.cwd, hunk.path));
    if (hunk.type === "update" && hunk.movePath) {
      touched.add(resolvePathKey(params.cwd, hunk.movePath));
    }
  }
  return Result.ok(touched);
}

export function collectApplyPatchTouchedPaths(params: {
  patchText: string;
  cwd: string;
  resolvePathKey?: (cwd: string, targetPath: string) => string;
}): Set<string> {
  return adaptCodingToolResultToHost(collectApplyPatchTouchedPathsResult(params));
}

export function collectEditFileTouchedPathsResult(params: {
  path: string;
  cwd: string;
  resolvePathKey?: (cwd: string, targetPath: string) => string;
}): ResultType<Set<string>, BatchRejected> {
  if (!params.resolvePathKey) {
    const cwd = resultOutcome(validateLocalCwd(params.cwd));
    if (!cwd.ok) return Result.err(new BatchRejected({ message: cwd.error.message }));
    return Result.ok(new Set([defaultPathKey(params.cwd, params.path)]));
  }
  return Result.ok(new Set([params.resolvePathKey(params.cwd, params.path)]));
}

export function collectEditFileTouchedPaths(params: {
  path: string;
  cwd: string;
  resolvePathKey?: (cwd: string, targetPath: string) => string;
}): Set<string> {
  return adaptCodingToolResultToHost(collectEditFileTouchedPathsResult(params));
}

function toolSetLookup(
  tools: ToolSet,
  name: string,
): { inputSchema: FlexibleSchema<unknown> | undefined } | undefined {
  const candidate = tools[name];
  if (!candidate || typeof candidate !== "object") return undefined;
  return { inputSchema: candidate.inputSchema };
}

function enabledToolNames(
  tools: ToolSet,
  specs?: ReadonlyMap<string, BatchToolSpec>,
): ResultType<[string, ...string[]], BatchRejected> {
  const names = specs?.size
    ? [...specs.entries()]
        .filter(([name, spec]) => name !== "batch" && spec.supportsBatch !== false)
        .map(([name]) => name)
    : Object.keys(tools).filter((name) => name !== "batch");
  if (names.length === 0) {
    return Result.err(
      new BatchRejected({
        message: "batch requires at least one enabled Level-1 tool that has not opted out",
      }),
    );
  }
  return Result.ok([names[0]!, ...names.slice(1)]);
}

export function createBatchToolResult<TToolSpec extends BatchToolSpec = BatchToolSpec>(params: {
  cwd: string;
  getTools: () => ToolSet;
  getToolSpecs?: () => ReadonlyMap<string, TToolSpec>;
  resolveEditTargets?: (
    spec: TToolSpec,
    input: unknown,
    context: { cwd: string },
  ) => Promise<Iterable<string>>;
  editingMode?: "apply_patch" | "edit_file" | "none";
  maxCalls?: number;
  resolvePathKey?: (cwd: string, targetPath: string) => string;
  errorFormatters?: BatchErrorFormatters;
}): ResultType<ToolSet, BatchRejected> {
  {
    const maxCalls = Math.min(params.maxCalls ?? MAX_BATCH_CALLS, MAX_BATCH_CALLS);
    const specs = params.getToolSpecs?.();
    const enabledNames = resultOutcome(enabledToolNames(params.getTools(), specs));
    if (!enabledNames.ok) return Result.err(enabledNames.error);
    const allowedNames = enabledNames.value;
    const allowedNameSet = new Set(allowedNames);
    const normalizeBatchToolName = (name: string): string => {
      if (allowedNameSet.has(name)) return name;
      switch (name) {
        case "read_file":
          return allowedNameSet.has("read") ? "read" : name;
        case "edit_file":
          return allowedNameSet.has("edit") ? "edit" : name;
        case "apply_patch":
          return allowedNameSet.has("patch") ? "patch" : name;
        default:
          return name;
      }
    };
    const runtimeInputSchema = z.object({
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
    const inputSchema = jsonSchema<z.output<typeof runtimeInputSchema>>(
      {
        type: "object",
        properties: {
          tool_calls: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", enum: allowedNames },
                parameters: {},
              },
              required: ["tool"],
              additionalProperties: false,
            },
            minItems: 1,
            maxItems: maxCalls,
          },
        },
        required: ["tool_calls"],
        additionalProperties: false,
      },
      {
        validate: asSchema(runtimeInputSchema).validate,
      },
    );

    async function executeBatch(
      input: z.output<typeof runtimeInputSchema>,
      toolCallId: string,
    ): Promise<ResultType<ToolExpansion, BatchRejected>> {
      if (input.tool_calls.length > maxCalls) {
        return Result.err(
          new BatchRejected({ message: `Batch accepts at most ${maxCalls} tool calls.` }),
        );
      }
      const calls = input.tool_calls.map((call) => ({
        ...call,
        tool: normalizeBatchToolName(call.tool),
      }));
      const tools = params.getTools();
      const children = await Promise.all(
        calls.map(async (call, index): Promise<ExpandedToolCall> => {
          const child = {
            toolCallId: buildSyntheticToolCallId({
              prefix: "batch_child",
              seed: `${toolCallId}:${index + 1}:${call.tool}`,
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
          const validated = await validateInput(childTool.inputSchema, call.parameters, child);
          return validated.match({
            err: (error) => {
              const message = params.errorFormatters?.childValidation
                ? params.errorFormatters.childValidation({
                    childIndex: index + 1,
                    toolName: call.tool,
                    parameters: call.parameters,
                    error,
                  })
                : `batch child #${index + 1} (${call.tool}) input validation failed: ${error.message}`;
              return { ...child, invalid: true, error: message };
            },
            ok: (value) => value,
          });
        }),
      );

      const pathOwners = new Map<string, number>();
      const conflicts: string[] = [];
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        if (child.invalid) continue;
        const call = calls[index]!;
        const spec = specs?.get(call.tool);
        let activeEditTool: "patch" | "edit" | undefined;
        if (params.editingMode === "apply_patch") activeEditTool = "patch";
        if (params.editingMode === "edit_file") activeEditTool = "edit";
        const isAdapterlessBuiltinEdit = !specs && (call.tool === "patch" || call.tool === "edit");
        if (!spec?.editTargets && call.tool !== activeEditTool && !isAdapterlessBuiltinEdit)
          continue;
        const record = decodeBatchEditInput(child);
        const cwd = record.cwd ?? params.cwd;

        let touched: Iterable<string>;
        if (spec?.editTargets) {
          const resolved = resultOutcome(
            await resolveBatchEditTargets({
              spec,
              child,
              cwd,
              resolveEditTargets: params.resolveEditTargets,
            }),
          );
          if (!resolved.ok) {
            return Result.err(
              new BatchRejected({
                message: `batch rejected: could not resolve edit targets for child #${index + 1} (${call.tool}): ${resolved.error.message}`,
              }),
            );
          }
          touched = resolved.value;
        } else if (call.tool === "patch") {
          const patchText = record.patchText;
          if (patchText === undefined) {
            const message = params.errorFormatters?.missingEditField?.({
              childIndex: index + 1,
              toolName: call.tool,
              field: "patchText",
              expectedType: "string",
              parameters: call.parameters,
            });
            return Result.err(
              new BatchRejected({
                message: message ?? "batch patch preflight requires string patchText",
              }),
            );
          }
          const collected = resultOutcome(
            collectApplyPatchTouchedPathsResult({
              patchText,
              cwd,
              resolvePathKey: params.resolvePathKey,
            }),
          );
          if (!collected.ok) return Result.err(collected.error);
          touched = collected.value;
        } else {
          const editPath = record.path;
          if (editPath === undefined) {
            const message = params.errorFormatters?.missingEditField?.({
              childIndex: index + 1,
              toolName: call.tool,
              field: "path",
              expectedType: "string",
              parameters: call.parameters,
            });
            return Result.err(
              new BatchRejected({
                message: message ?? "batch edit preflight requires string path",
              }),
            );
          }
          const collected = resultOutcome(
            collectEditFileTouchedPathsResult({
              path: editPath,
              cwd,
              resolvePathKey: params.resolvePathKey,
            }),
          );
          if (!collected.ok) return Result.err(collected.error);
          touched = collected.value;
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
        return Result.err(
          new BatchRejected({
            message: [
              "batch rejected: edit calls touch overlapping paths:",
              ...lines,
              "Tip: combine edits into a single edit call per file.",
            ].join("\n"),
          }),
        );
      }

      return Result.ok(
        new ToolExpansion(
          {
            ok: true,
            total: children.length,
            children: children.map((child) => ({
              toolCallId: child.toolCallId,
              tool: child.toolName,
            })),
          },
          children,
        ),
      );
    }

    return Result.ok({
      batch: tool({
        description: [
          "Expand multiple independent operations into ordinary tool calls that execute after this batch call.",
          "Supports every enabled Level-1 tool except batch; tools may explicitly opt out of batching.",
          "Each child keeps its own normal tool result and identity; transports may return them as one ordered aggregate.",
          "Notes:",
          "- Child calls use the same parallel scheduler as provider-emitted tool calls.",
          "- Child failures do not stop sibling calls or change the accepted batch result.",
          "- Every child call must include all required parameters for its tool.",
          "- Do not emit empty parameters objects for tools with required fields.",
          "- If multiple edit calls with declared edit targets touch the same file path, the entire batch is rejected.",
          'Bad example: {"tool_calls":[{"tool":"read","parameters":{}},{"tool":"bash","parameters":{}}]}',
          'Good example: {"tool_calls":[{"tool":"read","parameters":{"path":"src/index.ts"}},{"tool":"bash","parameters":{"command":"bun test"}}]}',
        ].join("\n"),
        inputSchema,
        execute: async (input, options) => {
          const executed = await executeBatch(input, options.toolCallId);
          return adaptCodingToolResultToHost(executed);
        },
      }),
    });
  }
}
