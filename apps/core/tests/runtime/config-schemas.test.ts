import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv from "ajv";
import { parseCoreConfigResult } from "@stanley2058/lilac-utils/core-config/parse";
import { isRecord } from "@stanley2058/lilac-utils/runtime-utils";
import { parseMcpConfigYaml, serializeMcpConfigYaml } from "../../src/mcp/config";
import { createEmptyMcpConfig } from "../../src/mcp/config-types";
import { publishConfigSchemas } from "../../src/runtime/config-schemas";
import coreSchema from "../../src/generated/config-schemas/core-config.schema.json";
import mcpSchema from "../../src/generated/config-schemas/mcp-config.schema.json";

const ajv = new Ajv({ strict: false, validateFormats: false });
const validateCore = ajv.compile(coreSchema);
const validateMcp = ajv.compile(mcpSchema);
const directories: string[] = [];

function undocumentedProperties(schema: unknown, prefix = ""): string[] {
  if (!isRecord(schema)) return [];
  const missing: string[] = [];
  if (isRecord(schema.properties)) {
    for (const [key, field] of Object.entries(schema.properties)) {
      if (!isRecord(field) || "not" in field) continue;
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      if (typeof field.description !== "string" || field.description.length === 0)
        missing.push(fieldPath);
      if (typeof field.markdownDescription !== "string" || field.markdownDescription.length === 0)
        missing.push(`${fieldPath} (Markdown)`);
      missing.push(...undocumentedProperties(field, fieldPath));
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) missing.push(...undocumentedProperties(branch, prefix));
  }
  for (const keyword of ["items", "additionalProperties"])
    missing.push(...undocumentedProperties(schema[keyword], `${prefix}.*`));
  return missing;
}

test("current Core fields expose hover documentation, including maps and union branches", () => {
  const current = coreSchema.anyOf.find((schema) => schema.properties.configVersion.const === 3);
  expect(current).toBeDefined();
  expect(undocumentedProperties(current)).toEqual([]);
});

