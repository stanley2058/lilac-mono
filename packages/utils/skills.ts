import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

export type SkillSource =
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
  | "codex-user"
  | "opencode-user"
  | "gemini-user";

export type DiscoveredSkill = {
  name: string;
  description: string;
  location: string;
  baseDir: string;
  source: SkillSource;
};

export type SkillWarning = {
  location: string;
  message: string;
};

export type DiscoverSkillsResult = {
  skills: DiscoveredSkill[];
  warnings: SkillWarning[];
};

export const DEFAULT_SKILL_DESCRIPTION_MAX_CHARS = 160;
export const DEFAULT_SKILLS_SECTION_MAX_CHARS = 20000;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextPrefix(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
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

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function trimNonEmptyString(x: unknown): string | undefined {
  if (typeof x !== "string") return undefined;
  const trimmed = x.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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
  body: string;
};

export function parseSkillMarkdown(raw: string): ParsedSkillFile {
  const parts = splitFrontmatter(raw);
  if (!parts) {
    throw new Error("SKILL.md missing YAML frontmatter (--- ... ---)");
  }

  let parsedFrontmatter: unknown;
  try {
    parsedFrontmatter = Bun.YAML.parse(parts.frontmatterText) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse YAML frontmatter: ${msg}`);
  }

  if (!isRecord(parsedFrontmatter)) {
    throw new Error("YAML frontmatter must be a mapping/object");
  }

  const name = trimNonEmptyString(parsedFrontmatter.name);
  const description = trimNonEmptyString(parsedFrontmatter.description);

  if (!name) throw new Error("Frontmatter field 'name' is required");
  if (!description)
    throw new Error("Frontmatter field 'description' is required");

  return {
    frontmatter: parsedFrontmatter,
    name,
    description,
    body: parts.body.trimStart(),
  };
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
    errors.push(
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    );
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
  skills: readonly DiscoveredSkill[],
  options?: {
    maxDescriptionChars?: number;
    maxSectionChars?: number;
  },
): string | null {
  if (skills.length === 0) return null;

  const maxDescriptionChars =
    options?.maxDescriptionChars ?? DEFAULT_SKILL_DESCRIPTION_MAX_CHARS;
  const maxSectionChars =
    options?.maxSectionChars ?? DEFAULT_SKILLS_SECTION_MAX_CHARS;

  const header = "## Available Skills";
  const lines: string[] = [header];

  for (const s of skills) {
    const desc = truncateWithEllipsis(s.description, maxDescriptionChars);
    const line = `- ${s.name}: ${desc}`;

    const candidate = [...lines, line].join("\n");
    if (candidate.length > maxSectionChars) {
      break;
    }

    lines.push(line);
  }

  // If any skills were omitted due to the overall cap, add a final line.
  // Ensure the omission line itself fits by removing trailing skill lines if needed.
  while (true) {
    const included = Math.max(0, lines.length - 1);
    const omitted = skills.length - included;
    if (omitted <= 0) break;

    const omittedLine = `(...and ${omitted} more skills omitted)`;
    const candidate = [...lines, omittedLine].join("\n");
    if (candidate.length <= maxSectionChars) {
      lines.push(omittedLine);
      break;
    }

    // If we can't fit the omission line, drop the last included skill.
    if (lines.length <= 1) {
      // Extremely small maxSectionChars; return a best-effort truncated header.
      return header.slice(0, Math.max(0, maxSectionChars));
    }
    lines.pop();
  }

  return lines.join("\n");
}

export async function discoverSkills(params: {
  workspaceRoot: string;
  dataDir: string;
  homeDir?: string;
  roots?: SkillScanRoot[];
}): Promise<DiscoverSkillsResult> {
  const roots =
    params.roots ??
    defaultSkillScanRoots({
      workspaceRoot: params.workspaceRoot,
      dataDir: params.dataDir,
      homeDir: params.homeDir,
    });

  const warnings: SkillWarning[] = [];
  const byName = new Map<string, DiscoveredSkill>();

  for (const root of roots) {
    const baseDir = globBaseDir(root.pattern);

    // If the base directory doesn't exist, skip (Bun.Glob currently throws
    // in some cases when scanning missing roots).
    if (!(await pathExists(baseDir))) {
      continue;
    }

    const glob = new Bun.Glob(root.pattern);

    for await (const skillPath of glob.scan({
      onlyFiles: true,
      absolute: true,
      followSymlinks: true,
    })) {
      if (skillPath.includes(`${path.sep}node_modules${path.sep}`)) continue;

      // Progressive disclosure: discovery loads metadata only.
      // Read a prefix large enough to include YAML frontmatter.
      let rawPrefix: string;
      try {
        rawPrefix = await readTextPrefix(skillPath, 64 * 1024);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push({ location: skillPath, message: `read failed: ${msg}` });
        continue;
      }

      let parsed: ParsedSkillFile;
      try {
        // parseSkillMarkdown expects a full document, but for discovery we only
        // need frontmatter; this works as long as frontmatter is in the prefix.
        parsed = parseSkillMarkdown(rawPrefix);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push({ location: skillPath, message: msg });
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

      const baseDir = path.dirname(skillPath);
      const parentDirName = path.basename(baseDir);
      if (parentDirName !== parsed.name) {
        warnings.push({
          location: skillPath,
          message: `name \"${parsed.name}\" does not match parent directory \"${parentDirName}\"`,
        });
      }

      // Precedence: since roots are ordered high-to-low, keep the first seen.
      if (byName.has(parsed.name)) continue;

      byName.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        location: skillPath,
        baseDir,
        source: root.source,
      });
    }
  }

  const skills = Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return { skills, warnings };
}
