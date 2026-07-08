import { createCoreToolPluginManager } from "@stanley2058/lilac-core";
import { env, getCoreConfig, type CoreConfig } from "@stanley2058/lilac-utils";

export function createToolBridgePluginManager(params?: {
  dataDir?: string;
  getConfig?: () => Promise<CoreConfig>;
}) {
  return createCoreToolPluginManager({
    runtime: {
      getConfig: params?.getConfig ?? (() => getCoreConfig()),
    },
    dataDir: params?.dataDir ?? env.dataDir,
  });
}
