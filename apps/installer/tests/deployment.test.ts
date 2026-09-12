import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { Result } from "better-result";
import { InstallerDataFailed, type DataFileWriter } from "../src/data-files";
import type { SetupFile } from "../src/types";
import {
  createDeployment,
  parseDeployment,
  readEnvironment,
  serializeEnvironment,
  validateDeploymentInputs,
  writeInstallation,
} from "../src/deployment";
import type { SetupDraft } from "../src/types";

function draft(): SetupDraft {
  return {
    get: () => undefined,
    set: () => {},
    remove: () => {},
    secrets: {},
    files: [],
    stagingDir: "",
    readExistingFile: async () => undefined,
    computerEnabled: false,
  };
}
const images = {
  core: "registry.example/lilac:release",
  gateway: "registry.example/gateway:release",
  runner: "registry.example/runner:release",
};

describe("installer deployment", () => {
  it("keeps credential punctuation literal with Compose raw environment files", () => {
    const secrets = { PROVIDER_KEY: 'literal$TOKEN#quote"value\\suffix', EMPTY: "" };
    expect(readEnvironment(serializeEnvironment(secrets))).toEqual(secrets);
    const document = createDeployment("/example/instance", draft(), images);
    expect(document.getIn(["services", "lilac", "env_file", 0, "format"])).toBe("raw");
    expect(document.getIn(["services", "lilac", "ports"])).toBeUndefined();
    expect(document.getIn(["services", "lilac", "build"])).toBeUndefined();
    expect(document.getIn(["services", "lilac", "image"])).toBe(images.core);
  });

  it("preserves custom Compose fields and comments when selecting a new image", () => {
    const original = parseDocument(
      "# custom deployment\nservices:\n  lilac:\n    image: registry.example/old:release\n    mem_limit: 9g # operator limit\n    labels:\n      custom: keep\n  extra:\n    image: registry.example/extra:release\n",
    );
    const updated = createDeployment("/example/instance", draft(), images, original);
    expect(updated.getIn(["services", "lilac", "image"])).toBe(images.core);
    expect(updated.getIn(["services", "lilac", "mem_limit"])).toBe("9g");
    expect(updated.getIn(["services", "extra", "image"])).toBe("registry.example/extra:release");
    expect(updated.toString()).toContain("# operator limit");
    expect(original.getIn(["services", "lilac", "image"])).toBe("registry.example/old:release");
  });

  it("adds optional computer services without replacing the Core deployment", () => {
    const state = draft();
    state.computerEnabled = true;
    const document = createDeployment("/example/instance", state, images);
    expect(
      document.getIn(["services", "computer-use-gateway", "environment", "RUNNER_IMAGE"]),
    ).toBe(images.runner);
    expect(document.getIn(["services", "computer-use-gateway", "volumes", 0])).toBe(
      "/var/run/docker.sock:/var/run/docker.sock",
    );
    expect(document.getIn(["services", "lilac", "depends_on", "redis", "condition"])).toBe(
      "service_healthy",
    );
  });

  it("rejects malformed deployment inputs before writes", () => {
    const state = draft();
    state.secrets.INVALID = "value\nINJECTED=oops";
    expect(validateDeploymentInputs(state, images).isErr()).toBe(true);
    state.secrets = {};
    state.files.push({ relativePath: "../outside", content: "no" });
    expect(validateDeploymentInputs(state, images).isErr()).toBe(true);
    expect(parseDeployment("services: [").isErr()).toBe(true);
    expect(parseDeployment("services:\n  unrelated:\n    image: example\n").isErr()).toBe(true);
  });

  it("keeps existing image and credentials readable when private data preparation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "installer-failed-update-"));
    const previousCompose = "services:\n  lilac:\n    image: registry.example/previous:release\n";
    const previousSecrets = "PROVIDER_KEY=previous-key\n";
    const failData: DataFileWriter = async () =>
      Result.err(new InstallerDataFailed({ message: "Image pull failed." }));
    try {
      await Bun.write(path.join(root, "compose.yaml"), previousCompose);
      await Bun.write(path.join(root, "secrets.env"), previousSecrets);
      const state = draft();
      state.secrets.PROVIDER_KEY = "replacement-key";
      const result = await writeInstallation(
        {
          root,
          draft: state,
          config: "configVersion: 2\n",
          compose: "services: {}\n",
          image: "registry.example/unavailable:release",
          installExecutable: false,
        },
        failData,
      );
      expect(result.isErr()).toBe(true);
      expect(await readFile(path.join(root, "compose.yaml"), "utf8")).toBe(previousCompose);
      expect(await readFile(path.join(root, "secrets.env"), "utf8")).toBe(previousSecrets);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create an apparent installation when a fresh image pull fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "installer-failed-fresh-"));
    const failData: DataFileWriter = async () =>
      Result.err(new InstallerDataFailed({ message: "Image pull failed." }));
    try {
      const result = await writeInstallation(
        {
          root,
          draft: draft(),
          config: "configVersion: 2\n",
          compose: "services: {}\n",
          image: "registry.example/unavailable:release",
          installExecutable: false,
        },
        failData,
      );
      expect(result.isErr()).toBe(true);
      expect(await Bun.file(path.join(root, "compose.yaml")).exists()).toBe(false);
      expect(await Bun.file(path.join(root, "secrets.env")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps operator files private and sends data files to the container ownership writer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "installer-deployment-"));
    const writes: { dataDir: string; files: readonly SetupFile[]; image: string }[] = [];
    const writeData: DataFileWriter = async (dataDir, files, image) => {
      writes.push({ dataDir, files, image });
      return Result.ok(undefined);
    };
    try {
      const state = draft();
      state.secrets.PROVIDER_KEY = "fixture-key";
      state.files.push({ relativePath: "secret/provider.json", content: '{"fixture":true}\n' });
      const settings = {
        root,
        draft: state,
        config: "configVersion: 2\n",
        compose: "services: {}\n",
        installExecutable: false,
        image: images.core,
      };
      expect((await writeInstallation(settings, writeData)).isOk()).toBe(true);
      await Bun.write(path.join(root, "keep.txt"), "retained");
      expect((await writeInstallation(settings, writeData)).isOk()).toBe(true);
      expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("retained");
      expect((await stat(path.join(root, "secrets.env"))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(root, "compose.yaml"))).mode & 0o777).toBe(0o600);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual({
        dataDir: path.join(root, "data"),
        image: images.core,
        files: [
          { relativePath: "core-config.yaml", content: settings.config, mode: 0o600 },
          ...state.files,
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
