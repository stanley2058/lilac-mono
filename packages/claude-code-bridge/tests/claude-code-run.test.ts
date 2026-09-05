import { describe, expect, it, spyOn } from "bun:test";
import { claudeCodeExecutableSettings } from "@stanley2058/lilac-utils/claude-code-executable";
import { tool } from "ai";
import { createClaudeCode, type ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { Panic } from "better-result";
import { z } from "zod";

import { materializeClaudeCodeRun, materializeClaudeCodeRunResult } from "../claude-code-run";

describe("materializeClaudeCodeRun", () => {
  it("returns invalid native-session configuration as an owned Result error", async () => {
    const materialized = await materializeClaudeCodeRunResult({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      nativeSession: { mode: "fresh", sessionId: "not-a-uuid" },
      execute: async () => {
        throw new Error("not called");
      },
    });

    expect(materialized.status).toBe("error");
    if (materialized.status === "error") {
      expect(materialized.error._tag).toBe("ClaudeCodeRunInvalidConfiguration");
    }
  });

  it("attempts all acquired cleanup before rethrowing model construction Panic", async () => {
    const constructionPanic = new Panic({ message: "model construction invariant" });
    const controlsPanic = new Panic({ message: "control cleanup invariant" });
    const bridgePanic = new Panic({ message: "bridge cleanup invariant" });
    const events: string[] = [];
    let restoreBridgeClose: () => void = () => undefined;
    let closeBridge: () => Promise<void> = async () => undefined;

    try {
      const materialized = materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd: process.cwd(),
        tools: {},
        execute: async () => {
          throw new Error("not called");
        },
        createModel: (_modelId, settings) => {
          settings.onStreamStart?.({
            inject: () => undefined,
            close: () => {
              events.push("first-injector-close");
              throw controlsPanic;
            },
          });
          settings.onStreamStart?.({
            inject: () => undefined,
            close: () => {
              events.push("later-injector-close");
            },
          });
          const mcp = settings.mcpServers?.["lilac"];
          if (mcp?.type !== "sdk") throw new Error("Lilac SDK MCP server was not installed");
          closeBridge = mcp.instance.close.bind(mcp.instance);
          const closeSpy = spyOn(mcp.instance, "close").mockImplementation(async () => {
            events.push("bridge-close");
            throw bridgePanic;
          });
          restoreBridgeClose = () => closeSpy.mockRestore();
          throw constructionPanic;
        },
      });

      await expect(materialized).rejects.toBe(constructionPanic);
      expect(events).toEqual(["first-injector-close", "later-injector-close", "bridge-close"]);
    } finally {
      restoreBridgeClose();
      await closeBridge();
    }
  });

  it("attempts bridge cleanup before surfacing cleanup Panic after an ordinary failure", async () => {
    const cleanupPanic = new Panic({ message: "control cleanup invariant" });
    const events: string[] = [];
    let restoreBridgeClose: () => void = () => undefined;

    try {
      const materialized = materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd: process.cwd(),
        tools: {},
        execute: async () => {
          throw new Error("not called");
        },
        createModel: (_modelId, settings) => {
          settings.onStreamStart?.({
            inject: () => undefined,
            close: () => {
              events.push("first-injector-close");
              throw cleanupPanic;
            },
          });
          settings.onStreamStart?.({
            inject: () => undefined,
            close: () => {
              events.push("later-injector-close");
            },
          });
          const mcp = settings.mcpServers?.["lilac"];
          if (mcp?.type !== "sdk") throw new Error("Lilac SDK MCP server was not installed");
          const closeBridge = mcp.instance.close.bind(mcp.instance);
          const closeSpy = spyOn(mcp.instance, "close").mockImplementation(async () => {
            events.push("bridge-close");
            await closeBridge();
          });
          restoreBridgeClose = () => closeSpy.mockRestore();
          throw new Error("model construction failed");
        },
      });

      await expect(materialized).rejects.toBe(cleanupPanic);
      expect(events).toEqual(["first-injector-close", "later-injector-close", "bridge-close"]);
    } finally {
      restoreBridgeClose();
    }
  });

  it("combines ordinary model construction and cleanup failures", async () => {
    let restoreBridgeClose: () => void = () => undefined;
    let closeBridge: () => Promise<void> = async () => undefined;

    try {
      const materialized = await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd: process.cwd(),
        tools: {},
        execute: async () => {
          throw new Error("not called");
        },
        createModel: (_modelId, settings) => {
          settings.onStreamStart?.({
            inject: () => undefined,
            close: () => {
              throw new Error("injector cleanup failed");
            },
          });
          const mcp = settings.mcpServers?.["lilac"];
          if (mcp?.type !== "sdk") throw new Error("Lilac SDK MCP server was not installed");
          closeBridge = mcp.instance.close.bind(mcp.instance);
          const closeSpy = spyOn(mcp.instance, "close").mockImplementation(async () => {
            throw new Error("bridge cleanup failed");
          });
          restoreBridgeClose = () => closeSpy.mockRestore();
          throw new Error("model construction failed");
        },
      });

      expect(materialized.status).toBe("error");
      if (materialized.status === "error") {
        expect(materialized.error._tag).toBe("ClaudeCodeRunOperationAndCleanupFailed");
        if (materialized.error._tag === "ClaudeCodeRunOperationAndCleanupFailed") {
          expect(materialized.error.operationError._tag).toBe("ClaudeCodeRunExternalFailure");
          if (materialized.error.operationError._tag === "ClaudeCodeRunExternalFailure") {
            expect(materialized.error.operationError.operation).toBe("Claude model construction");
          }
          expect(
            materialized.error.cleanupError.failures.map(({ operation }) => operation),
          ).toEqual(["Claude message injector close", "Claude MCP bridge cleanup"]);
        }
      }
    } finally {
      restoreBridgeClose();
      await closeBridge();
    }
  });

  it("isolates the tool-enabled agent model from the no-tools utility model", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const provider = createClaudeCode();
    const cwd = process.cwd();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {
        read: tool({
          description: "Read a value",
          inputSchema: z.object({ path: z.string() }),
          execute: ({ path }) => path,
        }),
        batch: tool({
          description: "Expand calls",
          inputSchema: z.object({}),
          execute: () => "not exposed",
        }),
      },
      execute: () => {
        throw new Error("not called");
      },
      createModel: (modelId, modelSettings) => {
        settings.push(modelSettings);
        return provider(modelId, modelSettings);
      },
    });

    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      cwd,
      env: { ENABLE_TOOL_SEARCH: "true" },
      tools: ["ToolSearch"],
      settingSources: [],
      persistSession: false,
      streamingInput: "always",
    });
    expect(settings[0]?.mcpServers).toBeDefined();
    expect(settings[0]?.canUseTool).toBeFunction();
    expect(settings[0]?.onStreamStart).toBeFunction();
    expect(settings[0]?.onQueryControllerCreated).toBeFunction();
    const utilityModel = run.createUtilityModel();
    expect(utilityModel).not.toBe(run.agentModel);
    expect(settings[1]).toEqual({
      ...claudeCodeExecutableSettings(),
      cwd,
      tools: [],
      settingSources: [],
      persistSession: false,
    });
    const nextUtilityModel = run.createUtilityModel();
    expect(nextUtilityModel).not.toBe(utilityModel);
    expect(settings[2]).toEqual(settings[1]);
    // Both models must target the same Claude installation.
    expect(settings[0]?.pathToClaudeCodeExecutable).toBe(
      settings[1]?.pathToClaudeCodeExecutable as string | undefined,
    );

    const injected: string[] = [];
    let closed = false;
    settings[0]?.onStreamStart?.({
      inject: (message, onResult) => {
        injected.push(message);
        onResult?.(true);
      },
      close: () => {
        closed = true;
      },
    });
    let delivered = false;
    expect(
      run.control.inject("change direction", (value) => {
        delivered = value;
      }),
    ).toBe(true);
    expect(injected).toEqual(["change direction"]);
    expect(delivered).toBe(true);

    await run.dispose();
    expect(closed).toBe(true);
    expect(run.control.inject("too late")).toBe(false);
    await run.dispose();
  });

  it("keeps persistent initial and continuation settings separate", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const provider = createClaudeCode();
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      nativeSession: { mode: "fresh", sessionId },
      execute: () => {
        throw new Error("not called");
      },
      createModel: (modelId, modelSettings) => {
        settings.push(modelSettings);
        return provider(modelId, modelSettings);
      },
    });

    expect(run.continuationModel).toBeDefined();
    expect(settings[0]).toMatchObject({ persistSession: true, sessionId });
    expect(settings[0]?.resume).toBeUndefined();
    expect(settings[1]).toMatchObject({ persistSession: true, resume: sessionId });
    expect(settings[1]?.sessionId).toBeUndefined();
    expect(settings[1]?.forkSession).toBeUndefined();

    run.createUtilityModel();
    expect(settings[2]).toMatchObject({ persistSession: false, tools: [], settingSources: [] });
    expect(settings[2]?.resume).toBeUndefined();
    expect(settings[2]?.sessionId).toBeUndefined();
    await run.dispose();
  });

  it("preserves caller built-ins, appends ToolSearch once, and keeps utility tools empty", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const provider = createClaudeCode();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: { read: tool({ inputSchema: z.object({}), execute: () => "value" }) },
      builtInTools: ["WebSearch", "ToolSearch"],
      execute: () => {
        throw new Error("not called");
      },
      createModel: (modelId, modelSettings) => {
        settings.push(modelSettings);
        return provider(modelId, modelSettings);
      },
    });

    expect(settings[0]?.tools).toEqual(["WebSearch", "ToolSearch"]);
    expect(settings[0]?.env).toEqual({ ENABLE_TOOL_SEARCH: "true" });
    run.createUtilityModel();
    expect(settings[1]?.tools).toEqual([]);
    expect(settings[1]?.env).toBeUndefined();

    await run.dispose();
  });

  it("returns utility model construction failures from the mandatory Result API", async () => {
    const provider = createClaudeCode();
    let createCalls = 0;
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      execute: () => {
        throw new Error("not called");
      },
      createModel: (modelId, settings) => {
        createCalls += 1;
        if (createCalls > 1) throw new Error("utility provider unavailable");
        return provider(modelId, settings);
      },
    });

    const utility = run.createUtilityModelResult();
    expect(utility.status).toBe("error");
    if (utility.status === "error") {
      expect(utility.error).toMatchObject({
        _tag: "ClaudeCodeRunExternalFailure",
        operation: "Claude utility model construction",
      });
    }
    expect(() => run.createUtilityModel()).toThrow("Claude utility model construction failed");
    await run.dispose();
  });

  it("preserves Panic identity from utility model construction", async () => {
    const provider = createClaudeCode();
    const panic = new Panic({ message: "utility model invariant" });
    let createCalls = 0;
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      execute: () => {
        throw new Error("not called");
      },
      createModel: (modelId, settings) => {
        createCalls += 1;
        if (createCalls > 1) throw panic;
        return provider(modelId, settings);
      },
    });

    expect(() => run.createUtilityModelResult()).toThrow(panic);
    expect(() => run.createUtilityModel()).toThrow(panic);
    await run.dispose();
  });
});
