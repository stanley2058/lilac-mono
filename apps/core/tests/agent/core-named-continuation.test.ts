import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { modelMessageSchema, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Result, type Result as ResultType } from "better-result";
import type {
  ClaudeNativeAttemptObservation,
  ClaudeNativeSessionStart,
  MaterializedClaudeCodeRun,
} from "@stanley2058/lilac-claude-code-bridge";

import {
  coreProfileExecutionScopeAuthority,
  createCoreNamedClaudeRuntime as createCoreNamedClaudeRuntimeResult,
  hashCoreNamedExecutionScope,
  prepareCoreNamedHistoryView,
} from "../../src/agent/core-named-continuation";
import {
  type CoreClaudeBindingReadError,
  SqliteTranscriptStore,
  TranscriptStoreSqliteDriverFailure,
} from "../../src/transcript/transcript-store";
import { projectStoredMessagesV1 } from "../../src/transcript/stored-message-materialization";

const directories: string[] = [];

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function createCoreNamedClaudeRuntime(
  input: Parameters<typeof createCoreNamedClaudeRuntimeResult>[0],
) {
  return resultValue(createCoreNamedClaudeRuntimeResult(input));
}

function bindingValue<T>(result: ResultType<T, CoreClaudeBindingReadError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

function getNamedBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCoreNamedClaudeSessionBinding"]>[0],
) {
  return bindingValue(store.getCoreNamedClaudeSessionBinding(input));
}

function getRequestTranscript(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getRequestTranscript"]>[0],
) {
  return resultValue(store.getRequestTranscript(input));
}

