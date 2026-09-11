import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SKILL_DESCRIPTION_MAX_CHARS,
  discoverSkills,
  parseSkillMarkdown,
  parseSkillMarkdownResult,
} from "../skills";
import { formatAvailableSkillsSection } from "../skills";

async function mkdirp(p: string) {
  await fs.mkdir(p, { recursive: true });
}

describe("skills discovery", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it("keeps parseSkillMarkdown failures as plain Errors", () => {
    let caught: unknown;
    try {
      parseSkillMarkdown("missing frontmatter");
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) expect(caught.constructor).toBe(Error);
  });

  it("prefers data/skills over .claude/skills on name collision", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));

    const workspaceRoot = path.join(tmpRoot, "ws");
    const dataDir = path.join(tmpRoot, "data");

    await mkdirp(path.join(workspaceRoot, ".claude", "skills", "dup-skill"));
    await mkdirp(path.join(dataDir, "skills", "dup-skill"));

    await fs.writeFile(
      path.join(workspaceRoot, ".claude", "skills", "dup-skill", "SKILL.md"),
      `---\nname: dup-skill\ndescription: from claude\n---\n\n# Claudey\n`,
      "utf8",
    );

    await fs.writeFile(
      path.join(dataDir, "skills", "dup-skill", "SKILL.md"),
      `---\nname: dup-skill\ndescription: from data\n---\n\n# Datay\n`,
      "utf8",
    );

    const { skills, warnings } = await discoverSkills({
      workspaceRoot,
      dataDir,
      homeDir: path.join(tmpRoot, "home"),
    });

    expect(warnings).toContainEqual({
      location: path.join(workspaceRoot, ".claude", "skills", "dup-skill", "SKILL.md"),
      message: expect.stringContaining('duplicate skill name "dup-skill"'),
    });
    expect(warnings[0]?.message).toContain(path.join(dataDir, "skills", "dup-skill", "SKILL.md"));
    const skill = skills.find((candidate) => candidate.name === "dup-skill");
    expect(skill?.description).toBe("from data");
    expect(skill?.source).toBe("lilac-data");
  });

  it("skips invalid skill names", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));

    const workspaceRoot = path.join(tmpRoot, "ws");
    const dataDir = path.join(tmpRoot, "data");

    await mkdirp(path.join(dataDir, "skills", "Bad_Name"));

    await fs.writeFile(
      path.join(dataDir, "skills", "Bad_Name", "SKILL.md"),
      `---\nname: Bad_Name\ndescription: nope\n---\n\n# nope\n`,
      "utf8",
    );

    const { skills } = await discoverSkills({
      workspaceRoot,
      dataDir,
      homeDir: path.join(tmpRoot, "home"),
    });

    expect(skills.some((skill) => skill.name === "Bad_Name")).toBe(false);
  });

  it("discovers project .agents skills and retains invocation flags without hiding discovery", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));
    for (const [name, flag] of [
      ["manual-skill", "true"],
      ["automatic-skill", "false"],
      ["string-flag-skill", '"true"'],
    ]) {
      const directory = path.join(tmpRoot, ".agents", "skills", name!);
      await mkdirp(directory);
      await fs.writeFile(
        path.join(directory, "SKILL.md"),
        `---
name: ${name}
description: ${name}
disable-model-invocation: ${flag}
---
Instructions
`,
      );
    }
    const { skills } = await discoverSkills({
      workspaceRoot: tmpRoot,
      dataDir: path.join(tmpRoot, "data"),
      homeDir: path.join(tmpRoot, "home"),
    });
    expect(skills.find((skill) => skill.name === "manual-skill")).toMatchObject({
      source: "agent-project",
      disableModelInvocation: true,
    });
    const section = formatAvailableSkillsSection(skills);
    expect(section).not.toContain("manual-skill");
    expect(section).toContain("automatic-skill");
    expect(section).toContain("string-flag-skill");
  });

  it("discovers skills from ~/.agents/skills", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));

    const workspaceRoot = path.join(tmpRoot, "ws");
    const dataDir = path.join(tmpRoot, "data");
    const homeDir = path.join(tmpRoot, "home");

    await mkdirp(path.join(homeDir, ".agents", "skills", "agent-skill"));

    await fs.writeFile(
      path.join(homeDir, ".agents", "skills", "agent-skill", "SKILL.md"),
      `---\nname: agent-skill\ndescription: from agents\n---\n\n# Agents\n`,
      "utf8",
    );

    const { skills } = await discoverSkills({
      workspaceRoot,
      dataDir,
      homeDir,
    });

    const skill = skills.find((candidate) => candidate.name === "agent-skill");
    expect(skill?.description).toBe("from agents");
    expect(skill?.source).toBe("agent-user");
  });

  it("discovers bundled skills at lowest precedence", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));
    const workspaceRoot = path.join(tmpRoot, "ws");
    const dataDir = path.join(tmpRoot, "data");
    await mkdirp(path.join(dataDir, "skills", "workflow-authoring"));
    await fs.writeFile(
      path.join(dataDir, "skills", "workflow-authoring", "SKILL.md"),
      "---\nname: workflow-authoring\ndescription: local override\n---\n\n# Override\n",
      "utf8",
    );

    const overridden = await discoverSkills({
      workspaceRoot,
      dataDir,
      homeDir: path.join(tmpRoot, "home"),
    });
    expect(overridden.skills.find((skill) => skill.name === "workflow-authoring")).toMatchObject({
      description: "local override",
      source: "lilac-data",
    });

    await fs.rm(path.join(dataDir, "skills", "workflow-authoring"), {
      recursive: true,
      force: true,
    });
    const bundled = await discoverSkills({
      workspaceRoot,
      dataDir,
      homeDir: path.join(tmpRoot, "home"),
    });
    for (const name of [
      "coding-agent",
      "customize-lilac",
      "mcp-management",
      "image-generation",
      "workflow-authoring",
    ]) {
      expect(bundled.skills.find((skill) => skill.name === name)).toMatchObject({
        source: "lilac-builtin",
      });
    }
  });

  it("caps discovered skills and reports truncation", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));
    const skillsRoot = path.join(tmpRoot, "skills");
    for (const name of ["skill-one", "skill-two", "skill-three"]) {
      await mkdirp(path.join(skillsRoot, name));
      await fs.writeFile(
        path.join(skillsRoot, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
      );
    }

    const result = await discoverSkills({
      workspaceRoot: tmpRoot,
      dataDir: path.join(tmpRoot, "data"),
      roots: [
        {
          pattern: path.join(skillsRoot, "*", "SKILL.md"),
          source: "agent-project",
          precedence: 1,
        },
      ],
      maxSkills: 2,
      maxScanEntries: 100,
    });

    expect(result.skills).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.message.includes("capped at 2"))).toBe(true);
  });

  it("caps filesystem scanning and does not follow skill directory symlinks", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));
    const skillsRoot = path.join(tmpRoot, "skills");
    const externalRoot = path.join(tmpRoot, "external", "linked-skill");
    await mkdirp(skillsRoot);
    await mkdirp(externalRoot);
    await fs.writeFile(
      path.join(externalRoot, "SKILL.md"),
      "---\nname: linked-skill\ndescription: linked\n---\n",
    );
    await fs.symlink(externalRoot, path.join(skillsRoot, "linked-skill"));
    await mkdirp(path.join(skillsRoot, "ordinary-directory"));

    const result = await discoverSkills({
      workspaceRoot: tmpRoot,
      dataDir: path.join(tmpRoot, "data"),
      roots: [
        {
          pattern: path.join(skillsRoot, "**", "SKILL.md"),
          source: "agent-project",
          precedence: 1,
        },
      ],
      maxScanEntries: 1,
    });

    expect(result.skills.some((skill) => skill.name === "linked-skill")).toBe(false);
    expect(result.warnings.some((warning) => warning.message.includes("scan capped at 1"))).toBe(
      true,
    );
  });

  it("preserves recursive depth and custom glob structure in bounded scans", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));
    const skillsRoot = path.join(tmpRoot, "skills");
    const recursiveSkill = path.join(
      skillsRoot,
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "recursive-skill",
    );
    const structuredSkill = path.join(skillsRoot, "group", "structured-skill");
    const shallowSkill = path.join(skillsRoot, "shallow-skill");
    for (const [directory, name] of [
      [recursiveSkill, "recursive-skill"],
      [structuredSkill, "structured-skill"],
      [shallowSkill, "shallow-skill"],
    ] as const) {
      await mkdirp(directory);
      await fs.writeFile(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
      );
    }

    const recursive = await discoverSkills({
      workspaceRoot: tmpRoot,
      dataDir: path.join(tmpRoot, "data"),
      roots: [
        {
          pattern: path.join(skillsRoot, "**", "SKILL.md"),
          source: "agent-project",
          precedence: 1,
        },
      ],
      maxScanEntries: 100,
    });
    const structured = await discoverSkills({
      workspaceRoot: tmpRoot,
      dataDir: path.join(tmpRoot, "data"),
      roots: [
        {
          pattern: path.join(skillsRoot, "*", "*", "SKILL.md"),
          source: "agent-project",
          precedence: 1,
        },
      ],
      maxScanEntries: 100,
    });

    expect(recursive.skills.some((skill) => skill.name === "recursive-skill")).toBe(true);
    expect(structured.skills.map((skill) => skill.name)).toEqual(["structured-skill"]);
  });

  it("skips hidden descendants during bounded recursive scans", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-"));
    const skillsRoot = path.join(tmpRoot, "skills");
    const hiddenSkill = path.join(skillsRoot, ".hidden", "hidden-skill");
    await mkdirp(hiddenSkill);
    await fs.writeFile(
      path.join(hiddenSkill, "SKILL.md"),
      "---\nname: hidden-skill\ndescription: hidden\n---\n",
    );

    const result = await discoverSkills({
      workspaceRoot: tmpRoot,
      dataDir: path.join(tmpRoot, "data"),
      roots: [
        {
          pattern: path.join(skillsRoot, "**", "SKILL.md"),
          source: "agent-project",
          precedence: 1,
        },
      ],
      maxScanEntries: 100,
    });

    expect(result.skills).toEqual([]);
  });

  it("returns absolute locations for bounded relative root patterns", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-skills-relative-"));
    const skillsRoot = path.join(tmpRoot, "skills");
    const skillDirectory = path.join(skillsRoot, "relative-skill");
    await mkdirp(skillDirectory);
    await fs.writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: relative-skill\ndescription: relative\n---\n",
    );

    const result = await discoverSkills({
      workspaceRoot: tmpRoot,
      dataDir: path.join(tmpRoot, "data"),
      roots: [
        {
          pattern: path.relative(process.cwd(), path.join(skillsRoot, "*", "SKILL.md")),
          source: "agent-project",
          precedence: 1,
        },
      ],
      maxScanEntries: 100,
    });

    expect(result.skills[0]?.location).toBe(path.join(skillDirectory, "SKILL.md"));
  });
});

