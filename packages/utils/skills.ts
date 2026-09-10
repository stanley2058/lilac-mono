import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { captureResultOutcome, errorMessage, isPanic, settlePromiseResult } from "./runtime-utils";

export type SkillSource =
  | "lilac-builtin"
  | "lilac-data"
  | "claude-project"
  | "cursor-project"
  | "copilot-project"
  | "copilot-project-legacy"
  | "codex-project"
  | "opencode-project"
  | "agent-project"
  | "gemini-project"
  | "windsurf-project"
  | "claude-user"
  | "cursor-user"
  | "copilot-user"
  | "agent-user"
  | "codex-user"
  | "opencode-user"
  | "gemini-user";

export type DiscoveredSkill = {
  name: string;
  description: string;
  location: string;
  baseDir: string;
  source: SkillSource;
  disableModelInvocation?: boolean;
};

export type SkillWarning = {
  location: string;
  message: string;
};

export type DiscoverSkillsResult = {
  skills: DiscoveredSkill[];
  warnings: SkillWarning[];
};

export const DEFAULT_SKILL_DESCRIPTION_MAX_CHARS = 512;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export class SkillFilesystemError extends TaggedError("SkillFilesystemError")<{
  readonly operation: "access" | "open-directory" | "open-file" | "read-file" | "close-file";
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SkillReadAndCleanupFailed extends TaggedError("SkillReadAndCleanupFailed")<{
  readonly path: string;
  readonly readError: SkillFilesystemError;
  readonly cleanupError: SkillFilesystemError;
  readonly message: string;
}> {}

async function pathExists(p: string): Promise<boolean> {
  const settlement = await settlePromiseResult(() => fs.access(p));
  if (settlement.kind === "panic") throw settlement.panic;
  return settlement.kind === "value";
}

async function scanSkillPathsBounded(
  root: SkillScanRoot,
  baseDir: string,
  maxEntries: number,
): Promise<{ paths: string[]; scannedEntries: number; truncated: boolean }> {
  const absoluteBaseDir = path.resolve(baseDir);
  const relativePattern = path
    .relative(absoluteBaseDir, path.resolve(root.pattern))
    .split(path.sep)
    .join("/");
  const matcher = new Bun.Glob(relativePattern);
  const pending = [absoluteBaseDir];
  const paths: string[] = [];
  let scannedEntries = 0;

  while (pending.length > 0) {
    const currentDirectory = pending.shift();
    if (currentDirectory === undefined) break;
    const opened = await settlePromiseResult(() => fs.opendir(currentDirectory));
    if (opened.kind === "panic") throw opened.panic;
    if (opened.kind === "failure") continue;
    const directory = opened.value;
    for await (const entry of directory) {
      scannedEntries += 1;
      if (scannedEntries > maxEntries) {
        return { paths, scannedEntries: maxEntries, truncated: true };
      }
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(currentDirectory, entry.name);
      const relativeEntryPath = path.relative(absoluteBaseDir, entryPath).split(path.sep).join("/");
      if (entry.isFile() && matcher.match(relativeEntryPath)) {
        paths.push(entryPath);
        continue;
      }
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        pending.push(entryPath);
      }
    }
  }
  return { paths, scannedEntries, truncated: false };
}

export async function readTextPrefixResult(
  filePath: string,
  maxBytes: number,
): Promise<ResultType<string, SkillFilesystemError | SkillReadAndCleanupFailed>> {
  const opened = await settlePromiseResult(() => fs.open(filePath, "r"));
  if (opened.kind === "panic") throw opened.panic;
  if (opened.kind === "failure") {
    return Result.err(
      new SkillFilesystemError({
        operation: "open-file",
        path: filePath,
        cause: opened.restoreCause(),
        message: `Failed to open skill file '${filePath}'`,
      }),
    );
  }
  const handle = opened.value;

  const read = await settlePromiseResult(async () => {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  });
  const cleanup = await settlePromiseResult(() => handle.close());

  if (read.kind === "panic") throw read.panic;
  if (cleanup.kind === "panic") throw cleanup.panic;

  const readError =
    read.kind === "failure"
      ? new SkillFilesystemError({
          operation: "read-file",
          path: filePath,
          cause: read.restoreCause(),
          message: `Failed to read skill file '${filePath}'`,
        })
      : undefined;
  const cleanupError =
    cleanup.kind === "failure"
      ? new SkillFilesystemError({
          operation: "close-file",
          path: filePath,
          cause: cleanup.restoreCause(),
          message: `Failed to close skill file '${filePath}'`,
        })
      : undefined;

  if (readError && cleanupError) {
    return Result.err(
      new SkillReadAndCleanupFailed({
        path: filePath,
        readError,
        cleanupError,
        message: `Failed to read and close skill file '${filePath}'`,
      }),
    );
  }
  if (read.kind === "failure") return Result.err(readError!);
  if (cleanupError) return Result.err(cleanupError);
  return Result.ok(read.value);
}

