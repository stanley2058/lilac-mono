import { describe, expect, it } from "bun:test";

import { ModelCapability } from "../model-capability";

describe("ModelCapability", () => {
  it("maps codex/* provider to openai/* for models.dev lookup", async () => {
    const registry = {
      openai: {
        id: "openai",
        npm: "@ai-sdk/openai",
        name: "OpenAI",
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            name: "GPT-4o",
            family: "gpt-4o",
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 16_384 },
          },
        },
      },
    };

    const mc = new ModelCapability({
      apiUrl: "https://example.invalid/models.dev/api.json",
      fetch: (async () => {
        return new Response(JSON.stringify(registry), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const info = await mc.resolve("codex/gpt-4o");
    expect(info.model).toBe("gpt-4o");
    expect(info.limit.context).toBe(128_000);
  });
});
