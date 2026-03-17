import type { CoreToolPlugin } from "../types";
import { createBuiltinLocalToolsPlugin } from "./local-tools";
import {
  createBuiltinAttachmentPlugin,
  createBuiltinCodexPlugin,
  createBuiltinGeneratePlugin,
  createBuiltinOnboardingPlugin,
  createBuiltinSkillsPlugin,
  createBuiltinSshPlugin,
  createBuiltinSummarizePlugin,
  createBuiltinSurfacePlugin,
  createBuiltinWebPlugin,
  createBuiltinWorkflowPlugin,
} from "./server-tools";

export function createBuiltinCoreToolPlugins(): CoreToolPlugin[] {
  return [
    createBuiltinLocalToolsPlugin(),
    createBuiltinWebPlugin(),
    createBuiltinSkillsPlugin(),
    createBuiltinWorkflowPlugin(),
    createBuiltinSurfacePlugin(),
    createBuiltinAttachmentPlugin(),
    createBuiltinOnboardingPlugin(),
    createBuiltinGeneratePlugin(),
    createBuiltinCodexPlugin(),
    createBuiltinSummarizePlugin(),
    createBuiltinSshPlugin(),
  ];
}
