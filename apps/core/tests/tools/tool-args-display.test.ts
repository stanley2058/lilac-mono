import { describe, expect, it } from "bun:test";

import { formatToolArgsForDisplay } from "../../src/tools/tool-args-display";

describe("formatToolArgsForDisplay", () => {
  it("formats bash command and truncates to 20 chars including ellipsis", () => {
    expect(
      formatToolArgsForDisplay("bash", {
        command: "echo 12345678901234567890",
      }),
    ).toBe(" echo 123456789012...");
  });

  it("formats readFile path with middle truncation (7 ... 10)", () => {
    expect(
      formatToolArgsForDisplay("readFile", {
        path: "/path/to/some/really/long/path/to/file.js",
      }),
    ).toBe(" /path/t...to/file.js");
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
      " /path/t...o/file1.js (+3)",
    );
  });

  it("formats apply_patch (openai) as operation path", () => {
    expect(
      formatToolArgsForDisplay("apply_patch", {
        callId: "call_1",
        operation: {
          type: "update_file",
          path: "/path/to/some/really/long/path/to/file.js",
          diff: "@@\n-a\n+b\n",
        },
      }),
    ).toBe(" /path/t...to/file.js");
  });

  it("returns empty string on invalid args", () => {
    expect(formatToolArgsForDisplay("bash", { nope: true })).toBe("");
    expect(formatToolArgsForDisplay("readFile", { nope: true })).toBe("");
    expect(formatToolArgsForDisplay("apply_patch", { nope: true })).toBe("");
  });
});
