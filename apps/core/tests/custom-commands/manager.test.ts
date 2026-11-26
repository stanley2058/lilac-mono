import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CustomCommandResult } from "@stanley2058/lilac-utils";

import {
  CustomCommandManager,
  type ParsedCustomCommandInvocation,
} from "../../src/custom-commands/manager";
import {
  parseCustomCommandFromRaw,
  parseSessionConfigIdFromRaw,
} from "../../src/surface/bridge/bus-agent-runner/raw";

async function mkdirp(filePath: string) {
  await fs.mkdir(filePath, { recursive: true });
}

async function writeCommandModule(params: {
  dataDir: string;
  name: string;
  source: string;
}): Promise<string> {
  const dir = path.join(params.dataDir, "cmds", params.name);
  await mkdirp(dir);
  await fs.writeFile(
    path.join(dir, "def.json"),
    JSON.stringify({ name: params.name, description: `Test ${params.name}` }),
    "utf8",
  );
  await fs.writeFile(path.join(dir, "index.ts"), params.source, "utf8");
  return dir;
}

function commandContext(dataDir: string, commandDir: string, commandName: string) {
  return {
    cwd: "/workspace",
    dataDir,
    commandDir,
    commandName,
    requestId: "req-1",
    sessionId: "session-1",
  };
}

async function initializeManager(manager: CustomCommandManager): Promise<void> {
  const initialized = await manager.init();
  if (initialized.status === "error") throw initialized.error;
}

function parseTextSuccessfully(
  manager: CustomCommandManager,
  text: string,
): ParsedCustomCommandInvocation | null {
  const parsed = manager.parseText(text);
  if (parsed.status === "error") throw parsed.error;
  return parsed.value;
}

function parseSlashSuccessfully(
  manager: CustomCommandManager,
  params: Parameters<CustomCommandManager["parseSlash"]>[0],
): ParsedCustomCommandInvocation {
  const parsed = manager.parseSlash(params);
  if (parsed.status === "error") throw parsed.error;
  return parsed.value;
}

