import { describe, expect, it } from "bun:test";
import path from "node:path";

import { parseCoreConfig } from "../core-config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectDefaultShapePaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return [prefix];
  }

  if (!isRecord(value)) {
    return [prefix];
  }

  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    return [prefix];
  }

  const out: string[] = [];
  if (prefix.length > 0) {
    out.push(prefix);
  }

  for (const key of keys) {
    const nextPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
    out.push(...collectDefaultShapePaths(value[key], nextPrefix));
  }

  return out;
}

function pathSet(value: unknown): Set<string> {
  return new Set(collectDefaultShapePaths(value).filter((item) => item.length > 0));
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((item) => !right.has(item)).sort();
}

describe("core config drift coverage", () => {
  it("keeps v1 and v2 default universal sections in sync", async () => {
    const v1 = await parseCoreConfig({ configVersion: 1 });
    const v2 = await parseCoreConfig({ configVersion: 2 });

    const expectedTopLevel = [
      "agent",
      "configVersion",
      "conversation",
      "entity",
      "models",
      "plugins",
      "surface",
      "tools",
    ];

    expect(Object.keys(v1).sort()).toEqual(expectedTopLevel);
    expect(Object.keys(v2).sort()).toEqual(expectedTopLevel);
  });

  it("keeps v1 fallbacks aligned with v2 default shape", async () => {
    const v1Paths = pathSet(await parseCoreConfig({ configVersion: 1 }));
    const v2Paths = pathSet(await parseCoreConfig({ configVersion: 2 }));

    const expectedV2OnlyPaths = ["surface.discord.outputNotification"];

    expect(difference(v2Paths, v1Paths)).toEqual(expectedV2OnlyPaths);
    expect(difference(v1Paths, v2Paths)).toEqual([]);
  });

  it("keeps the example template parseable with documented v2 defaults", async () => {
    const templatePath = path.join(
      import.meta.dir,
      "..",
      "config-templates",
      "core-config.example.yaml",
    );
    const rawTemplate = await Bun.file(templatePath).text();
    const parsedYaml = Bun.YAML.parse(rawTemplate) as unknown;
    const cfg = await parseCoreConfig(parsedYaml);

    expect(cfg.configVersion).toBe(2);
    expect(cfg.tools.fsBackend).toBe("fff");
    expect(cfg.tools.inspect.model).toBe("google/gemini-3.5-flash");
    expect(cfg.tools.editFile.hashline).toBe(true);
    expect(cfg.tools.output.maxPreviewBytes).toBe(40 * 1024);
    expect(cfg.tools.output.artifactTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(cfg.tools.historicalResultPruning.enabled).toBe(false);
    expect(cfg.tools.batch.maxCalls).toBe(8);
    expect(cfg.tools.media.maxInlineBytesTotal).toBe(20 * 1024 * 1024);
    expect(cfg.tools.generate.image.models).toEqual([]);
    expect(cfg.tools.generate.image.defaults).toEqual({});
    expect(cfg.tools.generate.image.profiles).toEqual({});
    expect(cfg.surface.discord.outputMode).toBe("preview");
    expect(cfg.surface.discord.outputPreviewModeFinalStyle).toBe("plain");
    expect(cfg.surface.discord.outputNotification).toBe(true);
    expect(cfg.surface.discord.markdownTableRender).toEqual({
      enabled: true,
      style: "unicode",
      maxWidth: 50,
      fallbackMode: "list",
    });
    expect(cfg.agent.reasoningDisplay).toBe("detailed");
    expect(cfg.agent.retry).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
    });
    expect(cfg.agent.subagents.defaultTimeoutMs).toBe(10 * 60 * 1000);
    expect(cfg.agent.subagents.maxTimeoutMs).toBe(20 * 60 * 1000);
    expect(cfg.models.capability.forceUnknownProviders).toEqual(["openai-compatible"]);
  });
});
