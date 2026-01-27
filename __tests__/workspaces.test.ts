import { describe, expect, it } from "bun:test";

async function runBunTest(cwd: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", "test", "--pass-with-no-tests"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

describe("workspace tests", () => {
  it("runs bun tests in each workspace", async () => {
    const roots = ["apps/core", "packages/utils", "packages/event-bus"];

    for (const dir of roots) {
      const res = await runBunTest(dir);
      if (res.exitCode !== 0) {
        throw new Error(
          [
            `bun test failed in ${dir} (exitCode=${res.exitCode})`,
            "--- stdout ---",
            res.stdout.trimEnd(),
            "--- stderr ---",
            res.stderr.trimEnd(),
          ].join("\n"),
        );
      }
    }

    expect(true).toBe(true);
  }, 60_000);
});
