import { describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createClaudeCode,
  type SpawnedProcess,
  type SpawnOptions,
} from "ai-sdk-provider-claude-code";
import { Panic } from "better-result";

import {
  ClaudeNativeSessionPreflightError,
  materializeClaudeCodeRunResult,
  projectClaudeSdkMessage,
  type ClaudeNativeSessionLifecycle,
  type MaterializedClaudeCodeRun,
} from "../claude-code-run";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
type ClaudeCodeSettings = Parameters<
  NonNullable<Parameters<typeof materializeClaudeCodeRunResult>[0]["createModel"]>
>[1];

class FakeSpawnedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  exit(code = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
}

function createModelCapture(settings: ClaudeCodeSettings[]) {
  const provider = createClaudeCode();
  return (modelId: string, modelSettings: ClaudeCodeSettings) => {
    settings.push(modelSettings);
    return provider(modelId, modelSettings);
  };
}

async function emitSdkMessage(settings: ClaudeCodeSettings, message: object): Promise<void> {
  const callback = settings.onSdkMessage;
  if (!callback) throw new Error("onSdkMessage was not installed");
  await callback(message);
}

async function runStopHook(settings: ClaudeCodeSettings): Promise<void> {
  const callback = settings.hooks?.Stop?.[0]?.hooks[0];
  if (!callback) throw new Error("Stop hook was not installed");
  await callback(
    {
      session_id: CANDIDATE_ID,
      transcript_path: "/tmp/claude-test-transcript.jsonl",
      cwd: process.cwd(),
      hook_event_name: "Stop",
      stop_hook_active: false,
    },
    undefined,
    { signal: new AbortController().signal },
  );
}

function spawnTrackedProcess(settings: ClaudeCodeSettings, cwd: string): SpawnedProcess {
  const spawnProcess = settings.spawnClaudeCodeProcess;
  if (!spawnProcess) throw new Error("spawnClaudeCodeProcess was not installed");
  const options = {
    command: "claude",
    args: [],
    cwd,
    env: {},
    signal: new AbortController().signal,
  } satisfies SpawnOptions;
  return spawnProcess(options);
}

async function emitQueryController(
  settings: ClaudeCodeSettings,
  options: {
    readonly getContextUsage?: () => Promise<unknown>;
    readonly returnQuery: () => Promise<void>;
  },
): Promise<void> {
  const callback = settings.onQueryControllerCreated;
  if (!callback) throw new Error("onQueryControllerCreated was not installed");
  await callback({
    rawQuery: {
      return: async () => {
        await options.returnQuery();
        return { done: true, value: undefined };
      },
    },
    getContextUsage:
      options.getContextUsage ?? (async () => ({ totalTokens: 700, maxTokens: 100_000 })),
    interrupt: async () => undefined,
  });
}

function successfulInit(sessionId: string, model = "claude-sonnet-4-6"): object {
  return { type: "system", subtype: "init", session_id: sessionId, model };
}

function successfulResult(sessionId: string): object {
  return { type: "result", subtype: "success", session_id: sessionId };
}

function nativeSession(run: MaterializedClaudeCodeRun): ClaudeNativeSessionLifecycle {
  if (!run.nativeSession) throw new Error("native session lifecycle was not materialized");
  return run.nativeSession;
}

