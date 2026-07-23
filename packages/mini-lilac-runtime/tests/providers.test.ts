import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAiProviderRegistry,
  loadProviderAuth,
  loadProviderConfig,
  loadProviderRegistry,
  reasoningProviderOptions,
  writeProviderAuth,
  type ProviderAuth,
  type ProviderConfig,
} from "../src/providers";
import { loadRuntimeConfig } from "../src/config";

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-providers-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const config: ProviderConfig = {
  configVersion: 1,
  providers: {
    local: {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      catalog: "v1",
    },
  },
};
const auth: ProviderAuth = { local: { type: "api-key", key: "not-from-env" } };

const oauthTokens = {
  type: "oauth" as const,
  access: "oauth-access-secret",
  refresh: "oauth-refresh-secret",
  expires: Date.now() + 60_000,
};

async function loadTestRegistry(
  providerConfig: ProviderConfig,
  providerAuth: ProviderAuth,
  oauth: typeof oauthTokens | null,
) {
  const directory = await tempDirectory();
  const providerConfigFile = path.join(directory, "providers.yaml");
  const providerAuthFile = path.join(directory, "auth.json");
  const runtimeConfigFile = path.join(directory, "config.yaml");
  await Bun.write(providerConfigFile, JSON.stringify(providerConfig));
  await Bun.write(providerAuthFile, JSON.stringify(providerAuth));
  await chmod(providerAuthFile, 0o600);
  await Bun.write(
    runtimeConfigFile,
    JSON.stringify({
      configVersion: 1,
      server: { host: "127.0.0.1", port: 8090 },
      providerConfigFile: "./providers.yaml",
      providerAuthFile: "./auth.json",
      agent: {
        systemPrompt: "test",
        defaultProfile: "coding",
        profiles: {
          coding: {
            subagentOnly: false,
            tools: ["*"],
            execution: true,
            workspaceWrites: true,
            delegation: true,
          },
        },
      },
    }),
  );
  const runtimeConfig = await loadRuntimeConfig(runtimeConfigFile);
  return loadProviderRegistry(runtimeConfig, { readCodexTokens: async () => oauth });
}

describe("reasoningProviderOptions", () => {
  it("merges Codex OAuth store/include options with detailed summaries", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: true,
        providerType: "openai",
        reasoningEnabled: true,
      }),
    ).toEqual({
      openai: {
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "detailed",
      },
    });
  });

  it("requests detailed summaries for direct OpenAI providers", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: "openai",
        reasoningEnabled: true,
      }),
    ).toEqual({
      openai: { reasoningSummary: "detailed" },
    });
  });

  it("leaves other provider types and unknown providers untouched", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: "anthropic",
        reasoningEnabled: true,
      }),
    ).toBeUndefined();
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: undefined,
        reasoningEnabled: true,
      }),
    ).toBeUndefined();
  });

  it("does not request summaries when reasoning is disabled", () => {
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: true,
        providerType: "openai",
        reasoningEnabled: false,
      }),
    ).toEqual({
      openai: { store: false, include: ["reasoning.encrypted_content"] },
    });
    expect(
      reasoningProviderOptions({
        usesCodexOAuth: false,
        providerType: "openai",
        reasoningEnabled: false,
      }),
    ).toBeUndefined();
  });
});

