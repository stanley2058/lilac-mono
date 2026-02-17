import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

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
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "TOOLS.md",
] as const;

export const PROMPT_TEMPLATE_STATE_FILENAME = ".prompt-template-state.json";

const PROMPT_TEMPLATE_STATE_SCHEMA_VERSION = 1 as const;

export type CorePromptFileName = (typeof CORE_PROMPT_FILES)[number];

type EnsureResult = {
  promptDir: string;
  ensured: {
    name: string;
    path: string;
    created: boolean;
    overwritten: boolean;
    updated: boolean;
    dirtyDetected: boolean;
    newFileCreated: boolean;
    newPath?: string;
  }[];
};

type PromptTemplateStateEntry = {
  status: "managed" | "customized";
  templateHash: string;
  appliedHash?: string;
};

type PromptTemplateState = {
  schemaVersion: typeof PROMPT_TEMPLATE_STATE_SCHEMA_VERSION;
  templateBundleHash: string;
  files: Partial<Record<CorePromptFileName, PromptTemplateStateEntry>>;
};

function templatePath(name: CorePromptFileName): string {
  return path.join(import.meta.dir, "prompt-templates", name);
}

export function resolvePromptDir(options?: { dataDir?: string }): string {
  const dataDir =
    options?.dataDir ?? process.env.DATA_DIR ?? path.resolve(findWorkspaceRoot(), "data");
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

function sha256HexText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseStateEntry(raw: unknown): PromptTemplateStateEntry | null {
  if (!isRecord(raw)) return null;

  const status = raw.status;
  if (status !== "managed" && status !== "customized") {
    return null;
  }

  const templateHash = raw.templateHash;
  if (typeof templateHash !== "string" || templateHash.length === 0) {
    return null;
  }

  const appliedRaw = raw.appliedHash;
  if (typeof appliedRaw !== "undefined" && typeof appliedRaw !== "string") {
    return null;
  }

  return {
    status,
    templateHash,
    ...(typeof appliedRaw === "string" ? { appliedHash: appliedRaw } : {}),
  };
}

function parsePromptTemplateState(raw: string): PromptTemplateState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== PROMPT_TEMPLATE_STATE_SCHEMA_VERSION) {
    return null;
  }

  const templateBundleHash = parsed.templateBundleHash;
  if (typeof templateBundleHash !== "string" || templateBundleHash.length === 0) {
    return null;
  }

  const filesRaw = parsed.files;
  if (!isRecord(filesRaw)) {
    return null;
  }

  const files: Partial<Record<CorePromptFileName, PromptTemplateStateEntry>> = {};
  for (const name of CORE_PROMPT_FILES) {
    const entry = parseStateEntry(filesRaw[name]);
    if (entry) {
      files[name] = entry;
    }
  }

  return {
    schemaVersion: PROMPT_TEMPLATE_STATE_SCHEMA_VERSION,
    templateBundleHash,
    files,
  };
}

async function loadPromptTemplateState(promptDir: string): Promise<PromptTemplateState | null> {
  const statePath = path.join(promptDir, PROMPT_TEMPLATE_STATE_FILENAME);

  let raw: string;
  try {
    raw = await Bun.file(statePath).text();
  } catch {
    return null;
  }

  return parsePromptTemplateState(raw);
}

