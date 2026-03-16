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

  it("accepts additionalPrompts session overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          sessionModes: {
            chan: {
              additionalPrompts: [
                "Keep this session focused on release readiness.",
                "file:///tmp/session-memo.md",
              ],
            },
          },
        },
      },
    });

    expect(parsed.surface.router.sessionModes.chan?.additionalPrompts).toEqual([
      "Keep this session focused on release readiness.",
      "file:///tmp/session-memo.md",
    ]);
  });

  it("accepts model session overrides", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          sessionModes: {
            chan: {
              model: "sonnet",
            },
          },
        },
      },
    });

    expect(parsed.surface.router.sessionModes.chan?.model).toBe("sonnet");
  });

  it("accepts canonical and alias heartbeat session keys", () => {
    const parsed = coreConfigSchema.parse({
      surface: {
        router: {
          sessionModes: {
            __heartbeat__: {
              model: "sonnet",
            },
            heartbeat: {
              model: "haiku",
            },
          },
        },
      },
    });

    expect(parsed.surface.router.sessionModes.__heartbeat__?.model).toBe("sonnet");
    expect(parsed.surface.router.sessionModes.heartbeat?.model).toBe("haiku");
  });
});

describe("coreConfigSchema entity aliases", () => {
  it("accepts optional alias comments and legacy session strings", () => {
    const parsed = coreConfigSchema.parse({
      entity: {
        users: {
          alice: {
            discord: "u1",
            comment: "Primary operator",
          },
        },
        sessions: {
          discord: {
            ops: {
              discord: "c1",
              comment: "Deploy coordination",
            },
            general: "c2",
          },
        },
      },
    });

    expect(parsed.entity?.users.alice).toEqual({
      discord: "u1",
      comment: "Primary operator",
    });
    expect(parsed.entity?.sessions.discord.ops).toEqual({
      discord: "c1",
      comment: "Deploy coordination",
    });
    expect(parsed.entity?.sessions.discord.general).toBe("c2");
  });
});
