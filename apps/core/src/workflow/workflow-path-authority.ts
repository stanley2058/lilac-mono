import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { isWorkflowProtectedPath } from "./workflow-protected-path";

type WorkflowPathPolicy = { canonicalCwd: string };

const contentInspectPathSchema = z.object({ path: z.string().min(1).optional() }).passthrough();
const surfaceSendPathsSchema = z
  .object({
    paths: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)]).optional(),
    filenames: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)]).optional(),
  })
  .passthrough();

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertNonSecretWorkspacePath(root: string, candidate: string): void {
  if (isWorkflowProtectedPath(root, candidate)) {
    throw new Error("Workflow external tools cannot read protected workspace files");
  }
}

async function openContainedFile(
  requestedPath: string,
  policy: WorkflowPathPolicy,
): Promise<{ handle: FileHandle; descriptorPath: string }> {
  const root = policy.canonicalCwd;
  const lexical = path.resolve(root, requestedPath);
  if (!isContained(root, lexical)) throw new Error("Workflow tool path escaped the approved cwd");
  assertNonSecretWorkspacePath(root, lexical);

  const canonical = await fs.realpath(lexical);
  if (canonical !== lexical || !isContained(root, canonical)) {
    throw new Error("Workflow tool paths must not contain symbolic links");
  }
  const before = await fs.lstat(canonical);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
    throw new Error("Workflow tool path must identify a regular non-symlink file");
  }

  const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const after = await fs.realpath(lexical);
    if (
      after !== canonical ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink > 1 ||
      !opened.isFile()
    ) {
      throw new Error("Workflow tool path changed during authorization");
    }
    return { handle, descriptorPath: `/proc/self/fd/${handle.fd}` };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function authorizeWorkflowPathInput(input: {
  callableId: string;
  value: Record<string, unknown>;
  policy: WorkflowPathPolicy;
}): Promise<{ value: Record<string, unknown>; close(): Promise<void> }> {
  const opened: FileHandle[] = [];
  try {
    if (input.callableId === "content.inspect") {
      const parsed = contentInspectPathSchema.parse(input.value);
      if (!parsed.path) return { value: input.value, close: async () => {} };
      const file = await openContainedFile(parsed.path, input.policy);
      opened.push(file.handle);
      return {
        value: { ...input.value, path: file.descriptorPath },
        close: async () =>
          await Promise.all(opened.map(async (handle) => await handle.close())).then(() => {}),
      };
    }

    if (input.callableId === "surface.messages.send") {
      const parsed = surfaceSendPathsSchema.parse(input.value);
      const paths =
        parsed.paths === undefined
          ? []
          : Array.isArray(parsed.paths)
            ? parsed.paths
            : [parsed.paths];
      if (paths.length === 0) return { value: input.value, close: async () => {} };
      const files = [];
      for (const requested of paths) {
        const file = await openContainedFile(requested, input.policy);
        opened.push(file.handle);
        files.push(file.descriptorPath);
      }
      const filenames =
        parsed.filenames === undefined
          ? paths.map((requested) => path.basename(requested))
          : parsed.filenames;
      return {
        value: { ...input.value, paths: files, filenames },
        close: async () =>
          await Promise.all(opened.map(async (handle) => await handle.close())).then(() => {}),
      };
    }

    return { value: input.value, close: async () => {} };
  } catch (error) {
    await Promise.all(opened.map(async (handle) => await handle.close().catch(() => undefined)));
    throw error;
  }
}