function globBaseDir(pattern: string): string {
  // Best-effort: take everything before the first glob token.
  const tokens = ["*", "?", "[", "]", "{"];
  const idx = tokens
    .map((t) => pattern.indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];

  if (idx === undefined) return path.dirname(pattern);

  const prefix = pattern.slice(0, idx);
  const sepIdx = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  if (sepIdx === -1) return prefix || ".";

  const base = prefix.slice(0, sepIdx);
  return base.length > 0 ? base : path.parse(pattern).root;
}

const skillFrontmatterSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .passthrough();

function splitFrontmatter(raw: string): {
  frontmatterText: string;
  body: string;
} | null {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return null;
  const frontmatterText = match[1] ?? "";
  const body = raw.slice(match[0].length);
  return { frontmatterText, body };
}

export type ParsedSkillFile = {
  frontmatter: Record<string, unknown>;
  name: string;
  description: string;
  disableModelInvocation: boolean;
  body: string;
};

export class SkillMarkdownInvalid extends TaggedError("SkillMarkdownInvalid")<{
  readonly issue: "missing-frontmatter" | "malformed-yaml" | "invalid-frontmatter";
  readonly cause?: unknown;
  readonly message: string;
}> {}

export function parseSkillMarkdownResult(
  raw: string,
): ResultType<ParsedSkillFile, SkillMarkdownInvalid> {
  const parts = splitFrontmatter(raw);
  if (!parts) {
    return Result.err(
      new SkillMarkdownInvalid({
        issue: "missing-frontmatter",
        message: "SKILL.md missing YAML frontmatter (--- ... ---)",
      }),
    );
  }

  const decoded = Result.try({
    try: () => Bun.YAML.parse(parts.frontmatterText),
    catch: (cause) => ({ cause }),
  });
  const decodeOutcome = captureResultOutcome(decoded);
  if (!decodeOutcome.ok && isPanic(decodeOutcome.error.cause)) throw decodeOutcome.error.cause;
  if (!decodeOutcome.ok) {
    return Result.err(
      new SkillMarkdownInvalid({
        issue: "malformed-yaml",
        cause: decodeOutcome.error.cause,
        message: `Failed to parse YAML frontmatter: ${errorMessage(decodeOutcome.error.cause)}`,
      }),
    );
  }
  const yaml = decodeOutcome.value;

  const parsed = skillFrontmatterSchema.safeParse(yaml);
  if (!parsed.success) {
    return Result.err(
      new SkillMarkdownInvalid({
        issue: "invalid-frontmatter",
        cause: parsed.error,
        message: "YAML frontmatter must be an object with non-empty name and description",
      }),
    );
  }

  return Result.ok({
    frontmatter: parsed.data,
    name: parsed.data.name,
    description: parsed.data.description,
    disableModelInvocation: parsed.data["disable-model-invocation"] === true,
    body: parts.body.trimStart(),
  });
}