async function writePromptTemplateState(
  promptDir: string,
  state: PromptTemplateState,
): Promise<void> {
  const statePath = path.join(promptDir, PROMPT_TEMPLATE_STATE_FILENAME);
  await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function writeTextIfChanged(params: {
  filePath: string;
  content: string;
}): Promise<{ written: boolean; created: boolean }> {
  const existed = await exists(params.filePath);
  if (existed) {
    const current = await Bun.file(params.filePath).text();
    if (current === params.content) {
      return { written: false, created: false };
    }
  }

  await Bun.write(params.filePath, params.content);
  return { written: true, created: !existed };
}

function computeTemplateBundleHash(
  templates: Record<CorePromptFileName, { hash: string }>,
): string {
  const h = createHash("sha256");
  for (const name of CORE_PROMPT_FILES) {
    h.update(name);
    h.update(":");
    h.update(templates[name].hash);
    h.update("\n");
  }
  return h.digest("hex");
}

export async function ensurePromptWorkspace(options?: {
  dataDir?: string;
  overwrite?: boolean;
}): Promise<EnsureResult> {
  const promptDir = resolvePromptDir({ dataDir: options?.dataDir });
  await safeMkdir(promptDir);

  const previousState = await loadPromptTemplateState(promptDir);

  const templatesByName = Object.fromEntries(
    await Promise.all(
      CORE_PROMPT_FILES.map(async (name) => {
        const content = await Bun.file(templatePath(name)).text();
        return [name, { content, hash: sha256HexText(content) }] as const;
      }),
    ),
  ) as Record<CorePromptFileName, { content: string; hash: string }>;

  const nextStateFiles: Partial<Record<CorePromptFileName, PromptTemplateStateEntry>> = {};
  const templateBundleHash = computeTemplateBundleHash(templatesByName);

  const ensured: EnsureResult["ensured"] = [];

  for (const name of CORE_PROMPT_FILES) {
    const dst = path.join(promptDir, name);
    const newPath = `${dst}.new`;
    const template = templatesByName[name];
    const previousEntry = previousState?.files[name];
    const templateChanged =
      typeof previousEntry?.templateHash === "string" &&
      previousEntry.templateHash !== template.hash;
    const shouldWriteNewFile = templateChanged || typeof previousEntry === "undefined";

    const currentExists = await exists(dst);
    const currentContent = currentExists ? await Bun.file(dst).text() : null;
    const currentHash = currentContent === null ? null : sha256HexText(currentContent);

    if (options?.overwrite) {
      await Bun.write(dst, template.content);
      ensured.push({
        name,
        path: dst,
        created: !currentExists,
        overwritten: currentExists,
        updated: false,
        dirtyDetected: false,
        newFileCreated: false,
      });
      nextStateFiles[name] = {
        status: "managed",
        templateHash: template.hash,
        appliedHash: template.hash,
      };
      continue;
    }

    if (currentContent === null) {
      await Bun.write(dst, template.content);
      ensured.push({
        name,
        path: dst,
        created: true,
        overwritten: false,
        updated: false,
        dirtyDetected: false,
        newFileCreated: false,
      });
      nextStateFiles[name] = {
        status: "managed",
        templateHash: template.hash,
        appliedHash: template.hash,
      };
      continue;
    }

    if (currentHash === template.hash) {
      ensured.push({
        name,
        path: dst,
        created: false,
        overwritten: false,
        updated: false,
        dirtyDetected: false,
        newFileCreated: false,
      });
      nextStateFiles[name] = {
        status: "managed",
        templateHash: template.hash,
        appliedHash: template.hash,
      };
      continue;
    }

    const managedAndUnchangedSinceLastApply =
      previousEntry?.status === "managed" &&
      typeof previousEntry.appliedHash === "string" &&
      currentHash === previousEntry.appliedHash;

    if (managedAndUnchangedSinceLastApply && templateChanged) {
      await Bun.write(dst, template.content);
      ensured.push({
        name,
        path: dst,
        created: false,
        overwritten: true,
        updated: true,
        dirtyDetected: false,
        newFileCreated: false,
      });
      nextStateFiles[name] = {
        status: "managed",
        templateHash: template.hash,
        appliedHash: template.hash,
      };
      continue;
    }

    let newFileCreated = false;
    if (shouldWriteNewFile) {
      const result = await writeTextIfChanged({ filePath: newPath, content: template.content });
      newFileCreated = result.created;
    }

    ensured.push({
      name,
      path: dst,
      created: false,
      overwritten: false,
      updated: false,
      dirtyDetected: true,
      newFileCreated,
      ...(shouldWriteNewFile ? { newPath } : {}),
    });

    nextStateFiles[name] = {
      status: "customized",
      templateHash: template.hash,
    };
  }

  await writePromptTemplateState(promptDir, {
    schemaVersion: PROMPT_TEMPLATE_STATE_SCHEMA_VERSION,
    templateBundleHash,
    files: nextStateFiles,
  });

  return { promptDir, ensured };
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;

  const idx = raw.indexOf("\n---");
  if (idx === -1) return raw;

  const after = raw.slice(idx + "\n---".length);
  return after.replace(/^\s+/, "");
}

export async function loadPromptFiles(options?: { dataDir?: string }): Promise<PromptFile[]> {
  const { promptDir } = await ensurePromptWorkspace({
    dataDir: options?.dataDir,
  });

  const files: PromptFile[] = [];
  for (const name of CORE_PROMPT_FILES) {
    const filePath = path.join(promptDir, name);
    const contentRaw = await Bun.file(filePath).text();
    const content = stripFrontmatter(contentRaw).trim();
    files.push({ name, path: filePath, content });
  }

  return files;
}

export function compileSystemPromptFromFiles(
  files: readonly PromptFile[],
  basePrompt?: string,
): string {
  const lines: string[] = basePrompt ? [basePrompt] : [];

  lines.push("Your system behavior is defined by a set of workspace prompt files.");
  lines.push("These files are loaded from the local data directory and are authoritative.");
  lines.push("");

  for (const f of files) {
    lines.push(`# ${f.name} (${f.path})`);
    lines.push(f.content.length > 0 ? f.content : "(empty)");
  }

  return lines.join("\n").trim();
}

export async function buildAgentSystemPrompt(options?: {
  dataDir?: string;
  basePrompt?: string;
}): Promise<{
  systemPrompt: string;
  promptDir: string;
  filePaths: string[];
}> {
  const files = await loadPromptFiles({ dataDir: options?.dataDir });
  return {
    systemPrompt: compileSystemPromptFromFiles(files, options?.basePrompt),
    promptDir: resolvePromptDir({ dataDir: options?.dataDir }),
    filePaths: files.map((f) => f.path),
  };
}

export async function promptWorkspaceSignature(options?: { dataDir?: string }): Promise<{
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
