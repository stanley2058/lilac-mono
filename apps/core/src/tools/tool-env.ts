import { createLogger } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const logger = createLogger({ module: "tool:env" });

const MAX_TOOL_ENV_FILE_BYTES = 64 * 1024;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_PREFIXES = ["LILAC_", "LD_", "DYLD_", "NODE_", "BUN_"] as const;
const RESERVED_NAMES = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "CDPATH",
  "ENV",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "PATH",
  "HOME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "DATA_DIR",
  "TOOL_SERVER_BACKEND_URL",
  "GIT_CONFIG_GLOBAL",
  "GNUPGHOME",
  "FORCE_COLOR",
  "NO_COLOR",
  "REDIS_URL",
]);

const toolEnvFileSchema = z.record(z.string(), z.unknown());
const expiresAtSchema = z
  .union([z.string(), z.number().finite()])
  .refine((value) => Number.isFinite(new Date(value).getTime()), {
    message: "expiresAt must be a valid date string or epoch-millisecond number",
  });
const toolEnvEntrySchema = z.union([
  z.string(),
  z
    .object({
      value: z.string(),
      expiresAt: expiresAtSchema.optional(),
    })
    .strict(),
]);

function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function parseEntry(name: string, raw: unknown, now: number): string | null {
  const parsed = toolEnvEntrySchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("tool env entry ignored: validation failed", { name });
    return null;
  }

  if (typeof parsed.data === "string") return parsed.data;
  if (parsed.data.expiresAt !== undefined) {
    const expiresAtMs = new Date(parsed.data.expiresAt).getTime();
    if (now >= expiresAtMs) return null;
  }

  return parsed.data.value;
}

export function parseToolEnv(raw: unknown, now = Date.now()): Record<string, string> {
  const parsedFile = toolEnvFileSchema.parse(raw);

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsedFile)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      logger.warn("tool env entry ignored: invalid environment variable name", { name });
      continue;
    }
    if (isReservedName(name)) {
      logger.warn("tool env entry ignored: reserved environment variable", { name });
      continue;
    }

    const parsed = parseEntry(name, value, now);
    if (parsed === null) continue;
    if (parsed.includes("\0")) {
      logger.warn("tool env entry ignored: value contains a null byte", { name });
      continue;
    }
    result[name] = parsed;
  }

  return result;
}

export async function loadToolEnv(dataDir: string): Promise<Record<string, string>> {
  const filePath = path.join(dataDir, "secret", "tool-env.jsonc");

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      logger.warn("tool env ignored: path is not a regular file", { filePath });
      return {};
    }
    if (stat.size > MAX_TOOL_ENV_FILE_BYTES) {
      logger.warn("tool env ignored: file exceeds size limit", {
        filePath,
        maxBytes: MAX_TOOL_ENV_FILE_BYTES,
      });
      return {};
    }
    if ((stat.mode & 0o077) !== 0) {
      logger.warn("tool env file is accessible by group or others; mode 0600 is recommended", {
        filePath,
      });
    }

    const content = await fs.readFile(filePath, "utf8");
    return parseToolEnv(Bun.JSONC.parse(content));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    logger.warn("tool env ignored: failed to read or validate file", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
