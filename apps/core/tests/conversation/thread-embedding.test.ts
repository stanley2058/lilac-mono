import { describe, expect, it } from "bun:test";

import { Panic } from "better-result";

import { createConversationThreadEmbeddingAdapterResolver } from "../../src/conversation/thread-embedding";

describe("conversation thread embedding adapter resolver", () => {
  it("preserves config loader defects instead of disabling embeddings", async () => {
    const defect = new Error("config loader defect");
    const resolveAdapter = createConversationThreadEmbeddingAdapterResolver(async () => {
      throw defect;
    });

    await expect(resolveAdapter()).rejects.toBe(defect);
  });

  it("preserves config loader Panic identity", async () => {
    const panic = new Panic({ message: "embedding config invariant failed" });
    const resolveAdapter = createConversationThreadEmbeddingAdapterResolver(async () => {
      throw panic;
    });

    await expect(resolveAdapter()).rejects.toBe(panic);
  });
});

describe("separate query embeddings", () => {
  it("routes queries separately while retaining document identity and refreshing config", async () => {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const { providers, parseCoreConfigV2ToUniversal } = await import("@stanley2058/lilac-utils");
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json();
        requests.push(body.model);
        return Response.json({
          data: [{ index: 0, embedding: [1, 0] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });
    const original = providers["openai-compatible"];
    providers["openai-compatible"] = createOpenAICompatible({
      name: "openaiCompatible",
      baseURL: `${server.url}v1`,
    });
    try {
      const cfg = parseCoreConfigV2ToUniversal({
        configVersion: 2,
        conversation: {
          thread: {
            embedding: {
              enabled: true,
              model: "openai-compatible/voyage-4-nano-document",
              queryModel: "openai-compatible/voyage-4-nano-query",
            },
          },
        },
      });
      const resolve = createConversationThreadEmbeddingAdapterResolver(async () => cfg);
      const adapter = (await resolve())!;
      expect(adapter.modelId).toBe("openai-compatible/voyage-4-nano-document");
      expect(await resolve()).toBe(adapter);
      const usage: string[] = [];
      await adapter.embed({
        text: "find this",
        facet: "query",
        onUsage: (event) => usage.push(event.modelId),
      });
      await adapter.embed({
        text: "saved summary",
        facet: "brief",
        onUsage: (event) => usage.push(event.modelId),
      });
      expect(requests).toEqual(["voyage-4-nano-query", "voyage-4-nano-document"]);
      expect(usage).toEqual(requests);
      delete cfg.conversation.thread.embedding.queryModel;
      const fallback = (await resolve())!;
      expect(fallback).not.toBe(adapter);
      expect(fallback.modelId).toBe(adapter.modelId);
      await fallback.embed({ text: "find again", facet: "query" });
      expect(requests.at(-1)).toBe("voyage-4-nano-document");
      cfg.conversation.thread.embedding.queryModel = "missing-alias";
      expect(await resolve()).toBeNull();
    } finally {
      providers["openai-compatible"] = original;
      await server.stop(true);
    }
  });
});
