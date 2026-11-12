import { expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { parseEnv } from "../../../packages/utils/env";
import { parseCoreConfigResult } from "../../../packages/utils/core-config/parse";
import {
  createConfigDocument,
  getConfigValue,
  setConfigValue,
  deleteConfigValue,
  validateConfigDocument,
} from "../src/config-document";
import { createDeployment } from "../src/deployment";
import { configureOptional } from "../src/optional";
import type { Prompt, SetupDraft } from "../src/types";

function fixture() {
  const document = createConfigDocument();
  const draft: SetupDraft = {
    get: (key) => getConfigValue(document, key),
    set: (key, value) => setConfigValue(document, key, value),
    remove: (key) => deleteConfigValue(document, key),
    secrets: {},
    files: [],
    stagingDir: "",
    computerEnabled: false,
    readExistingFile: async () => undefined,
  };
  return { document, draft };
}

it("keeps installer environment names tied to runtime readers and configured env references", async () => {
  const { document, draft } = fixture();
  const pending = [
    "blobs",
    "s3",
    "bucket",
    "prefix",
    "https://s3.example.com",
    "us-east-1",
    "key",
    "secret",
    "token",
    "done",
  ];
  const next = () => pending.shift()!;
  const prompt: Prompt = {
    text: async () => next(),
    select: async (_message, choices) => {
      const value = next();
      return choices.find((entry) => entry.value === value)!.value;
    },
    confirm: async () => true,
    note: () => {},
  };
  await configureOptional(prompt, draft);
  expect(pending).toEqual([]);
  const config = validateConfigDocument(document).unwrap();
  const defaults = parseCoreConfigResult({ configVersion: 3 }).unwrap();
  const coreNames = new Set(
    [...parseEnv.toString().matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((match) => match[1]!),
  );
  coreNames.add(defaults.surface.discord.tokenEnv);
  expect(config.blobStorage.kind).toBe("s3");
  if (config.blobStorage.kind === "s3") {
    coreNames.add(config.blobStorage.accessKeyIdEnv);
    coreNames.add(config.blobStorage.secretAccessKeyEnv);
    if (config.blobStorage.sessionTokenEnv) coreNames.add(config.blobStorage.sessionTokenEnv);
  }
  const gatewaySource = await readFile(
    new URL("../../computer-use-gateway/src/contracts.ts", import.meta.url),
    "utf8",
  );
  const gatewayNames = new Set(
    [...gatewaySource.matchAll(/^  ([A-Z][A-Z0-9_]+): z\./gm)].map((match) => match[1]!),
  );
  const directory = new URL("../src/", import.meta.url);
  const installerNames = new Set<string>();
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith(".ts")) continue;
    const source = await readFile(new URL(filename, directory), "utf8");
    for (const match of source.matchAll(/"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"/g))
      installerNames.add(match[1]!);
  }
  expect(installerNames.size).toBeGreaterThan(25);
  expect(
    [...installerNames].filter((name) => !coreNames.has(name) && !gatewayNames.has(name)),
  ).toEqual([]);
});

it("keeps shared Compose and Dockerfile environment defaults equal", async () => {
  const { draft } = fixture();
  const deployment = createDeployment("/fixture", draft, {
    core: "test:1",
    gateway: "test:1",
    runner: "test:1",
  });
  const environment = deployment.toJS().services.lilac.environment as Record<string, string>;
  const source = await readFile(
    fileURLToPath(new URL("../../../Dockerfile", import.meta.url)),
    "utf8",
  );
  const imageEnvironment: Record<string, string> = {};
  for (const match of source.matchAll(/^ENV ([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
    const value = match[2]!.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_whole, key: string) => {
      expect(imageEnvironment[key], `Unresolved Docker ENV ${key}`).toBeDefined();
      return imageEnvironment[key]!;
    });
    imageEnvironment[match[1]!] = value;
  }
  const sourceCompose = parseDocument(
    await readFile(new URL("../../../compose.yaml", import.meta.url), "utf8"),
  ).toJS().services.lilac.environment as Record<string, string>;
  const coreNames = new Set(
    [...parseEnv.toString().matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((match) => match[1]!),
  );
  for (const key of Object.keys(environment)) {
    expect(
      coreNames.has(key) || key in imageEnvironment,
      `No runtime reader for Compose ${key}`,
    ).toBe(true);
  }
  for (const values of [environment, sourceCompose]) {
    const shared = Object.keys(values).filter((key) => key in imageEnvironment);
    expect(shared.length).toBeGreaterThan(5);
    for (const key of shared) {
      const value = values[key]!.replace(/\$\{[A-Z][A-Z0-9_]*:-([^}]*)\}/g, "$1");
      expect(value, key).toBe(imageEnvironment[key]!);
    }
  }
});
