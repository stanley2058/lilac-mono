import { z } from "zod";
import { Result, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolJsonValue,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import {
  formatConfigPath,
  isConfigObject,
  parseConfigPath,
  parseConfigYaml,
  readConfigValue,
  type ConfigPatchOperation,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import {
  configFieldUi,
  enumerateConfigFields,
  schemaAlternatives,
  schemaAtPath,
  schemaDefaultAtPath,
  type ConfigSchema,
  type ConfigSchemaNode,
} from "@stanley2058/lilac-utils/config-schema";

import {
  configChildKeys,
  configFileName,
  configFileSchema,
  configRootNode,
  configVersionOf,
  unknownConfigPathError,
  type ConfigFileError,
  type ConfigFileKind,
  type ConfigFiles,
} from "../../runtime/config-files";
import type { McpRegistryApi } from "../../mcp/registry-types";
import { defineServerTool, type ServerTool } from "../types";

const fileSchema = z
  .enum(["core", "mcp"])
  .describe("core: DATA_DIR/core-config.yaml; mcp: DATA_DIR/mcp-config.yaml.");
const pathSchema = z
  .string()
  .max(1024)
  .describe('Field path such as agent.subagents.maxDepth, models.def["gpt-5"].model, or a.b[0].');

const describeInputSchema = z.strictObject({
  file: fileSchema,
  path: pathSchema.optional().describe("Describe one field: schema, default, and current value."),
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Search field paths and descriptions (case-insensitive); returns up to 20 fields."),
});

const operationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set"),
    path: pathSchema,
    value: z.json().describe("JSON value to write at path."),
  }),
  z.strictObject({
    op: z.literal("unset"),
    path: pathSchema.describe("Field to remove so its schema default applies again."),
  }),
]);

const patchInputSchema = z.strictObject({
  file: fileSchema,
  operations: z.array(operationSchema).min(1).max(50).describe("Edits applied in order."),
  dryRun: z.boolean().optional().describe("Validate and return the diff without writing."),
  expectedRevision: z
    .string()
    .max(128)
    .optional()
    .describe("Revision from an earlier config.patch; the write fails if the file changed since."),
});

const SECRET_RULE =
  "Never write secret values into these files: reference environment variable names (fields ending in Env) or, in mcp-config.yaml, value sources such as {env: NAME}.";

const DESCRIBE_DESCRIPTION = [
  "Describe Lilac's own configuration files before editing them.",
  "No path or query lists top-level sections. `query` searches field paths and descriptions.",
  "`path` returns the field's description, type, default, current value, whether the file sets it explicitly, and child keys for objects.",
  "Record keys appear as `*` in query results; substitute a concrete key in paths.",
].join(" ");

const PATCH_DESCRIPTION = [
  "Edit DATA_DIR/core-config.yaml or mcp-config.yaml with comment-preserving set/unset operations.",
  "Call config.describe first to confirm paths and value shapes.",
  "Use `unset` to reset a field to its default instead of writing the default value.",
  "The whole result is validated before writing; use dryRun to preview the diff.",
  "Core applies core-config changes automatically except fields marked restart, which the result lists and which need a Core restart.",
  "MCP changes reload the MCP registry and return per-server outcomes.",
  SECRET_RULE,
].join(" ");

const MAX_CURRENT_VALUE_CHARS = 8_000;
const MAX_LISTED_KEYS = 60;
const MAX_QUERY_RESULTS = 20;

function configToolFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `config_${kind}`,
    message,
    retryable: kind === "conflict" || kind === "unavailable",
  });
}

function fromFileError(error: ConfigFileError): ServerToolFailure {
  switch (error.code) {
    case "invalid":
      return configToolFailure("usage", error.message);
    case "conflict":
      return serverToolFailure({
        ...configToolFailure("conflict", error.message),
        ...(error.currentRevision ? { details: { currentRevision: error.currentRevision } } : {}),
      });
    case "io":
      return configToolFailure("unavailable", error.message);
  }
}

function oneLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n")[0]?.trim() ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

function nodeDescription(schema: ConfigSchema, node: ConfigSchemaNode): string | undefined {
  if (node.description) return node.description;
  return schemaAlternatives(schema, node).find((alternative) => alternative.description)
    ?.description;
}

