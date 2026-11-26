import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCustomCommandTextName,
  decodeCustomCommandResult,
  discoverCustomCommands,
  readCustomCommandDefinition,
  type CustomCommandDiscoveryDependencies,
  type CustomCommandResult,
} from "../custom-commands";

async function mkdirp(filePath: string) {
  await fs.mkdir(filePath, { recursive: true });
}

async function discoverSuccessfully(
  dataDir: string,
  dependencies?: Partial<CustomCommandDiscoveryDependencies>,
) {
  const discovered = await discoverCustomCommands({ dataDir, dependencies });
  if (discovered.status === "error") throw discovered.error;
  return discovered.value;
}

describe("custom command result decoding", () => {
  it("accepts all six declared result variants without replacing valid objects", () => {
    const results: readonly CustomCommandResult[] = [
      { type: "text", value: "command output", providerOptions: { test: { mode: "plain" } } },
      {
        type: "json",
        value: { nested: [null, true, 42, "value", { omitted: undefined }] },
        providerOptions: { test: { enabled: true } },
      },
      {
        type: "execution-denied",
        reason: "not approved",
        providerOptions: { test: { policy: "manual" } },
      },
      {
        type: "error-text",
        value: "command failed",
        providerOptions: { test: { retryable: false } },
      },
      {
        type: "error-json",
        value: { message: "command failed", code: 17 },
        providerOptions: { test: { retryable: false } },
      },
      { type: "content", value: [{ type: "text", text: "attached" }] },
    ];

    for (const result of results) {
      expect(decodeCustomCommandResult(result)).toBe(result);
    }
  });

  it("preserves reserved JSON keys and unknown envelope/content extension fields", () => {
    const jsonResult: unknown = JSON.parse(
      '{"type":"json","value":{"constructor":{"safe":true},"__proto__":{"safe":true}},"constructor":{"extension":true},"__proto__":{"extension":true}}',
    );
    const contentResult: unknown = JSON.parse(
      '{"type":"content","value":[{"type":"text","text":"ok","constructor":{"part":true},"__proto__":{"part":true}}],"futureEnvelope":{"opaque":true}}',
    );
    const providerOptionsResult: unknown = JSON.parse(
      '{"type":"text","value":"ok","providerOptions":{"constructor":{"__proto__":{"safe":true}},"__proto__":{"constructor":{"safe":true}}}}',
    );
    const opaqueExtensions = {
      type: "content",
      value: [{ type: "text", text: "ok", futurePartField: new Map([["opaque", 1n]]) }],
      providerOptions: "future content-envelope field",
      futureEnvelopeField: Symbol("opaque"),
    };

    expect(decodeCustomCommandResult(jsonResult) === jsonResult).toBe(true);
    expect(decodeCustomCommandResult(contentResult) === contentResult).toBe(true);
    expect(decodeCustomCommandResult(providerOptionsResult) === providerOptionsResult).toBe(true);
    expect(decodeCustomCommandResult(opaqueExtensions) === opaqueExtensions).toBe(true);
  });

  it("accepts every supported content part and file payload representation", () => {
    const result: CustomCommandResult = {
      type: "content",
      value: [
        { type: "text", text: "attached", providerOptions: { test: { mode: "plain" } } },
        {
          type: "file",
          mediaType: "application/octet-stream",
          filename: "string.bin",
          data: { type: "data", data: "AA==" },
        },
        {
          type: "file",
          mediaType: "application/octet-stream",
          data: { type: "data", data: new Uint8Array([0, 1]) },
        },
        {
          type: "file",
          mediaType: "application/octet-stream",
          data: { type: "data", data: Buffer.from([0, 1]) },
        },
        {
          type: "file",
          mediaType: "application/octet-stream",
          data: { type: "data", data: new ArrayBuffer(2) },
        },
        {
          type: "file",
          mediaType: "text/plain",
          data: { type: "url", url: new URL("https://example.com/file.txt") },
        },
        {
          type: "file",
          mediaType: "application/pdf",
          data: { type: "reference", reference: { openai: "file-1" } },
        },
        {
          type: "file",
          mediaType: "text/plain",
          data: { type: "text", text: "inline text" },
        },
        {
          type: "file-data",
          data: "AA==",
          mediaType: "application/octet-stream",
          filename: "legacy.bin",
        },
        { type: "file-url", url: "https://example.com/file", mediaType: "text/plain" },
        { type: "file-id", fileId: "file-1" },
        { type: "file-id", fileId: { openai: "file-1" } },
        { type: "file-reference", providerReference: { anthropic: "file-2" } },
        { type: "image-data", data: "AA==", mediaType: "image/png" },
        { type: "image-url", url: "https://example.com/image.png" },
        { type: "image-file-id", fileId: "image-1" },
        { type: "image-file-id", fileId: { openai: "image-1" } },
        { type: "image-file-reference", providerReference: { openai: "image-2" } },
        { type: "custom", providerOptions: { test: { payload: { enabled: true } } } },
      ],
    };

    expect(decodeCustomCommandResult(result)).toBe(result);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a missing discriminant", { value: null }],
    ["an unknown result variant", { type: "unknown", value: null }],
    ["text without a value", { type: "text" }],
    ["text with a non-string value", { type: "text", value: 1 }],
    ["JSON without a value", { type: "json" }],
    ["non-JSON bigint", { type: "json", value: 1n }],
    ["non-finite JSON number", { type: "json", value: Number.POSITIVE_INFINITY }],
    ["undefined in a JSON array", { type: "json", value: [undefined] }],
    ["execution denial with a non-string reason", { type: "execution-denied", reason: 1 }],
    ["error text without text", { type: "error-text", value: 1 }],
    ["error JSON without JSON", { type: "error-json", value: 1n }],
    ["content without an array", { type: "content", value: {} }],
    [
      "malformed result provider options",
      { type: "json", value: null, providerOptions: { test: "invalid" } },
    ],
  ])("rejects %s", (_description, value) => {
    expect(decodeCustomCommandResult(value)).toBeNull();
  });

  it.each([
    ["an unknown part", { type: "unknown" }],
    ["text without string text", { type: "text", text: 1 }],
    ["file without media type", { type: "file", data: { type: "data", data: "AA==" } }],
    [
      "file with unknown data",
      { type: "file", mediaType: "text/plain", data: { type: "unknown" } },
    ],
    [
      "file with malformed inline data",
      { type: "file", mediaType: "text/plain", data: { type: "data", data: 1 } },
    ],
    [
      "file with a string URL payload",
      {
        type: "file",
        mediaType: "text/plain",
        data: { type: "url", url: "https://example.com" },
      },
    ],
    [
      "file with malformed provider reference",
      {
        type: "file",
        mediaType: "application/pdf",
        data: { type: "reference", reference: { openai: 1 } },
      },
    ],
    [
      "file with a tagged provider reference",
      {
        type: "file",
        mediaType: "application/pdf",
        data: { type: "reference", reference: { type: "reference", openai: "file-1" } },
      },
    ],
    [
      "file with malformed inline text",
      { type: "file", mediaType: "text/plain", data: { type: "text", text: 1 } },
    ],
    ["legacy file data without media type", { type: "file-data", data: "AA==" }],
    ["legacy file URL without URL", { type: "file-url", url: 1 }],
    ["legacy file id without an id", { type: "file-id", fileId: 1 }],
    [
      "legacy file reference without references",
      { type: "file-reference", providerReference: { openai: 1 } },
    ],
    ["legacy image data without media type", { type: "image-data", data: "AA==" }],
    ["legacy image URL without URL", { type: "image-url", url: 1 }],
    ["legacy image file id without an id", { type: "image-file-id", fileId: 1 }],
    [
      "legacy image file reference without references",
      { type: "image-file-reference", providerReference: { openai: 1 } },
    ],
    ["custom content with malformed options", { type: "custom", providerOptions: [] }],
    [
      "content with malformed nested options",
      { type: "text", text: "value", providerOptions: { test: { value: 1n } } },
    ],
  ])("rejects content with %s", (_description, part) => {
    expect(decodeCustomCommandResult({ type: "content", value: [part] })).toBeNull();
  });

  it("rejects cyclic JSON instead of throwing from the boundary decoder", () => {
    const value: Record<string, unknown> = {};
    value["self"] = value;

    expect(decodeCustomCommandResult({ type: "json", value })).toBeNull();
  });

  it.each([
    ["a sparse JSON array", { type: "json", value: Object.assign([], { length: 1 }) }],
    ["a sparse content array", { type: "content", value: Object.assign([], { length: 1 }) }],
    ["a non-JSON object", { type: "json", value: new Date(0) }],
    [
      "an inherited result discriminant",
      Object.assign(Object.create({ type: "text" }), { value: "inherited" }),
    ],
    [
      "an inherited content discriminant",
      {
        type: "content",
        value: [Object.assign(Object.create({ type: "text" }), { text: "inherited" })],
      },
    ],
  ])("rejects hostile malformed payloads with %s", (_description, result) => {
    expect(decodeCustomCommandResult(result)).toBeNull();
  });

  it("contains hostile access failures", () => {
    const malformed: Record<string, unknown> = {};
    Object.defineProperty(malformed, "type", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(decodeCustomCommandResult(malformed)).toBeNull();
  });

  it("rejects revoked proxies without leaking their access error", () => {
    const { proxy, revoke } = Proxy.revocable({ type: "text", value: "ok" }, {});
    revoke();

    expect(decodeCustomCommandResult(proxy)).toBeNull();
  });
});

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

    const result = await discoverSuccessfully(dataDir);
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

    const result = await discoverSuccessfully(dataDir);
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

    const result = await discoverSuccessfully(dataDir);
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

    const result = await discoverSuccessfully(dataDir);
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

    const result = await discoverSuccessfully(dataDir);
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

    const result = await discoverSuccessfully(dataDir);
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

    const result = await discoverSuccessfully(dataDir);
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

    const result = await discoverSuccessfully(dataDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("invalid");
    if (result[0]?.type !== "invalid") throw new Error("expected invalid");
    expect(result[0].invalid.reason).toContain("Too big: expected array to have <=24 items");
  });

  it("preserves missing-root behavior without rejecting discovery", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const result = await discoverCustomCommands({
      dataDir: "/missing-data",
      dependencies: { readDirectory: async () => Promise.reject(missing) },
    });

    expect(result.status).toBe("ok");
    if (result.status === "error") throw result.error;
    expect(result.value).toEqual([]);
  });

  it("returns typed directory failures", async () => {
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const directoryFailure = await discoverCustomCommands({
      dataDir: "/denied-data",
      dependencies: { readDirectory: async () => Promise.reject(denied) },
    });
    expect(directoryFailure.status).toBe("error");
    if (directoryFailure.status === "ok") throw new Error("expected directory failure");
    expect(directoryFailure.error._tag).toBe("CustomCommandDirectoryReadError");
  });

  it("skips an inaccessible command path while retaining valid commands", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const blockedDir = path.join(dataDir, "cmds", "blocked");
    const validDir = path.join(dataDir, "cmds", "valid");
    await mkdirp(blockedDir);
    await mkdirp(validDir);
    await fs.writeFile(path.join(blockedDir, "def.json"), "{}", "utf8");
    await fs.writeFile(path.join(blockedDir, "index.ts"), "export function execute() {}\n", "utf8");
    await fs.writeFile(
      path.join(validDir, "def.json"),
      JSON.stringify({ name: "valid", description: "Valid command" }),
      "utf8",
    );
    await fs.writeFile(path.join(validDir, "index.ts"), "export function execute() {}\n", "utf8");

    const denied = Object.assign(new Error("api_key=must-not-leak"), { code: "EACCES" });
    const result = await discoverCustomCommands({
      dataDir,
      dependencies: {
        access: async (filePath) => {
          if (filePath.startsWith(blockedDir)) return Promise.reject(denied);
          await fs.access(filePath);
        },
      },
    });

    expect(result.status).toBe("ok");
    if (result.status === "error") throw result.error;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toEqual({
      type: "invalid",
      invalid: { dir: blockedDir, reason: "missing def.json" },
    });
    expect(result.value[1]).toEqual({
      type: "command",
      command: expect.objectContaining({
        dir: validDir,
        def: expect.objectContaining({ name: "valid" }),
      }),
    });
    expect(JSON.stringify(result.value)).not.toContain("must-not-leak");
  });

  it("returns specific definition read, JSON, and schema errors", async () => {
    const denied = Object.assign(new Error("definition denied"), { code: "EACCES" });
    const readFailure = await readCustomCommandDefinition({
      defPath: "/commands/blocked/def.json",
      readText: async () => Promise.reject(denied),
    });
    expect(readFailure.status).toBe("error");
    if (readFailure.status === "ok") throw new Error("expected read failure");
    expect(readFailure.error._tag).toBe("CustomCommandDefinitionReadError");

    const jsonFailure = await readCustomCommandDefinition({
      defPath: "/commands/broken/def.json",
      readText: async () => "{broken",
    });
    expect(jsonFailure.status).toBe("error");
    if (jsonFailure.status === "ok") throw new Error("expected JSON failure");
    expect(jsonFailure.error._tag).toBe("CustomCommandDefinitionJsonError");

    const schemaFailure = await readCustomCommandDefinition({
      defPath: "/commands/invalid/def.json",
      readText: async () => JSON.stringify({ name: "Bad_Name", description: "invalid" }),
    });
    expect(schemaFailure.status).toBe("error");
    if (schemaFailure.status === "ok") throw new Error("expected schema failure");
    expect(schemaFailure.error._tag).toBe("CustomCommandDefinitionSchemaError");
    if (schemaFailure.error._tag !== "CustomCommandDefinitionSchemaError") {
      throw new Error("expected schema error");
    }
    expect(schemaFailure.error.issues).toContain(
      "name must be lowercase letters/numbers with hyphen separators",
    );
  });

  it("retains definition read failures as invalid command reports", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const dir = path.join(dataDir, "cmds", "unreadable");
    await mkdirp(dir);
    await fs.writeFile(path.join(dir, "def.json"), "{}", "utf8");
    await fs.writeFile(path.join(dir, "index.ts"), "export function execute() {}\n", "utf8");

    const result = await discoverSuccessfully(dataDir, {
      readText: async () => Promise.reject(new Error("definition unavailable")),
    });
    expect(result).toEqual([
      {
        type: "invalid",
        invalid: {
          dir,
          defPath: path.join(dir, "def.json"),
          reason: "invalid def.json: definition unavailable",
        },
      },
    ]);
  });

  it("retains valid commands when another definition is unreadable and redacts its warning", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cmds-"));
    const dataDir = path.join(tmp, "data");
    const brokenDir = path.join(dataDir, "cmds", "broken");
    const validDir = path.join(dataDir, "cmds", "valid");
    await mkdirp(brokenDir);
    await mkdirp(validDir);
    for (const dir of [brokenDir, validDir]) {
      await fs.writeFile(path.join(dir, "index.ts"), "export function execute() {}\n", "utf8");
    }
    await fs.writeFile(path.join(brokenDir, "def.json"), "{}", "utf8");
    await fs.writeFile(
      path.join(validDir, "def.json"),
      JSON.stringify({ name: "valid", description: "Valid command" }),
      "utf8",
    );

    const result = await discoverSuccessfully(dataDir, {
      readText: async (filePath) => {
        if (filePath.startsWith(brokenDir)) {
          return Promise.reject(new Error("token=must-not-leak"));
        }
        return fs.readFile(filePath, "utf8");
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "invalid",
      invalid: {
        dir: brokenDir,
        defPath: path.join(brokenDir, "def.json"),
        reason: "invalid def.json: token=<redacted>",
      },
    });
    expect(result[1]).toEqual({
      type: "command",
      command: expect.objectContaining({
        dir: validDir,
        def: expect.objectContaining({ name: "valid" }),
      }),
    });
  });
});
