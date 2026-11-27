import { describe, expect, it } from "bun:test";

import {
  applyConfigPatch,
  formatConfigPath,
  parseConfigPath,
  parseConfigYaml,
} from "../config-document";
import {
  decodeConfigSchema,
  enumerateConfigFields,
  schemaAtPath,
  schemaDefaultAtPath,
  versionSchemaNode,
} from "../config-schema";

function patched(text: string, operations: Parameters<typeof applyConfigPatch>[1]) {
  return applyConfigPatch(text, operations).match({
    ok: (value) => value,
    err: (error) => {
      throw new Error(error.message);
    },
  });
}

describe("applyConfigPatch", () => {
  it("keeps comments and order outside changed nodes", () => {
    const text = [
      "# top comment",
      "configVersion: 3",
      "models:",
      "  main:",
      "    model: openai/gpt-4o # keep me",
      "  fast:",
      "    model: openai/gpt-4o-mini",
      "",
    ].join("\n");
    const next = patched(text, [{ op: "set", path: ["models", "main", "model"], value: "x/y" }]);
    expect(next).toBe(text.replace("openai/gpt-4o #", "x/y #"));
  });

  it("keeps untouched flow collections and quoting byte for byte", () => {
    const text = [
      "configVersion: 3",
      "models:",
      "  main:",
      "    fallback: [anthropic/claude]",
      "surface:",
      "  discord:",
      "    allowedGuildIds: ['123']",
      "    botName: 'lilac'",
      "  router: { defaultMode: mention }",
      "",
    ].join("\n");
    const next = patched(text, [
      { op: "set", path: ["surface", "discord", "botName"], value: "lila" },
    ]);
    expect(next).toBe(text.replace("'lilac'", "'lila'"));
  });

  it("keeps a flow list in flow style when it changes", () => {
    const text = 'surface:\n  discord:\n    allowedGuildIds: ["1"]\n';
    const next = patched(text, [
      { op: "set", path: ["surface", "discord", "allowedGuildIds"], value: ["1", "2"] },
    ]);
    expect(next).toBe('surface:\n  discord:\n    allowedGuildIds: ["1", "2"]\n');
  });

  it("keeps untouched lines when the printer changes the line count", () => {
    const text = "a: 1\nlist: [\n  x,\n  y,\n]\nc:   3\n";
    const next = patched(text, [{ op: "set", path: ["a"], value: 2 }]);
    expect(next).toBe(text.replace("a: 1", "a: 2"));
  });

  it("unsets a field reached through an alias without changing the anchor", () => {
    const text = "base: &shared\n  enabled: true\n  size: 1\ncopy: *shared\n";
    const next = patched(text, [{ op: "unset", path: ["copy", "enabled"] }]);
    expect(parseConfigYaml(next).match({ ok: (doc) => doc.value, err: () => null })).toEqual({
      base: { enabled: true, size: 1 },
      copy: { size: 1 },
    });
  });

  it("keeps an anchor when its collection is replaced", () => {
    const text = "base: &shared\n  size: 1\ncopy: *shared\n";
    const next = patched(text, [{ op: "set", path: ["base"], value: { size: 2 } }]);
    expect(parseConfigYaml(next).match({ ok: (doc) => doc.value, err: () => null })).toEqual({
      base: { size: 2 },
      copy: { size: 2 },
    });
  });

  it("rejects removing an anchored value that an alias still uses", () => {
    const text = "base: &shared\n  size: 1\ncopy: *shared\n";
    expect(applyConfigPatch(text, [{ op: "unset", path: ["base"] }]).isErr()).toBe(true);
  });

  it("reports broken and recursive aliases as invalid YAML", () => {
    expect(parseConfigYaml("a: *missing\n").isErr()).toBe(true);
    expect(parseConfigYaml("a: &a [*a]\n").isErr()).toBe(true);
  });

  it("matches the file's indent width for new keys", () => {
    const next = patched("a:\n    b: 1\n", [{ op: "set", path: ["a", "c"], value: 2 }]);
    expect(next).toBe("a:\n    b: 1\n    c: 2\n");
  });

  it("detaches nested anchors without redirecting other aliases", () => {
    const text = "x: &outer\n  inner: &inner\n    k: 1\n  copy: *inner\ny: *outer\nz: *inner\n";
    const next = patched(text, [{ op: "set", path: ["y", "inner", "k"], value: 2 }]);
    expect(parseConfigYaml(next).match({ ok: (doc) => doc.value, err: () => null })).toEqual({
      x: { inner: { k: 1 }, copy: { k: 1 } },
      y: { inner: { k: 2 }, copy: { k: 1 } },
      z: { k: 1 },
    });
  });

  it("rejects a child path below a scalar reached through an alias", () => {
    expect(
      applyConfigPatch("x: &x 1\ny: *x\n", [{ op: "set", path: ["y", "z"], value: 2 }]).isErr(),
    ).toBe(true);
  });

  it("matches four-space sequences and ignores block scalar indentation", () => {
    const list = "root:\n    - a\n    - b\nother:   keep\n";
    expect(patched(list, [{ op: "set", path: ["root", 0], value: "x" }])).toBe(
      list.replace("- a", "- x"),
    );
    const scalar = "note: |\n x\nmap:\n    a: 1\n";
    expect(patched(scalar, [{ op: "set", path: ["map", "b"], value: 2 }])).toBe(
      `${scalar}    b: 2\n`,
    );
  });

  it("rejects a key path into a list", () => {
    expect(
      applyConfigPatch("a: [1]\n", [{ op: "set", path: ["a", "key"], value: 2 }]).isErr(),
    ).toBe(true);
  });

  it("indents inserted lines like their neighbours when blocks use different widths", () => {
    const text = [
      "configVersion: 1",
      "servers:",
      "  one:",
      "      transport: stdio",
      "      command:   echo",
      "  two:",
      "    transport: stdio",
      "    command:   node # keep",
      "",
    ].join("\n");
    const next = patched(text, [{ op: "set", path: ["servers", "one", "args"], value: ["a"] }]);
    expect(next.split("\n").slice(0, 5)).toEqual(text.split("\n").slice(0, 5));
    expect(next.endsWith("  two:\n    transport: stdio\n    command:   node # keep\n")).toBe(true);
    expect(parseConfigYaml(next).match({ ok: (doc) => doc.value, err: () => null })).toEqual({
      configVersion: 1,
      servers: {
        one: { transport: "stdio", command: "echo", args: ["a"] },
        two: { transport: "stdio", command: "node" },
      },
    });
  });

  it("keeps flush sequences and wide item spacing", () => {
    const flush = "map:\n    a: 1\nroot:\n- a: 1\n  b: 2\nother:   keep\n";
    expect(patched(flush, [{ op: "set", path: ["root", 0, "c"], value: 3 }])).toBe(
      flush.replace("  b: 2\n", "  b: 2\n  c: 3\n"),
    );
    const wide = "root:\n-   a: 1\nother:   keep\n";
    expect(patched(wide, [{ op: "set", path: ["root", 0, "b"], value: 2 }])).toBe(
      "root:\n-   a: 1\n    b: 2\nother:   keep\n",
    );
  });

  it("keeps untouched lines in files larger than the line comparison limit", () => {
    const env = Array.from({ length: 2500 }, (_, index) => `      V${index}:   x`).join("\n");
    const text = `servers:\n  one:\n    command:   echo\n    env:\n${env}\n`;
    const next = patched(text, [{ op: "set", path: ["servers", "one", "args"], value: ["a"] }]);
    expect(next.startsWith(`servers:\n  one:\n    command:   echo\n    env:\n${env}\n`)).toBe(true);
  });

  it("updates an existing numeric key when the path names it as a string", () => {
    expect(patched("root:\n  1: old\n", [{ op: "set", path: ["root", "1"], value: 2 }])).toBe(
      "root:\n  1: 2\n",
    );
  });

  it("finds numeric keys through aliases and boolean keys", () => {
    const aliased = "base: &base\n  1: old\n  keep: yes\ncopy: *base\n";
    const unset = patched(aliased, [{ op: "unset", path: ["copy", "1"] }]);
    expect(parseConfigYaml(unset).match({ ok: (doc) => doc.value, err: () => null })).toEqual({
      base: { "1": "old", keep: "yes" },
      copy: { keep: "yes" },
    });
    const set = patched(aliased, [{ op: "set", path: ["copy", "1"], value: 2 }]);
    expect(parseConfigYaml(set).match({ ok: (doc) => doc.value, err: () => null })).toEqual({
      base: { "1": "old", keep: "yes" },
      copy: { "1": 2, keep: "yes" },
    });
    expect(set.match(/"?1"?:/gu)?.length).toBe(2);
    expect(
      patched("env:\n  true: old\n  keep: 1\n", [{ op: "unset", path: ["env", "true"] }]),
    ).toBe("env:\n  keep: 1\n");
  });

  it("rejects a key path into a root list", () => {
    expect(applyConfigPatch("- x\n", [{ op: "set", path: ["oops"], value: 2 }]).isErr()).toBe(true);
    expect(applyConfigPatch("- x\n", [{ op: "set", path: ["0"], value: 2 }]).isErr()).toBe(true);
  });

  it("returns identical text for an empty patch", () => {
    const text = "configVersion: 3\nsurface:\n  discord: { botName: lilac }\n";
    expect(patched(text, [])).toBe(text);
  });

  it("creates missing parents and quotes numeric-looking strings", () => {
    const next = patched("configVersion: 3\n", [
      { op: "set", path: ["surface", "discord", "allowedChannelIds"], value: ["123"] },
    ]);
    expect(next).toContain('- "123"');
    expect(parseConfigYaml(next).match({ ok: (doc) => doc.value, err: () => null })).toEqual({
      configVersion: 3,
      surface: { discord: { allowedChannelIds: ["123"] } },
    });
  });

  it("removes maps emptied by an unset", () => {
    const next = patched("configVersion: 3\ntools:\n  output:\n    artifactTtl: 1d\n", [
      { op: "unset", path: ["tools", "output", "artifactTtl"] },
    ]);
    expect(next).toBe("configVersion: 3\n");
  });

  it("detaches aliases before editing through them", () => {
    const text = "a: &shared\n  x: 1\nb: *shared\n";
    const next = patched(text, [{ op: "set", path: ["b", "x"], value: 2 }]);
    expect(parseConfigYaml(next).match({ ok: (doc) => doc.value, err: () => null })).toEqual({
      a: { x: 1 },
      b: { x: 2 },
    });
  });

  it("rejects paths through scalars and invalid YAML", () => {
    expect(applyConfigPatch("a: 1\n", [{ op: "set", path: ["a", "b"], value: 1 }]).isErr()).toBe(
      true,
    );
    expect(applyConfigPatch("a: [\n", []).isErr()).toBe(true);
  });
});

