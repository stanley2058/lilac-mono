import { skipReplyTool } from "../../tools/skip-reply";
import { markBoundedBuiltinOutput } from "../types";
import type { CoreToolPlugin } from "../types";
import { createBuiltinJobPlugin } from "./job";
import { createBuiltinLocalToolsPlugin } from "./local-tools";
import { createBuiltinOrchestratePlugin } from "./orchestrate";
import { createBuiltinQuestionPlugin } from "./question";
import {
  createBuiltinAttachmentPlugin,
  createBuiltinCodexPlugin,
  createBuiltinConfigPlugin,
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
    {
      meta: { id: "builtin-skip-reply", name: "Skip reply" },
      create: () => ({
        level1: [
          markBoundedBuiltinOutput({
            name: "skip_reply",
            isEnabled: () => true,
            supportsBatch: false,
            createTool: () => skipReplyTool,
          }),
        ],
        level2: [],
      }),
    },
    createBuiltinQuestionPlugin(),
    createBuiltinJobPlugin(),
    createBuiltinOrchestratePlugin(),
    createBuiltinWebPlugin(),
    createBuiltinSkillsPlugin(),
    createBuiltinMcpPlugin(),
    createBuiltinConfigPlugin(),
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
