import { describe, expect, it } from "bun:test";
import { executeBash } from "../../src/tools/bash-impl";
import { analyzeBashCommand } from "../../src/tools/bash-safety";

describe("executeBash", () => {
  it("executes a command and returns output", async () => {
    const res = await executeBash({ command: "echo hello" });

    expect(res.exitCode).toBe(0);
    expect(res.executionError).toBeUndefined();
    expect(res.stdout).toContain("hello");
  });

  it("does not set executionError for command failures", async () => {
    const res = await executeBash({ command: "exit 2" });

    expect(res.exitCode).toBe(2);
    expect(res.executionError).toBeUndefined();
  });

  it("returns a timeout executionError when exceeded", async () => {
    const res = await executeBash({ command: "sleep 10", timeoutMs: 50 });

    expect(res.executionError).toBeDefined();
    expect(res.executionError?.type).toBe("timeout");
    if (res.executionError?.type === "timeout") {
      expect(res.executionError.timeoutMs).toBe(50);
      expect(res.executionError.signal.length).toBeGreaterThan(0);
    }
    expect(res.exitCode).not.toBe(0);
  });

  it("returns an exception executionError when cwd is invalid", async () => {
    const res = await executeBash({
      command: "echo hi",
      cwd: "/this/path/definitely/does/not/exist",
    });

    expect(res.exitCode).toBe(-1);
    expect(res.executionError).toBeDefined();
    expect(res.executionError?.type).toBe("exception");
    if (res.executionError?.type === "exception") {
      expect(res.executionError.phase).toBe("spawn");
      expect(res.executionError.message.length).toBeGreaterThan(0);
    }
  });
});

describe("analyzeBashCommand", () => {
  it("allows benign commands", () => {
    expect(analyzeBashCommand("echo hello")).toBeNull();
    expect(analyzeBashCommand("git status")).toBeNull();
  });

  it("blocks destructive git commands", () => {
    const result = analyzeBashCommand("git reset --hard");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("git reset --hard");
  });

  it("blocks rm -rf against root", () => {
    const result = analyzeBashCommand("rm -rf /");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("root");
  });

  it("allows rm -rf against temp paths", () => {
    const result = analyzeBashCommand("rm -rf /tmp/cache");
    expect(result).toBeNull();
  });

  it("blocks commands wrapped in bash -c", () => {
    const result = analyzeBashCommand("bash -c 'git reset --hard'");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("git reset --hard");
  });

  it("blocks interpreter one-liners that contain dangerous commands", () => {
    const result = analyzeBashCommand(
      "python -c 'import os; os.system(\"rm -rf /\")'",
    );
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("interpreter");
  });

  it("blocks find -delete", () => {
    const result = analyzeBashCommand("find . -delete");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("find -delete");
  });

  it("blocks xargs rm -rf even with temp targets", () => {
    const result = analyzeBashCommand("xargs rm -rf /tmp/cache");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("xargs");
  });

  it("blocks parallel shell -c", () => {
    const result = analyzeBashCommand("parallel bash -c '{}' ::: 'echo hi'");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("parallel");
  });
});
