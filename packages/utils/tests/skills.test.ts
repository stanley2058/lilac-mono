import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverSkills, parseSkillMarkdown } from "../skills";
import { formatAvailableSkillsSection, type DiscoveredSkill } from "../skills";

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

    const { skills } = await discoverSkills({
      workspaceRoot,
      dataDir,
      homeDir: path.join(tmpRoot, "home"),
    });

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

  it("discovers the bundled workflow skill at lowest precedence", async () => {
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
    expect(bundled.skills.find((skill) => skill.name === "workflow-authoring")).toMatchObject({
      source: "lilac-builtin",
    });
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

  it("truncates descriptions and caps total size with omission line", () => {
    const skills: DiscoveredSkill[] = Array.from({ length: 10 }).map((_, i) => ({
      name: `skill-${i}`,
      description: "x".repeat(500),
      location: `/tmp/skill-${i}/SKILL.md`,
      baseDir: `/tmp/skill-${i}`,
      source: "lilac-data",
    }));

    const section = formatAvailableSkillsSection(skills, {
      maxDescriptionChars: 20,
      maxSectionChars: 180,
    });

    expect(section).not.toBe(null);
    expect(section!).toContain("## Available Skills");
    expect(section!).toContain("- skill-0:");
    // Description truncation
    expect(section!).toContain("...");
    // Omission line
    expect(section!).toContain("(...and ");
    expect(section!.length).toBeLessThanOrEqual(180);
  });
});

describe("bundled skill templates", () => {
  it("includes a strong coding-agent template", async () => {
    const raw = await Bun.file(
      path.join(import.meta.dir, "..", "skill-templates", "coding-agent", "SKILL.md"),
    ).text();

    const skill = parseSkillMarkdown(raw);

    expect(skill.name).toBe("coding-agent");
    expect(skill.description).toContain("Essential coding workflow rules");
    expect(skill.description).toContain("load this before software engineering tasks");
    expect(skill.body).toContain("Use `git` when applicable");
    expect(skill.body).toContain("Use `gh` when configured and the project is linked to GitHub");
  });
});
