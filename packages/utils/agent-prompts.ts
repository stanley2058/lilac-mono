import path from "node:path";
import fs from "node:fs/promises";

import { findWorkspaceRoot } from "./find-root";

export const DEFAULT_PROMPT_DIRNAME = "prompts";

export type PromptFile = {
  name: string;
  path: string;
  content: string;
};

export const CORE_PROMPT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
] as const;

export type CorePromptFileName = (typeof CORE_PROMPT_FILES)[number];

type EnsureResult = {
  promptDir: string;
  ensured: { name: string; path: string; created: boolean }[];
};

function templatePath(name: CorePromptFileName): string {
  return path.join(import.meta.dir, "prompt-templates", name);
}

export function resolvePromptDir(options?: { dataDir?: string }): string {
  const dataDir =
    options?.dataDir ??
    process.env.DATA_DIR ??
    path.resolve(findWorkspaceRoot(), "data");
  return path.join(dataDir, DEFAULT_PROMPT_DIRNAME);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await Bun.file(filePath).stat();
    return true;
  } catch {
    return false;
  }
}

async function safeMkdir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyIfMissing(params: {
  from: string;
  to: string;
}): Promise<{ created: boolean }> {
  if (await exists(params.to)) return { created: false };

  const content = await Bun.file(params.from).text();
  await Bun.write(params.to, content);
  return { created: true };
}

export async function ensurePromptWorkspace(options?: {
  dataDir?: string;
}): Promise<EnsureResult> {
  const promptDir = resolvePromptDir({ dataDir: options?.dataDir });
  await safeMkdir(promptDir);

  const ensured: EnsureResult["ensured"] = [];
  for (const name of CORE_PROMPT_FILES) {
    const dst = path.join(promptDir, name);
    const src = templatePath(name);
    const { created } = await copyIfMissing({ from: src, to: dst });
    ensured.push({ name, path: dst, created });
  }

  return { promptDir, ensured };
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;

  const idx = raw.indexOf("\n---");
  if (idx === -1) return raw;

  const after = raw.slice(idx + "\n---".length);
  return after.replace(/^\s+/, "");
}

export async function loadPromptFiles(options?: {
  dataDir?: string;
}): Promise<PromptFile[]> {
  const { promptDir } = await ensurePromptWorkspace({ dataDir: options?.dataDir });

  const files: PromptFile[] = [];
  for (const name of CORE_PROMPT_FILES) {
    const filePath = path.join(promptDir, name);
    const contentRaw = await Bun.file(filePath).text();
    const content = stripFrontmatter(contentRaw).trim();
    files.push({ name, path: filePath, content });
  }

  return files;
}

export function compileSystemPromptFromFiles(files: readonly PromptFile[]): string {
  const lines: string[] = [];

  lines.push("You are Lilac.");
  lines.push("");
  lines.push("Your system behavior is defined by a set of workspace prompt files.");
  lines.push("These files are loaded from the local data directory and are authoritative.");
  lines.push("");
  lines.push("How to use the files:");
  lines.push("- AGENTS.md: operating rules and priorities (how you work)");
  lines.push("- SOUL.md: persona and boundaries (tone, what not to do)");
  lines.push("- TOOLS.md: tool usage notes (does not grant tools)");
  lines.push("- IDENTITY.md: short identity card (name/role/vibe)");
  lines.push("- USER.md: user preferences and defaults");
  lines.push("");
  lines.push("If instructions conflict, follow this precedence order:");
  lines.push("AGENTS.md > SOUL.md > TOOLS.md > IDENTITY.md > USER.md");
  lines.push("");

  lines.push("# Project Context");

  for (const f of files) {
    lines.push("");
    lines.push(`## ${f.name}`);
    lines.push(f.content.length > 0 ? f.content : "(empty)");
  }

  return lines.join("\n").trim();
}

export async function buildAgentSystemPrompt(options?: {
  dataDir?: string;
}): Promise<{
  systemPrompt: string;
  promptDir: string;
  filePaths: string[];
}> {
  const files = await loadPromptFiles({ dataDir: options?.dataDir });
  return {
    systemPrompt: compileSystemPromptFromFiles(files),
    promptDir: resolvePromptDir({ dataDir: options?.dataDir }),
    filePaths: files.map((f) => f.path),
  };
}

export async function promptWorkspaceSignature(options?: {
  dataDir?: string;
}): Promise<{
  promptDir: string;
  maxMtimeMs: number | null;
}> {
  const promptDir = resolvePromptDir({ dataDir: options?.dataDir });

  let maxMtimeMs: number | null = null;

  for (const name of CORE_PROMPT_FILES) {
    const p = path.join(promptDir, name);
    try {
      const stat = await Bun.file(p).stat();
      maxMtimeMs = Math.max(maxMtimeMs ?? 0, stat.mtimeMs);
    } catch {
      // Missing files will be created by ensurePromptWorkspace(); signature remains stable.
      continue;
    }
  }

  return { promptDir, maxMtimeMs };
}
