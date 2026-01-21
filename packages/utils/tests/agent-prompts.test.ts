import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  buildAgentSystemPrompt,
  CORE_PROMPT_FILES,
  DEFAULT_PROMPT_DIRNAME,
  ensurePromptWorkspace,
} from "../agent-prompts";

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
        expect(built.systemPrompt).toContain(`## ${name}`);
      }

      expect(built.systemPrompt).toContain("If instructions conflict");
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
});
