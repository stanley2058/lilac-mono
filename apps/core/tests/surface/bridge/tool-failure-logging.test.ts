import { describe, expect, it } from "bun:test";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";

import {
  extractBatchChildFailureEntries,
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
  it("redacts secrets and truncates non-batch previews", () => {
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

  it("does not truncate batch previews", () => {
    const big = "x".repeat(6_000);
    const preview = formatToolLogPreview({
      toolName: "batch",
      value: {
        tool_calls: [{ tool: "bash", parameters: { command: `printf '${big}'` } }],
      },
    });

    expect(preview.length).toBeGreaterThan(4_100);
    expect(preview.endsWith("...")).toBe(false);
  });
});

describe("extractBatchChildFailureEntries", () => {
  it("extracts failed child calls with arguments and errors", () => {
    const entries = extractBatchChildFailureEntries({
      args: {
        tool_calls: [
          { tool: "glob", parameters: { pattern: "*.ts" } },
          { tool: "bash", parameters: { command: "bad-command" } },
        ],
      },
      result: {
        ok: false,
        total: 2,
        failed: 1,
        results: [
          { toolCallId: "p:1", tool: "glob", ok: true, output: { paths: [] } },
          { toolCallId: "p:2", tool: "bash", ok: false, error: "exit code 127" },
        ],
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.index).toBe(1);
    expect(entries[0]?.toolName).toBe("bash");
    expect(entries[0]?.error).toBe("exit code 127");
    expect(entries[0]?.args).toEqual({ command: "bad-command" });
  });
});
