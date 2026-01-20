import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverSkills } from "../skills";

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

    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("dup-skill");
    expect(skills[0]!.description).toBe("from data");
    expect(skills[0]!.source).toBe("lilac-data");
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

    expect(skills).toEqual([]);
  });
});
