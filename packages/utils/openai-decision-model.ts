import { z } from "zod";

function loadOpenAI(): typeof import("@ai-sdk/openai") {
  const mod: typeof import("@ai-sdk/openai") = require("@ai-sdk/openai");
  return mod;
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const decisionRequestSchema = z.object({ input: z.string() }).catchall(z.json());

export function decodeOpenAIDecisionRequestBody(body: NonNullable<FetchInit>["body"]) {
  return decisionRequestSchema.parse(JSON.parse(z.string().parse(body)));
}

export function createOpenAIDecisionModel(input: {
  model: string;
  apiKey: string;
  baseUrl?: string;
  images?: readonly string[];
  fetch?: typeof globalThis.fetch;
}) {
  const fetchFn = input.fetch ?? globalThis.fetch;
  const images = input.images ?? [];
  const fetchWithImages = async (request: FetchInput, init?: FetchInit): Promise<Response> => {
    if (images.length === 0) return fetchFn(request, init);
    const body = decodeOpenAIDecisionRequestBody(init?.body);
    // The SDK currently stringifies state. The endpoint requires native input_image parts.
    const content = [
      { type: "input_text", text: body.input },
      ...images.map((image_url) => ({ type: "input_image", image_url })),
    ];
    return fetchFn(request, {
      ...init,
      body: JSON.stringify({ ...body, input: [{ role: "user", content }] }),
    });
  };
  const fetch = Object.assign(fetchWithImages, {
    preconnect: fetchFn.preconnect?.bind(fetchFn) ?? (() => {}),
  });
  return loadOpenAI()
    .createOpenAI({ apiKey: input.apiKey, baseURL: input.baseUrl, fetch })
    .decisionModel(input.model);
}
