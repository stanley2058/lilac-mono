import { asSchema } from "ai";
import { z } from "zod";

import { formatRemoteDisplayPath, parseSshCwdTarget } from "../ssh/ssh-cwd";
import { bashInputSchema } from "./bash";
import { editFileInputZod, globInputZod, grepInputZod, readFileInputZod } from "./fs/fs";

type ValidationResult<T> = { success: true; value: T } | { success: false; error: Error };

type ZodSafeParseResult<T> = { success: true; data: T } | { success: false; error: unknown };

function isZodSchema(value: unknown): value is {
  safeParse: (input: unknown) => ZodSafeParseResult<unknown>;
} {
  return (
    !!value &&
    typeof value === "object" &&
    "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function safeValidateSync<T>(schema: unknown, value: unknown): T | undefined {
  try {
    if (isZodSchema(schema)) {
      const res = schema.safeParse(value);
      return res.success ? (res.data as T) : undefined;
    }

    const s = asSchema(schema as never);
    const validate = (s as unknown as { validate?: unknown }).validate;
    if (typeof validate !== "function") return undefined;

    const res = (validate as (v: unknown) => unknown)(value);
    if (isPromiseLike(res)) return undefined;

    const parsed = res as ValidationResult<T>;
    return parsed.success ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function truncateEnd(input: string, maxLen: number): string {
  const s = input;
  if (s.length <= maxLen) return s;
  if (maxLen <= 3) return "...".slice(0, maxLen);
  return s.slice(0, maxLen - 3) + "...";
}

function truncateMiddle(input: string, headLen: number, tailLen: number, maxLen: number): string {
  const s = input;
  if (s.length <= maxLen) return s;
  const ellipsis = "...";
  const keep = headLen + tailLen + ellipsis.length;
  if (keep !== maxLen) {
    // Safety: ensure we never exceed maxLen even if caller misconfigures.
    return truncateEnd(s, maxLen);
  }
  return s.slice(0, headLen) + ellipsis + s.slice(-tailLen);
}

const localApplyPatchArgsSchema = z.object({
  patchText: z.string(),
  cwd: z.string().optional(),
});

const subagentDelegateArgsSchema = z.object({
  profile: z.enum(["explore", "general", "self"]).optional(),
  task: z.string().min(1),
  timeoutMs: z.number().optional(),
});

function parseApplyPatchPathsFromPatchText(patchText: string): string[] {
  // Matches tool patch headers like:
  // *** Add File: path
  // *** Update File: path
  // *** Delete File: path
  const re = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)\s*$/gm;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(patchText)) !== null) {
    const p = (m[1] ?? "").trim();
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

type ToolArgsFormatter = (args: unknown) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const DISPLAY_MAX_LEN = 30;
const PATH_HEAD_LEN = 14;
const PATH_TAIL_LEN = 13;

function normalizeRemoteDisplay(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const sshUrlMatch = /^ssh:\/\/([^/]+)(\/.*)?$/i.exec(trimmed);
  if (sshUrlMatch) {
    const host = sshUrlMatch[1] ?? "";
    const remotePath = sshUrlMatch[2] ?? "~";
    return formatRemoteDisplayPath(host, remotePath);
  }

  return trimmed;
}

function normalizeRemoteCwdDisplay(input: string): string {
  const normalized = normalizeRemoteDisplay(input);
  if (!normalized) return "";

  const cwdTarget = parseSshCwdTarget(normalized);
  if (cwdTarget.kind === "ssh") {
    return formatRemoteDisplayPath(cwdTarget.host, cwdTarget.cwd);
  }

  return normalized;
}

const readFileToolArgsFormatter: ToolArgsFormatter = (args) => {
  const parsed = safeValidateSync<{ path: string }>(readFileInputZod, args);
  if (!parsed) return "";

  const p = normalizeRemoteDisplay(parsed.path);
  if (!p) return "";
  return " " + truncateMiddle(p, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN);
};

const TOOL_ARGS_FORMATTERS: Record<string, ToolArgsFormatter> = {
  bash: (args) => {
    const parsed = safeValidateSync<{ command: string; cwd?: string }>(bashInputSchema, args);
    if (!parsed) return "";

    const cmd = parsed.command.replace(/\s+/g, " ").trim();
    if (!cmd) return "";

    const cwd = (parsed.cwd ?? "").trim();
    const cwdTarget = parseSshCwdTarget(cwd);
    const display =
      cwdTarget.kind === "ssh"
        ? `${formatRemoteDisplayPath(cwdTarget.host, cwdTarget.cwd)} ${cmd}`
        : cmd;

    return " " + truncateEnd(display, DISPLAY_MAX_LEN);
  },

  read_file: readFileToolArgsFormatter,

  // Back-compat for older transcripts / callers.
  readFile: readFileToolArgsFormatter,

  glob: (args) => {
    const parsed = safeValidateSync<{ patterns: string[]; cwd?: string }>(globInputZod, args);
    if (!parsed) return "";

    const joinedPatterns = parsed.patterns
      .map((p) => p.trim())
      .filter(Boolean)
      .join(",");
    if (!joinedPatterns) return "";

    const cwd = normalizeRemoteCwdDisplay(parsed.cwd ?? "");
    const raw = cwd ? `${joinedPatterns} ${cwd}` : joinedPatterns;
    const display = raw.replace(/\s+/g, " ").trim();
    return " " + truncateEnd(display, DISPLAY_MAX_LEN);
  },

  grep: (args) => {
    const parsed = safeValidateSync<{ pattern: string; cwd?: string }>(grepInputZod, args);
    if (!parsed) return "";

    const pattern = parsed.pattern.replace(/\s+/g, " ").trim();
    if (!pattern) return "";

    const cwd = normalizeRemoteCwdDisplay(parsed.cwd ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const raw = cwd ? `${pattern} ${cwd}` : pattern;
    return " " + truncateEnd(raw, DISPLAY_MAX_LEN);
  },

  subagent_delegate: (args) => {
    const parsed = safeValidateSync<{ task: string }>(subagentDelegateArgsSchema, args);
    if (!parsed) return "";
    const task = parsed.task.replace(/\s+/g, " ").trim();
    if (!task) return "";
    return " " + truncateEnd(task, DISPLAY_MAX_LEN);
  },

  apply_patch: (args) => {
    const localParsed = safeValidateSync<{ patchText: string }>(localApplyPatchArgsSchema, args);
    if (!localParsed) return "";

    const paths = parseApplyPatchPathsFromPatchText(localParsed.patchText);
    const first = (paths[0] ?? "").trim();
    if (!first) return "";

    const remaining = Math.max(0, paths.length - 1);
    const suffix = remaining > 0 ? ` (+${remaining})` : "";
    return " " + truncateMiddle(first, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN) + suffix;
  },

  edit_file: (args) => {
    const parsed = safeValidateSync<{ path: string }>(editFileInputZod, args);
    if (!parsed) return "";

    const p = normalizeRemoteDisplay(parsed.path);
    if (!p) return "";
    return " " + truncateMiddle(p, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN);
  },

  batch: (args) => {
    if (!isRecord(args)) return "";
    const calls = args["tool_calls"];
    if (!Array.isArray(calls)) return "";
    const n = calls.length;
    if (!Number.isFinite(n) || n <= 0) return "";
    return ` (${n} tools)`;
  },
};

export function formatToolArgsForDisplay(toolName: string, args: unknown): string {
  const f = TOOL_ARGS_FORMATTERS[toolName];
  if (!f) return "";
  try {
    return f(args);
  } catch {
    return "";
  }
}
