import { describe, expect, it } from "bun:test";

import {
  coreConfigSchema,
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV2ToUniversal,
  parseCoreConfigV3ToUniversal,
} from "../core-config";
import {
  isPermissionProfileWithin,
  resolveSubagentPermissionProfile,
  resolveSubagentPermissionProfileName,
} from "../subagent-profile";

describe("coreConfigSchema agent.subagents", () => {
  it("defaults v3 to full and restricted permission profiles", () => {
    const parsed = parseCoreConfigV3ToUniversal({ configVersion: 3 });
    expect(parsed.agent.subagents.maxDepth).toBe(2);
    expect(Object.keys(parsed.agent.subagents.permissions).sort()).toEqual(["full", "restricted"]);
    expect(parsed.agent.subagents.defaultPermissions).toBe("full");
    expect(parsed.agent.subagents.permissions.restricted).toEqual({
      level1: {
        tools: ["bash", "read", "glob", "grep", "fuzzy_search", "batch"],
        plugins: ["builtin-local-tools"],
      },
      level2: expect.objectContaining({ plugins: expect.arrayContaining(["web", "skills"]) }),
      network: true,
      workspaceWrites: false,
      execution: "native",
      delegation: false,
    });
    expect(parsed.agent.subagents.permissions.full).toEqual({
      level1: { tools: ["*"], plugins: ["*"] },
      level2: { callables: ["*"], plugins: ["*"] },
      network: true,
      workspaceWrites: true,
      execution: "native",
      delegation: true,
    });
  });

  it("parses custom v3 profiles from restricted defaults and normalizes tool names", () => {
    const parsed = parseCoreConfigV3ToUniversal({
      configVersion: 3,
      agent: {
        subagents: {
          permissions: {
            offline: { network: false, promptOverlay: "Work only from local files." },
            editor: { level1: { tools: ["read_file", "edit_file"], plugins: ["*"] } },
          },
        },
      },
    });

    expect(parsed.agent.subagents.permissions.offline).toMatchObject({
      network: false,
      workspaceWrites: false,
      execution: "native",
      delegation: false,
      promptOverlay: "Work only from local files.",
    });
    expect(parsed.agent.subagents.permissions.editor?.level1.tools).toEqual(["read", "edit"]);
    expect(parsed.agent.subagents.permissions.full.delegation).toBe(true);
  });

  it("keeps the frozen v1 general authority and restricted default", () => {
    const parsed = parseCoreConfigV1ToUniversal({});
    expect(parsed.agent.subagents.defaultPermissions).toBe("restricted");
    expect(parsed.agent.subagents.permissions.general).toMatchObject({
      workspaceWrites: true,
      delegation: false,
    });
  });

  it("rejects v3 role profiles and invalid permission profile names", () => {
    expect(() =>
      parseCoreConfigV3ToUniversal({
        configVersion: 3,
        agent: { subagents: { profiles: { explore: {} } } },
      }),
    ).toThrow("agent.subagents.profiles was removed");
    for (const name of ["primary", "Bad Name"]) {
      expect(() =>
        parseCoreConfigV3ToUniversal({
          configVersion: 3,
          agent: { subagents: { permissions: { [name]: {} } } },
        }),
      ).toThrow("permission profile names");
    }
  });

  it("maps frozen v2 profiles onto restricted, general, and full with a restricted default", () => {
    const parsed = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      agent: {
        subagents: {
          profiles: {
            explore: {
              level1: { tools: ["read_file"], plugins: ["local"] },
              network: false,
              promptOverlay: "Cite paths.",
              model: "sonnet",
            },
            general: { network: false },
            self: { execution: "restricted" },
          },
        },
      },
    });

    expect(Object.keys(parsed.agent.subagents.permissions).sort()).toEqual([
      "full",
      "general",
      "restricted",
    ]);
    expect(parsed.agent.subagents.defaultPermissions).toBe("restricted");
    expect(parsed.agent.subagents.permissions.general).toMatchObject({
      network: false,
      delegation: false,
    });
    expect(resolveSubagentPermissionProfileName(parsed, "general")).toBe("general");
    expect(parsed.agent.subagents.permissions.restricted).toMatchObject({
      level1: { tools: ["read"], plugins: ["local"] },
      network: false,
      promptOverlay: "Cite paths.",
    });
    expect(parsed.agent.subagents.permissions.restricted).not.toHaveProperty("model");
    expect(parsed.agent.subagents.permissions.full).toMatchObject({
      execution: "restricted",
      delegation: true,
    });
  });

  it("rejects the former v2 execution true value", () => {
    expect(() =>
      parseCoreConfigV2ToUniversal({
        configVersion: 2,
        agent: { subagents: { profiles: { general: { execution: true } } } },
      }),
    ).toThrow();
  });

  it("accepts profile model alias/spec with options", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        subagents: {
          profiles: {
            explore: {
              model: "sonnet",
              options: {
                anthropic: {
                  thinking: { type: "enabled" },
                },
              },
            },
            general: {
              model: "openrouter/openai/gpt-4o-mini",
            },
            self: {
              model: "codex/gpt-5-mini",
            },
          },
        },
      },
    });

    expect(parsed.agent.subagents.profiles.explore.model).toBe("sonnet");
    expect(parsed.agent.subagents.profiles.general.model).toBe("openrouter/openai/gpt-4o-mini");
    expect(parsed.agent.subagents.profiles.self.model).toBe("codex/gpt-5-mini");
    expect(parsed.agent.subagents.profiles.explore.options?.anthropic).toEqual({
      thinking: { type: "enabled" },
    });
  });

  it("accepts maxDepth=2 and rejects values above 2", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        subagents: {
          maxDepth: 2,
        },
      },
    });

    expect(parsed.agent.subagents.maxDepth).toBe(2);

    expect(() =>
      coreConfigSchema.parse({
        agent: {
          subagents: {
            maxDepth: 3,
          },
        },
      }),
    ).toThrow();
  });

  it("rejects explore options when model is not set", () => {
    expect(() =>
      coreConfigSchema.parse({
        agent: {
          subagents: {
            profiles: {
              explore: {
                options: {
                  openai: {
                    temperature: 0.2,
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow("options requires model to be set");
  });

  it("rejects self options when model is not set", () => {
    expect(() =>
      coreConfigSchema.parse({
        agent: {
          subagents: {
            profiles: {
              self: {
                options: {
                  openai: {
                    temperature: 0.2,
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow("options requires model to be set");
  });
});

describe("subagent permission profiles", () => {
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    agent: { subagents: { permissions: { offline: { network: false } } } },
  });

  it("maps legacy role names unless a profile has that name", () => {
    expect(resolveSubagentPermissionProfileName(config, "explore")).toBe("restricted");
    expect(resolveSubagentPermissionProfileName(config, "general")).toBe("full");
    expect(resolveSubagentPermissionProfileName(config, "self")).toBe("full");
    expect(resolveSubagentPermissionProfileName(config, "offline")).toBe("offline");
    expect(resolveSubagentPermissionProfileName(config, "toString")).toBeUndefined();

    const shadowed = parseCoreConfigV3ToUniversal({
      configVersion: 3,
      agent: { subagents: { permissions: { explore: { network: false } } } },
    });
    expect(resolveSubagentPermissionProfileName(shadowed, "explore")).toBe("explore");
  });

  it("resolves unknown names to an empty authority", () => {
    expect(resolveSubagentPermissionProfile(config, "missing")).toEqual({
      name: "missing",
      level1: { tools: [], plugins: [] },
      level2: { callables: [], plugins: [] },
      network: false,
      workspaceWrites: false,
      execution: false,
      delegation: false,
    });
  });

  it("checks that a child profile stays within its parent", () => {
    const permissions = config.agent.subagents.permissions;
    expect(isPermissionProfileWithin(permissions.restricted, permissions.full)).toBe(true);
    expect(isPermissionProfileWithin(permissions.full, permissions.restricted)).toBe(false);
    expect(isPermissionProfileWithin(permissions.offline!, permissions.restricted)).toBe(true);
    expect(isPermissionProfileWithin(permissions.restricted, permissions.offline!)).toBe(false);
    expect(
      isPermissionProfileWithin(
        { ...permissions.restricted, execution: "restricted" },
        { ...permissions.restricted, execution: false },
      ),
    ).toBe(false);
  });
});
