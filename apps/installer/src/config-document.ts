import fs from "node:fs/promises";

import { Result, TaggedError, type Result as ResultType } from "better-result";
import { isAlias, isMap, isScalar, parseDocument, type Document } from "yaml";

import { parseCoreConfigResult } from "@stanley2058/lilac-utils/core-config/parse";
import { jsonValueSchema } from "@stanley2058/lilac-utils/core-config/v1";
import type { CoreConfig, JSONValue } from "@stanley2058/lilac-utils/core-config/types";

export type ConfigDocument = Document.Parsed;
export type ConfigPath = readonly (string | number)[];

export class InstallerConfigInvalid extends TaggedError("InstallerConfigInvalid")<{
  readonly message: string;
}> {}

export class InstallerConfigIoFailed extends TaggedError("InstallerConfigIoFailed")<{
  readonly operation: "read";
  readonly message: string;
}> {}

export function createConfigDocument(): ConfigDocument {
  return parseDocument("configVersion: 2\n", { merge: true });
}

export function validateConfigDocument(
  document: ConfigDocument,
): ResultType<CoreConfig, InstallerConfigInvalid> {
  if (document.errors.length > 0) {
    return Result.err(
      new InstallerConfigInvalid({ message: "Configuration contains invalid YAML." }),
    );
  }
  if (!isMap(document.contents)) {
    return Result.err(
      new InstallerConfigInvalid({ message: "Configuration must be a YAML mapping." }),
    );
  }
  return Result.gen(function* () {
    const source = yield* Result.try({
      try: (): unknown => document.toJS({ maxAliasCount: 100 }),
      catch: () =>
        new InstallerConfigInvalid({ message: "Configuration contains invalid YAML aliases." }),
    });
    return parseCoreConfigResult(source).mapError(
      (failure) => new InstallerConfigInvalid({ message: failure.message }),
    );
  });
}

export function parseConfigDocument(
  source: string,
): ResultType<ConfigDocument, InstallerConfigInvalid> {
  const document = parseDocument(source, { prettyErrors: false, merge: true });
  return validateConfigDocument(document).map(() => document);
}

export async function readConfigDocument(
  filePath: string,
): Promise<
  ResultType<
    { document: ConfigDocument; exists: boolean },
    InstallerConfigInvalid | InstallerConfigIoFailed
  >
> {
  const captured = await Result.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: (cause) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
        return { kind: "missing" as const };
      }
      return { kind: "failed" as const };
    },
  });
  const source = captured.match<
    { kind: "found"; text: string } | { kind: "missing" } | { kind: "failed" }
  >({
    ok: (text) => ({ kind: "found", text }),
    err: (failure) => failure,
  });
  if (source.kind === "missing") {
    return Result.ok({ document: createConfigDocument(), exists: false });
  }
  if (source.kind === "failed") {
    return Result.err(
      new InstallerConfigIoFailed({
        operation: "read",
        message: "Could not read the existing configuration. Check file permissions.",
      }),
    );
  }
  return parseConfigDocument(source.text).map((document) => ({ document, exists: true }));
}

export function getConfigValue(
  document: ConfigDocument,
  keyPath: ConfigPath,
): JSONValue | undefined {
  const parsed = jsonValueSchema.safeParse(document.toJS({ maxAliasCount: 100 }));
  if (!parsed.success) return undefined;
  let value: JSONValue | undefined = parsed.data;
  for (const segment of keyPath) {
    if (value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      if (typeof segment !== "number") return undefined;
      value = value[segment];
      continue;
    }
    value = value[String(segment)];
  }
  return value;
}

function expandAliasAncestors(document: ConfigDocument, keyPath: ConfigPath): void {
  for (let length = 1; length < keyPath.length; length += 1) {
    const prefix = keyPath.slice(0, length);
    const node = document.getIn(prefix, true);
    if (!isAlias(node)) continue;
    const replacement = node.resolve(document)?.clone();
    if (!replacement) continue;
    if ("anchor" in replacement) replacement.anchor = undefined;
    replacement.comment = node.comment ?? replacement.comment;
    replacement.commentBefore = node.commentBefore ?? replacement.commentBefore;
    document.setIn(prefix, replacement);
  }
}

export function setConfigValue(
  document: ConfigDocument,
  keyPath: ConfigPath,
  value: JSONValue,
): void {
  expandAliasAncestors(document, keyPath);
  document.setIn(keyPath, value);
}

function expandMergedParent(document: ConfigDocument, keyPath: ConfigPath): void {
  const parentPath = keyPath.slice(0, -1);
  const parent = document.getIn(parentPath, true);
  if (!isMap(parent)) return;
  const hasMerge = parent.items.some(
    (pair) => isScalar(pair.key) && typeof pair.key.value === "symbol",
  );
  if (!hasMerge) return;
  const resolved = getConfigValue(document, parentPath);
  if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) return;
  const replacement = parent.clone();
  if (!isMap(replacement)) return;
  replacement.items = replacement.items.filter(
    (pair) => !(isScalar(pair.key) && typeof pair.key.value === "symbol"),
  );
  for (const [key, value] of Object.entries(resolved)) {
    if (replacement.has(key)) continue;
    replacement.set(key, value);
  }
  document.setIn(parentPath, replacement);
}

export function deleteConfigValue(document: ConfigDocument, keyPath: ConfigPath): void {
  expandAliasAncestors(document, keyPath);
  expandMergedParent(document, keyPath);
  document.deleteIn(keyPath);
}

export function serializeConfigDocument(document: ConfigDocument): string {
  return document.toString({ lineWidth: 0 });
}
