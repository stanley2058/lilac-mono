import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MiniLilacSkillCatalog } from "../src/skills";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-skills-"));
  temporaryDirectories.push(directory);
  const dataDir = path.join(directory, "state");
  const homeDir = path.join(directory, "home");
  const cwd = path.join(directory, "workspace");
  const skillDir = path.join(dataDir, "skills", "frontend-design");
  await Promise.all([
    mkdir(path.join(skillDir, "references"), { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ]);
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: frontend-design\ndescription: Build deliberate interfaces with strong visual hierarchy.\n---\n\nFollow the interface workflow.\n",
  );
  await writeFile(path.join(skillDir, "references", "layout.md"), "Layout reference\n");
  const outsideResource = path.join(directory, "outside.txt");
  await writeFile(outsideResource, "outside\n");
  await symlink(outsideResource, path.join(skillDir, "outside-link.txt"));
  return { directory, dataDir, homeDir, cwd, skillDir };
}

describe("MiniLilacSkillCatalog", () => {
  it("discovers bounded metadata and loads structural skill JSON", async () => {
    const { dataDir, homeDir, cwd, skillDir } = await fixture();
    const catalog = new MiniLilacSkillCatalog({ dataDir, homeDir });
    const snapshot = await catalog.discover(cwd);

    expect(snapshot.summaries).toEqual([
      {
        name: "frontend-design",
        description: "Build deliberate interfaces with strong visual hierarchy.",
      },
    ]);
    const prompt = snapshot.promptSection(128_000);
    expect(prompt).toContain("frontend-design: Build deliberate interfaces");
    expect(prompt).toContain("@skills:<name>");
    expect(prompt).not.toContain(skillDir);
    expect(prompt?.length).toBeLessThanOrEqual(8_000);

    expect(await snapshot.load("frontend-design")).toEqual({
      name: "frontend-design",
      description: "Build deliberate interfaces with strong visual hierarchy.",
      instructions: "Follow the interface workflow.\n",
      baseDirectory: skillDir,
      resources: ["references/"],
      resourceListingTruncated: false,
    });
    await expect(snapshot.load("missing")).rejects.toThrow("is not available");
  });

  it("discovers only Mini Lilac state and local or global .agents skills", async () => {
    const { dataDir, homeDir, cwd } = await fixture();
    const localSkill = path.join(cwd, ".agents", "skills", "local-skill");
    const globalSkill = path.join(homeDir, ".agents", "skills", "global-skill");
    const ignoredClaudeSkill = path.join(cwd, ".claude", "skills", "ignored-skill");
    await Promise.all([
      mkdir(localSkill, { recursive: true }),
      mkdir(globalSkill, { recursive: true }),
      mkdir(ignoredClaudeSkill, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(localSkill, "SKILL.md"),
        "---\nname: local-skill\ndescription: Local agent skill.\n---\n\nLocal.\n",
      ),
      writeFile(
        path.join(globalSkill, "SKILL.md"),
        "---\nname: global-skill\ndescription: Global agent skill.\n---\n\nGlobal.\n",
      ),
      writeFile(
        path.join(ignoredClaudeSkill, "SKILL.md"),
        "---\nname: ignored-skill\ndescription: Must not load.\n---\n\nIgnored.\n",
      ),
    ]);

    const snapshot = await new MiniLilacSkillCatalog({ dataDir, homeDir }).discover(cwd);
    expect(snapshot.summaries.map((skill) => skill.name)).toEqual([
      "frontend-design",
      "global-skill",
      "local-skill",
    ]);
  });

  it("rejects oversized instructions instead of truncating them", async () => {
    const { dataDir, homeDir, cwd, skillDir } = await fixture();
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: frontend-design\ndescription: Large skill.\n---\n\n${"x".repeat(32_001)}`,
    );
    const snapshot = await new MiniLilacSkillCatalog({ dataDir, homeDir }).discover(cwd);

    await expect(snapshot.load("frontend-design")).rejects.toThrow(
      "instructions exceed 32000 characters",
    );
  });

  it("bounds skill file reads by bytes", async () => {
    const { dataDir, homeDir, cwd, skillDir } = await fixture();
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: frontend-design\ndescription: Large skill.\n---\n\n${"x".repeat(128 * 1_024)}`,
    );
    const snapshot = await new MiniLilacSkillCatalog({ dataDir, homeDir }).discover(cwd);

    await expect(snapshot.load("frontend-design")).rejects.toThrow("exceeds 131072 bytes");
  });
});