describe("skills prompt formatting", () => {
  it("returns null when no skills are provided", () => {
    expect(formatAvailableSkillsSection([])).toBe(null);
  });

  it("caps each description at 512 characters without omitting skills", () => {
    const skills = Array.from({ length: 101 }, (_, i) => ({
      name: `skill-${i}`,
      description: "x".repeat(600),
    }));
    const section = formatAvailableSkillsSection(skills)!;
    expect(section).toContain(`- skill-0: ${"x".repeat(509)}...`);
    expect(section).toContain("- skill-100:");
    expect(section.length).toBeGreaterThan(50_000);
    expect(section).toContain("101 skills, exceeding 100");
    expect(section).toContain("51712 characters, exceeding 50,000");
  });

  it("warns independently at strictly greater than the count and description thresholds", () => {
    const atThreshold = Array.from({ length: 100 }, (_, i) => ({
      name: `skill-${i}`,
      description: "x".repeat(500),
    }));
    expect(formatAvailableSkillsSection(atThreshold)).not.toContain("Warning:");
    const countOnly = formatAvailableSkillsSection(
      Array.from({ length: 101 }, (_, i) => ({ name: `skill-${i}`, description: "short" })),
    );
    expect(countOnly).toContain("101 skills, exceeding 100");
    expect(countOnly).not.toContain("exceeding 50,000");
    const descriptionsOnly = formatAvailableSkillsSection(
      Array.from({ length: 98 }, (_, i) => ({
        name: `skill-${i}`,
        description: "x".repeat(512),
      })),
    );
    expect(descriptionsOnly).toContain("50176 characters, exceeding 50,000");
    expect(descriptionsOnly).not.toContain("exceeding 100");
  });

  it("excludes disabled skills from the catalog and its warning thresholds", () => {
    const disabled = Array.from({ length: 101 }, (_, i) => ({
      name: `manual-${i}`,
      description: "x".repeat(512),
      disableModelInvocation: true,
    }));
    expect(formatAvailableSkillsSection(disabled)).toBeNull();
    expect(
      formatAvailableSkillsSection([
        ...disabled,
        { name: "automatic", description: "Always available." },
      ]),
    ).toBe("## Available Skills\n- automatic: Always available.");
  });
});

