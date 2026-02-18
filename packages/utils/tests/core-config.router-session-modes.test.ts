import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema surface.router.sessionModes", () => {
  it("accepts gate-only session overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          defaultMode: "active",
          sessionModes: {
            "123": {
              gate: true,
            },
          },
        },
      },
    });

    expect(parsed.surface.router.defaultMode).toBe("active");
    expect(parsed.surface.router.sessionModes["123"]?.mode).toBeUndefined();
    expect(parsed.surface.router.sessionModes["123"]?.gate).toBe(true);
  });
});
