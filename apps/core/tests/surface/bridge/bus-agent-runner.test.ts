import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  appendConfiguredAliasPromptBlock,
  appendAdditionalSessionMemoBlock,
  consumeAssistantTextDelta,
  createAssistantTextPartBoundaryState,
  createDeferredSubagentManager,
  buildHeartbeatOverlayForRequest,
  buildPersistedHeartbeatMessages,
  buildSurfaceMetadataOverlay,
  markAssistantTextPartEnded,
  markAssistantTextPartStarted,
  mergeToSingleUserMessage,
  maybeAppendResponseCommentaryPrompt,
  resolveSessionAdditionalPrompts,
  shouldCancelRunPolicyRequest,
  shouldCancelIdleOnlyGlobalRequest,
  toOpenAIPromptCacheKey,
  withReasoningDisplayDefaultForAnthropicOpus47Models,
  withBlankLineBetweenTextParts,
  withReasoningSummaryDefaultForOpenAIModels,
} from "../../../src/surface/bridge/bus-agent-runner";
import {
  buildExperimentalDownloadForAnthropicFallback,
  shouldForceUrlDownloadForAnthropicFallback,
  withStableAnthropicUpstreamOrder,
} from "../../../src/surface/bridge/bus-agent-runner/anthropic-fallback-media";

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

function createInMemoryRawBusWithStopWaitingForActiveHandler(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    activeHandlers: number;
    stopWaiters: Array<() => void>;
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
        activeHandlers: 0,
        stopWaiters: [] as Array<() => void>,
        handler: async (msg: Message<unknown>, ctx: HandleContext) => {
          entry.activeHandlers += 1;
          try {
            await handler(msg as unknown as Message<TData>, ctx);
          } finally {
            entry.activeHandlers -= 1;
            if (entry.activeHandlers === 0 && entry.stopWaiters.length > 0) {
              const waiters = entry.stopWaiters.splice(0, entry.stopWaiters.length);
              for (const waiter of waiters) waiter();
            }
          }
        },
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
          await entry.handler(m, {
            cursor: m.id,
            commit: async () => {},
          });
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
          if (entry.activeHandlers === 0) return;
          await new Promise<void>((resolve) => {
            entry.stopWaiters.push(resolve);
          });
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

describe("withReasoningDisplayDefaultForAnthropicOpus47Models", () => {
  it("does not inject summarized thinking when display is none", () => {
    const next = withReasoningDisplayDefaultForAnthropicOpus47Models({
      reasoningDisplay: "none",
      provider: "anthropic",
      modelId: "claude-opus-4.7",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 12000,
        },
      },
    });
  });

  it("upgrades enabled thinking to adaptive summarized for opus 4.7", () => {
    const next = withReasoningDisplayDefaultForAnthropicOpus47Models({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-opus-4.7",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          budgetTokens: 12000,
          display: "summarized",
        },
      },
    });
  });

  it("injects summarized display for vercel/openrouter anthropic opus 4.7 models", () => {
    const vercel = withReasoningDisplayDefaultForAnthropicOpus47Models({
      reasoningDisplay: "detailed",
      provider: "vercel",
      modelId: "anthropic/claude-opus-4.7",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        gateway: {
          order: ["anthropic"],
        },
      },
    });

    const openrouter = withReasoningDisplayDefaultForAnthropicOpus47Models({
      reasoningDisplay: "detailed",
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4-7",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
          },
        },
        openrouter: {
          route: "fallback",
        },
      },
    });

    expect(vercel).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      gateway: {
        order: ["anthropic"],
      },
    });
    expect(openrouter).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
      },
      openrouter: {
        route: "fallback",
      },
    });
  });

  it("does not override explicit anthropic thinking display", () => {
    const next = withReasoningDisplayDefaultForAnthropicOpus47Models({
      reasoningDisplay: "simple",
      provider: "anthropic",
      modelId: "claude-opus-4.7",
      providerOptions: {
        anthropic: {
          thinking: {
            type: "adaptive",
            display: "omitted",
          },
        },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: {
          type: "adaptive",
          display: "omitted",
        },
      },
    });
  });
});

describe("withStableAnthropicUpstreamOrder", () => {
  it("injects the default order for vercel anthropic when none is configured", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      anthropic: {
        thinking: { type: "enabled" },
      },
    });

    expect(next).toEqual({
      anthropic: {
        thinking: { type: "enabled" },
      },
      gateway: {
        order: ["anthropic", "vertex", "bedrock"],
      },
    });
  });

  it("preserves an explicit vercel gateway order", () => {
    const next = withStableAnthropicUpstreamOrder("vercel", {
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });

    expect(next).toEqual({
      gateway: {
        order: ["vertex", "anthropic", "bedrock"],
      },
    });
  });

  it("preserves an explicit openrouter provider order", () => {
    const next = withStableAnthropicUpstreamOrder("openrouter", {
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });

    expect(next).toEqual({
      openrouter: {
        provider: {
          order: ["bedrock", "anthropic"],
        },
      },
    });
  });
});

