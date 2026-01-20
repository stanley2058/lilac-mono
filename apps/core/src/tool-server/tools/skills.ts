import fs from "node:fs/promises";
import { z } from "zod";
import { Fzf } from "fzf";

import type { ServerTool } from "../types";
import {
  discoverSkills,
  parseSkillMarkdown,
  type DiscoveredSkill,
  env,
  findWorkspaceRoot,
} from "@stanley2058/lilac-utils";
import { zodObjectToCliLines } from "./zod-cli";

const listInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Search query (fuzzy-matched against name/description/source)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Max results (default: 50)")
    .default(50),
  sources: z
    .array(z.string())
    .optional()
    .describe('Optional source filter (e.g. ["lilac-data", "claude-project"])'),
});

const readInputSchema = z.object({
  name: z.string().min(1).describe("Skill name"),
  maxChars: z
    .number()
    .int()
    .positive()
    .max(200_000)
    .optional()
    .describe("Max characters of SKILL.md body to return"),
});

type SkillIncludeSummary = {
  baseDir: string;
  dirs: string[];
  files: string[];
};

async function listTopLevelEntries(
  baseDir: string,
): Promise<SkillIncludeSummary> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });

  const dirs: string[] = [];
  const files: string[] = [];

  for (const ent of entries) {
    const name = ent.name;
    if (name === "node_modules" || name === ".git") continue;

    if (ent.isDirectory()) {
      dirs.push(`${name}/`);
    } else if (ent.isFile()) {
      files.push(name);
    }
  }

  dirs.sort();
  files.sort();

  return { baseDir, dirs, files };
}

function truncateText(text: string, maxChars: number | undefined) {
  const cap = maxChars ?? 50_000;
  if (text.length <= cap) return { text, truncated: false as const };
  return { text: text.slice(0, cap), truncated: true as const };
}

function scoreAndFilter(
  skills: DiscoveredSkill[],
  queryRaw: string | undefined,
  limit: number,
): DiscoveredSkill[] {
  const query = queryRaw?.trim();
  if (!query) return skills.slice(0, limit);

  // Use Fzf for fuzzy ranking.
  const fzf = new Fzf(skills, {
    selector: (s) => `${s.name} ${s.description} ${s.source}`,
  });

  return fzf
    .find(query)
    .slice(0, limit)
    .map((r) => r.item);
}

function requireSkillByName(
  skills: DiscoveredSkill[],
  name: string,
): DiscoveredSkill {
  const found = skills.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `Skill not found: '${name}'. Use skills.list to see available skills.`,
    );
  }
  return found;
}

export class Skills implements ServerTool {
  id = "skills";

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "skills.list",
        name: "Skills List",
        description:
          "List and search skills discovered from common directories.",
        shortInput: zodObjectToCliLines(listInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(listInputSchema),
      },
      {
        callableId: "skills.brief",
        name: "Skills Brief",
        description: "Load a skill's frontmatter + a truncated SKILL.md body.",
        shortInput: zodObjectToCliLines(readInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(readInputSchema),
      },
      {
        callableId: "skills.full",
        name: "Skills Full",
        description:
          "Load a skill's frontmatter + a larger SKILL.md body, plus a top-level directory listing.",
        shortInput: zodObjectToCliLines(readInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(readInputSchema),
      },
    ];
  }

  async call(
    callableId: string,
    rawInput: Record<string, unknown>,
  ): Promise<unknown> {
    const workspaceRoot = findWorkspaceRoot();

    const { skills, warnings } = await discoverSkills({
      workspaceRoot,
      dataDir: env.dataDir,
    });

    if (callableId === "skills.list") {
      const input = listInputSchema.parse(rawInput);

      let filtered = skills;
      if (input.sources && input.sources.length > 0) {
        const allowed = new Set(input.sources);
        filtered = filtered.filter((s) => allowed.has(s.source));
      }

      const ranked = scoreAndFilter(filtered, input.query, input.limit);

      return {
        skills: ranked.map((s) => ({
          name: s.name,
          description: s.description,
          source: s.source,
          location: s.location,
        })),
        warnings,
      };
    }

    if (callableId === "skills.brief" || callableId === "skills.full") {
      const input = readInputSchema.parse(rawInput);
      const found = requireSkillByName(skills, input.name);

      const raw = await Bun.file(found.location).text();
      const parsed = parseSkillMarkdown(raw);

      // Keep returned frontmatter stable + minimal-ish.
      const frontmatter = parsed.frontmatter;
      const defaultCap = callableId === "skills.brief" ? 8000 : 50_000;
      const { text, truncated } = truncateText(
        parsed.body,
        input.maxChars ?? defaultCap,
      );

      const includes = await listTopLevelEntries(found.baseDir);

      return {
        name: found.name,
        description: found.description,
        source: found.source,
        location: found.location,
        baseDir: found.baseDir,
        frontmatter,
        body: text,
        truncated,
        includes: callableId === "skills.full" ? includes : undefined,
      };
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }
}
