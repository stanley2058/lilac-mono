import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  commonConfigLines,
  applyConfigPatch,
  formatConfigPath,
  isConfigObject,
  parseConfigYaml,
  type ConfigPatchOperation,
  type ConfigPath,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import {
  configFieldUi,
  decodeConfigSchema,
  enumerateConfigFields,
  schemaAlternatives,
  schemaAtPath,
  versionSchemaNode,
  type ConfigSchema,
  type ConfigSchemaNode,
} from "@stanley2058/lilac-utils/config-schema";
import { decodeCoreConfigYaml, parseCoreConfigResult } from "@stanley2058/lilac-utils/core-config";
import { DEFAULT_CORE_CONFIG_VERSION } from "@stanley2058/lilac-utils/core-config/v3";
import { errorCode } from "@stanley2058/lilac-utils/runtime-utils";

import coreSchemaJson from "../generated/config-schemas/core-config.schema.json";
import mcpSchemaJson from "../generated/config-schemas/mcp-config.schema.json";
import { parseMcpConfigYaml } from "../mcp/config";
import { withMcpConfigMutationLock } from "../mcp/config-file";
import { captureError } from "../shared/error-capture";

export type ConfigFileKind = "core" | "mcp";
export type ConfigFileDocument = { kind: ConfigFileKind; revision: string; text: string };

export class ConfigFileError extends TaggedError("ConfigFileError")<{
  code: "invalid" | "conflict" | "io";
  message: string;
  currentRevision?: string;
}> {}

const MAX_CONFIG_BYTES = 1_048_576;
const EMPTY_MCP_CONFIG = "configVersion: 1\nservers: {}\n";

function failure(
  code: ConfigFileError["code"],
  message: string,
  currentRevision?: string,
): ConfigFileError {
  return new ConfigFileError({
    code,
    message,
    ...(currentRevision ? { currentRevision } : {}),
  });
}

export function configRevision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function configFileName(kind: ConfigFileKind): string {
  return `${kind}-config.yaml`;
}

export function validateConfigDocument(
  kind: ConfigFileKind,
  text: string,
): ResultType<void, ConfigFileError> {
  if (text.length > MAX_CONFIG_BYTES)
    return Result.err(failure("invalid", "Configuration exceeds 1 MiB"));
  if (kind === "mcp") {
    const parsed = parseMcpConfigYaml(text);
    if (!parsed.ok) return Result.err(failure("invalid", parsed.issues.join("\n")));
    return Result.ok();
  }
  return Result.gen(function* () {
    const raw = yield* decodeCoreConfigYaml(text).mapError((error) =>
      failure("invalid", error.message),
    );
    yield* parseCoreConfigResult(raw).mapError((error) => {
      if (
        error._tag !== "CoreConfigV1Invalid" &&
        error._tag !== "CoreConfigV2Invalid" &&
        error._tag !== "CoreConfigV3Invalid"
      )
        return failure("invalid", error.message);
      return failure(
        "invalid",
        error.cause.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("\n"),
      );
    });
    return Result.ok();
  });
}

type LoadedSchema = { readonly schema: ConfigSchema };
const loadedSchemas = new Map<ConfigFileKind, LoadedSchema>();

/** The decoded editor schema for one file. The JSON is generated, so a decode failure is a build defect. */
export function configFileSchema(kind: ConfigFileKind): ResultType<ConfigSchema, ConfigFileError> {
  const cached = loadedSchemas.get(kind);
  if (cached) return Result.ok(cached.schema);
  return decodeConfigSchema(kind === "core" ? coreSchemaJson : mcpSchemaJson)
    .mapError((error) => failure("io", `${configFileName(kind)} schema: ${error.message}`))
    .map((schema) => {
      loadedSchemas.set(kind, { schema });
      return schema;
    });
}

/** The core schema of the file's `configVersion` (an omitted version parses as 1); MCP has one. */
export function configVersionOf(kind: ConfigFileKind, value: ConfigValue | undefined): number {
  if (kind === "mcp") return 1;
  const version = isConfigObject(value) ? value.configVersion : undefined;
  return typeof version === "number" ? version : DEFAULT_CORE_CONFIG_VERSION;
}

export function configRootNode(
  kind: ConfigFileKind,
  schema: ConfigSchema,
  value: ConfigValue | undefined,
): ConfigSchemaNode {
  return versionSchemaNode(schema, kind === "core" ? configVersionOf(kind, value) : undefined);
}

