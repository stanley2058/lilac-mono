import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createLilacBus,
  lilacEventTypes,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import {
  RESPONSE_COMMENTARY_INSTRUCTIONS,
  createLogger,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import type { ModelMessage } from "ai";
import type { LanguageModel } from "ai";

import {
  appendAdditionalSessionMemoBlock,
  createDeferredSubagentManager,
  buildHeartbeatOverlayForRequest,
  buildPersistedHeartbeatMessages,
  mergeToSingleUserMessage,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
  shouldCancelRunPolicyRequest,
  shouldCancelIdleOnlyGlobalRequest,
  toOpenAIPromptCacheKey,
  withBlankLineBetweenTextParts,
  withReasoningSummaryDefaultForOpenAIModels,
} from "../../../src/surface/bridge/bus-agent-runner";

function fakeModel(): LanguageModel {
  return {} as LanguageModel;
}

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, { cursor: id, commit: async () => {} });
      }

      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        opts,
        handler: handler as unknown as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
      };
      subs.add(entry);

      const offset = opts.offset;
      if (offset?.type === "begin" || offset?.type === "cursor") {
        const existing = topics.get(topic) ?? [];
        const replay =
          offset.type === "cursor"
            ? (() => {
                const cursorIndex = existing.findIndex((m) => m.id === offset.cursor);
                return cursorIndex >= 0 ? existing.slice(cursorIndex + 1) : existing;
              })()
            : existing;
        for (const m of replay) {
          await handler(m as unknown as Message<TData>, {
            cursor: m.id,
            commit: async () => {},
          });
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },

    fetch: async <TData>(topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m as unknown as Message<TData>,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]?.id : undefined,
      };
    },

    close: async () => {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(1);
  }
}

describe("toOpenAIPromptCacheKey", () => {
  it("returns the session id when it fits provider limits", () => {
    const sessionId = "sub:abc123";

    expect(toOpenAIPromptCacheKey(sessionId)).toBe(sessionId);
  });

  it("hashes long session ids down to 64 chars", () => {
    const sessionId =
      "sub:680343695673131032:sub:req:7984efa2-6f00-41c5-b1d0-bf77ada46e59:309873d2-712a-424e-9dd1-45273b4655d9";

    const key = toOpenAIPromptCacheKey(sessionId);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).not.toBe(sessionId);
  });
});

describe("withReasoningSummaryDefaultForOpenAIModels", () => {
  it("does not inject reasoning summary when display is none", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "none",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toBeUndefined();
  });

  it("injects detailed reasoning summary for openai provider", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: undefined,
    });

    expect(next).toEqual({
      openai: {
        reasoningSummary: "detailed",
      },
    });
  });

  it("injects for vercel/openai/* and openrouter/openai/* models", () => {
    const vercel = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "openai/gpt-5",
      providerOptions: { gateway: { order: ["openai"] } },
    });

    const openrouter = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
      providerOptions: { openrouter: { route: "fallback" } },
    });

    expect(vercel?.openai?.reasoningSummary).toBe("detailed");
    expect(openrouter?.openai?.reasoningSummary).toBe("detailed");
  });

  it("does not override explicit reasoningSummary", () => {
    const next = withReasoningSummaryDefaultForOpenAIModels({
      reasoningDisplay: "simple",
      provider: "openai",
      modelId: "gpt-5",
      providerOptions: {
        openai: {
          reasoningSummary: "auto",
          parallelToolCalls: true,
        },
      },
    });

    expect(next).toEqual({
      openai: {
        reasoningSummary: "auto",
        parallelToolCalls: true,
      },
    });
  });
});

