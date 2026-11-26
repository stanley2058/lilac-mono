import { describe, expect, it } from "bun:test";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";

import {
  formatToolArgsForDisplay,
  formatToolArgsForDisplayWithSpecs,
} from "../../src/tools/tool-args-display";
import { createLocalToolSpecs } from "../../src/plugins/builtin/local-tools";

const BUILTIN_TOOL_SPECS = new Map(createLocalToolSpecs().map((spec) => [spec.name, spec]));

function formatBuiltinArgs(toolName: string, args: unknown): string {
  return formatToolArgsForDisplayWithSpecs(toolName, args, BUILTIN_TOOL_SPECS);
}

describe("formatToolArgsForDisplay", () => {
  it("formats bash command and truncates to 30 chars including ellipsis", () => {
    expect(
      formatBuiltinArgs("bash", {
        command: "echo 12345678901234567890123456789012345678901234567890",
      }),
    ).toBe(" echo 1234567890123456789012...");
  });

  it("redacts secrets in a bash command before truncating it", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const display = formatBuiltinArgs("bash", {
      command: `GH_TOKEN=${token} bun dev`,
      background: "service",
    });
    expect(display).not.toContain("ghp_aaaa");
  });

  it("formats read path with middle truncation (14 ... 13)", () => {
    expect(
      formatBuiltinArgs("read", {
        path: "/path/to/some/really/long/path/to/file.js",
      }),
    ).toBe(" /path/to/some/...th/to/file.js");
  });

  it("formats remote read path with host initials", () => {
    expect(
      formatBuiltinArgs("read", {
        path: "ssh://stanley-server/some/really/long/path/to/file.js",
      }),
    ).toBe(" @SS:/some/real...th/to/file.js");
  });

  it("keeps scp-style read path literal", () => {
    expect(
      formatBuiltinArgs("read", {
        path: "stanley-desktop:/repo/apps/core/src/index.ts",
      }),
    ).toBe(" stanley-deskto.../src/index.ts");
  });

  it("keeps local filenames with ':' literal", () => {
    expect(
      formatBuiltinArgs("read", {
        path: "notes:2026.md",
      }),
    ).toBe(" notes:2026.md");
  });

  it("formats patch as first file + remaining count", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: /path/to/some/really/long/path/to/file1.js",
      "@@",
      "-a",
      "+b",
      "*** Add File: /path/to/file2.js",
      "+x",
      "*** Delete File: /path/to/file3.js",
      "*** Add File: /path/to/file4.js",
      "+y",
      "*** End Patch",
    ].join("\n");

    expect(formatBuiltinArgs("patch", { patchText })).toBe(" /path/to/some/...h/to/file1.js (+3)");
  });

  it("formats edit path with middle truncation", () => {
    expect(
      formatBuiltinArgs("edit", {
        path: "/path/to/some/really/long/path/to/file.js",
        oldText: "a",
        newText: "b",
      }),
    ).toBe(" /path/to/some/...th/to/file.js");
  });

  it("formats grep as pattern + path", () => {
    expect(
      formatBuiltinArgs("grep", {
        pattern: "foo",
        path: "/tmp",
      }),
    ).toBe(" foo /tmp");
  });

  it("formats grep remote path with host initials", () => {
    expect(
      formatBuiltinArgs("grep", {
        pattern: "foo",
        path: "stanley-server:/repo/apps/core",
      }),
    ).toBe(" foo @SS:/repo/apps/core");
  });

  it("formats grep artifact paths without treating them as SSH targets", () => {
    expect(
      formatBuiltinArgs("grep", {
        pattern: "foo",
        path: "tool-result://00000000-0000-0000-0000-000000000000",
      }),
    ).toBe(" foo tool-result://00000000-...");
  });

  it("formats grep resource paths without treating them as SSH targets", () => {
    expect(
      formatBuiltinArgs("grep", {
        pattern: "foo",
        path: "resource://r1_00000000000000000000000000000000",
      }),
    ).toBe(" foo resource://r1_000000000...");
  });

  it("formats glob as patterns + cwd", () => {
    expect(
      formatBuiltinArgs("glob", {
        patterns: ["a", "b"],
        cwd: "/c",
      }),
    ).toBe(" a,b /c");
  });

  it("formats fuzzy_search as query + cwd", () => {
    expect(
      formatBuiltinArgs("fuzzy_search", {
        query: "agent runner",
        cwd: "/repo/apps/core",
      }),
    ).toBe(" agent runner /repo/apps/core");
  });

  it("formats fuzzy_search remote cwd with host initials", () => {
    expect(
      formatBuiltinArgs("fuzzy_search", {
        query: "agent",
        cwd: "stanley-server:/repo/apps/core",
      }),
    ).toBe(" agent @SS:/repo/apps/core");
  });

  it("formats subagent_delegate profile and task", () => {
    const display = formatBuiltinArgs("subagent_delegate", {
      profile: "general",
      task: "Investigate flaky tests in apps/core and propose a fix",
    });

    expect(display.startsWith(" (general) Investigate flaky")).toBe(true);
    expect(display.length).toBeLessThanOrEqual(31);
  });

  it("formats bash with remote cwd prefix", () => {
    expect(
      formatBuiltinArgs("bash", {
        command: "ls -la",
        cwd: "stanley-server:/repo/apps/core",
      }),
    ).toBe(" @SS:/repo/apps/core ls -la");
  });

  it("returns empty string on invalid args", () => {
    expect(formatBuiltinArgs("bash", { nope: true })).toBe("");
    expect(formatBuiltinArgs("read", { nope: true })).toBe("");
    expect(formatBuiltinArgs("patch", { nope: true })).toBe("");
    expect(formatBuiltinArgs("edit", { nope: true })).toBe("");
    expect(formatBuiltinArgs("fuzzy_search", { nope: true })).toBe("");
  });

  it("preserves restored built-in argument formatter fallbacks", () => {
    expect(formatToolArgsForDisplay("readFile", { path: "legacy.txt" })).toBe(" legacy.txt");
    expect(formatToolArgsForDisplay("read_file", { path: "legacy.txt" })).toBe(" legacy.txt");
    expect(formatToolArgsForDisplay("edit_file", { path: "legacy.txt" })).toBe(" legacy.txt");
    expect(
      formatToolArgsForDisplay("apply_patch", {
        patchText: "*** Begin Patch\n*** Delete File: legacy.txt\n*** End Patch",
      }),
    ).toBe(" legacy.txt");
  });

  it("preserves non-Bash arguments in bounded native activity details", () => {
    const args = { pattern: "apps/core/src/surface/native/**/*.ts", cwd: "/workspace/lilac" };
    expect(
      formatToolArgsForDisplayWithSpecs(
        "glob",
        args,
        BUILTIN_TOOL_SPECS,
        undefined,
        undefined,
        8192,
      ),
    ).toBe(` ${JSON.stringify(args)}`);
    expect(
      formatToolArgsForDisplayWithSpecs(
        "plugin_without_formatter",
        args,
        undefined,
        undefined,
        undefined,
        8192,
      ),
    ).toBe(` ${JSON.stringify(args)}`);
    expect(
      formatToolArgsForDisplayWithSpecs(
        "read",
        { filePath: "a".repeat(9000) },
        undefined,
        undefined,
        undefined,
        8192,
      ).length,
    ).toBe(8193);
  });

  it("omits unserializable native arguments", () => {
    expect(
      formatToolArgsForDisplayWithSpecs(
        "custom",
        { value: 1n },
        undefined,
        undefined,
        undefined,
        8192,
      ),
    ).toBe("");
  });

  it("prefers plugin metadata formatter when provided", () => {
    const specs = new Map<string, Level1ToolSpec<unknown>>([
      [
        "custom_tool",
        {
          name: "custom_tool",
          createTool: () => ({}),
          isEnabled: () => true,
          formatArgs: () => " custom-display",
        },
      ],
    ]);

    expect(formatToolArgsForDisplayWithSpecs("custom_tool", { anything: true }, specs)).toBe(
      " custom-display",
    );
  });

  it("omits malformed and failed plugin formatter output", () => {
    const malformed: Level1ToolSpec<unknown> = {
      name: "malformed",
      createTool: () => ({}),
      isEnabled: () => true,
      formatArgs: () => "valid",
    };
    Object.defineProperty(malformed, "formatArgs", { value: () => 42 });
    const failed: Level1ToolSpec<unknown> = {
      name: "failed",
      createTool: () => ({}),
      isEnabled: () => true,
      formatArgs() {
        throw new Error("formatter boom");
      },
    };
    const specs = new Map([
      ["malformed", malformed],
      ["failed", failed],
    ]);

    expect(formatToolArgsForDisplayWithSpecs("malformed", {}, specs)).toBe("");
    expect(formatToolArgsForDisplayWithSpecs("failed", {}, specs)).toBe("");
  });
});