export function parseSkillMarkdown(raw: string): ParsedSkillFile {
  const result = parseSkillMarkdownResult(raw);
  const resolved = result.match<
    { readonly value: ParsedSkillFile } | { readonly error: SkillMarkdownInvalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export type SkillScanRoot = {
  pattern: string;
  source: SkillSource;
  precedence: number;
};

export function defaultSkillScanRoots(params: {
  workspaceRoot: string;
  dataDir: string;
  homeDir?: string;
}): SkillScanRoot[] {
  const home = params.homeDir ?? homedir();
  // If callers pass an explicit homeDir (tests, sandboxed runs), keep discovery
  // scoped to that home and do not consult the real process.env-based XDG home.
  const xdgConfigHome = params.homeDir
    ? path.join(home, ".config")
    : (process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
  const ws = params.workspaceRoot;

  // Higher precedence wins on name collisions.
  // We return in descending precedence order so callers can keep "first seen".
  return [
    {
      pattern: path.join(params.dataDir, "skills", "*", "SKILL.md"),
      source: "lilac-data",
      precedence: 300,
    },

    // Project-level compatibility dirs
    {
      pattern: path.join(ws, ".agents", "skills", "**", "SKILL.md"),
      source: "agent-project",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".claude", "skills", "*", "SKILL.md"),
      source: "claude-project",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".cursor", "skills", "*", "SKILL.md"),
      source: "cursor-project",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".github", "skills", "*", "SKILL.md"),
      source: "copilot-project",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".github", "copilot", "skills", "*", "SKILL.md"),
      source: "copilot-project-legacy",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".codex", "skills", "**", "SKILL.md"),
      source: "codex-project",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".opencode", "skill", "*", "SKILL.md"),
      source: "opencode-project",
      precedence: 200,
    },
    {
      // add-skill + opencode conventions
      pattern: path.join(ws, ".opencode", "skills", "*", "SKILL.md"),
      source: "opencode-project",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".agent", "skills", "**", "SKILL.md"),
      source: "agent-project",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".gemini", "skills", "**", "SKILL.md"),
      source: "gemini-project",
      precedence: 200,
    },
    {
      pattern: path.join(ws, ".windsurf", "skills", "*", "SKILL.md"),
      source: "windsurf-project",
      precedence: 200,
    },

    // Global/user-level compatibility dirs
    {
      pattern: path.join(home, ".claude", "skills", "*", "SKILL.md"),
      source: "claude-user",
      precedence: 100,
    },
    {
      pattern: path.join(home, ".cursor", "skills", "*", "SKILL.md"),
      source: "cursor-user",
      precedence: 100,
    },
    {
      pattern: path.join(home, ".copilot", "skills", "*", "SKILL.md"),
      source: "copilot-user",
      precedence: 100,
    },
    {
      pattern: path.join(home, ".agents", "skills", "**", "SKILL.md"),
      source: "agent-user",
      precedence: 100,
    },
    {
      pattern: path.join(home, ".codex", "skills", "**", "SKILL.md"),
      source: "codex-user",
      precedence: 100,
    },
    {
      pattern: path.join(xdgConfigHome, "opencode", "skill", "*", "SKILL.md"),
      source: "opencode-user",
      precedence: 100,
    },
    {
      // add-skill installs opencode skills here by default.
      pattern: path.join(xdgConfigHome, "opencode", "skills", "*", "SKILL.md"),
      source: "opencode-user",
      precedence: 100,
    },
    {
      pattern: path.join(home, ".gemini", "skills", "**", "SKILL.md"),
      source: "gemini-user",
      precedence: 100,
    },
    {
      pattern: path.join(import.meta.dir, "builtin-skills", "*", "SKILL.md"),
      source: "lilac-builtin",
      precedence: 0,
    },
  ];
}

function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!NAME_RE.test(name)) {
    errors.push(
      "name must match ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase letters/numbers with single hyphen separators)",
    );
  }
  return errors;
}

function validateSkillDescription(description: string): string[] {
  const errors: string[] = [];
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  return errors;
}

