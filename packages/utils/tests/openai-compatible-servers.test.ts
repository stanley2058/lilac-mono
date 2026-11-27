import { afterEach, describe, expect, it } from "bun:test";
import { embed, generateText } from "ai";

import {
  configureOpenAICompatibleServers,
  env,
  fromDurableResolvedModelPlanResult,
  fromDurableResolvedModelRequestResult,
  getModelProviders,
  openAICompatibleServersOf,
  parseCoreConfigV3ToUniversal,
  providers,
  resolveModelRefResult,
  routeOpenAICompatibleModel,
  toDurableResolvedModelRequest,
  type CoreConfig,
} from "../index";

type ServerRequest = {
  server: string;
  path: string;
  model: string;
  authorization: string | null;
};

function startServer(name: string, requests: ServerRequest[]) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string };
      const path = new URL(request.url).pathname;
      requests.push({
        server: name,
        path,
        model: body.model,
        authorization: request.headers.get("authorization"),
      });
      if (path.endsWith("/embeddings")) {
        return Response.json({
          data: [{ index: 0, embedding: [1, 0] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }
      return Response.json({
        id: "chat-1",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

function v3Config(models: Record<string, unknown> = {}): CoreConfig {
  return parseCoreConfigV3ToUniversal({ configVersion: 3, models });
}

function resolve(cfg: CoreConfig, model: string) {
  const resolved = resolveModelRefResult(cfg, { model }, "test");
  if (resolved.status === "error") throw new Error(resolved.error.message);
  return resolved.value;
}

async function embedWith(cfg: CoreConfig, model: string) {
  const resolved = resolve(cfg, model);
  const route = routeOpenAICompatibleModel(resolved.modelId, openAICompatibleServersOf(cfg));
  if (route.status === "error") throw new Error(route.error.message);
  await embed({ model: route.value.provider.embeddingModel(route.value.modelId), value: "x" });
  return resolved;
}

const originalEnv = env.providers.openaiCompatible;
const originalProvider = providers["openai-compatible"];

function setLegacyBaseUrl(baseUrl: string | undefined) {
  Object.assign(env.providers, { openaiCompatible: { baseUrl, apiKey: undefined } });
  providers["openai-compatible"] = getModelProviders()["openai-compatible"];
}

function serversConfig(openaiCompatible: Record<string, unknown>): CoreConfig {
  return v3Config({ providers: { openaiCompatible } });
}

afterEach(() => {
  configureOpenAICompatibleServers({});
  Object.assign(env.providers, { openaiCompatible: originalEnv });
  providers["openai-compatible"] = originalProvider;
  delete process.env.LILAC_TEST_VLLM_KEY;
});

describe("models.providers.openaiCompatible config", () => {
  it("defaults to no servers", () => {
    expect(v3Config().models.providers).toEqual({ openaiCompatible: {} });
  });

  it("accepts named servers with an optional key variable", () => {
    const cfg = serversConfig({
      vllm: { baseUrl: "http://gpu-box:8000/v1", apiKeyEnv: "VLLM_API_KEY" },
      tei: { baseUrl: "https://embed.example.com/v1" },
    });
    expect(cfg.models.providers?.openaiCompatible).toEqual({
      vllm: { baseUrl: "http://gpu-box:8000/v1", apiKeyEnv: "VLLM_API_KEY" },
      tei: { baseUrl: "https://embed.example.com/v1" },
    });
  });

  it.each([
    [{ "a/b": { baseUrl: "http://host/v1" } }, "server names cannot be empty or contain /"],
    [{ "": { baseUrl: "http://host/v1" } }, "server names cannot be empty or contain /"],
    [{ vllm: { baseUrl: "ftp://host/v1" } }, "baseUrl must use http or https"],
    [{ vllm: { baseUrl: "http://user:pw@host/v1" } }, "baseUrl must not contain credentials"],
    [{ vllm: { baseUrl: "http://host/v1?tenant=a" } }, "baseUrl must not contain a query"],
    [{ vllm: { baseUrl: "http://host/v1#x" } }, "baseUrl must not contain a query or fragment"],
    [{ vllm: { baseUrl: "http://host/v1?" } }, "baseUrl must not contain a query or fragment"],
    [{ vllm: { baseUrl: "http://host/v1#" } }, "baseUrl must not contain a query or fragment"],
    [{ vllm: { baseUrl: "http://host/v1", apiKeyEnv: "not a name" } }, "environment variable"],
  ])("rejects %j", (openaiCompatible, message) => {
    expect(() => serversConfig(openaiCompatible)).toThrow(message);
  });

  it("reports a malformed baseUrl as a validation issue", () => {
    expect(() => serversConfig({ vllm: { baseUrl: "invalid" } })).toThrow(
      expect.objectContaining({ name: "ZodError" }),
    );
  });
});

describe("openai-compatible server routing", () => {
  it("routes by server name and falls back to OPENAI_COMPATIBLE_BASE_URL", async () => {
    const requests: ServerRequest[] = [];
    const vllm = startServer("vllm", requests);
    const tei = startServer("tei", requests);
    const legacy = startServer("legacy", requests);
    process.env.LILAC_TEST_VLLM_KEY = "vllm-secret";
    try {
      setLegacyBaseUrl(`${legacy.url}v1`);
      const cfg = serversConfig({
        vllm: { baseUrl: `${vllm.url}v1`, apiKeyEnv: "LILAC_TEST_VLLM_KEY" },
        tei: { baseUrl: `${tei.url}v1` },
      });

      const chat = resolve(cfg, "openai-compatible/vllm/Qwen/Qwen3-32B");
      await generateText({ model: chat.model, prompt: "hi" });
      const routed = await embedWith(cfg, "openai-compatible/tei/bge-m3");
      await embedWith(cfg, "openai-compatible/Qwen/Qwen3-Embedding");
      await embedWith(cfg, "openai-compatible/plain-model");

      expect(chat.modelId).toBe("vllm/Qwen/Qwen3-32B");
      expect(routed.modelId).toBe("tei/bge-m3");
      expect(requests).toEqual([
        {
          server: "vllm",
          path: "/v1/chat/completions",
          model: "Qwen/Qwen3-32B",
          authorization: "Bearer vllm-secret",
        },
        { server: "tei", path: "/v1/embeddings", model: "bge-m3", authorization: null },
        {
          server: "legacy",
          path: "/v1/embeddings",
          model: "Qwen/Qwen3-Embedding",
          authorization: null,
        },
        { server: "legacy", path: "/v1/embeddings", model: "plain-model", authorization: null },
      ]);
    } finally {
      await Promise.all([vllm.stop(true), tei.stop(true), legacy.stop(true)]);
    }
  });

  it("restores durable requests through the given or active servers", async () => {
    const requests: ServerRequest[] = [];
    const vllm = startServer("vllm", requests);
    try {
      setLegacyBaseUrl(undefined);
      const servers = { vllm: { baseUrl: `${vllm.url}v1` } };
      const cfg = serversConfig(servers);
      const durable = toDurableResolvedModelRequest(
        resolve(cfg, "openai-compatible/vllm/qwen"),
        cfg.agent.reasoningDisplay,
      );

      expect(fromDurableResolvedModelRequestResult(durable).status).toBe("error");
      const fromSnapshot = fromDurableResolvedModelPlanResult(
        durable,
        openAICompatibleServersOf(cfg),
      );
      if (fromSnapshot.status === "error") throw new Error(fromSnapshot.error.message);
      await generateText({ model: fromSnapshot.value.head.model, prompt: "hi" });
      configureOpenAICompatibleServers(cfg.models.providers!.openaiCompatible);
      const restored = fromDurableResolvedModelRequestResult(durable);
      if (restored.status === "error") throw new Error(restored.error.message);
      await generateText({ model: restored.value.model, prompt: "hi" });

      expect(requests.map((request) => [request.server, request.model])).toEqual([
        ["vllm", "qwen"],
        ["vllm", "qwen"],
      ]);
    } finally {
      await vllm.stop(true);
    }
  });

  it("rejects a server ref without a model", () => {
    const cfg = serversConfig({ vllm: { baseUrl: "http://127.0.0.1:1/v1" } });
    const result = resolveModelRefResult(cfg, { model: "openai-compatible/vllm/" }, "test");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.issue).toBe("invalid-spec");
      expect(result.error.message).toContain(
        "names OpenAI-compatible server 'vllm' without a model",
      );
    }
  });

  it("reports an unrouted model when no server matches and the env slot is unset", () => {
    setLegacyBaseUrl(undefined);
    const cfg = serversConfig({ vllm: { baseUrl: "http://127.0.0.1:1/v1" } });

    expect(
      resolveModelRefResult(cfg, { model: "openai-compatible/vllm/qwen" }, "test").status,
    ).toBe("ok");
    const result = resolveModelRefResult(cfg, { model: "openai-compatible/other/qwen" }, "test");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.issue).toBe("provider-not-configured");
      expect(result.error.message).toContain("Provider 'openai-compatible' is not configured");
      expect(result.error.message).toContain("No OpenAI-compatible server for 'other/qwen'");
    }
  });
});
