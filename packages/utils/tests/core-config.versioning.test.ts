import { describe, expect, it } from "bun:test";

import { parseCoreConfig, readCoreConfigVersion } from "../core-config";

describe("core config versioning", () => {
  it("treats missing configVersion as v1", async () => {
    expect(readCoreConfigVersion({})).toBe(1);

    const parsed = await parseCoreConfig({});
    expect(parsed.configVersion).toBe(1);
    expect(parsed.models.main.model).toBe("openrouter/openai/gpt-4o");
    expect(parsed.agent.systemPrompt).toBe("");
  });

  it("parses explicit v1 configs with current defaults", async () => {
    const parsed = await parseCoreConfig({ configVersion: 1 });

    expect(parsed.configVersion).toBe(1);
    expect(parsed.surface.discord.outputMode).toBe("inline");
    expect(parsed.surface.discord.outputPreviewModeFinalStyle).toBe("embed");
    expect(parsed.surface.discord.markdownTableRender.enabled).toBe(false);
    expect(parsed.agent.reasoningDisplay).toBe("simple");
    expect(parsed.tools.fsBackend).toBe("node-rg");
    expect(parsed.tools.web.fetch.mode).toBe("auto");
    expect(parsed.tools.inspect.model).toBe("google/gemini-3-flash");
    expect(parsed.tools.editFile.hashline).toBe(false);
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
    expect(parsed.agent.subagents.defaultTimeoutMs).toBe(10 * 60 * 1000);
    expect(parsed.agent.subagents.maxTimeoutMs).toBe(20 * 60 * 1000);
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

  it("rejects unsupported config versions", async () => {
    expect(() => readCoreConfigVersion({ configVersion: 3 })).toThrow(
      "Unsupported core config version: 3",
    );
    await expect(parseCoreConfig({ configVersion: 3 })).rejects.toThrow(
      "Unsupported core config version: 3",
    );
  });
});
