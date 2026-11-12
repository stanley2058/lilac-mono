import { describe, expect, it } from "bun:test";

describe("remote fs runner version", () => {
  it("reports the package version from the built CLI", async () => {
    const packageDir = import.meta.dir.replace(/\/tests$/u, "");
    const built = Bun.spawn(["bun", "run", "build.ts"], {
      cwd: packageDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildStderr, buildExitCode] = await Promise.all([
      new Response(built.stderr).text(),
      built.exited,
    ]);
    expect(buildExitCode, buildStderr).toBe(0);

    const versionProcess = Bun.spawn(["node", "dist/cli.js", "--version"], {
      cwd: packageDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(versionProcess.stdout).text(),
      new Response(versionProcess.stderr).text(),
      versionProcess.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("0.0.7");
  });
});
