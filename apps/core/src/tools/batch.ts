import path from "node:path";

import {
  collectApplyPatchTouchedPaths as collectSharedApplyPatchTouchedPaths,
  collectEditFileTouchedPaths as collectSharedEditFileTouchedPaths,
  createBatchTool,
} from "@stanley2058/lilac-coding-tools/batch";
import { expandTilde } from "@stanley2058/lilac-fs";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";
import type { EditingToolMode } from "@stanley2058/lilac-utils";
import type { ToolSet } from "ai";

import { parseSshCwdTarget } from "../ssh/ssh-cwd";
import {
  formatBatchChildValidationError,
  formatBatchPreflightMissingFieldError,
} from "./batch-error-message";

function normalizeRemotePath(base: string, targetPath: string): string {
  const input = targetPath.trim();
  if (input.length === 0) return base;
  if (input.startsWith("/")) return path.posix.normalize(input);
  if (input === "~") return "~";
  if (input.startsWith("~/")) {
    const normalized = path.posix.normalize(input.slice(2));
    return normalized === "." ? "~" : `~/${normalized.replace(/^\.\//, "")}`;
  }
  if (base.startsWith("/")) return path.posix.normalize(path.posix.resolve(base, input));

  const segments =
    base === "~"
      ? []
      : (base.startsWith("~/") ? base.slice(2) : base)
          .split("/")
          .filter((segment) => segment.length > 0);
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.length === 0 ? "~" : `~/${segments.join("/")}`;
}

function resolveTouchedPathKey(cwd: string, targetPath: string): string {
  const target = parseSshCwdTarget(cwd);
  if (target.kind === "local") {
    const base = path.resolve(expandTilde(cwd));
    const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(base, targetPath);
    return `file://${path.resolve(resolved)}`;
  }

  const resolved = normalizeRemotePath(target.cwd, targetPath);
  return `ssh://${target.host}${resolved.startsWith("/") ? resolved : `/${resolved}`}`;
}

export function collectApplyPatchTouchedPaths(params: {
  patchText: string;
  cwd: string;
}): Set<string> {
  return collectSharedApplyPatchTouchedPaths({
    ...params,
    resolvePathKey: resolveTouchedPathKey,
  });
}

export function collectEditFileTouchedPaths(params: { path: string; cwd: string }): Set<string> {
  return collectSharedEditFileTouchedPaths({
    ...params,
    resolvePathKey: resolveTouchedPathKey,
  });
}

export function batchTool(params: {
  defaultCwd: string;
  getTools: () => ToolSet;
  getToolSpecs?: () => ReadonlyMap<string, Level1ToolSpec<unknown>>;
  editingMode?: EditingToolMode | "none";
  maxCalls?: number;
}) {
  return createBatchTool({
    cwd: params.defaultCwd,
    getTools: params.getTools,
    getToolSpecs: params.getToolSpecs,
    editingMode: params.editingMode,
    maxCalls: params.maxCalls,
    resolvePathKey: resolveTouchedPathKey,
    errorFormatters: {
      childValidation: formatBatchChildValidationError,
      missingEditField: formatBatchPreflightMissingFieldError,
    },
  });
}
