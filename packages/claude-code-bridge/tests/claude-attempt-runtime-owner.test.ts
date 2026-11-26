import { describe, expect, it } from "bun:test";
import type { PrepareModelCallContext } from "@stanley2058/lilac-agent";
import type { ModelMessage } from "ai";
import { createClaudeCode } from "@stanley2058/lilac-utils/claude-sdk";
import { Result } from "better-result";

import {
  ClaudeAttemptRuntimeOwner,
  type ClaudeAttemptRuntimeCandidate,
} from "../claude-attempt-runtime-owner";
import {
  ClaudeCodeRunCleanupFailed,
  ClaudeCodeRunInvalidConfiguration,
  type ClaudeNativeAttemptObservation,
  type MaterializedClaudeCodeRun,
} from "../claude-code-run";

const model = createClaudeCode()("sonnet");

function userMessage(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantMessage(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

function prepareContext(
  canonicalMessages: readonly ModelMessage[],
  fullBudgetView: readonly ModelMessage[] = canonicalMessages,
): PrepareModelCallContext {
  return {
    canonicalMessages,
    fullBudgetView,
    runtime: { model, modelSpecifier: "fallback/model", executionMode: "local-tools" },
    payload: { mode: "full" },
    transformContext: { system: "system", tools: {} },
  };
}

function nativeObservation(
  sessionId: string | null,
  usage: { readonly tokens: number; readonly maxTokens: number } | null = null,
): ClaudeNativeAttemptObservation {
  return {
    requestedSessionId: sessionId,
    sourceSessionId: null,
    initSessionId: sessionId,
    resultSessionId: sessionId,
    contextTokens: usage?.tokens ?? null,
    contextMaxTokens: usage?.maxTokens ?? null,
    requestedModel: "sonnet",
    initializedModel: null,
    requestedReasoning: null,
    providerWarnings: [],
    invoked: false,
    requiredObservabilityError: null,
    callbackError: null,
  };
}

function fakeRun(options: {
  readonly sessionId?: string | null;
  readonly sourceSessionId?: string | null;
  readonly withNativeLifecycle?: boolean;
  readonly initialUsage?: { readonly tokens: number; readonly maxTokens: number } | null;
  readonly cleanupFails?: boolean;
}) {
  let observation = nativeObservation(
    options.sessionId === undefined ? "candidate-session" : options.sessionId,
    options.initialUsage,
  );
  observation = { ...observation, sourceSessionId: options.sourceSessionId ?? null };
  let nextWaitObservation: ClaudeNativeAttemptObservation | null = null;
  let disposeCalls = 0;
  const run: MaterializedClaudeCodeRun = {
    agentModel: createClaudeCode()("sonnet"),
    continuationModel: createClaudeCode()("sonnet"),
    createUtilityModelResult: () => Result.ok(createClaudeCode()("sonnet")),
    createUtilityModel: () => createClaudeCode()("sonnet"),
    control: {
      inject: () => false,
      interruptResult: async () => Result.ok(false),
      interrupt: async () => false,
      clearResult: () => Result.ok(),
      clear: () => undefined,
    },
    ...(options.withNativeLifecycle === false
      ? {}
      : {
          nativeSession: {
            getObservation: () => observation,
            waitForObservation: async () => {
              const next = nextWaitObservation ?? observation;
              nextWaitObservation = null;
              return next;
            },
            recordWarning: () => undefined,
            finalizeResult: async () =>
              Result.err(
                new ClaudeCodeRunInvalidConfiguration({
                  message: "not finalized by the process-local owner",
                }),
              ),
            finalize: async () => {
              throw new Error("not finalized by the process-local owner");
            },
          },
        }),
    dispose: async () => {
      disposeCalls += 1;
    },
    disposeResult: async () => {
      disposeCalls += 1;
      return options.cleanupFails
        ? Result.err(
            new ClaudeCodeRunCleanupFailed({
              failures: [],
              message: "test cleanup failed",
            }),
          )
        : Result.ok();
    },
  };
  return {
    run,
    setUsage(usage: { readonly tokens: number; readonly maxTokens: number } | null) {
      observation = {
        ...nativeObservation(observation.requestedSessionId, usage),
        sourceSessionId: observation.sourceSessionId,
      };
    },
    setObservation(next: ClaudeNativeAttemptObservation) {
      observation = next;
    },
    setNextWaitObservation(next: ClaudeNativeAttemptObservation) {
      nextWaitObservation = next;
    },
    get disposeCalls() {
      return disposeCalls;
    },
  };
}

function candidate(
  run: MaterializedClaudeCodeRun,
  initialPayload: ClaudeAttemptRuntimeCandidate["initialPayload"] = { mode: "full" },
): ClaudeAttemptRuntimeCandidate {
  return {
    run,
    modelSpecifier: "claude-code/claude-sonnet-4-6",
    initialPayload,
  };
}

describe("ClaudeAttemptRuntimeOwner", () => {
  it("preserves candidate validation and cleanup failures together", async () => {
    const fake = fakeRun({ withNativeLifecycle: false, cleanupFails: true });
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });

    const prepared = await owner.prepareResult(prepareContext([]));
    expect(prepared.status).toBe("error");
    if (prepared.status === "error") {
      expect(prepared.error._tag).toBe("ClaudeAttemptRuntimeOperationAndCleanupFailed");
      if (prepared.error._tag === "ClaudeAttemptRuntimeOperationAndCleanupFailed") {
        expect(prepared.error.operationError._tag).toBe("ClaudeAttemptRuntimeCandidateFailed");
        expect(prepared.error.cleanupError._tag).toBe("ClaudeAttemptRuntimeCleanupFailed");
      }
    }
  });

  it("materializes lazily once and selects a provider-tools runtime", async () => {
    const fake = fakeRun({});
    let factoryCalls = 0;
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: { admittedHead: "head-1" },
      createCandidate: async () => {
        factoryCalls += 1;
        return candidate(fake.run);
      },
    });
    const context = prepareContext([userMessage("one")]);

    expect(factoryCalls).toBe(0);
    const first = await owner.prepare(context);
    const second = await owner.prepare(context);

    expect(factoryCalls).toBe(1);
    expect(first).toEqual(second);
    expect(first).toEqual({
      runtime: {
        model: fake.run.agentModel,
        modelSpecifier: "claude-code/claude-sonnet-4-6",
        executionMode: "provider-tools",
        persistentAttemptIdentity: "candidate-session",
        streamTextMaxRetries: 0,
      },
      payload: { mode: "full" },
    });
  });

  it("uses the initial full payload, then advances an exact canonical suffix and usage cursor", async () => {
    const fake = fakeRun({});
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    const firstCanonical = [userMessage("one")];

    expect((await owner.prepare(prepareContext(firstCanonical))).payload).toEqual({ mode: "full" });
    fake.setUsage({ tokens: 1_250, maxTokens: 200_000 });
    await owner.recordSuccessfulModelCall([...firstCanonical, assistantMessage("one response")]);

    expect(owner.state.cursor).toEqual({
      canonicalMessageCount: 2,
      canonicalPrefixHash: expect.any(String),
      nativeContextTokens: 1_250,
      nativeContextMaxTokens: 200_000,
    });
    const nextCanonical = [
      userMessage("one"),
      assistantMessage("one response"),
      userMessage("three"),
    ];
    expect((await owner.prepare(prepareContext(nextCanonical))).payload).toEqual({
      mode: "suffix",
      startIndex: 2,
    });
  });

  it("makes a candidate unusable and blocks later preparation when terminal usage is missing", async () => {
    const fake = fakeRun({});
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    const context = prepareContext([userMessage("one")]);
    await owner.prepare(context);

    await owner.recordSuccessfulModelCall(context.canonicalMessages);

    expect(fake.disposeCalls).toBe(1);
    expect(owner.state).toMatchObject({
      phase: "unusable",
      cursor: { canonicalMessageCount: 0 },
      unusableReason: "terminal native context usage is missing",
    });
    await expect(owner.prepare(context)).rejects.toThrow(
      "terminal native context usage is missing",
    );
  });

  it("blocks continuation when terminal native identity does not match the candidate", async () => {
    const fake = fakeRun({});
    fake.setObservation({
      ...nativeObservation("candidate-session", { tokens: 100, maxTokens: 1_000 }),
      resultSessionId: "different-session",
    });
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    const canonical = [userMessage("one")];
    await owner.prepare(prepareContext(canonical));

    await expect(owner.recordSuccessfulModelCall(canonical)).rejects.toThrow(
      "terminal native session identity is missing, mismatched, or conflicting",
    );

    expect(fake.disposeCalls).toBe(1);
    await expect(owner.prepare(prepareContext(canonical))).rejects.toThrow(
      "terminal native session identity is missing, mismatched, or conflicting",
    );
  });

  it("blocks a second cursor advancement without fresh init and result identity", async () => {
    const fake = fakeRun({});
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    const first = [userMessage("one")];
    await owner.prepare(prepareContext(first));
    fake.setUsage({ tokens: 100, maxTokens: 1_000 });
    const firstCompleted = [...first, assistantMessage("response")];
    await owner.recordSuccessfulModelCall(firstCompleted);

    const second = [...firstCompleted, userMessage("continue")];
    await owner.prepare(prepareContext(second));
    fake.setNextWaitObservation({
      ...nativeObservation("candidate-session", { tokens: 150, maxTokens: 1_000 }),
      initSessionId: null,
      resultSessionId: null,
    });

    await expect(
      owner.recordSuccessfulModelCall([...second, assistantMessage("second response")]),
    ).rejects.toThrow("terminal native session identity is missing, mismatched, or conflicting");
    expect(fake.disposeCalls).toBe(1);
    expect(owner.state.phase).toBe("unusable");
  });

  it("adds only the unsynchronized estimate and lets current lower usage supersede stored usage", async () => {
    const fake = fakeRun({});
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    expect(
      owner.getNativeInputEstimateFloor({ unsynchronizedSuffixAndOverlayEstimate: 300 }),
    ).toBeNull();
    expect(
      owner.getNativeInputEstimateFloor({
        unsynchronizedSuffixAndOverlayEstimate: 300,
        storedNativeContextTokens: 900,
      }),
    ).toBe(1_200);

    const canonical = [userMessage("one")];
    await owner.prepare(prepareContext(canonical));
    fake.setUsage({ tokens: 250, maxTokens: 2_000 });
    await owner.recordSuccessfulModelCall(canonical);
    const cursorBefore = owner.state.cursor;

    expect(
      owner.getNativeInputEstimateFloor({
        unsynchronizedSuffixAndOverlayEstimate: 300,
        storedNativeContextTokens: 900,
      }),
    ).toBe(550);
    expect(owner.state.cursor).toEqual(cursorBefore);
  });

  it("rejects invalid native floor estimates", () => {
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fakeRun({}).run),
    });

    expect(() =>
      owner.getNativeInputEstimateFloor({
        unsynchronizedSuffixAndOverlayEstimate: Number.NaN,
      }),
    ).toThrow("Unsynchronized suffix and overlay estimate must be finite and non-negative");
    expect(() =>
      owner.getNativeInputEstimateFloor({
        unsynchronizedSuffixAndOverlayEstimate: 10,
        storedNativeContextTokens: -1,
      }),
    ).toThrow("Stored native context tokens must be finite and non-negative");
  });

  it("keeps optional callback failures eligible for continuation", async () => {
    const fake = fakeRun({});
    fake.setObservation({
      ...nativeObservation("candidate-session", { tokens: 100, maxTokens: 1_000 }),
      callbackError: "optional observer failed",
    });
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    const canonical = [userMessage("one")];
    await owner.prepare(prepareContext(canonical));

    await owner.recordSuccessfulModelCall(canonical);

    expect(owner.state.phase).toBe("active");
    expect(owner.state.cursor?.nativeContextTokens).toBe(100);
    expect(fake.disposeCalls).toBe(0);
  });

  it("blocks continuation after a required observability failure", async () => {
    const fake = fakeRun({});
    fake.setObservation({
      ...nativeObservation("candidate-session", { tokens: 100, maxTokens: 1_000 }),
      requiredObservabilityError: "required observer failed",
      callbackError: "required observer failed",
    });
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    const canonical = [userMessage("one")];
    await owner.prepare(prepareContext(canonical));

    await expect(owner.recordSuccessfulModelCall(canonical)).rejects.toThrow(
      "terminal native session identity is missing, mismatched, or conflicting",
    );
    expect(owner.state.phase).toBe("unusable");
    expect(fake.disposeCalls).toBe(1);
  });

  it("replaces a caller-approved retry with a distinct candidate and stable factory context", async () => {
    const firstRun = fakeRun({ sessionId: "candidate-1" });
    const secondRun = fakeRun({ sessionId: "candidate-2" });
    const runs = [firstRun, secondRun];
    const inputs = { admittedHead: "head-1" };
    const factoryRequests: Array<{
      readonly attemptIndex: number;
      readonly inputs: typeof inputs;
      readonly prepareContext: PrepareModelCallContext;
    }> = [];
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: inputs,
      createCandidate: async (request) => {
        factoryRequests.push(request);
        const next = runs[request.attemptIndex];
        if (!next) throw new Error("unexpected attempt");
        return candidate(next.run);
      },
    });
    const firstContext = prepareContext([userMessage("one")]);
    const retryContext = prepareContext([userMessage("one")]);

    await owner.prepare(firstContext);
    await owner.retireForRetry();
    const retried = await owner.prepare(retryContext);

    expect(firstRun.disposeCalls).toBe(1);
    expect(retried.runtime.model).toBe(secondRun.run.agentModel);
    expect(retried.runtime.persistentAttemptIdentity).toBe("candidate-2");
    expect(factoryRequests.map(({ attemptIndex }) => attemptIndex)).toEqual([0, 1]);
    expect(factoryRequests[0]?.inputs).toBe(inputs);
    expect(factoryRequests[1]?.inputs).toBe(inputs);
    expect(factoryRequests[0]?.prepareContext).toBe(firstContext);
    expect(factoryRequests[1]?.prepareContext).toBe(firstContext);
  });

  it("resets the cursor and factory context after canonical replacement", async () => {
    const runs = [fakeRun({ sourceSessionId: "source-session" }), fakeRun({})];
    const factoryContexts: PrepareModelCallContext[] = [];
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async ({ attemptIndex, prepareContext: context }) => {
        factoryContexts.push(context);
        const next = runs[attemptIndex];
        if (!next) throw new Error("unexpected attempt");
        return candidate(
          next.run,
          attemptIndex === 0 ? { mode: "suffix", startIndex: 1 } : undefined,
        );
      },
    });
    const original = prepareContext([userMessage("base"), userMessage("new")]);
    await owner.prepare(original);
    runs[0]?.setUsage({ tokens: 100, maxTokens: 1_000 });
    await owner.recordSuccessfulModelCall(original.canonicalMessages);

    await owner.retireForCanonicalReplacement();

    expect(runs[0]?.disposeCalls).toBe(1);
    expect(owner.state.cursor).toBeNull();
    const replacement = prepareContext([userMessage("compacted")]);
    expect((await owner.prepare(replacement)).payload).toEqual({ mode: "full" });
    expect(factoryContexts).toEqual([original, replacement]);
    expect(owner.state.attemptIndex).toBe(1);
  });

  it("rejects canonical replacement between preparation and successful-call recording", async () => {
    const fake = fakeRun({});
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    await owner.prepare(prepareContext([userMessage("original")]));
    fake.setUsage({ tokens: 100, maxTokens: 1_000 });

    await expect(owner.recordSuccessfulModelCall([userMessage("replacement")])).rejects.toThrow(
      "canonical history changed after model-call preparation",
    );

    expect(fake.disposeCalls).toBe(1);
    expect(owner.state).toMatchObject({
      phase: "unusable",
      cursor: { canonicalMessageCount: 0 },
    });
  });

  it("retires at run end idempotently", async () => {
    const fake = fakeRun({});
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    const context = prepareContext([userMessage("one")]);
    await owner.prepare(context);

    const firstRetirement = owner.retireAtRunEnd();
    const secondRetirement = owner.retireAtRunEnd();
    expect(secondRetirement).toBe(firstRetirement);
    await Promise.all([firstRetirement, secondRetirement]);

    expect(fake.disposeCalls).toBe(1);
    expect(owner.state.phase).toBe("retired");
    await expect(owner.prepare(context)).rejects.toThrow("run-end retirement");
  });

  it("rejects and disposes missing and ephemeral native lifecycle candidates", async () => {
    const missing = fakeRun({ withNativeLifecycle: false });
    const missingOwner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(missing.run),
    });
    await expect(missingOwner.prepare(prepareContext([]))).rejects.toThrow(
      "native session lifecycle is missing",
    );
    expect(missing.disposeCalls).toBe(1);

    const ephemeral = fakeRun({ sessionId: null });
    const ephemeralOwner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(ephemeral.run),
    });
    await expect(ephemeralOwner.prepare(prepareContext([]))).rejects.toThrow(
      "ephemeral native sessions are not supported",
    );
    expect(ephemeral.disposeCalls).toBe(1);
  });

  it("rejects and disposes an out-of-bounds initial suffix", async () => {
    const fake = fakeRun({ sourceSessionId: "source-session" });
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run, { mode: "suffix", startIndex: 2 }),
    });

    await expect(owner.prepare(prepareContext([userMessage("one")]))).rejects.toThrow(
      "canonical suffix 2 exceeds message count 1",
    );
    expect(fake.disposeCalls).toBe(1);
  });

  it("counts canonical messages only and ignores full-budget overlays", async () => {
    const fake = fakeRun({ sourceSessionId: "source-session" });
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run, { mode: "suffix", startIndex: 1 }),
    });
    const canonical = [userMessage("base"), userMessage("current")];
    const budgetView = [...canonical, userMessage("overlay one"), userMessage("overlay two")];

    expect((await owner.prepare(prepareContext(canonical, budgetView))).payload).toEqual({
      mode: "suffix",
      startIndex: 1,
    });
    fake.setUsage({ tokens: 300, maxTokens: 1_000 });
    await owner.recordSuccessfulModelCall(canonical);
    expect(owner.state.cursor?.canonicalMessageCount).toBe(2);

    const nextCanonical = [...canonical, userMessage("next")];
    const nextBudget = [...nextCanonical, userMessage("different overlay")];
    expect((await owner.prepare(prepareContext(nextCanonical, nextBudget))).payload).toEqual({
      mode: "suffix",
      startIndex: 2,
    });
  });

  it("rejects and disposes fresh suffix and fork full payload combinations", async () => {
    const fresh = fakeRun({});
    const freshOwner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fresh.run, { mode: "suffix", startIndex: 0 }),
    });
    await expect(freshOwner.prepare(prepareContext([]))).rejects.toThrow(
      "fresh sessions require a full initial payload",
    );
    expect(fresh.disposeCalls).toBe(1);

    const fork = fakeRun({ sourceSessionId: "source-session" });
    const forkOwner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fork.run, { mode: "full" }),
    });
    await expect(forkOwner.prepare(prepareContext([]))).rejects.toThrow(
      "fork sessions require a suffix initial payload",
    );
    expect(fork.disposeCalls).toBe(1);
  });

  it("uses the continuation model only after successful cursor advancement", async () => {
    const fake = fakeRun({});
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async () => candidate(fake.run),
    });
    const initial = [userMessage("one")];

    expect((await owner.prepare(prepareContext(initial))).runtime.model).toBe(fake.run.agentModel);
    fake.setUsage({ tokens: 100, maxTokens: 1_000 });
    const synchronized = [...initial, assistantMessage("response"), userMessage("continue")];
    await owner.recordSuccessfulModelCall(synchronized);

    expect((await owner.prepare(prepareContext(synchronized))).runtime.model).toBe(
      fake.run.continuationModel!,
    );
  });

  it("rematerializes on same-length and longer synchronized-prefix replacement", async () => {
    const runs = [
      fakeRun({ sourceSessionId: "source-1" }),
      fakeRun({}),
      fakeRun({ sourceSessionId: "source-2" }),
      fakeRun({}),
    ];
    const contexts: PrepareModelCallContext[] = [];
    const owner = new ClaudeAttemptRuntimeOwner({
      factoryInputs: null,
      createCandidate: async ({ attemptIndex, prepareContext: context }) => {
        contexts.push(context);
        const next = runs[attemptIndex];
        if (!next) throw new Error("unexpected attempt");
        return candidate(
          next.run,
          attemptIndex % 2 === 0 ? { mode: "suffix", startIndex: 1 } : { mode: "full" },
        );
      },
    });

    const original = [userMessage("base"), userMessage("current")];
    await owner.prepare(prepareContext(original));
    runs[0]?.setUsage({ tokens: 100, maxTokens: 1_000 });
    await owner.recordSuccessfulModelCall(original);

    const sameLength = [userMessage("replacement"), userMessage("current")];
    expect((await owner.prepare(prepareContext(sameLength))).payload).toEqual({ mode: "full" });
    expect(runs[0]?.disposeCalls).toBe(1);

    await owner.retireForCanonicalReplacement();
    const nextOriginal = [userMessage("base two"), userMessage("current two")];
    await owner.prepare(prepareContext(nextOriginal));
    runs[2]?.setUsage({ tokens: 200, maxTokens: 1_000 });
    await owner.recordSuccessfulModelCall(nextOriginal);

    const longerReplacement = [
      userMessage("changed base"),
      userMessage("inserted"),
      userMessage("current two"),
    ];
    expect((await owner.prepare(prepareContext(longerReplacement))).payload).toEqual({
      mode: "full",
    });
    expect(runs[2]?.disposeCalls).toBe(1);
    expect(contexts).toEqual([
      expect.anything(),
      expect.objectContaining({ canonicalMessages: sameLength }),
      expect.objectContaining({ canonicalMessages: nextOriginal }),
      expect.objectContaining({ canonicalMessages: longerReplacement }),
    ]);
  });
});
