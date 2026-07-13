import { describe, expect, it } from "bun:test";

import { parseCoreConfig } from "../core-config";

import type { CoreConfigKeyPath } from "../core-config";

function collectWarnings(): {
  paths: CoreConfigKeyPath[];
  onUnknownKey(path: CoreConfigKeyPath): void;
} {
  const paths: CoreConfigKeyPath[] = [];
  return {
    paths,
    onUnknownKey(path) {
      paths.push(path);
    },
  };
}

describe("core config unknown keys", () => {
  it("reports unknown top-level and nested keys after successful validation", async () => {
    const warnings = collectWarnings();
    const parsed = await parseCoreConfig(
      {
        configVersion: 2,
        rootTypo: true,
        agent: {
          retry: {
            delay: 100,
          },
        },
        models: {
          def: {
            custom: {
              model: "openai/gpt-5.5",
              typo: true,
            },
          },
        },
      },
      warnings,
    );

    expect(warnings.paths).toEqual([
      ["rootTypo"],
      ["agent", "retry", "delay"],
      ["models", "def", "custom", "typo"],
    ]);
    expect("rootTypo" in parsed).toBe(false);
    expect("delay" in parsed.agent.retry).toBe(false);
    expect("typo" in parsed.models.def.custom!).toBe(false);
  });

  it("preserves dynamic record and opaque JSON keys without warnings", async () => {
    const warnings = collectWarnings();
    const parsed = await parseCoreConfig(
      {
        configVersion: 2,
        plugins: {
          config: {
            "some-plugin": {
              arbitrary: {
                nested: true,
              },
            },
          },
        },
        models: {
          main: {
            options: {
              openai: {
                arbitrary: true,
              },
            },
          },
        },
        surface: {
          router: {
            sessionModes: {
              "discord/channel": {
                mode: "active",
              },
            },
          },
        },
      },
      warnings,
    );

    expect(warnings.paths).toEqual([]);
    expect(parsed.plugins.config["some-plugin"]).toEqual({
      arbitrary: { nested: true },
    });
    expect(parsed.models.main.options).toEqual({
      openai: { arbitrary: true },
    });
  });

  it("recognizes web aliases while reporting unknown children at their source path", async () => {
    const warnings = collectWarnings();
    const parsed = await parseCoreConfig(
      {
        configVersion: 2,
        tools: {
          web: {
            search: {
              provider: "exa",
              typo: true,
            },
          },
        },
      },
      warnings,
    );

    expect(warnings.paths).toEqual([["tools", "web", "search", "typo"]]);
    expect(parsed.tools.web.extract.providers).toEqual(["exa"]);
  });

  it("reports fields that do not belong to the selected config version", async () => {
    const v1Warnings = collectWarnings();
    await parseCoreConfig(
      {
        configVersion: 1,
        tools: {
          inspect: {
            model: "google/gemini-3.5-flash",
          },
        },
      },
      v1Warnings,
    );

    const v2Warnings = collectWarnings();
    await parseCoreConfig(
      {
        configVersion: 2,
        agent: {
          subagents: {
            defaultTimeoutMs: 240_000,
            maxTimeoutMs: 480_000,
          },
        },
      },
      v2Warnings,
    );

    expect(v1Warnings.paths).toEqual([["tools", "inspect"]]);
    expect(v2Warnings.paths).toEqual([
      ["agent", "subagents", "defaultTimeoutMs"],
      ["agent", "subagents", "maxTimeoutMs"],
    ]);
  });

  it("does not report unknown keys when validation fails", async () => {
    const warnings = collectWarnings();

    await expect(
      parseCoreConfig(
        {
          configVersion: 2,
          rootTypo: true,
          tools: {
            batch: {
              maxCalls: 0,
            },
          },
        },
        warnings,
      ),
    ).rejects.toThrow();

    expect(warnings.paths).toEqual([]);
  });
});
