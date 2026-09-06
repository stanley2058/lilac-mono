import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Panic } from "better-result";

import { canonicalClaudeExecutionCwd } from "../../src/agent/claude-composition";

describe("Claude execution directory canonicalization", () => {
  test("uses the canonical directory returned by realpath", async () => {
    const requestedDirectories: string[] = [];
    const canonical = await canonicalClaudeExecutionCwd("./linked-workspace", async (cwd) => {
      requestedDirectories.push(cwd);
      return "/canonical/workspace";
    });

    expect(requestedDirectories).toEqual(["./linked-workspace"]);
    expect(canonical).toBe("/canonical/workspace");
  });

  test("uses an absolute directory when realpath fails", async () => {
    const executionCwd = "./unavailable-workspace/../workspace";
    const canonical = await canonicalClaudeExecutionCwd(executionCwd, async () => {
      throw new Error("realpath unavailable");
    });

    expect(canonical).toBe(path.resolve(executionCwd));
  });

  test("preserves realpath Panic identity", async () => {
    const panic = new Panic({ message: "realpath invariant failed" });

    await expect(
      canonicalClaudeExecutionCwd("./workspace", async () => {
        throw panic;
      }),
    ).rejects.toBe(panic);
  });
});
