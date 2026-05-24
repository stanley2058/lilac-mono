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
    expect(parsed.tools.web.fetch.mode).toBe("auto");
    expect(parsed.tools.editFile.hashline).toBe(false);
  });

  it("maps v1 field names into the universal config shape", async () => {
    const parsed = await parseCoreConfig({
      configVersion: 1,
      tools: {
        experimental_hashline_edit: true,
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
    expect(() => readCoreConfigVersion({ configVersion: 2 })).toThrow(
      "Unsupported core config version: 2",
    );
    await expect(parseCoreConfig({ configVersion: 2 })).rejects.toThrow(
      "Unsupported core config version: 2",
    );
  });
});
