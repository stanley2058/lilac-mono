import { describe, expect, it, spyOn } from "bun:test";
import * as filesystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DATA_FILES_PROGRAM, readDataFileResult, writeDataFiles } from "../src/data-files";

const spawnProcess = Bun.spawn;

function completedCommand(code: number, stdout = "", stderr = "") {
  return spawnProcess(
    [
      process.execPath,
      "--eval",
      `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
}

async function withProtectedRead<T>(run: () => Promise<T>): Promise<T> {
  const read = spyOn(filesystem, "readFile").mockRejectedValue(
    Object.assign(new Error("fixture private filesystem detail"), { code: "EACCES" }),
  );
  try {
    return await run();
  } finally {
    read.mockRestore();
  }
}

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
  it("pulls a pruned recorded image before reading protected existing configuration", async () => {
    await withProtectedRead(async () => {
      const image = "registry.example/lilac:recorded-release";
      const content = "configVersion: 2\nbasePrompt: Keep this configuration\n";
      const spawn = spyOn(Bun, "spawn")
        .mockImplementationOnce(() => completedCommand(1))
        .mockImplementationOnce(() => completedCommand(0))
        .mockImplementationOnce(() => completedCommand(0, content));
      try {
        const result = await readDataFileResult("/example/data", "core-config.yaml", image);
        expect(result.match({ ok: (value) => value, err: () => undefined })).toBe(content);
        expect(spawn).toHaveBeenCalledTimes(3);
        expect(spawn.mock.calls[0]?.[0]).toEqual([
          "docker",
          "image",
          "inspect",
          image,
          "--format",
          "{{.Id}}",
        ]);
        expect(spawn.mock.calls[1]?.[0]).toEqual(["docker", "pull", image]);
        const [args, options] = spawn.mock.calls[2]!;
        expect(args).toContain("--pull=never");
        expect(args).toContain("--read-only");
        expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
          "--network",
          "none",
        ]);
        expect(args.filter((arg) => arg === "--mount")).toHaveLength(1);
        expect(args[args.indexOf("--mount") + 1]).toBe(
          'type=bind,"source=/example/data",target=/data,readonly',
        );
        expect(args[args.indexOf("--entrypoint") + 2]).toBe(image);
        expect(options?.stdin).toBeInstanceOf(Blob);
        if (options?.stdin instanceof Blob) {
          expect(await options.stdin.json()).toEqual({
            action: "read",
            relativePath: "core-config.yaml",
          });
        }
      } finally {
        spawn.mockRestore();
      }
    });
  });

  it("uses a cached image and recognizes only the helper's explicit missing-file result", async () => {
    await withProtectedRead(async () => {
      const spawn = spyOn(Bun, "spawn")
        .mockImplementationOnce(() => completedCommand(0))
        .mockImplementationOnce(() => completedCommand(44));
      try {
        const result = await readDataFileResult(
          "/example/data",
          "missing.yaml",
          "registry.example/lilac:recorded-release",
        );
        expect(result.match({ ok: (value) => value, err: () => "failed" })).toBeUndefined();
        expect(spawn.mock.calls.map(([args]) => args[1])).toEqual(["image", "run"]);
      } finally {
        spawn.mockRestore();
      }
    });
  });

  it("returns a sanitized image-pull failure without treating existing config as missing", async () => {
    await withProtectedRead(async () => {
      const diagnostic = "fixture private registry detail";
      const spawn = spyOn(Bun, "spawn")
        .mockImplementationOnce(() => completedCommand(1, diagnostic, diagnostic))
        .mockImplementationOnce(() => completedCommand(1, diagnostic, diagnostic));
      try {
        const result = await readDataFileResult(
          "/example/data",
          "core-config.yaml",
          "registry.example/lilac:recorded-release",
        );
        expect(result.isErr()).toBe(true);
        expect(
          result.match({ ok: () => "unexpected success", err: (error) => error.message }),
        ).toBe(
          "Could not pull the Core image needed to access private data files. Check registry access, then rerun setup.",
        );
        expect(spawn.mock.calls.map(([args]) => args[1])).toEqual(["image", "pull"]);
        expect(spawn.mock.calls[0]?.[1]?.stdout).toBe("pipe");
        expect(spawn.mock.calls[0]?.[1]?.stderr).toBe("pipe");
        expect(spawn.mock.calls[1]?.[1]?.stdout).toBe("inherit");
        expect(spawn.mock.calls[1]?.[1]?.stderr).toBe("inherit");
      } finally {
        spawn.mockRestore();
      }
    });
  });

  it("sanitizes image inspection failures and stops before running the data helper", async () => {
    await withProtectedRead(async () => {
      const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
        throw new Error("fixture private process detail");
      });
      try {
        const result = await readDataFileResult(
          "/example/data",
          "core-config.yaml",
          "registry.example/lilac:recorded-release",
        );
        expect(result.isErr()).toBe(true);
        expect(
          result.match({ ok: () => "unexpected success", err: (error) => error.message }),
        ).toBe("Could not run docker.");
        expect(spawn).toHaveBeenCalledTimes(1);
      } finally {
        spawn.mockRestore();
      }
    });
  });

  it("rejects invalid read and write image references before any Docker command", async () => {
    await withProtectedRead(async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "installer-invalid-image-"));
      const spawn = spyOn(Bun, "spawn");
      try {
        const read = await readDataFileResult(directory, "core-config.yaml", "--invalid");
        const written = await writeDataFiles(directory, [], "--invalid");
        const message = "The configured Core image is not a valid image reference.";
        expect(read.match({ ok: () => "unexpected success", err: (error) => error.message })).toBe(
          message,
        );
        expect(
          written.match({ ok: () => "unexpected success", err: (error) => error.message }),
        ).toBe(message);
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        spawn.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

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
