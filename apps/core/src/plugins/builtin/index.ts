import type { CoreToolPlugin } from "../types";
import { createBuiltinJobPlugin } from "./job";
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

export function createBuiltinCoreToolPlugins(
  discordSearch?: Parameters<typeof createBuiltinSurfacePlugin>[0],
): CoreToolPlugin[] {
  return [
    createBuiltinLocalToolsPlugin(),
    createBuiltinQuestionPlugin(),
    createBuiltinJobPlugin(),
    createBuiltinWebPlugin(),
    createBuiltinSkillsPlugin(),
    createBuiltinMcpPlugin(),
    createBuiltinDiscoveryPlugin(),
    createBuiltinConversationThreadPlugin(),
    createBuiltinWorkflowPlugin(),
    createBuiltinSurfacePlugin(discordSearch),
    createBuiltinAttachmentPlugin(),
    createBuiltinResourcePlugin(),
    createBuiltinOnboardingPlugin(),
    createBuiltinGeneratePlugin(),
    createBuiltinCodexPlugin(),
    createBuiltinSshPlugin(),
  ];
}
