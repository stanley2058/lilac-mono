import type { CoreToolPlugin } from "../types";
import { createBuiltinLocalToolsPlugin } from "./local-tools";
import {
  createBuiltinAttachmentPlugin,
  createBuiltinCodexPlugin,
  createBuiltinContentInspectPlugin,
  createBuiltinDiscoveryPlugin,
  createBuiltinGeneratePlugin,
  createBuiltinOnboardingPlugin,
  createBuiltinSkillsPlugin,
  createBuiltinSshPlugin,
  createBuiltinSurfacePlugin,
  createBuiltinWebPlugin,
  createBuiltinWorkflowPlugin,
} from "./server-tools";

export function createBuiltinCoreToolPlugins(): CoreToolPlugin[] {
  return [
    createBuiltinLocalToolsPlugin(),
    createBuiltinWebPlugin(),
    createBuiltinSkillsPlugin(),
    createBuiltinDiscoveryPlugin(),
    createBuiltinWorkflowPlugin(),
    createBuiltinSurfacePlugin(),
    createBuiltinAttachmentPlugin(),
    createBuiltinOnboardingPlugin(),
    createBuiltinGeneratePlugin(),
    createBuiltinCodexPlugin(),
    createBuiltinContentInspectPlugin(),
    createBuiltinSshPlugin(),
  ];
}
