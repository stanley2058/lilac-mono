import { posix } from "node:path";

import { getToolName, isToolUIPart, type UIMessageChunk } from "ai";
import { z } from "zod";

import { parseReasoningSummary } from "@stanley2058/lilac-utils/reasoning-summary";

import {
  miniLilacTodoChunkSchema,
  miniLilacTodosSchema,
  miniLilacUIMessageDataPartSchema,
  type MiniLilacCompactionEvent,
  type MiniLilacControlResult,
  type MiniLilacSessionSnapshot,
  type MiniLilacSubagentStatus,
  type MiniLilacTodoState,
  type MiniLilacTranscriptReset,
  type MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";

export type TranscriptKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "shell"
  | "exploration"
  | "edit"
  | "file"
  | "source"
  | "status"
  | "subagent"
  | "compaction"
  | "error";

export type TranscriptTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export interface TranscriptEntry {
  readonly id: string;
  readonly kind: TranscriptKind;
  readonly tone: TranscriptTone;
  readonly text: string;
  readonly singleLine?: boolean;
  readonly streaming?: boolean;
  readonly shell?: ShellTranscript;
  readonly exploration?: ExplorationTranscript;
  readonly edit?: EditTranscript;
  readonly subagent?: SubagentTranscript;
}

export interface SubagentTranscript {
  readonly toolCallId: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly profile: string;
  readonly prompt: string;
  readonly mode: "sync" | "deferred";
  readonly state: "pending" | "running" | "completed" | "cancelled" | "error" | "rejected";
  readonly toolCount: number;
  readonly activity?: string;
  readonly text?: string;
  readonly error?: string;
}

export interface ShellTranscript {
  readonly command: string;
  readonly cwd?: string;
  readonly output?: string;
}

export interface ExplorationOperation {
  readonly action: "Read" | "Grep" | "Glob" | "Find";
  readonly detail: string;
}

export interface ExplorationTranscript {
  readonly reads: number;
  readonly searches: number;
  readonly failures: number;
  readonly operations: readonly ExplorationOperation[];
}

export interface EditOperation {
  readonly action: "Patch" | "Edit";
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly tone: TranscriptTone;
  readonly detail?: string;
}

export interface EditTranscript {
  readonly operations: readonly EditOperation[];
}

export interface TranscriptRenderOptions {
  readonly cwd?: string;
}

const DEFAULT_SHELL_OUTPUT_LINES = 8;
const DEFAULT_SHELL_OUTPUT_CHARACTERS = 2_000;

export interface ChunkOutputSink {
  append(entry: Omit<TranscriptEntry, "id">): string;
  update(id: string, entry: Omit<TranscriptEntry, "id">): void;
  appendText(id: string, delta: string): void;
  finish(id: string): void;
}

export interface ChunkRendererHooks {
  onSnapshot(snapshot: MiniLilacSessionSnapshot): void;
  onControl?(result: MiniLilacControlResult): void;
  onTodos?(todos: MiniLilacTodoState): void;
  onTranscriptReset(reset: MiniLilacTranscriptReset): void;
}

function previewText(value: string, max = 120): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 3)}...` : singleLine;
}

function toolErrorSummary(summary: string, errorText: string): string {
  const trimmed = errorText.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return `${summary} failed`;
  return `${summary}: ${previewText(errorText, 180)}`;
}

function controlSummary(result: MiniLilacControlResult): string {
  switch (result.status) {
    case "queued":
      return `steer queued (${result.steeringId})`;
    case "interrupted":
      return `queued steering interrupted (${result.steeringIds.length})`;
    case "empty":
      return "no queued steering to interrupt";
    case "inactive":
      return "no active run";
    case "cancelled":
      return "run cancelled";
  }
}

function subagentEntry(subagent: SubagentTranscript): Omit<TranscriptEntry, "id"> {
  const running = subagent.state === "pending" || subagent.state === "running";
  const icon = running ? "│" : subagent.state === "completed" ? "✓" : "×";
  const profile = humanizeToolName(subagent.profile);
  const background = subagent.mode === "deferred" ? " (background)" : "";
  const session = subagent.sessionName === undefined ? "" : ` [${subagent.sessionName}]`;
  const lines = [
    `${icon} ${profile} Task${session}${background} - ${previewText(subagent.prompt, 160)}`,
  ];
  if (running && subagent.activity !== undefined) {
    lines.push(
      `  ↳ ${humanizeToolName(subagent.activity)}${subagent.toolCount > 1 ? ` · ${subagent.toolCount} tool calls` : ""}`,
    );
  } else if (subagent.toolCount > 0) {
    lines.push(`  ↳ ${subagent.toolCount} tool call${subagent.toolCount === 1 ? "" : "s"}`);
  } else if (subagent.error !== undefined) {
    lines.push(`  ↳ ${previewText(subagent.error, 180)}`);
  }
  if (subagent.sessionId !== undefined && lines.length === 1)
    lines.push("  ↳ Click to view transcript");
  return {
    kind: "subagent",
    tone: running
      ? "accent"
      : subagent.state === "completed"
        ? "success"
        : subagent.state === "cancelled"
          ? "muted"
          : "danger",
    text: lines.join("\n"),
    subagent,
  };
}

function compactTokenCount(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  if (tokens < 1_000) return String(tokens);
  const divisor = tokens < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = divisor === 1_000 ? "K" : "M";
  return `${Math.round((tokens / divisor) * 10) / 10}${suffix}`;
}

function compactionSummary(event: MiniLilacCompactionEvent): string {
  if (event.status === "failed")
    return `Context compaction failed${event.error ? `: ${event.error}` : ""}`;
  const before = compactTokenCount(event.estimatedInputTokensBefore);
  const after = compactTokenCount(event.estimatedInputTokensAfter);
  const usage = before !== undefined && after !== undefined ? ` · ${before} → ${after}` : "";
  return `Context compacted${usage}`;
}

const pathInputSchema = z.object({ path: z.string() });
const readInputSchema = z.object({
  path: z.string(),
  start: z
    .union([
      z.object({ offset: z.number().int().nonnegative() }),
      z.object({
        line: z.number().int().positive(),
        column: z.number().int().nonnegative().optional(),
      }),
    ])
    .optional(),
  maxLines: z.number().int().positive().optional(),
  maxCharacters: z.number().int().positive().optional(),
});
const bashInputSchema = z.object({ command: z.string(), cwd: z.string().optional() });
const globInputSchema = z.object({ patterns: z.array(z.string()), cwd: z.string().optional() });
const grepInputSchema = z.object({ pattern: z.string(), cwd: z.string().optional() });
const fuzzyInputSchema = z.object({ query: z.string(), cwd: z.string().optional() });
const patchInputSchema = z.object({ patchText: z.string(), cwd: z.string().optional() });
const editInputSchema = z.object({
  path: z.string(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  edits: z
    .array(
      z.object({
        op: z.enum(["replace", "append", "prepend"]),
        pos: z.string(),
        end: z.string().optional(),
        lines: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
      }),
    )
    .optional(),
});
const editOutputSchema = z.object({ replacementsMade: z.number().int().nonnegative().optional() });
const bashExecutionErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("blocked"), reason: z.string() }),
  z.object({ type: z.literal("aborted"), signal: z.literal("SIGTERM") }),
  z.object({
    type: z.literal("timeout"),
    timeoutMs: z.number().nonnegative(),
    signal: z.literal("SIGTERM"),
  }),
  z.object({ type: z.literal("exception"), message: z.string() }),
]);
const bashOutputSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
    stdoutTruncated: z.boolean().optional(),
    stderrTruncated: z.boolean().optional(),
    executionError: bashExecutionErrorSchema.optional(),
  })
  .strict()
  .refine(
    (output) =>
      output.stdout !== undefined ||
      output.stderr !== undefined ||
      output.exitCode !== undefined ||
      output.stdoutTruncated !== undefined ||
      output.stderrTruncated !== undefined ||
      output.executionError !== undefined,
  );
const bashOutputDeltaSchema = z.object({
  type: z.literal("output-delta"),
  delta: z.string(),
});
const subagentInputSchema = z.object({
  profile: z.string().optional(),
  prompt: z.string().optional(),
  task: z.string().optional(),
  mode: z.enum(["sync", "deferred"]).optional(),
  sessionName: z.string().optional(),
});
const subagentResultSchema = z.object({
  status: z.enum(["accepted", "completed", "cancelled", "error", "rejected"]),
  childRunId: z.string().optional(),
  childSessionId: z.string().optional(),
  sessionName: z.string().optional(),
  profile: z.string().optional(),
  text: z.string().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
});

function subagentFromTool(
  toolCallId: string,
  input: unknown,
  output?: unknown,
): SubagentTranscript {
  const parsedInput = subagentInputSchema.safeParse(input);
  const parsedOutput = subagentResultSchema.safeParse(output);
  const profile = parsedOutput.success
    ? (parsedOutput.data.profile ?? parsedInput.data?.profile)
    : parsedInput.data?.profile;
  const prompt = parsedInput.success
    ? (parsedInput.data.prompt ?? parsedInput.data.task ?? "Delegated task")
    : "Delegated task";
  const mode = parsedInput.success ? (parsedInput.data.mode ?? "sync") : "sync";
  if (!parsedOutput.success) {
    return {
      toolCallId,
      profile: profile ?? "subagent",
      prompt,
      mode,
      state: "pending",
      toolCount: 0,
    };
  }
  const state = parsedOutput.data.status === "accepted" ? "running" : parsedOutput.data.status;
  return {
    toolCallId,
    ...(parsedOutput.data.childRunId ? { runId: parsedOutput.data.childRunId } : {}),
    ...(parsedOutput.data.childSessionId ? { sessionId: parsedOutput.data.childSessionId } : {}),
    ...(parsedOutput.data.sessionName || parsedInput.data?.sessionName
      ? { sessionName: parsedOutput.data.sessionName ?? parsedInput.data?.sessionName }
      : {}),
    profile: profile ?? "subagent",
    prompt,
    mode,
    state,
    toolCount: 0,
    ...(parsedOutput.data.text ? { text: parsedOutput.data.text } : {}),
    ...(parsedOutput.data.error || parsedOutput.data.reason
      ? { error: parsedOutput.data.error ?? parsedOutput.data.reason }
      : {}),
  };
}

function subagentFromStatus(status: MiniLilacSubagentStatus): SubagentTranscript {
  return { ...status };
}
const skillInputSchema = z.object({ name: z.string().trim().min(1) });
const todoWriteInputSchema = z.strictObject({ todos: miniLilacTodosSchema });
const batchInputSchema = z.object({ tool_calls: z.array(z.unknown()) });
const webfetchInputSchema = z.object({ url: z.string().trim().min(1) });
const websearchInputSchema = z.object({ query: z.string().trim().min(1) });

type ToolRenderState =
  | { readonly status: "active"; readonly output?: unknown }
  | { readonly status: "success"; readonly output: unknown }
  | { readonly status: "error"; readonly errorText: string }
  | { readonly status: "denied" };

type ExplorationState = {
  id: string;
  reads: number;
  searches: number;
  failures: number;
  operations: ExplorationOperation[];
  pending: Set<string>;
};

function explorationCategory(name: string): "read" | "search" | undefined {
  if (name === "read_file") return "read";
  if (name === "glob" || name === "grep" || name === "fuzzy_search") return "search";
  return undefined;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function explorationTranscriptText(
  exploration: ExplorationTranscript,
  latest: boolean,
  expanded = false,
): string {
  const counts = [
    exploration.reads > 0 ? plural(exploration.reads, "read") : undefined,
    exploration.searches > 0 ? plural(exploration.searches, "search") : undefined,
  ].filter((value) => value !== undefined);
  const header = `${latest ? "Exploring" : "Explored"} · ${counts.join(", ")}${exploration.failures > 0 ? ` · ${plural(exploration.failures, "failure")}` : ""}`;
  if (!expanded) return header;
  return [
    header,
    ...exploration.operations.map(
      (operation) => `${operation.action} ${previewText(operation.detail, 240)}`,
    ),
  ].join("\n");
}

function explorationEntry(state: ExplorationState, latest = true): Omit<TranscriptEntry, "id"> {
  const exploration = {
    reads: state.reads,
    searches: state.searches,
    failures: state.failures,
    operations: [...state.operations],
  } satisfies ExplorationTranscript;
  return {
    kind: "exploration",
    tone: state.failures > 0 ? "warning" : latest ? "accent" : "normal",
    text: explorationTranscriptText(exploration, latest),
    exploration,
  };
}

function explorationOperation(
  name: string,
  input: unknown,
  options: TranscriptRenderOptions = {},
): ExplorationOperation {
  if (name === "read_file") {
    const parsed = readInputSchema.safeParse(input);
    if (parsed.success) {
      const start = parsed.data.start;
      const details = [
        start && "offset" in start ? `offset ${start.offset}` : undefined,
        start && "line" in start
          ? `line ${start.line}${start.column === undefined ? "" : `:${start.column}`}`
          : undefined,
        parsed.data.maxLines === undefined ? undefined : plural(parsed.data.maxLines, "line"),
        parsed.data.maxCharacters === undefined
          ? undefined
          : plural(parsed.data.maxCharacters, "character"),
      ].filter((value) => value !== undefined);
      return {
        action: "Read",
        detail: [explorationPath(parsed.data.path, options.cwd), ...details].join(" · "),
      };
    }
    return { action: "Read", detail: "file" };
  }
  if (name === "grep") {
    const parsed = grepInputSchema.safeParse(input);
    if (parsed.success) {
      return {
        action: "Grep",
        detail: [
          explorationScope(parsed.data.cwd, options.cwd),
          JSON.stringify(parsed.data.pattern),
        ]
          .filter((value) => value !== undefined)
          .join(" · "),
      };
    }
    return { action: "Grep", detail: "pattern" };
  }
  if (name === "glob") {
    const parsed = globInputSchema.safeParse(input);
    if (parsed.success) {
      return {
        action: "Glob",
        detail: [explorationScope(parsed.data.cwd, options.cwd), parsed.data.patterns.join(", ")]
          .filter((value) => value !== undefined)
          .join(" · "),
      };
    }
    return { action: "Glob", detail: "files" };
  }
  const parsed = fuzzyInputSchema.safeParse(input);
  return {
    action: "Find",
    detail: parsed.success
      ? [explorationScope(parsed.data.cwd, options.cwd), JSON.stringify(parsed.data.query)]
          .filter((value) => value !== undefined)
          .join(" · ")
      : "query",
  };
}

function explorationPath(value: string, cwd: string | undefined): string {
  if (cwd === undefined) return value;
  const normalizedValue = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (normalizedValue === normalizedCwd) return ".";
  if (normalizedValue.startsWith(`${normalizedCwd}/`)) {
    return normalizedValue.slice(normalizedCwd.length + 1);
  }
  return value;
}

function explorationScope(value: string | undefined, cwd: string | undefined): string | undefined {
  if (value === undefined || sameCwd(value, cwd)) return undefined;
  return explorationPath(value, cwd);
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  const lines = value.split("\n").length;
  return value.endsWith("\n") ? lines - 1 : lines;
}

function replacementLineCount(value: string | readonly string[] | null | undefined): number {
  if (value === undefined || value === null) return 0;
  return typeof value === "string" ? lineCount(value) : value.length;
}

function hashlineNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)#[0-9a-f]+\b/iu.exec(value.trim());
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function editPath(value: string, cwd: string | undefined): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (cwd === undefined || !normalized.startsWith("/")) return normalized;
  const normalizedCwd = posix.normalize(cwd.replaceAll("\\", "/"));
  return posix.relative(normalizedCwd, normalized) || ".";
}

export function editTranscriptAction(edit: EditTranscript): "Patch" | "Edit" {
  const first = edit.operations[0]?.action ?? "Edit";
  return edit.operations.every((operation) => operation.action === first) ? first : "Edit";
}

export function editOperationText(edit: EditOperation): string {
  const additions = edit.added > 0 ? ` +${edit.added}` : "";
  const removals = edit.removed > 0 ? ` -${edit.removed}` : "";
  return `${edit.action} ${edit.path}${additions}${removals}${edit.detail ?? ""}`;
}

export function editTranscriptText(edit: EditTranscript): string {
  if (edit.operations.length === 1) {
    const operation = edit.operations[0];
    return operation === undefined ? "Edit" : editOperationText(operation);
  }
  return `${editTranscriptAction(edit)} ${plural(edit.operations.length, "file")}`;
}

export function groupNearbyEdits(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const grouped: TranscriptEntry[] = [];
  for (const entry of entries) {
    const previous = grouped.at(-1);
    if (entry.edit === undefined || previous?.edit === undefined) {
      grouped.push(entry);
      continue;
    }
    const edit = {
      operations: [...previous.edit.operations, ...entry.edit.operations],
    } satisfies EditTranscript;
    grouped[grouped.length - 1] = {
      ...previous,
      tone:
        previous.tone === "danger" || entry.tone === "danger"
          ? "danger"
          : previous.tone === "warning" || entry.tone === "warning"
            ? "warning"
            : "normal",
      text: editTranscriptText(edit),
      edit,
    };
  }
  return grouped;
}

function patchEdits(input: unknown, cwd: string | undefined): EditOperation[] | undefined {
  const parsed = patchInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const edits: Array<{ path: string; added: number; removed: number }> = [];
  let current: { path: string; added: number; removed: number } | undefined;
  for (const line of parsed.data.patchText.split("\n")) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line);
    if (header?.[1] !== undefined) {
      current = { path: header[1], added: 0, removed: 0 };
      edits.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (move?.[1] !== undefined && current !== undefined) {
      current.path = move[1];
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  return edits.map((edit) => ({
    action: "Patch",
    path: editPath(edit.path, parsed.data.cwd ?? cwd),
    added: edit.added,
    removed: edit.removed,
    tone: "normal",
  }));
}

function fileEdits(
  input: unknown,
  output: unknown,
  cwd: string | undefined,
): EditOperation[] | undefined {
  const parsed = editInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const replacements = editOutputSchema.safeParse(output);
  const multiplier = replacements.success ? (replacements.data.replacementsMade ?? 1) : 1;
  if (parsed.data.oldText !== undefined && parsed.data.newText !== undefined) {
    return [
      {
        action: "Edit",
        path: editPath(parsed.data.path, cwd),
        added: lineCount(parsed.data.newText) * multiplier,
        removed: lineCount(parsed.data.oldText) * multiplier,
        tone: "normal",
      },
    ];
  }
  if (parsed.data.edits !== undefined) {
    let added = 0;
    let removed = 0;
    for (const edit of parsed.data.edits) {
      added += replacementLineCount(edit.lines);
      if (edit.op !== "replace") continue;
      const start = hashlineNumber(edit.pos);
      const end = hashlineNumber(edit.end) ?? start;
      if (start !== undefined && end !== undefined && end >= start) removed += end - start + 1;
    }
    return [
      {
        action: "Edit",
        path: editPath(parsed.data.path, cwd),
        added,
        removed,
        tone: "normal",
      },
    ];
  }
  return [
    {
      action: "Edit",
      path: editPath(parsed.data.path, cwd),
      added: 0,
      removed: 0,
      tone: "normal",
    },
  ];
}

function shellOutput(output: unknown): string | undefined {
  if (typeof output === "string") return output.trimEnd() || undefined;
  const parsed = bashOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const executionError = parsed.data.executionError;
  const executionErrorText =
    executionError?.type === "blocked"
      ? executionError.reason
      : executionError?.type === "timeout"
        ? `Command timed out after ${executionError.timeoutMs}ms`
        : executionError?.type === "aborted"
          ? "Command aborted"
          : executionError?.type === "exception"
            ? executionError.message
            : undefined;
  const chunks = [
    parsed.data.stdout?.trimEnd(),
    parsed.data.stderr?.trimEnd(),
    executionErrorText,
  ].filter((value) => value !== undefined && value.length > 0);
  if (parsed.data.exitCode !== undefined && parsed.data.exitCode !== 0 && chunks.length === 0) {
    chunks.push(`Process exited with code ${parsed.data.exitCode}`);
  }
  return chunks.join("\n") || undefined;
}

function shellOutputFailed(output: unknown): boolean {
  const parsed = bashOutputSchema.safeParse(output);
  return parsed.success && parsed.data.executionError !== undefined;
}

function sameCwd(commandCwd: string, clientCwd: string | undefined): boolean {
  if (clientCwd === undefined) return false;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalize(commandCwd) === normalize(clientCwd);
}

export function shellTranscriptText(
  shell: ShellTranscript,
  expanded = false,
  outputLineLimit = DEFAULT_SHELL_OUTPUT_LINES,
  outputCharacterLimit = DEFAULT_SHELL_OUTPUT_CHARACTERS,
): string {
  const outputLines = shell.output?.split("\n") ?? [];
  const outputCharacters = Array.from(shell.output ?? "");
  const collapsible =
    outputLines.length > outputLineLimit || outputCharacters.length > outputCharacterLimit;
  const lineLimitedOutput = outputLines.slice(0, outputLineLimit).join("\n");
  const lineLimitedCharacters = Array.from(lineLimitedOutput);
  const characterLimitedOutput =
    lineLimitedCharacters.length <= outputCharacterLimit
      ? lineLimitedOutput
      : `${lineLimitedCharacters.slice(0, Math.max(0, outputCharacterLimit - 3)).join("")}...`;
  const visibleOutput =
    expanded || !collapsible
      ? outputLines
      : characterLimitedOutput.length === 0
        ? []
        : characterLimitedOutput.split("\n");
  const lines = [
    shell.cwd === undefined ? undefined : `# Running in ${shell.cwd}`,
    shell.cwd === undefined ? undefined : "",
    `$ ${shell.command}`,
    visibleOutput.length === 0 ? undefined : "",
    ...visibleOutput,
    collapsible ? "" : undefined,
    collapsible ? (expanded ? "Click to collapse" : "Click to expand") : undefined,
  ].filter((value) => value !== undefined);
  return lines.join("\n");
}

