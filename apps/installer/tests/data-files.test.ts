import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DATA_FILES_PROGRAM, readDataFileResult } from "../src/data-files";

async function runProgram(directory: string, request: object) {
  const child = Bun.spawn([process.execPath, "--eval", DATA_FILES_PROGRAM, "--", directory], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("installer private data files", () => {
  it("reads existing files and distinguishes missing files without emitting their contents", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "installer-data-read-"));
    try {
      await writeFile(path.join(directory, "core-config.yaml"), "configVersion: 2\n", {
        mode: 0o600,
      });
      const read = await readDataFileResult(
        directory,
        "core-config.yaml",
        "registry.example/unused:release",
      );
      expect(read.match({ ok: (value) => value, err: () => undefined })).toBe("configVersion: 2\n");
      const missing = await readDataFileResult(
        directory,
        "missing",
        "registry.example/unused:release",
      );
      expect(missing.match({ ok: (value) => value, err: () => "failed" })).toBeUndefined();
      expect(
        (
          await readDataFileResult(directory, "../outside", "registry.example/unused:release")
        ).isErr(),
      ).toBe(true);
      expect(await runProgram(directory, { action: "read", relativePath: "missing" })).toEqual({
        code: 44,
        stdout: "",
        stderr: "",
      });
      expect(await runProgram(directory, { action: "read", relativePath: "../outside" })).toEqual({
        code: 1,
        stdout: "",
        stderr: "Could not access Lilac data.\n",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(![0, 1000].includes(process.getuid?.() ?? -1))(
    "sets private modes and container ownership while preserving existing data",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "installer-data-write-"));
      try {
        await mkdir(path.join(directory, "workspace"));
        await writeFile(path.join(directory, "workspace", "keep.txt"), "retained");
        const payload = {
          action: "write",
          files: [
            { relativePath: "core-config.yaml", content: "configVersion: 2\n", mode: 0o600 },
            { relativePath: "secret/provider.json", content: '{"fixture":true}\n', mode: 0o600 },
          ],
        };
        expect(await runProgram(directory, payload)).toEqual({ code: 0, stdout: "", stderr: "" });
        expect(await runProgram(directory, payload)).toEqual({ code: 0, stdout: "", stderr: "" });
        for (const filename of ["core-config.yaml", "secret/provider.json"]) {
          const information = await stat(path.join(directory, filename));
          expect(information.uid).toBe(1000);
          expect(information.gid).toBe(1000);
          expect(information.mode & 0o777).toBe(0o600);
        }
        expect((await stat(path.join(directory, "secret"))).mode & 0o777).toBe(0o700);
        expect(await readFile(path.join(directory, "workspace", "keep.txt"), "utf8")).toBe(
          "retained",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
