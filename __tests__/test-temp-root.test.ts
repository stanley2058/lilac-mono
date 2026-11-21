import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createOwnedTestTempRoot,
  reapStaleTestTempRoots,
  removeOwnedTestTempRoot,
  resolveTestTempBaseDirectory,
  selectTestTempBaseDirectory,
  TEST_TEMP_ROOT_PREFIX,
} from "./test-temp-root";

const sandboxes: string[] = [];

function createSandbox(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "lilac-test-temp-root-test-"));
  sandboxes.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("owned test temp roots", () => {
  test("creates separate data and temporary directories with an owner marker", () => {
    const baseDirectory = createSandbox();
    const owned = createOwnedTestTempRoot(baseDirectory);

    expect(path.basename(owned.rootDirectory)).toStartWith(TEST_TEMP_ROOT_PREFIX);
    expect(existsSync(owned.dataDirectory)).toBe(true);
    expect(existsSync(owned.tempDirectory)).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(owned.rootDirectory, ".lilac-test-owner.json"), "utf8")),
    ).toEqual({
      version: 5,
      hostIdentity: expect.any(String),
      ownership: "posix-flock",
      pid: process.pid,
      rootDirectory: owned.rootDirectory,
      userId: process.getuid?.(),
    });

    removeOwnedTestTempRoot(owned);
    expect(existsSync(owned.rootDirectory)).toBe(false);
  });

  test("preserves a root while its owner lock is held", () => {
    const baseDirectory = createSandbox();
    const owned = createOwnedTestTempRoot(baseDirectory);

    expect(reapStaleTestTempRoots(baseDirectory)).toEqual([]);
    expect(existsSync(owned.rootDirectory)).toBe(true);
  });

  test("preserves a locked root regardless of marker age", () => {
    const baseDirectory = createSandbox();
    const owned = createOwnedTestTempRoot(baseDirectory);
    const oldDate = new Date(1_000);
    utimesSync(path.join(owned.rootDirectory, ".lilac-test-owner.json"), oldDate, oldDate);

    expect(reapStaleTestTempRoots(baseDirectory)).toEqual([]);
    expect(existsSync(owned.rootDirectory)).toBe(true);
  });

  test("preserves an active root when its marker cannot be read", () => {
    const baseDirectory = createSandbox();
    const owned = createOwnedTestTempRoot(baseDirectory);
    writeFileSync(path.join(owned.rootDirectory, ".lilac-test-owner.json"), '{"version":999}\n');

    expect(reapStaleTestTempRoots(baseDirectory)).toEqual([]);
    expect(existsSync(owned.rootDirectory)).toBe(true);

    owned.releaseOwnership();
    expect(reapStaleTestTempRoots(baseDirectory)).toEqual([owned.rootDirectory]);
    expect(existsSync(owned.rootDirectory)).toBe(false);
  });

  test("removes a root after its ownership lock is released", () => {
    const baseDirectory = createSandbox();
    const owned = createOwnedTestTempRoot(baseDirectory);
    owned.releaseOwnership();

    expect(reapStaleTestTempRoots(baseDirectory)).toEqual([owned.rootDirectory]);
    expect(existsSync(owned.rootDirectory)).toBe(false);
  });

  test("preserves a released root owned by a different host", () => {
    const baseDirectory = createSandbox();
    const owned = createOwnedTestTempRoot(baseDirectory);
    const markerFile = path.join(owned.rootDirectory, ".lilac-test-owner.json");
    const marker = JSON.parse(readFileSync(markerFile, "utf8"));
    writeFileSync(markerFile, `${JSON.stringify({ ...marker, hostIdentity: "foreign-host" })}\n`);
    owned.releaseOwnership();

    expect(reapStaleTestTempRoots(baseDirectory)).toEqual([]);
    expect(existsSync(owned.rootDirectory)).toBe(true);
  });

  test("preserves a live child root and reaps it after the child is killed", async () => {
    const baseDirectory = createSandbox();
    const helperUrl = new URL("./test-temp-root.ts", import.meta.url).href;
    const script = [
      `import { createOwnedTestTempRoot } from ${JSON.stringify(helperUrl)};`,
      "const owned = createOwnedTestTempRoot(process.env.LILAC_CRASH_TEST_BASE);",
      "process.stdout.write(`${owned.rootDirectory}\\n`);",
      "setInterval(() => {}, 60_000);",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, LILAC_CRASH_TEST_BASE: baseDirectory },
      stderr: "inherit",
      stdout: "pipe",
    });
    const reader = child.stdout.getReader();

    try {
      const decoder = new TextDecoder();
      let output = "";

      while (!output.includes("\n")) {
        const next = await reader.read();
        if (next.done) throw new Error("crash fixture exited before reporting its temp root");
        output += decoder.decode(next.value, { stream: true });
      }

      const rootDirectory = output.slice(0, output.indexOf("\n"));
      expect(existsSync(rootDirectory)).toBe(true);
      expect(reapStaleTestTempRoots(baseDirectory)).toEqual([]);

      child.kill(9);
      await child.exited;

      expect(reapStaleTestTempRoots(baseDirectory)).toEqual([rootDirectory]);
      expect(existsSync(rootDirectory)).toBe(false);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      child.kill(9);
      await child.exited;
    }
  });

  test("reaps a child killed during root initialization", async () => {
    const baseDirectory = createSandbox();
    const helperUrl = new URL("./test-temp-root.ts", import.meta.url).href;
    const script = [
      `import { createOwnedTestTempRoot } from ${JSON.stringify(helperUrl)};`,
      "createOwnedTestTempRoot(process.env.LILAC_CRASH_TEST_BASE, {",
      "  onRootCreated(rootDirectory) {",
      "    process.stdout.write(`${rootDirectory}\\n`);",
      "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
      "  },",
      "});",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, LILAC_CRASH_TEST_BASE: baseDirectory },
      stderr: "inherit",
      stdout: "pipe",
    });
    const reader = child.stdout.getReader();

    try {
      const decoder = new TextDecoder();
      let output = "";

      while (!output.includes("\n")) {
        const next = await reader.read();
        if (next.done) throw new Error("crash fixture exited before reporting its temp root");
        output += decoder.decode(next.value, { stream: true });
      }

      const rootDirectory = output.slice(0, output.indexOf("\n"));
      expect(existsSync(rootDirectory)).toBe(true);
      expect(reapStaleTestTempRoots(baseDirectory)).toEqual([]);

      child.kill(9);
      await child.exited;

      expect(reapStaleTestTempRoots(baseDirectory)).toEqual([rootDirectory]);
      expect(existsSync(rootDirectory)).toBe(false);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      child.kill(9);
      await child.exited;
    }
  });

  test("removes roots left incomplete during initialization", () => {
    const baseDirectory = createSandbox();
    const seed = createOwnedTestTempRoot(baseDirectory);
    const scopedPrefix = seed.rootDirectory.slice(0, -6);
    removeOwnedTestTempRoot(seed);
    const markerless = mkdtempSync(scopedPrefix);
    const malformed = mkdtempSync(scopedPrefix);
    writeFileSync(path.join(malformed, ".lilac-test-owner.json"), '{"version":1}\n');

    expect(reapStaleTestTempRoots(baseDirectory).sort()).toEqual([malformed, markerless].sort());
    expect(existsSync(markerless)).toBe(false);
    expect(existsSync(malformed)).toBe(false);
  });

  test("preserves prefix matches without an exact mkdtemp suffix", () => {
    const baseDirectory = createSandbox();
    const directory = path.join(baseDirectory, `${TEST_TEMP_ROOT_PREFIX}named`);
    const owned = createOwnedTestTempRoot(baseDirectory);
    const marker = readFileSync(path.join(owned.rootDirectory, ".lilac-test-owner.json"));
    mkdirSync(directory);
    writeFileSync(path.join(directory, ".lilac-test-owner.json"), marker);
    owned.releaseOwnership();

    expect(reapStaleTestTempRoots(baseDirectory)).toEqual([owned.rootDirectory]);
    expect(existsSync(directory)).toBe(true);
  });

  test("requires an absolute existing temporary base", () => {
    const baseDirectory = createSandbox();

    expect(resolveTestTempBaseDirectory(baseDirectory)).toBe(baseDirectory);
    expect(() => resolveTestTempBaseDirectory("relative")).toThrow("must be absolute");
    expect(() => resolveTestTempBaseDirectory(path.join(baseDirectory, "missing"))).toThrow();
  });

  test("falls back to a shorter writable temp base when default TMPDIR leaves insufficient Unix socket headroom", () => {
    const fallbackDirectory = createSandbox();
    const longDirectory = path.join(
      fallbackDirectory,
      "nested-long-tmpdir-segment-for-unix-sockets",
    );
    mkdirSync(longDirectory, { recursive: true });

    expect(
      selectTestTempBaseDirectory({
        defaultTempDir: longDirectory,
        fallbackTempDir: fallbackDirectory,
      }),
    ).toBe(fallbackDirectory);
    expect(
      selectTestTempBaseDirectory({
        explicitBase: longDirectory,
        fallbackTempDir: fallbackDirectory,
      }),
    ).toBe(longDirectory);
    expect(
      selectTestTempBaseDirectory({
        defaultTempDir: longDirectory,
        fallbackTempDir: path.join(fallbackDirectory, "missing"),
      }),
    ).toBe(longDirectory);
  });
});