function getLatestCompleteNamedTranscript(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getLatestCompleteNamedTranscript"]>[0],
) {
  return resultValue(store.getLatestCompleteNamedTranscript(input));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore(dbPath?: string) {
  if (dbPath) return new SqliteTranscriptStore(dbPath);
  const directory = await mkdtemp(path.join(tmpdir(), "core-named-continuation-"));
  directories.push(directory);
  return new SqliteTranscriptStore(path.join(directory, "transcripts.db"));
}

function fakeMaterializedRun(
  start: ClaudeNativeSessionStart,
  modelId: string,
): MaterializedClaudeCodeRun {
  if (start.mode === "ephemeral") throw new Error("persistent test run cannot be ephemeral");
  const model = new MockLanguageModelV4({ modelId });
  const observation: ClaudeNativeAttemptObservation = {
    requestedSessionId: start.sessionId,
    sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
    initSessionId: start.sessionId,
    resultSessionId: start.sessionId,
    contextTokens: 120,
    contextMaxTokens: 1_000,
    requestedModel: modelId,
    initializedModel: modelId,
    requestedReasoning: "high",
    providerWarnings: [],
    invoked: true,
    requiredObservabilityError: null,
    callbackError: null,
  };
  return {
    agentModel: model,
    continuationModel: model,
    createUtilityModelResult: () => Result.ok(model),
    createUtilityModel: () => model,
    control: {
      inject: () => false,
      interrupt: async () => false,
      async interruptResult() {
        return Result.ok(await this.interrupt());
      },
      clear: () => {},
      clearResult() {
        this.clear();
        return Result.ok();
      },
    },
    nativeSession: {
      getObservation: () => observation,
      waitForObservation: async () => observation,
      recordWarning: () => {},
      finalize: async () => ({
        status: "promotable",
        issues: [],
        observations: observation,
        candidate: { sessionId: start.sessionId, cwd: "/workspace", lastModified: 100 },
        sourcePreflight:
          start.mode === "fork"
            ? { sessionId: start.baseSessionId, cwd: "/workspace", lastModified: 50 }
            : null,
        sourceFinal:
          start.mode === "fork"
            ? { sessionId: start.baseSessionId, cwd: "/workspace", lastModified: 50 }
            : null,
      }),
      async finalizeResult() {
        return Result.ok(await this.finalize());
      },
    },
    dispose: async () => {},
    async disposeResult() {
      await this.dispose();
      return Result.ok();
    },
  };
}

function prepareContext(messages: readonly ModelMessage[]) {
  const model = new MockLanguageModelV4({ modelId: "claude-code/test" });
  return {
    canonicalMessages: [...messages],
    fullBudgetView: [...messages],
    runtime: {
      model,
      modelSpecifier: "claude-code/test",
      executionMode: "provider-tools" as const,
      streamTextMaxRetries: 0,
    },
    payload: { mode: "full" as const },
    transformContext: { system: "test", tools: {} },
  };
}

async function commitRuntime(input: {
  store: SqliteTranscriptStore;
  runtime: ReturnType<typeof createCoreNamedClaudeRuntime>;
  requestId: string;
  sessionId: string;
  messages: readonly ModelMessage[];
}) {
  await input.runtime.recordSuccessfulModelCall(input.messages);
  resultValue(
    input.store.saveRequestTranscript({
      requestId: input.requestId,
      sessionId: input.sessionId,
      requestClient: "unknown",
      messages: resultValue(projectStoredMessagesV1(input.messages)),
    }),
  );
  const terminal = getRequestTranscript(input.store, { requestId: input.requestId });
  if (!terminal) throw new Error("terminal transcript missing");
  return await input.runtime.finalize({
    terminalTranscript: terminal,
    canonicalMessages: input.messages,
    providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
    isCancellationRequested: () => false,
  });
}

describe("Core named Claude continuation", () => {
  it("recovers beside a crash-left uncertain attempt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "core-named-continuation-recovery-"));
    directories.push(directory);
    const dbPath = path.join(directory, "transcripts.db");
    const sessionId = "sub:parent:named:durable-recovery";
    const requestId = "durable-recovery";
    const messages = [{ role: "user", content: "recover" }] satisfies ModelMessage[];
    const firstStore = await createStore(dbPath);
    const firstRuntime = createCoreNamedClaudeRuntime({
      store: firstStore,
      requestClient: "discord",
      sessionId,
      requestId,
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => fakeMaterializedRun(start, "sonnet"),
    });
    await firstRuntime.prepareModelCall(prepareContext(messages));
    expect(
      firstStore.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("active");
    firstStore.close();

    const diagnostics: Array<{ event: string; detail: Readonly<Record<string, unknown>> }> = [];
    const recoveredStore = await createStore(dbPath);
    const recoveredRuntime = createCoreNamedClaudeRuntime({
      store: recoveredStore,
      requestClient: "discord",
      sessionId,
      requestId,
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => fakeMaterializedRun(start, "sonnet"),
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    await recoveredRuntime.prepareModelCall(prepareContext(messages));

    expect(
      recoveredStore.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    expect(
      recoveredStore.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 2,
      })?.state,
    ).toBe("active");
    expect(
      diagnostics.find((entry) => entry.event === "attempt-materialized")?.detail.attemptIndex,
    ).toBe(2);

    recoveredRuntime.markTerminalFailure(false);
    await recoveredRuntime.retireAtRunEnd();
    recoveredStore.close();
  });

  it("starts fresh, forks after restart, and preserves model/reasoning changes", async () => {
    const store = await createStore();
    const sessionId = "sub:parent:named:audit";
    const starts: ClaudeNativeSessionStart[] = [];
    const diagnostics: Array<{ event: string; detail: Readonly<Record<string, unknown>> }> = [];
    const firstRuntime = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "request-1",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "low",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => {
        starts.push(start);
        return fakeMaterializedRun(start, "sonnet");
      },
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    const firstInput = [{ role: "user", content: "first" }] satisfies ModelMessage[];
    expect((await firstRuntime.prepareModelCall(prepareContext(firstInput))).payload).toEqual({
      mode: "full",
    });
    const firstTerminal = [
      ...firstInput,
      { role: "assistant", content: "first answer" },
    ] satisfies ModelMessage[];
    expect(
      await commitRuntime({
        store,
        runtime: firstRuntime,
        requestId: "request-1",
        sessionId,
        messages: firstTerminal,
      }),
    ).toBe(true);
    await firstRuntime.retireAtRunEnd();

    const source = getLatestCompleteNamedTranscript(store, {
      requestClient: "discord",
      sessionId,
    });
    const secondRuntime = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "request-2",
      providerId: "claude-code",
      modelSpecifier: "claude-code/opus",
      reasoning: "xhigh",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: source,
      materialize: async (start) => {
        starts.push(start);
        return fakeMaterializedRun(start, "opus");
      },
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    const secondInput = [
      ...firstTerminal,
      { role: "user", content: "second" },
    ] satisfies ModelMessage[];
    expect((await secondRuntime.prepareModelCall(prepareContext(secondInput))).payload).toEqual({
      mode: "suffix",
      startIndex: firstTerminal.length,
    });
    expect(starts[0]?.mode).toBe("fresh");
    const firstStart = starts[0];
    if (!firstStart || firstStart.mode === "ephemeral") throw new Error("expected fresh start");
    expect(starts[1]).toMatchObject({ mode: "fork", baseSessionId: firstStart.sessionId });
    expect(
      diagnostics.find(
        (entry) => entry.event === "selection" && entry.detail["requestId"] === "request-1",
      )?.detail,
    ).toMatchObject({
      requestId: "request-1",
      sessionId,
      requestClient: "discord",
      providerId: "claude-code",
      mode: "fresh",
      reason: "missing-binding",
      model: "claude-code/sonnet",
      reasoning: "low",
      bindingHead: null,
      bindingRevision: null,
    });
    expect(
      diagnostics.find(
        (entry) =>
          entry.event === "canonical-published" && entry.detail["requestId"] === "request-1",
      )?.detail,
    ).toMatchObject({ reason: "verified-terminal-head", terminalCanonicalMessageCount: 2 });
    expect(
      diagnostics.find(
        (entry) => entry.event === "selection" && entry.detail["requestId"] === "request-2",
      )?.detail,
    ).toMatchObject({
      mode: "fork",
      reason: "exact-binding",
      model: "claude-code/opus",
      reasoning: "xhigh",
      bindingRevision: 1,
    });
    expect(
      secondRuntime.inputEstimateFloor({
        canonicalMessages: secondInput,
        overlay: [],
        estimateMessagesTokens: (messages) => messages.length * 10,
      }),
    ).toBe(130);
    await secondRuntime.retireAtRunEnd();
    store.close();
  });

  it("starts fresh for exact-head and execution-scope mismatches", async () => {
    const store = await createStore();
    const sessionId = "sub:parent:named:mismatch";
    const baseMessages = [
      { role: "user", content: "base" },
      { role: "assistant", content: "answer" },
    ] satisfies ModelMessage[];
    const seed = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "seed",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope-a",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => fakeMaterializedRun(start, "sonnet"),
    });
    await seed.prepareModelCall(prepareContext([baseMessages[0]!]));
    expect(
      await commitRuntime({
        store,
        runtime: seed,
        requestId: "seed",
        sessionId,
        messages: baseMessages,
      }),
    ).toBe(true);

    for (const mismatch of ["scope", "head"] as const) {
      const source = getLatestCompleteNamedTranscript(store, {
        requestClient: "discord",
        sessionId,
      });
      if (!source) throw new Error("source transcript missing");
      const selectedSource =
        mismatch === "head"
          ? {
              ...source,
              messages: [{ role: "user", content: "different" }] satisfies ModelMessage[],
            }
          : source;
      const starts: ClaudeNativeSessionStart[] = [];
      const runtime = createCoreNamedClaudeRuntime({
        store,
        requestClient: "discord",
        sessionId,
        requestId: `mismatch-${mismatch}`,
        providerId: "claude-code",
        modelSpecifier: "claude-code/sonnet",
        reasoning: "medium",
        executionScopeHash: mismatch === "scope" ? "scope-b" : "scope-a",
        executionCwd: "/workspace",
        sourceTranscript: selectedSource,
        materialize: async (start) => {
          starts.push(start);
          return fakeMaterializedRun(start, "sonnet");
        },
      });
      const canonical = modelMessageSchema
        .array()
        .parse([...selectedSource.messages, { role: "user", content: "next" }]);
      expect((await runtime.prepareModelCall(prepareContext(canonical))).payload).toEqual({
        mode: "full",
      });
      expect(starts[0]?.mode).toBe("fresh");
      runtime.markTerminalFailure(false);
      await runtime.retireAtRunEnd();
    }
    expect(
      getNamedBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.terminalRequestId,
    ).toBe("seed");
    store.close();
  });

  it("leaves the clean base unchanged after cancellation", async () => {
    const store = await createStore();
    const sessionId = "sub:parent:named:cancel";
    const baseMessages = [
      { role: "user", content: "base" },
      { role: "assistant", content: "clean" },
    ] satisfies ModelMessage[];
    const seed = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "cancel-seed",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => fakeMaterializedRun(start, "sonnet"),
    });
    await seed.prepareModelCall(prepareContext([baseMessages[0]!]));
    expect(
      await commitRuntime({
        store,
        runtime: seed,
        requestId: "cancel-seed",
        sessionId,
        messages: baseMessages,
      }),
    ).toBe(true);
    const clean = getNamedBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    const cancelled = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "cancelled-request",
      providerId: "claude-code",
      modelSpecifier: "claude-code/opus",
      reasoning: "high",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: getLatestCompleteNamedTranscript(store, {
        requestClient: "discord",
        sessionId,
      }),
      materialize: async (start) => fakeMaterializedRun(start, "opus"),
    });
    await cancelled.prepareModelCall(
      prepareContext([...baseMessages, { role: "user", content: "cancel this" }]),
    );
    cancelled.markTerminalFailure(true);
    await cancelled.retireAtRunEnd();

    expect(
      getNamedBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toEqual(clean);
    expect(
      store.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "cancelled-request",
        attemptIndex: 0,
      })?.state,
    ).toBe("cancelled");
    store.close();
  });

  it("blocks promotion when cancellation arrives during native finalization", async () => {
    const store = await createStore();
    const sessionId = "sub:parent:named:cancel-finalize";
    const baseMessages = [
      { role: "user", content: "base" },
      { role: "assistant", content: "clean" },
    ] satisfies ModelMessage[];
    const seed = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "cancel-finalize-seed",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => fakeMaterializedRun(start, "sonnet"),
    });
    await seed.prepareModelCall(prepareContext([baseMessages[0]!]));
    expect(
      await commitRuntime({
        store,
        runtime: seed,
        requestId: "cancel-finalize-seed",
        sessionId,
        messages: baseMessages,
      }),
    ).toBe(true);
    const clean = getNamedBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    const finalizationStarted = deferred<void>();
    const releaseFinalization = deferred<void>();
    let cancellationRequested = false;
    const runtime = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "cancel-during-finalize",
      providerId: "claude-code",
      modelSpecifier: "claude-code/opus",
      reasoning: "high",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: getLatestCompleteNamedTranscript(store, {
        requestClient: "discord",
        sessionId,
      }),
      materialize: async (start) => {
        const run = fakeMaterializedRun(start, "opus");
        const lifecycle = run.nativeSession;
        if (!lifecycle) throw new Error("native lifecycle missing");
        return {
          ...run,
          nativeSession: {
            getObservation: lifecycle.getObservation,
            waitForObservation: lifecycle.waitForObservation,
            recordWarning: lifecycle.recordWarning,
            finalize: async () => {
              finalizationStarted.resolve();
              await releaseFinalization.promise;
              return await lifecycle.finalize();
            },
            async finalizeResult() {
              return Result.ok(await this.finalize());
            },
          },
        };
      },
    });
    const inputMessages = [
      ...baseMessages,
      { role: "user", content: "cancel while finalizing" },
    ] satisfies ModelMessage[];
    await runtime.prepareModelCall(prepareContext(inputMessages));
    const terminalMessages = [
      ...inputMessages,
      { role: "assistant", content: "candidate" },
    ] satisfies ModelMessage[];
    await runtime.recordSuccessfulModelCall(terminalMessages);
    store.saveRequestTranscript({
      requestId: "cancel-during-finalize",
      sessionId,
      requestClient: "unknown",
      messages: terminalMessages,
    });
    const terminal = getRequestTranscript(store, { requestId: "cancel-during-finalize" });
    if (!terminal) throw new Error("terminal transcript missing");
    const promotion = runtime.finalize({
      terminalTranscript: terminal,
      canonicalMessages: terminalMessages,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      isCancellationRequested: () => cancellationRequested,
    });
    await finalizationStarted.promise;
    cancellationRequested = true;
    releaseFinalization.resolve();

    expect(await promotion).toBe(false);
    expect(
      getNamedBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toEqual(clean);
    expect(
      store.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "cancel-during-finalize",
        attemptIndex: 0,
      })?.state,
    ).toBe("cancelled");
    await runtime.retireAtRunEnd();
    store.close();
  });

  it("reports a post-publication promotion exception without relabeling native finalization", async () => {
    const store = await createStore();
    const diagnostics: Array<{ event: string; detail: Readonly<Record<string, unknown>> }> = [];
    const runtime = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId: "sub:parent:named:promotion-error",
      requestId: "promotion-error",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => fakeMaterializedRun(start, "sonnet"),
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    const inputMessages = [{ role: "user", content: "publish first" }] satisfies ModelMessage[];
    await runtime.prepareModelCall(prepareContext(inputMessages));
    const terminalMessages = [
      ...inputMessages,
      { role: "assistant", content: "published" },
    ] satisfies ModelMessage[];
    await runtime.recordSuccessfulModelCall(terminalMessages);
    store.saveRequestTranscript({
      requestId: "promotion-error",
      sessionId: "sub:parent:named:promotion-error",
      requestClient: "unknown",
      messages: terminalMessages,
    });
    const terminal = getRequestTranscript(store, { requestId: "promotion-error" });
    if (!terminal) throw new Error("terminal transcript missing");
    store.promoteCoreNamedClaudeSessionBinding = () =>
      Result.err(
        new TranscriptStoreSqliteDriverFailure({
          operation: "promote named binding",
          code: "SQLITE_IOERR",
          message: "simulated promotion database failure",
        }),
      );

    expect(
      await runtime.finalize({
        terminalTranscript: terminal,
        canonicalMessages: terminalMessages,
        providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
        isCancellationRequested: () => false,
      }),
    ).toBe(false);
    expect(
      store.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "sub:parent:named:promotion-error",
        requestId: "promotion-error",
        attemptIndex: 0,
      })?.state,
    ).toBe("succeeded");
    expect(diagnostics.some((entry) => entry.event === "canonical-published")).toBe(true);
    expect(diagnostics.some((entry) => entry.event === "promotion-failed")).toBe(true);
    expect(diagnostics.some((entry) => entry.event === "candidate-finalization-failed")).toBe(
      false,
    );
    expect(diagnostics.some((entry) => entry.event === "canonical-publication-failed")).toBe(false);
    await runtime.retireAtRunEnd();
    store.close();
  });

  it("budgets fresh candidates from live occupancy on the second model loop", async () => {
    const store = await createStore();
    const runtime = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId: "sub:parent:named:fresh-occupancy",
      requestId: "fresh-occupancy",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => fakeMaterializedRun(start, "sonnet"),
    });
    const firstInput = [{ role: "user", content: "read it" }] satisfies ModelMessage[];
    await runtime.prepareModelCall(prepareContext(firstInput));
    const synchronized = [
      ...firstInput,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read",
            toolName: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
    ] satisfies ModelMessage[];
    await runtime.recordSuccessfulModelCall(synchronized);
    const secondLoop = [
      ...synchronized,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "read_file",
            output: { type: "text", value: "contents" },
          },
        ],
      },
    ] satisfies ModelMessage[];

    expect(
      runtime.inputEstimateFloor({
        canonicalMessages: secondLoop,
        overlay: [],
        estimateMessagesTokens: (messages) => messages.length * 10,
      }),
    ).toBe(130);
    runtime.markTerminalFailure(false);
    await runtime.retireAtRunEnd();
    store.close();
  });

  it("uses persisted fork occupancy before materialization and live cursor usage after advancement", async () => {
    const store = await createStore();
    const sessionId = "sub:parent:named:fork-occupancy";
    const seed = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "fork-occupancy-seed",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: null,
      materialize: async (start) => fakeMaterializedRun(start, "sonnet"),
    });
    const seedInput = [{ role: "user", content: "seed" }] satisfies ModelMessage[];
    await seed.prepareModelCall(prepareContext(seedInput));
    const seedTerminal = [
      ...seedInput,
      { role: "assistant", content: "ready" },
    ] satisfies ModelMessage[];
    expect(
      await commitRuntime({
        store,
        runtime: seed,
        requestId: "fork-occupancy-seed",
        sessionId,
        messages: seedTerminal,
      }),
    ).toBe(true);

    const starts: ClaudeNativeSessionStart[] = [];
    const runtime = createCoreNamedClaudeRuntime({
      store,
      requestClient: "discord",
      sessionId,
      requestId: "fork-occupancy-next",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      sourceTranscript: getLatestCompleteNamedTranscript(store, {
        requestClient: "discord",
        sessionId,
      }),
      materialize: async (start) => {
        starts.push(start);
        const run = fakeMaterializedRun(start, "sonnet");
        const lifecycle = run.nativeSession;
        if (!lifecycle) throw new Error("native lifecycle missing");
        const observation = {
          ...lifecycle.getObservation(),
          contextTokens: 240,
        };
        return {
          ...run,
          nativeSession: {
            getObservation: () => observation,
            waitForObservation: async () => observation,
            recordWarning: lifecycle.recordWarning,
            finalize: lifecycle.finalize,
            finalizeResult: lifecycle.finalizeResult,
          },
        };
      },
    });
    const continued = [
      ...seedTerminal,
      { role: "user", content: "continue" },
    ] satisfies ModelMessage[];
    expect(
      runtime.inputEstimateFloor({
        canonicalMessages: continued,
        overlay: [],
        estimateMessagesTokens: (messages) => messages.length * 10,
      }),
    ).toBe(130);
    expect(starts).toHaveLength(0);

    expect((await runtime.prepareModelCall(prepareContext(continued))).payload).toEqual({
      mode: "suffix",
      startIndex: seedTerminal.length,
    });
    const advanced = [
      ...continued,
      { role: "assistant", content: "continued" },
    ] satisfies ModelMessage[];
    await runtime.recordSuccessfulModelCall(advanced);
    const nextLoop = [...advanced, { role: "user", content: "next" }] satisfies ModelMessage[];
    expect(
      runtime.inputEstimateFloor({
        canonicalMessages: nextLoop,
        overlay: [],
        estimateMessagesTokens: (messages) => messages.length * 10,
      }),
    ).toBe(250);
    runtime.markTerminalFailure(false);
    await runtime.retireAtRunEnd();
    store.close();
  });

  it("hashes effective direct-tool and subagent authority semantically", () => {
    const base = {
      canonicalCwd: "/workspace",
      providerIdentity: "core:claude-code",
      nativeStorageNamespaceIdentity: "/home/test/.claude",
      nativeExecutableConfig: { pathToClaudeCodeExecutable: "/usr/bin/claude" },
      profile: "general",
      safetyMode: "normal",
      profileAuthority: { execution: true, workspaceWrites: true },
      pluginAuthority: { disabled: [] },
      workflowAuthority: { cwd: "/workspace" },
      systemPolicy: { base: "system" },
      directToolNames: ["bash", "read", "patch", "subagent_delegate"],
      externalToolAuthority: [{ stableId: "mcp:search" }],
      subagentAuthority: { enabled: true, maxDepth: 2, currentDepth: 1 },
    } as const;
    const baseline = hashCoreNamedExecutionScope(base).hash;
    expect(
      hashCoreNamedExecutionScope({
        ...base,
        directToolNames: ["bash", "read", "edit", "subagent_delegate"],
      }).hash,
    ).toBe(baseline);
    expect(
      hashCoreNamedExecutionScope({
        ...base,
        profileAuthority: {
          execution: coreProfileExecutionScopeAuthority("native"),
          workspaceWrites: true,
        },
      }).hash,
    ).toBe(baseline);
    expect(
      hashCoreNamedExecutionScope({
        ...base,
        profileAuthority: { execution: "restricted", workspaceWrites: true },
      }).hash,
    ).not.toBe(baseline);
    expect(
      hashCoreNamedExecutionScope({
        ...base,
        directToolNames: ["bash", "read", "patch"],
      }).hash,
    ).not.toBe(baseline);
    expect(
      hashCoreNamedExecutionScope({
        ...base,
        subagentAuthority: { enabled: false, maxDepth: 2, currentDepth: 1 },
      }).hash,
    ).not.toBe(baseline);
    expect(
      hashCoreNamedExecutionScope({
        ...base,
        subagentAuthority: { enabled: true, maxDepth: 1, currentDepth: 1 },
      }).hash,
    ).not.toBe(baseline);
    expect(hashCoreNamedExecutionScope({ ...base, safetyMode: "restricted" }).hash).not.toBe(
      baseline,
    );
  });

  it("preserves native execution authority while distinguishing restricted mode", () => {
    expect(coreProfileExecutionScopeAuthority(false)).toBe(false);
    expect(coreProfileExecutionScopeAuthority("restricted")).toBe("restricted");
    expect(coreProfileExecutionScopeAuthority("native")).toBe(true);
  });

  it("uses text-only history replay for cross-family, mixed, and legacy heads", () => {
    const sourceMessages = [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "read_file",
            input: { path: "secret.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "read_file",
            output: { type: "text", value: "historical result" },
          },
        ],
      },
    ] satisfies ModelMessage[];
    const current = { role: "user", content: "continue" } satisfies ModelMessage;
    const replay = prepareCoreNamedHistoryView({
      canonicalMessages: [...sourceMessages, current],
      sourceMessages,
      currentTurnMessages: [current],
      replayHistoricalPrefix: true,
      targetFamily: "claude-code",
      modelSpecifier: "claude-code/sonnet",
    });
    expect(replay.at(-1)).toEqual(current);
    expect(replay.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(replay)).toContain("[Conversation handoff]");
    expect(JSON.stringify(replay)).not.toContain('"type":"tool-call"');
  });

  it("text-lowers replaced historical prefixes after compaction", () => {
    const sourceMessages = [
      { role: "user", content: "old source" },
      { role: "assistant", content: "old answer" },
    ] satisfies ModelMessage[];
    const current = { role: "user", content: "current request" } satisfies ModelMessage;
    const replaced = [
      { role: "user", content: "Compacted historical summary" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "historical-call",
            toolName: "bash",
            input: { command: "old command" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "historical-call",
            toolName: "bash",
            output: { type: "text", value: "old output" },
          },
        ],
      },
      current,
    ] satisfies ModelMessage[];
    const replay = prepareCoreNamedHistoryView({
      canonicalMessages: replaced,
      sourceMessages,
      currentTurnMessages: [current],
      replayHistoricalPrefix: true,
      targetFamily: "claude-code",
      modelSpecifier: "claude-code/sonnet",
    });

    expect(replay.at(-1)).toEqual(current);
    expect(replay.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(replay)).toContain("[Conversation handoff]");
    expect(JSON.stringify(replay)).not.toContain('"type":"tool-call"');
  });
});