describe("resolveSessionAdditionalPrompts", () => {
  it("keeps literal prompts and drops empty entries", async () => {
    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["  Keep answers short.  ", "\n\n", "   "],
    });

    expect(prompts).toEqual(["Keep answers short."]);
  });

  it("loads file:// prompts with filename and location header", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-runner-prompts-"));
    try {
      const memoPath = path.join(dir, "session-notes.md");
      await writeFile(memoPath, "be strict about scope\n", "utf8");

      const prompts = await resolveSessionAdditionalPrompts({
        entries: [pathToFileURL(memoPath).toString()],
      });

      expect(prompts).toEqual([`# session-notes.md (${memoPath})\nbe strict about scope`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips unreadable file prompts and reports a warning", async () => {
    const warnings: string[] = [];

    const prompts = await resolveSessionAdditionalPrompts({
      entries: ["file:///tmp/does-not-exist-session-prompt.md"],
      onWarn: (warning) => warnings.push(warning.reason),
    });

    expect(prompts).toEqual([]);
    expect(warnings).toEqual(["read_failed"]);
  });
});

describe("appendAdditionalSessionMemoBlock", () => {
  it("appends Additional Session Memo at the end", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["Line one", "Line two"]);

    expect(out).toBe("Base prompt\n\nAdditional Session Memo:\nLine one\n\nLine two");
  });

  it("omits the block when combined memo is empty", () => {
    const out = appendAdditionalSessionMemoBlock("Base prompt", ["  ", "\n\n"]);
    expect(out).toBe("Base prompt");
  });
});

describe("heartbeat overlays", () => {
  it("adds ordinary-session request metadata when heartbeat is enabled", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "discord:1:2",
      sessionId: "chan",
      runProfile: "primary",
      nowMs: 0,
    });

    expect(overlay).toContain("Heartbeat Context");
    expect(overlay).toContain("sourceSessionId='chan'");
    expect(overlay).toContain("sourceRequestId='discord:1:2'");
  });

  it("adds heartbeat quiet-hours context for heartbeat session", () => {
    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          cron: "*/30 * * * *",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
          softQuietHours: {
            start: "23:00",
            end: "08:00",
            timezone: "UTC",
          },
        },
      },
    } as unknown as Pick<CoreConfig, "surface">;

    const overlay = buildHeartbeatOverlayForRequest({
      cfg,
      requestId: "heartbeat:1",
      sessionId: "__heartbeat__",
      runProfile: "primary",
      nowMs: Date.UTC(2026, 2, 11, 23, 30, 0),
    });

    expect(overlay).toContain("Heartbeat Quiet Hours");
    expect(overlay).toContain("Current local quiet-hours state: inside");
  });
});

describe("buildPersistedHeartbeatMessages", () => {
  it("stores heartbeat summary as a single assistant message", () => {
    expect(buildPersistedHeartbeatMessages("summary")).toEqual([
      { role: "assistant", content: "summary" },
    ]);
  });
});

describe("shouldCancelIdleOnlyGlobalRequest", () => {
  it("cancels when another non-heartbeat session is running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "discord-session",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
      [
        "__heartbeat__",
        {
          running: false,
          agent: null,
          queue: [],
          activeRequestId: null,
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });

  it("cancels when the heartbeat session is already running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "__heartbeat__",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "heartbeat:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });
});

describe("shouldCancelRunPolicyRequest", () => {
  it("cancels idle_only_session when the session is already running", () => {
    type RunnerState =
      Parameters<typeof shouldCancelRunPolicyRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, RunnerState>([
      [
        "chan",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelRunPolicyRequest({
        runPolicy: "idle_only_session",
        sessionId: "chan",
        states,
      }),
    ).toBe(true);
  });
});

describe("maybeAppendResponseCommentaryPrompt", () => {
  it("appends commentary guidance for openai provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("appends commentary guidance for codex provider when enabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "codex",
      responseCommentary: true,
    });

    expect(out).toBe(`Base prompt\n\n${RESPONSE_COMMENTARY_INSTRUCTIONS}`);
  });

  it("does not append when disabled", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openai",
      responseCommentary: false,
    });

    expect(out).toBe("Base prompt");
  });

  it("does not append for unsupported providers", () => {
    const out = maybeAppendResponseCommentaryPrompt({
      baseSystemPrompt: "Base prompt",
      provider: "openrouter",
      responseCommentary: true,
    });

    expect(out).toBe("Base prompt");
  });
});

