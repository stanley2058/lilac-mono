import { createLogger } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import path from "node:path";

const logger = createLogger({ module: "tool:env" });

const MAX_TOOL_ENV_FILE_BYTES = 64 * 1024;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_PREFIXES = ["LILAC_", "LD_", "DYLD_", "NODE_", "BUN_"] as const;
const RESERVED_NAMES = new Set([
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

type ToolEnvEntry = string | { value: string; expiresAt?: string | number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function parseEntry(name: string, raw: unknown, now: number): ToolEnvEntry | null {
  if (typeof raw === "string") return raw;
  if (!isRecord(raw) || typeof raw.value !== "string") {
    logger.warn("tool env entry ignored: expected a string or object with a string value", {
      name,
    });
    return null;
  }

  const expiresAt = raw.expiresAt;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "string" && typeof expiresAt !== "number") {
      logger.warn("tool env entry ignored: expiresAt must be a string or number", { name });
      return null;
    }

    const expiresAtMs = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) {
      logger.warn("tool env entry ignored: expiresAt is invalid", { name });
      return null;
    }
    if (now >= expiresAtMs) return null;
  }

  return { value: raw.value, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

export function parseToolEnv(raw: unknown, now = Date.now()): Record<string, string> {
  if (!isRecord(raw)) {
    throw new Error("tool env must be a JSON object");
  }

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
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
    const resolved = typeof parsed === "string" ? parsed : parsed.value;
    if (resolved.includes("\0")) {
      logger.warn("tool env entry ignored: value contains a null byte", { name });
      continue;
    }
    result[name] = resolved;
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
