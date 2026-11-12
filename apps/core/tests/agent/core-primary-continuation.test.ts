import { openAIRequestCodec } from "@stanley2058/lilac-agent/adapters/openai-responses/input";
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
  buildCoreLineageManifestV2 as buildCoreLineageManifestResultV2,
  createCorePrimaryLineageFreshOnlyV2 as createCorePrimaryLineageFreshOnlyResultV2,
  type CoreLineageManifestV2,
  type CorePrimaryLineageV2,
} from "@stanley2058/lilac-event-bus";

import {
  createCorePrimaryClaudeRuntime as createCorePrimaryClaudeRuntimeResult,
  prepareCorePrimaryHistoryView,
  selectCorePrimaryClaudePrefix,
  shouldReplayCorePrimaryHistory,
} from "../../src/agent/core-primary-continuation";
import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  type CoreClaudeBindingReadError,
  SqliteTranscriptStore,
  TranscriptStoreSqliteDriverFailure,
  type CorePrimaryClaudeSessionBinding,
} from "../../src/transcript/transcript-store";
import { projectStoredMessagesV1 } from "../../src/transcript/stored-message-materialization";
import { hashCanonicalStoredMessagesV2 } from "../../src/transcript/transcript-persistence-codec";

const directories: string[] = [];

function createCorePrimaryClaudeRuntime(
  input: Parameters<typeof createCorePrimaryClaudeRuntimeResult>[0],
) {
  const created = createCorePrimaryClaudeRuntimeResult(input);
  if (created.status === "error") throw created.error;
  return created.value;
}

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function bindingValue<T>(result: ResultType<T, CoreClaudeBindingReadError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

function getPrimaryBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCorePrimaryClaudeSessionBinding"]>[0],
) {
  return bindingValue(store.getCorePrimaryClaudeSessionBinding(input));
}

function buildCoreLineageManifestV2(...args: Parameters<typeof buildCoreLineageManifestResultV2>) {
  return resultValue(buildCoreLineageManifestResultV2(...args));
}

function createCorePrimaryLineageFreshOnlyV2(
  ...args: Parameters<typeof createCorePrimaryLineageFreshOnlyResultV2>
) {
  return resultValue(createCorePrimaryLineageFreshOnlyResultV2(...args));
}

function getRequestTranscript(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getRequestTranscript"]>[0],
) {
  return resultValue(store.getRequestTranscript(input));
}

