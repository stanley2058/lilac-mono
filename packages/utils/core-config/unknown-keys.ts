import { isRecord } from "../runtime-utils";

import type { CoreConfigKeyPath } from "./types";

function aliasedTargetKey(path: CoreConfigKeyPath, sourceKey: string): string | undefined {
  if (path.length === 2 && path[0] === "tools" && path[1] === "web" && sourceKey === "search") {
    return "extract";
  }

  if (
    path.length === 3 &&
    path[0] === "tools" &&
    path[1] === "web" &&
    (path[2] === "extract" || path[2] === "search") &&
    sourceKey === "provider"
  ) {
    return "providers";
  }

  return undefined;
}

function collectUnknownConfigKeyPathsInto(
  source: unknown,
  target: unknown,
  path: CoreConfigKeyPath,
  unknownPaths: CoreConfigKeyPath[],
): void {
  if (Array.isArray(source) && Array.isArray(target)) {
    const commonLength = Math.min(source.length, target.length);
    for (let index = 0; index < commonLength; index += 1) {
      collectUnknownConfigKeyPathsInto(
        source[index],
        target[index],
        [...path, index],
        unknownPaths,
      );
    }
    return;
  }

  if (!isRecord(source) || !isRecord(target)) return;

  for (const sourceKey of Object.keys(source)) {
    const targetKey = Object.hasOwn(target, sourceKey)
      ? sourceKey
      : aliasedTargetKey(path, sourceKey);
    const sourcePath = [...path, sourceKey];

    if (targetKey === undefined || !Object.hasOwn(target, targetKey)) {
      unknownPaths.push(sourcePath);
      continue;
    }

    collectUnknownConfigKeyPathsInto(
      source[sourceKey],
      target[targetKey],
      sourcePath,
      unknownPaths,
    );
  }
}

export function collectUnknownConfigKeyPaths(
  source: unknown,
  target: unknown,
): CoreConfigKeyPath[] {
  const unknownPaths: CoreConfigKeyPath[] = [];
  collectUnknownConfigKeyPathsInto(source, target, [], unknownPaths);
  return unknownPaths;
}

export function formatCoreConfigKeyPath(path: CoreConfigKeyPath): string {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }

    if (/^[A-Za-z_$][\w$]*$/u.test(segment)) {
      formatted += formatted.length === 0 ? segment : `.${segment}`;
      continue;
    }

    formatted += `[${JSON.stringify(segment)}]`;
  }
  return formatted;
}
