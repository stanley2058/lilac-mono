import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema plugins", () => {
  it("defaults plugins.disabled and plugins.config", () => {
    const parsed = coreConfigSchema.parse({});

    expect(parsed.plugins).toEqual({
      disabled: [],
      config: {},
    });
  });

  it("accepts disabled ids and opaque per-plugin config", () => {
    const parsed = coreConfigSchema.parse({
      plugins: {
        disabled: ["surface", "workflow"],
        config: {
          demo: {
            enabled: true,
            threshold: 2,
          },
        },
      },
    });

    expect(parsed.plugins.disabled).toEqual(["surface", "workflow"]);
    expect(parsed.plugins.config).toEqual({
      demo: {
        enabled: true,
        threshold: 2,
      },
    });
  });
});
