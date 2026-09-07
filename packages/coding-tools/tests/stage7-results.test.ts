import { describe, expect, it } from "bun:test";

import {
  createBatchToolResult,
  decodePreviouslyLoadedInstructionPaths,
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

    expect(validateLocalCwd("host:/workspace").status).toBe("error");
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
