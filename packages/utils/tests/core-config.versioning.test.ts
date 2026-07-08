import { describe, expect, it } from "bun:test";

import { parseCoreConfig, readCoreConfigVersion } from "../core-config";

describe("core config versioning", () => {
  it("treats missing configVersion as v1", async () => {
    expect(readCoreConfigVersion({})).toBe(1);

    const parsed = await parseCoreConfig({});
    expect(parsed.configVersion).toBe(1);
    expect(parsed.models.main.model).toBe("openrouter/openai/gpt-4o");
    expect(parsed.models.main.reasoning).toBeUndefined();
    expect(parsed.agent.systemPrompt).toBe("");
  });

  it("parses explicit v1 configs with current defaults", async () => {
    const parsed = await parseCoreConfig({ configVersion: 1 });

    expect(parsed.configVersion).toBe(1);
    expect(parsed.surface.discord.outputMode).toBe("inline");
    expect(parsed.surface.discord.outputPreviewModeFinalStyle).toBe("embed");
    expect(parsed.surface.discord.markdownTableRender.enabled).toBe(false);
    expect(parsed.agent.reasoningDisplay).toBe("simple");
    expect(parsed.agent.retry).toEqual({
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
    });
    expect(parsed.tools.fsBackend).toBe("node-rg");
    expect(parsed.tools.web.fetch.mode).toBe("auto");
    expect(parsed.tools.inspect.model).toBe("google/gemini-3-flash");
    expect(parsed.tools.editFile.hashline).toBe(false);
    expect(parsed.tools.generate.image.models).toEqual([]);
    expect(parsed.tools.generate.image.defaults).toEqual({});
    expect(parsed.tools.generate.image.profiles).toEqual({});
  });

  it("parses explicit v2 configs with v2 defaults", async () => {
    const parsed = await parseCoreConfig({ configVersion: 2 });

    expect(parsed.configVersion).toBe(2);
    expect(parsed.tools.fsBackend).toBe("fff");
    expect(parsed.tools.inspect.model).toBe("google/gemini-3.5-flash");
    expect(parsed.tools.editFile.hashline).toBe(true);
    expect(parsed.tools.generate.image.models).toEqual([]);
    expect(parsed.tools.generate.image.defaults).toEqual({});
    expect(parsed.tools.generate.image.profiles).toEqual({});
    expect(parsed.surface.discord.outputMode).toBe("preview");
    expect(parsed.surface.discord.outputPreviewModeFinalStyle).toBe("plain");
    expect(parsed.surface.discord.outputNotification).toBe(true);
    expect(parsed.surface.discord.markdownTableRender).toEqual({
      enabled: true,
      style: "unicode",
      maxWidth: 50,
      fallbackMode: "list",
    });
    expect(parsed.agent.reasoningDisplay).toBe("detailed");
    expect(parsed.agent.retry).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
    });
    expect(parsed.agent.subagents.defaultTimeoutMs).toBe(10 * 60 * 1000);
    expect(parsed.agent.subagents.maxTimeoutMs).toBe(20 * 60 * 1000);
    expect(parsed.models.main.reasoning).toBeUndefined();
  });

  it("parses v2 generate.image model defaults", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      tools: {
        generate: {
          image: {
            models: [
              "openai-compatible/acme-image-model",
              "openai-compatible/acme-image-model",
              "openrouter/google/gemini-3.1-flash-image-preview",
            ],
          },
        },
      },
    });

    expect(parsed.tools.generate.image.models).toEqual([
      "openai-compatible/acme-image-model",
      "openrouter/google/gemini-3.1-flash-image-preview",
    ]);
  });

  it("parses v2 generate.image parameter defaults and model profiles", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      tools: {
        generate: {
          image: {
            defaults: {
              aspectRatio: "1:1",
              seed: 7,
              options: {
                quality: "standard",
              },
            },
            profiles: {
              "openai-compatible/nanobanana": {
                useWhen: "fast drafts and edits",
                defaults: {
                  size: "1024x1024",
                  maxRetries: 0,
                  options: {
                    openaiCompatible: {
                      quality: "high",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.tools.generate.image.defaults).toEqual({
      aspectRatio: "1:1",
      seed: 7,
      options: {
        quality: "standard",
      },
    });
    expect(parsed.tools.generate.image.profiles["openai-compatible/nanobanana"]).toEqual({
      useWhen: "fast drafts and edits",
      defaults: {
        size: "1024x1024",
        maxRetries: 0,
        options: {
          openaiCompatible: {
            quality: "high",
          },
        },
      },
    });
  });

  it("parses v2 portable model reasoning fields", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      models: {
        def: {
          "gpt-5.5": {
            model: "openai/gpt-5.5",
            reasoning: "high",
          },
        },
        main: {
          model: "gpt-5.5",
          reasoning: "medium",
        },
        fast: {
          model: "openai/gpt-5.5-mini",
          reasoning: "none",
        },
      },
      agent: {
        subagents: {
          profiles: {
            explore: {
              modelSlot: "fast",
              reasoning: "minimal",
            },
          },
        },
      },
    });

    expect(parsed.models.def["gpt-5.5"]?.reasoning).toBe("high");
    expect(parsed.models.main.reasoning).toBe("medium");
    expect(parsed.models.fast.reasoning).toBe("none");
    expect(parsed.agent.subagents.profiles.explore.reasoning).toBe("minimal");
  });

  it("rejects invalid v2 model reasoning values", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        models: {
          main: {
            model: "openai/gpt-5.5",
            reasoning: "extreme",
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("uses v2 subagent timeout defaults for partial v2 subagent configs", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      agent: {
        subagents: {
          enabled: true,
        },
      },
    });

    expect(parsed.agent.subagents.defaultTimeoutMs).toBe(10 * 60 * 1000);
    expect(parsed.agent.subagents.maxTimeoutMs).toBe(20 * 60 * 1000);
  });

  it("parses v2 configs with universal field names", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      tools: {
        fsBackend: "node-rg",
        inspect: {
          model: "google/gemini-3-pro",
        },
        editFile: {
          hashline: false,
        },
      },
      surface: {
        discord: {
          outputPreviewModeFinalStyle: "embed",
          markdownTableRender: {
            enabled: false,
            style: "ascii",
            maxWidth: 120,
            fallbackMode: "passthrough",
          },
        },
      },
    });

    expect(parsed.tools.fsBackend).toBe("node-rg");
    expect(parsed.tools.inspect.model).toBe("google/gemini-3-pro");
    expect(parsed.tools.editFile.hashline).toBe(false);
    expect(parsed.surface.discord.outputPreviewModeFinalStyle).toBe("embed");
    expect(parsed.surface.discord.markdownTableRender).toEqual({
      enabled: false,
      style: "ascii",
      maxWidth: 120,
      fallbackMode: "passthrough",
    });
  });

  it("maps v1 field names into the universal config shape", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 1,
      tools: {
        fsBackend: "fff",
        experimental_hashline_edit: true,
        inspect: {
          model: "google/gemini-3.5-flash",
        },
      },
      surface: {
        discord: {
          botName: "lilac",
          previewFinalOutputStyle: "plain",
          experimental: {
            markdownTableRender: {
              enabled: true,
              style: "ascii",
              maxWidth: 100,
              fallbackMode: "passthrough",
            },
          },
        },
      },
    });

    expect(parsed.tools.fsBackend).toBe("fff");
    expect(parsed.tools.inspect.model).toBe("google/gemini-3-flash");
    expect(parsed.tools.editFile.hashline).toBe(true);
    expect(parsed.surface.discord.outputPreviewModeFinalStyle).toBe("plain");
    expect(parsed.surface.discord.markdownTableRender).toEqual({
      enabled: true,
      style: "ascii",
      maxWidth: 100,
      fallbackMode: "passthrough",
    });
  });

  it("ignores the removed preview plain stats flag in stale config files", async () => {
    const parsedV1 = await parseCoreConfig({
      configVersion: 1,
      surface: {
        discord: {
          botName: "lilac",
          outputPreviewPlainFinalStats: false,
        },
      },
    });
    const parsedV2 = await parseCoreConfig({
      configVersion: 2,
      surface: {
        discord: {
          outputPreviewPlainFinalStats: false,
        },
      },
    });

    expect(parsedV1.surface.discord.outputPreviewModeFinalStyle).toBe("embed");
    expect("outputPreviewPlainFinalStats" in parsedV1.surface.discord).toBe(false);
    expect(parsedV2.surface.discord.outputPreviewModeFinalStyle).toBe("plain");
    expect("outputPreviewPlainFinalStats" in parsedV2.surface.discord).toBe(false);
  });

  it("rejects unsupported config versions", async () => {
    expect(() => readCoreConfigVersion({ configVersion: 3 })).toThrow(
      "Unsupported core config version: 3",
    );
    await expect(parseCoreConfig({ configVersion: 3 })).rejects.toThrow(
      "Unsupported core config version: 3",
    );
  });
});
