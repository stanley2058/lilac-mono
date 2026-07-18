import path from "node:path";

import { asSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import { buildSyntheticToolCallId, ToolExpansion } from "@stanley2058/lilac-agent";
import type { EditingToolMode } from "@stanley2058/lilac-utils";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";
import { expandTilde } from "@stanley2058/lilac-fs";
import { parsePatch } from "./apply-patch/apply-patch-core";
import {
  formatBatchChildValidationError,
  formatBatchPreflightMissingFieldError,
} from "./batch-error-message";

import { parseSshCwdTarget } from "../ssh/ssh-cwd";

const ALLOWED_TOOL_NAMES_BY_MODE = {
  apply_patch: ["read_file", "glob", "grep", "bash", "apply_patch"],
  edit_file: ["read_file", "glob", "grep", "bash", "edit_file"],
  none: ["read_file", "glob", "grep", "bash"],
} as const;

const ABSOLUTE_MAX_CALLS = 8;

function makeToolCallSchema(allowedToolNames: readonly [string, ...string[]]) {
  return z.object({
    tool: z.enum(allowedToolNames).describe("Tool name to execute"),
    parameters: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .describe("Tool arguments (object)"),
  });
}

function makeBatchInputSchema(allowedToolNames: readonly [string, ...string[]], maxCalls: number) {
  return z.object({
    tool_calls: z
      .array(makeToolCallSchema(allowedToolNames))
      .min(1)
      .max(maxCalls)
      .describe("Array of tool calls to execute in parallel"),
  });
}

type ToolLike = {
  inputSchema?: unknown;
};

function hasParseAsync(schema: unknown): schema is {
  parseAsync: (value: unknown) => Promise<unknown>;
} {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "parseAsync" in schema &&
    typeof schema.parseAsync === "function"
  );
}

function hasParse(schema: unknown): schema is { parse: (value: unknown) => unknown } {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "parse" in schema &&
    typeof schema.parse === "function"
  );
}

function resolveAgainstCwd(cwd: string, p: string): string {
  const base = path.resolve(expandTilde(cwd));
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

function normalizeRemotePath(base: string, p: string): string {
  const input = p.trim();
  if (input.length === 0) return base;

  if (input.startsWith("/")) {
    return path.posix.normalize(input);
  }

  if (input === "~") return "~";
  if (input.startsWith("~/")) {
    const rel = input.slice(2);
    const normalized = path.posix.normalize(rel);
    return normalized === "." ? "~" : `~/${normalized.replace(/^\.\//, "")}`;
  }

  if (base.startsWith("/")) {
    return path.posix.normalize(path.posix.resolve(base, input));
  }

  // base is "~" or "~/..." (pseudo-root); resolve without losing the tilde.
  const baseSegs =
    base === "~"
      ? []
      : base.startsWith("~/")
        ? base
            .slice(2)
            .split("/")
            .filter((s) => s.length > 0)
        : base.split("/").filter((s) => s.length > 0);

  const relSegs = input.split("/");
  const segs: string[] = [...baseSegs];
  for (const s of relSegs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (segs.length > 0) segs.pop();
      continue;
    }
    segs.push(s);
  }
  return segs.length === 0 ? "~" : `~/${segs.join("/")}`;
}

function resolveTouchedPathKey(cwd: string, p: string): string {
  const target = parseSshCwdTarget(cwd);
  if (target.kind === "local") {
    const resolved = resolveAgainstCwd(cwd, p);
    // Stable absolute key.
    return `file://${path.resolve(resolved)}`;
  }

  const base = target.cwd;
  const resolvedRemote = normalizeRemotePath(base, p);
  // Use a stable key space for remote paths.
  const suffix = resolvedRemote.startsWith("/") ? resolvedRemote : `/${resolvedRemote}`;
  return `ssh://${target.host}${suffix}`;
}

export function collectApplyPatchTouchedPaths(params: {
  patchText: string;
  cwd: string;
}): Set<string> {
  const hunks = parsePatch(params.patchText);
  const out = new Set<string>();
  for (const hunk of hunks) {
    if (hunk.type === "add") {
      out.add(resolveTouchedPathKey(params.cwd, hunk.path));
      continue;
    }
    if (hunk.type === "delete") {
      out.add(resolveTouchedPathKey(params.cwd, hunk.path));
      continue;
    }
    if (hunk.type === "update") {
      out.add(resolveTouchedPathKey(params.cwd, hunk.path));
      if (hunk.movePath) {
        out.add(resolveTouchedPathKey(params.cwd, hunk.movePath));
      }
      continue;
    }
    const _exhaustive: never = hunk;
    throw new Error(`Unhandled patch hunk: ${String(_exhaustive)}`);
  }
  return out;
}

export function collectEditFileTouchedPaths(params: { path: string; cwd: string }): Set<string> {
  return new Set([resolveTouchedPathKey(params.cwd, params.path)]);
}

function normalizeToolSpecs(
  toolSpecs?: ReadonlyMap<string, Level1ToolSpec<unknown>>,
): ReadonlyMap<string, Level1ToolSpec<unknown>> | undefined {
  if (!toolSpecs || toolSpecs.size === 0) return undefined;
  return toolSpecs;
}

function resolveAllowedToolNamesFromSpecs(
  toolSpecs?: ReadonlyMap<string, Level1ToolSpec<unknown>>,
): [string, ...string[]] | null {
  const normalized = normalizeToolSpecs(toolSpecs);
  if (!normalized) return null;

  const names = [...normalized.values()]
    .filter((spec) => spec.name !== "batch" && spec.supportsBatch !== false)
    .map((spec) => spec.name) as string[];
  if (names.length === 0) {
    throw new Error("batch requires at least one enabled Level-1 tool that has not opted out");
  }
  return names as [string, ...string[]];
}

