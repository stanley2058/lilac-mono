import { localApplyPatchTool } from "./local-apply-patch-tool";

export function applyPatchTool(params: { cwd: string; denyPaths?: readonly string[] }) {
  const { cwd } = params;
  return localApplyPatchTool(cwd, { denyPaths: params.denyPaths });
}
