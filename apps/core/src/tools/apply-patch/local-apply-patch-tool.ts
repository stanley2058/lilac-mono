import { tool } from "ai";
import { z } from "zod";
import { createLogger } from "@stanley2058/lilac-utils";
import { applyPatchInputSchema } from "@stanley2058/lilac-coding-tools/schemas";

import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import { applyHunks, parsePatch } from "./apply-patch-core";
import { remoteApplyPatch } from "./remote-apply-patch";

const REMOTE_DENY_RELATIVE_DIRS = [".ssh", ".aws", ".gnupg"] as const;

function normalizeRelativePatchPath(p: string): string {
  let s = p.trim();
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

function isDeniedRemotePatchPath(remoteCwd: string, patchPath: string): boolean {
  // The remote denylist is intended to protect home-scoped secrets.
  // We only enforce a simple relative-path restriction when the remote cwd is ~.
  if (remoteCwd !== "~") return false;
  const s = normalizeRelativePatchPath(patchPath);
  for (const dir of REMOTE_DENY_RELATIVE_DIRS) {
    if (s === dir) return true;
    if (s.startsWith(`${dir}/`)) return true;
  }
  return false;
}

const outputSchema = z.object({
  status: z.enum(["completed", "failed"]),
  output: z.string().optional(),
});

type PatchInput = z.infer<typeof applyPatchInputSchema>;

type ToolContext = {
  requestId: string;
  sessionId: string;
  requestClient: string;
};

export { parsePatch };

export function localApplyPatchTool(
  defaultCwd: string,
  options?: { denyPaths?: readonly string[] },
) {
  const logger = createLogger({
    module: "tool:apply_patch",
  });

  return {
    apply_patch: tool({
      description:
        "Apply a patch in '*** Begin Patch' format (*** Add/Update/Delete File, optional *** Move to:, @@ context blocks). Remote denylisted paths require dangerouslyAllow=true.",
      inputSchema: applyPatchInputSchema,
      outputSchema,
      execute: async (input: PatchInput, { context }: { context?: unknown }) => {
        const ctx =
          context && typeof context === "object" ? (context as Partial<ToolContext>) : undefined;
        try {
          const cwd = input.cwd ?? defaultCwd;
          const cwdTarget = parseSshCwdTarget(cwd);
          const hunks = parsePatch(input.patchText);

          logger.info("apply_patch start", {
            requestId: ctx?.requestId,
            sessionId: ctx?.sessionId,
            requestClient: ctx?.requestClient,
            cwd,
            dangerouslyAllow: input.dangerouslyAllow === true,
            hunkCount: hunks.length,
            added: hunks.filter((h) => h.type === "add").length,
            deleted: hunks.filter((h) => h.type === "delete").length,
            updated: hunks.filter((h) => h.type === "update").length,
            paths: hunks.map((h) => h.path).slice(0, 20),
            pathsTruncated: hunks.length > 20,
          });

          if (cwdTarget.kind === "ssh") {
            if (!input.dangerouslyAllow) {
              for (const h of hunks) {
                if (isDeniedRemotePatchPath(cwdTarget.cwd, h.path)) {
                  throw new Error(
                    `Access denied: '${h.path}' is blocked for apply_patch when cwd=${cwdTarget.cwd}`,
                  );
                }
                if (h.type === "update" && h.movePath) {
                  if (isDeniedRemotePatchPath(cwdTarget.cwd, h.movePath)) {
                    throw new Error(
                      `Access denied: '${h.movePath}' is blocked for apply_patch when cwd=${cwdTarget.cwd}`,
                    );
                  }
                }
              }
            }

            const remoteRes = await remoteApplyPatch({
              host: cwdTarget.host,
              cwd: cwdTarget.cwd,
              patchText: input.patchText,
              dangerouslyAllow: input.dangerouslyAllow,
            });
            if (!remoteRes.ok) {
              throw new Error(remoteRes.error);
            }

            const outputLines = remoteRes.output.split("\n");
            const changedLines = outputLines
              .slice(1)
              .map((l) => l.trim())
              .filter(Boolean);

            logger.info("apply_patch done", {
              requestId: ctx?.requestId,
              sessionId: ctx?.sessionId,
              ok: true,
              changedCount: changedLines.length,
              changed: changedLines.slice(0, 20),
              changedTruncated: changedLines.length > 20,
            });

            return { status: "completed" as const, output: remoteRes.output };
          }

          const output = await applyHunks(cwd, hunks, { denyPaths: options?.denyPaths });

          const outputLines = output.split("\n");
          const changedLines = outputLines
            .slice(1)
            .map((l) => l.trim())
            .filter(Boolean);

          logger.info("apply_patch done", {
            requestId: ctx?.requestId,
            sessionId: ctx?.sessionId,
            ok: true,
            changedCount: changedLines.length,
            changed: changedLines.slice(0, 20),
            changedTruncated: changedLines.length > 20,
          });

          return { status: "completed" as const, output };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error(
            "apply_patch failed",
            {
              requestId: ctx?.requestId,
              sessionId: ctx?.sessionId,
              ok: false,
              message: msg,
            },
            e,
          );
          return { status: "failed" as const, output: msg };
        }
      },
    }),
  };
}
