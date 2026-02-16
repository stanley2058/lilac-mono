import { describe, expect, it } from "bun:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  buildAgentSystemPrompt,
  CORE_PROMPT_FILES,
  DEFAULT_PROMPT_DIRNAME,
  PROMPT_TEMPLATE_STATE_FILENAME,
  ensurePromptWorkspace,
} from "../agent-prompts";

type StateEntry = {
  status: "managed" | "customized";
  templateHash: string;
  appliedHash?: string;
};

type PromptTemplateStateFile = {
  schemaVersion: 1;
  templateBundleHash: string;
  files: Partial<Record<(typeof CORE_PROMPT_FILES)[number], StateEntry>>;
};

function sha256HexText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function promptDirFromDataDir(dataDir: string): string {
  return path.join(dataDir, DEFAULT_PROMPT_DIRNAME);
}

function promptPath(dataDir: string, name: (typeof CORE_PROMPT_FILES)[number]): string {
  return path.join(promptDirFromDataDir(dataDir), name);
}

async function readTemplate(name: (typeof CORE_PROMPT_FILES)[number]): Promise<string> {
  return Bun.file(path.join(import.meta.dir, "..", "prompt-templates", name)).text();
}

async function writePromptState(dataDir: string, state: PromptTemplateStateFile): Promise<void> {
  const statePath = path.join(promptDirFromDataDir(dataDir), PROMPT_TEMPLATE_STATE_FILENAME);
  await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function withTempDataDir<T>(fn: (dataDir: string) => Promise<T>) {
  const old = process.env.DATA_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-utils-prompts-"));
  process.env.DATA_DIR = dir;

  try {
    return await fn(dir);
  } finally {
    if (old === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = old;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe("agent prompts", () => {
  it("creates missing prompt files from templates", async () => {
    await withTempDataDir(async (dataDir) => {
      const result = await ensurePromptWorkspace();
      expect(result.promptDir).toBe(path.join(dataDir, DEFAULT_PROMPT_DIRNAME));

      const ensuredNames = result.ensured.map((e) => e.name);
      for (const name of CORE_PROMPT_FILES) {
        expect(ensuredNames).toContain(name);
      }

      // On first run, all should be created.
      expect(result.ensured.every((e) => e.created)).toBe(true);
    });
  });

  it("overwrites prompt files when requested", async () => {
    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace({ dataDir });

      const agentsPath = path.join(dataDir, DEFAULT_PROMPT_DIRNAME, "AGENTS.md");
      await writeFile(agentsPath, "# AGENTS.md\n\nCustom rules.", "utf8");

      const res = await ensurePromptWorkspace({ dataDir, overwrite: true });
      const agents = res.ensured.find((e) => e.name === "AGENTS.md");
      expect(agents?.overwritten).toBe(true);

      const next = await Bun.file(agentsPath).text();
      expect(next).not.toContain("Custom rules.");
    });
  });

  it("builds a compiled system prompt containing all sections", async () => {
    await withTempDataDir(async (dataDir) => {
      const built = await buildAgentSystemPrompt();
      expect(built.promptDir).toBe(path.join(dataDir, DEFAULT_PROMPT_DIRNAME));

      for (const name of CORE_PROMPT_FILES) {
        expect(built.systemPrompt).toContain(`# ${name}`);
      }
    });
  });

  it("reflects prompt file edits", async () => {
    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace();

      const agentsPath = path.join(dataDir, DEFAULT_PROMPT_DIRNAME, "AGENTS.md");
      await writeFile(agentsPath, "# AGENTS.md\n\nCustom rules.", "utf8");

      const built = await buildAgentSystemPrompt();
      expect(built.systemPrompt).toContain("Custom rules.");
    });
  });

  it("auto-updates managed files when template version changes and file is clean", async () => {
    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace({ dataDir });

      const agentsPath = promptPath(dataDir, "AGENTS.md");
      const oldTemplateContent = "# AGENTS.md\n\nLegacy template baseline.\n";
      const oldTemplateHash = sha256HexText(oldTemplateContent);

      await writeFile(agentsPath, oldTemplateContent, "utf8");
      await writePromptState(dataDir, {
        schemaVersion: 1,
        templateBundleHash: "legacy-bundle",
        files: {
          "AGENTS.md": {
            status: "managed",
            templateHash: "legacy-template-hash",
            appliedHash: oldTemplateHash,
          },
        },
      });

      const result = await ensurePromptWorkspace({ dataDir });
      const agents = result.ensured.find((e) => e.name === "AGENTS.md");

      expect(agents?.updated).toBe(true);
      expect(agents?.overwritten).toBe(true);

      const templateContent = await readTemplate("AGENTS.md");
      const updated = await Bun.file(agentsPath).text();
      expect(updated).toBe(templateContent);
      expect(await Bun.file(`${agentsPath}.new`).exists()).toBe(false);
    });
  });

  it("writes AGENTS.md.new when template changes and local file is customized", async () => {
    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace({ dataDir });

      const agentsPath = promptPath(dataDir, "AGENTS.md");
      const customized = "# AGENTS.md\n\nMy local custom rules.\n";
      await writeFile(agentsPath, customized, "utf8");

      const templateContent = await readTemplate("AGENTS.md");
      await writePromptState(dataDir, {
        schemaVersion: 1,
        templateBundleHash: "legacy-bundle",
        files: {
          "AGENTS.md": {
            status: "managed",
            templateHash: "legacy-template-hash",
            appliedHash: sha256HexText(templateContent),
          },
        },
      });

      const result = await ensurePromptWorkspace({ dataDir });
      const agents = result.ensured.find((e) => e.name === "AGENTS.md");

      expect(agents?.dirtyDetected).toBe(true);
      expect(agents?.newPath).toBe(`${agentsPath}.new`);
      expect(agents?.newFileCreated).toBe(true);

      const after = await Bun.file(agentsPath).text();
      expect(after).toBe(customized);

      const newContent = await Bun.file(`${agentsPath}.new`).text();
      expect(newContent).toBe(templateContent);
    });
  });

  it("does not rewrite .new on repeated runs when templates did not change", async () => {
    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace({ dataDir });

      const agentsPath = promptPath(dataDir, "AGENTS.md");
      await writeFile(agentsPath, "# AGENTS.md\n\nCustomized\n", "utf8");

      const templateContent = await readTemplate("AGENTS.md");
      await writePromptState(dataDir, {
        schemaVersion: 1,
        templateBundleHash: "legacy-bundle",
        files: {
          "AGENTS.md": {
            status: "managed",
            templateHash: "legacy-template-hash",
            appliedHash: sha256HexText(templateContent),
          },
        },
      });

      await ensurePromptWorkspace({ dataDir });
      const firstStat = await Bun.file(`${agentsPath}.new`).stat();

      const second = await ensurePromptWorkspace({ dataDir });
      const agents = second.ensured.find((e) => e.name === "AGENTS.md");
      const secondStat = await Bun.file(`${agentsPath}.new`).stat();

      expect(agents?.newFileCreated).toBe(false);
      expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    });
  });

  it("migrates existing customized files by writing .new on first stateful run", async () => {
    await withTempDataDir(async (dataDir) => {
      const promptDir = promptDirFromDataDir(dataDir);
      await mkdir(promptDir, { recursive: true });

      const agentsPath = promptPath(dataDir, "AGENTS.md");
      const customized = "# AGENTS.md\n\nHand-edited local bootstrap.\n";
      await writeFile(agentsPath, customized, "utf8");

      const result = await ensurePromptWorkspace({ dataDir });
      const agents = result.ensured.find((e) => e.name === "AGENTS.md");

      expect(agents?.dirtyDetected).toBe(true);
      expect(agents?.newPath).toBe(`${agentsPath}.new`);
      expect(agents?.newFileCreated).toBe(true);
      expect(await Bun.file(`${agentsPath}.new`).exists()).toBe(true);

      const after = await Bun.file(agentsPath).text();
      expect(after).toBe(customized);
      expect(await Bun.file(path.join(promptDir, PROMPT_TEMPLATE_STATE_FILENAME)).exists()).toBe(
        true,
      );
    });
  });

  it("reports newFileCreated=false when an existing .new file is updated", async () => {
    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace({ dataDir });

      const agentsPath = promptPath(dataDir, "AGENTS.md");
      await writeFile(agentsPath, "# AGENTS.md\n\nCustomized\n", "utf8");
      await writeFile(`${agentsPath}.new`, "# AGENTS.md\n\nOld candidate\n", "utf8");

      const templateContent = await readTemplate("AGENTS.md");
      await writePromptState(dataDir, {
        schemaVersion: 1,
        templateBundleHash: "legacy-bundle",
        files: {
          "AGENTS.md": {
            status: "managed",
            templateHash: "legacy-template-hash",
            appliedHash: sha256HexText(templateContent),
          },
        },
      });

      const result = await ensurePromptWorkspace({ dataDir });
      const agents = result.ensured.find((e) => e.name === "AGENTS.md");

      expect(agents?.dirtyDetected).toBe(true);
      expect(agents?.newPath).toBe(`${agentsPath}.new`);
      expect(agents?.newFileCreated).toBe(false);
      expect(await Bun.file(`${agentsPath}.new`).text()).toBe(templateContent);
    });
  });
});
