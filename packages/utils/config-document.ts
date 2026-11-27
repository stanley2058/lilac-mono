import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  isAlias,
  isCollection,
  isMap,
  isScalar,
  isSeq,
  visit,
  parseDocument,
  stringify,
  type Document,
} from "yaml";
import { z } from "zod";

import { isRecord } from "./runtime-utils";

export type ConfigPathSegment = string | number;
export type ConfigPath = readonly ConfigPathSegment[];
export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | readonly ConfigValue[]
  | { readonly [key: string]: ConfigValue };

export type ConfigPatchOperation =
  | { readonly op: "set"; readonly path: ConfigPath; readonly value: ConfigValue }
  | { readonly op: "unset"; readonly path: ConfigPath };

export class ConfigDocumentInvalid extends TaggedError("ConfigDocumentInvalid")<{
  message: string;
}> {}

export type ParsedConfigDocument = {
  readonly document: Document;
  /** Plain value of the whole document; `null` for an empty file. */
  readonly value: ConfigValue;
};

const configValueSchema: z.ZodType<ConfigValue> = z.json();

function invalid(message: string): ConfigDocumentInvalid {
  return new ConfigDocumentInvalid({ message });
}

function documentValue(document: Document): ResultType<ConfigValue, ConfigDocumentInvalid> {
  return Result.try({
    try: () => configValueSchema.safeParse(document.toJS({ maxAliasCount: 100 }) ?? null),
    // A missing anchor throws while resolving; a self-referencing one recurses without end.
    catch: () => invalid("An alias points to a missing or self-referencing anchor"),
  }).andThen((parsed) =>
    parsed.success
      ? Result.ok(parsed.data)
      : Result.err(invalid("Configuration must contain only JSON-compatible values")),
  );
}

export function parseConfigYaml(
  text: string,
): ResultType<ParsedConfigDocument, ConfigDocumentInvalid> {
  const parsed = parseDocument(text);
  const [error] = parsed.errors;
  if (error) return Result.err(invalid(error.message));
  const document: Document = parsed;
  return documentValue(document).map((value) => ({ document, value }));
}

export function readConfigValue(value: ConfigValue, path: ConfigPath): ConfigValue | undefined {
  let current: ConfigValue | undefined = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    if (isConfigArray(current)) {
      current = typeof segment === "number" ? current[segment] : undefined;
      continue;
    }
    current = Object.hasOwn(current, segment) ? current[String(segment)] : undefined;
  }
  return current;
}

export function isConfigArray(value: ConfigValue | undefined): value is readonly ConfigValue[] {
  return Array.isArray(value);
}

export function isConfigObject(
  value: ConfigValue | undefined,
): value is { readonly [key: string]: ConfigValue } {
  return isRecord(value);
}

