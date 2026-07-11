import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadToolEnv, parseToolEnv } from "../../src/tools/tool-env";

describe("tool env", () => {
  it("parses strings and unexpired entries", () => {
    expect(
      parseToolEnv(
        {
          SIMPLE: "value",
          ACTIVE: { value: "token", expiresAt: "2026-07-11T07:00:00.000Z" },
          EXPIRED: { value: "old", expiresAt: 1 },
        },
        new Date("2026-07-11T06:00:00.000Z").getTime(),
      ),
    ).toEqual({ SIMPLE: "value", ACTIVE: "token" });
  });

  it("ignores invalid and reserved entries", () => {
    expect(
      parseToolEnv({
        "BAD-NAME": "value",
        LILAC_REQUEST_ID: "override",
        PATH: "/surprise",
        BAD_VALUE: 42,
        NULL_VALUE: "bad\0value",
        OK: "yes",
      }),
    ).toEqual({ OK: "yes" });
  });

  it("loads JSONC and observes file changes", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-env-"));
    const secretDir = path.join(dataDir, "secret");
    const filePath = path.join(secretDir, "tool-env.jsonc");
    await fs.mkdir(secretDir);

    try {
      await fs.writeFile(filePath, '{ // first\n "TOKEN": "one",\n}', { mode: 0o600 });
      expect(await loadToolEnv(dataDir)).toEqual({ TOKEN: "one" });

      await fs.writeFile(filePath, '{ "TOKEN": "two" }', { mode: 0o600 });
      expect(await loadToolEnv(dataDir)).toEqual({ TOKEN: "two" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("returns an empty overlay for missing or malformed files", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-env-"));
    try {
      expect(await loadToolEnv(dataDir)).toEqual({});
      await fs.mkdir(path.join(dataDir, "secret"));
      await fs.writeFile(path.join(dataDir, "secret", "tool-env.jsonc"), "{ nope", {
        mode: 0o600,
      });
      expect(await loadToolEnv(dataDir)).toEqual({});
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
