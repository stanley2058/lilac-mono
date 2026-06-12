import { describe, expect, it } from "bun:test";

import {
  parseLeadingContinueDirective,
  resolveSessionSafetyMode,
  stripLeadingContinueDirective,
  withDefaultToolsConfig,
} from "../../../src/surface/bridge/bus-request-router/common";

describe("continue directives", () => {
  it("treats bare !cont and !continue as !cont=8", () => {
    const botNames = ["lilac"];

    expect(parseLeadingContinueDirective({ text: "!cont resume please", botNames })).toBe(8);
    expect(parseLeadingContinueDirective({ text: "!continue resume please", botNames })).toBe(8);
    expect(parseLeadingContinueDirective({ text: "<@bot> !cont resume please", botNames })).toBe(8);
    expect(
      parseLeadingContinueDirective({ text: "<@bot> !continue resume please", botNames }),
    ).toBe(8);
  });

  it("strips bare continue directives from message text", () => {
    const botNames = ["lilac"];

    expect(stripLeadingContinueDirective({ text: "!cont resume please", botNames })).toBe(
      "resume please",
    );
    expect(stripLeadingContinueDirective({ text: "!continue resume please", botNames })).toBe(
      "resume please",
    );
    expect(stripLeadingContinueDirective({ text: "<@bot> !cont resume please", botNames })).toBe(
      "<@bot> resume please",
    );
    expect(
      stripLeadingContinueDirective({ text: "<@bot> !continue resume please", botNames }),
    ).toBe("<@bot> resume please");
  });
});

describe("session safety mode", () => {
  it("inherits restricted safety mode from parent when child has local prompts", async () => {
    const cfg = await withDefaultToolsConfig({
      surface: {
        router: {
          sessionModes: {
            parent: { safetyMode: "restricted" },
            child: { additionalPrompts: ["child memo"] },
          },
        },
      },
    });

    expect(resolveSessionSafetyMode(cfg, "child", "parent")).toBe("restricted");
  });
});
