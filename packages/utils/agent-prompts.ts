import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { z } from "zod";

import { findWorkspaceRoot } from "./find-root";

export const DEFAULT_PROMPT_DIRNAME = "prompts";
export const HEARTBEAT_PROMPT_FILENAME = "HEARTBEAT.md";
export const HEARTBEAT_PROMPT_DIRNAME = "heartbeat";

export type PromptFile = {
  name: string;
  path: string;
  content: string;
};

export type HeartbeatPromptPaths = {
  promptDir: string;
  heartbeatFilePath: string;
  heartbeatDir: string;
  inboxDir: string;
  archiveDir: string;
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
export const PROMPT_TEMPLATE_BASELINE_DIRNAME = ".prompt-template-baselines";

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
    upstreamDiffPath?: string;
    mergedPath?: string;
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

const promptTemplateStateEntrySchema = z.object({
  status: z.enum(["managed", "customized"]),
  templateHash: z.string().min(1),
  appliedHash: z.string().optional(),
});

const promptTemplateStateSchema = z.object({
  schemaVersion: z.literal(PROMPT_TEMPLATE_STATE_SCHEMA_VERSION),
  templateBundleHash: z.string().min(1),
  files: z.record(z.string(), promptTemplateStateEntrySchema).default({}),
});

function templatePath(name: CorePromptFileName): string {
  return path.join(import.meta.dir, "prompt-templates", name);
}

function heartbeatTemplatePath(): string {
  return path.join(import.meta.dir, "prompt-templates", HEARTBEAT_PROMPT_FILENAME);
}

export function resolvePromptDir(options?: { dataDir?: string }): string {
  const dataDir =
    options?.dataDir ?? process.env.DATA_DIR ?? path.resolve(findWorkspaceRoot(), "data");
  return path.join(dataDir, DEFAULT_PROMPT_DIRNAME);
}

export function resolveHeartbeatPromptPaths(options?: { dataDir?: string }): HeartbeatPromptPaths {
  const promptDir = resolvePromptDir(options);
  const heartbeatDir = path.join(promptDir, HEARTBEAT_PROMPT_DIRNAME);

  return {
    promptDir,
    heartbeatFilePath: path.join(promptDir, HEARTBEAT_PROMPT_FILENAME),
    heartbeatDir,
    inboxDir: path.join(heartbeatDir, "inbox"),
    archiveDir: path.join(heartbeatDir, "archive"),
  };
}

async function ensureHeartbeatWorkspace(options?: { dataDir?: string }): Promise<void> {
  const paths = resolveHeartbeatPromptPaths(options);
  await safeMkdir(paths.heartbeatDir);
  await safeMkdir(paths.inboxDir);
  await safeMkdir(paths.archiveDir);

  if (!(await exists(paths.heartbeatFilePath))) {
    await Bun.write(paths.heartbeatFilePath, await Bun.file(heartbeatTemplatePath()).text());
  }
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

function parsePromptTemplateState(raw: string): PromptTemplateState | null {
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const parsed = promptTemplateStateSchema.safeParse(parsedRaw);
  if (!parsed.success) return null;

  const files: Partial<Record<CorePromptFileName, PromptTemplateStateEntry>> = {};
  for (const name of CORE_PROMPT_FILES) {
    const entry = parsed.data.files[name];
    if (entry) {
      files[name] = entry;
    }
  }

  return {
    schemaVersion: PROMPT_TEMPLATE_STATE_SCHEMA_VERSION,
    templateBundleHash: parsed.data.templateBundleHash,
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

function promptTemplateBaselinePath(promptDir: string, name: CorePromptFileName): string {
  return path.join(promptDir, PROMPT_TEMPLATE_BASELINE_DIRNAME, name);
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return null;
  }
}

async function loadPreviousTemplateContent(params: {
  promptDir: string;
  name: CorePromptFileName;
  expectedHash: string | undefined;
  fallbackNewPath: string;
}): Promise<string | null> {
  if (!params.expectedHash) return null;

  const baseline = await readTextIfExists(
    promptTemplateBaselinePath(params.promptDir, params.name),
  );
  if (baseline !== null && sha256HexText(baseline) === params.expectedHash) {
    return baseline;
  }

  const previousNew = await readTextIfExists(params.fallbackNewPath);
  if (previousNew !== null && sha256HexText(previousNew) === params.expectedHash) {
    return previousNew;
  }

  return null;
}

async function writeTemplateBaseline(params: {
  promptDir: string;
  name: CorePromptFileName;
  content: string;
}): Promise<void> {
  const baselinePath = promptTemplateBaselinePath(params.promptDir, params.name);
  await safeMkdir(path.dirname(baselinePath));
  await writeTextIfChanged({ filePath: baselinePath, content: params.content });
}

type GitResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runGit(args: readonly string[]): Promise<GitResult | null> {
  const git = Bun.which("git");
  if (!git) return null;

  const proc = Bun.spawn([git, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { code, stdout, stderr };
}

function normalizeGitArtifactPaths(
  text: string,
  replacements: readonly [string, string][],
): string {
  let normalized = text;
  for (const [from, to] of replacements) {
    normalized = normalized.split(from).join(to);
  }
  return normalized;
}

async function withTemporaryTemplateFiles<T>(params: {
  name: CorePromptFileName;
  oldContent: string;
  newContent: string;
  run: (paths: { oldPath: string; newPath: string }) => Promise<T>;
}): Promise<T> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "lilac-prompt-template-"));
  try {
    const oldPath = path.join(dir, `upstream-before-${params.name}`);
    const newPath = path.join(dir, `upstream-after-${params.name}`);
    await Bun.write(oldPath, params.oldContent);
    await Bun.write(newPath, params.newContent);
    return await params.run({ oldPath, newPath });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function buildUpstreamTemplatePatch(params: {
  name: CorePromptFileName;
  oldContent: string;
  newContent: string;
}): Promise<string | null> {
  if (params.oldContent === params.newContent) return null;

  return withTemporaryTemplateFiles({
    name: params.name,
    oldContent: params.oldContent,
    newContent: params.newContent,
    run: async ({ oldPath, newPath }) => {
      const result = await runGit(["diff", "--no-index", "--no-prefix", "--", oldPath, newPath]);
      if (!result || (result.code !== 0 && result.code !== 1) || result.stdout.length === 0) {
        return null;
      }

      const normalized = normalizeGitArtifactPaths(result.stdout, [
        [oldPath, `upstream-before/${params.name}`],
        [newPath, `upstream-after/${params.name}`],
        [oldPath.replace(/^\//u, ""), `upstream-before/${params.name}`],
        [newPath.replace(/^\//u, ""), `upstream-after/${params.name}`],
      ]);
      return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    },
  });
}

async function buildMergedPromptCandidate(params: {
  name: CorePromptFileName;
  currentPath: string;
  oldContent: string;
  newContent: string;
}): Promise<string | null> {
  return withTemporaryTemplateFiles({
    name: params.name,
    oldContent: params.oldContent,
    newContent: params.newContent,
    run: async ({ oldPath, newPath }) => {
      const result = await runGit([
        "merge-file",
        "-p",
        "-L",
        `current/${params.name}`,
        "-L",
        `upstream-before/${params.name}`,
        "-L",
        `upstream-after/${params.name}`,
        params.currentPath,
        oldPath,
        newPath,
      ]);
      if (!result || (result.code !== 0 && result.code !== 1)) return null;
      return result.stdout;
    },
  });
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
  await ensureHeartbeatWorkspace({ dataDir: options?.dataDir });

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
      await writeTemplateBaseline({ promptDir, name, content: template.content });
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
      await writeTemplateBaseline({ promptDir, name, content: template.content });
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
      await writeTemplateBaseline({ promptDir, name, content: template.content });
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
      await writeTemplateBaseline({ promptDir, name, content: template.content });
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

    const previousTemplateContent = templateChanged
      ? await loadPreviousTemplateContent({
          promptDir,
          name,
          expectedHash: previousEntry?.templateHash,
          fallbackNewPath: newPath,
        })
      : null;

    let newFileCreated = false;
    if (shouldWriteNewFile) {
      const result = await writeTextIfChanged({ filePath: newPath, content: template.content });
      newFileCreated = result.created;
    }

    let upstreamDiffPath: string | undefined;
    let mergedPath: string | undefined;
    if (shouldWriteNewFile && previousTemplateContent !== null) {
      const patch = await buildUpstreamTemplatePatch({
        name,
        oldContent: previousTemplateContent,
        newContent: template.content,
      });
      if (patch !== null) {
        upstreamDiffPath = `${dst}.upstream.patch`;
        await writeTextIfChanged({ filePath: upstreamDiffPath, content: patch });
      }

      const merged = await buildMergedPromptCandidate({
        name,
        currentPath: dst,
        oldContent: previousTemplateContent,
        newContent: template.content,
      });
      if (merged !== null) {
        mergedPath = `${dst}.merged`;
        await writeTextIfChanged({ filePath: mergedPath, content: merged });
      }
    }

    await writeTemplateBaseline({ promptDir, name, content: template.content });

    ensured.push({
      name,
      path: dst,
      created: false,
      overwritten: false,
      updated: false,
      dirtyDetected: true,
      newFileCreated,
      ...(shouldWriteNewFile ? { newPath } : {}),
      ...(upstreamDiffPath ? { upstreamDiffPath } : {}),
      ...(mergedPath ? { mergedPath } : {}),
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
