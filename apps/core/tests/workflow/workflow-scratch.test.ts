import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isRecord } from "@stanley2058/lilac-utils";

import {
  ensureWorkflowRunScratch,
  workflowRunScratchPath,
  workflowScratchTools,
} from "../../src/workflow/workflow-scratch";

async function execute(tool: unknown, input: unknown): Promise<unknown> {
  if (!isRecord(tool) || typeof tool["execute"] !== "function") {
    throw new Error("Scratch test tool is not executable");
  }
  return await Reflect.apply(tool["execute"], tool, [input, { toolCallId: "scratch-test" }]);
}

describe("workflow run scratch", () => {
  it("reuses one canonical directory across operations and restart", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-scratch-"));
    try {
      const first = await ensureWorkflowRunScratch({ dataDir, runId: "run-1" });
      const writer = workflowScratchTools(first).scratch_write;
      await expect(
        execute(writer, { path: "handoff-result.txt", content: "shared result" }),
      ).resolves.toMatchObject({ bytes: 13 });

      const afterRestart = await ensureWorkflowRunScratch({ dataDir, runId: "run-1" });
      expect(afterRestart).toBe(first);
      await expect(
        execute(workflowScratchTools(afterRestart).scratch_read, {
          path: "handoff-result.txt",
        }),
      ).resolves.toEqual({ path: "handoff-result.txt", content: "shared result" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("isolates runs and rejects traversal, symlinks, and hardlinks", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-scratch-isolation-"));
    try {
      const first = await ensureWorkflowRunScratch({ dataDir, runId: "run-1" });
      const second = await ensureWorkflowRunScratch({ dataDir, runId: "run-2" });
      expect(first).not.toBe(second);
      expect(first).toBe(workflowRunScratchPath(dataDir, "run-1"));
      await fs.writeFile(path.join(first, "source.txt"), "secret-free handoff");
      await fs.symlink(path.join(first, "source.txt"), path.join(first, "link.txt"));
      await fs.link(path.join(first, "source.txt"), path.join(first, "hardlink.txt"));

      const tools = workflowScratchTools(first);
      await expect(execute(tools.scratch_read, { path: "../run-2/file" })).rejects.toThrow(
        "flat filenames",
      );
      await expect(execute(tools.scratch_read, { path: "link.txt" })).rejects.toThrow(
        /ELOOP|link/u,
      );
      await expect(execute(tools.scratch_read, { path: "hardlink.txt" })).rejects.toThrow(
        "non-linked",
      );
      await expect(
        execute(workflowScratchTools(second).scratch_read, { path: "source.txt" }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