describe("Claude native session lifecycle", () => {
  it("projects future SDK protocol variants to the closed unsupported fallback", () => {
    expect(projectClaudeSdkMessage({ type: "future-event", payload: { version: 2 } })).toEqual({
      kind: "unsupported",
    });
    expect(projectClaudeSdkMessage({ type: "system", subtype: "future-system-event" })).toEqual({
      kind: "unsupported",
    });
    expect(projectClaudeSdkMessage(Symbol("invalid SDK message"))).toMatchObject({
      kind: "invalid",
    });
  });

  it("keeps omitted session mode ephemeral and rejects ephemeral finalization", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd: process.cwd(),
        tools: {},
        execute: () => {
          throw new Error("not called");
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();

    expect(settings[0]).toMatchObject({ persistSession: false });
    expect(settings[0]?.sessionId).toBeUndefined();
    expect(settings[0]?.resume).toBeUndefined();
    expect(settings[0]?.forkSession).toBeUndefined();
    expect(nativeSession(run).getObservation()).toMatchObject({
      requestedSessionId: null,
      sourceSessionId: null,
      requestedModel: "sonnet",
      requestedReasoning: null,
      invoked: false,
    });
    expect(() => nativeSession(run).finalize()).toThrow(
      "Cannot finalize an ephemeral Claude native session",
    );

    await run.dispose();
  });

  it("materializes a fresh persisted candidate and finalizes authoritative observations", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    let usageCalls = 0;
    let injectorClosed = false;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "opus",
        reasoning: "xhigh",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => {
            usageCalls += 1;
            return { totalTokens: 1_250, maxTokens: 200_000 };
          },
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async (sessionId, options) => {
          expect(options).toEqual({ dir: cwd });
          return { sessionId, cwd, lastModified: 50 };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    expect(agentSettings).toMatchObject({
      persistSession: true,
      sessionId: CANDIDATE_ID,
      settingSources: [],
    });
    expect(agentSettings.resume).toBeUndefined();
    expect(agentSettings.forkSession).toBeUndefined();
    expect(run.continuationModel).toBeDefined();
    expect(agentSettings.hooks?.Stop).toHaveLength(1);
    expect(agentSettings.onSdkMessage).toBeFunction();

    agentSettings.onStreamStart?.({
      inject: () => undefined,
      close: () => {
        injectorClosed = true;
      },
    });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID, "claude-opus-4-6"));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    nativeSession(run).recordWarning("provider adjusted an unsupported option");
    await runStopHook(agentSettings);
    expect(usageCalls).toBe(1);

    const finalization = await nativeSession(run).finalize();

    expect(finalization).toEqual({
      status: "promotable",
      issues: [],
      observations: {
        requestedSessionId: CANDIDATE_ID,
        sourceSessionId: null,
        initSessionId: CANDIDATE_ID,
        resultSessionId: CANDIDATE_ID,
        contextTokens: 1_250,
        contextMaxTokens: 200_000,
        requestedModel: "opus",
        initializedModel: "claude-opus-4-6",
        requestedReasoning: "xhigh",
        providerWarnings: ["provider adjusted an unsupported option"],
        invoked: true,
        requiredObservabilityError: null,
        callbackError: null,
      },
      candidate: { sessionId: CANDIDATE_ID, cwd, lastModified: 50 },
      sourcePreflight: null,
      sourceFinal: null,
    });
    expect(injectorClosed).toBe(true);
    expect(await nativeSession(run).finalize()).toBe(finalization);
    await run.dispose();

    run.createUtilityModel();
    expect(settings[2]).toMatchObject({
      cwd,
      tools: [],
      settingSources: [],
      persistSession: false,
    });
    expect(settings[2]?.sessionId).toBeUndefined();
    expect(settings[2]?.resume).toBeUndefined();
    expect(settings[2]?.forkSession).toBeUndefined();
  });

  it("interrupts only through the supported query controller", async () => {
    const settings: ClaudeCodeSettings[] = [];
    let interrupts = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd: process.cwd(),
        tools: {},
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1 }),
          interrupt: async () => {
            interrupts += 1;
          },
          settle: async () => undefined,
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();

    expect(await run.control.interrupt()).toBe(true);
    expect(interrupts).toBe(1);
    await run.dispose();
    expect(await run.control.interrupt()).toBe(false);
    expect(interrupts).toBe(1);
  });

  it("forks from a preflight snapshot and permits model changes", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const reads: string[] = [];
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "opus",
        reasoning: "high",
        cwd,
        tools: {},
        nativeSession: {
          mode: "fork",
          baseSessionId: SOURCE_ID,
          sessionId: CANDIDATE_ID,
          expectedSourceLastModified: 10,
        },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 5_000, maxTokens: 200_000 }),
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async (sessionId, options) => {
          reads.push(sessionId);
          expect(options).toEqual({ dir: cwd });
          return {
            sessionId,
            cwd,
            lastModified: sessionId === SOURCE_ID ? 10 : 20,
          };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    expect(reads).toEqual([SOURCE_ID]);
    expect(agentSettings).toMatchObject({
      persistSession: true,
      resume: SOURCE_ID,
      forkSession: true,
      sessionId: CANDIDATE_ID,
    });
    expect(settings[1]).toMatchObject({
      persistSession: true,
      resume: CANDIDATE_ID,
    });
    expect(settings[1]?.forkSession).toBeUndefined();
    expect(settings[1]?.sessionId).toBeUndefined();
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID, "claude-opus-4-6"));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("promotable");
    expect(finalization.observations).toMatchObject({
      sourceSessionId: SOURCE_ID,
      requestedModel: "opus",
      initializedModel: "claude-opus-4-6",
      requestedReasoning: "high",
    });
    expect(finalization.sourcePreflight).toEqual({
      sessionId: SOURCE_ID,
      cwd,
      lastModified: 10,
    });
    expect(finalization.sourceFinal).toEqual(finalization.sourcePreflight);
    expect(reads).toEqual([SOURCE_ID, CANDIDATE_ID, SOURCE_ID]);
  });

  it("settles the native query before taking the promotable snapshot", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const usage = Promise.withResolvers<unknown>();
    const events: string[] = [];
    let injectorClosed = false;
    let lastModified = 30;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: () => {
            events.push("usage-requested");
            return usage.promise;
          },
          interrupt: async () => undefined,
          settle: async () => {
            events.push("query-settled");
            lastModified = 31;
          },
        },
        getSessionInfo: async (sessionId) => {
          events.push("session-read");
          return { sessionId, cwd, lastModified };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    agentSettings.onStreamStart?.({
      inject: () => undefined,
      close: () => {
        events.push("injector-closed");
        injectorClosed = true;
      },
    });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    expect(events).toEqual(["usage-requested"]);
    const finalizationPromise = nativeSession(run).finalize();
    expect(injectorClosed).toBe(false);
    expect(events).toEqual(["usage-requested"]);

    usage.resolve({ totalTokens: 700, maxTokens: 100_000 });
    const finalization = await finalizationPromise;
    expect(finalization.status).toBe("promotable");
    expect(finalization.candidate?.lastModified).toBe(31);
    expect(events).toEqual(["usage-requested", "injector-closed", "query-settled", "session-read"]);
  });

  it("waits for actual process exit after timed-out Query.return cleanup resolves", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const childProcess = new FakeSpawnedProcess();
    const queryReturned = Promise.withResolvers<void>();
    let metadataReads = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        spawnClaudeCodeProcess: () => childProcess,
        getSessionInfo: async (sessionId) => {
          metadataReads += 1;
          return { sessionId, cwd, lastModified: 31 };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    expect(spawnTrackedProcess(agentSettings, cwd)).toBe(childProcess);
    await emitQueryController(agentSettings, {
      returnQuery: async () => {
        queryReturned.resolve();
      },
    });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = nativeSession(run).finalize();
    await queryReturned.promise;
    expect(metadataReads).toBe(0);

    childProcess.exit();
    await expect(finalization).resolves.toMatchObject({ status: "promotable" });
    expect(metadataReads).toBe(1);
  });

  it("fails closed without process exit proof and never reads native metadata", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const childProcess = new FakeSpawnedProcess();
    let metadataReads = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        spawnClaudeCodeProcess: () => childProcess,
        waitForProcessExit: async () => {
          throw new Error("test exit proof unavailable");
        },
        getSessionInfo: async (sessionId) => {
          metadataReads += 1;
          return { sessionId, cwd, lastModified: 31 };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    spawnTrackedProcess(agentSettings, cwd);
    await emitQueryController(agentSettings, { returnQuery: async () => undefined });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    await expect(nativeSession(run).finalize()).rejects.toThrow(
      "Claude run disposal could not prove clean settlement",
    );
    expect(metadataReads).toBe(0);
  });

  it("drains a query controller registered while disposal is settling", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const firstProcess = new FakeSpawnedProcess();
    const secondProcess = new FakeSpawnedProcess();
    const processes = [firstProcess, secondProcess];
    const events: string[] = [];
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        spawnClaudeCodeProcess: () => {
          const process = processes.shift();
          if (!process) throw new Error("unexpected process spawn");
          return process;
        },
        getSessionInfo: async (sessionId) => {
          events.push("metadata-read");
          return { sessionId, cwd, lastModified: 31 };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    spawnTrackedProcess(agentSettings, cwd);
    spawnTrackedProcess(agentSettings, cwd);
    await emitQueryController(agentSettings, {
      returnQuery: async () => {
        events.push("first-query-returned");
        await emitQueryController(agentSettings, {
          returnQuery: async () => {
            events.push("late-query-returned");
            secondProcess.exit();
          },
        });
        firstProcess.exit();
      },
    });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    await expect(nativeSession(run).finalize()).resolves.toMatchObject({ status: "promotable" });
    expect(events).toEqual(["first-query-returned", "late-query-returned", "metadata-read"]);
  });

  it("closes injectors and MCP when query settlement rejects", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const childProcess = new FakeSpawnedProcess();
    let injectorClosed = false;
    let metadataReads = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        spawnClaudeCodeProcess: () => childProcess,
        getSessionInfo: async (sessionId) => {
          metadataReads += 1;
          return { sessionId, cwd, lastModified: 31 };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    const mcp = agentSettings.mcpServers?.["lilac"];
    if (mcp?.type !== "sdk") throw new Error("Lilac SDK MCP server was not installed");
    const closeSpy = spyOn(mcp.instance, "close");
    try {
      agentSettings.onStreamStart?.({
        inject: () => undefined,
        close: () => {
          injectorClosed = true;
        },
      });
      spawnTrackedProcess(agentSettings, cwd);
      await emitQueryController(agentSettings, {
        returnQuery: async () => {
          childProcess.exit();
          throw new Error("query settlement failed");
        },
      });
      await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
      await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
      await runStopHook(agentSettings);

      const finalization = nativeSession(run).finalize();
      await expect(finalization).rejects.toThrow(
        "Claude run disposal could not prove clean settlement",
      );
      await expect(run.dispose()).rejects.toBeInstanceOf(AggregateError);
      const cleanup = await run.disposeResult();
      expect(cleanup.status).toBe("error");
      if (cleanup.status === "error") {
        expect(cleanup.error._tag).toBe("ClaudeCodeRunCleanupFailed");
      }
      expect(injectorClosed).toBe(true);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(metadataReads).toBe(0);
    } finally {
      closeSpy.mockRestore();
    }
  });

  for (const operation of ["dispose", "finalize"] as const) {
    it(`attempts all cleanup and preserves the first Panic during ${operation}`, async () => {
      const settings: ClaudeCodeSettings[] = [];
      const observer = Promise.withResolvers<void>();
      const observerPanic = new Panic({ message: `${operation} observer panic` });
      const clearPanic = new Panic({ message: `${operation} clear panic` });
      const bridgePanic = new Panic({ message: `${operation} bridge panic` });
      const events: string[] = [];
      const run = (
        await materializeClaudeCodeRunResult({
          modelId: "sonnet",
          cwd: process.cwd(),
          tools: {},
          nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
          execute: () => {
            throw new Error("not called");
          },
          controller: {
            getContextUsage: async () => ({ totalTokens: 1, maxTokens: 10 }),
            interrupt: async () => undefined,
            settle: async () => {
              events.push("query-settled");
            },
          },
          onSdkMessage: () => observer.promise,
          createModel: createModelCapture(settings),
        })
      ).unwrap();
      const agentSettings = settings[0];
      if (!agentSettings) throw new Error("agent settings were not captured");
      const mcp = agentSettings.mcpServers?.["lilac"];
      if (mcp?.type !== "sdk") throw new Error("Lilac SDK MCP server was not installed");
      const closeSpy = spyOn(mcp.instance, "close").mockImplementation(async () => {
        events.push("bridge-closed");
        throw bridgePanic;
      });
      try {
        agentSettings.onStreamStart?.({
          inject: () => undefined,
          close: () => {
            events.push("first-injector-closed");
            throw clearPanic;
          },
        });
        agentSettings.onStreamStart?.({
          inject: () => undefined,
          close: () => {
            events.push("later-injector-closed");
          },
        });
        await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));

        const cleanup =
          operation === "dispose" ? run.disposeResult() : nativeSession(run).finalizeResult();
        observer.reject(observerPanic);

        await expect(cleanup).rejects.toBe(observerPanic);
        expect(events).toEqual([
          "first-injector-closed",
          "later-injector-closed",
          "query-settled",
          "bridge-closed",
        ]);
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        closeSpy.mockRestore();
      }
    });
  }

  it("attempts every injector and controller after a synchronous settle throw", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const childProcess = new FakeSpawnedProcess();
    const events: string[] = [];
    let metadataReads = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 700, maxTokens: 100_000 }),
          interrupt: async () => undefined,
          settle: () => {
            events.push("injected-settle");
            throw new Error("synchronous settle failure");
          },
        },
        spawnClaudeCodeProcess: () => childProcess,
        getSessionInfo: async (sessionId) => {
          metadataReads += 1;
          return { sessionId, cwd, lastModified: 31 };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    const mcp = agentSettings.mcpServers?.["lilac"];
    if (mcp?.type !== "sdk") throw new Error("Lilac SDK MCP server was not installed");
    const closeSpy = spyOn(mcp.instance, "close");
    try {
      closeSpy.mockImplementation(async () => {
        events.push("bridge-close");
        throw new Error("bridge cleanup failure");
      });
      agentSettings.onStreamStart?.({
        inject: () => undefined,
        close: () => {
          events.push("first-injector-close");
          throw new Error("synchronous injector close failure");
        },
      });
      agentSettings.onStreamStart?.({
        inject: () => undefined,
        close: () => {
          events.push("later-injector-close");
        },
      });
      spawnTrackedProcess(agentSettings, cwd);
      await emitQueryController(agentSettings, {
        returnQuery: async () => {
          events.push("runtime-settle");
          childProcess.exit();
        },
      });
      await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
      await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
      await runStopHook(agentSettings);

      const error = await nativeSession(run)
        .finalize()
        .then(() => undefined)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AggregateError);
      expect(events).toEqual([
        "first-injector-close",
        "later-injector-close",
        "injected-settle",
        "runtime-settle",
        "bridge-close",
      ]);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(metadataReads).toBe(0);
      const cleanup = await run.disposeResult();
      expect(cleanup.status).toBe("error");
      if (cleanup.status === "error") {
        expect(cleanup.error.failures.map(({ operation }) => operation)).toEqual([
          "Claude message injector close",
          "Claude query settlement",
          "Claude MCP bridge cleanup",
        ]);
      }
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("attempts every process exit wait after a synchronous callback throw", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const processes = [new FakeSpawnedProcess(), new FakeSpawnedProcess()];
    let exitWaitCalls = 0;
    let metadataReads = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 700, maxTokens: 100_000 }),
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        spawnClaudeCodeProcess: () => {
          const childProcess = processes.shift();
          if (!childProcess) throw new Error("unexpected process spawn");
          return childProcess;
        },
        waitForProcessExit: () => {
          exitWaitCalls += 1;
          throw new Error(`synchronous exit wait failure ${exitWaitCalls}`);
        },
        getSessionInfo: async (sessionId) => {
          metadataReads += 1;
          return { sessionId, cwd, lastModified: 31 };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    const mcp = agentSettings.mcpServers?.["lilac"];
    if (mcp?.type !== "sdk") throw new Error("Lilac SDK MCP server was not installed");
    const closeSpy = spyOn(mcp.instance, "close");
    try {
      spawnTrackedProcess(agentSettings, cwd);
      spawnTrackedProcess(agentSettings, cwd);
      await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
      await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
      await runStopHook(agentSettings);

      const error = await nativeSession(run)
        .finalize()
        .then(() => undefined)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AggregateError);
      expect(exitWaitCalls).toBe(2);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(metadataReads).toBe(0);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("rejects source mutation that occurs while the candidate query settles", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    let sourceLastModified = 10;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "opus",
        cwd,
        tools: {},
        nativeSession: {
          mode: "fork",
          baseSessionId: SOURCE_ID,
          sessionId: CANDIDATE_ID,
          expectedSourceLastModified: sourceLastModified,
        },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 700, maxTokens: 100_000 }),
          interrupt: async () => undefined,
          settle: async () => {
            sourceLastModified += 1;
          },
        },
        getSessionInfo: async (sessionId) => ({
          sessionId,
          cwd,
          lastModified: sessionId === SOURCE_ID ? sourceLastModified : 20,
        }),
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();

    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual(["source-last-modified-changed"]);
    expect(finalization.sourcePreflight?.lastModified).toBe(10);
    expect(finalization.sourceFinal?.lastModified).toBe(11);
  });

  it("reports source mutation and native identity conflicts without throwing", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    let sourceReadCount = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: {
          mode: "fork",
          baseSessionId: SOURCE_ID,
          sessionId: CANDIDATE_ID,
          expectedSourceLastModified: 1,
        },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 800, maxTokens: 100_000 }),
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async (sessionId) => {
          if (sessionId === SOURCE_ID) sourceReadCount += 1;
          return {
            sessionId,
            cwd,
            lastModified: sessionId === SOURCE_ID ? sourceReadCount : 25,
          };
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, successfulInit("33333333-3333-4333-8333-333333333333"));
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult("44444444-4444-4444-8444-444444444444"));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual([
      "init-session-id-mismatch",
      "init-session-id-conflict",
      "result-session-id-mismatch",
      "result-session-id-conflict",
      "required-observability-failed",
      "source-last-modified-changed",
    ]);
  });

  it("rejects invalid fork preflight before model construction", async () => {
    const cwd = process.cwd();
    const cases = [
      undefined,
      { sessionId: CANDIDATE_ID, cwd, lastModified: 10 },
      { sessionId: SOURCE_ID, cwd: `${cwd}/other`, lastModified: 10 },
      { sessionId: SOURCE_ID, cwd, lastModified: 11 },
    ];

    for (const metadata of cases) {
      let createCalls = 0;
      const result = await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: {
          mode: "fork",
          baseSessionId: SOURCE_ID,
          sessionId: CANDIDATE_ID,
          expectedSourceLastModified: 10,
        },
        execute: () => {
          throw new Error("not called");
        },
        getSessionInfo: async () => metadata,
        createModel: (modelId, settings) => {
          createCalls += 1;
          return createClaudeCode()(modelId, settings);
        },
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(ClaudeNativeSessionPreflightError);
      }
      expect(createCalls).toBe(0);
    }
  });

  it("rejects malformed and self-fork persistent IDs before model construction", async () => {
    let createCalls = 0;
    const createModel = (modelId: string, settings: ClaudeCodeSettings) => {
      createCalls += 1;
      return createClaudeCode()(modelId, settings);
    };
    const base = {
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      execute: () => {
        throw new Error("not called");
      },
      createModel,
    };

    const malformed = await materializeClaudeCodeRunResult({
      ...base,
      nativeSession: { mode: "fresh", sessionId: "not-a-uuid" },
    });
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("ClaudeCodeRunInvalidConfiguration");
    }
    const selfFork = await materializeClaudeCodeRunResult({
      ...base,
      nativeSession: {
        mode: "fork",
        baseSessionId: SOURCE_ID,
        sessionId: SOURCE_ID,
        expectedSourceLastModified: 10,
      },
    });
    expect(selfFork.status).toBe("error");
    if (selfFork.status === "error") {
      expect(selfFork.error.message).toContain("must be distinct");
    }
    expect(createCalls).toBe(0);
  });

  it("turns missing native state and callback failures into bounded observations", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const longError = "x".repeat(5_000);
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd: process.cwd(),
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => {
            throw new Error(longError);
          },
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async () => undefined,
        onSdkMessage: () => {
          throw new Error(longError);
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await expect(emitSdkMessage(agentSettings, { type: "system", subtype: "init" })).resolves.toBe(
      undefined,
    );
    await expect(runStopHook(agentSettings)).resolves.toBeUndefined();
    for (let index = 0; index < 40; index += 1) {
      nativeSession(run).recordWarning(`${index}:${"w".repeat(2_000)}`);
    }

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual([
      "init-session-id-missing",
      "result-session-id-missing",
      "context-usage-missing",
      "required-observability-failed",
      "candidate-missing",
    ]);
    expect(finalization.observations.callbackError?.length).toBeLessThanOrEqual(2_000);
    expect(finalization.observations.callbackError).toContain("Invalid SDK init message");
    expect(finalization.observations.requiredObservabilityError).toContain(
      "Invalid SDK init message",
    );
    expect(finalization.observations.providerWarnings).toHaveLength(32);
    expect(
      finalization.observations.providerWarnings.every((warning) => warning.length <= 1_000),
    ).toBe(true);
  });

  it("ignores realistic unrelated SDK messages without subtype", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 10, maxTokens: 1_000 }),
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      parent_tool_use_id: null,
      uuid: "message-id",
      session_id: CANDIDATE_ID,
    });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("promotable");
    expect(finalization.observations.callbackError).toBeNull();
  });

  it("does not promote after a required observability callback failure", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 10, maxTokens: 1_000 }),
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, { type: "system", subtype: "init" });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual(["required-observability-failed"]);
    expect(finalization.observations.requiredObservabilityError).toContain(
      "Invalid SDK init message",
    );
  });

  it("keeps optional SDK message callback failures promotable", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 10, maxTokens: 1_000 }),
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
        onSdkMessage: () => {
          throw new Error("optional observer failed");
        },
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("promotable");
    expect(finalization.observations.requiredObservabilityError).toBeNull();
    expect(finalization.observations.callbackError).toContain("optional observer failed");
  });

  it("returns explicit candidate metadata validation issues", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 1, maxTokens: 10 }),
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async () => ({
          sessionId: SOURCE_ID,
          cwd: `${cwd}/other`,
          lastModified: 100,
        }),
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual([
      "candidate-id-mismatch",
      "candidate-cwd-mismatch",
    ]);
    expect(finalization.candidate).toEqual({
      sessionId: SOURCE_ID,
      cwd: `${cwd}/other`,
      lastModified: 100,
    });
  });

  it("retains the latest successful usage but rejects a failed terminal capture", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    let usageCall = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => {
            usageCall += 1;
            if (usageCall === 2) throw new Error("terminal usage unavailable");
            return { totalTokens: 12, maxTokens: 1_000 };
          },
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);
    expect(await nativeSession(run).waitForObservation()).toMatchObject({
      contextTokens: 12,
      contextMaxTokens: 1_000,
    });
    await runStopHook(agentSettings);
    expect(await nativeSession(run).waitForObservation()).toMatchObject({
      contextTokens: null,
      contextMaxTokens: null,
    });
    expect(nativeSession(run).getObservation()).toMatchObject({
      contextTokens: 12,
      contextMaxTokens: 1_000,
    });

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.observations).toMatchObject({
      contextTokens: 12,
      contextMaxTokens: 1_000,
    });
    expect(finalization.issues.map(({ code }) => code)).toEqual([
      "context-usage-missing",
      "required-observability-failed",
    ]);
  });

  it("delivers init and result identities only when freshly observed for that outer call", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
        execute: () => {
          throw new Error("not called");
        },
        controller: {
          getContextUsage: async () => ({ totalTokens: 25, maxTokens: 1_000 }),
          interrupt: async () => undefined,
          settle: async () => undefined,
        },
        getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);
    expect(await nativeSession(run).waitForObservation()).toMatchObject({
      initSessionId: CANDIDATE_ID,
      resultSessionId: CANDIDATE_ID,
      contextTokens: 25,
      contextMaxTokens: 1_000,
    });

    await runStopHook(agentSettings);
    expect(await nativeSession(run).waitForObservation()).toMatchObject({
      initSessionId: null,
      resultSessionId: null,
      contextTokens: 25,
      contextMaxTokens: 1_000,
    });
    expect(nativeSession(run).getObservation()).toMatchObject({
      initSessionId: CANDIDATE_ID,
      resultSessionId: CANDIDATE_ID,
      contextTokens: 25,
      contextMaxTokens: 1_000,
    });
    await run.dispose();
  });

  it("records every portable requested reasoning value without inventing observed effort", async () => {
    const reasonings = [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "provider-default",
    ] as const;

    for (const reasoning of reasonings) {
      const settings: ClaudeCodeSettings[] = [];
      const run = (
        await materializeClaudeCodeRunResult({
          modelId: "sonnet",
          reasoning,
          cwd: process.cwd(),
          tools: {},
          execute: () => {
            throw new Error("not called");
          },
          createModel: createModelCapture(settings),
        })
      ).unwrap();

      expect(nativeSession(run).getObservation().requestedReasoning).toBe(reasoning);
      expect(nativeSession(run).getObservation()).not.toHaveProperty("initializedReasoning");
      await run.dispose();
    }
  });
});