describe("withBlankLineBetweenTextParts", () => {
  it("adds a blank line when text part id changes", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\n\nPart two.");
  });

  it("extends an existing trailing newline to a blank line", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not duplicate existing blank-line separation", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.\n\n",
      delta: "Part two.",
      partChanged: true,
    });

    expect(out).toBe("Part two.");
  });

  it("keeps provider whitespace when delta already starts with whitespace", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "\nPart two.",
      partChanged: true,
    });

    expect(out).toBe("\nPart two.");
  });

  it("does not change deltas when part did not change", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Part one.",
      delta: "Part two.",
      partChanged: false,
    });

    expect(out).toBe("Part two.");
  });

  it("supports restart recovery boundaries with prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "Sure! Triggering now - see you on the other side.",
      delta: "...and I'm back.",
      partChanged: true,
    });

    expect(out).toBe("\n\n...and I'm back.");
  });

  it("does not add separator when there is no prior visible text", () => {
    const out = withBlankLineBetweenTextParts({
      accumulatedText: "",
      delta: "Fresh reply.",
      partChanged: true,
    });

    expect(out).toBe("Fresh reply.");
  });
});

describe("mergeToSingleUserMessage", () => {
  it("keeps all user text when merging plain-text messages", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      { role: "assistant", content: "ignored" },
      { role: "user", content: "C two" },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("B one");
    expect(out.content).toContain("C two");
    expect(out.content).toContain("D steer");
  });

  it("preserves buffered multipart content and steering text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "B with image" },
          { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B with image")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D steer")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "image")).toBe(
      true,
    );
  });

  it("preserves steering multipart content and buffered text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      {
        role: "user",
        content: [
          { type: "text", text: "D interrupt with image" },
          { type: "image", image: new Uint8Array([7, 8]), mediaType: "image/jpeg" },
        ],
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B one")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D interrupt")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "image")).toBe(
      true,
    );
  });
});