describe("bundled skills", () => {
  it("reports malformed markdown as a typed error", () => {
    const result = parseSkillMarkdownResult("not frontmatter");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("SkillMarkdownInvalid");
      expect(result.error.issue).toBe("missing-frontmatter");
    }
  });

  it("routes Lilac deployment and config work to separate references", async () => {
    const skillDir = path.join(import.meta.dir, "..", "builtin-skills", "customize-lilac");
    const skill = parseSkillMarkdown(await Bun.file(path.join(skillDir, "SKILL.md")).text());

    expect(skill.name).toBe("customize-lilac");
    expect(skill.description.length).toBeLessThanOrEqual(DEFAULT_SKILL_DESCRIPTION_MAX_CHARS);
    expect(skill.description).toContain("/app");
    expect(skill.description).toContain("core-config.yaml");
    expect(skill.body).toContain("references/self-debugging.md");
    expect(skill.body).toContain("references/core-config.md");
    await expect(
      Bun.file(path.join(skillDir, "references", "self-debugging.md")).exists(),
    ).resolves.toBe(true);
    await expect(
      Bun.file(path.join(skillDir, "references", "core-config.md")).exists(),
    ).resolves.toBe(true);
  });

  it("includes a strong built-in coding-agent skill", async () => {
    const raw = await Bun.file(
      path.join(import.meta.dir, "..", "builtin-skills", "coding-agent", "SKILL.md"),
    ).text();

    const skill = parseSkillMarkdown(raw);

    expect(skill.name).toBe("coding-agent");
    expect(skill.description).toContain("Essential coding workflow rules");
    expect(skill.description).toContain("load this before software engineering tasks");
    expect(skill.body).toContain("Use `git` when applicable");
    expect(skill.body).toContain("Use `gh` when configured and the project is linked to GitHub");
  });

  it("documents Core MCP management separately from direct mcporter usage", async () => {
    const managementRaw = await Bun.file(
      path.join(import.meta.dir, "..", "builtin-skills", "mcp-management", "SKILL.md"),
    ).text();
    const mcporterRaw = await Bun.file(
      path.join(import.meta.dir, "..", "skill-templates", "mcporter", "SKILL.md"),
    ).text();

    const management = parseSkillMarkdown(managementRaw);
    const mcporter = parseSkillMarkdown(mcporterRaw);

    expect(management.name).toBe("mcp-management");
    expect(management.body).toContain("tools mcp.add");
    expect(management.body).toContain("curl '<complete-callback-url>'");
    expect(management.body).toContain("deliberately retains its credential file");
    expect(management.body).toContain("not isolation");
    expect(mcporter.description).toContain("does not manage Core's configured MCP registry");
    expect(mcporter.body).toContain("Load `mcp-management` instead");
  });

  it("discloses MCP management exactly once in TOOLS.md", async () => {
    const tools = await Bun.file(
      path.join(import.meta.dir, "..", "prompt-templates", "TOOLS.md"),
    ).text();

    expect(tools.match(/`mcp\.\*`/gu)).toHaveLength(1);
    expect(tools).toContain("Load the `mcp-management` skill");
  });
});
