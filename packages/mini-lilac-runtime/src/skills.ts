import path from "node:path";
import { open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";

import {
  discoverSkills,
  findWorkspaceRoot,
  formatAvailableSkillsSection,
  parseSkillMarkdown,
  type DiscoveredSkill,
  type SkillScanRoot,
  type SkillWarning,
} from "@stanley2058/lilac-utils";
import {
  miniLilacSkillSummarySchema,
  type MiniLilacSkillSummary,
} from "@stanley2058/mini-lilac-client";
import { z } from "zod";

const MAX_DISCOVERED_SKILLS = 256;
const MAX_CATALOG_CHARS = 8_000;
const MAX_DESCRIPTION_CATALOG_CHARS = 160;
const MAX_SKILL_FILE_BYTES = 128 * 1_024;
const MAX_SKILL_INSTRUCTION_CHARS = 32_000;
const MAX_SKILL_RESOURCES = 10;

const SKILL_USAGE_INSTRUCTIONS = [
  "Use the `skill` tool to load a skill when the task clearly matches its description.",
  "A token in the form `@skills:<name>` is an explicit user selection. Before acting, call the `skill` tool with that exact name.",
  "If a selected skill is unavailable, say so briefly and continue with the best fallback.",
].join("\n");

export const miniLilacSkillLoadResultSchema = z
  .object({
    name: miniLilacSkillSummarySchema.shape.name,
    description: miniLilacSkillSummarySchema.shape.description,
    instructions: z.string().max(MAX_SKILL_INSTRUCTION_CHARS),
    baseDirectory: z.string().min(1),
    resources: z.array(z.string().min(1)).max(MAX_SKILL_RESOURCES),
    resourceListingTruncated: z.boolean(),
  })
  .strict();
export type MiniLilacSkillLoadResult = z.infer<typeof miniLilacSkillLoadResultSchema>;

export type MiniLilacSkillCatalogOptions = {
  dataDir: string;
  homeDir?: string;
  onWarning?: (warning: SkillWarning) => void;
};

export class MiniLilacSkillCatalogSnapshot {
  readonly summaries: readonly MiniLilacSkillSummary[];
  private readonly byName: ReadonlyMap<string, DiscoveredSkill>;

  constructor(skills: readonly DiscoveredSkill[]) {
    this.byName = new Map(skills.map((skill) => [skill.name, skill]));
    this.summaries = skills.map((skill) =>
      miniLilacSkillSummarySchema.parse({ name: skill.name, description: skill.description }),
    );
  }

  promptSection(contextWindow?: number): string | null {
    if (this.summaries.length === 0) return null;
    const contextBudget =
      contextWindow === undefined ? MAX_CATALOG_CHARS : Math.floor(contextWindow * 0.02 * 4);
    const maxSectionChars = Math.max(512, Math.min(MAX_CATALOG_CHARS, contextBudget));
    const catalogBudget = Math.max(0, maxSectionChars - SKILL_USAGE_INSTRUCTIONS.length - 2);
    const catalog = formatAvailableSkillsSection(this.summaries, {
      maxDescriptionChars: MAX_DESCRIPTION_CATALOG_CHARS,
      maxSectionChars: catalogBudget,
    });
    if (catalog === null) return null;
    return `${catalog}\n\n${SKILL_USAGE_INSTRUCTIONS}`;
  }

  async load(name: string): Promise<MiniLilacSkillLoadResult> {
    const skill = this.byName.get(name);
    if (skill === undefined) throw new Error(`Skill '${name}' is not available`);
    const canonicalLocation = await realpath(skill.location);
    if (path.normalize(canonicalLocation) !== path.normalize(path.resolve(skill.location))) {
      throw new Error(`Skill '${name}' resolves through a symbolic link`);
    }
    const handle = await open(canonicalLocation, "r");
    const raw = await (async () => {
      try {
        const buffer = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > MAX_SKILL_FILE_BYTES) {
          throw new Error(`Skill '${name}' exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
        }
        return buffer.subarray(0, offset).toString("utf8");
      } finally {
        await handle.close();
      }
    })();
    const parsed = parseSkillMarkdown(raw);
    if (parsed.name !== name) throw new Error(`Skill '${name}' changed identity while loading`);
    if (parsed.body.length > MAX_SKILL_INSTRUCTION_CHARS) {
      throw new Error(
        `Skill '${name}' instructions exceed ${MAX_SKILL_INSTRUCTION_CHARS} characters`,
      );
    }
    const canonicalBaseDirectory = await realpath(skill.baseDir);
    if (path.normalize(canonicalBaseDirectory) !== path.normalize(path.resolve(skill.baseDir))) {
      throw new Error(`Skill '${name}' directory resolves through a symbolic link`);
    }
    const resources: string[] = [];
    let resourceListingTruncated = false;
    const directory = await opendir(canonicalBaseDirectory);
    for await (const entry of directory) {
      if (entry.name === "SKILL.md" || entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      if (!entry.isFile() && !entry.isDirectory()) continue;
      if (resources.length === MAX_SKILL_RESOURCES) {
        resourceListingTruncated = true;
        break;
      }
      resources.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }
    resources.sort();
    return miniLilacSkillLoadResultSchema.parse({
      name,
      description: parsed.description,
      instructions: parsed.body,
      baseDirectory: skill.baseDir,
      resources,
      resourceListingTruncated,
    });
  }
}

export class MiniLilacSkillCatalog {
  constructor(private readonly options: MiniLilacSkillCatalogOptions) {}

  async discover(cwd: string): Promise<MiniLilacSkillCatalogSnapshot> {
    const workspaceRoot = (() => {
      try {
        return findWorkspaceRoot(cwd);
      } catch {
        return path.resolve(cwd);
      }
    })();
    const homeDir = this.options.homeDir ?? homedir();
    const roots: SkillScanRoot[] = [
      {
        pattern: path.join(this.options.dataDir, "skills", "*", "SKILL.md"),
        source: "lilac-data",
        precedence: 300,
      },
      {
        pattern: path.join(workspaceRoot, ".agents", "skills", "**", "SKILL.md"),
        source: "agent-project",
        precedence: 200,
      },
      {
        pattern: path.join(homeDir, ".agents", "skills", "**", "SKILL.md"),
        source: "agent-user",
        precedence: 100,
      },
    ];
    try {
      const discovered = await discoverSkills({
        workspaceRoot,
        dataDir: this.options.dataDir,
        homeDir,
        roots,
        maxSkills: MAX_DISCOVERED_SKILLS * 2,
        maxScanEntries: MAX_DISCOVERED_SKILLS * 16,
      });
      discovered.warnings.forEach((warning) => this.options.onWarning?.(warning));
      const skills: DiscoveredSkill[] = [];
      for (const skill of discovered.skills) {
        try {
          const canonicalLocation = await realpath(skill.location);
          if (path.normalize(canonicalLocation) !== path.normalize(path.resolve(skill.location))) {
            this.options.onWarning?.({
              location: skill.location,
              message: "skill resolves through a symbolic link",
            });
            continue;
          }
          skills.push(skill);
          if (skills.length === MAX_DISCOVERED_SKILLS) {
            if (discovered.skills.length > skills.length) {
              this.options.onWarning?.({
                location: workspaceRoot,
                message: `skill discovery capped at ${MAX_DISCOVERED_SKILLS} entries`,
              });
            }
            break;
          }
        } catch (error) {
          this.options.onWarning?.({
            location: skill.location,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return new MiniLilacSkillCatalogSnapshot(skills);
    } catch (error) {
      this.options.onWarning?.({
        location: workspaceRoot,
        message: error instanceof Error ? error.message : String(error),
      });
      return new MiniLilacSkillCatalogSnapshot([]);
    }
  }
}