describe("createDeferredSubagentManager", () => {
  it("replays child completion that happened before restore reattach", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const parentHeaders = {
      request_id: "parent-request",
      session_id: "parent-session",
      request_client: "discord" as const,
    };

    const logger = createLogger({ module: "bus-agent-runner-test" });

    const manager = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });

    await manager.register({
      profile: "explore",
      task: "Map auth flow",
      timeoutMs: 5_000,
      depth: 1,
      parentRequestId: parentHeaders.request_id,
      parentSessionId: parentHeaders.session_id,
      parentRequestClient: parentHeaders.request_client,
      parentToolCallId: "tool-1",
      childRequestId: "child-request",
      childSessionId: "child-session",
      parentHeaders,
      childHeaders: {
        request_id: "child-request",
        session_id: "child-session",
        request_client: "unknown",
        parent_request_id: parentHeaders.request_id,
        parent_tool_call_id: "tool-1",
        subagent_profile: "explore",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Map auth flow" }],
    });

    const recovery = manager.buildRecoveryState();
    expect(recovery).toBeDefined();
    await manager.stop();

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "done after restart" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    const restored = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });
    await restored.restore(recovery);

    await waitFor(() => restored.hasBufferedCompletions());

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    const injected = await restored.injectBuffered(agent);
    expect(injected).toBe(true);
    expect(agent.state.messages).toHaveLength(3);

    const toolMessage = agent.state.messages[2];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool message");
    const toolResult = toolMessage.content[0];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type !== "tool-result") throw new Error("expected tool result");
    expect(toolResult.output).toEqual({
      type: "json",
      value: {
        ok: true,
        status: "resolved",
        profile: "explore",
        childRequestId: "child-request",
        childSessionId: "child-session",
        durationMs: expect.any(Number),
        finalText: "done after restart",
      },
    });

    await restored.stop();
  });

  it("does not miss a child completion that lands before the parent starts waiting", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const parentHeaders = {
      request_id: "parent-request",
      session_id: "parent-session",
      request_client: "discord" as const,
    };

    const logger = createLogger({ module: "bus-agent-runner-test" });

    const manager = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });

    await manager.register({
      profile: "explore",
      task: "Map auth flow",
      timeoutMs: 5_000,
      depth: 1,
      parentRequestId: parentHeaders.request_id,
      parentSessionId: parentHeaders.session_id,
      parentRequestClient: parentHeaders.request_client,
      parentToolCallId: "tool-1",
      childRequestId: "child-request",
      childSessionId: "child-session",
      parentHeaders,
      childHeaders: {
        request_id: "child-request",
        session_id: "child-session",
        request_client: "unknown",
        parent_request_id: parentHeaders.request_id,
        parent_tool_call_id: "tool-1",
        subagent_profile: "explore",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Map auth flow" }],
    });

    const waitState = manager.snapshotWaitState();
    expect(waitState.hasOutstandingChildren).toBe(true);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "done before wait registered" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    await waitFor(() => manager.hasBufferedCompletions());
    await manager.waitForSignalSince(waitState.signalVersion);

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    const injected = await manager.injectBuffered(agent);
    expect(injected).toBe(true);
    expect(manager.hasOutstandingChildren()).toBe(false);

    const toolMessage = agent.state.messages[2];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool message");
    const toolResult = toolMessage.content[0];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type !== "tool-result") throw new Error("expected tool result");
    expect(toolResult.output).toEqual({
      type: "json",
      value: {
        ok: true,
        status: "resolved",
        profile: "explore",
        childRequestId: "child-request",
        childSessionId: "child-session",
        durationMs: expect.any(Number),
        finalText: "done before wait registered",
      },
    });

    await manager.stop();
  });

  it("does not duplicate restored child text when replay settles before response text", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const parentHeaders = {
      request_id: "parent-request",
      session_id: "parent-session",
      request_client: "discord" as const,
    };

    const logger = createLogger({ module: "bus-agent-runner-test" });

    const manager = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });

    await manager.register({
      profile: "explore",
      task: "Map auth flow",
      timeoutMs: 5_000,
      depth: 1,
      parentRequestId: parentHeaders.request_id,
      parentSessionId: parentHeaders.session_id,
      parentRequestClient: parentHeaders.request_client,
      parentToolCallId: "tool-1",
      childRequestId: "child-request",
      childSessionId: "child-session",
      parentHeaders,
      childHeaders: {
        request_id: "child-request",
        session_id: "child-session",
        request_client: "unknown",
        parent_request_id: parentHeaders.request_id,
        parent_tool_call_id: "tool-1",
        subagent_profile: "explore",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Map auth flow" }],
    });

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "a" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "b" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    await waitFor(() => manager.buildRecoveryState()?.outstanding[0]?.finalText === "ab");

    const recovery = manager.buildRecoveryState();
    expect(recovery?.outstanding[0]?.finalText).toBe("ab");
    await manager.stop();

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    const restored = createDeferredSubagentManager({
      bus,
      logger,
      parentHeaders,
    });
    await restored.restore(recovery);

    await waitFor(() => restored.hasBufferedCompletions());

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    const injected = await restored.injectBuffered(agent);
    expect(injected).toBe(true);

    const toolMessage = agent.state.messages[2];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool message");
    const toolResult = toolMessage.content[0];
    expect(toolResult?.type).toBe("tool-result");
    if (toolResult?.type !== "tool-result") throw new Error("expected tool result");
    expect(toolResult.output).toEqual({
      type: "json",
      value: {
        ok: true,
        status: "resolved",
        profile: "explore",
        childRequestId: "child-request",
        childSessionId: "child-session",
        durationMs: expect.any(Number),
        finalText: "ab",
      },
    });

    await restored.stop();
  });
});