describe("anthropic fallback URL downloads", () => {
  it("detects fallback-capable anthropic gateway models", () => {
    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(true);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "openrouter/anthropic/claude-sonnet-4.5",
        provider: "openrouter",
        providerOptions: {
          openrouter: {
            provider: {
              order: ["anthropic"],
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      shouldForceUrlDownloadForAnthropicFallback({
        spec: "vercel/anthropic/claude-opus-4.6",
        provider: "vercel",
        providerOptions: {
          gateway: {
            only: ["anthropic"],
            order: ["vertex", "anthropic", "bedrock"],
          },
        },
      }),
    ).toBe(false);
  });

  it("forces downloads for http urls when fallback order includes vertex or bedrock", async () => {
    const downloadCalls: string[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      downloadUrl: async (url) => {
        downloadCalls.push(url.toString());
        return {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        };
      },
      cacheDir: dir,
    });

    try {
      expect(download).toBeDefined();

      const result = await download!([
        {
          url: new URL("https://example.com/image.png?test=force-download"),
          isUrlSupportedByModel: true,
        },
        {
          url: new URL("data:image/png;base64,AA=="),
          isUrlSupportedByModel: false,
        },
      ]);

      expect(downloadCalls).toEqual([
        "https://example.com/image.png?test=force-download",
        "data:image/png;base64,AA==",
      ]);
      expect(result).toEqual([
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches fallback downloads across repeated requests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array([9, 8, 7, 6]),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/report.pdf?test=cache"),
          isUrlSupportedByModel: true,
        },
      ];

      await download!(request);
      await download!(request);

      expect(calls).toBe(1);
      const files = await readdir(dir);
      expect(files.some((file) => file.endsWith(".bin"))).toBe(true);
      expect(files.some((file) => file.endsWith(".json"))).toBe(true);

      const dirStat = await stat(dir);
      expect(dirStat.mode & 0o077).toBe(0);

      for (const file of files) {
        const fileStat = await stat(path.join(dir, file));
        expect(fileStat.mode & 0o077).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads large cached attachments back from disk without re-downloading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let calls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        calls += 1;
        return {
          data: new Uint8Array(9 * 1024 * 1024),
          mediaType: "application/pdf",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/large-report.pdf?test=disk-cache"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(calls).toBe(1);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resizes oversized images to fit anthropic fallback limits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        };
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/huge-image.png?test=resize"),
          isUrlSupportedByModel: true,
        },
      ];

      const first = await download!(request);
      const second = await download!(request);

      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
      expect(first).toEqual([
        {
          data: new Uint8Array([1, 2, 3, 4]),
          mediaType: "image/jpeg",
        },
      ]);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches oversize image failures to avoid repeated downloads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-fallback-cache-"));
    let downloadCalls = 0;
    let fitCalls = 0;

    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
      cacheDir: dir,
      downloadUrl: async () => {
        downloadCalls += 1;
        return {
          data: new Uint8Array(6 * 1024 * 1024),
          mediaType: "image/png",
        };
      },
      fitImage: async () => {
        fitCalls += 1;
        return null;
      },
    });

    try {
      expect(download).toBeDefined();

      const request = [
        {
          url: new URL("https://example.com/too-big-image.png?test=oversize"),
          isUrlSupportedByModel: true,
        },
      ];

      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      await expect(download!(request)).rejects.toThrow("Image attachment too large");
      expect(downloadCalls).toBe(1);
      expect(fitCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not build a download hook when routing is pinned away from fallback providers", () => {
    const download = buildExperimentalDownloadForAnthropicFallback({
      spec: "vercel/anthropic/claude-opus-4.6",
      provider: "vercel",
      providerOptions: {
        gateway: {
          only: ["anthropic"],
          order: ["vertex", "anthropic", "bedrock"],
        },
      },
    });

    expect(download).toBeUndefined();
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

describe("appendConfiguredAliasPromptBlock", () => {
  it("appends sorted user and session aliases with ids and comments", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            Stanley: { discord: "u1", comment: "Primary operator" },
            alice: { discord: "u2" },
          },
          sessions: {
            discord: {
              ops: { discord: "c1", comment: "Deploy coordination" },
              Deployments: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
    });

    expect(out).toContain("Configured Aliases (Discord):");
    expect(out).toContain("- @alice (discord, u2)");
    expect(out).toContain("- @Stanley (discord, u1): Primary operator");
    expect(out).toContain("- #Deployments (discord, c2)");
    expect(out).toContain("- #ops (discord, c1): Deploy coordination");
    expect(out).not.toContain("read /tmp/core-config.yaml");
  });

  it("points to core-config when alias sections are truncated", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
            bob: { discord: "u2" },
          },
          sessions: {
            discord: {
              dev: "c1",
              ops: "c2",
            },
          },
        },
      } as Pick<CoreConfig, "entity">,
      coreConfigPath: "/tmp/core-config.yaml",
      maxUserAliases: 1,
      maxSessionAliases: 1,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("- @bob (discord, u2)");
    expect(out).toContain("- #dev (discord, c1)");
    expect(out).not.toContain("- #ops (discord, c2)");
    expect(out).toContain("read /tmp/core-config.yaml");
  });

  it("handles configs with user aliases but no session aliases", () => {
    const out = appendConfiguredAliasPromptBlock({
      baseSystemPrompt: "Base prompt",
      cfg: {
        entity: {
          users: {
            alice: { discord: "u1" },
          },
        },
      } as unknown as Pick<CoreConfig, "entity">,
    });

    expect(out).toContain("- @alice (discord, u1)");
    expect(out).not.toContain("Sessions:");
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

describe("assistant text part boundary accumulation", () => {
  it("separates streamed output and final text when a resumed text block reuses the same part id", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const secondDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(secondDelta);
    finalText += secondDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const thirdDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Now let me update the discovery.search entry...",
    });
    streamed.push(thirdDelta);
    finalText += thirdDelta;

    expect(streamed).toEqual([
      "...update the notes.",
      "\n\nWorks without the old patch...",
      "\n\nNow let me update the discovery.search entry...",
    ]);
    expect(finalText).toBe(
      "...update the notes.\n\nWorks without the old patch...\n\nNow let me update the discovery.search entry...",
    );
  });

  it("separates resumed streamed output from recovered visible text before persistence", () => {
    const state = createAssistantTextPartBoundaryState("Done. Updated TOOLS.md...");
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const delta = consumeAssistantTextDelta({
      state,
      finalText,
      recoveryPartialText: "Done. Updated TOOLS.md...",
      partId: "text-0",
      delta: "Now let me also write a daily note...",
    });
    streamed.push(delta);
    finalText += delta;

    expect(streamed).toEqual(["\n\nNow let me also write a daily note..."]);
    expect(finalText).toBe("\n\nNow let me also write a daily note...");
  });

  it("keeps a new text-block boundary pending across whitespace-only deltas", () => {
    const state = createAssistantTextPartBoundaryState(undefined);
    const streamed: string[] = [];
    let finalText = "";

    markAssistantTextPartStarted(state, "text-0");
    const firstDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "...update the notes.",
    });
    streamed.push(firstDelta);
    finalText += firstDelta;
    markAssistantTextPartEnded(state, "text-0");

    markAssistantTextPartStarted(state, "text-0");
    const whitespaceDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "\n",
    });
    streamed.push(whitespaceDelta);
    finalText += whitespaceDelta;

    const textDelta = consumeAssistantTextDelta({
      state,
      finalText,
      partId: "text-0",
      delta: "Works without the old patch...",
    });
    streamed.push(textDelta);
    finalText += textDelta;

    expect(streamed).toEqual(["...update the notes.", "\n", "\nWorks without the old patch..."]);
    expect(finalText).toBe("...update the notes.\n\nWorks without the old patch...");
  });
});