/** Structural equality for plain configuration values. */
export function configValuesEqual(
  left: ConfigValue | undefined,
  right: ConfigValue | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (isConfigArray(left) || isConfigArray(right)) {
    if (!isConfigArray(left) || !isConfigArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => configValuesEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && configValuesEqual(left[key], right[key]),
  );
}

/**
 * Replaces aliases on `path` with copies of their values. Aliased collections are shared, so an
 * edit through one path must not change the other users. The copy is built from the resolved
 * value, which carries no anchors that could collide with the originals.
 */
function expandAliasAncestors(
  document: Document,
  path: YamlKeyPath,
): ResultType<void, ConfigDocumentInvalid> {
  return Result.gen(function* () {
    for (let length = 1; length <= path.length; length += 1) {
      const prefix = path.slice(0, length);
      const node = document.getIn(prefix, true);
      if (!isAlias(node)) continue;
      const value = readConfigValue(yield* documentValue(document), asConfigPath(prefix));
      if (value === undefined) continue;
      const replacement = document.createNode(value);
      const target = node.resolve(document);
      if (isCollection(replacement) && isCollection(target)) replacement.flow = target.flow;
      replacement.comment = node.comment;
      replacement.commentBefore = node.commentBefore;
      document.setIn(prefix, replacement);
    }
    return Result.ok();
  });
}

/** A path in YAML key terms; unlike config paths, a key can also be a boolean such as `true:`. */
type YamlKey = string | number | boolean;
type YamlKeyPath = readonly YamlKey[];

function asConfigPath(path: YamlKeyPath): ConfigPath {
  return path.map((segment) => (typeof segment === "boolean" ? String(segment) : segment));
}

/**
 * `path` with each map segment replaced by the existing key it names, so `"1"` addresses an
 * unquoted `1:` key instead of adding a second key that reads the same.
 */
function existingKeys(document: Document, path: ConfigPath): YamlKeyPath {
  const resolved: YamlKey[] = [];
  let node: unknown = document.contents;
  for (const segment of path) {
    if (isAlias(node)) node = node.resolve(document);
    const match = isMap(node)
      ? node.items.find((pair) => isScalar(pair.key) && String(pair.key.value) === String(segment))
      : undefined;
    const key = match && isScalar(match.key) ? match.key.value : undefined;
    const next =
      typeof key === "string" || typeof key === "number" || typeof key === "boolean"
        ? key
        : segment;
    resolved.push(next);
    node = isCollection(node) ? node.get(next, true) : undefined;
  }
  return resolved;
}

/** The node at `path`, following aliases on the way. */
function nodeAt(document: Document, path: YamlKeyPath): unknown {
  let node: unknown = document.contents;
  for (const segment of path) {
    if (isAlias(node)) node = node.resolve(document);
    if (!isCollection(node)) return undefined;
    node = node.get(segment, true);
  }
  return node;
}

function setValue(
  document: Document,
  path: ConfigPath,
  value: ConfigValue,
): ResultType<void, ConfigDocumentInvalid> {
  if (path.length === 0) {
    document.contents = document.createNode(value);
    return Result.ok();
  }
  // Detaching an alias rebuilds its map, so keys are looked up again on the detached copy.
  return expandAliasAncestors(document, existingKeys(document, path).slice(0, -1)).map(() =>
    replaceValue(document, existingKeys(document, path), value),
  );
}

function replaceValue(document: Document, path: YamlKeyPath, value: ConfigValue): void {
  // A plain scalar replaces an existing scalar in place, which keeps its comments.
  if (value === null || typeof value !== "object") return document.setIn(path, value);
  const node = document.createNode(value);
  const current = document.getIn(path, true);
  if (isCollection(current) && isCollection(node)) {
    // Keep a `[a, b]` or `{a: b}` collection in flow style, and keep its anchor for aliases.
    node.flow = current.flow;
    node.anchor = current.anchor;
  }
  document.setIn(path, node);
}

function unsetValue(document: Document, path: ConfigPath): ResultType<void, ConfigDocumentInvalid> {
  if (path.length === 0) {
    document.contents = document.createNode({});
    return Result.ok();
  }
  if (nodeAt(document, existingKeys(document, path)) === undefined) return Result.ok();
  return expandAliasAncestors(document, existingKeys(document, path).slice(0, -1)).map(() =>
    deleteValue(document, existingKeys(document, path)),
  );
}

function deleteValue(document: Document, path: YamlKeyPath): void {
  document.deleteIn(path);
  // Drop maps that the removal emptied so reset fields leave no `{}` behind.
  for (let length = path.length - 1; length > 0; length -= 1) {
    const parentPath = path.slice(0, length);
    const parent = document.getIn(parentPath, true);
    if (!isMap(parent) || parent.items.length > 0) return;
    document.deleteIn(parentPath);
  }
}

function checkPath(document: Document, path: YamlKeyPath): ResultType<void, ConfigDocumentInvalid> {
  for (let length = 0; length < path.length; length += 1) {
    const found = nodeAt(document, path.slice(0, length));
    const node = isAlias(found) ? found.resolve(document) : found;
    const where =
      length === 0 ? "The document root" : formatConfigPath(asConfigPath(path.slice(0, length)));
    if (node === undefined) continue;
    if (!isCollection(node)) return Result.err(invalid(`${where} is not an object or list`));
    if (isSeq(node) && typeof path[length] !== "number")
      return Result.err(invalid(`${where} is a list; use an item index`));
  }
  return Result.ok();
}

/** Serializes with flow-collection padding that matches `styleOf`, such as `[a]` or `[ a ]`. */
export function serializeConfigDocument(document: Document, styleOf = ""): string {
  const layout = indentLayout(styleOf);
  return document.toString({
    lineWidth: 0,
    indent: layout.indent,
    indentSeq: layout.indentSeq,
    flowCollectionPadding: /[[{] [^\s\]}]/u.test(styleOf),
  });
}

function column(text: string, offset: number): number {
  return offset - (text.lastIndexOf("\n", offset - 1) + 1);
}

function mostCommon(counts: ReadonlyMap<number, number>, fallback: number): number {
  let best = fallback;
  let seen = 0;
  for (const [value, count] of counts)
    if (count > seen) {
      best = value;
      seen = count;
    }
  return best;
}

/**
 * The indent step and sequence style the file uses, measured from where nested block
 * collections start relative to their keys. Block scalar text and comments do not count.
 */
function indentLayout(text: string): { indent: number; indentSeq: boolean } {
  const steps = new Map<number, number>();
  let flushSequences = 0;
  let indentedSequences = 0;
  visit(parseDocument(text), {
    Pair(_, pair) {
      if (!isScalar(pair.key) || !pair.key.range) return;
      if (!isCollection(pair.value) || pair.value.flow || !pair.value.range) return;
      const step = column(text, pair.value.range[0]) - column(text, pair.key.range[0]);
      if (isSeq(pair.value) && step === 0) flushSequences += 1;
      if (isSeq(pair.value) && step > 0) indentedSequences += 1;
      if (step > 0) steps.set(step, (steps.get(step) ?? 0) + 1);
    },
  });
  return { indent: mostCommon(steps, 2), indentSeq: flushSequences <= indentedSequences };
}

const LCS_LIMIT = 4_000_000;

/**
 * Index pairs of a longest common subsequence of two line lists. Equal leading and trailing lines
 * pair directly, so only the changed middle needs the quadratic table; when that middle is still
 * too large, it is left unpaired.
 */
export function commonConfigLines(
  left: readonly string[],
  right: readonly string[],
): Array<readonly [number, number]> {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  const pairs: Array<readonly [number, number]> = [];
  for (let index = 0; index < start; index += 1) pairs.push([index, index]);
  const rows = leftEnd - start;
  const columns = rightEnd - start;
  if ((rows + 1) * (columns + 1) <= LCS_LIMIT)
    pairs.push(...middlePairs(left, right, start, leftEnd, rightEnd));
  for (let offset = 0; offset < left.length - leftEnd; offset += 1)
    pairs.push([leftEnd + offset, rightEnd + offset]);
  return pairs;
}

function middlePairs(
  left: readonly string[],
  right: readonly string[],
  start: number,
  leftEnd: number,
  rightEnd: number,
): Array<readonly [number, number]> {
  const width = rightEnd - start + 1;
  const lengths = new Uint32Array((leftEnd - start + 1) * width);
  for (let i = leftEnd - start - 1; i >= 0; i -= 1)
    for (let j = rightEnd - start - 1; j >= 0; j -= 1)
      lengths[i * width + j] =
        left[start + i] === right[start + j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
  const pairs: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < leftEnd - start && j < rightEnd - start) {
    if (left[start + i] === right[start + j]) {
      pairs.push([start + i, start + j]);
      i += 1;
      j += 1;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) i += 1;
    else j += 1;
  }
  return pairs;
}

function spacingFree(line: string): string {
  return line.replace(/\s+/gu, " ").trim();
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

/** Where a line's content starts, after indentation and any `- ` sequence markers. */
function contentColumn(line: string): number {
  return /^\s*(?:-\s+)*/u.exec(line)?.[0].length ?? 0;
}

/** Which original line decides how far to shift lines the patch inserts. */
type Shift = "previous" | "next" | "none";
const SHIFTS: readonly Shift[] = ["previous", "next", "none"];

/**
 * Keeps the original text of regions the patch did not change. The YAML printer normalizes
 * spacing, quoting and flow layout across the whole file, so the printed baseline is matched to
 * the original by lines that differ only in spacing, and every run of baseline lines that the
 * patch left alone is copied from the original. Inserted lines move by the indentation difference
 * between an original line and its printed form, taken from the line before or after them.
 */
function restoreUntouchedLines(
  original: string,
  baseline: string,
  next: string,
  shift: Shift,
): string {
  if (baseline === original) return next;
  const source = original.split("\n");
  const before = baseline.split("\n");
  const after = next.split("\n");
  const anchors = commonConfigLines(source.map(spacingFree), before.map(spacingFree));
  const sourceOf = new Map(anchors.map(([from, to]) => [to, from]));
  const kept = new Set<number>();
  // Lines of `next` that replace or add to the baseline, keyed by the baseline line they precede.
  const added = before.map((): string[] => []);
  const tail: string[] = [];
  let previous = -1;
  for (const [from, to] of commonConfigLines(before, after)) {
    added[from]?.push(...after.slice(previous + 1, to));
    kept.add(from);
    previous = to;
  }
  tail.push(...after.slice(previous + 1));
  const delta = (line: number): number => {
    const from = sourceOf.get(line);
    if (from === undefined || !kept.has(line)) return 0;
    return contentColumn(source[from] ?? "") - contentColumn(before[line] ?? "");
  };
  const shiftFor = (line: number): number => {
    if (shift === "next") return line < before.length ? delta(line) : 0;
    if (shift === "none") return 0;
    for (let index = line - 1; index >= 0; index -= 1)
      if (kept.has(index) && sourceOf.has(index)) return delta(index);
    return 0;
  };
  const inserted = (line: number): string[] => {
    const lines = line < before.length ? (added[line] ?? []) : tail;
    const offset = shiftFor(line);
    if (offset === 0) return lines;
    return lines.map((text) =>
      text.trim() === ""
        ? text
        : " ".repeat(Math.max(0, leadingSpaces(text) + offset)) + text.trimStart(),
    );
  };
  const output: string[] = [];
  const emitRegion = (sourceStart: number, sourceEnd: number, start: number, end: number) => {
    let untouched = true;
    for (let line = start; line < end; line += 1)
      if (!kept.has(line) || (line > start && (added[line]?.length ?? 0) > 0)) untouched = false;
    if (untouched) {
      if (start < end) output.push(...inserted(start));
      output.push(...source.slice(sourceStart, sourceEnd));
      return;
    }
    for (let line = start; line < end; line += 1) {
      output.push(...inserted(line));
      if (kept.has(line)) output.push(before[line] ?? "");
    }
  };
  let sourceStart = 0;
  let start = 0;
  for (const [sourceLine, line] of anchors) {
    emitRegion(sourceStart, sourceLine, start, line);
    output.push(...inserted(line));
    if (kept.has(line)) output.push(source[sourceLine] ?? "");
    sourceStart = sourceLine + 1;
    start = line + 1;
  }
  emitRegion(sourceStart, source.length, start, before.length);
  output.push(...inserted(before.length));
  return output.join("\n");
}

function serialize(document: Document, styleOf: string): ResultType<string, ConfigDocumentInvalid> {
  return Result.try({
    try: () => serializeConfigDocument(document, styleOf),
    // Removing an anchored value leaves its aliases pointing at nothing.
    catch: () => invalid("The change would break an alias that refers to this value"),
  });
}

/** Applies operations to YAML text, keeping comments and key order outside the changed nodes. */
export function applyConfigPatch(
  text: string,
  operations: readonly ConfigPatchOperation[],
): ResultType<string, ConfigDocumentInvalid> {
  return Result.gen(function* () {
    const { document } = yield* parseConfigYaml(text);
    if (operations.length === 0) return Result.ok(text);
    const baseline = serializeConfigDocument(document, text);
    if (document.contents === null) document.contents = document.createNode({});
    for (const operation of operations) {
      yield* checkPath(document, existingKeys(document, operation.path));
      if (operation.op === "set") yield* setValue(document, operation.path, operation.value);
      else yield* unsetValue(document, operation.path);
    }
    const next = yield* serialize(document, text);
    const expected = yield* documentValue(document);
    // Mixing original and printed lines can break indentation. Keep the first restoration that
    // reads back as the patched value, or fall back to the printed file.
    const restored = SHIFTS.map((shift) => restoreUntouchedLines(text, baseline, next, shift)).find(
      (candidate) =>
        parseConfigYaml(candidate).match({
          ok: ({ value }) => configValuesEqual(value, expected),
          err: () => false,
        }),
    );
    return Result.ok(restored ?? next);
  });
}

const plainSegment = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Formats a path as `a.b[0]["c.d"]`. */
export function formatConfigPath(path: ConfigPath): string {
  return path
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      if (plainSegment.test(segment)) return index === 0 ? segment : `.${segment}`;
      return `["${segment.replace(/["\\]/gu, "\\$&")}"]`;
    })
    .join("");
}