describe("config paths", () => {
  it("round-trips quoted and indexed segments", () => {
    const path = ["models", "capability", "overrides", "openai/gpt-4.1", "limit", 0];
    const text = formatConfigPath(path);
    expect(text).toBe('models.capability.overrides["openai/gpt-4.1"].limit[0]');
    expect(parseConfigPath(text).match({ ok: (value) => value, err: () => [] })).toEqual(path);
  });

  it("rejects malformed paths", () => {
    expect(parseConfigPath(".a").isErr()).toBe(true);
    expect(parseConfigPath("a..b").isErr()).toBe(true);
    expect(parseConfigPath('a["\\x"]').isErr()).toBe(true);
  });
});

describe("config schema navigation", () => {
  const schema = decodeConfigSchema({
    anyOf: [
      { type: "object", properties: { configVersion: { const: 1 } } },
      {
        type: "object",
        properties: {
          configVersion: { const: 2 },
          output: {
            type: "object",
            default: { mode: "auto", size: 3 },
            properties: { mode: { type: "string" }, size: { type: "integer" } },
          },
          removed: { not: {} },
          storage: {
            anyOf: [
              {
                type: "object",
                properties: { kind: { const: "local" }, root: { type: "string" } },
              },
              {
                type: "object",
                properties: { kind: { const: "s3" }, bucket: { type: "string" } },
              },
            ],
          },
          aliases: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: { model: { type: "string", "x-lilac": { kind: "model" } } },
            },
          },
        },
      },
    ],
  }).match({
    ok: (value) => value,
    err: (error) => {
      throw new Error(error.message);
    },
  });
  const root = versionSchemaNode(schema, 2);

  it("lists fields with record wildcards and merged union members", () => {
    expect(enumerateConfigFields(schema, root).map((field) => field.pattern)).toEqual([
      "configVersion",
      "output",
      "output.mode",
      "output.size",
      "storage",
      "storage.kind",
      "storage.root",
      "storage.bucket",
      "aliases",
      "aliases.*",
      "aliases.*.model",
    ]);
  });

  it("chooses union members from the current value", () => {
    const value = { storage: { kind: "s3" } };
    expect(schemaAtPath(schema, root, ["storage", "bucket"], value)?.type).toBe("string");
    expect(schemaAtPath(schema, root, ["storage", "root"], value)).toBeUndefined();
    expect(schemaAtPath(schema, root, ["aliases", "fast", "model"])?.["x-lilac"]).toEqual({
      kind: "model",
    });
    expect(schemaAtPath(schema, root, ["removed"])).toBeUndefined();
  });

  it("takes defaults from the first missing parent", () => {
    // A present parent applies its children's own defaults, and `size` has none.
    expect(schemaDefaultAtPath(schema, root, ["output", "size"], { output: {} })).toBeUndefined();
    expect(schemaDefaultAtPath(schema, root, ["output", "size"], {})).toBe(3);
  });

  it("reads defaults from ancestors", () => {
    expect(schemaDefaultAtPath(schema, root, ["output", "size"])).toBe(3);
    expect(schemaDefaultAtPath(schema, root, ["aliases", "x", "model"])).toBeUndefined();
  });
});
