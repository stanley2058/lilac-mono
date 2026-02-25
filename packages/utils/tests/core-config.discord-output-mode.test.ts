import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema surface.discord.outputMode", () => {
  it("defaults to inline", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.surface.discord.outputMode).toBe("inline");
  });

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

  it("defaults workingIndicators to ['Working']", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.surface.discord.workingIndicators).toEqual(["Working"]);
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
});
