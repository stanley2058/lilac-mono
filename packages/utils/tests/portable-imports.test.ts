import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const portableModules = [
  "utils/logging.ts",
  "utils/runtime-utils.ts",
  "utils/claude-code-executable.ts",
  "agent/index.ts",
  "claude-code-bridge/index.ts",
  "plugin-runtime/index.ts",
  "tool-results/src/index.ts",
  "tool-results/src/tool-result-output-normalizer.ts",
];

describe("portable package imports", () => {
  for (const modulePath of portableModules) {
    it(`imports ${modulePath} without Core configuration or provider setup`, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "lilac-portable-import-"));
      const moduleUrl = new URL(`../../${modulePath}`, import.meta.url).href;
      const source = `
        delete process.env.DATA_DIR;
        Bun.which = () => { throw new Error("Import attempted executable discovery"); };
        await import(${JSON.stringify(moduleUrl)});
      `;
      try {
        const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", source], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});
