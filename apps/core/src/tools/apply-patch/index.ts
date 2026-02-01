import { localApplyPatchTool } from "./local-apply-patch-tool";

export function applyPatchTool(params: { cwd: string }) {
  const { cwd } = params;
  return localApplyPatchTool(cwd);
}