/** Keys of an object or record node: declared properties and whether arbitrary keys are allowed. */
export function configChildKeys(
  schema: ConfigSchema,
  node: ConfigSchemaNode,
): { readonly properties: ReadonlyMap<string, ConfigSchemaNode>; readonly anyKey: boolean } {
  const properties = new Map<string, ConfigSchemaNode>();
  let anyKey = false;
  for (const alternative of schemaAlternatives(schema, node)) {
    for (const [key, property] of Object.entries(alternative.properties ?? {})) {
      if (!properties.has(key)) properties.set(key, property);
    }
    if (typeof alternative.additionalProperties === "object") anyKey = true;
  }
  return { properties, anyKey };
}

/** An error naming the longest prefix of `path` that the schema knows. */
export function unknownConfigPathError(
  kind: ConfigFileKind,
  schema: ConfigSchema,
  root: ConfigSchemaNode,
  configPath: ConfigPath,
  value: ConfigValue | undefined,
): ConfigFileError {
  let length = configPath.length - 1;
  let parent = schemaAtPath(schema, root, configPath.slice(0, length), value);
  while (!parent && length > 0) {
    length -= 1;
    parent = schemaAtPath(schema, root, configPath.slice(0, length), value);
  }
  const parentLabel = length === 0 ? "<root>" : formatConfigPath(configPath.slice(0, length));
  const children = parent ? configChildKeys(schema, parent) : undefined;
  const keys = children ? [...children.properties.keys()].slice(0, 40) : [];
  const keyList = keys.length > 0 ? ` Valid keys: ${keys.join(", ")}.` : "";
  return failure(
    "invalid",
    `Unknown ${configFileName(kind)} path ${formatConfigPath(configPath)}. Nearest valid parent: ${parentLabel}.${keyList} Use config.describe to inspect fields.`,
  );
}

function checkOperationPaths(
  kind: ConfigFileKind,
  operations: readonly ConfigPatchOperation[],
  before: ConfigValue,
  after: ConfigValue,
): ResultType<void, ConfigFileError> {
  return Result.gen(function* () {
    const schema = yield* configFileSchema(kind);
    for (const operation of operations) {
      if (operation.path.length === 0)
        return Result.err(failure("invalid", "A patch path must name a field"));
      // A set may switch a union member, so it resolves against the result; an unset path is gone there.
      const value = operation.op === "set" ? after : before;
      const root = configRootNode(kind, schema, value);
      if (!schemaAtPath(schema, root, operation.path, value))
        return Result.err(unknownConfigPathError(kind, schema, root, operation.path, value));
    }
    return Result.ok();
  });
}

function patternPrefixMatches(pattern: readonly string[], configPath: ConfigPath): boolean {
  const length = Math.min(pattern.length, configPath.length);
  for (let index = 0; index < length; index += 1) {
    const part = pattern[index];
    if (part !== "*" && part !== String(configPath[index])) return false;
  }
  return true;
}

/** Touched paths at, above, or below a field that Core reads only at startup. */
export function restartConfigPaths(
  kind: ConfigFileKind,
  operations: readonly ConfigPatchOperation[],
  value: ConfigValue,
): ResultType<readonly string[], ConfigFileError> {
  return configFileSchema(kind).map((schema) => {
    const root = configRootNode(kind, schema, value);
    const restartPatterns = enumerateConfigFields(schema, root)
      .filter((field) => configFieldUi(schema, field.node).restart === true)
      .map((field) => field.pattern.split("."));
    const paths = new Set<string>();
    for (const operation of operations) {
      if (restartPatterns.some((pattern) => patternPrefixMatches(pattern, operation.path)))
        paths.add(formatConfigPath(operation.path));
    }
    return [...paths];
  });
}

export type ConfigPatchInput = {
  readonly kind: ConfigFileKind;
  readonly operations: readonly ConfigPatchOperation[];
  readonly expectedRevision?: string;
  readonly dryRun?: boolean;
};

export type ConfigPatchOutcome = {
  readonly previous: ConfigFileDocument;
  readonly document: ConfigFileDocument;
  readonly changed: boolean;
  readonly written: boolean;
  readonly diff: string;
  readonly restartPaths: readonly string[];
};

/** Reads, validates, and writes `DATA_DIR/{core,mcp}-config.yaml` for every editing path. */
export class ConfigFiles {
  constructor(private readonly options: { readonly dataDir: string }) {}

