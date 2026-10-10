import { describe, expect, it } from "bun:test";

import { coreConfigSchema, parseCoreConfigV2ToUniversal } from "../core-config";

describe("coreConfigSchema surface.discord.outputMode", () => {
  it("accepts preview mode", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          outputMode: "preview",
        },
      },
    });

    expect(parsed.surface.discord.outputMode).toBe("preview");
  });

  it("accepts plain previewFinalOutputStyle", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          outputMode: "preview",
          previewFinalOutputStyle: "plain",
        },
      },
    });

    expect(parsed.surface.discord.previewFinalOutputStyle).toBe("plain");
  });

  it("keeps outputNotification optional by default", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.surface.discord.outputNotification).toBeUndefined();
  });

  it("accepts outputNotification=true", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          outputNotification: true,
        },
      },
    });

    expect(parsed.surface.discord.outputNotification).toBe(true);
  });

  it("accepts custom workingIndicators", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          workingIndicators: ["Planning", "Reading", "Tooling"],
        },
      },
    });

    expect(parsed.surface.discord.workingIndicators).toEqual(["Planning", "Reading", "Tooling"]);
  });

  it("uses surface workingIndicators unless Discord overrides them", () => {
    const shared = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      surface: { workingIndicators: ["Brewing"] },
    });
    expect(shared.surface.workingIndicators).toEqual(["Brewing"]);
    expect(shared.surface.discord.workingIndicators).toEqual(["Brewing"]);

    const overridden = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      surface: { workingIndicators: ["Brewing"], discord: { workingIndicators: ["Planning"] } },
    });
    expect(overridden.surface.workingIndicators).toEqual(["Brewing"]);
    expect(overridden.surface.discord.workingIndicators).toEqual(["Planning"]);

    const defaults = parseCoreConfigV2ToUniversal({ configVersion: 2 });
    expect(defaults.surface.discord.workingIndicators).toEqual(defaults.surface.workingIndicators);
    expect(defaults.surface.workingIndicators).toContain("Alchemizing");
  });

  it("keeps memberPresence optional by default", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.surface.discord.memberPresence).toBeUndefined();
  });

  it("accepts memberPresence=true", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
          memberPresence: true,
        },
      },
    });

    expect(parsed.surface.discord.memberPresence).toBe(true);
  });

  it("accepts markdown table render experimental overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        discord: {
          botName: "lilac",
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

    expect(parsed.surface.discord.experimental.markdownTableRender).toEqual({
      enabled: true,
      style: "ascii",
      maxWidth: 100,
      fallbackMode: "passthrough",
    });
  });
});