describe("CustomCommandManager", () => {
  let tmp: string | null = null;

  afterEach(async () => {
    if (!tmp) return;
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("returns discovery failures from initialization without rejecting", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataPath = path.join(tmp, "data-file");
    await fs.writeFile(dataPath, "not a directory", "utf8");
    const manager = new CustomCommandManager(dataPath);

    const initialized = await manager.init();

    expect(initialized.status).toBe("error");
    if (initialized.status === "ok") throw new Error("expected discovery failure");
    expect(initialized.error._tag).toBe("CustomCommandDirectoryReadError");
    expect(manager.list()).toEqual([]);
    expect(manager.listWarnings()).toEqual([]);
  });

  it("loads valid commands while inaccessible and broken commands become safe warnings", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const blockedDir = await writeCommandModule({
      dataDir,
      name: "blocked",
      source: "export function execute() {}\n",
    });
    const brokenDir = await writeCommandModule({
      dataDir,
      name: "broken",
      source: "export function execute() {}\n",
    });
    await fs.writeFile(path.join(brokenDir, "def.json"), "{broken", "utf8");
    await writeCommandModule({
      dataDir,
      name: "valid",
      source: "export function execute() {}\n",
    });
    const denied = Object.assign(new Error("secret=must-not-leak"), { code: "EACCES" });
    const manager = new CustomCommandManager(dataDir, {
      access: async (filePath) => {
        if (filePath.startsWith(blockedDir)) return Promise.reject(denied);
        await fs.access(filePath);
      },
    });

    const initialized = await manager.init();

    expect(initialized.status).toBe("ok");
    expect(manager.list().map((command) => command.def.name)).toEqual(["valid"]);
    const warnings = manager.listWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toBe(`${blockedDir}: missing def.json`);
    expect(warnings[1]).toContain(`${brokenDir}: invalid def.json:`);
    expect(JSON.stringify(warnings)).not.toContain("must-not-leak");
    expect(JSON.stringify(warnings)).not.toContain('"cause"');
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
    await initializeManager(manager);

    expect(parseTextSuccessfully(manager, "/lilac:tarot 3")?.args).toEqual([3]);
    expect(parseTextSuccessfully(manager, "/lilac:tarot count=2")?.args).toEqual([2]);
    expect(
      parseTextSuccessfully(
        manager,
        "/lilac:tarot count=2 Please give me advice on my career change.",
      ),
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
    await initializeManager(manager);

    expect(
      parseTextSuccessfully(manager, "/lilac:tarot Please read this for my career")?.args,
    ).toEqual([undefined]);
    expect(
      parseTextSuccessfully(manager, "/lilac:tarot Please read this for my career")?.prompt,
    ).toBe("Please read this for my career");
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
    await initializeManager(manager);

    expect(
      parseSlashSuccessfully(manager, {
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
    await initializeManager(manager);

    const withPrompt = parseSlashSuccessfully(manager, {
      name: "tarot",
      rawArgs: { mode: "situation-obstacle-advice" },
      prompt: "Please give me advice on my career change.",
    });
    expect(manager.formatPreview(withPrompt)).toBe(
      "/lilac:tarot mode=situation-obstacle-advice\nPrompt: Please give me advice on my career change.",
    );

    const withoutPrompt = parseSlashSuccessfully(manager, {
      name: "tarot",
      rawArgs: { mode: "past-present-future" },
    });
    expect(manager.formatPreview(withoutPrompt)).toBe("/lilac:tarot mode=past-present-future");
  });

  it("rejects slash arg values outside declared choices", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "tarot");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "tarot",
        description: "Draw cards",
        args: [{ key: "mode", type: "string", choices: ["single", "past-present-future"] }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const manager = new CustomCommandManager(dataDir);
    await initializeManager(manager);

    const parsed = manager.parseSlash({
      name: "tarot",
      rawArgs: { mode: "mind-body-spirit" },
    });
    expect(parsed.status).toBe("error");
    if (parsed.status === "ok") throw new Error("expected choice error");
    expect(parsed.error._tag).toBe("CustomCommandArgumentChoiceError");
    expect(parsed.error.message).toBe(
      "Argument 'mode' must be one of: single, past-present-future.",
    );
  });

  it("rejects invalid optional positional choice values instead of treating them as prompt text", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "tarot");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "tarot",
        description: "Draw cards",
        args: [{ key: "mode", type: "string", choices: ["single", "past-present-future"] }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export async function execute() {}\n", "utf8");

    const manager = new CustomCommandManager(dataDir);
    await initializeManager(manager);

    const parsed = manager.parseText("/lilac:tarot mind-body-spirit help");
    expect(parsed.status).toBe("error");
    if (parsed.status === "ok") throw new Error("expected choice error");
    expect(parsed.error._tag).toBe("CustomCommandArgumentChoiceError");
    expect(parsed.error.message).toBe(
      "Argument 'mode' must be one of: single, past-present-future.",
    );
  });

  it("returns specific typed argument parsing failures", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "typed");
    await mkdirp(dir);
    await fs.writeFile(
      path.join(dir, "def.json"),
      JSON.stringify({
        name: "typed",
        description: "Typed arguments",
        args: [
          { key: "count", type: "number", required: true },
          { key: "enabled", type: "boolean" },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "index.ts"), "export function execute() {}\n", "utf8");
    const manager = new CustomCommandManager(dataDir);
    await initializeManager(manager);

    const cases = [
      [manager.parseText('/lilac:typed "unterminated'), "CustomCommandUnterminatedQuoteError"],
      [manager.parseText("/lilac:typed count=no"), "CustomCommandNumberArgumentError"],
      [
        manager.parseText("/lilac:typed count=2 enabled=maybe"),
        "CustomCommandBooleanArgumentError",
      ],
      [manager.parseText("/lilac:typed count=2 extra=value"), "CustomCommandUnknownArgumentError"],
      [manager.parseText("/lilac:typed"), "CustomCommandRequiredArgumentError"],
      [manager.parseSlash({ name: "typed", rawArgs: {} }), "CustomCommandRequiredArgumentError"],
      [manager.parseSlash({ name: "missing", rawArgs: {} }), "CustomCommandUnknownError"],
    ] as const;

    for (const [parsed, tag] of cases) {
      expect(parsed.status).toBe("error");
      if (parsed.status === "ok") throw new Error(`expected ${tag}`);
      expect(parsed.error._tag).toBe(tag);
    }
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
    await initializeManager(manager);
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

    expect(result.status).toBe("ok");
    if (result.status === "error") throw result.error;
    expect(result.value).toEqual({
      type: "json",
      value: {
        greeting: "hello stanley",
        cwd: "/workspace",
        dir,
      },
    });
  });

  it("preserves the imported module as the execute receiver", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = await writeCommandModule({
      dataDir,
      name: "receiver",
      source: [
        "export const receiverValue = 'module receiver';",
        "export function execute() {",
        "  return { type: 'json', value: this.receiverValue };",
        "}",
        "",
      ].join("\n"),
    });
    const manager = new CustomCommandManager(dataDir);
    await initializeManager(manager);
    const command = manager.get("receiver");
    if (!command) throw new Error("expected command");

    const result = await manager.execute({
      command,
      args: [],
      context: commandContext(dataDir, dir, "receiver"),
    });

    expect(result.status).toBe("ok");
    if (result.status === "error") throw result.error;
    expect(result.value).toEqual({ type: "json", value: "module receiver" });
  });

  it("accepts every declared result variant without replacing the command result", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = await writeCommandModule({
      dataDir,
      name: "result-variants",
      source: "export function execute(args) { return args[0]; }\n",
    });
    const manager = new CustomCommandManager(dataDir);
    await initializeManager(manager);
    const command = manager.get("result-variants");
    if (!command) throw new Error("expected command");
    const results: readonly CustomCommandResult[] = [
      { type: "text", value: "ok" },
      { type: "json", value: { ok: true } },
      { type: "execution-denied", reason: "not approved" },
      { type: "error-text", value: "failed" },
      { type: "error-json", value: { message: "failed" } },
      { type: "content", value: [{ type: "text", text: "ok" }] },
    ];

    for (const expected of results) {
      const result = await manager.execute({
        command,
        args: [expected],
        context: commandContext(dataDir, dir, "result-variants"),
      });

      expect(result.status).toBe("ok");
      if (result.status === "error") throw result.error;
      expect(result.value).toBe(expected);
    }
  });

  it.each([
    [
      "import failures",
      "import-failure",
      "throw new Error('import boom');\n",
      "CustomCommandImportError",
      "import boom",
    ],
    [
      "a missing execute export",
      "missing-execute",
      "export const value = true;\n",
      "CustomCommandExecuteMissingError",
      "must export async execute",
    ],
    [
      "a non-function execute export",
      "invalid-execute",
      "export const execute = true;\n",
      "CustomCommandExecuteMissingError",
      "must export async execute",
    ],
    [
      "synchronous execute throws",
      "sync-throw",
      "export function execute() { throw new Error('sync boom'); }\n",
      "CustomCommandExecuteThrownError",
      "sync boom",
    ],
    [
      "execute promise rejections",
      "async-rejection",
      "export async function execute() { throw new Error('async boom'); }\n",
      "CustomCommandExecuteRejectedError",
      "async boom",
    ],
    [
      "malformed command results",
      "malformed-result",
      "export function execute() { return { type: 'content', value: [{ type: 'text' }] }; }\n",
      "CustomCommandResultInvalidError",
      "invalid tool result payload",
    ],
  ] as const)("returns a tagged error for %s", async (_description, name, source, tag, message) => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-command-manager-"));
    const dataDir = path.join(tmp, "data");
    const dir = await writeCommandModule({ dataDir, name, source });
    const manager = new CustomCommandManager(dataDir);
    await initializeManager(manager);
    const command = manager.get(name);
    if (!command) throw new Error("expected command");

    const result = await manager.execute({
      command,
      args: [],
      context: commandContext(dataDir, dir, name),
    });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected execution error");
    expect(result.error._tag).toBe(tag);
    expect(result.error.message).toContain(message);
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

  it("rejects malformed command metadata", () => {
    expect(
      parseCustomCommandFromRaw({
        customCommand: {
          name: "tarot",
          text: "/lilac:tarot",
          source: "unknown",
        },
      }),
    ).toBeNull();
  });
});

describe("raw router metadata decoders", () => {
  it("trims non-empty string fields", () => {
    expect(parseSessionConfigIdFromRaw({ sessionConfigId: "  c1  " })).toBe("c1");
    expect(parseSessionConfigIdFromRaw({ sessionConfigId: "   " })).toBeNull();
  });
});