function toolSetLookup(tools: ToolSet, name: string): ToolLike | undefined {
  const v = (tools as unknown as Record<string, unknown>)[name];
  if (!v || typeof v !== "object") return undefined;
  return v as ToolLike;
}

export function batchTool(params: {
  defaultCwd: string;
  getTools: () => ToolSet;
  getToolSpecs?: () => ReadonlyMap<string, Level1ToolSpec<unknown>>;
  editingMode?: EditingToolMode | "none";
  maxCalls?: number;
}) {
  const { defaultCwd, getTools } = params;
  const editingMode = params.editingMode ?? "apply_patch";
  const maxCalls = Math.min(params.maxCalls ?? ABSOLUTE_MAX_CALLS, ABSOLUTE_MAX_CALLS);
  const toolSpecs = normalizeToolSpecs(params.getToolSpecs?.());
  const allowedToolNames =
    resolveAllowedToolNamesFromSpecs(toolSpecs) ??
    (ALLOWED_TOOL_NAMES_BY_MODE[editingMode] as unknown as [string, ...string[]]);
  const batchInputSchema = makeBatchInputSchema(allowedToolNames, maxCalls);
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
      inputSchema: batchInputSchema,
      execute: async (input, options) => {
        const calls = input.tool_calls;
        if (calls.length > ABSOLUTE_MAX_CALLS || calls.length > maxCalls) {
          throw new Error(`Batch accepts at most ${maxCalls} tool calls.`);
        }
        const tools = getTools();

        const children = await Promise.all(
          calls.map(async (call, index) => {
            const toolCallId = buildSyntheticToolCallId({
              prefix: "batch_child",
              seed: `${options.toolCallId}:${index + 1}:${call.tool}`,
            });
            const child = {
              toolCallId,
              toolName: call.tool,
              input: call.parameters,
            };
            const childTool = toolSetLookup(tools, call.tool);
            if (!childTool) {
              return {
                ...child,
                invalid: true,
                error: `Tool not available: ${call.tool}`,
              };
            }

            try {
              if (hasParseAsync(childTool.inputSchema)) {
                return {
                  ...child,
                  input: await childTool.inputSchema.parseAsync(call.parameters),
                };
              }
              if (hasParse(childTool.inputSchema)) {
                return { ...child, input: childTool.inputSchema.parse(call.parameters) };
              }
              const schema = asSchema(childTool.inputSchema as never);
              const validation = await schema.validate?.(call.parameters);
              if (!validation) return child;
              if (!validation.success) throw validation.error;
              return { ...child, input: validation.value };
            } catch (error: unknown) {
              return {
                ...child,
                invalid: true,
                error: formatBatchChildValidationError({
                  childIndex: index + 1,
                  toolName: call.tool,
                  parameters: call.parameters,
                  error,
                }),
              };
            }
          }),
        );

        const activeEditTool = editingMode === "none" ? null : editingMode;

        // Preflight: reject active edit calls that overlap on touched paths.
        const seen = new Map<string, number>();
        const conflicts: string[] = [];
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
          const child = children[i]!;
          if ("invalid" in child && child.invalid) continue;
          const spec = toolSpecs?.get(call.tool);
          const shouldPreflight =
            Boolean(spec?.editTargets) || (activeEditTool !== null && call.tool === activeEditTool);
          if (!shouldPreflight) continue;
          const raw =
            child.input && typeof child.input === "object" && !Array.isArray(child.input)
              ? (child.input as Record<string, unknown>)
              : {};
          const cwd = typeof raw["cwd"] === "string" ? raw["cwd"] : defaultCwd;

          let touched: Set<string>;

          if (spec?.editTargets) {
            try {
              touched = new Set(await spec.editTargets(child.input, { cwd }));
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(
                `batch rejected: could not resolve edit targets for child #${i + 1} (${call.tool}): ${message}`,
              );
            }
          } else if (activeEditTool === "apply_patch") {
            if (typeof raw["patchText"] !== "string") {
              throw new Error(
                formatBatchPreflightMissingFieldError({
                  childIndex: i + 1,
                  toolName: activeEditTool,
                  field: "patchText",
                  expectedType: "string",
                  parameters: raw,
                }),
              );
            }

            try {
              touched = collectApplyPatchTouchedPaths({
                patchText: String(raw["patchText"]),
                cwd,
              });
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(
                `batch rejected: could not parse edit targets for child #${i + 1} (${call.tool}): ${message}`,
              );
            }
          } else {
            if (typeof raw["path"] !== "string") {
              throw new Error(
                formatBatchPreflightMissingFieldError({
                  childIndex: i + 1,
                  toolName: call.tool,
                  field: "path",
                  expectedType: "string",
                  parameters: raw,
                }),
              );
            }
            touched = collectEditFileTouchedPaths({
              path: String(raw["path"]),
              cwd,
            });
          }

          for (const p of touched) {
            const prior = seen.get(p);
            if (prior !== undefined) {
              conflicts.push(p);
              continue;
            }
            seen.set(p, i);
          }
        }

        if (conflicts.length > 0) {
          const unique = Array.from(new Set(conflicts)).slice(0, 25);
          const more = conflicts.length - unique.length;
          const lines = unique.map((p) => `- ${p}`);
          if (more > 0) lines.push(`- ... and ${more} more`);
          throw new Error(
            [
              "batch rejected: edit calls touch overlapping paths:",
              ...lines,
              "Tip: combine edits into a single edit call per file.",
            ].join("\n"),
          );
        }

        const result = {
          ok: true as const,
          total: children.length,
          children: children.map((child) => ({
            toolCallId: child.toolCallId,
            tool: child.toolName,
          })),
        };
        return new ToolExpansion(result, children);
      },
    }),
  };
}
