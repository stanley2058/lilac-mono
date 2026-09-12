import { describe, expect, it, spyOn } from "bun:test";
import * as filesystem from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "better-result";
import { InstallerDataFailed, type DataFileWriter } from "../src/data-files";
import { writeInstallation } from "../src/deployment";
import type { SetupDraft } from "../src/types";

function settings(root: string) {
  const draft: SetupDraft = {
    get: () => undefined,
    set: () => {},
    remove: () => {},
    secrets: { PROVIDER_KEY: "replacement-fixture-key" },
    files: [],
    stagingDir: "",
    readExistingFile: async () => undefined,
    computerEnabled: false,
  };
  return {
    root,
    draft,
    config: "configVersion: 2\n",
    compose: "services: {}\n",
    image: "registry.example/lilac:release",
    installExecutable: true,
  };
}

describe("installation write preparation", () => {
  it("preserves an existing dotenv file byte for byte when confirmed credentials use Compose overrides", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "installer-preserved-environment-"));
    const source =
      "# operator credentials\r\nPROVIDER_KEY=\"old-key\" # keep comment\r\nREF=${PROVIDER_KEY}\r\nMULTILINE='first\nsecond'\r\n";
    const options = settings(root);
    options.installExecutable = false;
    options.draft.preservedEnvironmentSource = source;
    try {
      await Bun.write(path.join(root, "secrets.env"), source);
      const result = await writeInstallation(options, async () => Result.ok(undefined));
      expect(result.isOk()).toBe(true);
      expect(await readFile(path.join(root, "secrets.env"), "utf8")).toBe(source);
      expect((await stat(path.join(root, "secrets.env"))).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(root, "compose.yaml"), "utf8")).toBe(options.compose);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps live data unchanged and removes staged credentials if a later host write fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "installer-host-write-failure-"));
    const writeFile = Bun.write;
    const write = spyOn(Bun, "write")
      .mockImplementationOnce(writeFile)
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("fixture disk full"), { code: "ENOSPC" })),
      );
    let dataWrites = 0;
    const writeData: DataFileWriter = async () => {
      dataWrites++;
      return Result.ok(undefined);
    };
    try {
      const result = await writeInstallation(settings(root), writeData);
      expect(result.isErr()).toBe(true);
      expect(dataWrites).toBe(0);
      expect(await Bun.file(path.join(root, "secrets.env")).exists()).toBe(false);
      expect(await Bun.file(path.join(root, "compose.yaml")).exists()).toBe(false);
      expect(
        (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      write.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const dataSucceeds of [true, false]) {
    it(`attempts all temporary-file removals and returns an expected failure after a ${dataSucceeds ? "successful" : "failed"} data write`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "installer-cleanup-failure-"));
      const removeFile = filesystem.rm;
      const attempts: string[] = [];
      const remove = spyOn(filesystem, "rm").mockImplementation(async (filename, options) => {
        attempts.push(String(filename));
        if (attempts.length === 1)
          throw Object.assign(new Error("fixture private filesystem detail"), { code: "EACCES" });
        return removeFile(filename, options);
      });
      const writeData: DataFileWriter = async () => {
        if (dataSucceeds) return Result.ok(undefined);
        return Result.err(
          new InstallerDataFailed({ message: "Fixture data preparation failure." }),
        );
      };
      try {
        const result = await writeInstallation(settings(root), writeData);
        expect(result.isErr()).toBe(true);
        expect(attempts).toHaveLength(3);
        expect(
          result.match({ ok: () => "unexpected success", err: (error) => error.message }),
        ).toBe(
          dataSucceeds
            ? "Could not remove temporary installation files. Check directory permissions before rerunning setup."
            : "Fixture data preparation failure.",
        );
        const remaining = (await readdir(root, { recursive: true })).filter((name) =>
          name.endsWith(".tmp"),
        );
        expect(remaining).toHaveLength(dataSucceeds ? 0 : 1);
      } finally {
        remove.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  for (const blocked of ["secrets.env", "compose.yaml", "bin/lilac", "bin"]) {
    it(`leaves live data untouched when ${blocked} cannot be replaced`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "installer-blocked-host-"));
      let dataWrites = 0;
      const writeData: DataFileWriter = async () => {
        dataWrites++;
        return Result.ok(undefined);
      };
      try {
        await mkdir(path.join(root, "data"));
        await Bun.write(path.join(root, "data", "core-config.yaml"), "previous config\n");
        if (blocked === "bin") await Bun.write(path.join(root, blocked), "operator file\n");
        else await mkdir(path.join(root, blocked), { recursive: true });
        const result = await writeInstallation(settings(root), writeData);
        expect(result.isErr()).toBe(true);
        expect(dataWrites).toBe(0);
        expect(await readFile(path.join(root, "data", "core-config.yaml"), "utf8")).toBe(
          "previous config\n",
        );
        expect(
          (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".tmp")),
        ).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  for (const dataSucceeds of [true, false]) {
    it(`stages private host files and the executable before a ${dataSucceeds ? "successful" : "failed"} data write`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "installer-staged-host-"));
      const previousCompose = "services:\n  lilac:\n    image: registry.example/previous:release\n";
      const previousSecrets = "PROVIDER_KEY=previous-fixture-key\n";
      const previousExecutable = "previous executable\n";
      const options = settings(root);
      let dataWrites = 0;
      const writeData: DataFileWriter = async () => {
        dataWrites++;
        expect(await readFile(path.join(root, "compose.yaml"), "utf8")).toBe(previousCompose);
        expect(await readFile(path.join(root, "secrets.env"), "utf8")).toBe(previousSecrets);
        expect(await readFile(path.join(root, "bin", "lilac"), "utf8")).toBe(previousExecutable);
        const temporary = (await readdir(root, { recursive: true })).filter((name) =>
          name.endsWith(".tmp"),
        );
        expect(temporary).toHaveLength(3);
        for (const name of temporary) {
          const details = await stat(path.join(root, name));
          if (name.startsWith("bin/")) {
            expect(details.mode & 0o777).toBe(0o755);
            expect(details.size).toBe((await stat(process.execPath)).size);
            continue;
          }
          expect(details.mode & 0o777).toBe(0o600);
        }
        if (dataSucceeds) return Result.ok(undefined);
        return Result.err(
          new InstallerDataFailed({ message: "Fixture image preparation failure." }),
        );
      };
      try {
        await mkdir(path.join(root, "bin"));
        await Bun.write(path.join(root, "compose.yaml"), previousCompose);
        await Bun.write(path.join(root, "secrets.env"), previousSecrets);
        await Bun.write(path.join(root, "bin", "lilac"), previousExecutable);
        const result = await writeInstallation(options, writeData);
        expect(result.isOk()).toBe(dataSucceeds);
        expect(dataWrites).toBe(1);
        expect(await readFile(path.join(root, "compose.yaml"), "utf8")).toBe(
          dataSucceeds ? options.compose : previousCompose,
        );
        expect(await readFile(path.join(root, "secrets.env"), "utf8")).toBe(
          dataSucceeds ? "PROVIDER_KEY=replacement-fixture-key\n" : previousSecrets,
        );
        expect((await stat(path.join(root, "bin", "lilac"))).size).toBe(
          dataSucceeds ? (await stat(process.execPath)).size : previousExecutable.length,
        );
        expect(
          (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".tmp")),
        ).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
