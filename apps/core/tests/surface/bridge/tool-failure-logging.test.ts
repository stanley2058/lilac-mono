import { describe, expect, it } from "bun:test";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";

import {
  formatToolLogPreview,
  summarizeToolFailure,
} from "../../../src/surface/bridge/bus-agent-runner/tool-failure-logging";

describe("summarizeToolFailure", () => {
  it("marks bash non-zero exit as soft failure", () => {
    const res = summarizeToolFailure({
      toolName: "bash",
      isError: false,
      result: {
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
      },
    });

    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("soft");
    expect(res.error).toContain("127");
  });

  it("marks read_file success=false as soft failure", () => {
    const res = summarizeToolFailure({
      toolName: "read_file",
      isError: false,
      result: {
        success: false,
        resolvedPath: "/tmp/missing.txt",
        error: {
          code: "NOT_FOUND",
          message: "No such file",
        },
      },
    });

    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("soft");
    expect(res.error).toBe("No such file");
  });

  it("marks execution errors as hard failure", () => {
    const res = summarizeToolFailure({
      toolName: "glob",
      isError: true,
      result: "validation failed",
    });

    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("hard");
    expect(res.error).toBe("validation failed");
  });

  it("prefers plugin-provided failure summarizer when available", () => {
    const specs = new Map<string, Level1ToolSpec<unknown>>([
      [
        "custom_tool",
        {
          name: "custom_tool",
          createTool: () => ({}),
          isEnabled: () => true,
          summarizeFailure: () => ({ ok: false, failureKind: "soft", error: "custom failure" }),
        },
      ],
    ]);

    const res = summarizeToolFailure({
      toolName: "custom_tool",
      isError: false,
      result: { nope: true },
      toolSpecs: specs,
    });

    expect(res).toEqual({ ok: false, failureKind: "soft", error: "custom failure" });
  });
});

describe("formatToolLogPreview", () => {
  it("redacts secrets and truncates previews", () => {
    const long = "x".repeat(6_000);
    const preview = formatToolLogPreview({
      toolName: "bash",
      value: {
        command: "curl -H 'authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234'",
        long,
      },
    });

    expect(preview).toContain("<redacted>");
    expect(preview.length).toBeLessThanOrEqual(4_003);
  });

  it("truncates batch previews", () => {
    const big = "x".repeat(6_000);
    const preview = formatToolLogPreview({
      toolName: "batch",
      value: {
        tool_calls: [{ tool: "bash", parameters: { command: `printf '${big}'` } }],
      },
    });

    expect(preview.length).toBeLessThanOrEqual(4_003);
    expect(preview.endsWith("...")).toBe(true);
  });
});