test("hover documentation retains examples, units, defaults, and version-specific guidance", () => {
  const current = coreSchema.anyOf[2];
  if (!current) throw new Error("Missing current Core schema");
  const tools = current.properties.tools.properties;
  expect(tools.output?.properties.artifactTtl.markdownDescription).toContain("`7d`");
  expect(tools.output?.properties.artifactTtl.markdownDescription).toContain("mo is 30 days");
  expect(tools.output?.properties.artifactTtl.markdownDescription).toContain("Default: 7d");
  expect(
    current.properties.agent.properties.subagents.properties.permissions?.description,
  ).toContain("inherit restricted defaults");
  expect(
    current.properties.models.properties.rules?.items.properties.match.markdownDescription,
  ).toContain("`*` also matches slashes");
  expect(current.properties.surface.properties.discord.properties.tokenEnv.description).toContain(
    "not put the token itself",
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "lilac-config-schemas-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("Core schemas accept both versions, friendly units, and legacy web inputs", async () => {
  const cases = [
    {},
    { configVersion: 1 },
    { configVersion: 2 },
    { configVersion: 2, tools: { output: { artifactTtl: "3h", maxPreviewBytes: "1.5KiB" } } },
    { configVersion: 2, tools: { web: { firecrawl: { queueTtl: "2s" } } } },
    { configVersion: 2, tools: { web: { search: { provider: "exa" } } } },
    { configVersion: 1, tools: { web: { extract: { provider: "exa" } } } },
    { configVersion: 2, plugins: { config: { test: { arbitrary: [1, true, null] } } } },
    { configVersion: 3 },
    {
      configVersion: 3,
      agent: { subagents: { permissions: { offline: { network: false } } } },
    },
  ];
  for (const input of cases) {
    expect(parseCoreConfigResult(input).isOk()).toBe(true);
    expect(validateCore(input), JSON.stringify(validateCore.errors)).toBe(true);
  }
  const template = await Bun.file(
    path.join(
      import.meta.dir,
      "../../../../packages/utils/config-templates/core-config.example.yaml",
    ),
  ).text();
  expect(
    template.startsWith("# yaml-language-server: $schema=./.schemas/core-config.schema.json\n"),
  ).toBe(true);
  expect(validateCore(Bun.YAML.parse(template)), JSON.stringify(validateCore.errors)).toBe(true);
});

test("Core editor diagnostics reject wrong versions, fields, types, and units", () => {
  for (const input of [
    { configVersion: 4 },
    { configVersion: "2" },
    { configVersion: null },
    { configVersion: 2, typo: true },
    { configVersion: 3, agent: { subagents: { permissions: { offline: { typo: true } } } } },
    { tools: { output: { artifactTtl: "3h" } } },
    { configVersion: 2, tools: { output: { artifactTtl: true } } },
    { configVersion: 2, tools: { output: { artifactTtl: "3MB" } } },
    { configVersion: 2, tools: { output: { maxPreviewBytes: "3h" } } },
    { configVersion: 2, tools: { output: { artifactTtl: -1 } } },
    { configVersion: 2, tools: { web: { firecrawl: { maxConcurrency: "two" } } } },
  ])
    expect(validateCore(input), JSON.stringify(input)).toBe(false);
});

test("MCP schema validates transport-specific fields and credential source shapes", () => {
  const input = {
    configVersion: 1,
    servers: {
      local: { transport: "stdio", command: "example", env: { KEY: { env: "KEY" } } },
      remote: {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Token: { file: "/secret/token", pointer: "/token" } },
      },
    },
  };
  expect(parseMcpConfigYaml(Bun.YAML.stringify(input)).ok).toBe(true);
  expect(validateMcp(input), JSON.stringify(validateMcp.errors)).toBe(true);
  for (const invalid of [
    {},
    { configVersion: 2 },
    { configVersion: 1, typo: true },
    { configVersion: 1, servers: { bad: { transport: "stdio" } } },
    { configVersion: 1, servers: { bad: { transport: "http", command: "example" } } },
    { configVersion: 1, servers: { bad: { transport: "sse", url: "https://example.com" } } },
  ])
    expect(validateMcp(invalid)).toBe(false);
  expect(serializeMcpConfigYaml(createEmptyMcpConfig())).toStartWith(
    "# yaml-language-server: $schema=./.schemas/mcp-config.schema.json\n",
  );
});

test("publication replaces stale schemas, preserves unchanged files, and leaves config untouched", async () => {
  const directory = await temporaryDirectory();
  const configPath = path.join(directory, "core-config.yaml");
  await writeFile(configPath, "invalid: [\n");
  await publishConfigSchemas(directory);
  const schemaPath = path.join(directory, ".schemas/core-config.schema.json");
  expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual(coreSchema);
  const previous = new Date("2020-01-01T00:00:00Z");
  await utimes(schemaPath, previous, previous);
  await publishConfigSchemas(directory);
  expect((await stat(schemaPath)).mtimeMs).toBe(previous.getTime());
  await writeFile(schemaPath, '{"title":"another build"}\n');
  await publishConfigSchemas(directory);
  expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual(coreSchema);
  expect((await readdir(path.join(directory, ".schemas"))).sort()).toEqual([
    "core-config.schema.json",
    "mcp-config.schema.json",
  ]);
  expect(await readFile(configPath, "utf8")).toBe("invalid: [\n");
});

test("Core publishes schemas even when invalid config prevents startup", async () => {
  const directory = await temporaryDirectory();
  await writeFile(path.join(directory, "core-config.yaml"), "invalid: [\n");
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", path.join(import.meta.dir, "../../src/runtime/main.ts")],
    {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, DATA_DIR: directory, LOG_LEVEL: "error" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => child.kill(), 20_000);
  try {
    const [exit] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(1);
    expect(
      JSON.parse(await readFile(path.join(directory, ".schemas/core-config.schema.json"), "utf8")),
    ).toEqual(coreSchema);
    expect(
      JSON.parse(await readFile(path.join(directory, ".schemas/mcp-config.schema.json"), "utf8")),
    ).toEqual(mcpSchema);
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}, 25_000);
