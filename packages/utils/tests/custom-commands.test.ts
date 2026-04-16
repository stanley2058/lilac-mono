import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildCustomCommandTextName, discoverCustomCommands } from "../custom-commands";

async function mkdirp(filePath: string) {
  await fs.mkdir(filePath, { recursive: true });
}

describe("custom command discovery", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (!tmp) return;
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("discovers valid commands from DATA_DIR/cmds", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "tarot");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "tarot",
        description: "Draw cards",
        args: [{ key: "count", type: "number" }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const result = await discoverCustomCommands({ dataDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("command");
    if (result[0]?.type !== "command") throw new Error("expected command");
    expect(result[0].command.def.name).toBe("tarot");
    expect(buildCustomCommandTextName(result[0].command.def.name)).toBe("lilac:tarot");
  });

  it("accepts static string choices for slash-friendly args", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "tarot");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "tarot",
        description: "Draw cards",
        args: [
          {
            key: "mode",
            type: "string",
            choices: ["single", "past-present-future"],
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const result = await discoverCustomCommands({ dataDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("command");
    if (result[0]?.type !== "command") throw new Error("expected command");
    expect(result[0].command.def.args[0]?.choices).toEqual(["single", "past-present-future"]);
  });

  it("allows more than 25 string choices in shared command metadata", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "palette");
    const choices = Array.from({ length: 26 }, (_, index) => `choice-${index + 1}`);
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "palette",
        description: "Pick a palette",
        args: [{ key: "name", type: "string", choices }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const result = await discoverCustomCommands({ dataDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("command");
    if (result[0]?.type !== "command") throw new Error("expected command");
    expect(result[0].command.def.args[0]?.choices).toEqual(choices);
  });

  it("reports invalid command directories", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "broken");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "Bad_Name",
        description: "nope",
      }),
      "utf8",
    );

    const result = await discoverCustomCommands({ dataDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("invalid");
    if (result[0]?.type !== "invalid") throw new Error("expected invalid");
    expect(result[0].invalid.reason).toContain("missing index.ts or index.js");
  });

  it("rejects invalid slash-incompatible arg metadata", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "bad-args");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "bad-args",
        description: "Draw cards",
        args: [
          { key: "Bad Key", type: "number" },
          { key: "count", type: "number", description: "x".repeat(101) },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const result = await discoverCustomCommands({ dataDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("invalid");
    if (result[0]?.type !== "invalid") throw new Error("expected invalid");
    expect(result[0].invalid.reason).toContain("arg key must be lowercase letters/numbers");
  });

  it("rejects duplicate or non-string choices", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "bad-choices");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "bad-choices",
        description: "Draw cards",
        args: [
          { key: "mode", type: "string", choices: ["single", "single"] },
          { key: "count", type: "number", choices: ["1", "2"] },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const result = await discoverCustomCommands({ dataDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("invalid");
    if (result[0]?.type !== "invalid") throw new Error("expected invalid");
    expect(result[0].invalid.reason).toContain("duplicate choice 'single'");
    expect(result[0].invalid.reason).toContain("choices are only supported for string args");
  });

  it("rejects the reserved prompt arg key", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "bad-args");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "bad-args",
        description: "Draw cards",
        args: [{ key: "prompt", type: "string" }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const result = await discoverCustomCommands({ dataDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("invalid");
    if (result[0]?.type !== "invalid") throw new Error("expected invalid");
    expect(result[0].invalid.reason).toContain("'prompt' is reserved");
  });

  it("rejects commands with more than 24 declared args", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "too-many-args");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "too-many-args",
        description: "Draw cards",
        args: Array.from({ length: 25 }, (_, index) => ({
          key: `arg-${index + 1}`,
          type: "string",
        })),
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const result = await discoverCustomCommands({ dataDir });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("invalid");
    if (result[0]?.type !== "invalid") throw new Error("expected invalid");
    expect(result[0].invalid.reason).toContain("Too big: expected array to have <=24 items");
  });
});