function normalizeInlineText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function truncateWithEllipsis(raw: string, maxChars: number): string {
  const s = normalizeInlineText(raw);
  if (maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  if (maxChars <= 3) return s.slice(0, maxChars);
  return `${s.slice(0, maxChars - 3)}...`;
}

/**
 * Build a compact skills index suitable for appending to a system prompt.
 * Returns null when no skills are provided.
 */
export function formatAvailableSkillsSection(
  skills: readonly Pick<DiscoveredSkill, "name" | "description" | "disableModelInvocation">[],
  options?: {
    maxDescriptionChars?: number;
  },
): string | null {
  const advertisedSkills = skills.filter((skill) => skill.disableModelInvocation !== true);
  if (advertisedSkills.length === 0) return null;

  const maxDescriptionChars = options?.maxDescriptionChars ?? DEFAULT_SKILL_DESCRIPTION_MAX_CHARS;
  const lines = ["## Available Skills"];
  let descriptionChars = 0;

  for (const skill of advertisedSkills) {
    const description = truncateWithEllipsis(skill.description, maxDescriptionChars);
    descriptionChars += description.length;
    lines.push(`- ${skill.name}: ${description}`);
  }

  if (advertisedSkills.length > 100) {
    lines.push(`Warning: skill catalog contains ${advertisedSkills.length} skills, exceeding 100.`);
  }
  if (descriptionChars > 50_000) {
    lines.push(
      `Warning: inserted skill descriptions total ${descriptionChars} characters, exceeding 50,000.`,
    );
  }

  return lines.join("\n");
}

export async function discoverSkills(params: {
  workspaceRoot: string;
  dataDir: string;
  homeDir?: string;
  roots?: SkillScanRoot[];
  maxSkills?: number;
  maxScanEntries?: number;
}): Promise<DiscoverSkillsResult> {
  const rootsInput =
    params.roots ??
    defaultSkillScanRoots({
      workspaceRoot: params.workspaceRoot,
      dataDir: params.dataDir,
      homeDir: params.homeDir,
    });

  // Avoid scanning identical patterns multiple times (can happen when callers
  // provide custom roots or compose lists).
  const roots: SkillScanRoot[] = [];
  const seenRootPatterns = new Set<string>();
  for (const r of rootsInput) {
    const key = path.normalize(r.pattern);
    if (seenRootPatterns.has(key)) continue;
    seenRootPatterns.add(key);
    roots.push(r);
  }

  const warnings: SkillWarning[] = [];
  const byName = new Map<string, DiscoveredSkill>();
  const seenSkillPaths = new Set<string>();
  let scannedEntries = 0;

  scanRoots: for (const root of roots) {
    const rootBaseDir = globBaseDir(root.pattern);

    // If the base directory doesn't exist, skip (Bun.Glob currently throws
    // in some cases when scanning missing roots).
    if (!(await pathExists(rootBaseDir))) {
      continue;
    }

    const boundedScan =
      params.maxScanEntries === undefined
        ? undefined
        : await scanSkillPathsBounded(root, rootBaseDir, params.maxScanEntries - scannedEntries);
    const skillPaths =
      boundedScan?.paths ??
      new Bun.Glob(root.pattern).scan({
        onlyFiles: true,
        absolute: true,
        followSymlinks: true,
      });
    scannedEntries += boundedScan?.scannedEntries ?? 0;
    if (boundedScan?.truncated) {
      warnings.push({
        location: rootBaseDir,
        message: `skill filesystem scan capped at ${params.maxScanEntries} entries`,
      });
    }

    for await (const skillPath of skillPaths) {
      const normalizedSkillPath = path.normalize(skillPath);
      if (seenSkillPaths.has(normalizedSkillPath)) continue;
      seenSkillPaths.add(normalizedSkillPath);
      if (skillPath.includes(`${path.sep}node_modules${path.sep}`)) continue;

      // Progressive disclosure: discovery loads metadata only.
      // Read a prefix large enough to include YAML frontmatter.
      const rawPrefix = await readTextPrefixResult(skillPath, 64 * 1024);
      const raw = rawPrefix.match<string | SkillFilesystemError | SkillReadAndCleanupFailed>({
        ok: (value) => value,
        err: (error) => error,
      });
      if (SkillFilesystemError.is(raw) || SkillReadAndCleanupFailed.is(raw)) {
        warnings.push({ location: skillPath, message: `read failed: ${raw.message}` });
        continue;
      }

      // Discovery only needs frontmatter; the bounded prefix is sufficient.
      const parsedResult = parseSkillMarkdownResult(raw);
      const parsed = parsedResult.match<ParsedSkillFile | SkillMarkdownInvalid>({
        ok: (value) => value,
        err: (error) => error,
      });
      if (SkillMarkdownInvalid.is(parsed)) {
        warnings.push({ location: skillPath, message: parsed.message });
        continue;
      }

      const nameErrors = validateSkillName(parsed.name);
      for (const err of nameErrors) {
        warnings.push({ location: skillPath, message: err });
      }
      if (nameErrors.length > 0) {
        // Keep discovery deterministic: skip invalid names.
        continue;
      }

      const descErrors = validateSkillDescription(parsed.description);
      for (const err of descErrors) {
        warnings.push({ location: skillPath, message: err });
      }
      if (descErrors.length > 0) {
        // Skip overly-long descriptions to avoid prompt bloat.
        continue;
      }

      const skillBaseDir = path.dirname(skillPath);
      const parentDirName = path.basename(skillBaseDir);
      if (parentDirName !== parsed.name) {
        warnings.push({
          location: skillPath,
          message: `name "${parsed.name}" does not match parent directory "${parentDirName}"`,
        });
      }

      // Precedence: since roots are ordered high-to-low, keep the first seen.
      const existing = byName.get(parsed.name);
      if (existing) {
        warnings.push({
          location: skillPath,
          message: `duplicate skill name "${parsed.name}"; keeping "${existing.location}" and ignoring "${skillPath}"`,
        });
        continue;
      }

      byName.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        location: skillPath,
        baseDir: skillBaseDir,
        source: root.source,
        disableModelInvocation: parsed.disableModelInvocation,
      });
      if (params.maxSkills !== undefined && byName.size >= params.maxSkills) {
        warnings.push({
          location: rootBaseDir,
          message: `skill discovery capped at ${params.maxSkills} entries`,
        });
        break scanRoots;
      }
    }
    if (boundedScan?.truncated) break scanRoots;
  }

  const skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  return { skills, warnings };
}
