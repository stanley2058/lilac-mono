import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyOpenAIApplyPatchDiff } from "./openai-apply-diff";

export type OpenAIApplyPatchOperation =
  | {
      type: "create_file";
      path: string;
      diff: string;
    }
  | {
      type: "update_file";
      path: string;
      diff: string;
    }
  | {
      type: "delete_file";
      path: string;
    };

export type OpenAIApplyPatchInput = {
  callId: string;
  operation: OpenAIApplyPatchOperation;
};

export type OpenAIApplyPatchOutput = {
  status: "completed" | "failed";
  output?: string;
};

function resolvePath(baseDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

export function createOpenAIApplyPatchExecutor(baseDir: string) {
  return async ({ callId, operation }: OpenAIApplyPatchInput): Promise<OpenAIApplyPatchOutput> => {
    try {
      const targetPath = resolvePath(baseDir, operation.path);

      switch (operation.type) {
        case "create_file": {
          await mkdir(path.dirname(targetPath), { recursive: true });
          const content = applyOpenAIApplyPatchDiff("", operation.diff, "create");
          await writeFile(targetPath, content, "utf-8");
          return {
            status: "completed",
            output: `[${callId}] created ${operation.path}`,
          };
        }

        case "update_file": {
          const original = await readFile(targetPath, "utf-8").catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Cannot update missing file '${operation.path}': ${msg}`);
          });

          const patched = applyOpenAIApplyPatchDiff(original, operation.diff);
          await writeFile(targetPath, patched, "utf-8");
          return {
            status: "completed",
            output: `[${callId}] updated ${operation.path}`,
          };
        }

        case "delete_file": {
          // Best-effort delete. We intentionally do not allow recursive directory deletes.
          const s = await stat(targetPath).catch(() => null);
          if (s?.isDirectory()) {
            throw new Error(`Refusing to delete directory: ${operation.path}`);
          }
          await rm(targetPath, { force: true });
          return {
            status: "completed",
            output: `[${callId}] deleted ${operation.path}`,
          };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: "failed", output: msg };
    }
  };
}
