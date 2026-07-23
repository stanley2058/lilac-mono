import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { __clipboardInternals, ClipboardImageTooLargeError } from "./clipboard";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("clipboard image bounds", () => {
  it("keeps binary command output at the byte limit", async () => {
    const bytes = await __clipboardInternals.command(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0, 1, 2, 0]))"],
      { maxBytes: 4, timeoutMs: 1_000 },
    );

    expect([...bytes]).toEqual([0, 1, 2, 0]);
  });

  it("terminates commands when output crosses the byte limit", async () => {
    await expect(
      __clipboardInternals.command(
        process.execPath,
        ["-e", "process.stdout.write(Buffer.alloc(17)); setTimeout(() => {}, 10_000)"],
        { maxBytes: 16, timeoutMs: 1_000 },
      ),
    ).rejects.toBeInstanceOf(ClipboardImageTooLargeError);
  });

  it("does not wait for descendants that inherit a terminated command's stdout", async () => {
    const startedAt = Date.now();
    await expect(
      __clipboardInternals.command(
        process.execPath,
        [
          "-e",
          'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: ["ignore", "inherit", "ignore"] })',
        ],
        { maxBytes: 16, timeoutMs: 20 },
      ),
    ).rejects.toThrow("timed out");
    expect(Date.now() - startedAt).toBeLessThan(300);
  });

  it("bounds temporary file reads", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-clipboard-"));
    temporaryDirectories.push(directory);
    const exact = path.join(directory, "exact.png");
    const oversized = path.join(directory, "oversized.png");
    await Promise.all([
      writeFile(exact, Buffer.alloc(16, 1)),
      writeFile(oversized, Buffer.alloc(17)),
    ]);

    expect(await __clipboardInternals.readBoundedFile(exact, 16)).toEqual(Buffer.alloc(16, 1));
    await expect(__clipboardInternals.readBoundedFile(oversized, 16)).rejects.toBeInstanceOf(
      ClipboardImageTooLargeError,
    );
  });
});
