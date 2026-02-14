import path from "node:path";

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { EditingToolMode } from "@stanley2058/lilac-utils";
import { expandTilde } from "./fs/fs-impl";
import { parsePatch } from "./apply-patch/apply-patch-core";
import { formatToolArgsForDisplay } from "./tool-args-display";

import { parseSshCwdTarget } from "../ssh/ssh-cwd";

const ALLOWED_TOOL_NAMES_BY_MODE = {
  apply_patch: ["read_file", "glob", "grep", "bash", "apply_patch"],
  edit_file: ["read_file", "glob", "grep", "bash", "edit_file"],
  none: ["read_file", "glob", "grep", "bash"],
} as const;

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

function makeBatchInputSchema(allowedToolNames: readonly [string, ...string[]]) {
  return z.object({
    tool_calls: z
      .array(makeToolCallSchema(allowedToolNames))
      .min(1)
      .max(25)
      .describe("Array of tool calls to execute in parallel"),
  });
}

const batchOutputSchema = z.object({
  ok: z.boolean(),
  total: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  results: z.array(
    z.object({
      toolCallId: z.string(),
      tool: z.string(),
      ok: z.boolean(),
      output: z.unknown().optional(),
      error: z.string().optional(),
    }),
  ),
});

type ToolLike = {
  inputSchema?: unknown;
  execute?: (
    args: unknown,
    options: {
      toolCallId: string;
      messages: readonly unknown[];
      abortSignal?: AbortSignal;
      experimental_context?: unknown;
    },
  ) => unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasParse(schema: unknown): schema is { parse: (v: unknown) => unknown } {
  if (!schema || typeof schema !== "object") return false;
  return "parse" in schema && typeof (schema as { parse?: unknown }).parse === "function";
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

function collectApplyPatchTouchedPaths(params: { patchText: string; cwd: string }): Set<string> {
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

function collectEditFileTouchedPaths(params: { path: string; cwd: string }): Set<string> {
  return new Set([resolveTouchedPathKey(params.cwd, params.path)]);
}

function toolSetLookup(tools: ToolSet, name: string): ToolLike | undefined {
  const v = (tools as unknown as Record<string, unknown>)[name];
  if (!v || typeof v !== "object") return undefined;
  return v as ToolLike;
}

export function batchTool(params: {
  defaultCwd: string;
  getTools: () => ToolSet;
  editingMode?: EditingToolMode | "none";
  reportToolStatus?: (update: {
    toolCallId: string;
    status: "start" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => void | Promise<void>;
}) {
  const { defaultCwd, getTools, reportToolStatus } = params;
  const editingMode = params.editingMode ?? "apply_patch";
  const allowedToolNames = ALLOWED_TOOL_NAMES_BY_MODE[editingMode] as unknown as [
    string,
    ...string[],
  ];
  const batchInputSchema = makeBatchInputSchema(allowedToolNames);
  const editCallDescription =
    editingMode === "none"
      ? "Supports independent read_file/glob/grep/bash operations."
      : `Supports independent read_file/glob/grep/bash/${editingMode} operations.`;

  const reportSafe = (update: {
    toolCallId: string;
    status: "start" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => {
    if (!reportToolStatus) return;
    Promise.resolve(reportToolStatus(update)).catch(() => {
      // ignore (tool progress is best-effort)
    });
  };

  type ChildStatus = "pending" | "running" | "done";
  type ChildState = {
    tool: string;
    args: unknown;
    status: ChildStatus;
    ok: boolean | null;
    updatedSeq: number;
  };

  function iconForChild(s: ChildState): string {
    if (s.status === "running") return "▶";
    if (s.status === "done") return s.ok ? "✓" : "✗";
    return "…";
  }

  function renderBatchDisplay(params: {
    total: number;
    done: number;
    children: readonly ChildState[];
    collapsed: boolean;
  }): string {
    const header = params.collapsed
      ? `batch (${params.total} tools)`
      : `batch (${params.total} tools; ${params.done}/${params.total} done)`;

    if (params.collapsed) return header;

    const recent = params.children
      .filter((c) => c.updatedSeq > 0)
      .sort((a, b) => b.updatedSeq - a.updatedSeq)
      .slice(0, 3)
      .sort((a, b) => a.updatedSeq - b.updatedSeq);

    if (recent.length === 0) return header;

    const lines = recent.map((c, idx) => {
      const args = formatToolArgsForDisplay(c.tool, c.args);
      const branch = idx === recent.length - 1 ? "└─" : "├─";
      return `${branch} ${iconForChild(c)} ${c.tool}${args}`;
    });

    return [header, ...lines].join("\n");
  }

  return {
    batch: tool({
      description: [
        "Execute multiple tool calls in parallel. Prefer this tool when your following operations are independent.",
        editCallDescription,
        "Notes:",
        "- All calls start in parallel; ordering is not guaranteed.",
        "- Partial failures do not stop other tool calls.",
        "- If multiple edit calls touch the same file path, the entire batch is rejected.",
      ].join("\n"),
      inputSchema: batchInputSchema,
      outputSchema: batchOutputSchema,
      execute: async (input, options) => {
        const calls = input.tool_calls;
        const tools = getTools();

        const activeEditTool = editingMode === "none" ? null : editingMode;

        // Preflight: reject active edit calls that overlap on touched paths.
        const seen = new Map<string, number>();
        const conflicts: string[] = [];
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
          if (!activeEditTool || call.tool !== activeEditTool) continue;
          const raw = call.parameters;
          const cwd = isRecord(raw) && typeof raw["cwd"] === "string" ? raw["cwd"] : defaultCwd;

          let touched: Set<string>;

          if (activeEditTool === "apply_patch") {
            if (!isRecord(raw) || typeof raw["patchText"] !== "string") {
              throw new Error("batch: apply_patch parameters must include patchText (string)");
            }

            try {
              touched = collectApplyPatchTouchedPaths({
                patchText: String(raw["patchText"]),
                cwd,
              });
            } catch {
              // If the patch is invalid we can't preflight touched paths.
              // Let the apply_patch tool handle the error for this call.
              continue;
            }
          } else {
            if (!isRecord(raw) || typeof raw["path"] !== "string") {
              throw new Error("batch: edit_file parameters must include path (string)");
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

        const parentId = options.toolCallId;

        const children: ChildState[] = calls.map((c) => ({
          tool: c.tool,
          args: c.parameters,
          status: "pending",
          ok: null,
          updatedSeq: 0,
        }));
        let updateSeq = 0;

        const publishProgress = () => {
          const done = children.filter((c) => c.status === "done").length;
          reportSafe({
            toolCallId: parentId,
            status: "start",
            display: renderBatchDisplay({
              total: children.length,
              done,
              children,
              collapsed: false,
            }),
          });
        };

        // Best-effort: establish an initial progress line.
        publishProgress();
        const results = await Promise.all(
          calls.map(async (call, idx) => {
            const toolCallId = `${parentId}:${idx + 1}`;

            const child = children[idx]!;

            const t = toolSetLookup(tools, call.tool);
            if (!t?.execute) {
              child.status = "done";
              child.ok = false;
              child.updatedSeq = ++updateSeq;
              publishProgress();
              return {
                toolCallId,
                tool: call.tool,
                ok: false as const,
                error: `Tool not available or not executable: ${call.tool}`,
              };
            }

            const parameters = call.parameters;
            let validatedArgs: unknown = parameters;
            try {
              if (hasParse(t.inputSchema)) {
                validatedArgs = t.inputSchema.parse(parameters);
              }
            } catch (e: unknown) {
              child.status = "done";
              child.ok = false;
              child.args = parameters;
              child.updatedSeq = ++updateSeq;
              publishProgress();
              return {
                toolCallId,
                tool: call.tool,
                ok: false as const,
                error: e instanceof Error ? e.message : String(e),
              };
            }

            child.status = "running";
            child.ok = null;
            child.args = validatedArgs;
            child.updatedSeq = ++updateSeq;
            publishProgress();

            try {
              const out = await t.execute(validatedArgs, {
                toolCallId,
                messages: options.messages,
                abortSignal: options.abortSignal,
                experimental_context: options.experimental_context,
              });

              child.status = "done";
              child.ok = true;
              child.updatedSeq = ++updateSeq;
              publishProgress();
              return {
                toolCallId,
                tool: call.tool,
                ok: true as const,
                output: out,
              };
            } catch (e: unknown) {
              child.status = "done";
              child.ok = false;
              child.updatedSeq = ++updateSeq;
              publishProgress();
              return {
                toolCallId,
                tool: call.tool,
                ok: false as const,
                error: e instanceof Error ? e.message : String(e),
              };
            }
          }),
        );

        const succeeded = results.filter((r) => r.ok).length;
        const failed = results.length - succeeded;

        // Collapse the batch tool line once everything is done.
        reportSafe({
          toolCallId: parentId,
          status: "end",
          ok: failed === 0,
          error: failed === 0 ? undefined : "one or more tool calls failed",
          display: renderBatchDisplay({
            total: children.length,
            done: children.length,
            children,
            collapsed: true,
          }),
        });

        return {
          ok: failed === 0,
          total: results.length,
          succeeded,
          failed,
          results,
        };
      },
    }),
  };
}
