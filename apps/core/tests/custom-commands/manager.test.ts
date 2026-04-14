import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CustomCommandManager } from "../../src/custom-commands/manager";
import { parseCustomCommandFromRaw } from "../../src/surface/bridge/bus-agent-runner/raw";

async function mkdirp(filePath: string) {
  await fs.mkdir(filePath, { recursive: true });
}

describe("CustomCommandManager", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (!tmp) return;
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("parses positional and named text arguments with trailing prompt", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "tarot");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "tarot",
        description: "Draw cards",
        args: [{ key: "count", type: "number", required: false }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const manager = new CustomCommandManager(dataDir);
    await manager.init();

    expect(manager.parseText("/lilac:tarot 3")?.args).toEqual([3]);
    expect(manager.parseText("/lilac:tarot count=2")?.args).toEqual([2]);
    expect(
      manager.parseText("/lilac:tarot count=2 Please give me advice on my career change."),
    ).toEqual({
      command: expect.objectContaining({ textName: "lilac:tarot" }),
      args: [2],
      prompt: "Please give me advice on my career change.",
      text: "/lilac:tarot count=2 Please give me advice on my career change.",
      source: "text",
    });
  });

  it("treats non-matching optional args as transcript prompt text", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "tarot");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "tarot",
        description: "Draw cards",
        args: [{ key: "count", type: "number", required: false }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const manager = new CustomCommandManager(dataDir);
    await manager.init();

    expect(manager.parseText("/lilac:tarot Please read this for my career")?.args).toEqual([
      undefined,
    ]);
    expect(manager.parseText("/lilac:tarot Please read this for my career")?.prompt).toBe(
      "Please read this for my career",
    );
  });

  it("adds reserved slash prompt text without passing it as an execute arg", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "tarot");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "tarot",
        description: "Draw cards",
        args: [{ key: "mode", type: "string", required: false }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const manager = new CustomCommandManager(dataDir);
    await manager.init();

    expect(
      manager.parseSlash({
        name: "tarot",
        rawArgs: { mode: "past-present-future" },
        prompt: "Please focus on my work situation.",
      }),
    ).toEqual({
      command: expect.objectContaining({ textName: "lilac:tarot" }),
      args: ["past-present-future"],
      prompt: "Please focus on my work situation.",
      text: "/lilac:tarot mode=past-present-future Please focus on my work situation.",
      source: "discord-slash",
    });
  });

  it("formats slash previews with prompt on a second line", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "tarot");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "tarot",
        description: "Draw cards",
        args: [{ key: "mode", type: "string", required: false }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const manager = new CustomCommandManager(dataDir);
    await manager.init();

    const withPrompt = manager.parseSlash({
      name: "tarot",
      rawArgs: { mode: "situation-obstacle-advice" },
      prompt: "Please give me advice on my career change.",
    });
    if (!withPrompt) throw new Error("expected parsed invocation");
    expect(manager.formatPreview(withPrompt)).toBe(
      "/lilac:tarot mode=situation-obstacle-advice\nPrompt: Please give me advice on my career change.",
    );

    const withoutPrompt = manager.parseSlash({
      name: "tarot",
      rawArgs: { mode: "past-present-future" },
    });
    expect(manager.formatPreview(withoutPrompt)).toBe("/lilac:tarot mode=past-present-future");
  });

  it("executes a command module with explicit context", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "hello");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "hello",
        description: "Say hello",
        args: [{ key: "name", type: "string", required: true }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "index.ts"),
      [
        "export async function execute(args, ctx) {",
        "  return {",
        "    type: 'json',",
        "    value: { greeting: `hello ${String(args[0])}`, cwd: ctx.cwd, dir: ctx.commandDir },",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const manager = new CustomCommandManager(dataDir);
    await manager.init();
    const command = manager.get("hello");
    if (!command) throw new Error("expected command");

    const result = await manager.execute({
      command,
      args: ["stanley"],
      context: {
        cwd: "/workspace",
        dataDir,
        commandDir: dir,
        commandName: "hello",
        requestId: "req-1",
        sessionId: "session-1",
      },
    });

    expect(result).toEqual({
      type: "json",
      value: {
        greeting: "hello stanley",
        cwd: "/workspace",
        dir,
      },
    });
  });
});

describe("parseCustomCommandFromRaw", () => {
  it("extracts command metadata from request raw", () => {
    expect(
      parseCustomCommandFromRaw({
        customCommand: {
          name: "tarot",
          args: [3],
          prompt: "Please focus on work.",
          text: "/lilac:tarot 3",
          source: "text",
        },
      }),
    ).toEqual({
      name: "tarot",
      args: [3],
      prompt: "Please focus on work.",
      text: "/lilac:tarot 3",
      source: "text",
    });
  });
});
