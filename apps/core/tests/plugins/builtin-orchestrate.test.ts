import { describe, expect, it } from "bun:test";
import { asSchema } from "ai";
import { parseCoreConfigV3ToUniversal } from "@stanley2058/lilac-utils";

import { createBuiltinOrchestratePlugin } from "../../src/plugins/builtin/orchestrate";
import type { CoreLevel1ToolSpec } from "../../src/plugins/types";

const config = parseCoreConfigV3ToUniversal({ configVersion: 3 });

async function orchestrateSpec(): Promise<CoreLevel1ToolSpec> {
  const created = await createBuiltinOrchestratePlugin().create({} as never);
  const spec = created.level1?.[0];
  if (!spec) throw new Error("orchestrate plugin has no Level 1 tool");
  return spec;
}

function runContext(input: {
  requestClient?: string;
  initiator?: string;
  runProfile?: string;
  safetyMode?: "trusted" | "restricted";
  sessionId?: string;
  subagentDepth?: number;
}) {
  return {
    runtime: { config },
    cwd: "/tmp",
    runProfile: input.runProfile ?? "primary",
    editingToolMode: "none",
    subagentDepth: input.subagentDepth ?? 0,
    subagentConfig: { enabled: true, idleTimeoutMs: 60_000, maxDepth: 2 },
    requestContext: {
      requestId: "request",
      sessionId: input.sessionId ?? "native:thread",
      requestClient: input.requestClient ?? "native",
      subagentDepth: input.subagentDepth ?? 0,
      subagentProfile: input.runProfile ?? "primary",
      safetyMode: input.safetyMode ?? "trusted",
      ...(input.initiator ? { requestInitiator: { platform: input.initiator, userId: "u" } } : {}),
    },
  } as never;
}

async function enabled(input: Parameters<typeof runContext>[0]): Promise<boolean> {
  return (await orchestrateSpec()).isEnabled(runContext(input));
}

async function actions(input: Parameters<typeof runContext>[0]): Promise<string[]> {
  const spec = await orchestrateSpec();
  const created = spec.createTool({
    ...(runContext(input) as object),
    getTools: () => ({}),
    getLevel1ToolSpecs: () => new Map(),
  } as never) as { inputSchema: unknown };
  const schema = asSchema(created.inputSchema as never).jsonSchema as {
    properties: { action: { enum: string[] } };
  };
  return schema.properties.action.enum;
}

describe("orchestrate tool capability", () => {
  it("is available to native and Discord primaries", async () => {
    expect(await enabled({ requestClient: "native" })).toBe(true);
    expect(await enabled({ requestClient: "discord", sessionId: "123" })).toBe(true);
  });

  it("follows a child's originating surface", async () => {
    expect(
      await enabled({ requestClient: "unknown", initiator: "native", runProfile: "full" }),
    ).toBe(true);
    expect(await enabled({ requestClient: "unknown", runProfile: "full" })).toBe(false);
  });

  it("is absent from GitHub, restricted, and heartbeat runs", async () => {
    expect(await enabled({ requestClient: "github" })).toBe(false);
    expect(await enabled({ safetyMode: "restricted" })).toBe(false);
    expect(await enabled({ sessionId: "__heartbeat__" })).toBe(false);
  });

  it("lets primaries and delegating subagents control targets, and others only read", async () => {
    expect(await actions({})).toEqual(["read", "send", "interrupt"]);
    expect(
      await actions({
        requestClient: "unknown",
        initiator: "native",
        runProfile: "full",
        subagentDepth: 1,
      }),
    ).toEqual(["read", "send", "interrupt"]);
    expect(
      await actions({
        requestClient: "unknown",
        initiator: "native",
        runProfile: "full",
        subagentDepth: 2,
      }),
    ).toEqual(["read"]);
    expect(
      await actions({
        requestClient: "unknown",
        initiator: "native",
        runProfile: "restricted",
        subagentDepth: 1,
      }),
    ).toEqual(["read"]);
  });

  it("stays out of the built-in restricted profile, which lists its plugins", () => {
    const { level1 } = config.agent.subagents.permissions["restricted"]!;
    expect(level1.plugins).not.toContain("builtin-orchestrate");
    expect(level1.tools).not.toContain("orchestrate");
  });
});
