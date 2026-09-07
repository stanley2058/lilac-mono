import { describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Panic } from "better-result";

import {
  applyPatchResult,
  canonicalPathAllowed,
  createBatchToolResult,
  decodePreviouslyLoadedInstructionPaths,
  guardrailBypassAllowed,
  parsePatchResult,
  validateLocalCwd,
} from "../src";

describe("Stage 7 Result boundaries", () => {
  it("returns owned errors for invalid patch, batch, and guardrail inputs", () => {
    const patch = parsePatchResult("not a patch");
    expect(patch.status).toBe("error");
    if (patch.status === "error") expect(patch.error._tag).toBe("PatchRejected");

    const batch = createBatchToolResult({ cwd: process.cwd(), getTools: () => ({}) });
    expect(batch.status).toBe("error");
    if (batch.status === "error") expect(batch.error._tag).toBe("BatchRejected");

    expect(guardrailBypassAllowed(true, false).status).toBe("error");
    expect(validateLocalCwd("host:/workspace").status).toBe("error");
  });

  it("keeps filesystem operation failures as Stage 3 Result values", async () => {
    const applied = await applyPatchResult({
      cwd: process.cwd(),
      denyPaths: [],
      patchText: [
        "*** Begin Patch",
        "*** Update File: definitely-missing-stage7-file.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });

    expect(applied.status).toBe("error");
    if (applied.status === "error") {
      expect(applied.error._tag).toBe("FileSystemOperationFailed");
      if (applied.error._tag === "FileSystemOperationFailed") {
        expect(applied.error.code).toBe("ENOENT");
      }
    }
  });

  it("propagates patch deletion stat failures except an absent target", async () => {
    for (const code of ["EACCES", "EPERM"] as const) {
      const stat = spyOn(fs, "stat").mockRejectedValueOnce(
        Object.assign(new Error(code), { code }),
      );
      try {
        const result = await applyPatchResult({
          cwd: process.cwd(),
          denyPaths: [],
          dangerouslyAllow: true,
          allowGuardrailBypass: true,
          patchText: [
            "*** Begin Patch",
            "*** Delete File: permission-fixture.txt",
            "*** End Patch",
          ].join("\n"),
        });
        expect(result).toMatchObject({
          status: "error",
          error: { _tag: "FileSystemOperationFailed", code },
        });
      } finally {
        stat.mockRestore();
      }
    }

    const panic = new Panic({ message: "patch deletion invariant" });
    const stat = spyOn(fs, "stat").mockRejectedValueOnce(panic);
    try {
      await expect(
        applyPatchResult({
          cwd: process.cwd(),
          denyPaths: [],
          dangerouslyAllow: true,
          allowGuardrailBypass: true,
          patchText: [
            "*** Begin Patch",
            "*** Delete File: panic-fixture.txt",
            "*** End Patch",
          ].join("\n"),
        }),
      ).rejects.toBe(panic);
    } finally {
      stat.mockRestore();
    }
  });

  it("treats the filesystem root as the parent of every descendant", async () => {
    const target = process.cwd();
    const denied = await canonicalPathAllowed({
      targetPath: target,
      denyPaths: [path.parse(target).root],
      operation: "root regression",
    });

    expect(denied).toMatchObject({
      status: "error",
      error: { _tag: "CodingToolGuardrailViolation" },
    });
  });

  it("decodes only supported instruction history shapes", () => {
    const paths = decodePreviouslyLoadedInstructionPaths([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "read",
            output: {
              type: "json",
              value: {
                loadedInstructions: ["/workspace/AGENTS.md"],
                instructionsText: "Instructions from: /workspace/src/AGENTS.md\nRules",
              },
            },
          },
          {
            type: "tool-result",
            toolName: "read_file",
            output: {
              type: "json",
              value: { loadedInstructions: ["/workspace/legacy/AGENTS.md"] },
            },
          },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolName: "bash", output: null }] },
    ]);

    expect([...paths]).toEqual([
      "/workspace/AGENTS.md",
      "/workspace/src/AGENTS.md",
      "/workspace/legacy/AGENTS.md",
    ]);
  });
});
