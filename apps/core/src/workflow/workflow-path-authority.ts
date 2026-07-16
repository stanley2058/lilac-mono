import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ServerToolWorkflowPathAuthority } from "@stanley2058/lilac-plugin-runtime";
import { z } from "zod";

import { isWorkflowProtectedPath } from "./workflow-protected-path";

type WorkflowPathPolicy = { canonicalCwd: string };

const workflowPathInputSchema = z.strictObject({
  field: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(200)).max(16).optional(),
  cardinality: z.enum(["one", "many"]),
  target: z.enum(["read-file", "write-directory", "write-file"]),
  default: z.literal("cwd").optional(),
});

const workflowPathAuthoritySchema = z.strictObject({
  inputs: z.array(workflowPathInputSchema).max(64),
});

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertUnprotected(root: string, candidate: string): void {
  if (isWorkflowProtectedPath(root, candidate)) {
    throw new Error("Workflow Level-2 tools cannot access protected workspace paths");
  }
}

async function canonicalContainedPath(input: {
  requestedPath: string;
  policy: WorkflowPathPolicy;
  kind: "file" | "directory";
}): Promise<{ lexical: string; stats: Awaited<ReturnType<typeof fs.lstat>> }> {
  const root = input.policy.canonicalCwd;
  const lexical = path.resolve(root, input.requestedPath);
  if (!isContained(root, lexical)) throw new Error("Workflow tool path escaped the approved cwd");
  assertUnprotected(root, lexical);

  const canonical = await fs.realpath(lexical);
  const stats = await fs.lstat(lexical);
  if (
    canonical !== lexical ||
    stats.isSymbolicLink() ||
    (input.kind === "file" ? !stats.isFile() : !stats.isDirectory())
  ) {
    throw new Error(`Workflow tool path must identify a canonical ${input.kind}`);
  }
  if (input.kind === "file" && stats.nlink > 1) {
    throw new Error("Workflow tool path must not identify a hard-linked file");
  }
  return { lexical, stats };
}

async function openReadFile(
  requestedPath: string,
  policy: WorkflowPathPolicy,
): Promise<{ handle: FileHandle; descriptorPath: string; logicalPath: string }> {
  const authorized = await canonicalContainedPath({ requestedPath, policy, kind: "file" });
  const handle = await fs.open(authorized.lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== authorized.stats.dev ||
      opened.ino !== authorized.stats.ino ||
      opened.nlink > 1 ||
      !opened.isFile()
    ) {
      throw new Error("Workflow tool path changed during authorization");
    }
    return {
      handle,
      descriptorPath: `/proc/self/fd/${handle.fd}`,
      logicalPath: authorized.lexical,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openWriteDirectory(
  requestedPath: string,
  policy: WorkflowPathPolicy,
): Promise<{ handle: FileHandle; descriptorPath: string; logicalPath: string }> {
  const authorized = await canonicalContainedPath({ requestedPath, policy, kind: "directory" });
  const handle = await fs.open(
    authorized.lexical,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== authorized.stats.dev ||
      opened.ino !== authorized.stats.ino ||
      !opened.isDirectory()
    ) {
      throw new Error("Workflow output directory changed during authorization");
    }
    return {
      handle,
      descriptorPath: `/proc/self/fd/${handle.fd}`,
      logicalPath: authorized.lexical,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openWriteFile(
  requestedPath: string,
  policy: WorkflowPathPolicy,
): Promise<{ handle: FileHandle; descriptorPath: string; logicalPath: string }> {
  const root = policy.canonicalCwd;
  const lexical = path.resolve(root, requestedPath);
  if (!isContained(root, lexical) || lexical === root) {
    throw new Error("Workflow output file escaped the approved cwd");
  }
  assertUnprotected(root, lexical);
  await canonicalContainedPath({
    requestedPath: path.dirname(lexical),
    policy,
    kind: "directory",
  });
  const existing = await fs.lstat(lexical).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) {
    throw new Error("Workflow output path must be absent or a regular non-linked file");
  }
  const handle = await fs.open(
    lexical,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino))
    ) {
      throw new Error("Workflow output path changed during authorization");
    }
    return { handle, descriptorPath: `/proc/self/fd/${handle.fd}`, logicalPath: lexical };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function pathLikeKey(key: string): boolean {
  const normalized = key.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
  if (["filename", "filenames", "filehash"].includes(normalized)) return false;
  return (
    ["cwd", "dir", "directory", "file", "files", "path", "paths"].includes(normalized) ||
    normalized.endsWith("dir") ||
    normalized.endsWith("directory") ||
    normalized.endsWith("file") ||
    normalized.endsWith("files") ||
    normalized.endsWith("path") ||
    normalized.endsWith("paths") ||
    normalized.endsWith("image") ||
    normalized.endsWith("images")
  );
}

function looksLikeExplicitLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.startsWith("file:")
  );
}

