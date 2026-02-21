import { describe, expect, it } from "bun:test";

import { formatToolArgsForDisplay } from "../../src/tools/tool-args-display";

describe("formatToolArgsForDisplay", () => {
  it("formats bash command and truncates to 30 chars including ellipsis", () => {
    expect(
      formatToolArgsForDisplay("bash", {
        command: "echo 12345678901234567890123456789012345678901234567890",
      }),
    ).toBe(" echo 1234567890123456789012...");
  });

  it("formats readFile path with middle truncation (14 ... 13)", () => {
    expect(
      formatToolArgsForDisplay("read_file", {
        path: "/path/to/some/really/long/path/to/file.js",
      }),
    ).toBe(" /path/to/some/...th/to/file.js");
  });

  it("formats remote read_file path with host initials", () => {
    expect(
      formatToolArgsForDisplay("read_file", {
        path: "ssh://stanley-server/some/really/long/path/to/file.js",
      }),
    ).toBe(" @SS:/some/real...th/to/file.js");
  });

  it("keeps scp-style read_file path literal", () => {
    expect(
      formatToolArgsForDisplay("read_file", {
        path: "stanley-desktop:/repo/apps/core/src/index.ts",
      }),
    ).toBe(" stanley-deskto.../src/index.ts");
  });

  it("keeps local filenames with ':' literal", () => {
    expect(
      formatToolArgsForDisplay("read_file", {
        path: "notes:2026.md",
      }),
    ).toBe(" notes:2026.md");
  });

  it("formats apply_patch (local) as first file + remaining count", () => {
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

    expect(formatToolArgsForDisplay("apply_patch", { patchText })).toBe(
      " /path/to/some/...h/to/file1.js (+3)",
    );
  });

  it("formats edit_file path with middle truncation", () => {
    expect(
      formatToolArgsForDisplay("edit_file", {
        path: "/path/to/some/really/long/path/to/file.js",
        oldText: "a",
        newText: "b",
      }),
    ).toBe(" /path/to/some/...th/to/file.js");
  });

  it("formats grep as pattern + cwd", () => {
    expect(
      formatToolArgsForDisplay("grep", {
        pattern: "foo",
        cwd: "/tmp",
      }),
    ).toBe(" foo /tmp");
  });

  it("formats grep remote cwd with host initials", () => {
    expect(
      formatToolArgsForDisplay("grep", {
        pattern: "foo",
        cwd: "stanley-server:/repo/apps/core",
      }),
    ).toBe(" foo @SS:/repo/apps/core");
  });

  it("formats glob as patterns + cwd", () => {
    expect(
      formatToolArgsForDisplay("glob", {
        patterns: ["a", "b"],
        cwd: "/c",
      }),
    ).toBe(" a,b /c");
  });

  it("formats subagent_delegate task regardless of profile", () => {
    const display = formatToolArgsForDisplay("subagent_delegate", {
      profile: "general",
      task: "Investigate flaky tests in apps/core and propose a fix",
    });

    expect(display.startsWith(" Investigate flaky tests in")).toBe(true);
    expect(display.length).toBeLessThanOrEqual(31);
  });

  it("formats bash with remote cwd prefix", () => {
    expect(
      formatToolArgsForDisplay("bash", {
        command: "ls -la",
        cwd: "stanley-server:/repo/apps/core",
      }),
    ).toBe(" @SS:/repo/apps/core ls -la");
  });

  it("returns empty string on invalid args", () => {
    expect(formatToolArgsForDisplay("bash", { nope: true })).toBe("");
    expect(formatToolArgsForDisplay("read_file", { nope: true })).toBe("");
    expect(formatToolArgsForDisplay("apply_patch", { nope: true })).toBe("");
    expect(formatToolArgsForDisplay("edit_file", { nope: true })).toBe("");
  });
});
