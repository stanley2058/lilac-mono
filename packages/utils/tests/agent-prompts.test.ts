import { describe, expect, it } from "bun:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  promptWorkspaceSignature,
  applyBasePromptForProvider,
  buildAgentSystemPrompt,
  CORE_PROMPT_FILES,
  DEFAULT_PROMPT_DIRNAME,
  HEARTBEAT_PROMPT_DIRNAME,
  HEARTBEAT_PROMPT_FILENAME,
  PROMPT_TEMPLATE_BASELINE_DIRNAME,
  PROMPT_TEMPLATE_STATE_FILENAME,
  WORKER_PROMPT_FILES,
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

function templateBaselinePath(dataDir: string, name: (typeof CORE_PROMPT_FILES)[number]): string {
  return path.join(promptDirFromDataDir(dataDir), PROMPT_TEMPLATE_BASELINE_DIRNAME, name);
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

  it("seeds heartbeat workflow assets without creating legacy inbox directories", async () => {
    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace({ dataDir });
      const promptDir = path.join(dataDir, DEFAULT_PROMPT_DIRNAME);
      for (const [active, asset] of [
        [HEARTBEAT_PROMPT_FILENAME, "HEARTBEAT.md"],
        [path.join(HEARTBEAT_PROMPT_DIRNAME, "WORK.md"), "WORK.md"],
      ]) {
        expect(await Bun.file(path.join(promptDir, active!)).text()).toBe(
          await Bun.file(
            path.join(import.meta.dir, "..", "builtin-skills", "heartbeat", "assets", asset!),
          ).text(),
        );
      }
      expect(await Bun.file(path.join(promptDir, "heartbeat", "inbox")).exists()).toBe(false);
    });
  });

  it("preserves customized heartbeat files and pending legacy work on startup", async () => {
    await withTempDataDir(async (dataDir) => {
      const promptDir = path.join(dataDir, DEFAULT_PROMPT_DIRNAME);
      const files = [
        [HEARTBEAT_PROMPT_FILENAME, "Legacy workflow with a flight watch"],
        ["heartbeat/WORK.md", "Existing watch: post to discord/thread-1"],
        ["heartbeat/inbox/pending.md", "Recheck the forecast"],
        ["heartbeat/archive/previous.md", "Previously communicated finding"],
      ] as const;
      for (const [relative, content] of files)
        await Bun.write(path.join(promptDir, relative), content);
      await ensurePromptWorkspace({ dataDir });
      await ensurePromptWorkspace({ dataDir });
      for (const [relative, content] of files)
        expect(await Bun.file(path.join(promptDir, relative)).text()).toBe(content);
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
      for (const name of WORKER_PROMPT_FILES) {
        expect(built.workerSystemPrompt).toContain(`# ${name}`);
      }
      for (const name of CORE_PROMPT_FILES) {
        if ((WORKER_PROMPT_FILES as readonly string[]).includes(name)) continue;
        expect(built.workerSystemPrompt).not.toContain(`# ${name}`);
        expect(built.workerSystemPrompt).toContain(
          `- ${name}: ${path.join(built.promptDir, name)}`,
        );
      }
      expect(built.workerSystemPrompt).toContain("# Workspace files not loaded in this run");
      expect(built.systemPrompt).toContain(
        "These local files provide workspace instructions and context for this agent.",
      );
      expect(built.systemPrompt).not.toContain("are authoritative");
    });
  });

  it("applies basePrompt to non-codex provider system prompts", () => {
    expect(
      applyBasePromptForProvider({
        systemPrompt: "Workspace prompt",
        basePrompt: "Base prompt",
        provider: "openai",
      }),
    ).toBe("Base prompt\n\nWorkspace prompt");
  });

  it("omits basePrompt from codex provider system prompts", () => {
    expect(
      applyBasePromptForProvider({
        systemPrompt: "Workspace prompt",
        basePrompt: "Base prompt",
        provider: "codex",
      }),
    ).toBe("Workspace prompt");
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

  it("does not rewrite unchanged prompt template state", async () => {
    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace({ dataDir });

      const statePath = path.join(promptDirFromDataDir(dataDir), PROMPT_TEMPLATE_STATE_FILENAME);
      const initialContent = await Bun.file(statePath).text();
      const knownTime = new Date("2020-01-02T03:04:05.000Z");
      await utimes(statePath, knownTime, knownTime);

      await ensurePromptWorkspace({ dataDir });

      expect(await Bun.file(statePath).text()).toBe(initialContent);
      expect((await Bun.file(statePath).stat()).mtimeMs).toBe(knownTime.getTime());
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

  it("writes upstream diff and merged candidate for customized files with a baseline", async () => {
    if (!Bun.which("git")) return;

    await withTempDataDir(async (dataDir) => {
      await ensurePromptWorkspace({ dataDir });

      const agentsPath = promptPath(dataDir, "AGENTS.md");
      const oldTemplateContent = "# AGENTS.md\n\nOld upstream rule.\n";
      const customized = "# AGENTS.md\n\nOld upstream rule.\n\nLocal custom rule.\n";
      const oldTemplateHash = sha256HexText(oldTemplateContent);

      await writeFile(agentsPath, customized, "utf8");
      const baselinePath = templateBaselinePath(dataDir, "AGENTS.md");
      await mkdir(path.dirname(baselinePath), { recursive: true });
      await writeFile(baselinePath, oldTemplateContent, "utf8");

      await writePromptState(dataDir, {
        schemaVersion: 1,
        templateBundleHash: "legacy-bundle",
        files: {
          "AGENTS.md": {
            status: "managed",
            templateHash: oldTemplateHash,
            appliedHash: oldTemplateHash,
          },
        },
      });

      const result = await ensurePromptWorkspace({ dataDir });
      const agents = result.ensured.find((e) => e.name === "AGENTS.md");

      expect(agents?.dirtyDetected).toBe(true);
      expect(agents?.newPath).toBe(`${agentsPath}.new`);
      expect(agents?.upstreamDiffPath).toBe(`${agentsPath}.upstream.patch`);
      expect(agents?.mergedPath).toBe(`${agentsPath}.merged`);
      expect(await Bun.file(agentsPath).text()).toBe(customized);

      const upstreamPatch = await Bun.file(`${agentsPath}.upstream.patch`).text();
      expect(upstreamPatch).toContain("upstream-before/AGENTS.md");
      expect(upstreamPatch).toContain("upstream-after/AGENTS.md");
      expect(upstreamPatch).toContain("Old upstream rule.");

      const merged = await Bun.file(`${agentsPath}.merged`).text();
      expect(merged).toContain("Local custom rule.");

      const templateContent = await readTemplate("AGENTS.md");
      expect(await Bun.file(baselinePath).text()).toBe(templateContent);
    });
  });
});

it("prompt fingerprints detect changes below another file's maximum mtime", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "prompt-signature-"));
  try {
    await ensurePromptWorkspace({ dataDir });
    await utimes(promptPath(dataDir, "AGENTS.md"), 2000000000, 2000000000);
    const before = await promptWorkspaceSignature({ dataDir });
    await writeFile(promptPath(dataDir, "USER.md"), "changed user");
    const after = await promptWorkspaceSignature({ dataDir });
    expect(before.maxMtimeMs).toBe(after.maxMtimeMs);
    expect(before.fingerprint).not.toBe(after.fingerprint);
    await rm(promptPath(dataDir, "USER.md"));
    expect((await promptWorkspaceSignature({ dataDir })).fingerprint).not.toBe(after.fingerprint);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