function nodeTypes(schema: ConfigSchema, node: ConfigSchemaNode): ServerToolJsonValue {
  const types = new Set<string>();
  const values: ConfigValue[] = [];
  for (const alternative of schemaAlternatives(schema, node)) {
    if (alternative.const !== undefined) values.push(alternative.const);
    if (alternative.enum) values.push(...alternative.enum);
    const type = alternative.type;
    if (typeof type === "string") types.add(type);
    if (Array.isArray(type)) for (const entry of type) types.add(entry);
    if (type === undefined && alternative.properties) types.add("object");
  }
  return { types: [...types], ...(values.length > 0 ? { values: values.slice(0, 40) } : {}) };
}

function boundedValue(value: ConfigValue | undefined): ServerToolJsonValue | undefined {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text.length <= MAX_CURRENT_VALUE_CHARS) return value;
  return `<${text.length} characters; describe a child path to read it>`;
}

type DescribeInput = z.output<typeof describeInputSchema>;
type PatchInput = z.output<typeof patchInputSchema>;
type ConfigRegistry = Pick<McpRegistryApi, "reload">;

export class ConfigManagement implements ServerTool {
  id = "config";
  private readonly serverTool: ServerTool;

  constructor(
    private readonly params: {
      readonly files: ConfigFiles;
      readonly registry?: ConfigRegistry;
    },
  ) {
    this.serverTool = defineServerTool({
      id: this.id,
      callables: ({ callable }) => ({
        "config.describe": callable({
          name: "Config Describe",
          description: DESCRIBE_DESCRIPTION,
          inputSchema: describeInputSchema,
          primaryPositional: "file",
          run: (input) => this.callDescribe(input),
        }),
        "config.patch": callable({
          name: "Config Patch",
          description: PATCH_DESCRIPTION,
          inputSchema: patchInputSchema,
          primaryPositional: "file",
          run: (input) => this.callPatch(input),
        }),
      }),
    });
  }

  async init(): Promise<void> {
    await this.serverTool.init();
  }

  async destroy(): Promise<void> {
    await this.serverTool.destroy();
  }

  async list() {
    return this.serverTool.list();
  }

  async call(callableId: string, rawInput: Record<string, unknown>): Promise<ServerToolResult> {
    return this.serverTool.call(callableId, rawInput);
  }

  private async callDescribe(input: DescribeInput): Promise<ServerToolResult> {
    const files = this.params.files;
    return Result.gen(async function* () {
      const document = yield* (await files.read(input.file)).mapError(fromFileError);
      const schema = yield* configFileSchema(input.file).mapError(fromFileError);
      const value = parseConfigYaml(document.text).match({
        ok: (parsed) => parsed.value,
        err: () => null,
      });
      const header = {
        file: configFileName(input.file),
        revision: document.revision,
        ...(input.file === "core" ? { configVersion: configVersionOf(input.file, value) } : {}),
      };
      const root = configRootNode(input.file, schema, value);
      if (input.path !== undefined)
        return describePath({ kind: input.file, schema, root, value, path: input.path }).map(
          (field) => ({ ...header, ...field }),
        );
      if (input.query !== undefined)
        return Result.ok({ ...header, ...describeQuery(schema, root, input.query) });
      return Result.ok({ ...header, sections: describeSections(schema, root, value) });
    });
  }

  private async callPatch(input: PatchInput): Promise<ServerToolResult> {
    const params = this.params;
    return Result.gen(async function* () {
      const operations = yield* parseOperations(input.operations);
      const outcome = yield* (
        await params.files.patch({
          kind: input.file,
          operations,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision }),
          ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
        })
      ).mapError(fromFileError);
      const restart =
        outcome.restartPaths.length > 0
          ? {
              restartRequired: [...outcome.restartPaths],
              note: "Core reads these fields only at startup. Restart Core to apply them.",
            }
          : {};
      const summary = {
        file: configFileName(input.file),
        dryRun: input.dryRun === true,
        changed: outcome.changed,
        written: outcome.written,
        previousRevision: outcome.previous.revision,
        revision: outcome.document.revision,
        diff: outcome.diff,
        ...restart,
      };
      if (input.file !== "mcp" || !outcome.written) return Result.ok(summary);
      const reload = yield* Result.await(reloadMcp(params.registry));
      return Result.ok({ ...summary, reload });
    });
  }
}

