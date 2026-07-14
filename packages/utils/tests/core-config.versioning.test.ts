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
    expect(parsed.agent.idleTimeoutMs).toBe(15 * 60 * 1000);
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
    expect(parsed.agent.subagents.idleTimeoutMs).toBe(6 * 60 * 1000);
  });

  it("parses explicit v2 configs with v2 defaults", async () => {
    const parsed = await parseCoreConfig({ configVersion: 2 });

    expect(parsed.configVersion).toBe(2);
    expect(parsed.tools.fsBackend).toBe("fff");
    expect(parsed.tools.inspect.model).toBe("google/gemini-3.5-flash");
    expect(parsed.tools.editFile.hashline).toBe(true);
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
    expect(parsed.agent.idleTimeoutMs).toBe(15 * 60 * 1000);
    expect(parsed.agent.retry).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
    });
    expect(parsed.agent.subagents.idleTimeoutMs).toBe(6 * 60 * 1000);
    expect(parsed.models.main.reasoning).toBeUndefined();
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

  it("parses v2 subagent delegation guidance and model selection metadata", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      agent: {
        subagents: {
          delegatePromptOverlay: "Prefer scout for mechanical exploration.",
        },
      },
      models: {
        def: {
          scout: {
            model: "openrouter/google/gemini-2.5-flash",
            comment: "Fast and inexpensive.",
            agentCanSelect: true,
          },
          defaultAlias: {
            model: "openai/gpt-5.5-mini",
          },
          manual: {
            model: "openai/gpt-5.5",
            agentCanSelect: false,
          },
        },
      },
    });

    expect(parsed.agent.subagents.delegatePromptOverlay).toBe(
      "Prefer scout for mechanical exploration.",
    );
    expect(parsed.models.def.scout).toMatchObject({
      comment: "Fast and inexpensive.",
      agentCanSelect: true,
    });
    expect(parsed.models.def.defaultAlias?.agentCanSelect).toBe(false);
    expect(parsed.models.def.manual?.agentCanSelect).toBe(false);
  });

  it("normalizes v1 model aliases as unavailable for agent selection", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 1,
      models: {
        def: {
          legacy: {
            model: "openai/gpt-4o",
          },
        },
      },
    });

    expect(parsed.models.def.legacy?.agentCanSelect).toBe(false);
    expect(parsed.models.def.legacy?.comment).toBeUndefined();
    expect(parsed.agent.subagents.delegatePromptOverlay).toBeUndefined();
  });

  it("rejects v2 model aliases that cannot be resolved as aliases", async () => {
    await expect(
      parseCoreConfig({
        configVersion: 2,
        models: {
          def: {
            "invalid/alias": {
              model: "openai/gpt-5.5",
            },
          },
        },
      }),
    ).rejects.toThrow("model alias must not contain '/'");

    await expect(
      parseCoreConfig({
        configVersion: 2,
        models: {
          def: {
            invalidTarget: {
              model: "gpt-5.5",
            },
          },
        },
      }),
    ).rejects.toThrow("models.def model must use provider/model format");
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

  it("uses the v2 subagent idle timeout default for partial configs", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      agent: {
        subagents: {
          enabled: true,
        },
      },
    });

    expect(parsed.agent.subagents.idleTimeoutMs).toBe(6 * 60 * 1000);
  });

  it("does not expose legacy subagent timeout fields in v2", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      agent: {
        subagents: {
          defaultTimeoutMs: 240_000,
          maxTimeoutMs: 480_000,
        },
      },
    });

    expect(parsed.agent.subagents.idleTimeoutMs).toBe(6 * 60 * 1000);
    expect("defaultTimeoutMs" in parsed.agent.subagents).toBe(false);
    expect("maxTimeoutMs" in parsed.agent.subagents).toBe(false);
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
      agent: {
        idleTimeoutMs: 1_200_000,
        subagents: {
          idleTimeoutMs: 240_000,
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
    expect(parsed.agent.idleTimeoutMs).toBe(1_200_000);
    expect(parsed.agent.subagents).toEqual({
      enabled: true,
      maxDepth: 2,
      idleTimeoutMs: 240_000,
      profiles: {
        explore: { modelSlot: "main" },
        general: { modelSlot: "main" },
        self: { modelSlot: "main" },
      },
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
      agent: {
        subagents: {
          defaultTimeoutMs: 240_000,
          maxTimeoutMs: 480_000,
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
    expect(parsed.agent.subagents.idleTimeoutMs).toBe(240_000);
    expect("defaultTimeoutMs" in parsed.agent.subagents).toBe(false);
    expect("maxTimeoutMs" in parsed.agent.subagents).toBe(false);
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