describe("Claude reusable execution settlement", () => {
  it("awaits exit proof and accepts another query without disposing the run", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const processes = [new FakeSpawnedProcess(), new FakeSpawnedProcess()];
    let spawned = 0;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd: process.cwd(),
        tools: {},
        execute: async () => {
          throw new Error("not called");
        },
        spawnClaudeCodeProcess: () => processes[spawned++]!,
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const modelSettings = settings[0]!;
    const firstReturned = Promise.withResolvers<void>();
    spawnTrackedProcess(modelSettings, process.cwd());
    await emitQueryController(modelSettings, {
      returnQuery: async () => {
        firstReturned.resolve();
      },
    });
    let settled = false;
    const settlement = run.settleExecutionResult!().then((result) => {
      settled = true;
      return result;
    });
    await firstReturned.promise;
    expect(settled).toBe(false);
    processes[0]!.exit();
    expect((await settlement).status).toBe("ok");
    let injected = false;
    modelSettings.onStreamStart?.({
      inject() {
        injected = true;
      },
      close() {},
    });
    expect(run.control.inject("new query")).toBe(true);
    expect(injected).toBe(true);
    spawnTrackedProcess(modelSettings, process.cwd());
    await emitQueryController(modelSettings, {
      returnQuery: async () => {
        processes[1]!.exit();
      },
    });
    expect((await run.settleExecutionResult!()).status).toBe("ok");
    expect(spawned).toBe(2);
    await run.dispose();
  });

  it("settles the query when injector cleanup panics and preserves that defect", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const child = new FakeSpawnedProcess();
    const panic = new Panic({ message: "injector settlement defect" });
    let querySettled = false;
    const run = (
      await materializeClaudeCodeRunResult({
        modelId: "sonnet",
        cwd: process.cwd(),
        tools: {},
        execute: async () => {
          throw new Error("not called");
        },
        spawnClaudeCodeProcess: () => child,
        createModel: createModelCapture(settings),
      })
    ).unwrap();
    const modelSettings = settings[0]!;
    modelSettings.onStreamStart?.({
      inject() {},
      close() {
        throw panic;
      },
    });
    spawnTrackedProcess(modelSettings, process.cwd());
    await emitQueryController(modelSettings, {
      returnQuery: async () => {
        querySettled = true;
        child.exit();
      },
    });
    await expect(run.settleExecutionResult!()).rejects.toBe(panic);
    expect(querySettled).toBe(true);
    await run.dispose();
  });
});
