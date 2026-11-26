import { describe, expect, it } from "bun:test";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";

import {
  formatToolLogPreview,
  summarizeToolFailure,
} from "../../../src/surface/bridge/bus-agent-runner/tool-failure-logging";
import { createLocalToolSpecs } from "../../../src/plugins/builtin/local-tools";

const BUILTIN_TOOL_SPECS = new Map(createLocalToolSpecs().map((spec) => [spec.name, spec]));

function summarizeBuiltinFailure(params: { toolName: string; isError: boolean; result: unknown }) {
  return summarizeToolFailure({ ...params, toolSpecs: BUILTIN_TOOL_SPECS });
}

describe("summarizeToolFailure", () => {
  it("marks bash non-zero exit as soft failure", () => {
    const res = summarizeBuiltinFailure({
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
    expect(res).toEqual({
      ok: false,
      failureKind: "soft",
      failureClass: "tool",
      failureCode: "nonzero_exit",
      exitCode: 127,
      error: "bash command exited with a nonzero status",
    });
  });

  it("projects typed Bash policy, timeout, cancellation, and spawn failures", () => {
    const cases = [
      {
        executionError: {
          type: "blocked",
          code: "dynamic_recursive_delete",
          reason: "dynamic target",
          hint: "use literal children",
        },
        expected: {
          failureClass: "policy",
          failureCode: "dynamic_recursive_delete",
          retryable: false,
          error: "dynamic target Hint: use literal children",
        },
      },
      {
        executionError: {
          type: "timeout",
          code: "wall_clock_timeout",
          timeoutMs: 50,
          timeoutKind: "wall_clock",
          signal: "SIGTERM",
        },
        expected: {
          failureClass: "timeout",
          failureCode: "wall_clock_timeout",
          error: "bash timed out after 50ms",
        },
      },
      {
        executionError: {
          type: "aborted",
          code: "execution_cancelled",
          signal: "SIGTERM",
        },
        expected: {
          failureClass: "cancelled",
          failureCode: "execution_cancelled",
          retryable: false,
          error: "bash execution was cancelled",
        },
      },
      {
        executionError: {
          type: "exception",
          code: "spawn_cwd_missing",
          phase: "spawn",
          message: "cwd missing",
          errno: "ENOENT",
          cwd: "/tmp/missing",
        },
        expected: {
          failureClass: "environment",
          failureCode: "spawn_cwd_missing",
          retryable: false,
          error: "cwd missing",
        },
      },
      {
        executionError: {
          type: "exception",
          code: "spawn_failed",
          phase: "spawn",
          message: "spawn failed",
          errno: "EACCES",
          cwd: "/tmp/workspace",
        },
        expected: {
          failureClass: "environment",
          failureCode: "spawn_failed",
          error: "spawn failed",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const summary = summarizeBuiltinFailure({
        toolName: "bash",
        isError: false,
        result: {
          stdout: "",
          stderr: "",
          exitCode: -1,
          executionError: testCase.executionError,
        },
      });
      expect(summary).toMatchObject({
        ok: false,
        failureKind: "hard",
        ...testCase.expected,
      });
    }
  });

  it("classifies malformed Bash results without parsing their text", () => {
    expect(
      summarizeBuiltinFailure({
        toolName: "bash",
        isError: false,
        result: { executionError: "ENOENT: secret free-form text" },
      }),
    ).toEqual({
      ok: false,
      failureKind: "hard",
      failureClass: "unknown",
      failureCode: "invalid_result",
      error: "bash returned an invalid result",
    });
    expect(
      summarizeBuiltinFailure({
        toolName: "bash",
        isError: false,
        result: { stdout: "", stderr: "", exitCode: 1.5 },
      }),
    ).toEqual({
      ok: false,
      failureKind: "hard",
      failureClass: "unknown",
      failureCode: "invalid_result",
      error: "bash returned an invalid result",
    });
  });

  it("marks read success=false as soft failure", () => {
    const res = summarizeBuiltinFailure({
      toolName: "read",
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

  it("marks fuzzy_search errors as soft failures", () => {
    const res = summarizeBuiltinFailure({
      toolName: "fuzzy_search",
      isError: false,
      result: { error: "index unavailable" },
    });

    expect(res).toEqual({
      ok: false,
      failureKind: "soft",
      error: "fuzzy_search failed: index unavailable",
    });
  });

  it("marks execution errors as hard failure", () => {
    const res = summarizeBuiltinFailure({
      toolName: "glob",
      isError: true,
      result: "validation failed",
    });

    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("hard");
    expect(res.failureClass).toBe("unknown");
    expect(res.failureCode).toBe("host_execution_error");
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

  it("falls back when plugin summarizers fail or return malformed results", () => {
    const failed: Level1ToolSpec<unknown> = {
      name: "failed",
      createTool: () => ({}),
      isEnabled: () => true,
      summarizeFailure() {
        throw new Error("summary boom");
      },
    };
    const malformed: Level1ToolSpec<unknown> = {
      name: "malformed",
      createTool: () => ({}),
      isEnabled: () => true,
      summarizeFailure: () => ({ ok: true }),
    };
    Object.defineProperty(malformed, "summarizeFailure", { value: () => ({ failureKind: "bad" }) });

    expect(
      summarizeToolFailure({
        toolName: "failed",
        isError: false,
        result: {},
        toolSpecs: new Map([["failed", failed]]),
      }),
    ).toEqual({ ok: true });
    expect(
      summarizeToolFailure({
        toolName: "malformed",
        isError: false,
        result: {},
        toolSpecs: new Map([["malformed", malformed]]),
      }),
    ).toEqual({ ok: true });
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
