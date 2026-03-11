import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("core-config heartbeat", () => {
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
