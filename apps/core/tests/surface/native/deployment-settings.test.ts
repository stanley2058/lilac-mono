import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeDeploymentSettingsSchema } from "@stanley2058/lilac-client-protocol";
import {
  parseCoreConfigV2ToUniversal,
  parseCoreConfigV3ToUniversal,
} from "@stanley2058/lilac-utils";
import { NativeStore } from "../../../src/surface/native/store";
import { createNativeIntegrationFixture } from "./integration-fixture";

const initial = {
  titleModel: "main",
  outputStreaming: "complete" as const,
  dmContextGapMs: 7_200_000,
  dmTimestampGapMs: 1_800_000,
  oldMessageSelectionMaxAgeMs: 60000,
  storageRetentionMaxAgeMs: 86400000,
  crossThreadSend: { triggerRun: false },
};

test("deployment settings seed once, survive restart, enforce ownership and reject stale writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-deployment-"));
  const file = path.join(directory, "native.sqlite");
  let store = new NativeStore(new Database(file));
  try {
    store.initialize().unwrap();
    for (const role of ["owner", "participant"] as const)
      store
        .upsertUser({ id: role, providerId: role, displayName: role, role, toolMode: "full" })
        .unwrap();
    store.initializeDeployment(initial).unwrap();
    const document = store.readDeployment("owner").unwrap();
    expect(document.settings).toEqual(initial);
    expect(
      store.readDeployment("participant").match({ ok: () => null, err: (error) => error }),
    ).toMatchObject({ code: "forbidden" });
    expect(
      store
        .setDeployment("participant", { settings: initial, expectedRevision: 0 })
        .match({ ok: () => null, err: (error) => error }),
    ).toMatchObject({ code: "forbidden" });
    const changed = {
      ...initial,
      titleModel: "fast",
      outputStreaming: "paragraph" as const,
      storageRetentionMaxAgeMs: null,
    };
    const saved = store.setDeployment("owner", { settings: changed, expectedRevision: 0 }).unwrap();
    expect(saved.revision).toBe(1);
    expect(
      store
        .setDeployment("owner", { settings: initial, expectedRevision: 0 })
        .match({ ok: () => null, err: (error) => error }),
    ).toMatchObject({ code: "conflict" });
    expect(
      store.setDeployment("owner", { settings: changed, expectedRevision: 1 }).unwrap(),
    ).toEqual(saved);
    store.close();
    store = new NativeStore(new Database(file));
    store.initialize().unwrap();
    store.initializeDeployment(initial).unwrap();
    expect(store.getDeployment().unwrap()).toEqual(saved);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment RPC imports all legacy fields and saves without touching commented YAML", async () => {
  let file = "";
  const yaml =
    "# Operator notes\nconfigVersion: 2\nsurface:\n  native:\n    outputStreaming: complete # Keep this comment\n";
  const fixture = await createNativeIntegrationFixture({
    prepare: async ({ config, dataDir }) => {
      Object.assign(config.surface.native, initial);
      file = path.join(dataDir, "core-config.yaml");
    },
  });
  try {
    await writeFile(file, yaml);
    const { client } = fixture.connect();
    const document = await client.config.readDeployment({});
    expect(document.settings).toEqual(initial);
    const settings = {
      ...initial,
      titleModel: "fast",
      dmContextGapMs: 3_600_000,
      dmTimestampGapMs: 600_000,
      oldMessageSelectionMaxAgeMs: null,
      storageRetentionMaxAgeMs: null,
      crossThreadSend: { triggerRun: true },
      outputStreaming: "paragraph" as const,
    };
    const saved = await client.config.setDeployment({
      settings,
      expectedRevision: document.revision,
    });
    expect(await client.config.readDeployment({})).toEqual(saved);
    expect(fixture.store.getDeployment().unwrap().settings).toEqual(settings);
    expect(await readFile(file, "utf8")).toBe(yaml);
    await expect(
      client.config.setDeployment({ settings: initial, expectedRevision: document.revision }),
    ).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});

test("deployment contract rejects invalid fields and permits unlimited ages", () => {
  expect(
    nativeDeploymentSettingsSchema.safeParse({
      ...initial,
      oldMessageSelectionMaxAgeMs: null,
      storageRetentionMaxAgeMs: null,
    }).success,
  ).toBe(true);
  for (const patch of [
    { titleModel: " " },
    { outputStreaming: "invalid" },
    { oldMessageSelectionMaxAgeMs: 0 },
    { dmContextGapMs: 0 },
    { dmTimestampGapMs: 1.5 },
    { dmContextMaxAgeMs: 10_800_000 },
    { storageRetentionMaxAgeMs: -1 },
    { storageRetentionMaxAgeMs: 1.5 },
    { crossThreadSend: { triggerRun: "yes" } },
  ])
    expect(nativeDeploymentSettingsSchema.safeParse({ ...initial, ...patch }).success).toBe(false);
});

test("stored deployment settings drop the legacy DM context age", () => {
  const store = new NativeStore(new Database(":memory:"));
  try {
    store.initialize().unwrap();
    const { dmContextGapMs: _gap, dmTimestampGapMs: _timestamp, ...legacy } = initial;
    store.initializeDeployment({ ...legacy, dmContextMaxAgeMs: 10_800_000 } as never).unwrap();
    expect(store.getDeployment().unwrap().settings).toEqual({
      ...legacy,
      dmContextGapMs: 7_200_000,
      dmTimestampGapMs: 1_800_000,
    });
  } finally {
    store.close();
  }
});

function deploymentFromConfig(
  native: ReturnType<typeof parseCoreConfigV3ToUniversal>["surface"]["native"],
) {
  return nativeDeploymentSettingsSchema.parse({
    titleModel: native.titleModel,
    outputStreaming: native.outputStreaming,
    oldMessageSelectionMaxAgeMs: native.oldMessageSelectionMaxAgeMs,
    storageRetentionMaxAgeMs: native.storageRetentionMaxAgeMs,
    crossThreadSend: native.crossThreadSend,
    dmContextGapMs: 7_200_000,
    dmTimestampGapMs: 1_800_000,
  });
}

test("switching from v2 native YAML settings to v3 defaults preserves the deployment record", () => {
  const store = new NativeStore(new Database(":memory:"));
  try {
    store.initialize().unwrap();
    const v2 = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      surface: { native: initial },
    });
    const v2Settings = deploymentFromConfig(v2.surface.native);
    store.initializeDeployment(v2Settings).unwrap();
    const imported = store.getDeployment().unwrap();
    const v3 = parseCoreConfigV3ToUniversal({ configVersion: 3 });
    const freshSettings = deploymentFromConfig(v3.surface.native);
    expect(freshSettings.titleModel).toBe("fast");
    expect(freshSettings.outputStreaming).toBe("paragraph");
    expect(freshSettings.crossThreadSend.triggerRun).toBe(true);
    store.initializeDeployment(freshSettings).unwrap();
    expect(store.getDeployment().unwrap()).toEqual(imported);
    expect(imported.settings.titleModel).toBe("main");
    expect(imported.settings.outputStreaming).toBe("complete");
    expect(imported.settings.crossThreadSend.triggerRun).toBe(false);
  } finally {
    store.close();
  }
});