function parseOperations(
  operations: PatchInput["operations"],
): ResultType<readonly ConfigPatchOperation[], ServerToolFailure> {
  return Result.gen(function* () {
    const parsed: ConfigPatchOperation[] = [];
    for (const operation of operations) {
      const path = yield* parseConfigPath(operation.path).mapError((error) =>
        configToolFailure("usage", error.message),
      );
      parsed.push(
        operation.op === "set"
          ? { op: "set", path, value: operation.value }
          : { op: "unset", path },
      );
    }
    return Result.ok(parsed);
  });
}

async function reloadMcp(
  registry: ConfigRegistry | undefined,
): Promise<ResultType<ServerToolJsonValue, ServerToolFailure>> {
  if (!registry)
    return Result.ok({ status: "unavailable", note: "MCP registry is not running in this Core." });
  return (await registry.reload())
    .map((outcomes) => ({
      status: "reloaded",
      servers: outcomes.map((outcome) => ({
        serverId: outcome.serverId,
        reconciliation: outcome.reconciliation,
        result: outcome.result,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      })),
    }))
    .mapError((error) =>
      configToolFailure("unavailable", `Saved, but MCP reload failed: ${error.message}`),
    );
}

function describePath(params: {
  readonly kind: ConfigFileKind;
  readonly schema: ConfigSchema;
  readonly root: ConfigSchemaNode;
  readonly value: ConfigValue;
  readonly path: string;
}): ResultType<{ readonly [key: string]: ServerToolJsonValue }, ServerToolFailure> {
  return Result.gen(function* () {
    const { kind, schema, root, value } = params;
    const path = yield* parseConfigPath(params.path).mapError((error) =>
      configToolFailure("usage", error.message),
    );
    const node = schemaAtPath(schema, root, path, value);
    if (!node)
      return Result.err(fromFileError(unknownConfigPathError(kind, schema, root, path, value)));
    const ui = configFieldUi(schema, node);
    const current = readConfigValue(value, path);
    const defaultValue = schemaDefaultAtPath(schema, root, path, value);
    const children = configChildKeys(schema, node);
    const keys = [...children.properties.entries()]
      .slice(0, MAX_LISTED_KEYS)
      .map(([key, child]) => {
        const description = oneLine(nodeDescription(schema, child));
        return { key, ...(description ? { description } : {}) };
      });
    const recordKeys =
      children.anyKey && isConfigObject(current)
        ? Object.keys(current).slice(0, MAX_LISTED_KEYS)
        : [];
    const description = nodeDescription(schema, node);
    const boundedCurrent = boundedValue(current);
    const boundedDefault = boundedValue(defaultValue);
    return Result.ok({
      path: formatConfigPath(path),
      ...(description ? { description } : {}),
      type: nodeTypes(schema, node),
      ...(ui.kind ? { kind: ui.kind } : {}),
      restart: ui.restart === true,
      explicitlySet: current !== undefined,
      ...(boundedCurrent === undefined ? {} : { current: boundedCurrent }),
      ...(boundedDefault === undefined ? {} : { default: boundedDefault }),
      ...(keys.length > 0 ? { children: keys } : {}),
      ...(children.anyKey ? { acceptsAnyKey: true, existingKeys: recordKeys } : {}),
    });
  });
}

function describeQuery(
  schema: ConfigSchema,
  root: ConfigSchemaNode,
  query: string,
): { readonly [key: string]: ServerToolJsonValue } {
  const needle = query.toLowerCase();
  const matches = enumerateConfigFields(schema, root).filter((field) => {
    if (field.pattern.toLowerCase().includes(needle)) return true;
    return nodeDescription(schema, field.node)?.toLowerCase().includes(needle) === true;
  });
  return {
    query,
    total: matches.length,
    fields: matches.slice(0, MAX_QUERY_RESULTS).map((field) => {
      const description = oneLine(nodeDescription(schema, field.node));
      return { path: field.pattern, ...(description ? { description } : {}) };
    }),
  };
}

function describeSections(
  schema: ConfigSchema,
  root: ConfigSchemaNode,
  value: ConfigValue,
): ServerToolJsonValue {
  return [...configChildKeys(schema, root).properties.entries()].map(([key, node]) => {
    const description = oneLine(nodeDescription(schema, node));
    return {
      key,
      ...(description ? { description } : {}),
      set: isConfigObject(value) && Object.hasOwn(value, key),
    };
  });
}
