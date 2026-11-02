import type { CoreToolPlugin } from "../types";
import { createBuiltinLocalToolsPlugin } from "./local-tools";
import { createBuiltinQuestionPlugin } from "./question";
import {
  createBuiltinAttachmentPlugin,
  createBuiltinCodexPlugin,
  createBuiltinConversationThreadPlugin,
  createBuiltinDiscoveryPlugin,
  createBuiltinGeneratePlugin,
  createBuiltinMcpPlugin,
  createBuiltinOnboardingPlugin,
  createBuiltinResourcePlugin,
  createBuiltinSkillsPlugin,
  createBuiltinSshPlugin,
  createBuiltinSurfacePlugin,
  createBuiltinWebPlugin,
  createBuiltinWorkflowPlugin,
} from "./server-tools";

export function createBuiltinCoreToolPlugins(): CoreToolPlugin[] {
  return [
    createBuiltinLocalToolsPlugin(),
    createBuiltinQuestionPlugin(),
    createBuiltinWebPlugin(),
    createBuiltinSkillsPlugin(),
    createBuiltinMcpPlugin(),
    createBuiltinDiscoveryPlugin(),
    createBuiltinConversationThreadPlugin(),
    createBuiltinWorkflowPlugin(),
    createBuiltinSurfacePlugin(),
    createBuiltinAttachmentPlugin(),
    createBuiltinResourcePlugin(),
    createBuiltinOnboardingPlugin(),
    createBuiltinGeneratePlugin(),
    createBuiltinCodexPlugin(),
    createBuiltinSshPlugin(),
  ];
}