describe("buildSurfaceMetadataOverlay", () => {
  it("returns null when no user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      { role: "user", content: "plain user text" },
      { role: "assistant", content: '<LILAC_META:v1>{"platform":"discord"}</LILAC_META:v1>' },
    ] satisfies ModelMessage[]);

    expect(overlay).toBeNull();
  });

  it("returns instructions when a user message starts with surface metadata", () => {
    const overlay = buildSurfaceMetadataOverlay([
      {
        role: "user",
        content:
          '<LILAC_META:v1>{"platform":"discord","user_id":"u1","message_id":"m1"}</LILAC_META:v1>\nhello',
      },
    ] satisfies ModelMessage[]);

    expect(overlay).toContain("trusted injected tag");
    expect(overlay).toContain("first line of a user-message block");
    expect(overlay).toContain("&lt;LILAC_META:v1>");
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

  it("preserves later metadata lines at merged block boundaries", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m1"}</LILAC_META:v1>\nfirst',
      },
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("m1");
    expect(out.content).toContain(
      '\n\n<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
    );
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

  it("does not deadlock when a resolved lifecycle event settles from its own subscription callback", async () => {
    const raw = createInMemoryRawBusWithStopWaitingForActiveHandler();
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
    const waitPromise = manager.waitForSignalSince(waitState.signalVersion);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "resolved without deadlock" },
      {
        headers: {
          request_id: "child-request",
          session_id: "child-session",
          request_client: "unknown",
        },
      },
    );

    const publishResolved = bus.publish(
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

    const publishResult = await Promise.race([
      publishResolved.then(() => "resolved" as const),
      Bun.sleep(100).then(() => "timeout" as const),
    ]);
    expect(publishResult).toBe("resolved");

    const waitResult = await Promise.race([
      waitPromise.then(() => "resolved" as const),
      Bun.sleep(100).then(() => "timeout" as const),
    ]);
    expect(waitResult).toBe("resolved");

    expect(manager.hasBufferedCompletions()).toBe(true);
    expect(manager.hasOutstandingChildren()).toBe(false);

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    const injected = await manager.injectBuffered(agent);
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
        finalText: "resolved without deadlock",
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
