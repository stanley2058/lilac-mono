import { constants, type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export type WorkflowDescriptorKind = "directory" | "file" | "file-or-directory";

export const workflowPathIdentitySchema = z.strictObject({
  dev: z.string().regex(/^\d+$/u),
  ino: z.string().regex(/^\d+$/u),
});

export type WorkflowPathIdentity = z.infer<typeof workflowPathIdentitySchema>;

export function workflowPathIdentity(
  stats: Pick<BigIntStats, "dev" | "ino">,
): WorkflowPathIdentity {
  return { dev: stats.dev.toString(10), ino: stats.ino.toString(10) };
}

export async function readWorkflowPathIdentity(candidate: string): Promise<WorkflowPathIdentity> {
  return workflowPathIdentity(await fs.stat(candidate, { bigint: true }));
}

export async function assertWorkflowPathIdentity(input: {
  candidate: string;
  expected: WorkflowPathIdentity;
  label: string;
}): Promise<void> {
  const actual = await readWorkflowPathIdentity(input.candidate);
  if (actual.dev !== input.expected.dev || actual.ino !== input.expected.ino) {
    throw new Error(`${input.label} no longer names its authorized inode`);
  }
}

export function workflowDescriptorPath(handle: FileHandle): string {
  return `/proc/${process.pid}/fd/${handle.fd}`;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertKind(stats: Stats, kind: WorkflowDescriptorKind, label: string): void {
  const valid =
    kind === "file"
      ? stats.isFile()
      : kind === "directory"
        ? stats.isDirectory()
        : stats.isFile() || stats.isDirectory();
  if (!valid) throw new Error(`${label} must identify a regular ${kind.replace("-or-", " or ")}`);
}

export async function openPinnedWorkflowRoot(
  root: string,
  label: string,
  expected?: WorkflowPathIdentity,
): Promise<FileHandle> {
  const logicalRoot = path.resolve(root);
  const before = await fs.lstat(logicalRoot);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    (await fs.realpath(logicalRoot)) !== logicalRoot
  ) {
    throw new Error(`${label} must be a canonical real directory`);
  }
  const segments = logicalRoot.split(path.sep).filter(Boolean);
  let handle = await fs.open(
    path.parse(logicalRoot).root,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    for (const segment of segments) {
      const next = await fs.open(
        `${workflowDescriptorPath(handle)}/${segment}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const previous = handle;
      handle = next;
      await previous.close();
    }
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isDirectory()) {
      throw new Error(`${label} changed during authorization`);
    }
    if (expected) {
      const precise = workflowPathIdentity(await handle.stat({ bigint: true }));
      if (precise.dev !== expected.dev || precise.ino !== expected.ino) {
        throw new Error(`${label} no longer names its authorized inode`);
      }
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function openWorkflowPathFromRoot(input: {
  root: string;
  rootHandle: FileHandle;
  candidate: string;
  kind: WorkflowDescriptorKind;
  flags?: number;
  mode?: number;
  rejectHardLinks?: boolean;
  expected?: Pick<Stats, "dev" | "ino">;
  label: string;
}): Promise<{ handle: FileHandle; stats: Stats }> {
  const root = path.resolve(input.root);
  const candidate = path.resolve(input.candidate);
  if (!isContained(root, candidate)) {
    throw new Error(`${input.label} escaped the authoritative root`);
  }
  const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let parent = input.rootHandle;
  let ownedParent: FileHandle | null = null;
  try {
    for (let index = 0; index < segments.length - 1; index += 1) {
      const next = await fs.open(
        `${workflowDescriptorPath(parent)}/${segments[index]}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const stats = await next.stat();
      if (!stats.isDirectory()) {
        await next.close();
        throw new Error(`${input.label} intermediate component is not a directory`);
      }
      await ownedParent?.close();
      ownedParent = next;
      parent = next;
    }

    const source =
      segments.length === 0
        ? workflowDescriptorPath(input.rootHandle)
        : `${workflowDescriptorPath(parent)}/${segments.at(-1)}`;
    const handle = await fs.open(
      source,
      (input.flags ?? constants.O_RDONLY) | (segments.length === 0 ? 0 : constants.O_NOFOLLOW),
      input.mode,
    );
    try {
      const stats = await handle.stat();
      assertKind(stats, input.kind, input.label);
      if (input.rejectHardLinks && stats.isFile() && stats.nlink > 1) {
        throw new Error(`${input.label} must not identify a hard-linked file`);
      }
      if (
        input.expected &&
        (stats.dev !== input.expected.dev || stats.ino !== input.expected.ino)
      ) {
        throw new Error(`${input.label} changed during authorization`);
      }
      return { handle, stats };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ELOOP", "ENOTDIR"].includes(String(error.code))
    ) {
      throw new Error(`${input.label} must not traverse symbolic links`, { cause: error });
    }
    throw error;
  } finally {
    await ownedParent?.close();
  }
}
