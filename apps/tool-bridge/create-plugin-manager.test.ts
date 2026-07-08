import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoreConfig } from "@stanley2058/lilac-utils";

type ProviderEnvSnapshot = {
  OPENAI_COMPATIBLE_BASE_URL: string | undefined;
  OPENAI_COMPATIBLE_API_KEY: string | undefined;
};

function snapshotProviderEnv(): ProviderEnvSnapshot {
  return {
    OPENAI_COMPATIBLE_BASE_URL: process.env.OPENAI_COMPATIBLE_BASE_URL,
    OPENAI_COMPATIBLE_API_KEY: process.env.OPENAI_COMPATIBLE_API_KEY,
  };
}

function restoreProviderEnv(snapshot: ProviderEnvSnapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

describe("tool-bridge plugin manager", () => {
  let tmpRoot: string | null = null;
  let envSnapshot: ProviderEnvSnapshot | null = null;

  afterEach(async () => {
    if (envSnapshot) {
      restoreProviderEnv(envSnapshot);
      envSnapshot = null;
    }

    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("surfaces generate.image config in help output", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-bridge-"));
    const dataDir = path.join(tmpRoot, "data");
    await fs.mkdir(dataDir, { recursive: true });

    envSnapshot = snapshotProviderEnv();
    process.env.OPENAI_COMPATIBLE_BASE_URL = "https://example.invalid/v1";
    process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";

    const [{ createToolBridgePluginManager }, { createToolServer }, { parseCoreConfig }] =
      await Promise.all([
        import("./create-plugin-manager"),
        import("@stanley2058/lilac-core"),
        import("@stanley2058/lilac-utils"),
      ]);

    const config = (await parseCoreConfig({
      configVersion: 2,
      tools: {
        generate: {
          image: {
            models: ["openai-compatible/gpt-image-2"],
            profiles: {
              "openai-compatible/gpt-image-2": {
                useWhen: "Final high-fidelity product images.",
                defaults: {
                  size: "1024x1024",
                  options: {
                    quality: "high",
                  },
                },
              },
            },
          },
        },
      },
    })) satisfies CoreConfig;

    const pluginManager = createToolBridgePluginManager({
      dataDir,
      getConfig: async () => config,
    });
    const server = createToolServer({ pluginManager });

    await server.init();

    try {
      const response = await server.app.handle(new Request("http://localhost/help/generate.image"));

      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        description: string;
      };

      expect(body.description).toContain("Default models: openai-compatible/gpt-image-2");
      expect(body.description).toContain(
        "Model profiles: openai-compatible/gpt-image-2 (use when: Final high-fidelity product images.; defaults: size=1024x1024, providerOptions=configured)",
      );
    } finally {
      await server.stop();
    }
  });
});