export function isShellTranscriptCollapsible(
  shell: ShellTranscript,
  outputLineLimit = DEFAULT_SHELL_OUTPUT_LINES,
  outputCharacterLimit = DEFAULT_SHELL_OUTPUT_CHARACTERS,
): boolean {
  return (
    (shell.output?.split("\n").length ?? 0) > outputLineLimit ||
    Array.from(shell.output ?? "").length > outputCharacterLimit
  );
}

function toolEntry(
  name: string,
  input: unknown,
  state: ToolRenderState,
  options: TranscriptRenderOptions = {},
): Omit<TranscriptEntry, "id"> | undefined {
  if (name === "subagent_result") return undefined;
  if (name === "batch" && state.status !== "error") return undefined;
  if (name === "bash") {
    const parsed = bashInputSchema.safeParse(input);
    if (parsed.success) {
      const output =
        state.status === "success" || (state.status === "active" && state.output !== undefined)
          ? shellOutput(state.output)
          : state.status === "error"
            ? /^[[{]/u.test(state.errorText.trimStart())
              ? "Command failed"
              : state.errorText
            : state.status === "denied"
              ? "Denied"
              : undefined;
      const shell = {
        command: parsed.data.command,
        ...(parsed.data.cwd === undefined || sameCwd(parsed.data.cwd, options.cwd)
          ? {}
          : { cwd: parsed.data.cwd }),
        ...(output === undefined ? {} : { output }),
      } satisfies ShellTranscript;
      return {
        kind: "shell",
        tone:
          state.status === "error" ||
          (state.status === "success" && shellOutputFailed(state.output))
            ? "danger"
            : state.status === "denied"
              ? "warning"
              : "normal",
        text: shellTranscriptText(shell),
        shell,
      };
    }
  }
  if (name === "skill") {
    const parsed = skillInputSchema.safeParse(input);
    if (parsed.success && state.status !== "error" && state.status !== "denied") {
      return {
        kind: "tool",
        tone: state.status === "success" ? "success" : "accent",
        text: `${state.status === "success" ? "Loaded" : "Loading"} skill ${parsed.data.name}`,
      };
    }
  }
  const edits =
    name === "apply_patch"
      ? patchEdits(input, options.cwd)
      : name === "edit_file"
        ? fileEdits(input, state.status === "success" ? state.output : undefined, options.cwd)
        : undefined;
  if (edits !== undefined && edits.length > 0) {
    const detail =
      state.status === "error"
        ? `: ${previewText(state.errorText, 180)}`
        : state.status === "denied"
          ? ": denied"
          : undefined;
    const tone =
      state.status === "error" ? "danger" : state.status === "denied" ? "warning" : "normal";
    const edit = {
      operations: edits.map((operation, index) => ({
        ...operation,
        tone,
        ...(index === 0 && detail !== undefined ? { detail } : {}),
      })),
    } satisfies EditTranscript;
    return {
      kind: "edit",
      tone,
      text: editTranscriptText(edit),
      singleLine: true,
      edit,
    };
  }
  const summary = name === "batch" ? "Parallel tools" : toolSummary(name, input);
  const singleLine =
    name === "webfetch" || name === "websearch" || name === "apply_patch" || name === "edit_file";
  if (state.status === "error") {
    return {
      kind: "error",
      tone: "danger",
      text: toolErrorSummary(summary, state.errorText),
      ...(singleLine ? { singleLine: true } : {}),
    };
  }
  if (state.status === "denied") {
    return {
      kind: "tool",
      tone: "warning",
      text: `${summary}: denied`,
      ...(singleLine ? { singleLine: true } : {}),
    };
  }
  return {
    kind: "tool",
    tone: state.status === "success" ? "success" : "accent",
    text: summary,
    ...(singleLine ? { singleLine: true } : {}),
  };
}

function humanizeToolName(name: string): string {
  return name
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toolSummary(name: string, input: unknown): string {
  if (name === "bash") {
    const parsed = bashInputSchema.safeParse(input);
    if (parsed.success) return `$ ${previewText(parsed.data.command, 160)}`;
  }
  if (name === "read_file") {
    const parsed = pathInputSchema.safeParse(input);
    if (parsed.success) return `Read ${parsed.data.path}`;
  }
  if (name === "edit_file") {
    const parsed = pathInputSchema.safeParse(input);
    if (parsed.success) return `Edit ${parsed.data.path}`;
  }
  if (name === "glob") {
    const parsed = globInputSchema.safeParse(input);
    if (parsed.success) return `Glob ${parsed.data.patterns.join(", ")}`;
  }
  if (name === "grep") {
    const parsed = grepInputSchema.safeParse(input);
    if (parsed.success) return `Grep "${previewText(parsed.data.pattern)}"`;
  }
  if (name === "fuzzy_search") {
    const parsed = fuzzyInputSchema.safeParse(input);
    if (parsed.success) return `Find "${previewText(parsed.data.query)}"`;
  }
  if (name === "apply_patch") {
    const parsed = patchInputSchema.safeParse(input);
    if (parsed.success) {
      const paths = [
        ...parsed.data.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu),
      ].map((match) => match[1]);
      if (paths[0] !== undefined) {
        return `Patch ${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ""}`;
      }
    }
  }
  if (name === "subagent_delegate") {
    const parsed = subagentInputSchema.safeParse(input);
    if (parsed.success) {
      const prompt = parsed.data.prompt ?? parsed.data.task;
      if (prompt !== undefined) {
        return `${humanizeToolName(parsed.data.profile ?? "subagent")}: ${previewText(prompt)}`;
      }
    }
  }
  if (name === "skill") {
    const parsed = skillInputSchema.safeParse(input);
    if (parsed.success) return `Skill ${parsed.data.name}`;
  }
  if (name === "todowrite") {
    const parsed = todoWriteInputSchema.safeParse(input);
    if (parsed.success) {
      const count = parsed.data.todos.length;
      return `Update todos: ${count} item${count === 1 ? "" : "s"}`;
    }
  }
  if (name === "batch") {
    const parsed = batchInputSchema.safeParse(input);
    if (parsed.success) return `Batch ${parsed.data.tool_calls.length} tools`;
  }
  if (name === "webfetch") {
    const parsed = webfetchInputSchema.safeParse(input);
    if (parsed.success) return `Fetch ${parsed.data.url}`;
  }
  if (name === "websearch") {
    const parsed = websearchInputSchema.safeParse(input);
    if (parsed.success) return `Search "${parsed.data.query.replace(/\s+/gu, " ")}"`;
  }
  return humanizeToolName(name);
}

function fileEntry(mediaType: string, filename?: string): Omit<TranscriptEntry, "id"> {
  const label = mediaType.startsWith("image/") ? "Image" : "File";
  return { kind: "file", tone: "muted", text: filename ? `${label}: ${filename}` : label };
}

function sourceUrlEntry(title: string | undefined, url: string): Omit<TranscriptEntry, "id"> {
  return { kind: "source", tone: "muted", text: title === undefined ? url : `${title}: ${url}` };
}

function sourceDocumentEntry(
  title: string,
  mediaType: string,
  filename: string | undefined,
): Omit<TranscriptEntry, "id"> {
  const detail = filename === undefined ? mediaType : `${filename}; ${mediaType}`;
  return { kind: "source", tone: "muted", text: `${title}: ${detail}` };
}

function dataEntry(
  part: MiniLilacUIMessage["parts"][number],
): Omit<TranscriptEntry, "id"> | undefined {
  const parsed = miniLilacUIMessageDataPartSchema.safeParse(part);
  if (!parsed.success) return undefined;
  switch (parsed.data.type) {
    case "data-session":
      return undefined;
    case "data-control":
      return { kind: "status", tone: "muted", text: controlSummary(parsed.data.data) };
    case "data-transcriptReset":
      return {
        kind: "status",
        tone: "warning",
        text: `transcript rewound (${parsed.data.data.reason})`,
      };
    case "data-subagentStatus":
      return undefined;
    case "data-compaction":
      return {
        kind: "compaction",
        tone: parsed.data.data.status === "failed" ? "danger" : "warning",
        text: compactionSummary(parsed.data.data),
      };
  }
}

/**
 * Render a provider reasoning summary as a muted transcript entry.
 *
 * Follows OpenCode's convention: a leading `**Title**` block separated by a
 * blank line becomes the header, the remainder renders inline as the body. The
 * header reads `Thinking: <title>` while streaming and `Thought: <title>` once
 * finalized; a missing title falls back to `Thinking`/`Thought`. Summaries
 * without the title convention keep the full text as the body.
 */
function reasoningEntry(text: string, finalized: boolean): Omit<TranscriptEntry, "id"> {
  const summary = parseReasoningSummary(text);
  const verb = finalized ? "Thought" : "Thinking";
  const header = summary.title === null ? verb : `${verb}: ${summary.title}`;
  return {
    kind: "reasoning",
    tone: "muted",
    text: summary.body ? `${header}\n${summary.body}` : header,
  };
}

/** Convert a canonical startup transcript into the same model used by live output. */
export function renderInitialMessages(
  messages: readonly MiniLilacUIMessage[],
  options: TranscriptRenderOptions = {},
): TranscriptEntry[] {
  const rendered = messages.flatMap((message) => {
    const entries: TranscriptEntry[] = [];
    const subagentIndexes = new Map<string, number>();
    let exploration: ExplorationState | undefined;
    const append = (entry: TranscriptEntry) => {
      exploration = undefined;
      entries.push(entry);
    };
    message.parts.forEach((part, index) => {
      const id = `message:${message.id}:${index}`;
      if (part.type === "text") {
        const kind =
          message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "status";
        append({ id, kind, tone: kind === "user" ? "accent" : "normal", text: part.text });
        return;
      }
      if (part.type === "reasoning") {
        append({ id, ...reasoningEntry(part.text, part.state !== "streaming") });
        return;
      }
      if (isToolUIPart(part)) {
        const name = getToolName(part);
        const input =
          part.state === "output-error" && "rawInput" in part ? part.rawInput : part.input;
        const category = explorationCategory(name);
        if (name === "subagent_delegate") {
          const subagent = subagentFromTool(
            part.toolCallId,
            input,
            part.state === "output-available" ? part.output : undefined,
          );
          append({ id, ...subagentEntry(subagent) });
          subagentIndexes.set(part.toolCallId, entries.length - 1);
          return;
        }
        if (category !== undefined) {
          if (exploration === undefined) {
            exploration = {
              id,
              reads: 0,
              searches: 0,
              failures: 0,
              operations: [],
              pending: new Set(),
            };
            entries.push({ id, ...explorationEntry(exploration) });
          }
          if (category === "read") exploration.reads += 1;
          else exploration.searches += 1;
          exploration.operations.push(explorationOperation(name, input, options));
          if (part.state !== "output-available") {
            if (part.state === "output-error" || part.state === "output-denied") {
              exploration.failures += 1;
            } else {
              exploration.pending.add(id);
            }
          }
          const entryIndex = entries.findIndex((entry) => entry.id === exploration?.id);
          if (entryIndex >= 0)
            entries[entryIndex] = { id: exploration.id, ...explorationEntry(exploration) };
          return;
        }
        const state: ToolRenderState =
          part.state === "output-available"
            ? { status: "success", output: part.output }
            : part.state === "output-error"
              ? { status: "error", errorText: part.errorText }
              : part.state === "output-denied"
                ? { status: "denied" }
                : { status: "active" };
        const entry = toolEntry(name, input, state, options);
        if (entry !== undefined) append({ id, ...entry });
        return;
      }
      if (part.type.startsWith("data-")) {
        const parsed = miniLilacUIMessageDataPartSchema.safeParse(part);
        if (parsed.success && parsed.data.type === "data-subagentStatus") {
          const subagent = subagentFromStatus(parsed.data.data);
          const entryIndex = subagentIndexes.get(subagent.toolCallId);
          if (entryIndex !== undefined) {
            entries[entryIndex] = { id: entries[entryIndex]?.id ?? id, ...subagentEntry(subagent) };
          } else {
            append({ id, ...subagentEntry(subagent) });
            subagentIndexes.set(subagent.toolCallId, entries.length - 1);
          }
          return;
        }
        const entry = dataEntry(part);
        if (entry !== undefined) append({ id, ...entry });
        return;
      }
      if (part.type === "file") {
        append({ id, ...fileEntry(part.mediaType, part.filename) });
        return;
      }
      if (part.type === "source-url") {
        append({ id, ...sourceUrlEntry(part.title, part.url) });
        return;
      }
      if (part.type === "source-document") {
        append({ id, ...sourceDocumentEntry(part.title, part.mediaType, part.filename) });
      }
    });
    return entries;
  });
  return rendered.map((entry, index) => {
    if (entry.exploration === undefined) return entry;
    const latest = index === rendered.length - 1;
    return {
      ...entry,
      tone: entry.exploration.failures > 0 ? "warning" : latest ? "accent" : "normal",
      text: explorationTranscriptText(entry.exploration, latest),
    };
  });
}

/** Maps AI SDK chunks to plain semantic transcript entries for a UI adapter. */
export class ChunkRenderer {
  private readonly toolNames = new Map<string, string>();
  private readonly toolEntryIds = new Map<string, string>();
  private readonly toolSummaries = new Map<string, string>();
  private readonly toolInputs = new Map<string, unknown>();
  private readonly bashOutputByToolId = new Map<string, string>();
  private readonly flattenedBatchToolIds = new Set<string>();
  private readonly explorationByToolId = new Map<string, ExplorationState>();
  private readonly subagents = new Map<string, SubagentTranscript>();
  private exploration: ExplorationState | undefined;
  private readonly reasoningEntries = new Map<string, { id: string; text: string }>();
  private readonly textEntryIds = new Map<string, string>();

  constructor(
    private readonly output: ChunkOutputSink,
    private readonly hooks: ChunkRendererHooks,
    private readonly options: TranscriptRenderOptions = {},
  ) {}

  startRun(): void {
    this.resetTransientState();
  }

  handle(chunk: UIMessageChunk): void {
    if (chunk.type.startsWith("data-")) {
      this.handleData(chunk);
      return;
    }

    switch (chunk.type) {
      case "text-start":
        this.finalizeReasoning();
        return;
      case "text-delta":
        this.finalizeReasoning();
        this.renderTextDelta(chunk.id, chunk.delta);
        return;
      case "text-end":
        this.finishText(chunk.id);
        return;
      case "finish":
        this.finishOpenText();
        this.finalizeReasoning();
        return;
      case "reasoning-start":
        this.startReasoning(chunk.id);
        return;
      case "reasoning-delta":
        this.appendReasoning(chunk.id, chunk.delta);
        return;
      case "reasoning-end":
        this.endReasoning(chunk.id);
        return;
      case "tool-input-start":
        this.renderToolStart(chunk.toolCallId, chunk.toolName);
        return;
      case "tool-input-delta":
        return;
      case "tool-input-available":
        this.renderToolStart(chunk.toolCallId, chunk.toolName, chunk.input, true);
        return;
      case "tool-input-error":
        this.renderToolStart(chunk.toolCallId, chunk.toolName, chunk.input, true);
        this.renderToolError(chunk.toolCallId, chunk.errorText);
        return;
      case "tool-output-available":
        this.renderToolOutput(chunk.toolCallId, chunk.output, chunk.preliminary === true);
        return;
      case "tool-output-error":
        this.renderToolError(chunk.toolCallId, chunk.errorText);
        return;
      case "tool-output-denied":
        this.renderToolDenied(chunk.toolCallId);
        return;
      case "file":
        this.append(fileEntry(chunk.mediaType));
        return;
      case "source-url":
        this.append(sourceUrlEntry(chunk.title, chunk.url));
        return;
      case "source-document":
        this.append(sourceDocumentEntry(chunk.title, chunk.mediaType, chunk.filename));
        return;
      case "error":
        this.finishOpenText();
        this.finalizeReasoning();
        this.append({ kind: "error", tone: "danger", text: chunk.errorText });
        return;
      case "abort":
        this.finishOpenText();
        this.finalizeReasoning();
        this.append({
          kind: "status",
          tone: "muted",
          text: `aborted${chunk.reason !== undefined ? `: ${chunk.reason}` : ""}`,
        });
        return;
      default:
        return;
    }
  }

  private handleData(chunk: UIMessageChunk): void {
    const todos = miniLilacTodoChunkSchema.safeParse(chunk);
    if (todos.success) {
      this.hooks.onTodos?.(todos.data.data);
      return;
    }
    const parsed = miniLilacUIMessageDataPartSchema.safeParse(chunk);
    if (!parsed.success) return;
    const part = parsed.data;
    switch (part.type) {
      case "data-session":
        this.hooks.onSnapshot(part.data);
        return;
      case "data-control":
        this.hooks.onControl?.(part.data);
        this.append({ kind: "status", tone: "muted", text: controlSummary(part.data) });
        return;
      case "data-transcriptReset":
        this.resetTransientState();
        this.hooks.onTranscriptReset(part.data);
        this.append({
          kind: "status",
          tone: "warning",
          text: `transcript rewound (${part.data.reason}); canonical transcript will be reconciled`,
        });
        return;
      case "data-subagentStatus":
        this.renderSubagentStatus(part.data);
        return;
      case "data-compaction":
        this.append({
          kind: "compaction",
          tone: part.data.status === "failed" ? "danger" : "warning",
          text: compactionSummary(part.data),
        });
        return;
    }
  }

  private renderSubagentStatus(status: MiniLilacSubagentStatus): void {
    const subagent = subagentFromStatus(status);
    this.subagents.set(status.toolCallId, subagent);
    let id = this.toolEntryIds.get(status.toolCallId);
    if (id === undefined) {
      this.finalizeReasoning();
      id = this.append(subagentEntry(subagent));
      this.toolEntryIds.set(status.toolCallId, id);
    } else {
      this.output.update(id, subagentEntry(subagent));
    }
  }

  private renderToolStart(
    toolCallId: string,
    toolName: string,
    input?: unknown,
    inputAvailable = false,
  ): void {
    this.toolNames.set(toolCallId, toolName);
    if (inputAvailable) this.toolInputs.set(toolCallId, input);
    this.finalizeReasoning();
    if (toolName === "subagent_result") return;
    if (toolName === "subagent_delegate") {
      const parsed = subagentFromTool(toolCallId, input);
      const existing = this.subagents.get(toolCallId);
      const subagent =
        existing === undefined
          ? parsed
          : { ...existing, profile: parsed.profile, prompt: parsed.prompt, mode: parsed.mode };
      this.subagents.set(toolCallId, subagent);
      const existingId = this.toolEntryIds.get(toolCallId);
      if (existingId === undefined) {
        this.toolEntryIds.set(toolCallId, this.append(subagentEntry(subagent)));
      } else if (inputAvailable) {
        this.output.update(existingId, subagentEntry(subagent));
      }
      return;
    }
    if (toolName === "batch") {
      this.flattenedBatchToolIds.add(toolCallId);
      return;
    }
    const category = explorationCategory(toolName);
    if (category !== undefined) {
      if (!inputAvailable || this.explorationByToolId.has(toolCallId)) return;
      if (this.exploration === undefined) {
        const state: ExplorationState = {
          id: "",
          reads: category === "read" ? 1 : 0,
          searches: category === "search" ? 1 : 0,
          failures: 0,
          operations: [explorationOperation(toolName, input, this.options)],
          pending: new Set([toolCallId]),
        };
        state.id = this.output.append(explorationEntry(state));
        this.exploration = state;
      } else {
        if (category === "read") this.exploration.reads += 1;
        else this.exploration.searches += 1;
        this.exploration.operations.push(explorationOperation(toolName, input, this.options));
        this.exploration.pending.add(toolCallId);
        this.output.update(this.exploration.id, explorationEntry(this.exploration));
      }
      this.explorationByToolId.set(toolCallId, this.exploration);
      this.toolEntryIds.set(toolCallId, this.exploration.id);
      return;
    }
    const summary = toolSummary(toolName, input);
    if (inputAvailable || !this.toolSummaries.has(toolCallId)) {
      this.toolSummaries.set(toolCallId, summary);
    }
    const existingId = this.toolEntryIds.get(toolCallId);
    if (existingId !== undefined) {
      if (inputAvailable) {
        this.output.update(
          existingId,
          toolEntry(toolName, input, { status: "active" }, this.options) ?? {
            kind: "tool",
            tone: "accent",
            text: summary,
          },
        );
      }
      return;
    }
    const entry = toolEntry(toolName, input, { status: "active" }, this.options) ?? {
      kind: "tool" as const,
      tone: "accent" as const,
      text: summary,
    };
    const id = this.append(entry);
    this.toolEntryIds.set(toolCallId, id);
  }

  private renderToolOutput(toolCallId: string, output: unknown, preliminary: boolean): void {
    const name = this.toolNames.get(toolCallId) ?? "tool";
    if (name === "subagent_result") return;
    if (name === "subagent_delegate") {
      if (preliminary) return;
      const existing = this.subagents.get(toolCallId);
      if (existing?.state === "completed" || existing?.state === "cancelled") return;
      const subagent = subagentFromTool(toolCallId, this.toolInputs.get(toolCallId), output);
      const merged = { ...subagent, toolCount: existing?.toolCount ?? subagent.toolCount };
      this.subagents.set(toolCallId, merged);
      const id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) this.toolEntryIds.set(toolCallId, this.append(subagentEntry(merged)));
      else this.output.update(id, subagentEntry(merged));
      return;
    }
    if (preliminary) {
      if (name !== "bash") return;
      const parsed = bashOutputDeltaSchema.safeParse(output);
      if (!parsed.success) return;
      const partial = `${this.bashOutputByToolId.get(toolCallId) ?? ""}${parsed.data.delta}`;
      this.bashOutputByToolId.set(toolCallId, partial);
      let id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) {
        this.renderToolStart(toolCallId, name);
        id = this.toolEntryIds.get(toolCallId);
      }
      if (id === undefined) return;
      this.output.update(
        id,
        toolEntry(
          name,
          this.toolInputs.get(toolCallId),
          { status: "active", output: { stdout: partial } },
          this.options,
        ) ?? { kind: "tool", tone: "accent", text: this.toolSummaries.get(toolCallId) ?? "Bash" },
      );
      return;
    }
    const partial = this.bashOutputByToolId.get(toolCallId);
    this.bashOutputByToolId.delete(toolCallId);
    if (this.flattenedBatchToolIds.has(toolCallId)) return;
    if (this.explorationByToolId.has(toolCallId)) {
      this.settleExploration(toolCallId, false);
      return;
    }
    const id = this.toolEntryIds.get(toolCallId);
    if (id === undefined) {
      this.renderToolStart(toolCallId, name);
      return this.renderToolOutput(toolCallId, output, false);
    }
    this.output.update(
      id,
      toolEntry(
        name,
        this.toolInputs.get(toolCallId),
        {
          status: "success",
          output:
            name === "bash" && !bashOutputSchema.safeParse(output).success && partial !== undefined
              ? { stdout: partial }
              : output,
        },
        this.options,
      ) ?? {
        kind: "tool",
        tone: "success",
        text: this.toolSummaries.get(toolCallId) ?? toolSummary(name, undefined),
      },
    );
  }

  private renderToolError(toolCallId: string, errorText: string): void {
    this.bashOutputByToolId.delete(toolCallId);
    const name = this.toolNames.get(toolCallId) ?? "tool";
    if (name === "subagent_result") return;
    if (name === "subagent_delegate") {
      const existing = this.subagents.get(toolCallId);
      const subagent: SubagentTranscript = {
        ...(existing ?? subagentFromTool(toolCallId, this.toolInputs.get(toolCallId))),
        state: "error",
        error: errorText,
      };
      this.subagents.set(toolCallId, subagent);
      const id = this.toolEntryIds.get(toolCallId);
      if (id === undefined) this.toolEntryIds.set(toolCallId, this.append(subagentEntry(subagent)));
      else this.output.update(id, subagentEntry(subagent));
      return;
    }
    if (this.explorationByToolId.has(toolCallId)) {
      this.settleExploration(toolCallId, true);
      return;
    }
    if (this.flattenedBatchToolIds.has(toolCallId)) {
      this.append(
        toolEntry(
          name,
          this.toolInputs.get(toolCallId),
          { status: "error", errorText },
          this.options,
        ) ?? {
          kind: "error",
          tone: "danger",
          text: toolErrorSummary("Parallel tools", errorText),
        },
      );
      return;
    }
    const id = this.toolEntryIds.get(toolCallId);
    const entry = toolEntry(
      name,
      this.toolInputs.get(toolCallId),
      {
        status: "error",
        errorText,
      },
      this.options,
    ) ?? {
      kind: "error" as const,
      tone: "danger" as const,
      text: toolErrorSummary(
        this.toolSummaries.get(toolCallId) ?? toolSummary(name, undefined),
        errorText,
      ),
    };
    if (id === undefined) this.append(entry);
    else this.output.update(id, entry);
  }

  private renderToolDenied(toolCallId: string): void {
    this.bashOutputByToolId.delete(toolCallId);
    const name = this.toolNames.get(toolCallId) ?? "tool";
    if (name === "subagent_result") return;
    if (this.explorationByToolId.has(toolCallId)) {
      this.settleExploration(toolCallId, true);
      return;
    }
    if (this.flattenedBatchToolIds.has(toolCallId)) return;
    const id = this.toolEntryIds.get(toolCallId);
    const entry = toolEntry(
      name,
      this.toolInputs.get(toolCallId),
      { status: "denied" },
      this.options,
    ) ?? {
      kind: "tool" as const,
      tone: "warning" as const,
      text: `${this.toolSummaries.get(toolCallId) ?? toolSummary(name, undefined)}: denied`,
    };
    if (id === undefined) this.append(entry);
    else this.output.update(id, entry);
  }

  private append(entry: Omit<TranscriptEntry, "id">): string {
    if (entry.kind !== "exploration" && this.exploration !== undefined) {
      this.output.update(this.exploration.id, explorationEntry(this.exploration, false));
      this.exploration = undefined;
    }
    return this.output.append(entry);
  }

  private settleExploration(toolCallId: string, failed: boolean): void {
    const state = this.explorationByToolId.get(toolCallId);
    if (state === undefined) return;
    state.pending.delete(toolCallId);
    if (failed) state.failures += 1;
    this.output.update(state.id, explorationEntry(state, state === this.exploration));
  }

  private startReasoning(chunkId: string): void {
    if (this.reasoningEntries.has(chunkId)) return;
    const id = this.append(reasoningEntry("", false));
    this.reasoningEntries.set(chunkId, { id, text: "" });
  }

  private appendReasoning(chunkId: string, delta: string): void {
    // Codex may stream deltas without an explicit reasoning-start; open lazily.
    const existing = this.reasoningEntries.get(chunkId);
    if (existing === undefined && delta.length === 0) return;
    const entry = existing ?? { id: this.append(reasoningEntry("", false)), text: "" };
    entry.text += delta;
    this.reasoningEntries.set(chunkId, entry);
    this.output.update(entry.id, reasoningEntry(entry.text, false));
  }

  private endReasoning(chunkId: string): void {
    const entry = this.reasoningEntries.get(chunkId);
    if (entry === undefined) return;
    this.output.update(entry.id, reasoningEntry(entry.text, true));
    this.reasoningEntries.delete(chunkId);
  }

  // Codex may omit reasoning-end, so finalize any open entries when a text,
  // tool, or finish boundary is reached. Each chunk keeps its own entry so
  // separate reasoning blocks never merge.
  private finalizeReasoning(): void {
    for (const entry of this.reasoningEntries.values()) {
      this.output.update(entry.id, reasoningEntry(entry.text, true));
    }
    this.reasoningEntries.clear();
  }

  private renderTextDelta(chunkId: string, delta: string): void {
    let id = this.textEntryIds.get(chunkId);
    if (id === undefined) {
      id = this.append({ kind: "assistant", tone: "normal", text: delta, streaming: true });
      this.textEntryIds.set(chunkId, id);
      return;
    }
    this.output.appendText(id, delta);
  }

  private finishText(chunkId: string): void {
    const id = this.textEntryIds.get(chunkId);
    if (id === undefined) return;
    this.output.finish(id);
    this.textEntryIds.delete(chunkId);
  }

  private finishOpenText(): void {
    for (const id of this.textEntryIds.values()) this.output.finish(id);
    this.textEntryIds.clear();
  }

  private resetTransientState(): void {
    this.toolNames.clear();
    this.toolEntryIds.clear();
    this.toolSummaries.clear();
    this.toolInputs.clear();
    this.bashOutputByToolId.clear();
    this.flattenedBatchToolIds.clear();
    this.explorationByToolId.clear();
    this.subagents.clear();
    this.exploration = undefined;
    this.textEntryIds.clear();
    this.reasoningEntries.clear();
  }
}
