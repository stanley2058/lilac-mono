import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createConfigDocument,
  deleteConfigValue,
  getConfigValue,
  parseConfigDocument,
  readConfigDocument,
  serializeConfigDocument,
  setConfigValue,
  validateConfigDocument,
} from "../src/config-document";

function readDocument(source: string) {
  return parseConfigDocument(source).match({
    ok: (document) => document,
    err: (failure) => {
      throw failure;
    },
  });
}

describe("installer config documents", () => {
  it("creates a minimal version 2 document without expanding Core defaults", () => {
    const document = createConfigDocument();
    setConfigValue(document, ["models", "main", "model"], "openai/gpt-5.6-sol");
    setConfigValue(document, ["models", "main", "reasoning"], "medium");
    expect(validateConfigDocument(document).status).toBe("ok");
    expect(serializeConfigDocument(document)).toBe(
      "configVersion: 2\nmodels:\n  main:\n    model: openai/gpt-5.6-sol\n    reasoning: medium\n",
    );
    expect(getConfigValue(document, ["agent"])).toBeUndefined();
  });

  it("preserves comments, unknown fields and unrelated settings during updates", () => {
    const document = readDocument(
      `# Personal choices\nconfigVersion: 2\nmodels:\n  main:\n    model: openai/previous # keep this explanation\n    reasoning: low\n  fast:\n    model: openai/fast\ncustomThing:\n  value: keep-me # external setting\nsurface:\n  router:\n    allowedChannelIds: ["123"]\n`,
    );
    setConfigValue(document, ["models", "main", "model"], "openai/gpt-5.6-sol");
    setConfigValue(document, ["models", "main", "reasoning"], "medium");
    const output = serializeConfigDocument(document);
    expect(output).toContain("# Personal choices");
    expect(output).toContain("model: openai/gpt-5.6-sol # keep this explanation");
    expect(output).toContain("value: keep-me # external setting");
    expect(output).toMatch(/allowedChannelIds: \[\s*"123"\s*\]/u);
    expect(getConfigValue(document, ["models", "fast", "model"])).toBe("openai/fast");
    expect(getConfigValue(document, ["surface", "router", "allowedChannelIds"])).toEqual(["123"]);
    expect(getConfigValue(document, ["surface", "router", "allowedChannelIds", 0])).toBe("123");
    expect(validateConfigDocument(document).status).toBe("ok");
  });

  it("reads YAML merge keys as Core does and adds a local override without changing the anchor", () => {
    const document = readDocument(
      "configVersion: 2\nbase: &base\n  model: openai/example\nmodels:\n  main:\n    <<: *base\n    reasoning: medium\n",
    );
    expect(getConfigValue(document, ["models", "main", "model"])).toBe("openai/example");
    setConfigValue(document, ["models", "main", "model"], "openai/replacement");
    expect(getConfigValue(document, ["base", "model"])).toBe("openai/example");
    const output = serializeConfigDocument(document);
    expect(output).toContain("<<: *base");
    const runtimeConfig = Bun.YAML.parse(output);
    expect(runtimeConfig).toMatchObject({ models: { main: { model: "openai/replacement" } } });
  });

  it("updates an aliased model without changing other aliases of the same anchor", () => {
    const document = readDocument(
      "configVersion: 2\nbase: &base\n  model: openai/example\n  reasoning: high\nmodels:\n  main: *base # main settings\n  fast: *base\n",
    );
    setConfigValue(document, ["models", "main", "model"], "openai/replacement");
    deleteConfigValue(document, ["models", "main", "reasoning"]);
    expect(getConfigValue(document, ["models", "fast"])).toEqual({
      model: "openai/example",
      reasoning: "high",
    });
    expect(getConfigValue(document, ["models", "main"])).toEqual({ model: "openai/replacement" });
    const output = serializeConfigDocument(document);
    expect(output).toContain("fast: *base");
    expect(output).toContain("# main settings");
    expect(parseConfigDocument(output).status).toBe("ok");
  });

  it("removes inherited merge fields without keeping old provider options active", () => {
    const document = readDocument(
      "configVersion: 2\nbase: &base\n  model: openai/example\n  options: { temperature: 0.5 }\nmodels:\n  main:\n    <<: *base\n    reasoning: medium # preserve this choice\n    customKey: customValue # preserve this annotation\n",
    );
    deleteConfigValue(document, ["models", "main", "options"]);
    expect(getConfigValue(document, ["models", "main", "options"])).toBeUndefined();
    expect(getConfigValue(document, ["models", "main", "model"])).toBe("openai/example");
    expect(getConfigValue(document, ["base", "options"])).toEqual({ temperature: 0.5 });
    const output = serializeConfigDocument(document);
    expect(output).toContain("# preserve this choice");
    expect(output).toContain("# preserve this annotation");
    expect(parseConfigDocument(output).status).toBe("ok");
  });

  it("removes only the selected key", () => {
    const document = readDocument(
      "configVersion: 2\nmodels:\n  main:\n    model: openai/example\n    reasoning: high\n",
    );
    deleteConfigValue(document, ["models", "main", "reasoning"]);
    expect(getConfigValue(document, ["models", "main"])).toEqual({ model: "openai/example" });
  });

  it.each([
    "configVersion: 99\n",
    "configVersion: 2\nmodels: []\n",
    "configVersion: 2\ninvalid: [\n",
    "- not-a-map\n",
    "configVersion: 2\nconfigVersion: 2\n",
    "configVersion: 2\ncustomThing: *missing\n",
  ])("rejects invalid or unsupported existing config: %s", (source) => {
    expect(parseConfigDocument(source).status).toBe("error");
  });

  it("preserves a valid legacy version instead of silently upgrading it", () => {
    const document = readDocument("models:\n  main:\n    model: openai/example\n");
    expect(getConfigValue(document, ["configVersion"])).toBeUndefined();
    expect(
      validateConfigDocument(document).match({
        ok: (config) => config.configVersion,
        err: () => 0,
      }),
    ).toBe(1);
  });

  it("distinguishes a missing file from an existing malformed configuration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-installer-config-"));
    const filePath = path.join(directory, "core-config.yaml");
    try {
      const missing = await readConfigDocument(filePath);
      expect(missing.match({ ok: (result) => result.exists, err: () => true })).toBe(false);
      await writeFile(filePath, "configVersion: 77\n");
      expect((await readConfigDocument(filePath)).status).toBe("error");
      await writeFile(filePath, "configVersion: 2\n");
      const existing = await readConfigDocument(filePath);
      expect(existing.match({ ok: (result) => result.exists, err: () => false })).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never includes YAML contents in syntax error messages", () => {
    const result = parseConfigDocument("configVersion: 2\nsecret: [example-sensitive-value\n");
    const message = result.match({
      ok: () => "unexpected success",
      err: (failure) => failure.message,
    });
    expect(message).toBe("Configuration contains invalid YAML.");
    expect(message).not.toContain("example-sensitive-value");
  });
});
