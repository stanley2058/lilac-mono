import { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolContent } from "ai";

export const CUSTOM_COMMAND_TEXT_PREFIX = "lilac:";
export const CUSTOM_COMMAND_TOOL_NAME = "custom_command";
export const CUSTOM_COMMAND_PROMPT_ARG_KEY = "prompt";

const COMMAND_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_ARG_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const customCommandArgSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(COMMAND_ARG_KEY_RE, "arg key must be lowercase letters/numbers with hyphen separators"),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().trim().min(1).max(100).optional(),
  required: z.boolean().optional().default(false),
});

export const customCommandDefSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(COMMAND_NAME_RE, "name must be lowercase letters/numbers with hyphen separators"),
    description: z.string().trim().min(1).max(100),
    args: z.array(customCommandArgSchema).max(24).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.args.length; i += 1) {
      const key = value.args[i]?.key;
      if (!key) continue;
      if (key === CUSTOM_COMMAND_PROMPT_ARG_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["args", i, "key"],
          message: `'${CUSTOM_COMMAND_PROMPT_ARG_KEY}' is reserved for transcript prompts`,
        });
      }
      if (!seen.has(key)) {
        seen.add(key);
        continue;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["args", i, "key"],
        message: `duplicate arg key '${key}'`,
      });
    }
  });

export type CustomCommandArgDef = z.infer<typeof customCommandArgSchema>;
export type CustomCommandDef = z.infer<typeof customCommandDefSchema>;
export type CustomCommandResult = Extract<ToolContent[number], { type: "tool-result" }>["output"];

export type CustomCommandContext = {
  cwd: string;
  dataDir: string;
  commandDir: string;
  commandName: string;
  requestId: string;
  sessionId: string;
};

export type CustomCommandModule = {
  execute(
    args: unknown[],
    ctx: CustomCommandContext,
  ): Promise<CustomCommandResult> | CustomCommandResult;
};

export type DiscoveredCustomCommand = {
  def: CustomCommandDef;
  dir: string;
  defPath: string;
  entrypointPath: string;
};

export type InvalidCustomCommand = {
  dir: string;
  defPath?: string;
  reason: string;
};

export type CustomCommandDiscovery =
  | {
      type: "command";
      command: DiscoveredCustomCommand;
    }
  | {
      type: "invalid";
      invalid: InvalidCustomCommand;
    };

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function resolveEntrypoint(dir: string): Promise<string | null> {
  const candidates = [path.join(dir, "index.ts"), path.join(dir, "index.js")];
  for (const filePath of candidates) {
    if (await pathExists(filePath)) return filePath;
  }
  return null;
}

export function resolveCustomCommandsDir(dataDir: string): string {
  return path.join(dataDir, "cmds");
}

export function buildCustomCommandTextName(name: string): string {
  return `${CUSTOM_COMMAND_TEXT_PREFIX}${name}`;
}

export function isValidCustomCommandResult(value: unknown): value is CustomCommandResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>)["type"];
  return type === "json" || type === "error-text" || type === "content";
}

export async function discoverCustomCommands(params: {
  dataDir: string;
}): Promise<CustomCommandDiscovery[]> {
  const root = resolveCustomCommandsDir(params.dataDir);

  let dirents: Dirent[] = [];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return [];
    throw error;
  }

  const out: CustomCommandDiscovery[] = [];
  for (const dirent of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;

    const dir = path.join(root, dirent.name);
    const defPath = path.join(dir, "def.json");

    if (!(await pathExists(defPath))) {
      out.push({
        type: "invalid",
        invalid: {
          dir,
          reason: "missing def.json",
        },
      });
      continue;
    }

    const entrypointPath = await resolveEntrypoint(dir);
    if (!entrypointPath) {
      out.push({
        type: "invalid",
        invalid: {
          dir,
          defPath,
          reason: "missing index.ts or index.js",
        },
      });
      continue;
    }

    try {
      const parsed = customCommandDefSchema.parse(await readJson(defPath));
      out.push({
        type: "command",
        command: {
          def: parsed,
          dir,
          defPath,
          entrypointPath,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      out.push({
        type: "invalid",
        invalid: {
          dir,
          defPath,
          reason: `invalid def.json: ${msg}`,
        },
      });
    }
  }

  return out;
}
