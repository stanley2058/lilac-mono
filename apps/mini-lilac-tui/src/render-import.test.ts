import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const RENDER_MODULE = path.join(import.meta.dir, "render.ts");

describe("mini-lilac TUI module loading", () => {
  it("loads outside a Bun workspace when DATA_DIR is unset", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "mini-lilac-tui-import-"));
    const env = { ...process.env };
    delete env.DATA_DIR;

    try {
      const process = Bun.spawn(
        [
          Bun.which("bun") ?? "bun",
          "-e",
          `await import(${JSON.stringify(RENDER_MODULE)}); process.stdout.write("ok\\n");`,
        ],
        {
          cwd,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toBe("ok\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
