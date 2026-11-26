import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Result } from "better-result";
import Redis from "ioredis";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";

import {
  CoreDeadLetterKeyAccessFailed,
  loadOrCreateCoreDeadLetterKey,
  resolveCoreDeadLetterKeyPath,
} from "../../src/runtime/core-dead-letter-key";
import {
  CoreEventBusSetupFailed,
  setupCoreEventBusResources as setupCoreEventBusResourcesOutcome,
} from "../../src/runtime/create-core-runtime";

async function setupCoreEventBusResources(
  params: Parameters<typeof setupCoreEventBusResourcesOutcome>[0],
) {
  const outcome = await setupCoreEventBusResourcesOutcome(params);
  if (outcome.kind === "panic") throw outcome.panic;
  return outcome.result;
}

const temporaryRoots: string[] = [];
const unusedEvidenceBlobStore: Pick<BlobStore, "startUpload"> = {
  startUpload: async () => {
    throw new Error("unexpected dead-letter evidence upload");
  },
};

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-dead-letter-key-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("Core dead-letter encryption key", () => {
  it("creates mode 0600 key material and reuses the exact key", async () => {
    const dataDir = await temporaryRoot();
    const first = await loadOrCreateCoreDeadLetterKey({ dataDir });
    if (first.status === "error") throw first.error;
    const keyPath = resolveCoreDeadLetterKeyPath(dataDir);

    expect(first.value.byteLength).toBe(32);
    expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    expect(Buffer.from(await fs.readFile(keyPath))).toEqual(Buffer.from(first.value));

    const second = await loadOrCreateCoreDeadLetterKey({ dataDir });
    expect(second).toEqual(Result.ok(first.value));
    expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
  });

  it("converges concurrent creators on one persistent key", async () => {
    const dataDir = await temporaryRoot();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => loadOrCreateCoreDeadLetterKey({ dataDir })),
    );
    const keys = attempts.map((attempt) => {
      if (attempt.status === "error") throw attempt.error;
      return Buffer.from(attempt.value);
    });

    for (const key of keys) expect(key).toEqual(keys[0]!);
    expect((await fs.stat(resolveCoreDeadLetterKeyPath(dataDir))).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.join(dataDir, "secret"))).sort()).toEqual([
      "event-dead-letter.key",
    ]);
  });

  it("cleans up owned Redis when key setup returns a typed failure", async () => {
    const root = await temporaryRoot();
    const redis = new Redis({ lazyConnect: true });
    let cleanupCalled = false;
    Reflect.set(redis, "quit", async () => {
      cleanupCalled = true;
      redis.disconnect();
      return "OK";
    });
    const keyError = new CoreDeadLetterKeyAccessFailed({
      operation: "read-key",
      keyPath: resolveCoreDeadLetterKeyPath(root),
      cause: new Error("denied"),
      message: "Core dead-letter key access failed during read-key",
    });

    const setup = await setupCoreEventBusResources({
      redisUrl: "redis://unused",
      cwd: path.join(root, "workspace"),
      dataDir: root,
      evidenceBlobStore: unusedEvidenceBlobStore,
      logger: { warn: () => {}, error: () => {} },
      reportFatalError: () => {},
      dependencies: {
        captureRedisConstruction: () => Result.ok(redis),
        loadDeadLetterKey: async () => Result.err(keyError),
      },
    });

    expect(cleanupCalled).toBe(true);
    expect(setup.status).toBe("error");
    if (setup.status === "error") {
      expect(setup.error).toBeInstanceOf(CoreEventBusSetupFailed);
      if (setup.error instanceof CoreEventBusSetupFailed) {
        expect(setup.error.operation).toBe("load-dead-letter-key");
        expect(setup.error.cause).toBe(keyError);
      }
    }
  });
});