function permitsPathLikeText(key: string | undefined): boolean {
  if (!key) return false;
  const normalized = key.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return ["base64", "content", "prompt", "query", "text"].includes(normalized);
}

function findUndeclaredPathInput(
  value: unknown,
  declaredTopLevelFields: ReadonlySet<string>,
  pathParts: readonly string[] = [],
): string | null {
  if (typeof value === "string") {
    return looksLikeExplicitLocalPath(value) && !permitsPathLikeText(pathParts.at(-1))
      ? pathParts.join(".") || "<value>"
      : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUndeclaredPathInput(value[index], declaredTopLevelFields, [
        ...pathParts,
        String(index),
      ]);
      if (found) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const topLevelDeclared = pathParts.length === 0 && declaredTopLevelFields.has(key);
    if (topLevelDeclared) continue;
    if (pathLikeKey(key)) return [...pathParts, key].join(".");
    const found = findUndeclaredPathInput(child, declaredTopLevelFields, [...pathParts, key]);
    if (found) return found;
  }
  return null;
}

function pathValues(value: unknown, cardinality: "one" | "many"): string[] {
  if (cardinality === "one") return [z.string().min(1).parse(value)];
  return z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(64)])
    .transform((paths) => (Array.isArray(paths) ? paths : [paths]))
    .parse(value);
}

export async function authorizeWorkflowPathInput(input: {
  callableId: string;
  value: Record<string, unknown>;
  policy: WorkflowPathPolicy;
  authority: ServerToolWorkflowPathAuthority | undefined;
}): Promise<{
  value: Record<string, unknown>;
  restoreOutput(value: unknown): unknown;
  close(): Promise<void>;
}> {
  const authority = input.authority
    ? workflowPathAuthoritySchema.parse(input.authority)
    : { inputs: [] };
  const declaredFields = new Set<string>();
  for (const descriptor of authority.inputs) {
    for (const field of [descriptor.field, ...(descriptor.aliases ?? [])]) {
      if (declaredFields.has(field)) {
        throw new Error(`Workflow path authority declares duplicate field: ${field}`);
      }
      declaredFields.add(field);
    }
  }
  const undeclared = findUndeclaredPathInput(input.value, declaredFields);
  if (undeclared) {
    throw new Error(
      `Workflow callable '${input.callableId}' has undeclared local path input: ${undeclared}`,
    );
  }

  const opened: FileHandle[] = [];
  const outputPathReplacements: Array<{ descriptorPath: string; logicalPath: string }> = [];
  const authorizedValue = { ...input.value };
  try {
    for (const descriptor of authority.inputs) {
      const suppliedFields = [descriptor.field, ...(descriptor.aliases ?? [])].filter(
        (field) => input.value[field] !== undefined,
      );
      if (suppliedFields.length > 1) {
        throw new Error(
          `Workflow path input has conflicting aliases: ${suppliedFields.join(", ")}`,
        );
      }
      const suppliedField = suppliedFields[0];
      const field = suppliedField ?? descriptor.field;
      const rawValue = suppliedField
        ? input.value[suppliedField]
        : descriptor.default === "cwd"
          ? input.policy.canonicalCwd
          : undefined;
      if (rawValue === undefined) continue;
      const values = pathValues(rawValue, descriptor.cardinality);
      const rewritten: string[] = [];
      for (const requestedPath of values) {
        const authorized =
          descriptor.target === "read-file"
            ? await openReadFile(requestedPath, input.policy)
            : descriptor.target === "write-directory"
              ? await openWriteDirectory(requestedPath, input.policy)
              : await openWriteFile(requestedPath, input.policy);
        opened.push(authorized.handle);
        outputPathReplacements.push({
          descriptorPath: authorized.descriptorPath,
          logicalPath: authorized.logicalPath,
        });
        rewritten.push(authorized.descriptorPath);
      }
      authorizedValue[field] = descriptor.cardinality === "one" ? rewritten[0] : rewritten;
    }
    return {
      value: authorizedValue,
      restoreOutput: (value) => {
        if (outputPathReplacements.length === 0) return value;
        const restore = (candidate: unknown): unknown => {
          if (typeof candidate === "string") {
            for (const replacement of outputPathReplacements) {
              if (candidate === replacement.descriptorPath) return replacement.logicalPath;
              if (candidate.startsWith(`${replacement.descriptorPath}${path.sep}`)) {
                return `${replacement.logicalPath}${candidate.slice(replacement.descriptorPath.length)}`;
              }
            }
            return candidate;
          }
          if (Array.isArray(candidate)) return candidate.map(restore);
          if (candidate === null || typeof candidate !== "object") return candidate;
          return Object.fromEntries(
            Object.entries(candidate).map(([key, child]) => [key, restore(child)]),
          );
        };
        return restore(value);
      },
      close: async () => {
        await Promise.all(opened.map(async (handle) => await handle.close()));
      },
    };
  } catch (error) {
    await Promise.all(opened.map(async (handle) => await handle.close().catch(() => undefined)));
    throw error;
  }
}
