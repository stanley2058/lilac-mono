import { localApplyPatchTool } from "./local-apply-patch-tool";

export { applyPatchInputSchema } from "@stanley2058/lilac-coding-tools/schemas";

export function applyPatchTool(params: { cwd: string; denyPaths?: readonly string[] }) {
  const { cwd } = params;
  return localApplyPatchTool(cwd, { denyPaths: params.denyPaths });
}