describe("provider configuration", () => {
  it("loads versioned provider YAML and private auth JSON", async () => {
    const directory = await tempDirectory();
    const configFile = path.join(directory, "providers.yaml");
    const authFile = path.join(directory, "auth.json");
    await Bun.write(configFile, JSON.stringify(config));
    await Bun.write(authFile, JSON.stringify(auth));
    await chmod(authFile, 0o600);

    expect(await loadProviderConfig(configFile)).toEqual(config);
    expect(await loadProviderAuth(authFile)).toEqual(auth);
  });

  it("accepts strict per-model catalog overrides", async () => {
    const directory = await tempDirectory();
    const configFile = path.join(directory, "providers.yaml");
    const providerConfig = {
      configVersion: 1,
      providers: {
        local: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
          catalog: "v1",
          models: {
            "llama/custom": {
              reasoning: true,
              limit: { context: 131_072 },
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
      },
    } satisfies ProviderConfig;
    await Bun.write(configFile, JSON.stringify(providerConfig));

    expect(await loadProviderConfig(configFile)).toEqual(providerConfig);
    await Bun.write(
      configFile,
      JSON.stringify({
        ...providerConfig,
        providers: {
          local: { ...providerConfig.providers.local, models: { bad: { unknown: true } } },
        },
      }),
    );
    await expect(loadProviderConfig(configFile)).rejects.toThrow();
  });

  it("rejects group-readable auth files on POSIX", async () => {
    if (process.platform === "win32") return;
    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    await Bun.write(authFile, JSON.stringify(auth));
    await chmod(authFile, 0o640);
    await expect(loadProviderAuth(authFile)).rejects.toThrow("mode 0600");
  });

  it("atomically writes private auth JSON and replaces existing content", async () => {
    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    await Bun.write(authFile, "old content");
    await chmod(authFile, 0o644);

    await writeProviderAuth(authFile, auth);
    expect(await readFile(authFile, "utf8")).toBe(`${JSON.stringify(auth, null, 2)}\n`);
    if (process.platform !== "win32") {
      expect((await stat(authFile)).mode & 0o777).toBe(0o600);
    }
    expect(await loadProviderAuth(authFile)).toEqual(auth);

    const replacement: ProviderAuth = { local: { type: "api-key", key: "replacement" } };
    await writeProviderAuth(authFile, replacement);
    expect(await loadProviderAuth(authFile)).toEqual(replacement);
  });

  it("rejects legacy fields before creating auth or provider files", async () => {
    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    const configFile = path.join(directory, "providers.yaml");

    await expect(
      writeProviderAuth(authFile, { local: { type: "api-key", apiKey: "legacy" } }),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);

    await Bun.write(
      configFile,
      JSON.stringify({
        configVersion: 1,
        providers: { local: { kind: "openai-compatible", catalog: "v1" } },
      }),
    );
    await expect(loadProviderConfig(configFile)).rejects.toThrow();
  });

  it("cleans up its temporary file when replacement fails", async () => {
    const directory = await tempDirectory();
    const authFile = path.join(directory, "auth.json");
    await mkdir(authFile);

    await expect(writeProviderAuth(authFile, auth)).rejects.toThrow();
    expect((await readdir(directory)).sort()).toEqual(["auth.json"]);
  });

  it("builds a config-injected registry and rejects credential drift", () => {
    const registry = createAiProviderRegistry(config, auth);
    const model = registry.languageModel("local/example-model");
    expect(model.modelId).toBe("example-model");
    expect(() => createAiProviderRegistry(config, {})).toThrow("Missing credentials");
    expect(() =>
      createAiProviderRegistry(config, {
        ...auth,
        extra: { type: "api-key", key: "unused" },
      }),
    ).toThrow("unconfigured provider");
  });

  it("supersedes standard OpenAI with Codex OAuth without changing its model namespace", async () => {
    const loaded = await loadTestRegistry(
      {
        configVersion: 1,
        providers: { openai: { type: "openai", catalog: "models-dev" } },
      },
      {},
      oauthTokens,
    );

    expect(loaded.supersededProviderIds).toEqual(["openai"]);
    expect(loaded.registry.languageModel("openai/gpt-5").modelId).toBe("gpt-5");
    const diagnostics = JSON.stringify(loaded);
    expect(diagnostics).not.toContain(oauthTokens.access);
    expect(diagnostics).not.toContain(oauthTokens.refresh);
  });

  it("uses API-key OpenAI when OAuth is absent and lets OAuth win when both exist", async () => {
    const providerConfig: ProviderConfig = {
      configVersion: 1,
      providers: { openai: { type: "openai", catalog: "models-dev" } },
    };
    const providerAuth: ProviderAuth = {
      openai: { type: "api-key", key: "openai-api-key" },
    };

    const fallback = await loadTestRegistry(providerConfig, providerAuth, null);
    expect(fallback.supersededProviderIds).toEqual([]);
    expect(fallback.registry.languageModel("openai/gpt-5").modelId).toBe("gpt-5");

    const superseded = await loadTestRegistry(providerConfig, providerAuth, oauthTokens);
    expect(superseded.supersededProviderIds).toEqual(["openai"]);
  });

  it("never supersedes custom-baseUrl OpenAI and still requires its API key", async () => {
    const customConfig: ProviderConfig = {
      configVersion: 1,
      providers: {
        openai: {
          type: "openai",
          baseUrl: "https://openai-compatible.example/v1",
          catalog: "v1",
        },
      },
    };
    await expect(loadTestRegistry(customConfig, {}, oauthTokens)).rejects.toThrow(
      "Missing credentials",
    );

    const loaded = await loadTestRegistry(
      customConfig,
      { openai: { type: "api-key", key: "custom-key" } },
      oauthTokens,
    );
    expect(loaded.supersededProviderIds).toEqual([]);
  });

  it("rejects missing credentials without OAuth and v1 catalogs with OAuth", async () => {
    const modelsDevConfig: ProviderConfig = {
      configVersion: 1,
      providers: { openai: { type: "openai", catalog: "models-dev" } },
    };
    await expect(loadTestRegistry(modelsDevConfig, {}, null)).rejects.toThrow(
      "Missing credentials",
    );

    const v1Config: ProviderConfig = {
      configVersion: 1,
      providers: { openai: { type: "openai", catalog: "v1" } },
    };
    await expect(loadTestRegistry(v1Config, {}, oauthTokens)).rejects.toThrow(
      "must set catalog: models-dev",
    );
  });
});