// Quoted segments accept only `\"` and `\\` escapes.
const pathToken = /\.?([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]|\[("(?:[^"\\]|\\["\\])*")\]/y;

/** Parses the `formatConfigPath` syntax. */
export function parseConfigPath(text: string): ResultType<ConfigPath, ConfigDocumentInvalid> {
  const segments: ConfigPathSegment[] = [];
  pathToken.lastIndex = 0;
  while (pathToken.lastIndex < text.length) {
    const start = pathToken.lastIndex;
    const match = pathToken.exec(text);
    if (!match || (start === 0 && match[0].startsWith("."))) break;
    const [, name, index, quoted] = match;
    if (name !== undefined) segments.push(name);
    else if (index !== undefined) segments.push(Number(index));
    else if (quoted !== undefined) segments.push(quoted.slice(1, -1).replace(/\\(["\\])/gu, "$1"));
  }
  if (pathToken.lastIndex !== text.length || (text.length > 0 && segments.length === 0))
    return Result.err(invalid(`Invalid configuration path: ${text}`));
  return Result.ok(segments);
}

/**
 * The 1-based line of the deepest existing key on `path`, or `undefined` when the file has none
 * of it.
 */
export function configLineAtPath(text: string, path: ConfigPath): number | undefined {
  const parsed = parseDocument(text);
  for (let length = path.length; length > 0; length -= 1) {
    const node = parsed.getIn(path.slice(0, length), true);
    if (!isScalar(node) && !isCollection(node)) continue;
    if (!node.range) continue;
    const line = text.slice(0, node.range[0]).split("\n").length;
    // A block collection starts on the line after its key.
    return isCollection(node) && !node.flow ? Math.max(1, line - 1) : line;
  }
  return undefined;
}

/** YAML text for one value, as the form shows a subtree; empty for `undefined`. */
export function formatConfigYamlValue(value: ConfigValue | undefined): string {
  if (value === undefined) return "";
  return stringify(value, { lineWidth: 0 });
}
