import { describe, expect, it } from "bun:test";

import { ZodError } from "zod";

import {
  parseCoreConfig,
  parseCoreConfigResult,
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV2ToUniversal,
  readCoreConfigVersion,
  readCoreConfigVersionResult,
} from "../core-config";
import { deriveSubagentIdleTimeoutMs } from "../subagent-idle-timeout";

describe("core config versioning", () => {
  it("accepts opt-in image table style in both config versions without changing defaults", () => {
    const v1 = parseCoreConfigV1ToUniversal({
      surface: {
        discord: {
          botName: "lilac",
          experimental: { markdownTableRender: { enabled: true, style: "image" } },
        },
      },
    });
    const v2 = parseCoreConfigV2ToUniversal({
      surface: {
        discord: { botName: "lilac", markdownTableRender: { enabled: true, style: "image" } },
      },
    });
    expect(v1.surface.discord.markdownTableRender.style).toBe("image");
    expect(v2.surface.discord.markdownTableRender.style).toBe("image");
    expect(parseCoreConfigV1ToUniversal({}).surface.discord.markdownTableRender.style).toBe(
      "unicode",
    );
    expect(parseCoreConfigV2ToUniversal({}).surface.discord.markdownTableRender.style).toBe(
      "unicode",
    );
  });
  it("treats missing configVersion as v1", async () => {
    expect(readCoreConfigVersion({})).toBe(1);

    const parsed = await parseCoreConfig({});
    expect(parsed.configVersion).toBe(1);
    expect(parsed.models.main.model).toBe("openrouter/openai/gpt-4o");
    expect(parsed.models.main.reasoning).toBeUndefined();
    expect(parsed.agent.systemPrompt).toBe("");
  });

  it("returns typed version and schema failures", () => {
    const unsupported = readCoreConfigVersionResult({ configVersion: 99 });
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error._tag).toBe("CoreConfigVersionInvalid");
    }

    const invalid = parseCoreConfigResult({ configVersion: 2, tools: { output: null } });
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") expect(invalid.error._tag).toBe("CoreConfigV2Invalid");
  });

  it("keeps legacy config exceptions as Error and ZodError", async () => {
    let versionError: unknown;
    try {
      readCoreConfigVersion({ configVersion: 99 });
    } catch (cause) {
      versionError = cause;
    }
    expect(versionError).toBeInstanceOf(Error);
    if (versionError instanceof Error) expect(versionError.constructor).toBe(Error);

    await expect(
      parseCoreConfig({ configVersion: 2, tools: { output: null } }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("parses explicit v1 configs with current defaults", async () => {
    const parsed = await parseCoreConfig({ configVersion: 1 });

    expect(parsed.configVersion).toBe(1);
    expect(parsed.surface.discord.outputMode).toBe("inline");
    expect(parsed.surface.discord.outputPreviewModeFinalStyle).toBe("embed");
    expect(parsed.surface.discord.outputPreviewModeFinalText).toBe("reply-chain");
    expect(parsed.surface.discord.markdownTableRender.enabled).toBe(false);
    expect(parsed.surface.discord.markdownMathRender).toEqual({
      enabled: false,
      maxWidth: 50,
      fallbackMode: "source",
    });
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
    expect(parsed.agent.subagents.permissions.restricted.level1.tools).toEqual([
      "read",
      "glob",
      "grep",
      "fuzzy_search",
      "batch",
    ]);
    expect(parsed.agent.subagents.permissions.restricted.execution).toBe(false);
    expect(parsed.agent.subagents.permissions.full.execution).toBe("native");
    expect("idleTimeoutMs" in parsed.agent.subagents).toBe(false);
    expect(parsed.workflows.maxActiveRuns).toBe(64);
  });

  it("parses explicit v3 configs with v2 defaults outside subagents", async () => {
    const parsed = await parseCoreConfig({ configVersion: 3 });

    expect(parsed.configVersion).toBe(3);
    expect(parsed.tools.fsBackend).toBe("fff");
    expect(parsed.agent.retry.enabled).toBe(true);
    expect(Object.keys(parsed.agent.subagents.permissions).sort()).toEqual(["full", "restricted"]);
  });

  it("parses explicit v2 configs with v2 defaults", async () => {
    const parsed = await parseCoreConfig({ configVersion: 2 });

    expect(parsed.configVersion).toBe(2);
    expect(parsed.tools.fsBackend).toBe("fff");
    expect(parsed.agent.subagents.permissions.restricted.level1.tools).toEqual([
      "bash",
      "read",
      "glob",
      "grep",
      "fuzzy_search",
      "batch",
    ]);
    expect(parsed.agent.subagents.permissions.restricted.execution).toBe("native");
    expect(parsed.agent.subagents.permissions.full.execution).toBe("native");
    expect(parsed.tools.inspect.model).toBe("google/gemini-3.5-flash");
    expect(parsed.tools.editFile.hashline).toBe(true);
    expect(parsed.surface.discord.outputMode).toBe("preview");
    expect(parsed.surface.discord.outputPreviewModeFinalStyle).toBe("plain");
    expect(parsed.surface.discord.outputPreviewModeFinalText).toBe("flat");
    expect(parsed.surface.discord.outputNotification).toBe(true);
    expect(parsed.surface.discord.markdownTableRender).toEqual({
      enabled: true,
      style: "unicode",
      maxWidth: 50,
      fallbackMode: "list",
    });
    expect(parsed.surface.discord.markdownMathRender).toEqual({
      enabled: false,
      maxWidth: 50,
      fallbackMode: "source",
    });
    expect(parsed.agent.reasoningDisplay).toBe("detailed");
    expect(parsed.agent.idleTimeoutMs).toBe(15 * 60 * 1000);
    expect(parsed.agent.retry).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
    });
    expect("idleTimeoutMs" in parsed.agent.subagents).toBe(false);
    expect(parsed.models.main.reasoning).toBeUndefined();
    expect(parsed.workflows.maxActiveRuns).toBe(64);
  });

  it("parses the v2 global workflow active-run cap", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      workflows: { maxActiveRuns: 7 },
    });

    expect(parsed.workflows.maxActiveRuns).toBe(7);
  });

  it("keeps the workflow cap out of the frozen v1 input shape", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 1,
      workflows: { maxActiveRuns: 1 },
    });

    expect(parsed.workflows.maxActiveRuns).toBe(64);
  });

  it("parses v2 Discord markdown math rendering settings", () => {
    const parsed = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      surface: {
        discord: {
          markdownMathRender: {
            enabled: true,
            maxWidth: 240,
            fallbackMode: "passthrough",
          },
        },
      },
    });

    expect(parsed.surface.discord.markdownMathRender).toEqual({
      enabled: true,
      maxWidth: 240,
      fallbackMode: "passthrough",
    });
  });

  it("rejects invalid v2 Discord markdown math rendering settings", () => {
    for (const markdownMathRender of [
      { enabled: true, maxWidth: 39, fallbackMode: "source" },
      { enabled: true, maxWidth: 241, fallbackMode: "source" },
      { enabled: true, maxWidth: 50.5, fallbackMode: "source" },
      { enabled: true, maxWidth: 50, fallbackMode: "invalid" },
    ]) {
      expect(() =>
        parseCoreConfigV2ToUniversal({
          configVersion: 2,
          surface: { discord: { markdownMathRender } },
        }),
      ).toThrow();
    }
  });

  it("keeps Discord markdown math rendering out of the frozen v1 input shape", () => {
    const unknownKeys: string[][] = [];
    const parsed = parseCoreConfigV1ToUniversal(
      {
        surface: {
          discord: {
            botName: "lilac",
            markdownMathRender: {
              enabled: true,
              maxWidth: 240,
              fallbackMode: "passthrough",
            },
          },
        },
      },
      {
        onUnknownKey(path) {
          unknownKeys.push([...path] as string[]);
        },
      },
    );

    expect(unknownKeys).toEqual([["surface", "discord", "markdownMathRender"]]);
    expect(parsed.surface.discord.markdownMathRender).toEqual({
      enabled: false,
      maxWidth: 50,
      fallbackMode: "source",
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
  });

  it("parses flat v2 fallback chains without normalizing order or duplicates", () => {
    const repeatedFallback = [
      "primary",
      {
        model: "backup",
        reasoning: "low" as const,
        options: { temperature: 0.1 },
      },
      "primary",
    ];
    const parsed = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      models: {
        def: {
          primary: {
            model: "openai/gpt-5.5",
            fallback: repeatedFallback,
          },
        },
        main: {
          model: "primary",
          fallback: repeatedFallback,
        },
        fast: {
          model: "openai/gpt-5.5-mini",
          fallback: repeatedFallback,
        },
      },
      agent: {
        subagents: {
          profiles: {
            explore: {
              fallback: repeatedFallback,
            },
          },
        },
      },
    });

    expect(parsed.models.def.primary?.fallback).toEqual(repeatedFallback);
    expect(parsed.models.main.fallback).toEqual(repeatedFallback);
    expect(parsed.models.fast.fallback).toEqual(repeatedFallback);
  });

  it("keeps fallback out of the frozen v1 input shape", () => {
    const parsed = parseCoreConfigV1ToUniversal({
      models: {
        def: {
          primary: {
            model: "openai/gpt-5.5",
            fallback: ["openai/gpt-4o"],
          },
        },
        main: {
          model: "primary",
          fallback: ["openai/gpt-4o"],
        },
      },
    });

    expect(parsed.models.def.primary?.fallback).toBeUndefined();
    expect(parsed.models.main.fallback).toBeUndefined();
  });

  it("rejects incomplete fallback objects and strips nested chains", () => {
    expect(() =>
      parseCoreConfigV2ToUniversal({
        configVersion: 2,
        models: {
          main: {
            fallback: [{ reasoning: "low" }],
          },
        },
      }),
    ).toThrow();

    const parsed = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      models: {
        main: {
          fallback: [
            {
              model: "openai/gpt-4o",
              fallback: ["openai/gpt-4o-mini"],
            },
          ],
        },
      },
    });
    const entry = parsed.models.main.fallback?.[0];
    expect(typeof entry === "object" && entry !== null && "fallback" in entry).toBe(false);
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

  it("does not expose a v2 subagent idle timeout for partial configs", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 2,
      agent: {
        subagents: {
          enabled: true,
        },
      },
    });

    expect("idleTimeoutMs" in parsed.agent.subagents).toBe(false);
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

    expect("idleTimeoutMs" in parsed.agent.subagents).toBe(false);
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
          outputPreviewModeFinalText: "reply-chain",
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
    expect(parsed.surface.discord.outputPreviewModeFinalText).toBe("reply-chain");
    expect(parsed.surface.discord.markdownTableRender).toEqual({
      enabled: false,
      style: "ascii",
      maxWidth: 120,
      fallbackMode: "passthrough",
    });
    expect(parsed.agent.idleTimeoutMs).toBe(1_200_000);
    expect(parsed.agent.subagents).toMatchObject({
      enabled: true,
      maxDepth: 2,
      permissions: {
        restricted: { execution: "native", workspaceWrites: false, delegation: false },
        full: { execution: "native", workspaceWrites: true, delegation: true },
      },
    });
    expect("idleTimeoutMs" in parsed.agent.subagents).toBe(false);
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
    expect(parsed.surface.discord.outputPreviewModeFinalText).toBe("reply-chain");
    expect(parsed.surface.discord.markdownTableRender).toEqual({
      enabled: true,
      style: "ascii",
      maxWidth: 100,
      fallbackMode: "passthrough",
    });
    expect("idleTimeoutMs" in parsed.agent.subagents).toBe(false);
    expect("defaultTimeoutMs" in parsed.agent.subagents).toBe(false);
    expect("maxTimeoutMs" in parsed.agent.subagents).toBe(false);
  });

  it("derives subagent idle timeouts from the primary timeout", () => {
    expect(deriveSubagentIdleTimeoutMs(900_000)).toBe(600_000);
    expect(deriveSubagentIdleTimeoutMs(1_502)).toBe(1_001);
    expect(deriveSubagentIdleTimeoutMs(1)).toBe(1_000);
    expect(deriveSubagentIdleTimeoutMs(Number.NaN)).toBe(1_000);
  });

  it("rejects unsupported config versions", async () => {
    expect(() => readCoreConfigVersion({ configVersion: 4 })).toThrow(
      "Unsupported core config version: 4",
    );
    await expect(parseCoreConfig({ configVersion: 4 })).rejects.toThrow(
      "Unsupported core config version: 4",
    );
  });
});

it("v3 accepts max effort in model defaults, aliases and fallback chains while v2 stays frozen", () => {
  const models = {
    main: {
      model: "opus",
      reasoning: "max",
      fallback: [{ model: "anthropic/claude-opus", reasoning: "max" }],
    },
    fast: { model: "opus", reasoning: "max" },
    def: {
      opus: {
        model: "claude-code/opus",
        reasoning: "max",
        fallback: [{ model: "anthropic/claude-opus", reasoning: "max" }],
      },
    },
  };
  expect(parseCoreConfigResult({ configVersion: 3, models }).isOk()).toBe(true);
  expect(parseCoreConfigResult({ configVersion: 2, models }).isErr()).toBe(true);
});
