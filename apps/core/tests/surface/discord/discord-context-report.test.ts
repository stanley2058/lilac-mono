import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { Result } from "better-result";
import { z } from "zod";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";

import {
  createDiscordContextReportProvider,
  isDiscordContextTextCommand,
} from "../../../src/surface/discord/discord-context-report";
import type { BuiltLevel1Toolset, CoreToolPluginManager } from "../../../src/plugins/manager";

describe("isDiscordContextTextCommand", () => {
  it("matches only a leading context command token and ignores its trailing text", () => {
    expect(isDiscordContextTextCommand("!context")).toBe(true);
    expect(isDiscordContextTextCommand("!context anything after this")).toBe(true);
    expect(isDiscordContextTextCommand("!context\nignored")).toBe(true);
    expect(isDiscordContextTextCommand(" !context")).toBe(false);
    expect(isDiscordContextTextCommand("prefix !context")).toBe(false);
    expect(isDiscordContextTextCommand("!contextual")).toBe(true);
  });
});

describe("createDiscordContextReportProvider", () => {
  it("reports deferred tool inventory and compaction-reserved space", async () => {
    let releasedToolsets = 0;
    const directTool = tool({
      description: "Direct tool",
      inputSchema: z.object({ value: z.string() }),
      execute: async () => "ok",
    });
    const deferredTool = tool({
      description: "Deferred tool",
      inputSchema: z.object({ value: z.string() }),
      execute: async () => "ok",
    });
    const pluginIdentity = {
      source: "plugin" as const,
      sourceId: "calendar",
      rawToolName: "events",
    };
    const mcpIdentity = {
      source: "mcp" as const,
      sourceId: "docs",
      rawToolName: "search",
    };
    const toolset = {
      tools: {
        read: directTool,
        find_tools: directTool,
        plugin_calendar_events: deferredTool,
        mcp_docs_search: deferredTool,
      },
      specs: new Map(),
      directToolNames: new Set(["read", "find_tools"]),
      catalog: [
        {
          ...pluginIdentity,
          rawName: pluginIdentity.rawToolName,
          modelName: "plugin_calendar_events",
          identity: pluginIdentity,
          stableId: "plugin-id",
          tool: deferredTool,
        },
        {
          ...mcpIdentity,
          rawName: mcpIdentity.rawToolName,
          modelName: "mcp_docs_search",
          identity: mcpIdentity,
          stableId: "mcp-id",
          tool: deferredTool,
        },
      ],
      catalogMetadata: {},
      updateActiveBatchTools: () => undefined,
      contributionInfo: new Map(),
      genericOutputNormalizerBypassTools: new Set(),
      aggregateOutputBudgetExemptTools: new Set(),
      release: async () => {
        releasedToolsets++;
        return Result.ok(undefined);
      },
    } satisfies BuiltLevel1Toolset;
    const pluginManager = {
      buildLevel1ToolsetResult: async () => Result.ok(toolset),
    } as unknown as CoreToolPluginManager;
    const config = parseCoreConfigV1ToUniversal({
      models: {
        main: { model: "openrouter/openai/gpt-4o" },
        fast: { model: "openrouter/openai/gpt-4o-mini" },
        def: {},
        capability: {
          forceUnknownProviders: ["openrouter"],
          overrides: {
            "openrouter/openai/gpt-4o": {
              limit: { context: 128_000, output: 16_000 },
            },
          },
        },
      },
    });
    const provider = createDiscordContextReportProvider({
      pluginManager,
      cwd: "/tmp",
    });

    const report = await provider({
      source: "rest",
      config,
      sessionId: "channel",
      messages: [],
    });

    expect(report.status).toBe("ok");
    if (report.status === "error") throw report.error;
    expect(report.value.text).toContain("2 active");
    expect(report.value.text).toContain("Catalog: 1 plugin · 1 MCP, loaded on demand");
    expect(report.value.text).toContain("Active tool schemas");
    expect(report.value.text).toContain("128k tokens");
    expect(report.value.text).toContain("Unusable space          25.6k  20.0%");

    const fullWindowConfig = parseCoreConfigV1ToUniversal({
      models: {
        main: { model: "openrouter/openai/gpt-4o" },
        fast: { model: "openrouter/openai/gpt-4o-mini" },
        def: {},
        capability: {
          forceUnknownProviders: ["openrouter"],
          overrides: {
            "openrouter/openai/gpt-4o": {
              limit: { context: 1, output: 1 },
            },
          },
        },
      },
    });
    const fullWindowReport = await provider({
      source: "rest",
      config: fullWindowConfig,
      sessionId: "channel",
      messages: [],
    });

    expect(fullWindowReport.status).toBe("ok");
    if (fullWindowReport.status === "error") throw fullWindowReport.error;
    expect(fullWindowReport.value.text).not.toContain("Unusable space");
    expect(releasedToolsets).toBe(2);
  });
});