  filePath(kind: ConfigFileKind): string {
    return path.join(this.options.dataDir, configFileName(kind));
  }

  async read(kind: ConfigFileKind): Promise<ResultType<ConfigFileDocument, ConfigFileError>> {
    const read = await Result.tryPromise({
      try: () => fs.readFile(this.filePath(kind), "utf8"),
      catch: captureError,
    });
    return read.match<ResultType<ConfigFileDocument, ConfigFileError>>({
      ok: (text) => Result.ok({ kind, text, revision: configRevision(text) }),
      err: ({ cause: error }) => {
        const missing = kind === "mcp" && errorCode(error) === "ENOENT";
        if (!missing) return Result.err(failure("io", error.message));
        return Result.ok({
          kind,
          text: EMPTY_MCP_CONFIG,
          revision: configRevision(EMPTY_MCP_CONFIG),
        });
      },
    });
  }

  /** Replaces the whole file when `expectedRevision` still matches. */
  save(input: {
    readonly kind: ConfigFileKind;
    readonly text: string;
    readonly expectedRevision: string;
  }): Promise<ResultType<ConfigFileDocument, ConfigFileError>> {
    return this.serialized(input.kind, () => this.saveSerialized(input));
  }

  /** Applies comment-preserving operations, validates the whole result, and writes it unless `dryRun`. */
  patch(input: ConfigPatchInput): Promise<ResultType<ConfigPatchOutcome, ConfigFileError>> {
    return this.serialized(input.kind, () => this.patchSerialized(input));
  }

  // MCP writes share the registry tools' path lock. The same path-keyed queue also orders core writes.
  private serialized<T>(
    kind: ConfigFileKind,
    operation: () => Promise<ResultType<T, ConfigFileError>>,
  ): Promise<ResultType<T, ConfigFileError>> {
    return withMcpConfigMutationLock(this.filePath(kind), operation);
  }

  private async saveSerialized(input: {
    readonly kind: ConfigFileKind;
    readonly text: string;
    readonly expectedRevision: string;
  }): Promise<ResultType<ConfigFileDocument, ConfigFileError>> {
    return Result.gen(async function* (this: ConfigFiles) {
      yield* validateConfigDocument(input.kind, input.text);
      const current = yield* Result.await(this.read(input.kind));
      if (current.revision !== input.expectedRevision)
        return Result.err(
          failure("conflict", "Configuration changed since it was loaded", current.revision),
        );
      if (current.text === input.text) return Result.ok(current);
      yield* Result.await(writeAtomic(this.filePath(input.kind), input.text));
      return Result.ok({
        kind: input.kind,
        text: input.text,
        revision: configRevision(input.text),
      });
    }, this);
  }

  private async patchSerialized(
    input: ConfigPatchInput,
  ): Promise<ResultType<ConfigPatchOutcome, ConfigFileError>> {
    return Result.gen(async function* (this: ConfigFiles) {
      const previous = yield* Result.await(this.read(input.kind));
      if (input.expectedRevision !== undefined && previous.revision !== input.expectedRevision)
        return Result.err(
          failure("conflict", "Configuration changed since it was loaded", previous.revision),
        );
      const invalid = (error: { message: string }) => failure("invalid", error.message);
      const before = yield* parseConfigYaml(previous.text).mapError(invalid);
      const text = yield* applyConfigPatch(previous.text, input.operations).mapError(invalid);
      const after = yield* parseConfigYaml(text).mapError(invalid);
      yield* checkOperationPaths(input.kind, input.operations, before.value, after.value);
      yield* validateConfigDocument(input.kind, text);
      const changed = text !== previous.text;
      const restartPaths = changed
        ? yield* restartConfigPaths(input.kind, input.operations, after.value)
        : [];
      const document = { kind: input.kind, text, revision: configRevision(text) };
      const outcome = { previous, document, changed, diff: diffConfigText(previous.text, text) };
      if (!changed || input.dryRun) return Result.ok({ ...outcome, written: false, restartPaths });
      yield* Result.await(writeAtomic(this.filePath(input.kind), text));
      return Result.ok({ ...outcome, written: true, restartPaths });
    }, this);
  }
}

