import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function runBunTest(cwd: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-workspace-test-data-"));

  try {
    const proc = Bun.spawn(["bun", "test", "--pass-with-no-tests"], {
      cwd,
      env: { ...process.env, DATA_DIR: dataDir },
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
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe("workspace tests", () => {
  it("runs bun tests in each workspace", async () => {
    const roots = [
      "apps/core",
      "apps/acp-controller",
      "apps/mini-lilac-server",
      "apps/mini-lilac-tui",
      "packages/utils",
      "packages/event-bus",
      "packages/mini-lilac-client",
      "packages/mini-lilac-runtime",
    ];

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
