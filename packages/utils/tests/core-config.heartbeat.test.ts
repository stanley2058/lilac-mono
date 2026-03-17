import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("core-config heartbeat", () => {
  it("accepts a valid heartbeat cron expression", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/15 * * * *",
        },
      },
    });

    expect(parsed.surface.heartbeat.cron).toBe("*/15 * * * *");
  });

  it("rejects a heartbeat cron expression with the wrong field count", () => {
    expect(() =>
      coreConfigSchema.parse({
        surface: {
          heartbeat: {
            enabled: true,
            cron: "*/15 * * *",
          },
        },
      }),
    ).toThrow("cron expr must be 5 fields");
  });

  it("rejects the removed heartbeat every field", () => {
    expect(() =>
      coreConfigSchema.parse({
        surface: {
          heartbeat: {
            enabled: true,
            every: "30m",
          },
        },
      }),
    ).toThrow("surface.heartbeat.every has been removed; use surface.heartbeat.cron");
  });

  it("accepts a valid default output session", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        heartbeat: {
          enabled: true,
          defaultOutputSession: "discord/ops",
        },
      },
    });

    expect(parsed.surface.heartbeat.defaultOutputSession).toBe("discord/ops");
  });

  it("rejects an invalid default output session format", () => {
    expect(() =>
      coreConfigSchema.parse({
        surface: {
          heartbeat: {
            enabled: true,
            defaultOutputSession: "ops",
          },
        },
      }),
    ).toThrow("expected <client>/<sessionIdOrAlias>");
  });
});
