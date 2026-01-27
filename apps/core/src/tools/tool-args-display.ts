import { asSchema } from "ai";
import { z } from "zod";

import { bashInputSchema } from "./bash";
import { readFileInputZod } from "./fs/fs";

type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; error: Error };

type ZodSafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown };

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

function truncateMiddle(
  input: string,
  headLen: number,
  tailLen: number,
  maxLen: number,
): string {
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

const openAiApplyPatchArgsSchema = z.object({
  callId: z.string(),
  operation: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("create_file"),
      path: z.string(),
      diff: z.string(),
    }),
    z.object({
      type: z.literal("update_file"),
      path: z.string(),
      diff: z.string(),
    }),
    z.object({
      type: z.literal("delete_file"),
      path: z.string(),
    }),
  ]),
});

const localApplyPatchArgsSchema = z.object({
  patchText: z.string(),
  cwd: z.string().optional(),
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

const TOOL_ARGS_FORMATTERS: Record<string, ToolArgsFormatter> = {
  bash: (args) => {
    const parsed = safeValidateSync<{ command: string }>(bashInputSchema, args);
    if (!parsed) return "";

    const cmd = parsed.command.replace(/\s+/g, " ").trim();
    if (!cmd) return "";
    return " " + truncateEnd(cmd, 20);
  },

  read_file: (args) => {
    const parsed = safeValidateSync<{ path: string }>(readFileInputZod, args);
    if (!parsed) return "";

    const p = parsed.path.trim();
    if (!p) return "";
    return " " + truncateMiddle(p, 7, 10, 20);
  },

  // Back-compat for older transcripts / callers.
  readFile: (args) => TOOL_ARGS_FORMATTERS.read_file(args),

  apply_patch: (args) => {
    const openaiParsed = safeValidateSync<
      { operation: { path: string } }
    >(openAiApplyPatchArgsSchema, args);
    if (openaiParsed) {
      const p = openaiParsed.operation.path.trim();
      return p ? " " + truncateMiddle(p, 7, 10, 20) : "";
    }

    const localParsed = safeValidateSync<{ patchText: string }>(
      localApplyPatchArgsSchema,
      args,
    );
    if (!localParsed) return "";

    const paths = parseApplyPatchPathsFromPatchText(localParsed.patchText);
    const first = (paths[0] ?? "").trim();
    if (!first) return "";

    const remaining = Math.max(0, paths.length - 1);
    const suffix = remaining > 0 ? ` (+${remaining})` : "";
    return " " + truncateMiddle(first, 7, 10, 20) + suffix;
  },
};

export function formatToolArgsForDisplay(
  toolName: string,
  args: unknown,
): string {
  const f = TOOL_ARGS_FORMATTERS[toolName];
  if (!f) return "";
  try {
    return f(args);
  } catch {
    return "";
  }
}
