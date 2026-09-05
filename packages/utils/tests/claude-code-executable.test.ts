import { describe, expect, it } from "bun:test";

import { claudeCodeExecutableSettings } from "../claude-code-executable";

describe("claudeCodeExecutableSettings", () => {
  it("points the SDK at the resolved Claude installation", () => {
    expect(claudeCodeExecutableSettings(() => "/usr/local/bin/claude")).toEqual({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    });
  });

  it("stays empty when no claude is installed", () => {
    // The Agent SDK's own resolution and diagnostic must survive untouched
    // rather than being overridden with an empty path.
    expect(claudeCodeExecutableSettings(() => null)).toEqual({});
  });
});
