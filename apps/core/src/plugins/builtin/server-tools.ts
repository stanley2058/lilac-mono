import { ToolPluginSkipError, type ServerTool } from "@stanley2058/lilac-plugin-runtime";

import {
  Attachment,
  Codex,
  Generate,
  Onboarding,
  SSH,
  Skills,
  Summarize,
  Surface,
  Web,
  Workflow,
} from "../../tool-server/tools";
import type { CoreToolPlugin } from "../types";

function singletonLevel2(pluginId: string, createTool: () => ServerTool): CoreToolPlugin {
  return {
    meta: {
      id: pluginId,
    },
    create() {
      return {
        level2: [createTool()],
      };
    },
  };
}

export function createBuiltinWebPlugin(): CoreToolPlugin {
  return singletonLevel2("web", () => new Web());
}

export function createBuiltinSkillsPlugin(): CoreToolPlugin {
  return singletonLevel2("skills", () => new Skills());
}

export function createBuiltinOnboardingPlugin(): CoreToolPlugin {
  return singletonLevel2("onboarding", () => new Onboarding());
}

export function createBuiltinCodexPlugin(): CoreToolPlugin {
  return singletonLevel2("codex", () => new Codex());
}

export function createBuiltinGeneratePlugin(): CoreToolPlugin {
  return singletonLevel2("generate", () => new Generate());
}

export function createBuiltinSummarizePlugin(): CoreToolPlugin {
  return singletonLevel2("summarize", () => new Summarize());
}

export function createBuiltinSshPlugin(): CoreToolPlugin {
  return singletonLevel2("ssh", () => new SSH());
}

export function createBuiltinAttachmentPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "attachment",
    },
    create({ runtime }) {
      if (!runtime.bus) {
        throw new ToolPluginSkipError("attachment requires bus");
      }
      return {
        level2: [new Attachment({ bus: runtime.bus })],
      };
    },
  };
}

export function createBuiltinWorkflowPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "workflow",
    },
    create({ runtime }) {
      if (!runtime.bus) {
        throw new ToolPluginSkipError("workflow requires bus");
      }
      return {
        level2: [
          new Workflow({
            bus: runtime.bus,
            adapter: runtime.adapter,
            config: runtime.config,
            getConfig: runtime.getConfig,
            workflowStore: runtime.workflowStore,
          }),
        ],
      };
    },
  };
}

export function createBuiltinSurfacePlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "surface",
    },
    create({ runtime }) {
      if (!runtime.adapter || !(runtime.config || runtime.getConfig)) {
        throw new ToolPluginSkipError("surface requires adapter and config access");
      }
      return {
        level2: [
          new Surface({
            adapter: runtime.adapter,
            config: runtime.config,
            getConfig: runtime.getConfig,
            discordSearch: runtime.discordSearch,
          }),
        ],
      };
    },
  };
}