function getCoreRequestAtomMetadata(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCoreRequestAtomMetadata"]>[0],
) {
  return resultValue(store.getCoreRequestAtomMetadata(input));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore(dbPath?: string) {
  if (dbPath) return new SqliteTranscriptStore(dbPath);
  const directory = await mkdtemp(path.join(tmpdir(), "core-primary-continuation-"));
  directories.push(directory);
  return new SqliteTranscriptStore(path.join(directory, "transcripts.db"));
}

function syntheticSegment(
  source: string,
  messages: readonly ModelMessage[],
  canonicalMessages = resultValue(projectStoredMessagesV1(messages)),
) {
  const storedMessages = canonicalMessages;
  return {
    atoms: [
      {
        kind: "synthetic" as const,
        source,
        messageDigest: resultValue(hashCanonicalStoredMessagesV2(storedMessages)).hash,
      },
    ],
    canonicalMessages: storedMessages,
  };
}

function fakeMaterializedRun(
  start: ClaudeNativeSessionStart,
  modelId = "sonnet",
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

function bindingFor(manifest: CoreLineageManifestV2): CorePrimaryClaudeSessionBinding {
  const segment = manifest.segments[0]!;
  return {
    bindingProtocolVersion: 1,
    providerId: "claude-code",
    providerFamily: "claude-code",
    requestClient: "discord",
    lilacSessionId: "channel",
    terminalRequestId: "terminal",
    lineageVersion: 2,
    atomCount: segment.cumulativeAtomCount,
    prefixDigest: segment.cumulativePrefixDigest,
    canonicalMessageCount: segment.canonicalEnd,
    executionScopeHashVersion: 1,
    executionScopeHash: "scope",
    claudeSessionId: crypto.randomUUID(),
    nativeCwd: "/workspace",
    nativeLastModified: 50,
    nativeContextTokens: 100,
    nativeContextMaxTokens: 1_000,
    lastModelSpecifier: "claude-code/sonnet",
    lastReasoning: "medium",
    revision: 1,
    updatedAt: 1,
  };
}

describe("Core primary Claude continuation", () => {
  it("recovers beside a crash-left uncertain attempt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "core-primary-continuation-recovery-"));
    directories.push(directory);
    const dbPath = path.join(directory, "transcripts.db");
    const sessionId = "durable-recovery-channel";
    const requestId = "durable-recovery";
    const messages = [{ role: "user", content: "recover" }] satisfies ModelMessage[];
    const lineage = buildCoreLineageManifestV2([syntheticSegment("durable-recovery", messages)]);
    const firstStore = await createStore(dbPath);
    const firstRuntime = createCorePrimaryClaudeRuntime({
      store: firstStore,
      sessionId,
      requestId,
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      getLineage: () => lineage,
      materialize: async (start) => fakeMaterializedRun(start),
    });
    await firstRuntime.prepareModelCall(prepareContext(messages));
    expect(
      firstStore.getCorePrimaryClaudeSessionAttempt({
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
    const recoveredRuntime = createCorePrimaryClaudeRuntime({
      store: recoveredStore,
      sessionId,
      requestId,
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      getLineage: () => lineage,
      materialize: async (start) => fakeMaterializedRun(start),
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    await recoveredRuntime.prepareModelCall(prepareContext(messages));

    expect(
      recoveredStore.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    expect(
      recoveredStore.getCorePrimaryClaudeSessionAttempt({
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

  it("selects only the exact ordered complete segment boundary", () => {
    const first = [{ role: "user", content: "one" }] satisfies ModelMessage[];
    const second = [{ role: "assistant", content: "two" }] satisfies ModelMessage[];
    const current = [{ role: "user", content: "three" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV2([
      syntheticSegment("one", first),
      syntheticSegment("two", second),
      syntheticSegment("three", current),
    ]);
    const binding = bindingFor(
      buildCoreLineageManifestV2([syntheticSegment("one", first), syntheticSegment("two", second)]),
    );
    const exactBinding = {
      ...binding,
      atomCount: manifest.segments[1]!.cumulativeAtomCount,
      prefixDigest: manifest.segments[1]!.cumulativePrefixDigest,
      canonicalMessageCount: manifest.segments[1]!.canonicalEnd,
    };
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: manifest,
        canonicalMessages: [...first, ...second, ...current],
        binding: exactBinding,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }),
    ).toEqual({ mode: "fork", canonicalEnd: 2 });

    const mismatches = [
      { binding: { ...exactBinding, atomCount: 99 }, reason: "atom-count-unreachable" },
      {
        binding: { ...exactBinding, prefixDigest: "00".repeat(32) },
        reason: "prefix-digest-mismatch",
      },
      {
        binding: { ...exactBinding, canonicalMessageCount: 1 },
        reason: "canonical-count-mismatch",
      },
      {
        binding: { ...exactBinding, executionScopeHash: "other" },
        reason: "scope-mismatch",
      },
      { binding: { ...exactBinding, nativeCwd: "/other" }, reason: "native-cwd-mismatch" },
    ] as const;
    for (const mismatch of mismatches) {
      expect(
        selectCorePrimaryClaudePrefix({
          lineage: manifest,
          canonicalMessages: [...first, ...second, ...current],
          binding: mismatch.binding,
          executionScopeHash: "scope",
          executionCwd: "/workspace",
        }),
      ).toEqual({ mode: "fresh", reason: mismatch.reason });
    }
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: manifest,
        canonicalMessages: [...first, ...second],
        binding: exactBinding,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }),
    ).toEqual({ mode: "fresh", reason: "canonical-alignment-mismatch" });
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: createCorePrimaryLineageFreshOnlyV2("malformed-manifest"),
        canonicalMessages: current,
        binding: exactBinding,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }),
    ).toEqual({ mode: "fresh", reason: "fresh-only" });
  });

  it("uses parallel stored resource identity for exact prefix selection", () => {
    const historicalStored = resultValue(
      projectStoredMessagesV1([
        {
          role: "user",
          content: [
            {
              type: "resource",
              uri: "resource://r1_00000000000000000000000000000001",
              filename: "image.png",
              mediaType: "image/png",
            },
          ],
        },
      ]),
    );
    const historicalProvider = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '[attachment uri="resource://r1_00000000000000000000000000000001" filename="image.png" mime="image/png"]',
          },
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
            filename: "image.png",
          },
        ],
      },
    ] satisfies ModelMessage[];
    const current = [{ role: "user", content: "current" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV2([
      syntheticSegment("resource", historicalProvider, historicalStored),
      syntheticSegment("current", current),
    ]);
    const binding = {
      ...bindingFor(
        buildCoreLineageManifestV2([
          syntheticSegment("resource", historicalProvider, historicalStored),
        ]),
      ),
      atomCount: manifest.segments[0]!.cumulativeAtomCount,
      prefixDigest: manifest.segments[0]!.cumulativePrefixDigest,
      canonicalMessageCount: manifest.segments[0]!.canonicalEnd,
    };

    expect(
      selectCorePrimaryClaudePrefix({
        lineage: manifest,
        canonicalMessages: [...historicalProvider, ...current],
        canonicalStoredMessages: [
          ...historicalStored,
          ...resultValue(projectStoredMessagesV1(current)),
        ],
        binding,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }),
    ).toEqual({ mode: "fork", canonicalEnd: 1 });
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: manifest,
        canonicalMessages: [...historicalProvider, ...current],
        binding,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }).mode,
    ).toBe("fresh");
  });

  it("does not search another segment or slice a partial segment after reorder/delete/window changes", () => {
    const merged = [{ role: "user", content: "one\n\ntwo" }] satisfies ModelMessage[];
    const current = [{ role: "user", content: "current" }] satisfies ModelMessage[];
    const base = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:channel",
            sessionId: "channel",
            messageId: "one",
          },
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:channel",
            sessionId: "channel",
            messageId: "two",
          },
        ],
        canonicalMessages: merged,
      },
    ]);
    const binding = bindingFor(base);
    const changed = buildCoreLineageManifestV2([
      syntheticSegment("other", [{ role: "user", content: "other" }]),
      syntheticSegment("current", current),
      syntheticSegment("later", [{ role: "user", content: "later" }]),
    ]);
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: changed,
        canonicalMessages: modelMessageSchema
          .array()
          .parse(changed.segments.flatMap((segment) => segment.canonicalMessages)),
        binding,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }).mode,
    ).toBe("fresh");
    expect(binding.canonicalMessageCount).toBe(1);
    expect(binding.atomCount).toBe(2);
  });

  it("text-lowers mixed history while preserving every trailing current segment", async () => {
    const store = await createStore();
    const historical = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ] satisfies ModelMessage[];
    const firstCurrent = [
      {
        role: "user",
        content: [
          { type: "text", text: "new question" },
          { type: "file", data: new Uint8Array([1]), mediaType: "image/png" },
        ],
      },
    ] satisfies ModelMessage[];
    const secondCurrent = [
      { role: "user", content: "another current message" },
    ] satisfies ModelMessage[];
    const firstCurrentStored = resultValue(
      projectStoredMessagesV1([
        {
          role: "user",
          content: [
            { type: "text", text: "new question" },
            {
              type: "blob",
              blob: {
                version: 1,
                objectId: `b1_${"11".repeat(16)}`,
                sha256: "22".repeat(32),
                byteLength: 1,
              },
              mediaType: "image/png",
            },
          ],
        },
      ]),
    );
    const lineage = buildCoreLineageManifestV2(
      [
        {
          atoms: [
            {
              kind: "request",
              requestId: "old",
              transcriptDigest: "11".repeat(32),
              providerFamily: "ai-sdk",
              containsCrossFamilyTurns: false,
            },
          ],
          requestSource: {
            aliases: [
              {
                requestClient: "discord",
                surfaceId: "discord:channel",
                sessionId: "channel",
                messageId: "old-output",
              },
            ],
          },
          canonicalMessages: historical,
        },
        syntheticSegment("current-one", firstCurrent, firstCurrentStored),
        syntheticSegment("current-two", secondCurrent),
      ],
      { currentSegmentIndex: 1 },
    );
    expect(
      shouldReplayCorePrimaryHistory({
        lineage,
        historicalEnd: historical.length,
        store,
        targetFamily: "claude-code",
      }),
    ).toBe(true);
    const returningToAi = buildCoreLineageManifestV2(
      [
        {
          ...lineage.segments[0]!,
          atoms: [
            {
              kind: "request",
              requestId: "claude-turn",
              transcriptDigest: "22".repeat(32),
              providerFamily: "claude-code",
              containsCrossFamilyTurns: true,
            },
          ],
        },
        syntheticSegment("current-return", firstCurrent, firstCurrentStored),
        syntheticSegment("current-return-two", secondCurrent),
      ],
      { currentSegmentIndex: 1 },
    );
    expect(
      shouldReplayCorePrimaryHistory({
        lineage: returningToAi,
        historicalEnd: historical.length,
        store,
        targetFamily: "ai-sdk",
      }),
    ).toBe(true);
    const prepared = prepareCorePrimaryHistoryView({
      canonicalMessages: [...historical, ...firstCurrent, ...secondCurrent],
      lineage,
      replayHistoricalPrefix: true,
      targetFamily: "claude-code",
      modelSpecifier: "claude-code/sonnet",
    });
    expect(prepared.slice(0, 1).every((message) => typeof message.content === "string")).toBe(true);
    expect(prepared.slice(1)).toEqual([...firstCurrent, ...secondCurrent]);

    const historicalSuffix = prepareCorePrimaryHistoryView({
      canonicalMessages: historical.slice(1),
      lineage,
      replayHistoricalPrefix: true,
      targetFamily: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      canonicalStartIndex: 1,
    });
    expect(historicalSuffix.every((message) => typeof message.content === "string")).toBe(true);

    const currentSuffix = prepareCorePrimaryHistoryView({
      canonicalMessages: [...firstCurrent, ...secondCurrent],
      lineage,
      replayHistoricalPrefix: true,
      targetFamily: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      canonicalStartIndex: historical.length,
    });
    expect(currentSuffix).toEqual([...firstCurrent, ...secondCurrent]);
    store.close();
  });

  it("keeps a trailing completed tool exchange structural when replay covers the full history", async () => {
    const store = await createStore();
    const messages = [
      { role: "user", content: "run lint" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "lint-call",
            toolName: "bash",
            input: { command: "bun run lint" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "lint-call",
            toolName: "bash",
            output: { type: "error-text", value: "lint failed" },
          },
        ],
      },
    ] satisfies ModelMessage[];
    const lineage = createCorePrimaryLineageFreshOnlyV2(
      "deferred-result-insertion",
      messages.length,
    );

    const prepared = prepareCorePrimaryHistoryView({
      canonicalMessages: messages,
      lineage,
      replayHistoricalPrefix: true,
      targetFamily: "ai-sdk",
      modelSpecifier: "codex/gpt-5.6-sol",
    });

    expect(prepared.slice(-2)).toEqual(messages.slice(-2));
    expect(prepared.at(-1)?.role).toBe("tool");
    store.close();
  });

  it.each([
    ["before the first result", 2],
    ["between parallel results", 3],
  ] as const)("keeps a completed tool exchange structural when replay ends %s", async (_, end) => {
    const store = await createStore();
    const messages = [
      { role: "user", content: "run checks" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "lint-call",
            toolName: "bash",
            input: { command: "bun run lint" },
          },
          {
            type: "tool-call",
            toolCallId: "test-call",
            toolName: "bash",
            input: { command: "bun test" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "lint-call",
            toolName: "bash",
            output: { type: "text", value: "lint passed" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "test-call",
            toolName: "bash",
            output: { type: "text", value: "tests passed" },
          },
        ],
      },
      { role: "user", content: "focus on the failures" },
    ] satisfies ModelMessage[];
    const lineage = createCorePrimaryLineageFreshOnlyV2("steering-transform", end);

    const prepared = prepareCorePrimaryHistoryView({
      canonicalMessages: messages,
      lineage,
      replayHistoricalPrefix: true,
      targetFamily: "ai-sdk",
      modelSpecifier: "codex/gpt-5.6-sol",
    });

    expect(prepared.slice(1)).toEqual(messages.slice(1));
    expect(typeof prepared[0]?.content).toBe("string");
    store.close();
  });

  it("promotes mixed fresh history without output IDs, then exact-forks only after reachability", async () => {
    const store = await createStore();
    const starts: ClaudeNativeSessionStart[] = [];
    const diagnostics: Array<{ event: string; detail: Readonly<Record<string, unknown>> }> = [];
    const sessionId = "channel";
    const firstInput = [{ role: "user", content: "first" }] satisfies ModelMessage[];
    const firstManifest = buildCoreLineageManifestV2([syntheticSegment("first", firstInput)]);
    let firstLineage = firstManifest;
    const firstRuntime = createCorePrimaryClaudeRuntime({
      store,
      sessionId,
      requestId: "request-1",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "low",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      getLineage: () => firstLineage,
      materialize: async (start) => {
        starts.push(start);
        return fakeMaterializedRun(start);
      },
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    expect((await firstRuntime.prepareModelCall(prepareContext(firstInput))).payload).toEqual({
      mode: "full",
    });
    const firstTerminal = [
      ...firstInput,
      { role: "assistant", content: "answer" },
    ] satisfies ModelMessage[];
    await firstRuntime.recordSuccessfulModelCall(firstTerminal);
    resultValue(
      store.saveRequestTranscript({
        requestId: "request-1",
        sessionId,
        requestClient: "discord",
        messages: resultValue(projectStoredMessagesV1([firstTerminal[1]!])),
        corePrimaryLineage: firstManifest,
      }),
    );
    const firstTranscript = getRequestTranscript(store, { requestId: "request-1" });
    if (!firstTranscript) throw new Error("first transcript missing");
    expect(
      await firstRuntime.finalize({
        terminalTranscript: firstTranscript,
        canonicalMessages: firstTerminal,
        providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: true },
        isCancellationRequested: () => false,
      }),
    ).toBe(true);
    expect(store.listSurfaceMessagesForRequest({ requestId: "request-1" })).toEqual([]);
    const clean = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!clean) throw new Error("clean binding missing");

    const earlyInput = [{ role: "user", content: "early" }] satisfies ModelMessage[];
    const earlyLineage = buildCoreLineageManifestV2([syntheticSegment("early", earlyInput)]);
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: earlyLineage,
        canonicalMessages: earlyInput,
        binding: clean,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }).mode,
    ).toBe("fresh");
    const cancelledRuntime = createCorePrimaryClaudeRuntime({
      store,
      sessionId,
      requestId: "cancelled-after-clean",
      providerId: "claude-code",
      modelSpecifier: "claude-code/opus",
      reasoning: "high",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      getLineage: () => earlyLineage,
      materialize: async (start) => fakeMaterializedRun(start, "opus"),
    });
    await cancelledRuntime.prepareModelCall(prepareContext(earlyInput));
    cancelledRuntime.markTerminalFailure(true);
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toEqual(clean);
    await cancelledRuntime.retireAtRunEnd();

    const outputMessages = [firstTerminal[1]!] satisfies ModelMessage[];
    const outputKey = {
      requestClient: "discord",
      surfaceId: `discord:${sessionId}`,
      sessionId,
      messageId: "output-1",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    store.admitCoreSurfaceProjection({
      ...outputKey,
      canonicalMessages: [{ role: "assistant", content: "visible answer" }],
      sourceFacts: {},
      ownedBlobs: [],
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "request-1",
      created: [{ platform: "discord", channelId: sessionId, messageId: "output-1" }],
      last: { platform: "discord", channelId: sessionId, messageId: "output-1" },
    });
    const metadata = getCoreRequestAtomMetadata(store, { requestId: "request-1" });
    if (!metadata) throw new Error("request metadata missing");
    const secondCurrent = [{ role: "user", content: "second" }] satisfies ModelMessage[];
    const secondManifest = buildCoreLineageManifestV2([
      syntheticSegment("first", firstInput),
      {
        atoms: [{ kind: "request", ...metadata }],
        requestSource: {
          aliases: [
            {
              requestClient: "discord",
              surfaceId: `discord:${sessionId}`,
              sessionId,
              messageId: "output-1",
            },
          ],
        },
        canonicalMessages: outputMessages,
      },
      syntheticSegment("second", secondCurrent),
    ]);
    const returnedFromApi: CorePrimaryLineageV2 = {
      ...secondManifest,
      segments: secondManifest.segments.map((segment) => ({
        ...segment,
        atoms: segment.atoms.map((atom) =>
          atom.kind === "request" ? { ...atom, providerFamily: "ai-sdk" as const } : atom,
        ),
      })),
    };
    expect(
      selectCorePrimaryClaudePrefix({
        lineage: returnedFromApi,
        canonicalMessages: [...firstInput, ...outputMessages, ...secondCurrent],
        binding: clean,
        executionScopeHash: "scope",
        executionCwd: "/workspace",
      }),
    ).toEqual({ mode: "fresh", reason: "fresh-only" });
    const secondInput = [...firstInput, ...outputMessages, ...secondCurrent];
    const secondRuntime = createCorePrimaryClaudeRuntime({
      store,
      sessionId,
      requestId: "request-2",
      providerId: "claude-code",
      modelSpecifier: "claude-code/opus",
      reasoning: "xhigh",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      getLineage: () => secondManifest,
      materialize: async (start) => {
        starts.push(start);
        return fakeMaterializedRun(start, "opus");
      },
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    expect((await secondRuntime.prepareModelCall(prepareContext(secondInput))).payload).toEqual({
      mode: "suffix",
      startIndex: 2,
    });
    expect(starts[1]).toMatchObject({
      mode: "fork",
      baseSessionId: clean.claudeSessionId,
    });
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
        (entry) => entry.event === "promotion" && entry.detail["requestId"] === "request-1",
      )?.detail,
    ).toMatchObject({ mode: "cas", reason: "binding-promoted", promoted: true });
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
    firstLineage = firstManifest;
    await firstRuntime.retireAtRunEnd();
    await secondRuntime.retireAtRunEnd();
    store.close();
  });

  it("retires a compacted candidate and preserves the clean base on cancellation", async () => {
    const store = await createStore();
    const messages = [{ role: "user", content: "candidate" }] satisfies ModelMessage[];
    let lineage: CorePrimaryLineageV2 = buildCoreLineageManifestV2([
      syntheticSegment("candidate", messages),
    ]);
    const runtime = createCorePrimaryClaudeRuntime({
      store,
      sessionId: "channel",
      requestId: "cancelled",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      getLineage: () => lineage,
      materialize: async (start) => fakeMaterializedRun(start),
    });
    await runtime.prepareModelCall(prepareContext(messages));
    lineage = createCorePrimaryLineageFreshOnlyV2("compaction-checkpoint-transform");
    await runtime.retireForCanonicalReplacement();
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "channel",
        requestId: "cancelled",
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");
    await runtime.prepareModelCall(prepareContext(messages));
    runtime.markTerminalFailure(true);
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "channel",
      }),
    ).toBeNull();
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "channel",
        requestId: "cancelled",
        attemptIndex: 2,
      })?.state,
    ).toBe("cancelled");
    await runtime.retireAtRunEnd();
    store.close();
  });

  it("reports a post-publication promotion exception without relabeling native finalization", async () => {
    const store = await createStore();
    const diagnostics: Array<{ event: string; detail: Readonly<Record<string, unknown>> }> = [];
    const sessionId = "promotion-error-channel";
    const inputMessages = [{ role: "user", content: "publish first" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV2([
      syntheticSegment("promotion-error", inputMessages),
    ]);
    const runtime = createCorePrimaryClaudeRuntime({
      store,
      sessionId,
      requestId: "promotion-error",
      providerId: "claude-code",
      modelSpecifier: "claude-code/sonnet",
      reasoning: "medium",
      executionScopeHash: "scope",
      executionCwd: "/workspace",
      getLineage: () => manifest,
      materialize: async (start) => fakeMaterializedRun(start),
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    await runtime.prepareModelCall(prepareContext(inputMessages));
    const responseMessages = [{ role: "assistant", content: "published" }] satisfies ModelMessage[];
    const canonicalMessages = [...inputMessages, ...responseMessages];
    await runtime.recordSuccessfulModelCall(canonicalMessages);
    resultValue(
      store.saveRequestTranscript({
        requestId: "promotion-error",
        sessionId,
        requestClient: "discord",
        messages: resultValue(projectStoredMessagesV1(responseMessages)),
        corePrimaryLineage: manifest,
      }),
    );
    const terminal = getRequestTranscript(store, { requestId: "promotion-error" });
    if (!terminal) throw new Error("terminal transcript missing");
    store.promoteCorePrimaryClaudeSessionBinding = () =>
      Result.err(
        new TranscriptStoreSqliteDriverFailure({
          operation: "promote primary binding",
          code: "SQLITE_IOERR",
          message: "simulated promotion database failure",
        }),
      );

    expect(
      await runtime.finalize({
        terminalTranscript: terminal,
        canonicalMessages,
        providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
        isCancellationRequested: () => false,
      }),
    ).toBe(false);
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
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
});

describe("primary handoffs without Discord lineage", () => {
  it.each(["claude-code", "ai-sdk"] as const)(
    "hands off text-only history from %s",
    (lastFamily) => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Remember the task" },
        { role: "assistant", content: "We are fixing the provider" },
        { role: "user", content: "Continue" },
      ];
      const input = {
        canonicalMessages: messages,
        lineage: undefined,
        replayHistoricalPrefix: false,
        sourceProviderState: { lastFamily, containsCrossFamilyTurns: false },
        modelSpecifier: "test/model",
      };
      const targetFamily = lastFamily === "claude-code" ? "ai-sdk" : "claude-code";
      const projected = prepareCorePrimaryHistoryView({ ...input, targetFamily });
      expect(projected[0]?.content).toContain("[Conversation handoff]");
      expect(projected.slice(1)).toEqual(messages.slice(-1));
      expect(prepareCorePrimaryHistoryView({ ...input, targetFamily: lastFamily })).toEqual(
        messages,
      );
    },
  );

  it.each([false, true])(
    "makes retained Claude tool history portable after compaction=%s",
    async (compacted) => {
      const foreign: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "computer",
              toolName: "mcp_computer_use_execute",
              input: { code: "inspect screen" },
              providerExecuted: true,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "computer",
              toolName: "mcp_computer_use_execute",
              output: { type: "text", value: "screen capture ".repeat(1000) },
            },
          ],
        },
        { role: "assistant", content: "Inspected the screen." },
      ];
      const current: ModelMessage[] = [
        { role: "user", content: "What context did you receive?" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "current", toolName: "read", input: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "current",
              toolName: "read",
              output: { type: "text", value: "current result" },
            },
          ],
        },
      ];
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: compacted ? "Earlier conversation summary" : "Old computer task ".repeat(1000),
        },
        ...foreign,
        ...current,
      ];
      const original = structuredClone(messages);
      expect((await openAIRequestCodec.messages(messages)).status).toBe("error");
      const projected = prepareCorePrimaryHistoryView({
        canonicalMessages: messages,
        lineage: undefined,
        replayHistoricalPrefix: false,
        targetFamily: "ai-sdk",
        modelSpecifier: "codex/gpt-6-astra",
      });
      expect(projected[0]?.content).toContain("[Conversation handoff]");
      expect(projected.slice(1)).toEqual(current);
      expect((await openAIRequestCodec.messages(projected)).status).toBe("ok");
      expect(messages).toEqual(original);
    },
  );

  it("preserves same-family API tool history without a handoff", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "read", toolName: "read", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "read",
            output: { type: "text", value: "read result" },
          },
        ],
      },
      { role: "user", content: "Continue" },
    ];
    expect(
      prepareCorePrimaryHistoryView({
        canonicalMessages: messages,
        lineage: undefined,
        replayHistoricalPrefix: false,
        targetFamily: "ai-sdk",
        modelSpecifier: "codex/gpt-6-astra",
      }),
    ).toEqual(messages);
  });
});
