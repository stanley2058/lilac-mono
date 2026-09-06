import { afterEach, expect, it } from "bun:test";
import { streamText } from "ai";
import { env } from "../env";
import { createOpenAIResponsesSseModelProvider } from "../model-provider";
import { SERVER_COMPACTION_REQUEST_HEADER } from "../server-compaction-request";

const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const originalOpenAISettings = { ...env.providers.openai };
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  Object.assign(env.providers.openai, originalOpenAISettings);
});

it("constructs an SSE-only provider with the existing authentication and compaction wrappers", async () => {
  Object.assign(env.providers.openai, {
    apiKey: "test-key",
    baseUrl: "https://example.test/v1/",
    responsesTransport: "websocket",
  });
  let socketAttempts = 0;
  globalThis.WebSocket = class {
    constructor() {
      socketAttempts += 1;
      throw new Error("SSE fallback must not open a socket");
    }
  } as unknown as typeof WebSocket;
  const requests: { url: string; headers: Headers; body: string }[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    const events = [
      {
        type: "response.created",
        response: { id: "resp_sse", created_at: 1_783_620_000, model: "gpt-6-astra" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_sse",
          incomplete_details: null,
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const provider = createOpenAIResponsesSseModelProvider();
  const result = streamText({
    model: provider.responses("gpt-6-astra"),
    prompt: "Compact this context",
    headers: { [SERVER_COMPACTION_REQUEST_HEADER]: "true" },
  });
  for await (const part of result.stream) {
    expect(part.type).not.toBe("error");
  }
  expect((await result.usage).inputTokens).toBe(10);
  expect(socketAttempts).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("https://example.test/v1/responses");
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-key");
  expect(requests[0]!.headers.has(SERVER_COMPACTION_REQUEST_HEADER)).toBe(false);
  expect(requests[0]!.headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
  expect(JSON.parse(requests[0]!.body).input.at(-1)).toEqual({ type: "compaction_trigger" });
});