async function writeAtomic(file: string, text: string): Promise<ResultType<void, ConfigFileError>> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const written = await Result.gen(async function* () {
    const handle = yield* Result.await(
      Result.tryPromise({
        try: () => fs.open(temporary, "wx", 0o600),
        catch: () => failure("io", "Cannot create temporary configuration"),
      }),
    );
    const content = await Result.tryPromise({
      try: async () => {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      },
      catch: () => failure("io", "Cannot write temporary configuration"),
    });
    const closed = await Result.tryPromise({
      try: () => handle.close(),
      catch: () => failure("io", "Cannot close temporary configuration"),
    });
    yield* Result.all([content, closed]);
    yield* Result.await(
      Result.tryPromise({
        try: () => fs.rename(temporary, file),
        catch: () => failure("io", "Cannot replace configuration"),
      }),
    );
    return Result.ok();
  });
  const cleanup = await Result.tryPromise({
    try: () => fs.rm(temporary, { force: true }),
    catch: () => failure("io", "Cannot remove temporary configuration"),
  });
  return Result.all([written, cleanup]).map(() => undefined);
}

type DiffLine = { readonly mark: " " | "-" | "+"; readonly text: string };

const DIFF_CONTEXT_LINES = 2;
const MAX_LCS_CELLS = 4_000_000;
const MAX_DIFF_CHARS = 16_000;

function splitLines(text: string): readonly string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lcsDiff(before: readonly string[], after: readonly string[]): readonly DiffLine[] {
  // Large rewrites skip the quadratic table and show a full replacement.
  if ((before.length + 1) * (after.length + 1) > MAX_LCS_CELLS)
    return [
      ...before.map((text) => ({ mark: "-" as const, text })),
      ...after.map((text) => ({ mark: "+" as const, text })),
    ];
  const lines: DiffLine[] = [];
  let row = 0;
  let column = 0;
  for (const [nextRow, nextColumn] of commonConfigLines(before, after)) {
    for (; row < nextRow; row += 1) lines.push({ mark: "-", text: before[row] ?? "" });
    for (; column < nextColumn; column += 1) lines.push({ mark: "+", text: after[column] ?? "" });
    lines.push({ mark: " ", text: before[row] ?? "" });
    row += 1;
    column += 1;
  }
  for (; row < before.length; row += 1) lines.push({ mark: "-", text: before[row] ?? "" });
  for (; column < after.length; column += 1) lines.push({ mark: "+", text: after[column] ?? "" });
  return lines;
}

function diffLines(before: readonly string[], after: readonly string[]): readonly DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start])
    start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const same = (text: string): DiffLine => ({ mark: " ", text });
  return [
    ...before.slice(0, start).map(same),
    ...lcsDiff(before.slice(start, beforeEnd), after.slice(start, afterEnd)),
    ...before.slice(beforeEnd).map(same),
  ];
}

function hunkRanges(lines: readonly DiffLine[]): readonly (readonly [number, number])[] {
  const ranges: [number, number][] = [];
  lines.forEach((line, index) => {
    if (line.mark === " ") return;
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length, index + DIFF_CONTEXT_LINES + 1);
    const last = ranges.at(-1);
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
      return;
    }
    ranges.push([start, end]);
  });
  return ranges;
}

/** A unified-style line diff with two context lines, or "" when the texts are equal. */
export function diffConfigText(before: string, after: string): string {
  if (before === after) return "";
  const lines = diffLines(splitLines(before), splitLines(after));
  const beforeLineAt: number[] = [];
  const afterLineAt: number[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  for (const line of lines) {
    beforeLineAt.push(beforeLine);
    afterLineAt.push(afterLine);
    if (line.mark !== "+") beforeLine += 1;
    if (line.mark !== "-") afterLine += 1;
  }
  const output: string[] = [];
  for (const [start, end] of hunkRanges(lines)) {
    const hunk = lines.slice(start, end);
    const beforeCount = hunk.filter((line) => line.mark !== "+").length;
    const afterCount = hunk.filter((line) => line.mark !== "-").length;
    output.push(
      `@@ -${beforeLineAt[start] ?? 1},${beforeCount} +${afterLineAt[start] ?? 1},${afterCount} @@`,
      ...hunk.map((line) => `${line.mark}${line.text}`),
    );
  }
  const diff = output.join("\n");
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  const cut = diff.lastIndexOf("\n", MAX_DIFF_CHARS);
  const kept = diff.slice(0, cut > 0 ? cut : MAX_DIFF_CHARS);
  const omitted = diff.slice(kept.length).split("\n").length - 1;
  return `${kept}\n... diff truncated (${omitted} more lines)`;
}
