import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("persistent Python execution and framed output", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "tests", "-v"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  expect(result.stderr).not.toContain("FAILED");
  expect(result.status).toBe(0);
});
