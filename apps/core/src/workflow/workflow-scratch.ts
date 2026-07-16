import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { sha256 } from "./workflow-definition";
import {
  assertWorkflowPathAllowed,
  workflowDeniedRootPolicyForScratch,
} from "./workflow-denied-root-policy";
import { openPinnedWorkflowRoot, workflowDescriptorPath } from "./workflow-descriptor-path";

const SCRATCH_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const WORKFLOW_SCRATCH_MOUNT = "/run/lilac/scratch";

export function workflowRunScratchPath(dataDir: string, runId: string): string {
  return path.join(
    path.resolve(dataDir),
    "workflow-runtime",
    "scratch",
    sha256(runId).slice(0, 48),
  );
}

export async function ensureWorkflowRunScratch(input: {
  dataDir: string;
  runId: string;
}): Promise<string> {
  const scratchRoot = workflowRunScratchPath(input.dataDir, input.runId);
  const dataDir = path.resolve(input.dataDir);
  let parentHandle = await openPinnedWorkflowRoot(dataDir, "Workflow DATA_DIR");
  try {
    for (const segment of ["workflow-runtime", "scratch", path.basename(scratchRoot)]) {
      const candidate = `${workflowDescriptorPath(parentHandle)}/${segment}`;
      await fs.mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
      const childHandle = await fs.open(
        candidate,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (!(await childHandle.stat()).isDirectory()) {
        await childHandle.close();
        throw new Error("Workflow scratch path must not traverse symbolic links");
      }
      await parentHandle.close();
      parentHandle = childHandle;
    }
  } finally {
    await parentHandle.close();
  }
  return scratchRoot;
}

export async function assertExistingWorkflowScratch(scratchRoot: string): Promise<string> {
  const resolved = path.resolve(scratchRoot);
  const handle = await openPinnedWorkflowRoot(resolved, "Workflow family scratch root");
  await handle.close();
  assertWorkflowPathAllowed({
    policy: workflowDeniedRootPolicyForScratch(resolved),
    candidate: resolved,
    scratchRoot: resolved,
    label: "Workflow family scratch root",
  });
  return resolved;
}

function assertFlatScratchFilename(requestedPath: string): void {
  if (
    requestedPath.includes("\0") ||
    requestedPath === "." ||
    requestedPath === ".." ||
    requestedPath.includes("/") ||
    requestedPath.includes("\\") ||
    path.isAbsolute(requestedPath)
  ) {
    throw new Error(
      "Workflow scratch uses flat filenames only; path separators, traversal, and NUL are denied",
    );
  }
}

async function openScratchRoot(scratchRoot: string) {
  return await openPinnedWorkflowRoot(scratchRoot, "Workflow scratch root");
}

function assertScratchFileAllowed(scratchRoot: string, requestedPath: string): void {
  assertFlatScratchFilename(requestedPath);
  const candidate = path.join(scratchRoot, requestedPath);
  assertWorkflowPathAllowed({
    policy: workflowDeniedRootPolicyForScratch(scratchRoot),
    candidate,
    scratchRoot,
    label: "Workflow scratch path",
  });
}

export function workflowScratchTools(scratchRoot: string) {
  return {
    scratch_read: tool({
      description: "Read a UTF-8 file from this workflow run's shared scratch directory.",
      inputSchema: z.strictObject({ path: z.string().min(1).max(4_096) }),
      outputSchema: z.strictObject({ path: z.string(), content: z.string() }),
      execute: async ({ path: requestedPath }) => {
        assertScratchFileAllowed(scratchRoot, requestedPath);
        const rootHandle = await openScratchRoot(scratchRoot);
        try {
          const handle = await fs.open(
            `${workflowDescriptorPath(rootHandle)}/${requestedPath}`,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          const opened = await handle.stat();
          try {
            if (!opened.isFile() || opened.nlink > 1 || opened.size > SCRATCH_FILE_MAX_BYTES) {
              throw new Error("Workflow scratch reads require a bounded regular non-linked file");
            }
            return { path: requestedPath, content: await handle.readFile("utf8") };
          } finally {
            await handle.close();
          }
        } finally {
          await rootHandle.close();
        }
      },
    }),
    scratch_write: tool({
      description: "Write a UTF-8 file into this workflow run's shared scratch directory.",
      inputSchema: z.strictObject({
        path: z.string().min(1).max(4_096),
        content: z.string().max(SCRATCH_FILE_MAX_BYTES),
      }),
      outputSchema: z.strictObject({ path: z.string(), bytes: z.number().int().nonnegative() }),
      execute: async ({ path: requestedPath, content }) => {
        assertScratchFileAllowed(scratchRoot, requestedPath);
        const rootHandle = await openScratchRoot(scratchRoot);
        try {
          const handle = await fs.open(
            `${workflowDescriptorPath(rootHandle)}/${requestedPath}`,
            constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink > 1) {
              throw new Error("Workflow scratch writes require a regular non-linked file");
            }
            await handle.truncate(0);
            await handle.writeFile(content, "utf8");
          } finally {
            await handle.close();
          }
        } finally {
          await rootHandle.close();
        }
        return { path: requestedPath, bytes: Buffer.byteLength(content, "utf8") };
      },
    }),
  };
}
